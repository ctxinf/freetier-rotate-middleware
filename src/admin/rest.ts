import type { Context, Hono } from "hono";
import { createLogger } from "../logging.js";
import type { AppContext } from "../svc/context.js";
import { normalizeStrategyConfigJson, type RouteStrategyType } from "../svc/route-config.js";

const log = createLogger("admin.rest");

type StrategyType = RouteStrategyType;

type RouteWritePayload = {
  entryModel: string;
  upstreamModel: string;
  strategyType: StrategyType;
  priority: number;
  enabled: number;
  configJson: string;
};

function parseRouteWritePayload(input: any): RouteWritePayload {
  const entryModel = String(input?.entryModel ?? "").trim();
  const upstreamModel = String(input?.upstreamModel ?? "").trim();
  if (!entryModel) throw new Error("entryModel is required");
  if (!upstreamModel) throw new Error("upstreamModel is required");

  const strategyType = input?.strategyType;
  if (strategyType !== "token_day" && strategyType !== "req_min_day") {
    throw new Error("strategyType must be token_day or req_min_day");
  }

  const priority = Number(input?.priority);
  if (!Number.isFinite(priority)) throw new Error("priority must be a number");

  const enabledRaw = input?.enabled;
  const enabled = enabledRaw === 0 || enabledRaw === "0" || enabledRaw === false ? 0 : 1;

  const rawConfig = input?.configJson !== undefined ? input.configJson : input?.config;
  const configJson = normalizeStrategyConfigJson(strategyType, rawConfig, "route");
  let configObj: any;
  try {
    configObj = JSON.parse(configJson);
  } catch {
    throw new Error("configJson must be valid JSON");
  }

  if (!configObj || typeof configObj !== "object" || Array.isArray(configObj)) {
    throw new Error("config/configJson must be an object");
  }

  if (strategyType === "req_min_day") {
    const reqPerMin = Number(configObj.reqPerMin);
    const reqPerDay = Number(configObj.reqPerDay);
    if (!Number.isFinite(reqPerMin) || reqPerMin <= 0) throw new Error("req_min_day requires reqPerMin > 0");
    if (!Number.isFinite(reqPerDay) || reqPerDay <= 0) throw new Error("req_min_day requires reqPerDay > 0");
  }

  if (strategyType === "token_day") {
    const dailyTokenLimit = Number(configObj?.dailyTokenLimit);
    if (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit <= 0) {
      throw new Error("token_day requires dailyTokenLimit > 0");
    }
  }

  return {
    entryModel,
    upstreamModel,
    strategyType,
    priority,
    enabled,
    configJson
  };
}

function parseRouteId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid route id");
  return id;
}

function parseUpstreamBaseUrl(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("upstreamBaseUrl is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("upstreamBaseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("upstreamBaseUrl must use http or https");
  }
  return parsed.toString();
}

async function listRoutes(app: AppContext): Promise<any[]> {
  const res = await app.db.raw.execute(
    "SELECT id, public_model AS entryModel, upstream_model AS upstreamModel, strategy_type AS strategyType, priority, config_json AS configJson, enabled FROM route_items ORDER BY public_model ASC, priority DESC, id ASC"
  );
  return (res.rows as any[]) ?? [];
}

async function getRouteById(app: AppContext, id: number): Promise<any | null> {
  const res = await app.db.raw.execute({
    sql: "SELECT id, public_model AS entryModel, upstream_model AS upstreamModel, strategy_type AS strategyType, priority, config_json AS configJson, enabled FROM route_items WHERE id = ? LIMIT 1",
    args: [id]
  });
  return ((res.rows as any[]) ?? [])[0] ?? null;
}

async function findRouteIdByUniqueKey(app: AppContext, entryModel: string, upstreamModel: string): Promise<number | null> {
  const res = await app.db.raw.execute({
    sql: "SELECT id FROM route_items WHERE public_model = ? AND upstream_model = ? LIMIT 1",
    args: [entryModel, upstreamModel]
  });
  const row = ((res.rows as any[]) ?? [])[0] ?? null;
  return row?.id ? Number(row.id) : null;
}

export function registerAdminRestRoutes(app: Hono, ctx: AppContext): void {
  // Keep REST registration separate for future Hono JSR page layer.
  app.get("/admin/routes", async (c) => {
    return c.json({ data: await listRoutes(ctx) });
  });

  app.get("/admin/routes/:id", async (c) => {
    let id: number;
    try {
      id = parseRouteId(c.req.param("id"));
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }
    const row = await getRouteById(ctx, id);
    if (!row) return c.json({ error: { message: "route not found" } }, 404);
    return c.json({ data: row });
  });

  app.post("/admin/routes", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "invalid json body" } }, 400);
    }

    let payload: RouteWritePayload;
    try {
      payload = parseRouteWritePayload(body);
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }

    const dupId = await findRouteIdByUniqueKey(ctx, payload.entryModel, payload.upstreamModel);
    if (dupId) {
      return c.json({ error: { message: "route already exists for entryModel+upstreamModel", routeId: dupId } }, 409);
    }

    await ctx.db.raw.execute({
      sql: "INSERT INTO route_items(public_model, upstream_model, strategy_type, priority, config_json, enabled) VALUES(?, ?, ?, ?, ?, ?)",
      args: [
        payload.entryModel,
        payload.upstreamModel,
        payload.strategyType,
        payload.priority,
        payload.configJson,
        payload.enabled
      ]
    });

    const createdId = await findRouteIdByUniqueKey(ctx, payload.entryModel, payload.upstreamModel);
    const row = createdId ? await getRouteById(ctx, createdId) : null;
    log.info("route created", { routeId: createdId, entryModel: payload.entryModel, upstreamModel: payload.upstreamModel });
    return c.json({ data: row }, 201);
  });

  app.put("/admin/routes/:id", async (c) => {
    let id: number;
    try {
      id = parseRouteId(c.req.param("id"));
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }

    const exists = await getRouteById(ctx, id);
    if (!exists) return c.json({ error: { message: "route not found" } }, 404);

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "invalid json body" } }, 400);
    }

    let payload: RouteWritePayload;
    try {
      payload = parseRouteWritePayload(body);
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }

    const dupId = await findRouteIdByUniqueKey(ctx, payload.entryModel, payload.upstreamModel);
    if (dupId && dupId !== id) {
      return c.json({ error: { message: "route already exists for entryModel+upstreamModel", routeId: dupId } }, 409);
    }

    await ctx.db.raw.execute({
      sql: "UPDATE route_items SET public_model = ?, upstream_model = ?, strategy_type = ?, priority = ?, config_json = ?, enabled = ? WHERE id = ?",
      args: [
        payload.entryModel,
        payload.upstreamModel,
        payload.strategyType,
        payload.priority,
        payload.configJson,
        payload.enabled,
        id
      ]
    });

    const row = await getRouteById(ctx, id);
    log.info("route updated", { routeId: id, entryModel: payload.entryModel, upstreamModel: payload.upstreamModel });
    return c.json({ data: row });
  });

  app.delete("/admin/routes/:id", async (c) => {
    let id: number;
    try {
      id = parseRouteId(c.req.param("id"));
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }

    const exists = await getRouteById(ctx, id);
    if (!exists) return c.json({ error: { message: "route not found" } }, 404);

    await ctx.db.raw.execute({ sql: "DELETE FROM route_items WHERE id = ?", args: [id] });

    log.info("route deleted", { routeId: id });
    return c.json({ deleted: 1, routeId: id });
  });

  const cleanupRequestLogs = async (c: Context) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // allow empty body and query-only mode
    }

    const olderThan = String(body?.olderThan ?? c.req.query("olderThan") ?? "").trim();
    const keepLatestRaw = body?.keepLatest ?? c.req.query("keepLatest");

    if (olderThan === "1h" || olderThan === "1d") {
      const modifier = olderThan === "1h" ? "-1 hour" : "-1 day";
      const result = await ctx.db.raw.execute({
        sql: "DELETE FROM request_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
        args: [modifier]
      });
      const deleted = Number(result.rowsAffected ?? 0);
      log.info("request_logs cleaned by time window", { olderThan, deleted });
      return c.json({ mode: "older_than", olderThan, deleted });
    }

    if (keepLatestRaw !== undefined && keepLatestRaw !== null && String(keepLatestRaw).trim().length > 0) {
      const keepLatest = Number(keepLatestRaw);
      if (!Number.isInteger(keepLatest) || keepLatest < 100 || keepLatest > 500) {
        return c.json({ error: { message: "keepLatest must be an integer between 100 and 500" } }, 400);
      }
      const result = await ctx.db.raw.execute({
        sql: "DELETE FROM request_logs WHERE request_id IN (SELECT request_id FROM request_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
        args: [keepLatest]
      });
      const deleted = Number(result.rowsAffected ?? 0);
      log.info("request_logs cleaned by keepLatest", { keepLatest, deleted });
      return c.json({ mode: "keep_latest", keepLatest, deleted });
    }

    return c.json(
      { error: { message: "cleanup options required: olderThan=1h|1d or keepLatest=100..500" } },
      400
    );
  };
  app.post("/admin/request-logs/cleanup", cleanupRequestLogs);
  app.delete("/admin/request-logs", cleanupRequestLogs);

  app.get("/admin/settings/upstream-base-url", async (c) => {
    return c.json({ data: { upstreamBaseUrl: ctx.runtime.getUpstreamBaseUrl() } });
  });

  app.put("/admin/settings/upstream-base-url", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "invalid json body" } }, 400);
    }

    let upstreamBaseUrl: string;
    try {
      upstreamBaseUrl = parseUpstreamBaseUrl(body?.upstreamBaseUrl);
    } catch (e) {
      return c.json({ error: { message: (e as Error).message } }, 400);
    }

    await ctx.runtime.setUpstreamBaseUrl(upstreamBaseUrl);
    log.info("upstream_base_url updated", { upstreamBaseUrl });
    return c.json({ data: { upstreamBaseUrl } });
  });
}
