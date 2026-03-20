import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { registerAdminRestRoutes } from "./admin/rest.js";
import { createLogger, initLogging, sanitizeError } from "./logging.js";
import { createAppContext } from "./svc/context.js";
import { chatCompletionsHandler } from "./v1/chat-completions.js";
import { registerStatusRoutes } from "./pages/page_status.js";
import { modelsHandler } from "./v1/models.js";
import { registerHomeAndDocsRoutes } from "./pages/page_home.js";

const config = loadConfig();
await initLogging(config.logLevel ?? "info");
const log = createLogger("server");
const ctx = await createAppContext(config);

const app = new Hono();
const baseApp = config.basePath === "/" ? app : app.basePath(config.basePath);

app.use("*", async (c, next) => {
  const started = Date.now();
  const reqId = c.req.header("x-request-id") ?? "-";
  const reqLog = log.child({ requestId: reqId, method: c.req.method, path: c.req.path });
  reqLog.debug("http request started");
  try {
    await next();
    reqLog.info("http request completed", { status: c.res.status, latencyMs: Date.now() - started });
  } catch (e) {
    reqLog.error("http request failed", { latencyMs: Date.now() - started, ...sanitizeError(e) });
    throw e;
  }
});

app.onError((err, c) => {
  const reqId = c.req.header("x-request-id") ?? "-";
  log.error("unhandled app error", { requestId: reqId, path: c.req.path, ...sanitizeError(err) });
  return c.json({ error: { message: "Internal Server Error" } }, 500);
});

baseApp.get("/_health", (c) =>
  c.json({ ok: true, now: new Date().toISOString() })
);

if (config.basePath !== "/") {
  app.get("/", (c) => c.redirect(config.basePath, 302));
}

registerHomeAndDocsRoutes(baseApp, config, ctx);
registerStatusRoutes(baseApp, ctx, config);
registerAdminRestRoutes(baseApp, ctx);

baseApp.get("/models", (c) => modelsHandler(c, ctx));
baseApp.get("/v1/models", (c) => modelsHandler(c, ctx));
baseApp.post("/v1/chat/completions", (c) => chatCompletionsHandler(c, ctx));

serve({ fetch: app.fetch, port: config.port });
log.info("gateway listening", {
  port: config.port,
  basePath: config.basePath,
  configLoadMode: config.configLoadMode ?? "authoritative",
  logLevel: config.logLevel ?? "info"
});
