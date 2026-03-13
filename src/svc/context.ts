import type { AppConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { createGatewayDb } from "../storage/db.js";
import { initSchema } from "../storage/init.js";
import { syncRouteItemsFromConfig } from "../storage/route_items_sync.js";
import { getSetting, setSetting } from "../storage/settings.js";
import { createRouter } from "./router.js";
import { createQuotaService } from "./quota.js";

const log = createLogger("svc.context");

const UPSTREAM_BASE_URL_KEY = "upstream_base_url";

export type AppContext = {
  config: AppConfig;
  db: ReturnType<typeof createGatewayDb>;
  router: ReturnType<typeof createRouter>;
  quota: ReturnType<typeof createQuotaService>;
  runtime: {
    getUpstreamBaseUrl: () => string;
    setUpstreamBaseUrl: (value: string) => Promise<void>;
  };
};

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const db = createGatewayDb(config.databasePath);
  await initSchema(db);

  const storedUpstreamBaseUrl = await getSetting(db, UPSTREAM_BASE_URL_KEY);
  const effectiveUpstreamBaseUrl =
    typeof storedUpstreamBaseUrl === "string" && storedUpstreamBaseUrl.trim().length > 0
      ? storedUpstreamBaseUrl.trim()
      : config.upstreamBaseUrl;
  let runtimeUpstreamBaseUrl = effectiveUpstreamBaseUrl;

  if (runtimeUpstreamBaseUrl !== config.upstreamBaseUrl) {
    log.info("using upstream_base_url from app_settings", {
      configValue: config.upstreamBaseUrl,
      persistedValue: runtimeUpstreamBaseUrl
    });
  }

  if (config.routes && config.routes.length > 0) {
    const sync = await syncRouteItemsFromConfig(db, config.routes, config.configLoadMode ?? "authoritative");
    log.info("route_items synced from config", {
      mode: config.configLoadMode ?? "authoritative",
      inserted: sync.inserted,
      updated: sync.updated,
      skipped: sync.skipped,
      deleted: sync.deleted
    });
  }

  return {
    config,
    db,
    router: createRouter(db),
    quota: createQuotaService(db),
    runtime: {
      getUpstreamBaseUrl: () => runtimeUpstreamBaseUrl,
      setUpstreamBaseUrl: async (value: string) => {
        runtimeUpstreamBaseUrl = value;
        await setSetting(db, UPSTREAM_BASE_URL_KEY, value);
      }
    }
  };
}
