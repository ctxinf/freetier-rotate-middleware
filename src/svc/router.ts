import { and, asc, desc, eq } from "drizzle-orm";
import type { GatewayDb } from "../storage/db.js";
import { routeItems } from "../storage/schema.js";

export type StrategyType = "token_day" | "req_min_day";

export type RouteItem = {
  id: number;
  publicModel: string;
  upstreamModel: string;
  strategyType: StrategyType;
  priority: number;
  configJson: string;
  enabled: number;
};

export function createRouter(db: GatewayDb) {
  async function listCandidates(publicModel: string): Promise<RouteItem[]> {
    const rows = await db.orm
      .select()
      .from(routeItems)
      .where(and(eq(routeItems.publicModel, publicModel), eq(routeItems.enabled, 1)))
      .orderBy(desc(routeItems.priority), asc(routeItems.id));

    return rows.map((r) => ({
      ...r,
      strategyType: r.strategyType as StrategyType
    }));
  }

  return { listCandidates };
}

