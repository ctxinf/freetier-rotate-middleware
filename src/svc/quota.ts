import type { GatewayDb } from "../storage/db.js";
import { createLogger } from "../logging.js";
import type { RouteItem, StrategyType } from "./router.js";

type TokenDayConfig = {
  dailyTokenLimit: number;
  resetHourUtc?: number;
};

type ReqMinDayConfig = {
  reqPerMin: number;
  reqPerDay: number;
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type TokenDayCharge = { upstreamModel: string; dayBucket: string };

export type AcquireHandle =
  | { ok: true; routeItem: RouteItem; tokenDayCharge?: TokenDayCharge }
  | { ok: false; reason: string };

const log = createLogger("svc.quota");

function parseConfig(strategyType: StrategyType, configJson: string): TokenDayConfig | ReqMinDayConfig {
  let obj: any = {};
  try {
    obj = JSON.parse(configJson || "{}");
  } catch {
    obj = {};
  }

  if (strategyType === "token_day") {
    let dailyTokenLimit: number = NaN;

    if (obj.dailyTokenLimitTokens !== undefined) {
      dailyTokenLimit = Number(obj.dailyTokenLimitTokens);
    } else if (obj.dailyTokenLimitM !== undefined) {
      dailyTokenLimit = Number(obj.dailyTokenLimitM) * 1_000_000;
    } else if (typeof obj.dailyTokenLimit === "string") {
      const s = obj.dailyTokenLimit.trim();
      const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*([mM])$/);
      if (m) dailyTokenLimit = Number(m[1]) * 1_000_000;
      else dailyTokenLimit = Number(s);
    } else {
      const raw = Number(obj.dailyTokenLimit);
      // Prefer M (millions) for config ergonomics; keep backward-compat for large token counts.
      dailyTokenLimit = raw >= 1_000_000 ? raw : raw * 1_000_000;
    }

    if (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit <= 0) {
      throw new Error("token_day missing dailyTokenLimit (supports dailyTokenLimitM / dailyTokenLimitTokens / '2M')");
    }
    return {
      dailyTokenLimit,
      resetHourUtc: Number.isFinite(Number(obj.resetHourUtc)) ? Number(obj.resetHourUtc) : 0
    };
  }

  const reqPerMin = Number(obj.reqPerMin);
  const reqPerDay = Number(obj.reqPerDay);
  if (!Number.isFinite(reqPerMin) || reqPerMin <= 0) throw new Error("req_min_day missing reqPerMin");
  if (!Number.isFinite(reqPerDay) || reqPerDay <= 0) throw new Error("req_min_day missing reqPerDay");
  return { reqPerMin, reqPerDay };
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
  // If reset is at 08:00 UTC, then 07:59 still belongs to "yesterday" bucket.
  const hour = now.getUTCHours();
  const bucketDate = new Date(now);
  if (hour < resetHourUtc) bucketDate.setUTCDate(bucketDate.getUTCDate() - 1);
  return utcDayString(bucketDate);
}

export function createQuotaService(db: GatewayDb) {
  async function ensureCounterRow(executor: { execute: (stmt: any) => Promise<any> }, upstreamModel: string, bucketKey: string): Promise<void> {
    await executor.execute({
      sql: "INSERT INTO quota_counters(upstream_model, bucket_key) VALUES(?, ?) ON CONFLICT(upstream_model, bucket_key) DO NOTHING",
      args: [upstreamModel, bucketKey]
    });
  }

  async function consumeReqMinuteAndDay(upstreamModel: string, minuteBucket: string, minuteLimit: number, dayBucket: string, dayLimit: number): Promise<boolean> {
    const tx = await db.raw.transaction("write");
    try {
      await ensureCounterRow(tx, upstreamModel, minuteBucket);
      await ensureCounterRow(tx, upstreamModel, dayBucket);

      const minuteRes = await tx.execute({
        sql: "UPDATE quota_counters SET used_req = used_req + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upstream_model = ? AND bucket_key = ? AND used_req + 1 <= ?",
        args: [upstreamModel, minuteBucket, minuteLimit]
      });
      if (Number(minuteRes?.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }

      const dayRes = await tx.execute({
        sql: "UPDATE quota_counters SET used_req = used_req + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upstream_model = ? AND bucket_key = ? AND used_req + 1 <= ?",
        args: [upstreamModel, dayBucket, dayLimit]
      });
      if (Number(dayRes?.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }

      await tx.commit();
      return true;
    } finally {
      tx.close();
    }
  }

  async function canStartTokenDay(upstreamModel: string, dayBucket: string, dailyLimit: number): Promise<boolean> {
    const tx = await db.raw.transaction("write");
    try {
      await ensureCounterRow(tx, upstreamModel, dayBucket);
      const res = await tx.execute({
        sql: "SELECT used_tokens FROM quota_counters WHERE upstream_model = ? AND bucket_key = ? LIMIT 1",
        args: [upstreamModel, dayBucket]
      });
      const used = Number((res?.rows?.[0] as any)?.used_tokens ?? 0);
      const ok = Number.isFinite(used) ? used < dailyLimit : true;
      await tx.commit();
      return ok;
    } finally {
      tx.close();
    }
  }

  async function chargeTokens(upstreamModel: string, dayBucket: string, actual: number): Promise<void> {
    await ensureCounterRow(db.raw, upstreamModel, dayBucket);
    await db.raw.execute({
      sql: "UPDATE quota_counters SET used_tokens = used_tokens + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upstream_model = ? AND bucket_key = ?",
      args: [actual, upstreamModel, dayBucket]
    });
  }

  async function acquire(routeItem: RouteItem, clientBody: any, now: Date = new Date()): Promise<AcquireHandle> {
    if (routeItem.enabled !== 1) return { ok: false, reason: "disabled" };

    if (routeItem.strategyType === "req_min_day") {
      let cfg: ReqMinDayConfig;
      try {
        cfg = parseConfig("req_min_day", routeItem.configJson) as ReqMinDayConfig;
      } catch {
        log.warn("invalid req_min_day route config", { routeItemId: routeItem.id });
        return { ok: false, reason: "invalid config" };
      }
      const minuteBucket = utcMinuteString(now);
      const dayBucket = utcDayString(now);

      const ok = await consumeReqMinuteAndDay(routeItem.upstreamModel, minuteBucket, cfg.reqPerMin, dayBucket, cfg.reqPerDay);
      if (!ok) return { ok: false, reason: "req quota exceeded" };
      return { ok: true, routeItem };
    }

    if (routeItem.strategyType === "token_day") {
      let cfg: TokenDayConfig;
      try {
        cfg = parseConfig("token_day", routeItem.configJson) as TokenDayConfig;
      } catch {
        log.warn("invalid token_day route config", { routeItemId: routeItem.id });
        return { ok: false, reason: "invalid config" };
      }
      const dayBucket = quotaDayBucket(now, cfg.resetHourUtc ?? 0);
      const ok = await canStartTokenDay(routeItem.upstreamModel, dayBucket, cfg.dailyTokenLimit);
      if (!ok) return { ok: false, reason: "token quota exceeded" };

      return {
        ok: true,
        routeItem,
        tokenDayCharge: { upstreamModel: routeItem.upstreamModel, dayBucket }
      };
    }

    return { ok: false, reason: "unknown strategy" };
  }

  async function finalize(charge: TokenDayCharge | undefined, usage: Usage | undefined): Promise<void> {
    if (!charge) return;
    const actual = usage?.total_tokens;
    if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) {
      await chargeTokens(charge.upstreamModel, charge.dayBucket, actual);
      log.debug("token_day charged", { upstreamModel: charge.upstreamModel, dayBucket: charge.dayBucket, totalTokens: actual });
    }
  }

  return { acquire, finalize };
}
