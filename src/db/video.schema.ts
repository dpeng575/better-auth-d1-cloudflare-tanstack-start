import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * A video generation task. Created in `queued` after credits are reserved,
 * then driven to a terminal state by the cron worker (see docs in
 * src/server/video). Status transitions must use conditional UPDATEs so that
 * concurrent drivers (cron tick vs provider webhook) stay idempotent.
 */
export const videoTasks = sqliteTable(
  "video_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'queued' | 'processing' | 'succeeded' | 'failed'
    status: text("status").notNull().default("queued"),
    providerCode: text("provider_code").notNull(),
    modelCode: text("model_code").notNull(),
    prompt: text("prompt").notNull(),
    paramsJson: text("params_json"), // normalized params (JSON)
    providerTaskId: text("provider_task_id"),
    creditsReserved: integer("credits_reserved").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    resultR2Key: text("result_r2_key"),
    resultMetaJson: text("result_meta_json"), // duration/resolution etc. (JSON)
    // userId-scoped client key: blocks double-submit on retry/refresh
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("task_user_idx").on(table.userId, table.createdAt),
    // cron scans by status + updatedAt to pick up work and stale tasks
    index("task_status_idx").on(table.status, table.updatedAt),
  ],
);

export const videoTasksRelations = relations(videoTasks, ({ one }) => ({
  user: one(users, {
    fields: [videoTasks.userId],
    references: [users.id],
  }),
}));
