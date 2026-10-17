/**
 * R2 result storage tests (P4): inline content, remote fetch, failure
 * semantics (never succeed without stored bytes) — with an in-memory
 * R2BucketLike and a stubbed global fetch.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1Like } from "./helpers/d1";
import type { CreditsDB } from "../src/server/credits";
import { grantCredits } from "../src/server/credits";
import { runVideoCron } from "../src/server/video/cron";
import { storeVideoResult } from "../src/server/video/storage";
import { makeR2Like } from "./helpers/r2";

const USER = "u1";
const NOW = Date.now();

const DDL = `
CREATE TABLE users (id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL unique);
CREATE TABLE credit_balances (user_id text PRIMARY KEY NOT NULL, balance integer NOT NULL default 0, updated_at integer NOT NULL);
CREATE TABLE credit_ledger (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, delta integer NOT NULL,
  balance_after integer NOT NULL, reason text NOT NULL, ref_type text, ref_id text,
  idempotency_key text NOT NULL unique, created_at integer NOT NULL);
CREATE TABLE video_tasks (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, status text DEFAULT 'queued' NOT NULL,
  provider_code text NOT NULL, model_code text NOT NULL, prompt text NOT NULL, params_json text,
  provider_task_id text, credits_reserved integer NOT NULL, error_code text, error_message text,
  result_r2_key text, result_meta_json text, idempotency_key text NOT NULL unique,
  created_at integer NOT NULL, updated_at integer NOT NULL, started_at integer, finished_at integer);
CREATE TABLE providers (id text PRIMARY KEY NOT NULL, code text NOT NULL unique, name text NOT NULL,
  enabled integer NOT NULL default 1, priority integer NOT NULL default 0, config_json text, created_at integer NOT NULL);
CREATE TABLE provider_models (id text PRIMARY KEY NOT NULL, provider_id text NOT NULL, code text NOT NULL,
  name text NOT NULL, credit_cost integer NOT NULL, max_duration_sec integer,
  enabled integer NOT NULL default 1, params_schema_json text);
`;

function boot() {
  const sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  sqlite
    .prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
    .run(USER, USER, `${USER}@t.local`);
  const d1 = makeD1Like(sqlite);
  return { sqlite, d1 };
}

describe("storeVideoResult", () => {
  it("stores inline content into R2 with content type", async () => {
    const r2 = makeR2Like();
    const out = await storeVideoResult(r2, "task-1", {
      inlineContent: { body: "hello video", contentType: "text/plain" },
    });
    expect(out.r2Key).toBe("videos/task-1.txt");
    expect(r2.objects.get("videos/task-1.txt")).toMatchObject({
      body: "hello video",
      contentType: "text/plain",
    });
  });

  it("keeps an already-stored r2Key untouched", async () => {
    const r2 = makeR2Like();
    const out = await storeVideoResult(r2, "task-2", { r2Key: "videos/x.mp4" });
    expect(out.r2Key).toBe("videos/x.mp4");
    expect(r2.objects.size).toBe(0);
  });

  it("downloads sourceUrl into R2 with derived extension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new ArrayBuffer(8), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      ),
    );
    const r2 = makeR2Like();
    const out = await storeVideoResult(r2, "task-3", {
      sourceUrl: "https://cdn.example.com/v/abc",
    });
    expect(out.r2Key).toBe("videos/task-3.mp4");
    expect(r2.objects.has("videos/task-3.mp4")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("reports failure without throwing when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const r2 = makeR2Like();
    const out = await storeVideoResult(r2, "task-4", {
      sourceUrl: "https://cdn.example.com/v/abc",
    });
    expect(out.r2Key).toBeNull();
    expect(out.error).toBe("source_fetch_500");
    vi.unstubAllGlobals();
  });

  it("reports r2_not_configured when no bucket is bound", async () => {
    const out = await storeVideoResult(undefined, "task-5", {
      inlineContent: { body: "x", contentType: "text/plain" },
    });
    expect(out.r2Key).toBeNull();
    expect(out.error).toBe("r2_not_configured");
  });
});

describe("cron + storage integration", () => {
  let sqlite: Database.Database;
  let d1: CreditsDB;
  let r2: ReturnType<typeof makeR2Like>;

  beforeEach(async () => {
    const boot_ = boot();
    sqlite = boot_.sqlite;
    d1 = boot_.d1;
    r2 = makeR2Like();
    await grantCredits(d1, {
      userId: USER,
      amount: 10,
      reason: "signup_bonus",
      idempotencyKey: `seed:${Math.random()}`,
    });
    sqlite
      .prepare(
        `INSERT INTO video_tasks
           (id, user_id, status, provider_code, model_code, prompt,
            provider_task_id, credits_reserved, idempotency_key,
            created_at, updated_at)
         VALUES ('t1', ?, 'queued', 'mock', 'mock-fast', 'p', NULL, 10, 'k1', ?, ?)`,
      )
      .run(USER, NOW, NOW);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a succeeded task always has stored bytes in R2", async () => {
    // tick 1: claim + submit (mock ready 15s later)
    await runVideoCron(d1, NOW, r2);
    // tick 2: poll succeeds and the inline content is in R2 BEFORE succeed
    await runVideoCron(d1, NOW + 60_000, r2);

    const row = sqlite
      .prepare("SELECT status, result_r2_key FROM video_tasks WHERE id='t1'")
      .get() as any;
    expect(row.status).toBe("succeeded");
    expect(row.result_r2_key).toMatch(/^videos\/t1\.txt$/);
    expect(r2.objects.has(row.result_r2_key)).toBe(true);
  });

  it("without R2 the task stays processing (retried later), never succeeded", async () => {
    await runVideoCron(d1, NOW); // claim + submit
    await runVideoCron(d1, NOW + 60_000); // poll → storage unavailable

    const row = sqlite
      .prepare("SELECT status, error_code FROM video_tasks WHERE id='t1'")
      .get() as any;
    expect(row.status).toBe("processing");
    expect(row.error_code).toBeNull();
    expect(r2.objects.size).toBe(0);
  });
});
