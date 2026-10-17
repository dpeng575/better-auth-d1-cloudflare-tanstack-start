/**
 * Credits core — atomic, idempotent balance operations on D1.
 *
 * WHY THIS DESIGN (read before modifying):
 *
 * D1 has no interactive transactions: you cannot SELECT a balance, compare it
 * in JS, then UPDATE. Between the read and the write another request could
 * have spent the same credits (oversell). Instead, every mutation here is a
 * set of statements executed in ONE `db.batch()` (D1 batches are atomic), and
 * the sufficiency check lives INSIDE the SQL:
 *
 *   INSERT INTO credit_ledger (...) SELECT ... FROM credit_balances
 *     WHERE user_id = ? AND balance >= ?      -- writes a row only if affordable
 *   UPDATE credit_balances SET balance = balance - ?
 *     WHERE user_id = ? AND balance >= ?      -- same guard, belt and braces
 *
 * If the SELECT matches no row, the ledger insert is a no-op (changes === 0)
 * and the UPDATE changes nothing either — the batch commits but nothing moved.
 * Concurrent batches are serialized by SQLite, so two deducts that together
 * exceed the balance can never both pass the guard.
 *
 * IDEMPOTENCY: every operation carries an `idempotencyKey` with a UNIQUE
 * constraint on credit_ledger. A retried grant/refund loses the race, hits
 * the UNIQUE error, and the whole batch rolls back — balance untouched. We
 * catch that and report `duplicate: true`.
 *
 * `id` columns use crypto.randomUUID() (available in Workers and Node 18+).
 */

/** Minimal structural subset of D1Database that the credit functions need.
 *  Lets unit tests inject a better-sqlite3-backed adapter. */
export interface BoundStatement {
  run(): Promise<{ meta: { changes: number } }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** Mirrors D1PreparedStatement: runnable directly, or bind() first. */
export interface PreparedStatement extends BoundStatement {
  bind(...values: unknown[]): BoundStatement;
}

export interface CreditsDB {
  prepare(sql: string): PreparedStatement;
  batch(statements: BoundStatement[]): Promise<unknown[]>;
}

export type CreditReason =
  | "signup_bonus"
  | "purchase"
  | "video_spend"
  | "video_refund"
  | "admin_adjust";

export interface CreditOp {
  userId: string;
  /** Always positive; the direction is implied by the operation. */
  amount: number;
  reason: CreditReason;
  /** UNIQUE on credit_ledger.idempotency_key — make it deterministic, e.g.
   *  `video_refund:{taskId}` so a retried refund is a no-op. */
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}

export interface CreditResult {
  applied: boolean;
  duplicate?: boolean;
  insufficient?: boolean;
}

/** Credits granted when a user account is created. */
export const SIGNUP_BONUS_CREDITS = 100;

const LEDGER_COLUMNS =
  "id, user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key, created_at";

function isDuplicateKeyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/.test(msg) && /idempotency_key/.test(msg);
}

function ledgerInsert(self: {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
}) {
  return self.prepare(
    `INSERT INTO credit_ledger (${LEDGER_COLUMNS})
     SELECT ?, user_id, ?, balance + ?, ?, ?, ?, ?, ?
     FROM credit_balances WHERE user_id = ?`,
  );
}

function ledgerInsertGuarded(self: {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
}) {
  return self.prepare(
    `INSERT INTO credit_ledger (${LEDGER_COLUMNS})
     SELECT ?, user_id, -?, balance - ?, ?, ?, ?, ?, ?
     FROM credit_balances WHERE user_id = ? AND balance >= ?`,
  );
}

function balanceRowInsert(self: {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
}) {
  return self.prepare(
    `INSERT OR IGNORE INTO credit_balances (user_id, balance, updated_at)
     VALUES (?, 0, ?)`,
  );
}

function balanceIncrease(self: {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
}) {
  return self.prepare(
    `UPDATE credit_balances SET balance = balance + ?, updated_at = ?
     WHERE user_id = ?`,
  );
}

function balanceDecreaseGuarded(self: {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
}) {
  return self.prepare(
    `UPDATE credit_balances SET balance = balance - ?, updated_at = ?
     WHERE user_id = ? AND balance >= ?`,
  );
}

/** Add credits (signup bonus, purchase, refund). Idempotent via the ledger's
 *  UNIQUE idempotency_key. */
export async function grantCredits(
  db: CreditsDB,
  op: CreditOp,
): Promise<CreditResult> {
  if (op.amount <= 0) throw new Error("grantCredits: amount must be > 0");
  const now = Date.now();
  try {
    await db.batch([
      balanceRowInsert(db).bind(op.userId, now),
      ledgerInsert(db).bind(
        crypto.randomUUID(),
        op.amount, // delta
        op.amount, // balance_after = balance + amount
        op.reason,
        op.refType ?? null,
        op.refId ?? null,
        op.idempotencyKey,
        now,
        op.userId, // WHERE user_id = ?
      ),
      balanceIncrease(db).bind(op.amount, now, op.userId),
    ]);
    return { applied: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { applied: false, duplicate: true };
    throw error;
  }
}

/** Refund is a grant with a conventional reason — kept as a named export so
 *  call sites read clearly and the idempotency key convention stays uniform. */
export async function refundCredits(
  db: CreditsDB,
  op: Omit<CreditOp, "reason">,
): Promise<CreditResult> {
  return grantCredits(db, { ...op, reason: "video_refund" });
}

/** Spend credits. Atomically refused when the balance is insufficient. */
export async function deductCredits(
  db: CreditsDB,
  op: Omit<CreditOp, "reason"> & { reason?: CreditReason },
): Promise<CreditResult> {
  if (op.amount <= 0) throw new Error("deductCredits: amount must be > 0");
  const now = Date.now();
  const [_, ledgerResult] = await db.batch([
    balanceRowInsert(db).bind(op.userId, now),
    ledgerInsertGuarded(db).bind(
      crypto.randomUUID(),
      op.amount, // delta = -amount
      op.amount, // balance_after = balance - amount
      op.reason ?? "video_spend",
      op.refType ?? null,
      op.refId ?? null,
      op.idempotencyKey,
      now,
      op.userId, // WHERE user_id = ?
      op.amount, // AND balance >= ?
    ),
    balanceDecreaseGuarded(db).bind(op.amount, now, op.userId, op.amount),
  ]);
  const changes = (ledgerResult as { meta: { changes: number } }).meta.changes;
  if (changes === 0) return { applied: false, insufficient: true };
  return { applied: true };
}

export async function getBalance(db: CreditsDB, userId: string): Promise<number> {
  const { results } = await db
    .prepare("SELECT balance FROM credit_balances WHERE user_id = ?")
    .bind(userId)
    .all<{ balance: number }>();
  return results[0]?.balance ?? 0;
}

/** Create the balance row for a user if it does not exist yet. */
export async function ensureBalanceRow(
  db: CreditsDB,
  userId: string,
): Promise<void> {
  await balanceRowInsert(db).bind(userId, Date.now()).run();
}
