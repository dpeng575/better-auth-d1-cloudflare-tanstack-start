import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { jsonError, requireSession } from "@/server/apiAuth";
import { driveTask, getTaskRow, taskPublicJson } from "@/server/video/tasks";
import { getProvider } from "@/server/video/registry";

function getDb(): CreditsDB {
  return (env as any).DATABASE as CreditsDB;
}

export const Route = createFileRoute("/api/video/tasks/$taskId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const db = getDb();
        const task = await getTaskRow(db, params.taskId, session.userId);
        if (!task) return jsonError(404, "task_not_found", "No such task");

        // Opportunistic state-machine drive (P2 has no cron yet; P3 moves
        // driving to the cron worker and this stays as an accelerator).
        let current = task;
        if (current.status === "queued" || current.status === "processing") {
          const provider = getProvider(current.providerCode);
          if (provider) {
            current = await driveTask(db, current, provider, {
              r2: (env as any).R2_BUCKET,
            });
          }
        }

        return Response.json({ task: taskPublicJson(current) });
      },
    },
  },
});
