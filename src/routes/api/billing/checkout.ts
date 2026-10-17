import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { jsonError, requireSession } from "@/server/apiAuth";
import { createOrderAndCheckout } from "@/server/billing/orders";
import type { WaffoClientConfig } from "@/server/billing/waffo";

function getWaffoConfig(): WaffoClientConfig | null {
  const e = env as any;
  if (!e.WAFFO_API_KEY) return null;
  return { apiKey: e.WAFFO_API_KEY, apiUrl: e.WAFFO_API_URL };
}

export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await requireSession();
        if (!session) return jsonError(401, "unauthorized", "Sign in first");

        const waffo = getWaffoConfig();
        if (!waffo) {
          return jsonError(
            503,
            "payment_unavailable",
            "Payment provider is not configured",
          );
        }

        let body: { planCode?: unknown };
        try {
          body = await request.json();
        } catch {
          return jsonError(400, "invalid_json", "Body must be JSON");
        }
        const planCode = typeof body.planCode === "string" ? body.planCode : "";
        if (!planCode) return jsonError(400, "missing_plan", "planCode is required");

        // Waffo requires a real userEmail; anonymous accounts only have a
        // generated placeholder — block them from checkout.
        const authMod = await import("@/auth");
        const auth = authMod.createAuth(env as any, (request as any).cf);
        const s = await auth.api.getSession({ headers: request.headers });
        const email = s?.user?.email ?? "";
        const isAnonymous = (s?.user as any)?.isAnonymous === true;
        if (isAnonymous || !email) {
          return jsonError(
            403,
            "email_required",
            "Sign in with email or bind an email before purchasing",
          );
        }

        const url = new URL(request.url);
        const result = await createOrderAndCheckout(
          (env as any).DATABASE,
          {
            userId: session.userId,
            planCode,
            userEmail: email,
            baseUrl: url.origin,
            waffo,
          },
        );

        if (!result.ok) {
          if (result.error === "plan_not_found") {
            return jsonError(404, "plan_not_found", "Unknown plan");
          }
          return jsonError(
            502,
            "waffo_error",
            `Payment provider error: ${result.detail ?? "unknown"}`,
          );
        }

        return Response.json(
          { orderNo: result.order.orderNo, checkoutUrl: result.checkoutUrl },
          { status: 201 },
        );
      },
    },
  },
});
