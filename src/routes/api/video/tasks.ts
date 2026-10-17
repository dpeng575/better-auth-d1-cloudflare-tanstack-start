import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { jsonError, requireSession } from "@/server/apiAuth";
import { createVideoTask, listUserTasks, taskPublicJson } from "@/server/video/tasks";

function getDb(): CreditsDB {
  return (env as any).DATABASE as CreditsDB;
}

export const Route = createFileRoute("/api/video/tasks")({
  server: {
    handlers: {
      GET: async () => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const tasks = await listUserTasks(getDb(), session.userId);
        return Response.json({ tasks: tasks.map(taskPublicJson) });
      },

      POST: async ({ request }) => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        let body: {
          modelCode?: unknown;
          prompt?: unknown;
          clientKey?: unknown;
          params?: unknown;
        };
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "invalid_json", "Body must be JSON");
        }

        const modelCode = typeof body.modelCode === "string" ? body.modelCode : "";
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const clientKey = typeof body.clientKey === "string" ? body.clientKey : "";
        const params =
          body.params && typeof body.params === "object"
            ? (body.params as Record<string, unknown>)
            : undefined;

        if (!modelCode) return jsonError(400, "missing_model", "modelCode is required");
        if (prompt.length === 0 || prompt.length > 2000) {
          return jsonError(400, "invalid_prompt", "prompt must be 1-2000 chars");
        }
        if (!clientKey || clientKey.length > 128) {
          return jsonError(400, "invalid_client_key", "clientKey must be 1-128 chars");
        }

        const result = await createVideoTask(getDb(), {
          userId: session.userId,
          modelCode,
          prompt,
          clientKey,
          params: params as any,
        });

        if (!result.ok) {
          if (result.error === "model_not_found") {
            return jsonError(404, "model_not_found", "Unknown or disabled model");
          }
          return jsonError(
            402,
            "insufficient_credits",
            "Not enough credits for this model",
          );
        }

        return Response.json(
          { task: taskPublicJson(result.task), created: result.created },
          { status: result.created ? 201 : 200 },
        );
      },
    },
  },
});
