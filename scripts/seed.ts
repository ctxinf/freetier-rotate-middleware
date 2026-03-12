import { createGatewayDb } from "../src/storage/db.js";
import { initSchema } from "../src/storage/init.js";

const databasePath = process.env.DATABASE_PATH ?? "./data/gateway.sqlite";
const db = createGatewayDb(databasePath);
await initSchema(db);

const publicModel = process.argv[2] ?? "gpt-4o-mini";
const upstreamModel = process.argv[3] ?? publicModel;

// Example configs:
// token_day: {"dailyTokenLimit":2000000,"resetHourUtc":0}
// req_min_day: {"reqPerMin":5,"reqPerDay":100}
const strategyType = (process.argv[4] ?? "req_min_day") as "token_day" | "req_min_day";
const priority = Number(process.argv[5] ?? "100");
const configJson = process.argv[6] ?? JSON.stringify({ reqPerMin: 999999, reqPerDay: 999999 });

await db.raw.execute({
  sql: "INSERT INTO route_items(public_model, upstream_model, strategy_type, priority, config_json, enabled) VALUES(?, ?, ?, ?, ?, 1)",
  args: [publicModel, upstreamModel, strategyType, priority, configJson]
});

// eslint-disable-next-line no-console
console.log("seeded route_item", { publicModel, upstreamModel, strategyType, priority, configJson });
