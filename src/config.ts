import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

export type AppConfig = {
  port: number;
  upstreamBaseUrl: string;
  databasePath: string;
  routes?: RouteConfig[];
  configLoadMode?: ConfigLoadMode;
};

export type ConfigLoadMode = "authoritative" | "merge";

export type RouteConfig = {
  entryModel: string;
  upstreamModel: string;
  strategyType: "token_day" | "req_min_day";
  priority: number;
  enabled: number;
  configJson: string;
};

function normalizeTokenDayConfigToTokens(input: any): any {
  if (!input || typeof input !== "object") return input;
  const obj: any = { ...input };

  let dailyTokenLimitTokens: number | undefined;

  if (obj.dailyTokenLimitTokens !== undefined) {
    dailyTokenLimitTokens = Number(obj.dailyTokenLimitTokens);
  } else if (obj.dailyTokenLimitM !== undefined) {
    dailyTokenLimitTokens = Number(obj.dailyTokenLimitM) * 1_000_000;
  } else if (typeof obj.dailyTokenLimit === "string") {
    const s = obj.dailyTokenLimit.trim();
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*([mM])$/);
    if (m) dailyTokenLimitTokens = Number(m[1]) * 1_000_000;
    else dailyTokenLimitTokens = Number(s);
  } else if (obj.dailyTokenLimit !== undefined) {
    const raw = Number(obj.dailyTokenLimit);
    dailyTokenLimitTokens = raw >= 1_000_000 ? raw : raw * 1_000_000;
  }

  if (dailyTokenLimitTokens !== undefined && Number.isFinite(dailyTokenLimitTokens)) {
    obj.dailyTokenLimit = dailyTokenLimitTokens;
    delete obj.dailyTokenLimitM;
    delete obj.dailyTokenLimitTokens;
  }

  // Removed config keys: keep backwards-compat but strip them to reduce confusion.
  delete obj.reserveMultiplier;
  delete obj.reserveFloor;

  return obj;
}

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
    if (typeof obj.upstreamBaseUrl === "string") fileConfig.upstreamBaseUrl = obj.upstreamBaseUrl;
    if (typeof obj.databasePath === "string") fileConfig.databasePath = obj.databasePath;

    const mode = obj.configLoadMode ?? obj.routeItemsMode;
    if (mode === "authoritative" || mode === "merge") fileConfig.configLoadMode = mode;

    const routes = obj.routes ?? obj.routeItems;
    if (Array.isArray(routes)) {
      fileConfig.routes = routes.map((rawItem: any, idx: number) => {
        const entryModel =
          rawItem?.entryModel ?? rawItem?.publicModel ?? rawItem?.entry_model ?? rawItem?.public_model;
        const upstreamModel = rawItem?.upstreamModel ?? rawItem?.upstream_model;
        const strategyType = rawItem?.strategyType ?? rawItem?.strategy_type;
        const priorityRaw = rawItem?.priority ?? rawItem?.prio;
        const enabledRaw = rawItem?.enabled;
        const configJsonRaw = rawItem?.configJson ?? rawItem?.config_json ?? rawItem?.config;

        if (typeof entryModel !== "string" || entryModel.length === 0) {
          throw new Error(`routes[${idx}] missing entryModel`);
        }
        if (typeof upstreamModel !== "string" || upstreamModel.length === 0) {
          throw new Error(`routes[${idx}] missing upstreamModel`);
        }
        if (strategyType !== "token_day" && strategyType !== "req_min_day") {
          throw new Error(`routes[${idx}] invalid strategyType: ${String(strategyType)}`);
        }

        const priority = Number(priorityRaw ?? 0);
        if (!Number.isFinite(priority)) throw new Error(`routes[${idx}] invalid priority`);

        const enabled = enabledRaw === 0 || enabledRaw === "0" ? 0 : 1;

        let configJson = "{}";
        if (typeof configJsonRaw === "string") {
          configJson = configJsonRaw;
        } else if (configJsonRaw !== undefined) {
          const normalized =
            strategyType === "token_day"
              ? normalizeTokenDayConfigToTokens(configJsonRaw)
              : configJsonRaw;
          configJson = JSON.stringify(normalized);
        }

        return { entryModel, upstreamModel, strategyType, priority, enabled, configJson };
      });
    }
  }

  return fileConfig;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH;
  const fileConfig = configPath ? loadJsonFileConfig(configPath) : {};

  const port = Number(process.env.PORT ?? fileConfig.port ?? "8787");
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid PORT");

  const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? fileConfig.upstreamBaseUrl;
  if (!upstreamBaseUrl) throw new Error("Missing UPSTREAM_BASE_URL (or set it in CONFIG_PATH JSON)");

  const databasePath = process.env.DATABASE_PATH ?? fileConfig.databasePath ?? "./data/gateway.sqlite";

  const cfg: AppConfig = { port, upstreamBaseUrl, databasePath };
  if (fileConfig.routes && fileConfig.routes.length > 0) cfg.routes = fileConfig.routes;
  if (fileConfig.configLoadMode) cfg.configLoadMode = fileConfig.configLoadMode;
  return cfg;
}
