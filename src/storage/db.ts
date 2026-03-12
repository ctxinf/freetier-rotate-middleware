import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";

export type GatewayDb = {
  raw: Database.Database;
  orm: ReturnType<typeof drizzle>;
};

export function createGatewayDb(databasePath: string): GatewayDb {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const raw = new Database(databasePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");

  const orm = drizzle(raw, { schema });
  return { raw, orm };
}
