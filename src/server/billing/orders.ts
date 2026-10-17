/**
 * Order lifecycle. The money-critical rule: credits are granted BEFORE the
 * order is marked paid, and both steps are individually idempotent —
 *
 *   grantCredits(idempotencyKey: `purchase:{orderNo}`)  ← replay-safe
 *   UPDATE orders SET status='paid' WHERE ... AND status='pending'  ← one-shot
 *
 * A crash between the two converges on the next webhook retry (grant is a
 * duplicate no-op, then the UPDATE lands). Reversed ordering would risk
 * marking paid and crashing before granting credits with no retry trigger.
 */
import {
  type CreditsDB,
  grantCredits,
} from "../credits";
import type { Plan } from "./plans";
import { getPlan } from "./plans";
import {
  createWaffoCheckout,
  queryWaffoPayment,
  type WaffoClientConfig,
} from "./waffo";

export interface OrderRow {
  id: string;
  userId: string;
  orderNo: string;
  planCode: string;
  kind: string;
  amountCents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  paymentProvider: string;
  paymentRef: string | null;
  creditsGranted: number | null;
  paidAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const ORDER_COLUMNS = `id, user_id AS userId, order_no AS orderNo,
  plan_code AS planCode, kind, amount_cents AS amountCents, currency, status,
  payment_provider AS paymentProvider, payment_ref AS paymentRef,
  credits_granted AS creditsGranted, paid_at AS paidAt,
  created_at AS createdAt, updated_at AS updatedAt`;

function rowToOrder(row: Record<string, unknown>): OrderRow {
  return row as unknown as OrderRow;
}

export async function createOrderAndCheckout(
  db: CreditsDB,
  input: {
    userId: string;
    planCode: string;
    userEmail: string;
    baseUrl: string;
    waffo: WaffoClientConfig;
    nowMs?: number;
  },
): Promise<
  | { ok: true; order: OrderRow; checkoutUrl: string }
  | { ok: false; error: "plan_not_found" | "waffo_error"; detail?: string }
> {
  const plan: Plan | undefined = getPlan(input.planCode);
  if (!plan) return { ok: false, error: "plan_not_found" };

  const now = input.nowMs ?? Date.now();
  const id = crypto.randomUUID();
  const orderNo = `ORD-${now}-${id.slice(0, 8).toUpperCase()}`;

  await db
    .prepare(
      `INSERT INTO orders
         (id, user_id, order_no, plan_code, kind, amount_cents, currency,
          status, payment_provider, credits_granted, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'credits_pack', ?, ?, 'pending', 'waffo', ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      orderNo,
      plan.code,
      plan.amountCents,
      plan.currency,
      plan.credits,
      now,
      now,
    )
    .run();

  const checkout = await createWaffoCheckout(input.waffo, {
    orderNo,
    amountCents: plan.amountCents,
    currency: plan.currency,
    userEmail: input.userEmail,
    notifyUrl: `${input.baseUrl}/api/webhooks/waffo`,
    successRedirectUrl: `${input.baseUrl}/dashboard/billing?order=${orderNo}`,
    failedRedirectUrl: `${input.baseUrl}/dashboard/billing?order=${orderNo}&failed=1`,
    cancelRedirectUrl: `${input.baseUrl}/dashboard/billing?order=${orderNo}&canceled=1`,
  });

  if (!checkout.ok) {
    await db
      .prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`)
      .bind(now, id)
      .run();
    return { ok: false, error: "waffo_error", detail: checkout.error };
  }

  if (checkout.paymentRef) {
    await db
      .prepare(`UPDATE orders SET payment_ref = ?, updated_at = ? WHERE id = ?`)
      .bind(checkout.paymentRef, now, id)
      .run();
  }

  const { results } = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
    .bind(id)
    .all<Record<string, unknown>>();
  return { ok: true, order: rowToOrder(results[0]!), checkoutUrl: checkout.webUrl };
}

/** Grant credits for a paid order and flip it to `paid`. Safe to call again
 *  with the same order (webhook retries, reconciliation races). */
export async function markOrderPaidAndGrantCredits(
  db: CreditsDB,
  orderNo: string,
  paymentRef: string | null,
): Promise<{ granted: boolean; alreadyProcessed: boolean }> {
  const { results } = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_no = ?`)
    .bind(orderNo)
    .all<Record<string, unknown>>();
  const order = results[0] ? rowToOrder(results[0]) : null;
  if (!order) return { granted: false, alreadyProcessed: false };
  if (order.status === "paid") return { granted: false, alreadyProcessed: true };
  if (order.status !== "pending") {
    return { granted: false, alreadyProcessed: true };
  }

  // 1. Grant first — the unique idempotency key absorbs webhook replays.
  const grant = await grantCredits(db, {
    userId: order.userId,
    amount: order.creditsGranted ?? 0,
    reason: "purchase",
    idempotencyKey: `purchase:${order.orderNo}`,
    refType: "order",
    refId: order.id,
  });
  if (!grant.applied && !grant.duplicate) {
    return { granted: false, alreadyProcessed: false };
  }

  // 2. Then flip the order; conditional so only one writer wins.
  const now = Date.now();
  await db
    .prepare(
      `UPDATE orders SET status = 'paid', payment_ref = COALESCE(?, payment_ref),
         paid_at = ?, updated_at = ?
       WHERE order_no = ? AND status = 'pending'`,
    )
    .bind(paymentRef, now, now, orderNo)
    .run();

  return { granted: grant.applied, alreadyProcessed: false };
}

/** Reconciliation: stale pending orders get an active query against Waffo.
 *  Runs from the cron tick; skipped entirely when Waffo is not configured. */
export async function reconcilePendingOrders(
  db: CreditsDB,
  waffo: WaffoClientConfig | null,
  nowMs: number = Date.now(),
  staleAfterMs = 60 * 60 * 1000,
): Promise<number> {
  if (!waffo) return 0;
  const { results } = await db
    .prepare(
      `SELECT order_no AS orderNo FROM orders
       WHERE status = 'pending' AND created_at < ?`,
    )
    .bind(nowMs - staleAfterMs)
    .all<{ orderNo: string }>();

  let count = 0;
  for (const { orderNo } of results) {
    const q = await queryWaffoPayment(waffo, orderNo);
    if (q.ok && q.paid) {
      const r = await markOrderPaidAndGrantCredits(db, orderNo, null);
      if (r.granted) count += 1;
    }
  }
  return count;
}

export async function listUserOrders(
  db: CreditsDB,
  userId: string,
  limit = 50,
): Promise<OrderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Record<string, unknown>>();
  return results.map(rowToOrder);
}
