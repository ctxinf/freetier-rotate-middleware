import type { GatewayDb } from "../storage/db.js";
import { createLogger } from "../logging.js";
import type { RouteItem, StrategyType } from "./router.js";
import { parseCycleDays, resolveCycleWindow } from "./cycle.js";
import { normalizeTokenLimitToTokens } from "./route-config.js";

type TokenDayConfig = {
  dailyTokenLimit: number;
  cycleDays: number;
};

type ReqMinDayConfig = {
  reqPerMin: number;
  reqPerDay: number;
  cycleDays: number;
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
    const dailyTokenLimit = normalizeTokenLimitToTokens(obj);

    if (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit <= 0) {
      throw new Error("token_day missing dailyTokenLimit (supports dailyTokenLimitM / dailyTokenLimitTokens / '2M')");
    }
    return {
      dailyTokenLimit,
      cycleDays: parseCycleDays(obj.cycleDays ?? obj.cycle, 1)
    };
  }

  const reqPerMin = Number(obj.reqPerMin);
  const reqPerDay = Number(obj.reqPerDay);
  if (!Number.isFinite(reqPerMin) || reqPerMin <= 0) throw new Error("req_min_day missing reqPerMin");
  if (!Number.isFinite(reqPerDay) || reqPerDay <= 0) throw new Error("req_min_day missing reqPerDay");
  return { reqPerMin, reqPerDay, cycleDays: parseCycleDays(obj.cycleDays ?? obj.cycle, 1) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function utcMinuteString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
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

  async function acquireTokenCycleSlot(upstreamModel: string, bucketKey: string, dailyLimit: number): Promise<boolean> {
    const tx = await db.raw.transaction("write");
    try {
      await ensureCounterRow(tx, upstreamModel, bucketKey);
      const reserveRes = await tx.execute({
        sql: `UPDATE quota_counters
              SET in_flight_token_requests = in_flight_token_requests + 1,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE upstream_model = ?
                AND bucket_key = ?
                AND used_tokens < ?
                AND in_flight_token_requests = 0`,
        args: [upstreamModel, bucketKey, dailyLimit]
      });
      const ok = Number(reserveRes?.rowsAffected ?? 0) === 1;
      await tx.commit();
      return ok;
    } finally {
      tx.close();
    }
  }

  async function finalizeTokenCycle(charge: TokenDayCharge, usage: Usage | undefined): Promise<void> {
    const tx = await db.raw.transaction("write");
    try {
      await ensureCounterRow(tx, charge.upstreamModel, charge.dayBucket);
      const actual = usage?.total_tokens;
      if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) {
        await tx.execute({
          sql: `UPDATE quota_counters
                SET used_tokens = used_tokens + ?,
                    in_flight_token_requests = CASE
                      WHEN in_flight_token_requests > 0 THEN in_flight_token_requests - 1
                      ELSE 0
                    END,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE upstream_model = ?
                  AND bucket_key = ?`,
          args: [actual, charge.upstreamModel, charge.dayBucket]
        });
        await tx.commit();
        log.debug("token_day charged", {
          upstreamModel: charge.upstreamModel,
          bucketKey: charge.dayBucket,
          totalTokens: actual
        });
        return;
      }

      await tx.execute({
        sql: `UPDATE quota_counters
              SET in_flight_token_requests = CASE
                    WHEN in_flight_token_requests > 0 THEN in_flight_token_requests - 1
                    ELSE 0
                  END,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE upstream_model = ?
                AND bucket_key = ?`,
        args: [charge.upstreamModel, charge.dayBucket]
      });
      await tx.commit();
      log.debug("token_day slot released without usage", {
        upstreamModel: charge.upstreamModel,
        bucketKey: charge.dayBucket
      });
    } finally {
      tx.close();
    }
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
      const cycle = resolveCycleWindow(now, cfg.cycleDays);
      const minuteBucket = utcMinuteString(now);
      const dayBucket = cycle.bucketKey;

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
      const cycle = resolveCycleWindow(now, cfg.cycleDays);
      const ok = await acquireTokenCycleSlot(routeItem.upstreamModel, cycle.bucketKey, cfg.dailyTokenLimit);
      if (!ok) return { ok: false, reason: "token quota exceeded" };

      return {
        ok: true,
        routeItem,
        tokenDayCharge: { upstreamModel: routeItem.upstreamModel, dayBucket: cycle.bucketKey }
      };
    }

    return { ok: false, reason: "unknown strategy" };
  }

  async function finalize(charge: TokenDayCharge | undefined, usage: Usage | undefined): Promise<void> {
    if (!charge) return;
    await finalizeTokenCycle(charge, usage);
  }

  return { acquire, finalize };
}
