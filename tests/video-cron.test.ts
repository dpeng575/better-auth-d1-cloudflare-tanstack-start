/**
 * Cron scheduler tests (P3): watchdog expiry, orphan refunds, batch limits
 * and queued/processing driving — all against the mock provider on an
 * in-memory SQLite via the D1-like adapter.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { type CreditsDB, grantCredits } from "../src/server/credits";
import { makeD1Like } from "./helpers/d1";
import { makeR2Like } from "./helpers/r2";
import {
  CRON_MAX_SUBMITS,
  runVideoCron,
} from "../src/server/video/cron";
import { mockProvider } from "../src/server/video/providers/mock";

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
CREATE TABLE video_tasks (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  status text DEFAULT 'queued' NOT NULL,
  provider_code text NOT NULL,
  model_code text NOT NULL,
  prompt text NOT NULL,
  params_json text,
  provider_task_id text,
  credits_reserved integer NOT NULL,
  error_code text,
  error_message text,
  result_r2_key text,
  result_meta_json text,
  idempotency_key text NOT NULL unique,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  started_at integer,
  finished_at integer
);
CREATE TABLE providers (
  id text PRIMARY KEY NOT NULL,
  code text NOT NULL unique,
  name text NOT NULL,
  enabled integer NOT NULL default 1,
  priority integer NOT NULL default 0,
  config_json text,
  created_at integer NOT NULL
);
CREATE TABLE provider_models (
  id text PRIMARY KEY NOT NULL,
  provider_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  credit_cost integer NOT NULL,
  max_duration_sec integer,
  enabled integer NOT NULL default 1,
  params_schema_json text
);
`;

const USER = "u1";
const NOW = Date.now();

function insertUser(db: Database.Database, id: string) {
  db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)").run(
    id,
    id,
    `${id}@t.local`,
  );
}

function insertTask(
  db: Database.Database,
  opts: {
    id: string;
    status: string;
    providerCode?: string;
    providerTaskId?: string | null;
    updatedAt?: number;
    credits?: number;
  },
) {
  db.prepare(
    `INSERT INTO video_tasks
       (id, user_id, status, provider_code, model_code, prompt,
        provider_task_id, credits_reserved, idempotency_key,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mock-fast', 'p', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    USER,
    opts.status,
    opts.providerCode ?? "mock",
    opts.providerTaskId ?? null,
    opts.credits ?? 10,
    `key:${opts.id}`,
    NOW,
    opts.updatedAt ?? NOW,
  );
}

describe("video cron", () => {
  let sqlite: Database.Database;
  let d1: CreditsDB;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    insertUser(sqlite, USER);
    d1 = makeD1Like(sqlite);
  });

  async function seedCredits(amount: number) {
    await grantCredits(d1, {
      userId: USER,
      amount,
      reason: "signup_bonus",
      idempotencyKey: `seed:${amount}:${Math.random()}`,
    });
  }

  it("drives a queued task to processing with a provider task id", async () => {
    await seedCredits(10);
    insertTask(sqlite, { id: "t1", status: "queued" });

    const r = await runVideoCron(d1, NOW);
    expect(r.submitted).toBe(1);
    const row = sqlite
      .prepare("SELECT status, started_at, provider_task_id FROM video_tasks WHERE id='t1'")
      .get() as any;
    expect(row.status).toBe("processing");
    expect(row.started_at).toBe(NOW);
    expect(String(row.provider_task_id)).toMatch(/^mock:/);
  });

  it("polls a ready processing task to succeeded", async () => {
    insertTask(sqlite, {
      id: "t2",
      status: "processing",
      providerTaskId: "mock:eyJvayI6dHJ1ZSwicmVhZHlBdCI6MTcwMDAwMDAwMDAwMH0", // ok, readyAt < NOW
      updatedAt: NOW - 60_000,
    });
    const r = await runVideoCron(d1, NOW, makeR2Like());
    expect(r.polled).toBe(1);
    const row = sqlite
      .prepare("SELECT status, result_meta_json FROM video_tasks WHERE id='t2'")
      .get() as any;
    expect(row.status).toBe("succeeded");
    expect(JSON.parse(row.result_meta_json)).toMatchObject({ mock: true });
  });

  it("force-fails and refunds tasks stuck beyond the timeout", async () => {
    await seedCredits(50);
    insertTask(sqlite, {
      id: "t3",
      status: "processing",
      providerTaskId: "mock:eyJvayI6ZmFsc2UsInJlYWR5QXQiOjk5OTk5OTk5OTk5OX0", // never ready
      updatedAt: NOW - 25 * 60 * 60 * 1000,
    });
    const balanceBefore = (
      sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any
    ).balance;

    const r = await runVideoCron(d1, NOW);
    expect(r.expired).toBe(1);
    const row = sqlite
      .prepare("SELECT status, error_code FROM video_tasks WHERE id='t3'")
      .get() as any;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("task_timeout");
    const balanceAfter = (
      sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any
    ).balance;
    expect(balanceAfter).toBe(balanceBefore + 10);
  });

  it("refunds orphan deductions exactly once", async () => {
    await seedCredits(10);
    // Simulate a crash between deduction and task insert: the spend DID hit
    // the balance (10 -> 0) and wrote its ledger row, but no task row exists.
    sqlite
      .prepare(
        `INSERT INTO credit_ledger
           (id, user_id, delta, balance_after, reason, ref_type, ref_id,
            idempotency_key, created_at)
         VALUES ('l-orphan', ?, -10, 0, 'video_spend', 'video_task', 'ghost-task',
                 'video_spend:ghost-task', ?)`,
      )
      .run(USER, NOW);
    sqlite
      .prepare("UPDATE credit_balances SET balance = 0 WHERE user_id = ?")
      .run(USER);

    const r1 = await runVideoCron(d1, NOW);
    expect(r1.orphanRefunds).toBe(1);
    const bal = (
      sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any
    ).balance;
    expect(bal).toBe(10);

    // Second tick: idempotent, no double refund.
    const r2 = await runVideoCron(d1, NOW + 1000);
    expect(r2.orphanRefunds).toBe(0);
    expect(
      (sqlite.prepare("SELECT balance FROM credit_balances WHERE user_id=?").get(USER) as any)
        .balance,
    ).toBe(10);
  });

  it("caps submissions per tick at CRON_MAX_SUBMITS", async () => {
    await seedCredits(1000);
    for (let i = 0; i < 7; i++) {
      insertTask(sqlite, { id: `q${i}`, status: "queued", updatedAt: NOW + i });
    }
    const r = await runVideoCron(d1, NOW);
    expect(r.submitted).toBe(CRON_MAX_SUBMITS);
    const done = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM video_tasks WHERE status='processing'")
        .get() as any
    ).n;
    expect(done).toBe(CRON_MAX_SUBMITS);
  });

  it("fails tasks with unknown providers", async () => {
    await seedCredits(10);
    insertTask(sqlite, { id: "t4", status: "queued", providerCode: "who-dis" });
    const r = await runVideoCron(d1, NOW);
    const row = sqlite
      .prepare("SELECT status, error_code FROM video_tasks WHERE id='t4'")
      .get() as any;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("provider_unavailable");
    expect(r.expired + r.submitted).toBeGreaterThanOrEqual(0);
  });

  it("respects the mock provider round trip end to end", async () => {
    await seedCredits(10);
    insertTask(sqlite, { id: "t5", status: "queued" });
    const r2 = makeR2Like();
    await runVideoCron(d1, NOW, r2); // claim + submit

    const ptid = (
      sqlite
        .prepare("SELECT provider_task_id FROM video_tasks WHERE id='t5'")
        .get() as any
    ).provider_task_id as string;
    const poll = await mockProvider.poll(ptid, {}, NOW);
    expect(poll.state).toBe("processing"); // 15s mock delay not elapsed

    // A later tick after the mock delay completes the task.
    sqlite
      .prepare("UPDATE video_tasks SET updated_at = updated_at - 60000 WHERE id='t5'")
      .run();
    await runVideoCron(d1, NOW + 60_000, r2);
    const row = sqlite
      .prepare("SELECT status, result_r2_key FROM video_tasks WHERE id='t5'")
      .get() as any;
    expect(row.status).toBe("succeeded");
    expect(String(row.result_r2_key)).toMatch(/^videos\/t5\.txt$/);
  });
});
