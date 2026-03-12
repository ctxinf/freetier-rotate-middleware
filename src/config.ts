import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  databasePath: string;
};

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "8787");
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid PORT");

  return {
    port,
    upstreamBaseUrl: mustGetEnv("UPSTREAM_BASE_URL"),
    upstreamApiKey: process.env.UPSTREAM_API_KEY,
    databasePath: process.env.DATABASE_PATH ?? "./data/gateway.sqlite"
  };
}

