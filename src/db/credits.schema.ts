import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * credit_balances holds the authoritative spendable balance for each user.
 * It exists so deduction can be a single atomic conditional UPDATE
 * (D1 has no interactive transactions — see docs in src/server/credits).
 */
export const creditBalances = sqliteTable("credit_balances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * credit_ledger is an append-only journal of every balance change.
 * `balanceAfter` is denormalized for auditing; the unique `idempotencyKey`
 * makes refunds/grants replay-safe (insert conflict = already applied).
 */
export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    // 'signup_bonus' | 'purchase' | 'video_spend' | 'video_refund' | 'admin_adjust'
    reason: text("reason").notNull(),
    refType: text("ref_type"), // e.g. 'video_task' | 'order'
    refId: text("ref_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("ledger_user_idx").on(table.userId, table.createdAt)],
);

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  user: one(users, {
    fields: [creditBalances.userId],
    references: [users.id],
  }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, {
    fields: [creditLedger.userId],
    references: [users.id],
  }),
}));
