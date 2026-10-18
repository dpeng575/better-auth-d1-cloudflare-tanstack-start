import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { getBalance } from "@/server/credits";
import { jsonError, requireSession } from "@/server/apiAuth";

export const Route = createFileRoute("/api/credits/balance")({
  server: {
    handlers: {
      GET: async () => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const balance = await getBalance(
          (env as any).DATABASE as CreditsDB,
          session.userId,
        );
        return Response.json({ balance });
      },
    },
  },
});
