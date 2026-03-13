import type { GatewayDb } from "./db.js";

export async function getSetting(db: GatewayDb, key: string): Promise<string | null> {
  const res = await db.raw.execute({
    sql: "SELECT value FROM app_settings WHERE key = ? LIMIT 1",
    args: [key]
  });
  const row = (res.rows?.[0] as { value?: unknown } | undefined) ?? undefined;
  return typeof row?.value === "string" ? row.value : null;
}

export async function setSetting(db: GatewayDb, key: string, value: string): Promise<void> {
  await db.raw.execute({
    sql: `INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value]
  });
}
