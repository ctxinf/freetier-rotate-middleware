import type { Hono } from "hono";
import { asc, desc } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { AppContext } from "../svc/context.js";
import { routeItems as routeItemsTable } from "../storage/schema.js";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function utcDayString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function utcMinuteString(d: Date): string {
  return `${utcDayString(d)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function quotaDayBucket(now: Date, resetHourUtc: number): string {
  const hour = now.getUTCHours();
  const bucketDate = new Date(now);
  if (hour < resetHourUtc) bucketDate.setUTCDate(bucketDate.getUTCDate() - 1);
  return utcDayString(bucketDate);
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

function renderTable(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell) => `<td>${escapeHtml(cell === null || cell === undefined ? "" : String(cell))}</td>`)
          .join("")}</tr>`
    )
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
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

    if (ri.strategyType === "req_min_day") {
      const minuteBucket = utcMinuteString(now);
      const dayBucket = utcDayString(now);
      itemsWithUsage.push({
        ...ri,
        parsedConfig: parsed,
        buckets: { minuteBucket, dayBucket },
        counters: {
          minute: await getCounter(ri.upstreamModel, minuteBucket),
          day: await getCounter(ri.upstreamModel, dayBucket)
        }
      });
      continue;
    }

    if (ri.strategyType === "token_day") {
      const resetHourUtc = Number.isFinite(Number(parsed.resetHourUtc)) ? Number(parsed.resetHourUtc) : 0;
      const dayBucket = quotaDayBucket(now, resetHourUtc);
      itemsWithUsage.push({
        ...ri,
        parsedConfig: parsed,
        buckets: { dayBucket, resetHourUtc },
        counters: {
          day: await getCounter(ri.upstreamModel, dayBucket)
        }
      });
      continue;
    }

    itemsWithUsage.push({ ...ri, parsedConfig: parsed, buckets: null, counters: null });
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
        sample: ri,
        mixedStrategy: false
      });
      continue;
    }
    existing.routeCount += 1;
    if (ri.enabled === 1) existing.enabledCount += 1;
    existing.minPriority = Math.min(existing.minPriority, Number(ri.priority));
    existing.maxPriority = Math.max(existing.maxPriority, Number(ri.priority));
    existing.entryModels.add(String(ri.entryModel));
    if (existing.strategyType !== ri.strategyType) existing.mixedStrategy = true;
  }

  const upstreams = Array.from(upstreamMap.values())
    .map((u) => {
      const sample = u.sample;
      const strategyType = u.mixedStrategy ? "mixed" : u.strategyType;
      let bucket = "-";
      let usage = "-";
      if (!u.mixedStrategy && sample?.strategyType === "req_min_day") {
        const minute = sample.counters?.minute;
        const day = sample.counters?.day;
        const cfg = sample.parsedConfig ?? {};
        bucket = `${sample.buckets?.minuteBucket ?? "-"} | ${sample.buckets?.dayBucket ?? "-"}`;
        usage = `req: ${minute?.used_req ?? 0}/${cfg.reqPerMin ?? "?"}/min, ${day?.used_req ?? 0}/${cfg.reqPerDay ?? "?"}/day`;
      } else if (!u.mixedStrategy && sample?.strategyType === "token_day") {
        const day = sample.counters?.day;
        const cfg = sample.parsedConfig ?? {};
        bucket = `${sample.buckets?.dayBucket ?? "-"} (reset@${sample.buckets?.resetHourUtc ?? 0}hZ)`;
        usage = `tok: used ${formatTokensM(day?.used_tokens ?? 0)}, limit ${formatTokensM(cfg.dailyTokenLimit)}`;
      }
      return {
        upstreamModel: u.upstreamModel,
        strategyType,
        enabledCount: u.enabledCount,
        routeCount: u.routeCount,
        priorityRange: `${u.maxPriority}..${u.minPriority}`,
        entryModels: Array.from(u.entryModels).sort(),
        bucket,
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
      let usage = "-";

      if (ri.strategyType === "req_min_day") {
        const minute = ri.counters?.minute;
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        usage = `req: ${minute?.used_req ?? 0}/${cfg.reqPerMin ?? "?"}/min, ${day?.used_req ?? 0}/${cfg.reqPerDay ?? "?"}/day`;
      } else if (ri.strategyType === "token_day") {
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        usage = `tok: used ${formatTokensM(day?.used_tokens ?? 0)}, limit ${formatTokensM(cfg.dailyTokenLimit)}`;
      }

      const entryModel = String(ri.entryModel);
      if (!routeGroups.has(entryModel)) routeGroups.set(entryModel, []);
      routeGroups.get(entryModel)!.push([enabled, ri.upstreamModel, ri.strategyType, ri.priority, usage]);
    }

    const routeGroupsHtml = Array.from(routeGroups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([entryModel, rows]) => `<h3>${escapeHtml(entryModel)}</h3>${renderTable(
          ["en", "upstream_model", "strategy", "prio", "usage"],
          rows
        )}`
      )
      .join("");

    const upstreamRows: Array<Array<string | number | null | undefined>> = (payload.upstreams as any[]).map((u) => [
      `${u.enabledCount}/${u.routeCount}`,
      u.upstreamModel,
      u.strategyType,
      u.priorityRange,
      u.bucket,
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

    const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>my-ai-gateway status</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 16px; }
      h1, h2 { margin: 0 0 12px 0; }
      .meta { color: #444; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
      th { background: #f6f6f6; text-align: left; position: sticky; top: 0; }
      td { word-break: break-word; }
      ul { margin: 8px 0 16px 18px; }
      h3 { margin: 8px 0 8px; font-size: 16px; }
      .small { font-size: 12px; color: #555; }
    </style>
  </head>
  <body>
    <h1>my-ai-gateway status</h1>
    <div class="meta">now: ${escapeHtml(payload.now)} · <span class="small">GET /_status/json for raw JSON</span></div>

    <h2>config</h2>
    <ul>
      <li>port: ${escapeHtml(String(payload.config.port))}</li>
      <li>basePath: ${escapeHtml(payload.config.basePath)}</li>
      <li>upstreamBaseUrl: ${escapeHtml(payload.config.upstreamBaseUrl)}</li>
      <li>databasePath: ${escapeHtml(payload.config.databasePath)}</li>
    </ul>

    <h2>upstreams</h2>
    ${renderTable(
      ["en/routes", "upstream_model", "strategy", "prio(max..min)", "bucket", "usage"],
      upstreamRows
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
