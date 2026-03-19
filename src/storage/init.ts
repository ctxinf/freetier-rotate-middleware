import type { GatewayDb } from "./db.js";

async function tableHasColumn(db: GatewayDb, tableName: string, columnName: string): Promise<boolean> {
  const res = await db.raw.execute(`PRAGMA table_info(${tableName})`);
  const rows = (res.rows as any[]) ?? [];
  return rows.some((r) => String(r?.name) === columnName);
}

async function migrateQuotaCountersToUpstreamModel(db: GatewayDb): Promise<void> {
  const hasUpstreamModel = await tableHasColumn(db, "quota_counters", "upstream_model");
  if (hasUpstreamModel) {
    await db.raw.execute(
      "CREATE INDEX IF NOT EXISTS idx_quota_counters_upstream_bucket ON quota_counters(upstream_model, bucket_key)"
    );
    return;
  }

  const hasRouteItemId = await tableHasColumn(db, "quota_counters", "route_item_id");
  if (!hasRouteItemId) return;

  await db.raw.batch(
    [
      "ALTER TABLE quota_counters RENAME TO quota_counters_legacy",
      `CREATE TABLE quota_counters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_model TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        used_req INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(upstream_model, bucket_key)
      )`,
      `INSERT INTO quota_counters(upstream_model, bucket_key, used_tokens, used_req, updated_at)
       SELECT
         COALESCE(ri.upstream_model, '__legacy_route_' || CAST(q.route_item_id AS TEXT)) AS upstream_model,
         q.bucket_key,
         SUM(COALESCE(q.used_tokens, 0)) AS used_tokens,
         SUM(COALESCE(q.used_req, 0)) AS used_req,
         MAX(COALESCE(q.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) AS updated_at
       FROM quota_counters_legacy q
       LEFT JOIN route_items ri ON ri.id = q.route_item_id
       GROUP BY COALESCE(ri.upstream_model, '__legacy_route_' || CAST(q.route_item_id AS TEXT)), q.bucket_key`,
      "DROP TABLE quota_counters_legacy",
      "CREATE INDEX IF NOT EXISTS idx_quota_counters_upstream_bucket ON quota_counters(upstream_model, bucket_key)"
    ],
    "write"
  );
}

async function ensureRequestLogsUpstreamColumn(db: GatewayDb): Promise<void> {
  const hasUpstreamModel = await tableHasColumn(db, "request_logs", "upstream_model");
  if (!hasUpstreamModel) {
    await db.raw.execute("ALTER TABLE request_logs ADD COLUMN upstream_model TEXT");
  }
  await db.raw.execute(
    "CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_model, created_at DESC)"
  );
}

export async function initSchema(db: GatewayDb): Promise<void> {
  await db.raw.execute("PRAGMA busy_timeout = 5000");
  await db.raw.execute("PRAGMA journal_mode = WAL");

  await db.raw.batch(
    [
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
        upstream_model TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        used_req INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(upstream_model, bucket_key)
      )`,
      `CREATE TABLE IF NOT EXISTS request_logs (
        request_id TEXT PRIMARY KEY,
        route_item_id INTEGER,
        upstream_model TEXT,
        status INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC)",
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`
    ],
    "write"
  );

  await migrateQuotaCountersToUpstreamModel(db);
  await ensureRequestLogsUpstreamColumn(db);
  await db.raw.execute(
    "CREATE INDEX IF NOT EXISTS idx_quota_counters_upstream_bucket ON quota_counters(upstream_model, bucket_key)"
  );
}
