/**
 * Custom Cloudflare Worker entry: delegates fetch to TanStack Start's
 * handler and adds the `scheduled` handler that drives the video task
 * state machine every minute (see src/server/video/cron.ts).
 *
 * wrangler.jsonc "main" points here instead of the default
 * "@tanstack/react-start/server-entry", which only exports fetch.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { CreditsDB } from "@/server/credits";
import { runVideoCron } from "@/server/video/cron";
import { reconcilePendingOrders } from "@/server/billing/orders";

const fetchHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request): Promise<Response> {
    return fetchHandler(request);
  },

  async scheduled(
    _controller: ScheduledController,
    _env: unknown,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runVideoCron(
          (env as any).DATABASE as CreditsDB,
          Date.now(),
          (env as any).R2_BUCKET,
        );
        // Payment reconciliation — only when Waffo is configured.
        if ((env as any).WAFFO_API_KEY) {
          await reconcilePendingOrders(
            (env as any).DATABASE as CreditsDB,
            {
              apiKey: (env as any).WAFFO_API_KEY,
              apiUrl: (env as any).WAFFO_API_URL,
            },
          );
        }
      })(),
    );
  },
};
