import type { LogLevel } from "./config.js";

type LogFields = Record<string, unknown>;
type LogMethod = (message: string, fields?: LogFields) => void;
type LogtapeGetLogger = (category: string[]) => any;

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
let logtapeGetLogger: LogtapeGetLogger | null = null;
const fallbackColorEnabled = Boolean(process.stdout?.isTTY);

function toLogtapeLevel(level: LogLevel): string {
  return level === "warn" ? "warning" : level;
}

function levelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function colorize(text: string, code: string): string {
  if (!fallbackColorEnabled) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function levelColor(level: LogLevel): string {
  if (level === "error") return "31";
  if (level === "warn") return "33";
  if (level === "info") return "32";
  return "36";
}

function formatFieldValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "string") {
    return /^[A-Za-z0-9._:@/-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (value instanceof Error) {
    return `${value.name}:${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function serializeFields(fields?: LogFields): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return ` ${Object.entries(fields).map(([k, v]) => `${k}=${formatFieldValue(v)}`).join(" ")}`;
  } catch {
    return " [fields_unserializable]";
  }
}

function fallbackConsoleLog(level: LogLevel, category: string, message: string, fields?: LogFields): void {
  if (!levelEnabled(level)) return;
  const timestamp = colorize(new Date().toISOString(), "90");
  const levelTag = colorize(level.toUpperCase(), levelColor(level));
  const categoryTag = colorize(category, "35");
  const line = `[${timestamp}] [${levelTag}] [${categoryTag}] ${message}${serializeFields(fields)}`;
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
  logtapeGetLogger = null;

  const logtape = await importOptional("@logtape/logtape");
  if (!logtape) {
    fallbackConsoleLog("warn", "bootstrap.logging", "logtape not installed, using console fallback");
    return;
  }

  try {
    const configure = (logtape as any).configure;
    const getLogger = (logtape as any).getLogger;
    const getConsoleSink = (logtape as any).getConsoleSink;
    const getAnsiColorFormatter = (logtape as any).getAnsiColorFormatter;
    const defaultTextFormatter = (logtape as any).defaultTextFormatter;
    if (typeof configure !== "function") throw new Error("logtape configure not found");
    if (typeof getLogger !== "function") throw new Error("logtape getLogger not found");
    if (typeof getConsoleSink !== "function") throw new Error("logtape getConsoleSink not found");

    const sinkOptions: Record<string, unknown> = {};
    if (fallbackColorEnabled && typeof getAnsiColorFormatter === "function") {
      sinkOptions.formatter = getAnsiColorFormatter();
    } else if (typeof defaultTextFormatter === "function") {
      sinkOptions.formatter = defaultTextFormatter;
    }

    const config: Record<string, unknown> = {
      sinks: { console: getConsoleSink(sinkOptions) },
      loggers: [
        {
          category: ["logtape", "meta"],
          lowestLevel: "error",
          sinks: ["console"]
        },
        {
          category: [],
          lowestLevel: toLogtapeLevel(level),
          sinks: ["console"]
        }
      ]
    };

    await configure(config);
    logtapeGetLogger = getLogger as LogtapeGetLogger;
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
          if (Object.keys(merged).length === 0) {
            fn.call(logger, message);
          } else {
            fn.call(logger, message, merged);
          }
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
