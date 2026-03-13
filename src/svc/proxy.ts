import type { RouteItem } from "./router.js";
import type { AppContext } from "./context.js";
import { createLogger, sanitizeError } from "../logging.js";
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

type AttemptResult =
  | { kind: "success"; response: Response }
  | { kind: "next"; reason: "quota" | "upstream_error" | "upstream_retryable_status" };

const log = createLogger("svc.proxy");

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
): Promise<AttemptResult> {
  const requestLog = log.child({ requestId: p.requestId, candidateId: candidate.id, upstreamModel: candidate.upstreamModel });
  const acquired = await p.app.quota.acquire(candidate, p.clientBody);
  if (!acquired.ok) {
    requestLog.debug("candidate skipped by quota", { reason: acquired.reason });
    return { kind: "next", reason: "quota" };
  }

  const upstreamBody = { ...p.clientBody, model: candidate.upstreamModel };
  const headers = buildUpstreamHeaders(p.app, p.clientReq, p.requestId);
  const upstreamBaseUrl = p.app.runtime.getUpstreamBaseUrl();
  const url = upstreamUrl(upstreamBaseUrl);
  const started = Date.now();
  requestLog.debug("proxying to candidate", { url, strategyType: candidate.strategyType, stream });

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
    requestLog.warn("upstream request failed, fallback to next candidate", sanitizeError(e));
    return { kind: "next", reason: "upstream_error" };
  }

  const latencyMs = Date.now() - started;
  requestLog.debug("upstream response received", { status: upstreamRes.status, latencyMs });

  // Retry-able upstream errors: allow fallback to next candidate.
  if (!upstreamRes.ok && (upstreamRes.status === 429 || upstreamRes.status >= 500)) {
    await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
    await upsertRequestLog(p.app, {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: upstreamRes.status,
      latencyMs
    });
    requestLog.warn("retryable upstream response, fallback to next candidate", { status: upstreamRes.status, latencyMs });
    return { kind: "next", reason: "upstream_retryable_status" };
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
    requestLog.info("request completed", { status: upstreamRes.status, latencyMs, usage: usage ?? null });

    return { kind: "success", response: new Response(text, {
      status: upstreamRes.status,
      headers: filterUpstreamResponseHeaders(upstreamRes)
    }) };
  }

  if (!upstreamRes.body) {
    await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
    await upsertRequestLog(p.app, {
      requestId: p.requestId,
      routeItemId: candidate.id,
      status: 502,
      latencyMs
    });
    requestLog.error("stream response missing body", { status: upstreamRes.status, latencyMs });
    return { kind: "success", response: new Response(JSON.stringify({ error: { message: "Upstream stream missing body" } }), {
      status: 502,
      headers: { "content-type": "application/json" }
    }) };
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
      requestLog.info("stream completed", { status: upstreamRes.status, latencyMs, usage: usage ?? null });
    })
    .catch(async (e) => {
      await p.app.quota.finalize(acquired.tokenDayCharge, undefined);
      await upsertRequestLog(p.app, {
        requestId: p.requestId,
        routeItemId: candidate.id,
        status: upstreamRes.status,
        latencyMs
      });
      requestLog.warn("failed to collect stream usage", sanitizeError(e));
    });

  return { kind: "success", response: new Response(clientStream, {
    status: upstreamRes.status,
    headers: filterUpstreamResponseHeaders(upstreamRes)
  }) };
}

export async function proxyChatCompletions(p: ProxyParams): Promise<Response> {
  const stream = shouldStream(p.clientBody, p.clientReq);
  const requestLog = log.child({ requestId: p.requestId, entryModel: p.entryModel, stream });
  requestLog.debug("proxy request accepted");

  const candidates = await p.app.router.listCandidates(p.entryModel);
  requestLog.debug("candidate list resolved", { candidateCount: candidates.length });
  if (candidates.length === 0) {
    const upstreamBaseUrl = p.app.runtime.getUpstreamBaseUrl();
    const url = upstreamUrl(upstreamBaseUrl);
    const headers = buildUpstreamHeaders(p.app, p.clientReq, p.requestId);
    const upstreamBody = { ...p.clientBody, model: p.entryModel };
    const started = Date.now();
    requestLog.info("no route candidates, direct upstream fallback", { url });
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
    } catch (e) {
      requestLog.error("direct upstream fallback failed", sanitizeError(e));
      await upsertRequestLog(p.app, { requestId: p.requestId, status: 502, latencyMs: Date.now() - started });
      return new Response(JSON.stringify({ error: { message: "Upstream request failed" } }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    }
    const latencyMs = Date.now() - started;

    if (!stream) {
      const text = await upstreamRes.text();
      await upsertRequestLog(p.app, { requestId: p.requestId, status: upstreamRes.status, latencyMs });
      requestLog.info("direct fallback completed", { status: upstreamRes.status, latencyMs });
      return new Response(text, { status: upstreamRes.status, headers: filterUpstreamResponseHeaders(upstreamRes) });
    }

    if (!upstreamRes.body) {
      await upsertRequestLog(p.app, { requestId: p.requestId, status: 502, latencyMs });
      requestLog.error("direct fallback stream missing body", { status: upstreamRes.status, latencyMs });
      return new Response(JSON.stringify({ error: { message: "Upstream stream missing body" } }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    }

    requestLog.info("direct fallback stream started", { status: upstreamRes.status, latencyMs });
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: filterUpstreamResponseHeaders(upstreamRes) });
  }

  let hasQuotaExhausted = false;
  let hasUpstreamFailure = false;
  for (const candidate of candidates) {
    const attempt = await tryOneCandidate(p, candidate, stream);
    if (attempt.kind === "success") return attempt.response;
    if (attempt.reason === "quota") hasQuotaExhausted = true;
    if (attempt.reason === "upstream_error" || attempt.reason === "upstream_retryable_status") {
      hasUpstreamFailure = true;
    }
  }

  const finalStatus = hasUpstreamFailure ? 502 : 429;
  const finalMessage = hasUpstreamFailure ? "All route items failed at upstream" : "All route items exhausted";
  await upsertRequestLog(p.app, { requestId: p.requestId, status: finalStatus });
  if (hasUpstreamFailure) {
    requestLog.error("all candidates failed due to upstream errors");
  } else if (hasQuotaExhausted) {
    requestLog.warn("all candidates exhausted by quota");
  } else {
    requestLog.warn("all candidates unavailable");
  }
  return new Response(JSON.stringify({ error: { message: finalMessage } }), {
    status: finalStatus,
    headers: { "content-type": "application/json" }
  });
}
