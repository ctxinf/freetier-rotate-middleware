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
  const routeItems = await app.db.orm
    .select()
    .from(routeItemsTable)
    .orderBy(asc(routeItemsTable.publicModel), desc(routeItemsTable.priority), asc(routeItemsTable.id));

  const getCounter = async (routeItemId: number, bucketKey: string): Promise<any | null> => {
    const res = await app.db.raw.execute({
      sql: "SELECT used_tokens, used_req, reserved_tokens, updated_at FROM quota_counters WHERE route_item_id = ? AND bucket_key = ?",
      args: [routeItemId, bucketKey]
    });
    return (res?.rows?.[0] as any) ?? null;
  };

  const itemsWithUsage: any[] = [];
  for (const ri of routeItems as any[]) {
    const parsed = parseJsonSafe(ri.configJson);

    if (ri.strategyType === "req_min_day") {
      const minuteBucket = utcMinuteString(now);
      const dayBucket = utcDayString(now);
      itemsWithUsage.push({
        ...ri,
        parsedConfig: parsed,
        buckets: { minuteBucket, dayBucket },
        counters: {
          minute: await getCounter(ri.id, minuteBucket),
          day: await getCounter(ri.id, dayBucket)
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
          day: await getCounter(ri.id, dayBucket)
        }
      });
      continue;
    }

    itemsWithUsage.push({ ...ri, parsedConfig: parsed, buckets: null, counters: null });
  }

  const recentCountersRes = await app.db.raw.execute(
    "SELECT route_item_id, bucket_key, used_tokens, used_req, reserved_tokens, updated_at FROM quota_counters ORDER BY updated_at DESC LIMIT 200"
  );
  const recentCounters = (recentCountersRes?.rows as any[]) ?? [];

  const recentRequestLogsRes = await app.db.raw.execute(
    "SELECT request_id, route_item_id, status, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at FROM request_logs ORDER BY created_at DESC LIMIT 100"
  );
  const recentRequestLogs = (recentRequestLogsRes?.rows as any[]) ?? [];

  return {
    now: now.toISOString(),
    config: {
      port: config.port,
      upstreamBaseUrl: config.upstreamBaseUrl,
      databasePath: config.databasePath
    },
    routeItems: itemsWithUsage,
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

    const routeRows: Array<Array<string | number | null | undefined>> = payload.routeItems.map((ri: any) => {
      const enabled = ri.enabled === 1 ? "1" : "0";
      let bucket = "-";
      let usage = "-";

      if (ri.strategyType === "req_min_day") {
        const minute = ri.counters?.minute;
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        bucket = `${ri.buckets.minuteBucket} | ${ri.buckets.dayBucket}`;
        usage = `req: ${minute?.used_req ?? 0}/${cfg.reqPerMin ?? "?"}/min, ${day?.used_req ?? 0}/${cfg.reqPerDay ?? "?"}/day`;
      } else if (ri.strategyType === "token_day") {
        const day = ri.counters?.day;
        const cfg = ri.parsedConfig ?? {};
        bucket = `${ri.buckets.dayBucket} (reset@${ri.buckets.resetHourUtc}hZ)`;
        usage = `tok: used ${formatTokensM(day?.used_tokens ?? 0)}, res ${formatTokensM(day?.reserved_tokens ?? 0)}, limit ${formatTokensM(cfg.dailyTokenLimit)}`;
      }

      return [ri.id, enabled, ri.publicModel, ri.upstreamModel, ri.strategyType, ri.priority, bucket, usage];
    });

    const reqRows: Array<Array<string | number | null | undefined>> = (payload.requestLogsRecent as any[])
      .slice(0, 50)
      .map((r) => [
        r.created_at,
        r.status,
        r.route_item_id,
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
      .small { font-size: 12px; color: #555; }
    </style>
  </head>
  <body>
    <h1>my-ai-gateway status</h1>
    <div class="meta">now: ${escapeHtml(payload.now)} · <span class="small">GET /_status/json for raw JSON</span></div>

    <h2>config</h2>
    <ul>
      <li>port: ${escapeHtml(String(payload.config.port))}</li>
      <li>upstreamBaseUrl: ${escapeHtml(payload.config.upstreamBaseUrl)}</li>
      <li>databasePath: ${escapeHtml(payload.config.databasePath)}</li>
    </ul>

    <h2>route_items</h2>
    ${renderTable(
      ["id", "en", "public_model", "upstream_model", "strategy", "prio", "bucket", "usage"],
      routeRows
    )}

    <h2>request_logs_recent (top 50)</h2>
    ${renderTable(
      ["created_at", "status", "route_item_id", "total_tokens", "lat_ms", "request_id"],
      reqRows
    )}
  </body>
</html>`;

    return c.html(body);
  });
}
