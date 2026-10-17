/**
 * Idempotent seeding of the mock provider + models into the registry tables.
 * Runs on every video API call (INSERT OR IGNORE), so fresh databases work
 * without a manual seed step. Real providers are registered the same way.
 */
import type { CreditsDB } from "../credits";

const SEED_PROVIDER_SQL = `
  INSERT OR IGNORE INTO providers (id, code, name, enabled, priority, created_at)
  VALUES (?, 'mock', 'Mock Provider', 1, 0, ?)
`;

const SEED_MODEL_SQL = `
  INSERT OR IGNORE INTO provider_models
    (id, provider_id, code, name, credit_cost, max_duration_sec, enabled, params_schema_json)
  VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
`;

export async function ensureMockProviderSeeded(db: CreditsDB): Promise<void> {
  const now = Date.now();
  const providerId = "provider-mock";

  await db
    .prepare(SEED_PROVIDER_SQL)
    .bind(providerId, now)
    .run();

  // Two models so the UI selector is meaningful and the failure path is
  // exercisable (mock-pro fails when the prompt contains "fail").
  await db
    .prepare(SEED_MODEL_SQL)
    .bind("model-mock-fast", providerId, "mock-fast", "Mock Fast", 10, 15)
    .run();
  await db
    .prepare(SEED_MODEL_SQL)
    .bind("model-mock-pro", providerId, "mock-pro", "Mock Pro", 25, 30)
    .run();
}
