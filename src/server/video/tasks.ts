/**
 * Video task service — creation, querying, and state-machine transitions.
 *
 * Ordering discipline for task creation (see audit §C3: D1 has no interactive
 * transactions, so deduct-then-insert must be crash-safe):
 *
 *   1. deduct credits  (idempotency key `video_spend:{taskId}`)
 *   2. insert task row (idempotency key `{userId}:{clientKey}`)
 *   3. if the insert hits the UNIQUE index (retry/race), refund step 1 and
 *      return the existing task.
 *
 * A crash between 1 and 2 leaves a paid task-less deduction; the P3 cron
 * watchdog expires such queued-less orphans and refunds them.
 */
import { randomUUID } from "node:crypto";
import type { R2BucketLike } from "./storage";
import { storeVideoResult } from "./storage";
import {
  type CreditResult,
  type CreditsDB,
  deductCredits,
  refundCredits,
} from "../credits";
import type { VideoProvider, VideoSubmitRequest } from "./provider-types";
import { ensureMockProviderSeeded } from "./seed";

export type TaskStatus = "queued" | "processing" | "succeeded" | "failed";

export interface VideoTaskRow {
  id: string;
  userId: string;
  status: TaskStatus;
  providerCode: string;
  modelCode: string;
  prompt: string;
  paramsJson: string | null;
  providerTaskId: string | null;
  creditsReserved: number;
  errorCode: string | null;
  errorMessage: string | null;
  resultR2Key: string | null;
  resultMetaJson: string | null;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CreateTaskInput {
  userId: string;
  modelCode: string;
  prompt: string;
  clientKey: string;
  params?: VideoSubmitRequest["params"];
}

export type CreateTaskResult =
  | { ok: true; task: VideoTaskRow; created: boolean }
  | { ok: false; error: "model_not_found" | "insufficient_credits" };

// ---- helpers -------------------------------------------------------------

// Alias snake_case columns to the camelCase VideoTaskRow fields
const TASK_COLUMNS = `id, user_id AS userId, status,
  provider_code AS providerCode, model_code AS modelCode, prompt,
  params_json AS paramsJson, provider_task_id AS providerTaskId,
  credits_reserved AS creditsReserved, error_code AS errorCode,
  error_message AS errorMessage, result_r2_key AS resultR2Key,
  result_meta_json AS resultMetaJson, idempotency_key AS idempotencyKey,
  created_at AS createdAt, updated_at AS updatedAt,
  started_at AS startedAt, finished_at AS finishedAt`;

function rowToTask(row: Record<string, unknown>): VideoTaskRow {
  return row as unknown as VideoTaskRow;
}

export function taskPublicJson(task: VideoTaskRow) {
  return {
    id: task.id,
    status: task.status,
    providerCode: task.providerCode,
    modelCode: task.modelCode,
    prompt: task.prompt,
    params: task.paramsJson ? JSON.parse(task.paramsJson) : null,
    creditsReserved: task.creditsReserved,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    result: task.resultMetaJson
      ? { r2Key: task.resultR2Key, meta: JSON.parse(task.resultMetaJson) }
      : null,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

export async function getTaskById(
  db: CreditsDB,
  id: string,
): Promise<VideoTaskRow | null> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM video_tasks WHERE id = ?`)
    .bind(id)
    .all<Record<string, unknown>>();
  return results[0] ? rowToTask(results[0]) : null;
}

async function getTaskByIdempotencyKey(
  db: CreditsDB,
  key: string,
): Promise<VideoTaskRow | null> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM video_tasks WHERE idempotency_key = ?`)
    .bind(key)
    .all<Record<string, unknown>>();
  return results[0] ? rowToTask(results[0]) : null;
}

// ---- creation -------------------------------------------------------------

export async function createVideoTask(
  db: CreditsDB,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  await ensureMockProviderSeeded(db);

  // 0. Resolve the model + provider (both must be enabled).
  const { results: modelRows } = await db
    .prepare(
      `SELECT m.id AS model_id, m.code AS model_code, m.credit_cost,
              p.code AS provider_code
       FROM provider_models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.code = ? AND m.enabled = 1 AND p.enabled = 1`,
    )
    .bind(input.modelCode)
    .all<{
      model_id: string;
      model_code: string;
      credit_cost: number;
      provider_code: string;
    }>();
  const model = modelRows[0];
  if (!model) return { ok: false, error: "model_not_found" };

  // 1. Replayed request? Return the existing task untouched.
  const idempotencyKey = `${input.userId}:${input.clientKey}`;
  const existing = await getTaskByIdempotencyKey(db, idempotencyKey);
  if (existing) return { ok: true, task: existing, created: false };

  // 2. Reserve credits first — no task may exist without payment.
  const taskId = randomUUID();
  const spend: CreditResult = await deductCredits(db, {
    userId: input.userId,
    amount: model.credit_cost,
    reason: "video_spend",
    idempotencyKey: `video_spend:${taskId}`,
    refType: "video_task",
    refId: taskId,
  });
  if (!spend.applied) return { ok: false, error: "insufficient_credits" };

  // 3. Insert the task row; on a UNIQUE hit (raced retry) refund and return
  //    the winner's task.
  const now = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO video_tasks
           (id, user_id, status, provider_code, model_code, prompt, params_json,
            credits_reserved, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        taskId,
        input.userId,
        model.provider_code,
        model.model_code,
        input.prompt,
        input.params ? JSON.stringify(input.params) : null,
        model.credit_cost,
        idempotencyKey,
        now,
        now,
      )
      .run();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/.test(msg)) {
      await refundCredits(db, {
        userId: input.userId,
        amount: model.credit_cost,
        idempotencyKey: `video_refund:orphan:${taskId}`,
        refType: "video_task",
        refId: taskId,
      });
      const winner = await getTaskByIdempotencyKey(db, idempotencyKey);
      if (winner) return { ok: true, task: winner, created: false };
    }
    throw error;
  }

  const task = await getTaskById(db, taskId);
  return { ok: true, task: task!, created: true };
}

// ---- queries ---------------------------------------------------------------

export async function listUserTasks(
  db: CreditsDB,
  userId: string,
  limit = 50,
): Promise<VideoTaskRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM video_tasks
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Record<string, unknown>>();
  return results.map(rowToTask);
}

// ---- state machine ---------------------------------------------------------

async function claimQueued(
  db: CreditsDB,
  taskId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE video_tasks
       SET status = 'processing', started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .bind(now, now, taskId)
    .run();
  return result.meta.changes > 0;
}

async function finishSucceeded(
  db: CreditsDB,
  taskId: string,
  r2Key: string | null,
  meta: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE video_tasks
       SET status = 'succeeded', result_r2_key = ?, result_meta_json = ?,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'processing')`,
    )
    .bind(r2Key, JSON.stringify(meta), now, now, taskId)
    .run();
  return result.meta.changes > 0;
}

async function finishFailed(
  db: CreditsDB,
  task: VideoTaskRow,
  errorCode: string,
  errorMessage: string,
  now: number,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE video_tasks
       SET status = 'failed', error_code = ?, error_message = ?,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'processing')`,
    )
    .bind(errorCode, errorMessage, now, now, task.id)
    .run();
  if (claimed.meta.changes === 0) return false;
  // Full refund, idempotent via the ledger's unique key.
  await refundCredits(db, {
    userId: task.userId,
    amount: task.creditsReserved,
    idempotencyKey: `video_refund:${task.id}`,
    refType: "video_task",
    refId: task.id,
  });
  return true;
}

async function saveProviderTaskId(
  db: CreditsDB,
  taskId: string,
  providerTaskId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE video_tasks SET provider_task_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(providerTaskId, now, taskId)
    .run();
}

/**
 * Drive a task forward by exactly one step against its provider. Called
 * opportunistically from the detail endpoint in P2 and by the cron worker
 * from P3 onward. All transitions are conditional UPDATEs, so a cron tick
 * and a webhook-driven drive can race without double effects.
 */
export async function driveTask(
  db: CreditsDB,
  task: VideoTaskRow,
  provider: VideoProvider,
  opts: { r2?: R2BucketLike; nowMs?: number } = {},
): Promise<VideoTaskRow> {
  const nowMs = opts.nowMs ?? Date.now();
  if (task.status === "succeeded" || task.status === "failed") return task;

  if (task.status === "queued") {
    if (!claimQueued(db, task.id, nowMs)) {
      const current = await getTaskById(db, task.id);
      return current ?? task;
    }
    const outcome = await provider.submit(
      { model: task.modelCode, prompt: task.prompt, params: parseParams(task) },
      {},
    );
    if (outcome.kind === "async") {
      await saveProviderTaskId(db, task.id, outcome.providerTaskId, nowMs);
    } else if (outcome.kind === "completed") {
      const stored = await storeVideoResult(opts.r2, task.id, outcome.result);
      const needsStorage = Boolean(
        outcome.result.r2Key || outcome.result.sourceUrl || outcome.result.inlineContent,
      );
      if (needsStorage && !stored.r2Key) {
        // Bytes not safely in R2 yet — leave queued-less task in processing
        // for a retry on the next tick. Never succeed without stored bytes.
        return (await getTaskById(db, task.id)) ?? task;
      }
      await finishSucceeded(
        db,
        task.id,
        stored.r2Key,
        outcome.result.meta,
        nowMs,
      );
    } else {
      // accepted_no_id: nothing more we can do this tick; the provider must
      // support some poll path — treated as processing until it does.
    }
  }

  // processing (either just claimed or previously submitted)
  const current = await getTaskById(db, task.id);
  if (!current || current.status !== "processing") {
    return current ?? task;
  }

  if (!current.providerTaskId) {
    // queued for too long without an upstream id — let the P3 watchdog
    // expire it; nothing to poll yet.
    return current;
  }

  const poll = await provider.poll(current.providerTaskId, {}, nowMs);
  switch (poll.state) {
    case "processing":
      await db
        .prepare(`UPDATE video_tasks SET updated_at = ? WHERE id = ?`)
        .bind(nowMs, current.id)
        .run();
      break;
    case "succeeded": {
      const stored = await storeVideoResult(opts.r2, current.id, poll.result);
      const needsStorage = Boolean(
        poll.result.r2Key || poll.result.sourceUrl || poll.result.inlineContent,
      );
      if (needsStorage && !stored.r2Key) {
        await db
          .prepare(`UPDATE video_tasks SET updated_at = ? WHERE id = ?`)
          .bind(nowMs, current.id)
          .run();
        break;
      }
      await finishSucceeded(
        db,
        current.id,
        stored.r2Key,
        poll.result.meta,
        nowMs,
      );
      break;
    }
    case "failed":
      await finishFailed(
        db,
        current,
        poll.errorCode,
        `Provider error: ${poll.errorCode}`,
        nowMs,
      );
      break;
    case "not_found":
      await finishFailed(
        db,
        current,
        "provider_task_not_found",
        "Upstream no longer knows this task",
        nowMs,
      );
      break;
    case "poll_exhausted":
      break;
  }
  const final = await getTaskById(db, task.id);
  return final ?? current;
}

function parseParams(task: VideoTaskRow): VideoSubmitRequest["params"] {
  if (!task.paramsJson) return {};
  try {
    return JSON.parse(task.paramsJson);
  } catch {
    return {};
  }
}

/** Fetch a single task scoped to its owner. */
export async function getTaskRow(
  db: CreditsDB,
  taskId: string,
  userId: string,
): Promise<VideoTaskRow | null> {
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM video_tasks WHERE id = ? AND user_id = ?`,
    )
    .bind(taskId, userId)
    .all<Record<string, unknown>>();
  return results[0] ? rowToTask(results[0]) : null;
}

/** Force-fail a task (watchdog/timeout/operator paths). Idempotent: the
 *  conditional UPDATE plus the unique refund key make repeats harmless. */
export async function failTask(
  db: CreditsDB,
  task: VideoTaskRow,
  errorCode: string,
  errorMessage: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return finishFailed(db, task, errorCode, errorMessage, nowMs);
}
