import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

// This function guarantees execution ONLY on the server
export const getPublicURL = createServerFn({ method: "GET" }).handler(
  async () => {
    const _env = env as any;

    // 1. Always trust the PUBLIC_URL env var when set (production requirement).
    const envUrl = _env.PUBLIC_URL;
    if (envUrl) return envUrl;

    // 2. Dev-only fallback: infer from the request.
    //    The Host header can be spoofed, so never use this in production.
    const request = getRequest();
    if (request?.headers) {
      const host = request.headers.get("host");
      if (host?.includes("localhost")) {
        return `http://${host}`;
      }
    }

    return "http://localhost:3000";
  },
);
