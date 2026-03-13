import type { GatewayDb } from "./db.js";

export type RouteItemSeed = {
  entryModel: string;
  upstreamModel: string;
  strategyType: "token_day" | "req_min_day";
  priority: number;
  configJson: string;
  enabled: number;
};

export type ConfigLoadMode = "authoritative" | "load_once";

function keyOf(item: Pick<RouteItemSeed, "entryModel" | "upstreamModel">): string {
  return `${item.entryModel}::${item.upstreamModel}`;
}

export async function syncRouteItemsFromConfig(db: GatewayDb, items: RouteItemSeed[], mode: ConfigLoadMode): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
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
    let skipped = 0;
    let deleted = 0;

    for (const it of desired.values()) {
      const existingRes = await tx.execute({
        sql: "SELECT id FROM route_items WHERE public_model = ? AND upstream_model = ? LIMIT 1",
        args: [it.entryModel, it.upstreamModel]
      });
      const existing = (existingRes.rows?.[0] as any) ?? null;

      if (existing?.id) {
        if (mode === "load_once") {
          skipped++;
          continue;
        }

        await tx.execute({
          sql: "UPDATE route_items SET strategy_type = ?, priority = ?, config_json = ?, enabled = ? WHERE id = ?",
          args: [it.strategyType, it.priority, it.configJson, it.enabled, existing.id]
        });
        updated++;
      } else {
        await tx.execute({
          sql: "INSERT INTO route_items(public_model, upstream_model, strategy_type, priority, config_json, enabled) VALUES(?, ?, ?, ?, ?, ?)",
          args: [it.entryModel, it.upstreamModel, it.strategyType, it.priority, it.configJson, it.enabled]
        });
        inserted++;
      }
    }

    if (mode === "authoritative") {
      const rowsRes = await tx.execute(
        "SELECT id, public_model, upstream_model FROM route_items"
      );
      const rows = (rowsRes.rows as any[]) ?? [];
      const keptUnique = new Set<string>();
      for (const r of rows) {
        const k = keyOf({
          entryModel: r.public_model,
          upstreamModel: r.upstream_model
        });
        if (keptUnique.has(k) || !desired.has(k)) {
          await tx.execute({ sql: "DELETE FROM route_items WHERE id = ?", args: [r.id] });
          deleted++;
          continue;
        }
        keptUnique.add(k);
      }
    }

    await tx.commit();
    return { inserted, updated, skipped, deleted };
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}
