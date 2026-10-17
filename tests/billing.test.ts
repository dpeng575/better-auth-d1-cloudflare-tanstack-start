/**
 * Billing tests (P5): Waffo signature verification (Node signs, WebCrypto
 * verifies — proving Workers compatibility), idempotent paid-order
 * processing, checkout creation with an injected fetch, and anonymous
 * blocking lives at the route layer (not tested here).
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1Like } from "./helpers/d1";
import type { CreditsDB } from "../src/server/credits";
import {
  createOrderAndCheckout,
  markOrderPaidAndGrantCredits,
} from "../src/server/billing/orders";
import {
  verifyWaffoSignature,
} from "../src/server/billing/waffo";

const DDL = `
CREATE TABLE users (id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL unique);
CREATE TABLE credit_balances (user_id text PRIMARY KEY NOT NULL, balance integer NOT NULL default 0, updated_at integer NOT NULL);
CREATE TABLE credit_ledger (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, delta integer NOT NULL,
  balance_after integer NOT NULL, reason text NOT NULL, ref_type text, ref_id text,
  idempotency_key text NOT NULL unique, created_at integer NOT NULL);
CREATE TABLE orders (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, order_no text NOT NULL unique,
  plan_code text NOT NULL, kind text NOT NULL, amount_cents integer NOT NULL,
  currency text NOT NULL default 'usd', status text NOT NULL default 'pending',
  payment_provider text NOT NULL default 'waffo', payment_ref text,
  credits_granted integer, paid_at integer, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE subscriptions (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, plan_code text NOT NULL,
  status text NOT NULL, current_period_start integer NOT NULL, current_period_end integer NOT NULL,
  order_id text, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE providers (id text PRIMARY KEY NOT NULL, code text NOT NULL unique, name text NOT NULL,
  enabled integer NOT NULL default 1, priority integer NOT NULL default 0, config_json text, created_at integer NOT NULL);
CREATE TABLE provider_models (id text PRIMARY KEY NOT NULL, provider_id text NOT NULL, code text NOT NULL,
  name text NOT NULL, credit_cost integer NOT NULL, max_duration_sec integer,
  enabled integer NOT NULL default 1, params_schema_json text);
CREATE TABLE video_tasks (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, status text DEFAULT 'queued' NOT NULL,
  provider_code text NOT NULL, model_code text NOT NULL, prompt text NOT NULL, params_json text,
  provider_task_id text, credits_reserved integer NOT NULL, error_code text, error_message text,
  result_r2_key text, result_meta_json text, idempotency_key text NOT NULL unique,
  created_at integer NOT NULL, updated_at integer NOT NULL, started_at integer, finished_at integer);
`;

// ---- signature cross-verification ----------------------------------------

describe("verifyWaffoSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = JSON.stringify({ eventType: "order.completed", data: { outTradeNo: "ORD-1" } });

  function sign(payload: string): string {
    const signer = createSign("SHA256");
    signer.update(payload);
    return signer.sign(privateKey, "base64");
  }

  it("verifies a genuine Node-signed payload via WebCrypto", async () => {
    const sig = sign(body);
    expect(await verifyWaffoSignature(body, sig, publicKeyPem)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = sign(body);
    expect(
      await verifyWaffoSignature(body + "x", sig, publicKeyPem),
    ).toBe(false);
  });

  it("rejects a wrong signature and malformed inputs", async () => {
    expect(await verifyWaffoSignature(body, sign("other"), publicKeyPem)).toBe(false);
    expect(await verifyWaffoSignature(body, "not-base64!!!", publicKeyPem)).toBe(false);
    expect(await verifyWaffoSignature(body, sign(body), "not a pem")).toBe(false);
  });
});

// ---- orders ----------------------------------------------------------------

const USER = "u1";

describe("billing orders", () => {
  let sqlite: Database.Database;
  let d1: CreditsDB;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    sqlite
      .prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
      .run(USER, USER, `${USER}@t.local`);
    d1 = makeD1Like(sqlite);
  });

  function waffo( respond: any, status = 200 ) {
    return {
      apiKey: "test-key",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify(respond), { status }),
      ) as unknown as typeof fetch,
    };
  }

  it("creates an order and returns the checkout webUrl", async () => {
    const result = await createOrderAndCheckout(d1, {
      userId: USER,
      planCode: "credits_pack_100",
      userEmail: `${USER}@t.local`,
      baseUrl: "https://app.example.com",
      waffo: waffo({
        data: {
          tradeNo: "W-123",
          orderAction: JSON.stringify({ actionType: "WEB", webUrl: "https://cashier.waffo.ai/xyz" }),
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkoutUrl).toBe("https://cashier.waffo.ai/xyz");
    const row = sqlite
      .prepare("SELECT status, payment_ref, credits_granted FROM orders WHERE order_no = ?")
      .get(result.order.orderNo) as any;
    expect(row.status).toBe("pending");
    expect(row.payment_ref).toBe("W-123");
    expect(row.credits_granted).toBe(100);
  });

  it("marks the order failed when Waffo rejects creation", async () => {
    const result = await createOrderAndCheckout(d1, {
      userId: USER,
      planCode: "credits_pack_100",
      userEmail: `${USER}@t.local`,
      baseUrl: "https://app.example.com",
      waffo: waffo({ error: "bad" }, 400),
    });
    expect(result.ok).toBe(false);
    const row = sqlite.prepare("SELECT status FROM orders").get() as any;
    expect(row.status).toBe("failed");
  });

  it("grants credits exactly once across webhook replays", async () => {
    // create a paid-pending order directly
    sqlite
      .prepare(
        `INSERT INTO orders (id, user_id, order_no, plan_code, kind, amount_cents,
           currency, status, payment_provider, credits_granted, created_at, updated_at)
         VALUES ('o1', ?, 'ORD-X', 'credits_pack_100', 'credits_pack', 499,
           'usd', 'pending', 'waffo', 100, 1, 1)`,
      )
      .run(USER);

    const first = await markOrderPaidAndGrantCredits(d1, "ORD-X", "W-9");
    expect(first.granted).toBe(true);
    expect(
      (sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any)
        .balance,
    ).toBe(100);

    // replayed webhook delivery
    const second = await markOrderPaidAndGrantCredits(d1, "ORD-X", "W-9");
    expect(second.alreadyProcessed).toBe(true);
    expect(
      (sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any)
        .balance,
    ).toBe(100);
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger").get() as any).n,
    ).toBe(1);

    // order row flipped to paid
    expect(
      (sqlite.prepare("SELECT status FROM orders WHERE id='o1'").get() as any).status,
    ).toBe("paid");
  });

  it("ignores unknown order numbers without throwing", async () => {
    const r = await markOrderPaidAndGrantCredits(d1, "ORD-GHOST", null);
    expect(r.granted).toBe(false);
    expect(r.alreadyProcessed).toBe(false);
  });
});
