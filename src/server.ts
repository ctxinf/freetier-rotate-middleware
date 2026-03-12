import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createAppContext } from "./svc/context.js";
import { chatCompletionsHandler } from "./v1/chat-completions.js";
import { registerStatusRoutes } from "./pages/page_status.js";
import { modelsHandler } from "./v1/models.js";

const config = loadConfig();
const ctx = await createAppContext(config);

const app = new Hono();

app.get("/_health", (c) =>
  c.json({ ok: true, now: new Date().toISOString() })
);

registerStatusRoutes(app, ctx, config);

app.get("/models", (c) => modelsHandler(c, ctx));
app.get("/v1/models", (c) => modelsHandler(c, ctx));
app.post("/v1/chat/completions", (c) => chatCompletionsHandler(c, ctx));

serve({ fetch: app.fetch, port: config.port });
// eslint-disable-next-line no-console
console.log(`listening on :${config.port}`);
