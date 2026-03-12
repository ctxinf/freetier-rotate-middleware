import type { GatewayDb } from "../storage/db.js";
import type { RouteItem, StrategyType } from "./router.js";

type TokenDayConfig = {
  dailyTokenLimit: number;
  resetHourUtc?: number;
  reserveMultiplier?: number;
  reserveFloor?: number;
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

type TokenReservation = {
  routeItemId: number;
  dayBucket: string;
  reservedTokens: number;
  dailyLimit: number;
};

export type AcquireHandle =
  | { ok: true; routeItem: RouteItem; reservation?: TokenReservation }
  | { ok: false; reason: string };

function parseConfig(strategyType: StrategyType, configJson: string): TokenDayConfig | ReqMinDayConfig {
  let obj: any = {};
  try {
    obj = JSON.parse(configJson || "{}");
  } catch {
    obj = {};
  }

  if (strategyType === "token_day") {
    const dailyTokenLimit = Number(obj.dailyTokenLimit);
    if (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit <= 0) {
      throw new Error("token_day missing dailyTokenLimit");
    }
    return {
      dailyTokenLimit,
      resetHourUtc: Number.isFinite(Number(obj.resetHourUtc)) ? Number(obj.resetHourUtc) : 0,
      reserveMultiplier: Number.isFinite(Number(obj.reserveMultiplier)) ? Number(obj.reserveMultiplier) : 1.2,
      reserveFloor: Number.isFinite(Number(obj.reserveFloor)) ? Number(obj.reserveFloor) : 64
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

function estimateTokensFromBody(body: any): number {
  // Tokenizers are model-specific; use a conservative heuristic for reservation.
  const s = JSON.stringify(body ?? "");
  return Math.ceil(s.length / 4);
}

export function createQuotaService(db: GatewayDb) {
  function ensureCounterRow(routeItemId: number, bucketKey: string): void {
    db.raw
      .prepare(
        "INSERT INTO quota_counters(route_item_id, bucket_key) VALUES(?, ?) ON CONFLICT(route_item_id, bucket_key) DO NOTHING"
      )
      .run(routeItemId, bucketKey);
  }

  function getCounter(routeItemId: number, bucketKey: string): { used_tokens: number; used_req: number; reserved_tokens: number } {
    const row = db.raw
      .prepare("SELECT used_tokens, used_req, reserved_tokens FROM quota_counters WHERE route_item_id = ? AND bucket_key = ?")
      .get(routeItemId, bucketKey) as any;
    if (!row) return { used_tokens: 0, used_req: 0, reserved_tokens: 0 };
    return row;
  }

  function consumeReqMinuteAndDay(routeItemId: number, minuteBucket: string, minuteLimit: number, dayBucket: string, dayLimit: number): boolean {
    ensureCounterRow(routeItemId, minuteBucket);
    ensureCounterRow(routeItemId, dayBucket);

    const minuteCur = getCounter(routeItemId, minuteBucket);
    const dayCur = getCounter(routeItemId, dayBucket);
    if (minuteCur.used_req + 1 > minuteLimit) return false;
    if (dayCur.used_req + 1 > dayLimit) return false;

    const stmt = db.raw.prepare(
      "UPDATE quota_counters SET used_req = used_req + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_item_id = ? AND bucket_key = ?"
    );
    stmt.run(routeItemId, minuteBucket);
    stmt.run(routeItemId, dayBucket);
    return true;
  }

  function reserveTokens(routeItemId: number, dayBucket: string, reserve: number, dailyLimit: number): boolean {
    ensureCounterRow(routeItemId, dayBucket);
    const cur = getCounter(routeItemId, dayBucket);
    if (cur.used_tokens + cur.reserved_tokens + reserve > dailyLimit) return false;
    db.raw
      .prepare(
        "UPDATE quota_counters SET reserved_tokens = reserved_tokens + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_item_id = ? AND bucket_key = ?"
      )
      .run(reserve, routeItemId, dayBucket);
    return true;
  }

  function settleTokens(routeItemId: number, dayBucket: string, reserved: number, actual: number): void {
    ensureCounterRow(routeItemId, dayBucket);
    db.raw
      .prepare(
        "UPDATE quota_counters SET used_tokens = used_tokens + ?, reserved_tokens = reserved_tokens - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_item_id = ? AND bucket_key = ?"
      )
      .run(actual, reserved, routeItemId, dayBucket);
  }

  function chargeReservedAsUsed(routeItemId: number, dayBucket: string, reserved: number): void {
    ensureCounterRow(routeItemId, dayBucket);
    db.raw
      .prepare(
        "UPDATE quota_counters SET used_tokens = used_tokens + ?, reserved_tokens = reserved_tokens - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_item_id = ? AND bucket_key = ?"
      )
      .run(reserved, reserved, routeItemId, dayBucket);
  }

  function acquire(routeItem: RouteItem, clientBody: any, now: Date = new Date()): AcquireHandle {
    if (routeItem.enabled !== 1) return { ok: false, reason: "disabled" };

    if (routeItem.strategyType === "req_min_day") {
      let cfg: ReqMinDayConfig;
      try {
        cfg = parseConfig("req_min_day", routeItem.configJson) as ReqMinDayConfig;
      } catch {
        return { ok: false, reason: "invalid config" };
      }
      const minuteBucket = utcMinuteString(now);
      const dayBucket = utcDayString(now);

      const ok = db.raw.transaction(() =>
        consumeReqMinuteAndDay(routeItem.id, minuteBucket, cfg.reqPerMin, dayBucket, cfg.reqPerDay)
      )();

      if (!ok) return { ok: false, reason: "req quota exceeded" };
      return { ok: true, routeItem };
    }

    if (routeItem.strategyType === "token_day") {
      let cfg: TokenDayConfig;
      try {
        cfg = parseConfig("token_day", routeItem.configJson) as TokenDayConfig;
      } catch {
        return { ok: false, reason: "invalid config" };
      }
      const dayBucket = quotaDayBucket(now, cfg.resetHourUtc ?? 0);
      const estimate = estimateTokensFromBody(clientBody);
      const reserve = Math.max(
        Math.ceil(estimate * (cfg.reserveMultiplier ?? 1.2)),
        cfg.reserveFloor ?? 64
      );

      const ok = db.raw.transaction(() => reserveTokens(routeItem.id, dayBucket, reserve, cfg.dailyTokenLimit))();
      if (!ok) return { ok: false, reason: "token quota exceeded" };

      return {
        ok: true,
        routeItem,
        reservation: {
          routeItemId: routeItem.id,
          dayBucket,
          reservedTokens: reserve,
          dailyLimit: cfg.dailyTokenLimit
        }
      };
    }

    return { ok: false, reason: "unknown strategy" };
  }

  function finalize(reservation: TokenReservation | undefined, usage: Usage | undefined): void {
    if (!reservation) return;
    const actual = usage?.total_tokens;
    if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) {
      settleTokens(reservation.routeItemId, reservation.dayBucket, reservation.reservedTokens, actual);
      return;
    }
    chargeReservedAsUsed(reservation.routeItemId, reservation.dayBucket, reservation.reservedTokens);
  }

  return { acquire, finalize };
}
