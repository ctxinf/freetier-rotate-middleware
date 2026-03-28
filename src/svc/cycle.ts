export const DAY_MS = 24 * 60 * 60 * 1000;

export type CycleWindow = {
  cycleDays: number;
  cycleStart: Date;
  cycleEnd: Date;
  bucketKey: string;
  remainingMs: number;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function utcDayString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function parseCycleDays(raw: unknown, defaultValue = 1, fieldPath = "cycleDays"): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }

  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    const dayMatch = value.match(/^([1-9]\d*)\s*day$/);
    if (dayMatch) return Number(dayMatch[1]);
    if (/^[1-9]\d*$/.test(value)) return Number(value);
    throw new Error(`${fieldPath} must be a positive integer or like "7day"`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${fieldPath} must be a positive integer or like "7day"`);
  }
  return value;
}

export function resolveCycleWindow(now: Date, cycleDaysRaw: unknown, defaultValue = 1): CycleWindow {
  const cycleDays = parseCycleDays(cycleDaysRaw, defaultValue);
  const cycleStartMs = Math.floor(now.getTime() / DAY_MS / cycleDays) * cycleDays * DAY_MS;
  const cycleStart = new Date(cycleStartMs);
  const cycleEnd = new Date(cycleStartMs + cycleDays * DAY_MS);
  const remainingMs = Math.max(0, cycleEnd.getTime() - now.getTime());
  const bucketKey = cycleDays === 1 ? utcDayString(cycleStart) : `${utcDayString(cycleStart)}::${cycleDays}day`;

  return {
    cycleDays,
    cycleStart,
    cycleEnd,
    bucketKey,
    remainingMs
  };
}

