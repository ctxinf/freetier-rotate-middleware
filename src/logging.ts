import type { LogLevel } from "./config.js";

type LogFields = Record<string, unknown>;
type LogMethod = (message: string, fields?: LogFields) => void;

export type Logger = {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  child: (bindings: LogFields) => Logger;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let currentLevel: LogLevel = "info";
let logtapeGetLogger: ((category: string[]) => any) | null = null;

function levelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function serializeFields(fields?: LogFields): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return ` ${JSON.stringify(fields)}`;
  } catch {
    return " [fields_unserializable]";
  }
}

function fallbackConsoleLog(level: LogLevel, category: string, message: string, fields?: LogFields): void {
  if (!levelEnabled(level)) return;
  const line = `${new Date().toISOString()} [${level}] [${category}] ${message}${serializeFields(fields)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

async function importOptional(specifier: string): Promise<any | null> {
  try {
    const importer = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    return await importer(specifier);
  } catch {
    return null;
  }
}

function sanitizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { error: String(error) };
}

export async function initLogging(level: LogLevel): Promise<void> {
  currentLevel = level;

  const logtape = await importOptional("@logtape/logtape");
  if (!logtape) {
    fallbackConsoleLog("warn", "bootstrap.logging", "logtape not installed, using console fallback");
    return;
  }

  try {
    const configure = (logtape as any).configure;
    const getLogger = (logtape as any).getLogger;
    if (typeof getLogger !== "function") {
      throw new Error("logtape getLogger not found");
    }

    const consoleSinkMod = await importOptional("@logtape/console");
    const config: Record<string, unknown> = {
      loggers: [
        {
          category: [],
          lowestLevel: level,
          sinks: ["console"]
        }
      ]
    };
    if (consoleSinkMod && typeof (consoleSinkMod as any).getConsoleSink === "function") {
      (config as any).sinks = {
        console: (consoleSinkMod as any).getConsoleSink()
      };
    }

    if (typeof configure === "function") {
      await configure(config);
    }
    logtapeGetLogger = getLogger as (category: string[]) => any;
    fallbackConsoleLog("info", "bootstrap.logging", "logtape backend enabled", { level });
  } catch (error) {
    logtapeGetLogger = null;
    fallbackConsoleLog("warn", "bootstrap.logging", "failed to initialize logtape, using console fallback", sanitizeError(error));
  }
}

export function createLogger(category: string, bindings: LogFields = {}): Logger {
  const logWithLevel = (level: LogLevel, message: string, fields?: LogFields): void => {
    const merged = { ...bindings, ...(fields ?? {}) };
    if (logtapeGetLogger) {
      try {
        const logger = logtapeGetLogger(category.split("."));
        const fn = logger?.[level];
        if (typeof fn === "function") {
          fn.call(logger, `${message}${serializeFields(merged)}`);
          return;
        }
      } catch {
        // fall back to console
      }
    }
    fallbackConsoleLog(level, category, message, merged);
  };

  return {
    debug: (message, fields) => logWithLevel("debug", message, fields),
    info: (message, fields) => logWithLevel("info", message, fields),
    warn: (message, fields) => logWithLevel("warn", message, fields),
    error: (message, fields) => logWithLevel("error", message, fields),
    child: (extraBindings) => createLogger(category, { ...bindings, ...extraBindings })
  };
}

export { sanitizeError };
