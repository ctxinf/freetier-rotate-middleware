import type { AppConfig } from "../config.js";
import { createGatewayDb } from "../storage/db.js";
import { initSchema } from "../storage/init.js";
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
  initSchema(db.raw);

  return {
    config,
    db,
    router: createRouter(db),
    quota: createQuotaService(db)
  };
}

