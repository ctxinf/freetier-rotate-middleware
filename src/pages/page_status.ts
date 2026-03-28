import type { Hono } from "hono";
import { asc, desc } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { AppContext } from "../svc/context.js";
import { parseCycleDays, resolveCycleWindow } from "../svc/cycle.js";
import { routeItems as routeItemsTable } from "../storage/schema.js";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseJsonSafe(input: string): any {
  try {
    return JSON.parse(input || "{}");
  } catch {
    return {};
  }
}

function formatTokensM(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "?M";
  return `${(v / 1_000_000).toFixed(3)}M`;
}

function formatDurationMs(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "-";
  let remaining = Math.floor(value / 1000);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function resolveRouteCycle(parsed: any, now: Date) {
  let cycleDays = 1;
  try {
    cycleDays = parseCycleDays(parsed?.cycleDays ?? parsed?.cycle, 1);
  } catch {
    cycleDays = 1;
  }
  const cycle = resolveCycleWindow(now, cycleDays);
  return {
    cycleDays: cycle.cycleDays,
    cycleStartIso: cycle.cycleStart.toISOString(),
    cycleEndIso: cycle.cycleEnd.toISOString(),
    cycleRemainingMs: cycle.remainingMs,
    bucketKey: cycle.bucketKey
  };
}

function renderTable(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  options?: { fitWidth?: boolean }
): string {
  const fitClass = options?.fitWidth ? "fit-width" : "";
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell) => `<td>${escapeHtml(cell === null || cell === undefined ? "" : String(cell))}</td>`)
          .join("")}</tr>`
    )
    .join("")}</tbody>`;
  return `<table class="${fitClass}">${thead}${tbody}</table>`;
}

async function buildStatusPayload(app: AppContext, config: AppConfig, now: Date) {
  const routes = await app.db.orm
    .select()
    .from(routeItemsTable)
    .orderBy(asc(routeItemsTable.entryModel), desc(routeItemsTable.priority), asc(routeItemsTable.id));

  const counterCache = new Map<string, any | null>();
  const getCounter = async (upstreamModel: string, bucketKey: string): Promise<any | null> => {
    const cacheKey = `${upstreamModel}::${bucketKey}`;
    if (counterCache.has(cacheKey)) return counterCache.get(cacheKey) ?? null;
    const res = await app.db.raw.execute({
      sql: "SELECT used_tokens, used_req, updated_at FROM quota_counters WHERE upstream_model = ? AND bucket_key = ?",
      args: [upstreamModel, bucketKey]
    });
    const row = (res?.rows?.[0] as any) ?? null;
    counterCache.set(cacheKey, row);
    return row;
  };

  const itemsWithUsage: any[] = [];
  for (const ri of routes as any[]) {
    const parsed = parseJsonSafe(ri.configJson);
    const cycle = resolveRouteCycle(parsed, now);

    if (ri.strategyType === "req_min_day") {
      const minuteBucket = now.toISOString().slice(0, 16);
      const dayBucket = cycle.bucketKey;
      itemsWithUsage.push({
        ...ri,
        parsedConfig: parsed,
        cycle,
        buckets: { minuteBucket, dayBucket },
        counters: {
          minute: await getCounter(ri.upstreamModel, minuteBucket),
          day: await getCounter(ri.upstreamModel, dayBucket)
        }
      });
      continue;
    }

    if (ri.strategyType === "token_day") {
      const dayBucket = cycle.bucketKey;
      itemsWithUsage.push({
        ...ri,
        parsedConfig: parsed,
        cycle,
        buckets: { dayBucket },
        counters: {
          day: await getCounter(ri.upstreamModel, dayBucket)
        }
      });
      continue;
    }

    itemsWithUsage.push({ ...ri, parsedConfig: parsed, cycle, buckets: null, counters: null });
  }

  const recentCountersRes = await app.db.raw.execute(
    "SELECT upstream_model, bucket_key, used_tokens, used_req, updated_at FROM quota_counters ORDER BY updated_at DESC LIMIT 200"
  );
  const recentCounters = (recentCountersRes?.rows as any[]) ?? [];

  const recentRequestLogsRes = await app.db.raw.execute(
    "SELECT request_id, route_item_id, upstream_model, status, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at FROM request_logs ORDER BY created_at DESC LIMIT 100"
  );
  const recentRequestLogs = (recentRequestLogsRes?.rows as any[]) ?? [];

  const upstreamMap = new Map<string, any>();
  for (const ri of itemsWithUsage) {
    const key = String(ri.upstreamModel);
    const existing = upstreamMap.get(key);
    if (!existing) {
      upstreamMap.set(key, {
        upstreamModel: key,
        strategyType: ri.strategyType,
        enabledCount: ri.enabled === 1 ? 1 : 0,
        routeCount: 1,
        minPriority: ri.priority,
        maxPriority: ri.priority,
        entryModels: new Set<string>([String(ri.entryModel)]),
        configJson: String(ri.configJson ?? ""),
        cycleDays: ri.cycle?.cycleDays ?? 1,
        sample: ri,
        mixedStrategy: false,
        mixedConfig: false,
        mixedCycle: false
      });
      continue;
    }
    existing.routeCount += 1;
    if (ri.enabled === 1) existing.enabledCount += 1;
    existing.minPriority = Math.min(existing.minPriority, Number(ri.priority));
    existing.maxPriority = Math.max(existing.maxPriority, Number(ri.priority));
    existing.entryModels.add(String(ri.entryModel));
    if (existing.strategyType !== ri.strategyType) existing.mixedStrategy = true;
    if (existing.configJson !== String(ri.configJson ?? "")) existing.mixedConfig = true;
    if (existing.cycleDays !== (ri.cycle?.cycleDays ?? 1)) existing.mixedCycle = true;
  }

  const upstreams = Array.from(upstreamMap.values())
    .map((u) => {
      const sample = u.sample;
      const strategyType = u.mixedStrategy ? "mixed" : u.strategyType;
      let cycleStart = "-";
      let cycleLeft = "-";
      let usage = "-";
      const isMixed = u.mixedStrategy || u.mixedConfig || u.mixedCycle;
      if (!isMixed && sample?.strategyType === "req_min_day") {
        const minute = sample.counters?.minute;
        const day = sample.counters?.day;
        const cfg = sample.parsedConfig ?? {};
        cycleStart = sample.cycle?.cycleStartIso ?? "-";
        cycleLeft = formatDurationMs(sample.cycle?.cycleRemainingMs);
        usage = `req: ${minute?.used_req ?? 0}/${cfg.reqPerMin ?? "?"}/min, ${day?.used_req ?? 0}/${cfg.reqPerDay ?? "?"}/day`;
      } else if (!isMixed && sample?.strategyType === "token_day") {
        const day = sample.counters?.day;
        const cfg = sample.parsedConfig ?? {};
        cycleStart = sample.cycle?.cycleStartIso ?? "-";
        cycleLeft = formatDurationMs(sample.cycle?.cycleRemainingMs);
        usage = `token: ${formatTokensM(day?.used_tokens ?? 0)}/${formatTokensM(cfg.dailyTokenLimit)}`;
      } else if (isMixed) {
        cycleStart = "mixed";
        cycleLeft = "mixed";
        usage = "mixed";
      }
      return {
        upstreamModel: u.upstreamModel,
        strategyType,
        enabledCount: u.enabledCount,
        routeCount: u.routeCount,
        priorityRange: `${u.maxPriority}..${u.minPriority}`,
        entryModels: Array.from(u.entryModels).sort(),
        cycleStart,
        cycleLeft,
        usage
      };
    })
    .sort((a, b) => a.upstreamModel.localeCompare(b.upstreamModel));

  return {
    now: now.toISOString(),
    config: {
      port: config.port,
      basePath: config.basePath,
      upstreamBaseUrl: app.runtime.getUpstreamBaseUrl(),
      databasePath: config.databasePath
    },
    upstreams,
    routes: itemsWithUsage,
    quotaCountersRecent: recentCounters,
    requestLogsRecent: recentRequestLogs
  };
}

export function registerStatusRoutes(app: Hono, ctx: AppContext, config: AppConfig): void {
  app.get("/_status/json", async (c) => {
    const now = new Date();
    c.header("cache-control", "no-store");
    return c.json(await buildStatusPayload(ctx, config, now));
  });

  app.get("/_status", async (c) => {
    const now = new Date();
    const payload = await buildStatusPayload(ctx, config, now);
    c.header("cache-control", "no-store");

    const routeGroups = new Map<string, Array<Array<string | number | null | undefined>>>();
    for (const ri of payload.routes as any[]) {
      const enabled = ri.enabled === 1 ? "🟢" : "";
      const cycleStart = ri.cycle?.cycleStartIso ?? "-";
      const cycleLeft = formatDurationMs(ri.cycle?.cycleRemainingMs);
      let usage = "-";

      if (ri.strategyType === "req_min_day") {
        const minute = ri.counters?.minute;
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        usage = `req: ${minute?.used_req ?? 0}/${cfg.reqPerMin ?? "?"}/min, ${day?.used_req ?? 0}/${cfg.reqPerDay ?? "?"}/day`;
      } else if (ri.strategyType === "token_day") {
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        usage = `token: ${formatTokensM(day?.used_tokens ?? 0)}/${formatTokensM(cfg.dailyTokenLimit)}`;
      }

      const entryModel = String(ri.entryModel);
      if (!routeGroups.has(entryModel)) routeGroups.set(entryModel, []);
      routeGroups.get(entryModel)!.push([enabled, ri.upstreamModel, ri.strategyType, ri.priority, cycleStart, cycleLeft, usage]);
    }

    const routeGroupsHtml = Array.from(routeGroups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
      ([entryModel, rows]) => `<h3>entry_model: ${escapeHtml(entryModel)}</h3>${renderTable(
          ["enabled", "upstream_model", "strategy", "priority", "cycle_start", "cycle_left", "usage"],
          rows,
          { fitWidth: true }
        )}`
      )
      .join("");

    const upstreamRows: Array<Array<string | number | null | undefined>> = (payload.upstreams as any[]).map((u) => [
      u.upstreamModel,
      `${u.enabledCount}/${u.routeCount}`,
      u.cycleStart,
      u.cycleLeft,
      u.usage
    ]);

    const reqRows: Array<Array<string | number | null | undefined>> = (payload.requestLogsRecent as any[])
      .slice(0, 50)
      .map((r) => [
        r.created_at,
        r.status,
        r.route_item_id,
        r.upstream_model,
        r.total_tokens,
        r.latency_ms,
        r.request_id
      ]);
    const homePath = payload.config.basePath === "/" ? "/" : payload.config.basePath;

    const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>freetier-rotate-middleware status</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 16px; }
      .topnav { margin: 0 0 10px 0; }
      h1, h2 { margin: 0 0 12px 0; }
      .meta { color: #444; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; }
      table.fit-width { width: auto; max-width: 100%; display: inline-table; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
      th { background: #f6f6f6; text-align: left; position: sticky; top: 0; }
      td { word-break: break-word; }
      ul { margin: 8px 0 16px 18px; }
      h3 { margin: 8px 0 8px; font-size: 16px; }
      .small { font-size: 12px; color: #555; }
    </style>
  </head>
  <body>
    <div class="topnav"><a href="${escapeHtml(homePath)}">Home</a></div>
    <h1>freetier-rotate-middleware status</h1>
    <div class="meta"><span class="small">GET /_status/json for raw JSON</span></div>

    <h2>config</h2>
    <ul>
      <li>port: ${escapeHtml(String(payload.config.port))}</li>
      <li>basePath: ${escapeHtml(payload.config.basePath)}</li>
      <li>upstreamBaseUrl: ${escapeHtml(payload.config.upstreamBaseUrl)}</li>
      <li>databasePath: ${escapeHtml(payload.config.databasePath)}</li>
    </ul>

    <h2>upstreams</h2>
    ${renderTable(
      ["upstream_model", "routes(enabled/all)", "cycle_start", "cycle_left", "usage"],
      upstreamRows,
      { fitWidth: true }
    )}

    <h2>route_items (grouped by entry_model)</h2>
    ${routeGroupsHtml}

    <h2>request_logs_recent (top 50)</h2>
    ${renderTable(
      ["created_at", "status", "route_item_id", "upstream_model", "total_tokens", "lat_ms", "request_id"],
      reqRows
    )}
  </body>
</html>`;

    return c.html(body);
  });
}
