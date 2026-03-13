import type { Context } from "hono";
import { createLogger } from "../logging.js";
import { nanoid } from "../x/nanoid.js";
import type { AppContext } from "../svc/context.js";
import { proxyChatCompletions } from "../svc/proxy.js";

const log = createLogger("v1.chat_completions");

export async function chatCompletionsHandler(
  c: Context,
  app: AppContext
): Promise<Response> {
  const requestId = nanoid();
  const requestLog = log.child({ requestId });
  c.req.raw.signal.addEventListener("abort", () => {
    requestLog.warn("client disconnected");
  }, { once: true });

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    requestLog.warn("invalid json body");
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const entryModel = body?.model;
  if (typeof entryModel !== "string" || !entryModel) {
    requestLog.warn("missing body.model");
    return c.json({ error: { message: "Missing body.model" } }, 400);
  }

  requestLog.debug("dispatching proxy request", { entryModel });
  return proxyChatCompletions({
    app,
    requestId,
    clientReq: c.req.raw,
    clientBody: body,
    entryModel
  });
}
