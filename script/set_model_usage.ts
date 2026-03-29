import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { createGatewayDb } from "../src/storage/db.ts";
import { initSchema } from "../src/storage/init.ts";
import { parseCycleDays, resolveCycleWindow } from "../src/svc/cycle.ts";

type CliOptions = {
  model: string;
  databasePath: string;
  cycleDays?: number;
  bucketKey?: string;
  targetTokens: number;
  mode: "set" | "ensure_over";
};

function fail(message: string): never {
  throw new Error(message);
}

function parseMillionValue(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail(`${flagName} must be a non-negative number`);
  }
  return Math.floor(value * 1_000_000);
}

function parseTokenValue(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    fail(`${flagName} must be a non-negative integer`);
  }
  return value;
}

function defaultDatabasePath(): string {
  if (typeof process.env.DATABASE_PATH === "string" && process.env.DATABASE_PATH.trim().length > 0) {
    return process.env.DATABASE_PATH.trim();
  }
  return "./data/gateway.sqlite";
}

function printHelp(): void {
  console.log(`
Usage:
  npm run set:usage -- --model <upstream_model> --over-m <value>
  npm run set:usage -- --model <upstream_model> --usage-m <value>

Examples:
  npm run set:usage -- --model doubao-seed-2-0-pro-260215 --over-m 0.75
  npm run set:usage -- --model doubao-seed-2-0-pro-260215 --usage-tokens 934000

Options:
  --model            Required. quota_counters.upstream_model
  --over-m           Ensure current usage is > N million tokens
  --over-tokens      Ensure current usage is > N tokens
  --usage-m          Set current usage to N million tokens
  --usage-tokens     Set current usage to N tokens
  --cycle-days       Optional. Infer from route_items when omitted
  --bucket-key       Optional. Override current cycle bucket key directly
  --database         Optional. Defaults to DATABASE_PATH or ./data/gateway.sqlite
  --help             Show this message
`.trim());
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "over-m": { type: "string" },
      "over-tokens": { type: "string" },
      "usage-m": { type: "string" },
      "usage-tokens": { type: "string" },
      "cycle-days": { type: "string" },
      "bucket-key": { type: "string" },
      database: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const model = values.model?.trim();
  if (!model) fail("--model is required");

  const setModes = [
    values["usage-m"] !== undefined,
    values["usage-tokens"] !== undefined,
    values["over-m"] !== undefined,
    values["over-tokens"] !== undefined
  ].filter(Boolean).length;
  if (setModes !== 1) {
    fail("exactly one of --over-m / --over-tokens / --usage-m / --usage-tokens is required");
  }

  let mode: "set" | "ensure_over";
  let targetTokens: number;
  if (values["usage-m"] !== undefined) {
    mode = "set";
    targetTokens = parseMillionValue(values["usage-m"], "--usage-m");
  } else if (values["usage-tokens"] !== undefined) {
    mode = "set";
    targetTokens = parseTokenValue(values["usage-tokens"], "--usage-tokens");
  } else if (values["over-m"] !== undefined) {
    mode = "ensure_over";
    targetTokens = parseMillionValue(values["over-m"], "--over-m") + 1;
  } else {
    mode = "ensure_over";
    targetTokens = parseTokenValue(values["over-tokens"]!, "--over-tokens") + 1;
  }

  const cycleDays = values["cycle-days"] !== undefined
    ? parseCycleDays(values["cycle-days"], 1, "--cycle-days")
    : undefined;
  const bucketKey = values["bucket-key"]?.trim() || undefined;
  const databasePath = values.database?.trim() || defaultDatabasePath();

  const options: CliOptions = {
    model,
    databasePath,
    targetTokens,
    mode
  };
  if (cycleDays !== undefined) {
    options.cycleDays = cycleDays;
  }
  if (bucketKey !== undefined) {
    options.bucketKey = bucketKey;
  }
  return options;
}

async function inferCycleDays(db: ReturnType<typeof createGatewayDb>, model: string): Promise<number> {
  const res = await db.raw.execute({
    sql: "SELECT config_json FROM route_items WHERE upstream_model = ? AND strategy_type = 'token_day'",
    args: [model]
  });
  const rows = (res.rows as Array<{ config_json?: string }>) ?? [];
  if (rows.length === 0) {
    return 1;
  }

  const cycleDaysValues = new Set<number>();
  for (const row of rows) {
    let parsed: any = {};
    try {
      parsed = JSON.parse(row.config_json ?? "{}");
    } catch {
      parsed = {};
    }
    cycleDaysValues.add(parseCycleDays(parsed?.cycleDays ?? parsed?.cycle, 1));
  }

  if (cycleDaysValues.size > 1) {
    fail(`multiple cycleDays found for model ${model}; pass --cycle-days explicitly`);
  }

  return [...cycleDaysValues][0] ?? 1;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (!options.databasePath.startsWith("file:") && options.databasePath !== ":memory:") {
    const dir = options.databasePath.includes("/")
      ? options.databasePath.slice(0, options.databasePath.lastIndexOf("/"))
      : ".";
    if (!fs.existsSync(dir)) {
      fail(`database directory does not exist: ${dir}`);
    }
  }

  const db = createGatewayDb(options.databasePath);
  await initSchema(db);

  const cycleDays = options.bucketKey ? undefined : (options.cycleDays ?? await inferCycleDays(db, options.model));
  const bucketKey = options.bucketKey ?? resolveCycleWindow(new Date(), cycleDays!, 1).bucketKey;

  const tx = await db.raw.transaction("write");
  try {
    await tx.execute({
      sql: "INSERT INTO quota_counters(upstream_model, bucket_key) VALUES(?, ?) ON CONFLICT(upstream_model, bucket_key) DO NOTHING",
      args: [options.model, bucketKey]
    });

    const beforeRes = await tx.execute({
      sql: "SELECT used_tokens, in_flight_token_requests FROM quota_counters WHERE upstream_model = ? AND bucket_key = ? LIMIT 1",
      args: [options.model, bucketKey]
    });
    const beforeRow = ((beforeRes.rows as Array<{ used_tokens?: number; in_flight_token_requests?: number }>) ?? [])[0] ?? {};
    const beforeTokens = Number(beforeRow.used_tokens ?? 0);
    const inFlightTokenRequests = Number(beforeRow.in_flight_token_requests ?? 0);
    const afterTokens = options.mode === "ensure_over"
      ? Math.max(beforeTokens, options.targetTokens)
      : options.targetTokens;

    await tx.execute({
      sql: "UPDATE quota_counters SET used_tokens = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upstream_model = ? AND bucket_key = ?",
      args: [afterTokens, options.model, bucketKey]
    });

    await tx.commit();

    console.log(JSON.stringify({
      model: options.model,
      bucketKey,
      cycleDays: cycleDays ?? null,
      databasePath: options.databasePath,
      mode: options.mode,
      beforeTokens,
      afterTokens,
      inFlightTokenRequests
    }, null, 2));
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
    await db.raw.close();
  }
}

await main();
