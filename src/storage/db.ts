import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";

export type GatewayDb = {
  raw: ReturnType<typeof createClient>;
  orm: ReturnType<typeof drizzle>;
};

export function createGatewayDb(databasePath: string): GatewayDb {
  const isRemote =
    databasePath.startsWith("libsql:") ||
    databasePath.startsWith("https:") ||
    databasePath.startsWith("http:");

  if (!isRemote && databasePath !== ":memory:") {
    const fsPath = databasePath.startsWith("file:") ? databasePath.slice("file:".length) : databasePath;
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
  }

  const url =
    databasePath === ":memory:" ||
    databasePath.startsWith("file:") ||
    databasePath.startsWith("libsql:") ||
    databasePath.startsWith("https:") ||
    databasePath.startsWith("http:")
      ? databasePath
      : `file:${databasePath}`;

  const raw = createClient({ url, intMode: "number" });

  const orm = drizzle(raw, { schema });
  return { raw, orm };
}
