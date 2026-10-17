import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { markOrderPaidAndGrantCredits } from "@/server/billing/orders";
import { verifyWaffoSignature } from "@/server/billing/waffo";

/**
 * Waffo payment webhook (notifyUrl).
 *
 * Official contract: verify the RSA signature over the RAW body BEFORE
 * processing; reply 200 {"message":"success"} when handled, 200
 * {"message":"failed"} when the signature check fails (Waffo retries).
 * Event field names are kept loose until confirmed against sandbox traffic;
 * the idempotent grant makes repeated deliveries harmless either way.
 */
export const Route = createFileRoute("/api/webhooks/waffo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const e = env as any;
        const rawBody = await request.text();
        const signature = request.headers.get("X-SIGNATURE") ?? "";

        const publicKey: string | undefined = e.WAFFO_PUBLIC_KEY;
        if (!publicKey) {
          return Response.json({ message: "failed" }, { status: 200 });
        }

        const valid = await verifyWaffoSignature(rawBody, signature, publicKey);
        if (!valid) {
          return Response.json({ message: "failed" }, { status: 200 });
        }

        let event: any;
        try {
          event = JSON.parse(rawBody);
        } catch {
          return Response.json({ message: "success" }, { status: 200 });
        }

        // Loose extraction until sandbox confirms the exact event schema.
        const eventType = String(
          event?.eventType ?? event?.type ?? event?.event ?? "",
        );
        const payload = event?.data ?? event?.object ?? event;
        const orderNo: string | undefined =
          payload?.outTradeNo ?? payload?.orderNo ?? payload?.merchantOrderNo;
        const paymentRef: string | null =
          payload?.tradeNo ?? payload?.paymentId ?? null;
        const status = String(payload?.status ?? "").toLowerCase();
        const looksSuccessful =
          /success|paid|completed/i.test(eventType) ||
          /success|paid|completed/i.test(status);

        if (orderNo && looksSuccessful) {
          await markOrderPaidAndGrantCredits(
            (env as any).DATABASE as CreditsDB,
            orderNo,
            paymentRef,
          );
        }

        return Response.json({ message: "success" }, { status: 200 });
      },
    },
  },
});
