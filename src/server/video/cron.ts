/**
 * Cron-driven task scheduler (the P3 "queue replacement").
 *
 * One tick does, in order:
 *   1. Watchdog — force-fail tasks stuck in queued/processing beyond
 *      TASK_TIMEOUT_MS and refund their reservation.
 *   2. Orphan refunds — deductions whose task row never made it (crash
 *      between the two batches in createVideoTask) get refunded once.
 *   3. Drive queued tasks (submit to provider), at most CRON_MAX_SUBMITS.
 *   4. Poll processing tasks, at most CRON_MAX_POLLS, but never more often
 *      than POLL_MIN_INTERVAL_MS (the GET detail endpoint may already have
 *      driven them moments ago).
 *
 * Every tick is bounded so one minute never exceeds the Workers subrequest
 * budget. All state transitions are conditional UPDATEs, so overlapping
 * ticks / endpoint drives / (future) webhooks cannot double-apply.
 */
import { type CreditsDB, grantCredits } from "../credits";
import type { R2BucketLike } from "./storage";
import { driveTask, failTask, getTaskById, type VideoTaskRow } from "./tasks";
import { getProvider } from "./registry";

export const CRON_MAX_SUBMITS = 3;
export const CRON_MAX_POLLS = 10;
export const TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
export const POLL_MIN_INTERVAL_MS = 30_000;

/** Run one scheduler tick. `nowMs` injected for tests. */
export async function runVideoCron(
  db: CreditsDB,
  nowMs: number = Date.now(),
  r2?: R2BucketLike,
): Promise<{ expired: number; orphanRefunds: number; submitted: number; polled: number }> {
  const expired = await expireStuckTasks(db, nowMs);
  const orphanRefunds = await refundOrphanDeductions(db);
  const submitted = await driveQueued(db, nowMs, r2);
  const polled = await driveProcessing(db, nowMs, r2);
  return { expired, orphanRefunds, submitted, polled };
}

// ---- 1. watchdog ----------------------------------------------------------

async function expireStuckTasks(db: CreditsDB, nowMs: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id FROM video_tasks
       WHERE status IN ('queued', 'processing') AND updated_at < ?`,
    )
    .bind(nowMs - TASK_TIMEOUT_MS)
    .all<{ id: string }>();

  let count = 0;
  for (const { id } of results) {
    const task = await getTaskById(db, id);
    if (!task) continue;
    const ok = await failTask(
      db,
      task,
      "task_timeout",
      "Task exceeded the maximum processing time and was refunded",
      nowMs,
    );
    if (ok) count += 1;
  }
  return count;
}

// ---- 2. orphan deductions ---------------------------------------------------

async function refundOrphanDeductions(db: CreditsDB): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT l.ref_id AS taskId, l.user_id AS userId, -l.delta AS amount
       FROM credit_ledger l
       LEFT JOIN video_tasks t ON t.id = l.ref_id
       WHERE l.reason = 'video_spend' AND l.ref_type = 'video_task'
         AND t.id IS NULL`,
    )
    .all<{ taskId: string; userId: string; amount: number }>();

  let count = 0;
  for (const orphan of results) {
    const r = await grantCredits(db, {
      userId: orphan.userId,
      amount: orphan.amount,
      reason: "video_refund",
      idempotencyKey: `video_refund:orphan:${orphan.taskId}`,
      refType: "video_task",
      refId: orphan.taskId,
    });
    if (r.applied) count += 1;
  }
  return count;
}

// ---- 3 + 4. driving ---------------------------------------------------------

async function driveQueued(db: CreditsDB, nowMs: number, r2?: R2BucketLike): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id FROM video_tasks WHERE status = 'queued'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(CRON_MAX_SUBMITS)
    .all<{ id: string }>();

  let count = 0;
  for (const { id } of results) {
    if (await driveOne(db, id, nowMs, r2)) count += 1;
  }
  return count;
}

async function driveProcessing(db: CreditsDB, nowMs: number, r2?: R2BucketLike): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id FROM video_tasks
       WHERE status = 'processing' AND updated_at < ?
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .bind(nowMs - POLL_MIN_INTERVAL_MS, CRON_MAX_POLLS)
    .all<{ id: string }>();

  let count = 0;
  for (const { id } of results) {
    if (await driveOne(db, id, nowMs, r2)) count += 1;
  }
  return count;
}

/** Drive a single task; false when nothing changed or the provider is
 *  unknown (in which case the task is failed and refunded). */
async function driveOne(
  db: CreditsDB,
  taskId: string,
  nowMs: number,
  r2?: R2BucketLike,
): Promise<boolean> {
  const task: VideoTaskRow | null = await getTaskById(db, taskId);
  if (!task) return false;
  if (task.status === "succeeded" || task.status === "failed") return false;

  const provider = getProvider(task.providerCode);
  if (!provider) {
    await failTask(
      db,
      task,
      "provider_unavailable",
      `No provider registered for code "${task.providerCode}"`,
      nowMs,
    );
    return true;
  }

  const before = task.status;
  const after = await driveTask(db, task, provider, { r2, nowMs });
  return after.status !== before;
}
