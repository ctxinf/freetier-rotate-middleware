import type { RouteItem } from "./router.js";
import type { AppContext } from "./context.js";
import { requestLogs } from "../storage/schema.js";
import { collectUsageFromSse } from "./sse-usage.js";
import type { Usage } from "./quota.js";

type ProxyParams = {
  app: AppContext;
  requestId: string;
  clientReq: Request;
  clientBody: any;
  entryModel: string;
};

function shouldStream(clientBody: any, clientReq: Request): boolean {
  if (clientBody?.stream === true) return true;
  const accept = clientReq.headers.get("accept") ?? "";
  return accept.includes("text/event-stream");
}

function upstreamUrl(baseUrl: string): string {
  return new URL("/v1/chat/completions", baseUrl).toString();
}

function buildUpstreamHeaders(app: AppContext, clientReq: Request, requestId: string): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("x-request-id", requestId);

  const org = clientReq.headers.get("openai-organization");
  if (org) h.set("openai-organization", org);
  const project = clientReq.headers.get("openai-project");
  if (project) h.set("openai-project", project);

  const auth = clientReq.headers.get("authorization");
  if (auth) h.set("authorization", auth);

  return h;
}

function filterUpstreamResponseHeaders(up: Response): Headers {
  const h = new Headers();
  const ct = up.headers.get("content-type");
  if (ct) h.set("content-type", ct);
  const cache = up.headers.get("cache-control");
  if (cache) h.set("cache-control", cache);
  const reqId = up.headers.get("x-request-id");
  if (reqId) h.set("x-request-id", reqId);
  return h;
}

async function upsertRequestLog(app: AppContext, row: {
  requestId: string;
  routeItemId?: number;
  status?: number;
  usage?: Usage;
  latencyMs?: number;
}): Promise<void> {
  const createdAt = new Date().toISOString();

  const insertValues: Record<string, unknown> = { requestId: row.requestId, createdAt };
  const updateSet: Record<string, unknown> = {};

  if (row.routeItemId !== undefined) {
    insertValues.routeItemId = row.routeItemId;
    updateSet.routeItemId = row.routeItemId;
  }
  if (row.status !== undefined) {
    insertValues.status = row.status;
    updateSet.status = row.status;
  }
  if (row.latencyMs !== undefined) {
    insertValues.latencyMs = row.latencyMs;
    updateSet.latencyMs = row.latencyMs;
  }

  if (row.usage?.prompt_tokens !== undefined) {
    insertValues.promptTokens = row.usage.prompt_tokens;
    updateSet.promptTokens = row.usage.prompt_tokens;
  }
  if (row.usage?.completion_tokens !== undefined) {
    insertValues.completionTokens = row.usage.completion_tokens;
    updateSet.completionTokens = row.usage.completion_tokens;
  }
  if (row.usage?.total_tokens !== undefined) {
    insertValues.totalTokens = row.usage.total_tokens;
    updateSet.totalTokens = row.usage.total_tokens;
  }

  const q = app.db.orm.insert(requestLogs).values(insertValues as any);
  if (Object.keys(updateSet).length === 0) {
    await q.onConflictDoNothing();
    return;
  }

  await q.onConflictDoUpdate({
    target: requestLogs.requestId,
    set: updateSet as any
  });
}

async function tryOneCandidate(
  p: ProxyParams,
  candidate: RouteItem,
  stream: boolean
): Promise<Response | null> {
  const acquired = await p.app.quota.acquire(candidate, p.clientBody);
  if (!acquired.ok) return null;

  const upstreamBody = { ...p.clientBody, model: candidate.upstreamModel };
  const headers = buildUpstreamHeaders(p.app, p.clientReq, p.requestId);
  const url = upstreamUrl(p.app.config.upstreamBaseUrl);
  const started = Date.now();

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
    await upsertRequestLog(p.app, {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: 502,
      latencyMs: Date.now() - started
    });
    throw e;
  }

  const latencyMs = Date.now() - started;

  // Retry-able upstream errors: allow fallback to next candidate.
  if (!upstreamRes.ok && (upstreamRes.status === 429 || upstreamRes.status >= 500)) {
    await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
    await upsertRequestLog(p.app, {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: upstreamRes.status,
      latencyMs
    });
    return null;
  }

  if (!stream) {
    const text = await upstreamRes.text();
    let usage: Usage | undefined;
    try {
      const obj = JSON.parse(text);
      if (obj?.usage) usage = obj.usage as Usage;
    } catch {
      // ignore
    }

    await p.app.quota.finalize(acquired.tokenDayCharge, usage);
    const logRow: {
      requestId: string;
      routeItemId: number;
      status: number;
      latencyMs: number;
      usage?: Usage;
    } = {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: upstreamRes.status,
      latencyMs
    };
    if (usage) logRow.usage = usage;
    await upsertRequestLog(p.app, logRow);

    return new Response(text, {
      status: upstreamRes.status,
      headers: filterUpstreamResponseHeaders(upstreamRes)
    });
  }

  if (!upstreamRes.body) {
    await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
    await upsertRequestLog(p.app, {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: 502,
      latencyMs
    });
    return new Response(JSON.stringify({ error: { message: "Upstream stream missing body" } }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
  }

  const [clientStream, collectorStream] = upstreamRes.body.tee();
  collectUsageFromSse(collectorStream)
    .then(async (usage) => {
      await p.app.quota.finalize(acquired.tokenDayCharge, usage);
      const logRow: {
        requestId: string;
        routeItemId: number;
        status: number;
        latencyMs: number;
        usage?: Usage;
      } = {
        requestId: p.requestId,
        routeItemId: candidate.id,
        status: upstreamRes.status,
        latencyMs
      };
      if (usage) logRow.usage = usage;
      await upsertRequestLog(p.app, logRow);
    })
    .catch(async () => {
      await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
      await upsertRequestLog(p.app, {
        requestId: p.requestId,
        routeItemId: candidate.id,
        status: upstreamRes.status,
        latencyMs
      });
    });

  return new Response(clientStream, {
    status: upstreamRes.status,
    headers: filterUpstreamResponseHeaders(upstreamRes)
  });
}

export async function proxyChatCompletions(p: ProxyParams): Promise<Response> {
  const stream = shouldStream(p.clientBody, p.clientReq);

  const candidates = await p.app.router.listCandidates(p.entryModel);
  if (candidates.length === 0) {
    const url = upstreamUrl(p.app.config.upstreamBaseUrl);
    const headers = buildUpstreamHeaders(p.app, p.clientReq, p.requestId);
    const upstreamBody = { ...p.clientBody, model: p.entryModel };
    const started = Date.now();
    const upstreamRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
    const latencyMs = Date.now() - started;

    if (!stream) {
      const text = await upstreamRes.text();
      await upsertRequestLog(p.app, { requestId: p.requestId, status: upstreamRes.status, latencyMs });
      return new Response(text, { status: upstreamRes.status, headers: filterUpstreamResponseHeaders(upstreamRes) });
    }

    if (!upstreamRes.body) {
      await upsertRequestLog(p.app, { requestId: p.requestId, status: 502, latencyMs });
      return new Response(JSON.stringify({ error: { message: "Upstream stream missing body" } }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: filterUpstreamResponseHeaders(upstreamRes) });
  }

  for (const candidate of candidates) {
    const res = await tryOneCandidate(p, candidate, stream);
    if (res) return res;
  }

  await upsertRequestLog(p.app, { requestId: p.requestId, status: 429 });
  return new Response(JSON.stringify({ error: { message: "All route items exhausted" } }), {
    status: 429,
    headers: { "content-type": "application/json" }
  });
}
