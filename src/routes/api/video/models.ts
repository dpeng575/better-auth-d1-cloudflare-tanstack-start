import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { jsonError, requireSession } from "@/server/apiAuth";

export const Route = createFileRoute("/api/video/models")({
  server: {
    handlers: {
      GET: async () => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const { results } = await (env as any).DATABASE.prepare(
          `SELECT m.code, m.name, m.credit_cost AS creditCost,
                  m.max_duration_sec AS maxDurationSec
           FROM provider_models m
           JOIN providers p ON p.id = m.provider_id
           WHERE m.enabled = 1 AND p.enabled = 1
           ORDER BY m.credit_cost ASC`,
        ).all();

        return Response.json({ models: results });
      },
    },
  },
});
