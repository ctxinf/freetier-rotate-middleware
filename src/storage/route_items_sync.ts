import type { GatewayDb } from "./db.js";

export type RouteItemSeed = {
  publicModel: string;
  upstreamModel: string;
  strategyType: "token_day" | "req_min_day";
  priority: number;
  configJson: string;
  enabled: number;
};

export type RouteItemsSyncMode = "authoritative" | "merge";

function keyOf(item: Pick<RouteItemSeed, "publicModel" | "upstreamModel" | "strategyType" | "priority">): string {
  return `${item.publicModel}::${item.upstreamModel}::${item.strategyType}::${item.priority}`;
}

export function syncRouteItemsFromConfig(db: GatewayDb, items: RouteItemSeed[], mode: RouteItemsSyncMode): {
  inserted: number;
  updated: number;
  deleted: number;
} {
  const desired = new Map<string, RouteItemSeed>();
  for (const it of items) {
    const k = keyOf(it);
    if (desired.has(k)) {
      throw new Error(`Duplicate routeItem in config: ${k}`);
    }
    desired.set(k, it);
  }

  const selectExistingId = db.raw.prepare(
    "SELECT id FROM route_items WHERE public_model = ? AND upstream_model = ? AND strategy_type = ? AND priority = ? LIMIT 1"
  );
  const insertStmt = db.raw.prepare(
    "INSERT INTO route_items(public_model, upstream_model, strategy_type, priority, config_json, enabled) VALUES(?, ?, ?, ?, ?, ?)"
  );
  const updateStmt = db.raw.prepare(
    "UPDATE route_items SET config_json = ?, enabled = ? WHERE id = ?"
  );

  const allRowsStmt = db.raw.prepare(
    "SELECT id, public_model, upstream_model, strategy_type, priority, enabled FROM route_items"
  );
  const deleteStmt = db.raw.prepare("DELETE FROM route_items WHERE id = ?");

  const result = db.raw.transaction(() => {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    for (const it of desired.values()) {
      const existing = selectExistingId.get(it.publicModel, it.upstreamModel, it.strategyType, it.priority) as any;
      if (existing?.id) {
        updateStmt.run(it.configJson, it.enabled, existing.id);
        updated++;
      } else {
        insertStmt.run(it.publicModel, it.upstreamModel, it.strategyType, it.priority, it.configJson, it.enabled);
        inserted++;
      }
    }

    if (mode === "authoritative") {
      const rows = allRowsStmt.all() as any[];
      for (const r of rows) {
        const k = keyOf({
          publicModel: r.public_model,
          upstreamModel: r.upstream_model,
          strategyType: r.strategy_type,
          priority: r.priority
        });
        if (!desired.has(k)) {
          deleteStmt.run(r.id);
          deleted++;
        }
      }
    }

    return { inserted, updated, deleted };
  })();

  return result;
}
