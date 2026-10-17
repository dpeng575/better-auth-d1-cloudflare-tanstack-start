import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export async function getDb() {
  // Ensure "DATABASE" matches your D1 binding name in wrangler.jsonc
  return drizzle(env.DATABASE, {
    schema,
    // SQL logging is dev-only: it can leak user data into Workers logs
    logger: process.env.NODE_ENV !== "production",
  });
}

// Re-export the drizzle-orm types and utilities from here for convenience
export * from "drizzle-orm";

// Re-export all schema tables
export * from "./schema";
