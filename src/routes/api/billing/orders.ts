import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { jsonError, requireSession } from "@/server/apiAuth";
import { listUserOrders } from "@/server/billing/orders";

export const Route = createFileRoute("/api/billing/orders")({
  server: {
    handlers: {
      GET: async () => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const orders = await listUserOrders(
          (env as any).DATABASE as CreditsDB,
          session.userId,
        );
        return Response.json({ orders });
      },
    },
  },
});
