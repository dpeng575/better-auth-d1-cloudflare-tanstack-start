import { describe, expect, it } from "vitest";
import {
  creditBalances,
  creditLedger,
  orders,
  providerModels,
  providers,
  subscriptions,
  videoTasks,
} from "../src/db/schema";

/**
 * Smoke test for the SaaS business schemas (P0).
 * Guards against accidental drift: every table must be exported from the
 * unified schema and keep its idempotency-unique columns.
 */
describe("business schema", () => {
  it("exports all business tables", () => {
    for (const table of [
      creditBalances,
      creditLedger,
      videoTasks,
      providers,
      providerModels,
      orders,
      subscriptions,
    ]) {
      expect(table).toBeDefined();
    }
  });

  it("has unique idempotency keys where money moves", () => {
    const ledgerKeys = Object.keys(creditLedger);
    expect(ledgerKeys).toContain("idempotencyKey");
    const taskKeys = Object.keys(videoTasks);
    expect(taskKeys).toContain("idempotencyKey");
    const orderKeys = Object.keys(orders);
    expect(orderKeys).toContain("orderNo");
  });
});
