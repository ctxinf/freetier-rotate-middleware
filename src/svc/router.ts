import { and, asc, desc, eq } from "drizzle-orm";
import type { GatewayDb } from "../storage/db.js";
import { routeItems } from "../storage/schema.js";

export type StrategyType = "token_day" | "req_min_day";

export type RouteItem = {
  id: number;
  entryModel: string;
  upstreamModel: string;
  strategyType: StrategyType;
  priority: number;
  configJson: string;
  enabled: number;
};

export function createRouter(db: GatewayDb) {
  const priorityRotateCursor = new Map<string, number>();

  function rotateWithinSamePriority(entryModel: string, rows: any[]): any[] {
    if (rows.length <= 1) return rows;

    const out: any[] = [];
    let i = 0;
    while (i < rows.length) {
      const start = i;
      const prio = rows[i]!.priority;
      while (i < rows.length && rows[i]!.priority === prio) i++;
      const group = rows.slice(start, i);

      if (group.length <= 1) {
        out.push(...group);
        continue;
      }

      const key = `${entryModel}::${String(prio)}`;
      const cursor = priorityRotateCursor.get(key) ?? 0;
      const offset = ((cursor % group.length) + group.length) % group.length;
      priorityRotateCursor.set(key, (offset + 1) % group.length);
      out.push(...group.slice(offset), ...group.slice(0, offset));
    }

    return out;
  }

  async function listCandidates(entryModel: string): Promise<RouteItem[]> {
    const rows = await db.orm
      .select()
      .from(routeItems)
      .where(and(eq(routeItems.entryModel, entryModel), eq(routeItems.enabled, 1)))
      .orderBy(desc(routeItems.priority), asc(routeItems.id));
    const rotatedRows = rotateWithinSamePriority(entryModel, rows as any[]);

    return rotatedRows.map((r) => ({
      ...r,
      strategyType: r.strategyType as StrategyType
    }));
  }

  async function hasEntryModel(entryModel: string): Promise<boolean> {
    const res = await db.raw.execute({
      sql: "SELECT 1 FROM route_items WHERE public_model = ? LIMIT 1",
      args: [entryModel]
    });
    return Number((res.rows?.length ?? 0)) > 0;
  }

  return { listCandidates, hasEntryModel };
}
