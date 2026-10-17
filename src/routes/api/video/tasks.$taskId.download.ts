import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { jsonError, requireSession } from "@/server/apiAuth";
import { getTaskRow } from "@/server/video/tasks";

/**
 * Streams the finished video from R2. Owner-only, terminal-state-only.
 */
export const Route = createFileRoute("/api/video/tasks/$taskId/download")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const task = await getTaskRow(
          (env as any).DATABASE,
          params.taskId,
          session.userId,
        );
        if (!task) return jsonError(404, "task_not_found", "No such task");
        if (task.status !== "succeeded" || !task.resultR2Key) {
          return jsonError(
            409,
            "not_ready",
            "Task has no downloadable result yet",
          );
        }

        const object = await (env as any).R2_BUCKET.get(task.resultR2Key);
        if (!object) {
          return jsonError(410, "result_gone", "Stored result is missing");
        }

        const headers = new Headers();
        headers.set(
          "Content-Type",
          object.httpMetadata?.contentType ?? "application/octet-stream",
        );
        headers.set(
          "Content-Disposition",
          `attachment; filename="video-${task.id}.bin"`,
        );
        headers.set("Content-Length", String(object.size));
        return new Response(object.body, { headers });
      },
    },
  },
});
