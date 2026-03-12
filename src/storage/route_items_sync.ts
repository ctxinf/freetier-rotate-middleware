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

export async function syncRouteItemsFromConfig(db: GatewayDb, items: RouteItemSeed[], mode: RouteItemsSyncMode): Promise<{
  inserted: number;
  updated: number;
  deleted: number;
}> {
  const desired = new Map<string, RouteItemSeed>();
  for (const it of items) {
    const k = keyOf(it);
    if (desired.has(k)) {
      throw new Error(`Duplicate routeItem in config: ${k}`);
    }
    desired.set(k, it);
  }

  const tx = await db.raw.transaction("write");
  try {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    for (const it of desired.values()) {
      const existingRes = await tx.execute({
        sql: "SELECT id FROM route_items WHERE public_model = ? AND upstream_model = ? AND strategy_type = ? AND priority = ? LIMIT 1",
        args: [it.publicModel, it.upstreamModel, it.strategyType, it.priority]
      });
      const existing = (existingRes.rows?.[0] as any) ?? null;

      if (existing?.id) {
        await tx.execute({
          sql: "UPDATE route_items SET config_json = ?, enabled = ? WHERE id = ?",
          args: [it.configJson, it.enabled, existing.id]
        });
        updated++;
      } else {
        await tx.execute({
          sql: "INSERT INTO route_items(public_model, upstream_model, strategy_type, priority, config_json, enabled) VALUES(?, ?, ?, ?, ?, ?)",
          args: [it.publicModel, it.upstreamModel, it.strategyType, it.priority, it.configJson, it.enabled]
        });
        inserted++;
      }
    }

    if (mode === "authoritative") {
      const rowsRes = await tx.execute(
        "SELECT id, public_model, upstream_model, strategy_type, priority, enabled FROM route_items"
      );
      const rows = (rowsRes.rows as any[]) ?? [];
      for (const r of rows) {
        const k = keyOf({
          publicModel: r.public_model,
          upstreamModel: r.upstream_model,
          strategyType: r.strategy_type,
          priority: r.priority
        });
        if (!desired.has(k)) {
          await tx.execute({ sql: "DELETE FROM route_items WHERE id = ?", args: [r.id] });
          deleted++;
        }
      }
    }

    await tx.commit();
    return { inserted, updated, deleted };
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}
