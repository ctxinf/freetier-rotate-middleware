import type { GatewayDb } from "./db.js";

export async function initSchema(db: GatewayDb): Promise<void> {
  await db.raw.batch(
    [
      "PRAGMA journal_mode = WAL",
      "PRAGMA busy_timeout = 5000",
      `CREATE TABLE IF NOT EXISTS route_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_model TEXT NOT NULL,
        upstream_model TEXT NOT NULL,
        strategy_type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      )`,
      "CREATE INDEX IF NOT EXISTS idx_route_items_model_enabled ON route_items(public_model, enabled, priority)",
      `CREATE TABLE IF NOT EXISTS quota_counters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_item_id INTEGER NOT NULL,
        bucket_key TEXT NOT NULL,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        used_req INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(route_item_id, bucket_key)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_quota_counters_route_bucket ON quota_counters(route_item_id, bucket_key)",
      `CREATE TABLE IF NOT EXISTS request_logs (
        request_id TEXT PRIMARY KEY,
        route_item_id INTEGER,
        status INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`
    ],
    "write"
  );
}
