import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Subscription / credit-pack orders. Credits are granted ONLY from the
 * payment webhook or the reconciliation cron — never from the redirect page.
 */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderNo: text("order_no").notNull().unique(), // merchant order number sent to Waffo
    planCode: text("plan_code").notNull(),
    // 'subscription' | 'credits_pack'
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    // 'pending' | 'paid' | 'failed' | 'refunded'
    status: text("status").notNull().default("pending"),
    paymentProvider: text("payment_provider").notNull().default("waffo"),
    paymentRef: text("payment_ref"), // Waffo trade/payment id
    creditsGranted: integer("credits_granted"),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("order_user_idx").on(table.userId, table.createdAt)],
);

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planCode: text("plan_code").notNull(),
  // 'active' | 'canceled' | 'expired'
  status: text("status").notNull(),
  currentPeriodStart: integer("current_period_start", {
    mode: "timestamp_ms",
  }).notNull(),
  currentPeriodEnd: integer("current_period_end", {
    mode: "timestamp_ms",
  }).notNull(),
  orderId: text("order_id").references(() => orders.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const ordersRelations = relations(orders, ({ one }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));
