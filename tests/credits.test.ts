/**
 * Unit tests for the credits core (P1).
 *
 * Runs against an in-memory better-sqlite3 database through a tiny adapter
 * mimicking D1's prepare/bind/batch API. Production code only relies on
 * prepare().bind().run() and db.batch() atomicity, so behavior here matches
 * D1: batch is atomic, SQLite serializes writers.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CreditsDB,
  deductCredits,
  getBalance,
  grantCredits,
  refundCredits,
} from "../src/server/credits";
import { makeD1Like } from "./helpers/d1";

// ---- D1-like adapter lives in ./helpers/d1 ------------------------------

// ---- Test schema (mirrors drizzle migration 0005) ------------------------

const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  email text NOT NULL unique
);
CREATE TABLE credit_balances (
  user_id text PRIMARY KEY NOT NULL,
  balance integer NOT NULL default 0,
  updated_at integer NOT NULL
);
CREATE TABLE credit_ledger (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  delta integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  ref_type text,
  ref_id text,
  idempotency_key text NOT NULL unique,
  created_at integer NOT NULL
);
`;

const ALICE = "user-alice";
const BOB = "user-bob";

describe("credits core", () => {
  let sqlite: Database.Database;
  let d1: CreditsDB;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    const insert = sqlite.prepare(
      "INSERT INTO users (id, name, email) VALUES (?, ?, ?)",
    );
    for (const u of [ALICE, BOB]) {
      insert.run(u, u, `${u}@test.local`);
    }
    d1 = makeD1Like(sqlite);
  });

  it("grant then deduct keep ledger and balance consistent", async () => {
    const g = await grantCredits(d1, {
      userId: ALICE,
      amount: 100,
      reason: "signup_bonus",
      idempotencyKey: "bonus:alice",
    });
    expect(g.applied).toBe(true);
    expect(await getBalance(d1, ALICE)).toBe(100);

    const d = await deductCredits(d1, {
      userId: ALICE,
      amount: 30,
      idempotencyKey: "spend:task-1",
    });
    expect(d.applied).toBe(true);
    expect(await getBalance(d1, ALICE)).toBe(70);

    const ledger = sqlite
      .prepare("SELECT delta, balance_after, reason FROM credit_ledger ORDER BY delta")
      .all();
    expect(ledger).toEqual([
      { delta: -30, balance_after: 70, reason: "video_spend" },
      { delta: 100, balance_after: 100, reason: "signup_bonus" },
    ]);
  });

  it("deduct with insufficient balance is refused atomically", async () => {
    const d = await deductCredits(d1, {
      userId: ALICE,
      amount: 10,
      idempotencyKey: "spend:x",
    });
    expect(d.applied).toBe(false);
    expect(d.insufficient).toBe(true);
    expect(await getBalance(d1, ALICE)).toBe(0);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger").get(),
    ).toEqual({ n: 0 });
  });

  it("duplicate grant with same idempotency key is a no-op", async () => {
    await grantCredits(d1, {
      userId: ALICE,
      amount: 50,
      reason: "purchase",
      idempotencyKey: "purchase:order-1",
    });
    const second = await grantCredits(d1, {
      userId: ALICE,
      amount: 50,
      reason: "purchase",
      idempotencyKey: "purchase:order-1",
    });
    expect(second.duplicate).toBe(true);
    expect(second.applied).toBe(false);
    expect(await getBalance(d1, ALICE)).toBe(50);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger").get(),
    ).toEqual({ n: 1 });
  });

  it("double refund is applied exactly once", async () => {
    await grantCredits(d1, {
      userId: ALICE,
      amount: 100,
      reason: "video_spend",
      idempotencyKey: "seed",
    });
    const refundOp = {
      userId: ALICE,
      amount: 100,
      idempotencyKey: "video_refund:task-1",
      refType: "video_task",
      refId: "task-1",
    };
    const r1 = await refundCredits(d1, refundOp);
    expect(r1.applied).toBe(true);
    expect(await getBalance(d1, ALICE)).toBe(200);
    const r2 = await refundCredits(d1, refundOp);
    expect(r2.duplicate).toBe(true);
    expect(await getBalance(d1, ALICE)).toBe(200);
  });

  it("one user's spend never touches another user's balance", async () => {
    await grantCredits(d1, {
      userId: ALICE,
      amount: 100,
      reason: "signup_bonus",
      idempotencyKey: "b:a",
    });
    await grantCredits(d1, {
      userId: BOB,
      amount: 10,
      reason: "purchase",
      idempotencyKey: "b:b",
    });
    await deductCredits(d1, {
      userId: ALICE,
      amount: 60,
      idempotencyKey: "s:1",
    });
    expect(await getBalance(d1, ALICE)).toBe(40);
    expect(await getBalance(d1, BOB)).toBe(10);
  });
});
