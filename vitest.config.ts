import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Forks pool: unit tests run against drizzle schemas and pure functions.
    // (The app itself is exercised via `pnpm dev` / `pnpm preview`.)
    pool: "forks",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
