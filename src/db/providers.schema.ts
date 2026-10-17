import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Registry of video generation providers. Operational toggles (enabled,
 * priority) live here; provider SECRETS never do — those are Worker secrets.
 */
export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(), // 'mock' | 'replicate' | ...
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  configJson: text("config_json"), // non-secret config only
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const providerModels = sqliteTable(
  "provider_models",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    code: text("code").notNull(), // provider-specific model code
    name: text("name").notNull(),
    creditCost: integer("credit_cost").notNull(),
    maxDurationSec: integer("max_duration_sec"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    paramsSchemaJson: text("params_schema_json"), // which normalized params this model accepts
  },
  (table) => [index("model_provider_idx").on(table.providerId)],
);

export const providersRelations = relations(providers, ({ many }) => ({
  models: many(providerModels),
}));

export const providerModelsRelations = relations(providerModels, ({ one }) => ({
  provider: one(providers, {
    fields: [providerModels.providerId],
    references: [providers.id],
  }),
}));
