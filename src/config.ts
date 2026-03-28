import dotenv from "dotenv";
import fs from "node:fs";
import { normalizeStrategyConfigJson, type RouteStrategyType } from "./svc/route-config.js";

dotenv.config();

export type StrategyType = RouteStrategyType;

export type AppConfig = {
  port: number;
  basePath: string;
  upstreamBaseUrl: string;
  databasePath: string;
  routes?: RouteConfig[];
  configLoadMode?: ConfigLoadMode;
  logLevel?: LogLevel;
};

export type ConfigLoadMode = "authoritative" | "load_once";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type RouteConfig = {
  entryModel: string;
  upstreamModel: string;
  strategyType: StrategyType;
  priority: number;
  enabled: number;
  configJson: string;
};

type UpstreamPolicy = {
  upstreamModel: string;
  strategyType: StrategyType;
  enabled: number;
  configJson: string;
};

type GroupRouteRef = {
  upstreamModel: string;
  priority: number;
  enabledRaw?: unknown;
  strategyTypeRaw?: unknown;
  configJsonRaw?: unknown;
};

function stripJsoncComments(source: string): string {
  let out = "";
  let inString = false;
  let quote = '"';
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && i + 1 < source.length) {
      const next = source[i + 1]!;
      if (next === "/") {
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        out += "\n";
        continue;
      }
      if (next === "*") {
        i += 2;
        while (i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 1;
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function stripTrailingCommas(source: string): string {
  let out = "";
  let inString = false;
  let quote = '"';
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      const next = source[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function normalizeBasePath(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "/";

  let candidate = value;
  try {
    if (/^https?:\/\//i.test(value)) {
      candidate = new URL(value).pathname;
    }
  } catch {
    throw new Error(`Invalid basePath/baseUrl: ${value}`);
  }

  if (candidate.includes("?") || candidate.includes("#")) {
    throw new Error("basePath/baseUrl must not include query or hash");
  }
  if (/[<>"'`\s]/.test(candidate)) {
    throw new Error("basePath/baseUrl contains invalid characters");
  }

  if (!candidate.startsWith("/")) candidate = `/${candidate}`;
  candidate = candidate.replace(/\/{2,}/g, "/");
  candidate = candidate.replace(/\/+$/, "");
  return candidate === "" ? "/" : candidate;
}

function parseStrategyType(raw: unknown, fieldPath: string): StrategyType {
  if (raw === "token_day" || raw === "req_min_day") return raw;
  throw new Error(`${fieldPath} invalid strategyType: ${String(raw)}`);
}

function parseEnabled(raw: unknown, defaultValue = 1): number {
  if (raw === undefined || raw === null || raw === "") return defaultValue === 0 ? 0 : 1;
  return raw === 0 || raw === "0" || raw === false ? 0 : 1;
}

function parsePriority(raw: unknown, fieldPath: string, defaultValue: number): number {
  const priority = Number(raw ?? defaultValue);
  if (!Number.isFinite(priority)) throw new Error(`${fieldPath} invalid priority`);
  return priority;
}

function parseConfigJson(
  strategyType: StrategyType,
  rawConfigJson: unknown,
  fieldPath: string
): string {
  return normalizeStrategyConfigJson(strategyType, rawConfigJson, fieldPath);
}

function resolveRouteRef(rawRef: any, idx: number, basePriority: number, step: number): GroupRouteRef {
  const derivedPriority = basePriority - idx * step;
  if (typeof rawRef === "string") {
    return {
      upstreamModel: rawRef,
      priority: derivedPriority
    };
  }

  if (!rawRef || typeof rawRef !== "object") {
    throw new Error(`groups[] route ref at index ${idx} must be string or object`);
  }

  const upstreamModel =
    rawRef.upstreamModel ??
    rawRef.upstream_model ??
    rawRef.model ??
    rawRef.id;
  if (typeof upstreamModel !== "string" || upstreamModel.length === 0) {
    throw new Error(`groups[] route ref at index ${idx} missing upstreamModel`);
  }

  return {
    upstreamModel,
    priority: parsePriority(rawRef.priority ?? rawRef.prio, `groups[] route ref at index ${idx}`, derivedPriority),
    enabledRaw: rawRef.enabled,
    strategyTypeRaw: rawRef.strategyType ?? rawRef.strategy_type,
    configJsonRaw: rawRef.configJson ?? rawRef.config_json ?? rawRef.config
  };
}

function parseUpstreamPolicies(raw: unknown): Map<string, UpstreamPolicy> {
  const byModel = new Map<string, UpstreamPolicy>();
  if (!raw) return byModel;

  const pushOne = (item: any, fieldPath: string, modelOverride?: string) => {
    const upstreamModel =
      modelOverride ??
      item?.upstreamModel ??
      item?.upstream_model ??
      item?.model ??
      item?.id;
    if (typeof upstreamModel !== "string" || upstreamModel.length === 0) {
      throw new Error(`${fieldPath} missing upstreamModel`);
    }

    const strategyType = parseStrategyType(item?.strategyType ?? item?.strategy_type, fieldPath);
    const configJson = parseConfigJson(
      strategyType,
      item?.configJson ?? item?.config_json ?? item?.config,
      fieldPath
    );
    const enabled = parseEnabled(item?.enabled, 1);

    byModel.set(upstreamModel, {
      upstreamModel,
      strategyType,
      configJson,
      enabled
    });
  };

  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => pushOne(item, `upstreams[${idx}]`));
    return byModel;
  }

  if (typeof raw === "object") {
    for (const [model, item] of Object.entries(raw as Record<string, any>)) {
      pushOne(item, `upstreams.${model}`, model);
    }
    return byModel;
  }

  throw new Error("upstreams must be array or object");
}

function parseFlatRoutes(raw: unknown, upstreamPolicies: Map<string, UpstreamPolicy>): RouteConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((rawItem: any, idx: number) => {
    const entryModel =
      rawItem?.entryModel ?? rawItem?.publicModel ?? rawItem?.entry_model ?? rawItem?.public_model;
    const upstreamModel = rawItem?.upstreamModel ?? rawItem?.upstream_model;
    if (typeof entryModel !== "string" || entryModel.length === 0) {
      throw new Error(`routes[${idx}] missing entryModel`);
    }
    if (typeof upstreamModel !== "string" || upstreamModel.length === 0) {
      throw new Error(`routes[${idx}] missing upstreamModel`);
    }

    const upstreamPolicy = upstreamPolicies.get(upstreamModel);
    const strategyTypeRaw = rawItem?.strategyType ?? rawItem?.strategy_type ?? upstreamPolicy?.strategyType;
    const strategyType = parseStrategyType(strategyTypeRaw, `routes[${idx}]`);

    const priority = parsePriority(rawItem?.priority ?? rawItem?.prio, `routes[${idx}]`, 0);
    const routeEnabled = parseEnabled(rawItem?.enabled, upstreamPolicy?.enabled ?? 1);
    const enabled = upstreamPolicy?.enabled === 0 ? 0 : routeEnabled;

    let configJson: string;
    if (rawItem?.configJson !== undefined || rawItem?.config_json !== undefined || rawItem?.config !== undefined) {
      configJson = parseConfigJson(
        strategyType,
        rawItem?.configJson ?? rawItem?.config_json ?? rawItem?.config,
        `routes[${idx}]`
      );
    } else if (upstreamPolicy) {
      configJson = upstreamPolicy.configJson;
    } else {
      throw new Error(`routes[${idx}] missing config/configJson and no upstream policy found for ${upstreamModel}`);
    }

    return { entryModel, upstreamModel, strategyType, priority, enabled, configJson };
  });
}

function parseGroupRoutes(raw: unknown, upstreamPolicies: Map<string, UpstreamPolicy>): RouteConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: RouteConfig[] = [];

  raw.forEach((group, groupIdx) => {
    const entryModel = group?.entryModel ?? group?.entry;
    if (typeof entryModel !== "string" || entryModel.length === 0) {
      throw new Error(`groups[${groupIdx}] missing entryModel`);
    }

    const refsRaw = group?.routes ?? group?.targets ?? group?.upstreams ?? group?.upstreamModels;
    if (!Array.isArray(refsRaw)) {
      throw new Error(`groups[${groupIdx}] missing routes/upstreams array`);
    }

    const basePriority = parsePriority(group?.priorityBase, `groups[${groupIdx}]`, 1000);
    const step = parsePriority(group?.priorityStep, `groups[${groupIdx}]`, 10);

    refsRaw.forEach((rawRef, refIdx) => {
      const ref = resolveRouteRef(rawRef, refIdx, basePriority, step);
      const upstreamPolicy = upstreamPolicies.get(ref.upstreamModel);
      const strategyTypeRaw = ref.strategyTypeRaw ?? upstreamPolicy?.strategyType;
      const strategyType = parseStrategyType(strategyTypeRaw, `groups[${groupIdx}].routes[${refIdx}]`);

      const routeEnabled = parseEnabled(ref.enabledRaw, upstreamPolicy?.enabled ?? 1);
      const enabled = upstreamPolicy?.enabled === 0 ? 0 : routeEnabled;

      let configJson: string;
      if (ref.configJsonRaw !== undefined) {
        configJson = parseConfigJson(strategyType, ref.configJsonRaw, `groups[${groupIdx}].routes[${refIdx}]`);
      } else if (upstreamPolicy) {
        configJson = upstreamPolicy.configJson;
      } else {
        throw new Error(
          `groups[${groupIdx}].routes[${refIdx}] missing config/configJson and no upstream policy found for ${ref.upstreamModel}`
        );
      }

      out.push({
        entryModel,
        upstreamModel: ref.upstreamModel,
        strategyType,
        priority: ref.priority,
        enabled,
        configJson
      });
    });
  });

  return out;
}

function loadJsonFileConfig(configPath: string): Partial<AppConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e: any) {
    throw new Error(`Failed to read CONFIG_PATH file: ${configPath}: ${e?.message ?? String(e)}`);
  }

  let obj: any;
  try {
    const normalized = stripTrailingCommas(stripJsoncComments(raw.replace(/^\uFEFF/, "")));
    obj = JSON.parse(normalized);
  } catch (e: any) {
    throw new Error(`Invalid JSON/JSONC in CONFIG_PATH file: ${configPath}: ${e?.message ?? String(e)}`);
  }

  const fileConfig: Partial<AppConfig> = {};
  if (obj && typeof obj === "object") {
    if (obj.port !== undefined) fileConfig.port = Number(obj.port);
    if (typeof obj.basePath === "string" || typeof obj.baseUrl === "string") {
      fileConfig.basePath = normalizeBasePath(obj.basePath ?? obj.baseUrl);
    }
    if (typeof obj.upstreamBaseUrl === "string") fileConfig.upstreamBaseUrl = obj.upstreamBaseUrl;
    if (typeof obj.databasePath === "string") fileConfig.databasePath = obj.databasePath;

    const mode = obj.configLoadMode ?? obj.routeItemsMode;
    if (mode === "authoritative" || mode === "load_once") fileConfig.configLoadMode = mode;
    if (mode === "overwrite") fileConfig.configLoadMode = "authoritative";
    if (mode === "merge") fileConfig.configLoadMode = "load_once";

    if (obj.logLevel === "debug" || obj.logLevel === "info" || obj.logLevel === "warn" || obj.logLevel === "error") {
      fileConfig.logLevel = obj.logLevel;
    }

    const upstreamPolicies = parseUpstreamPolicies(obj.upstreams);
    const flatRoutes = parseFlatRoutes(obj.routes ?? obj.routeItems, upstreamPolicies);
    const groupRoutes = parseGroupRoutes(obj.groups, upstreamPolicies);
    const combinedRoutes = [...flatRoutes, ...groupRoutes];
    if (combinedRoutes.length > 0) {
      fileConfig.routes = combinedRoutes;
    }
  }

  return fileConfig;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH;
  const fileConfig = configPath ? loadJsonFileConfig(configPath) : {};

  const port = Number(process.env.PORT ?? fileConfig.port ?? "8787");
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid PORT");
  const basePath = normalizeBasePath(process.env.BASE_PATH ?? fileConfig.basePath ?? "/");

  const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? fileConfig.upstreamBaseUrl;
  if (!upstreamBaseUrl) throw new Error("Missing UPSTREAM_BASE_URL (or set it in CONFIG_PATH JSON)");

  const databasePath = process.env.DATABASE_PATH ?? fileConfig.databasePath ?? "./data/gateway.sqlite";
  const logLevelRaw = process.env.LOG_LEVEL ?? fileConfig.logLevel ?? "info";
  if (logLevelRaw !== "debug" && logLevelRaw !== "info" && logLevelRaw !== "warn" && logLevelRaw !== "error") {
    throw new Error("Invalid LOG_LEVEL, must be one of: debug/info/warn/error");
  }

  const cfg: AppConfig = { port, basePath, upstreamBaseUrl, databasePath, logLevel: logLevelRaw };
  if (fileConfig.routes && fileConfig.routes.length > 0) cfg.routes = fileConfig.routes;
  if (fileConfig.configLoadMode) cfg.configLoadMode = fileConfig.configLoadMode;
  return cfg;
}
