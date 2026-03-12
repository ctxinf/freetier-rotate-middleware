import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createAppContext } from "./svc/context.js";
import { chatCompletionsHandler } from "./v1/chat-completions.js";

const config = loadConfig();
const ctx = await createAppContext(config);

const app = new Hono();

app.get("/_health", (c) =>
  c.json({ ok: true, now: new Date().toISOString() })
);

app.post("/v1/chat/completions", (c) => chatCompletionsHandler(c, ctx));

serve({ fetch: app.fetch, port: config.port });
// eslint-disable-next-line no-console
console.log(`listening on :${config.port}`);

