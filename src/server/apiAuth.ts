/**
 * Shared auth helper for /api/* route handlers.
 * Returns the Better Auth session or null for anonymous visitors.
 */
import { createAuth, type CloudflareBindings } from "@/auth";
import { env } from "cloudflare:workers";
import { getRequest } from "@tanstack/react-start/server";

export async function requireSession(): Promise<{
  userId: string;
} | null> {
  const request = getRequest();
  const auth = createAuth(env as unknown as CloudflareBindings, (request as any).cf);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return null;
  return { userId: session.user.id };
}

export function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}
