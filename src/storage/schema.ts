import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const routeItems = sqliteTable("route_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entryModel: text("public_model").notNull(),
  upstreamModel: text("upstream_model").notNull(),
  strategyType: text("strategy_type").notNull(),
  priority: integer("priority").notNull().default(0),
  configJson: text("config_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1)
});

export const requestLogs = sqliteTable("request_logs", {
  requestId: text("request_id").primaryKey(),
  routeItemId: integer("route_item_id"),
  upstreamModel: text("upstream_model"),
  status: integer("status"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  latencyMs: integer("latency_ms"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});
