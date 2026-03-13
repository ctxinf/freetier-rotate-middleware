import type { AppConfig } from "../config.js";
import { createGatewayDb } from "../storage/db.js";
import { initSchema } from "../storage/init.js";
import { syncRouteItemsFromConfig } from "../storage/route_items_sync.js";
import { createRouter } from "./router.js";
import { createQuotaService } from "./quota.js";

export type AppContext = {
  config: AppConfig;
  db: ReturnType<typeof createGatewayDb>;
  router: ReturnType<typeof createRouter>;
  quota: ReturnType<typeof createQuotaService>;
};

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const db = createGatewayDb(config.databasePath);
  await initSchema(db);

  if (config.routes && config.routes.length > 0) {
    await syncRouteItemsFromConfig(db, config.routes, config.configLoadMode ?? "authoritative");
  }

  return {
    config,
    db,
    router: createRouter(db),
    quota: createQuotaService(db)
  };
}
