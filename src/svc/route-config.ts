import { parseCycleDays } from "./cycle.js";

export type RouteStrategyType = "token_day" | "req_min_day";

export function normalizeTokenLimitToTokens(input: any): number {
  let dailyTokenLimit: number = NaN;

  if (input.dailyTokenLimitTokens !== undefined) {
    dailyTokenLimit = Number(input.dailyTokenLimitTokens);
  } else if (input.dailyTokenLimitM !== undefined) {
    dailyTokenLimit = Number(input.dailyTokenLimitM) * 1_000_000;
  } else if (typeof input.dailyTokenLimit === "string") {
    const s = input.dailyTokenLimit.trim();
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*([mM])$/);
    if (m) dailyTokenLimit = Number(m[1]) * 1_000_000;
    else dailyTokenLimit = Number(s);
  } else {
    dailyTokenLimit = Number(input.dailyTokenLimit);
  }

  return dailyTokenLimit;
}

function normalizeCycleDaysField(input: any): number {
  const raw = input.cycleDays ?? input.cycle ?? input.cycleDay ?? input.cycle_period;
  return parseCycleDays(raw, 1);
}

export function normalizeStrategyConfigObject(strategyType: RouteStrategyType, input: any, fieldPath: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${fieldPath} config/configJson must be object`);
  }

  const obj: Record<string, unknown> = { ...input };
  const cycleDays = normalizeCycleDaysField(obj);
  obj.cycleDays = cycleDays;
  delete obj.cycle;
  delete obj.cycleDay;
  delete obj.cycle_period;
  delete obj.resetHourUtc;
  delete obj.reserveMultiplier;
  delete obj.reserveFloor;

  if (strategyType === "token_day") {
    const dailyTokenLimit = normalizeTokenLimitToTokens(obj);
    if (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit <= 0) {
      throw new Error(`${fieldPath} token_day requires dailyTokenLimit > 0`);
    }
    obj.dailyTokenLimit = dailyTokenLimit;
    delete obj.dailyTokenLimitTokens;
    delete obj.dailyTokenLimitM;
  } else {
    const reqPerMin = Number(obj.reqPerMin);
    const reqPerDay = Number(obj.reqPerDay);
    if (!Number.isFinite(reqPerMin) || reqPerMin <= 0) {
      throw new Error(`${fieldPath} req_min_day requires reqPerMin > 0`);
    }
    if (!Number.isFinite(reqPerDay) || reqPerDay <= 0) {
      throw new Error(`${fieldPath} req_min_day requires reqPerDay > 0`);
    }
  }

  return obj;
}

export function normalizeStrategyConfigJson(
  strategyType: RouteStrategyType,
  rawConfigJson: unknown,
  fieldPath: string
): string {
  if (typeof rawConfigJson === "string") {
    let parsed: any;
    try {
      parsed = JSON.parse(rawConfigJson);
    } catch {
      throw new Error(`${fieldPath} configJson must be valid JSON`);
    }
    return JSON.stringify(normalizeStrategyConfigObject(strategyType, parsed, fieldPath));
  }

  if (rawConfigJson === undefined) {
    return JSON.stringify(normalizeStrategyConfigObject(strategyType, {}, fieldPath));
  }

  if (rawConfigJson === null || typeof rawConfigJson !== "object" || Array.isArray(rawConfigJson)) {
    throw new Error(`${fieldPath} config/configJson must be object or JSON string`);
  }

  return JSON.stringify(normalizeStrategyConfigObject(strategyType, rawConfigJson, fieldPath));
}
