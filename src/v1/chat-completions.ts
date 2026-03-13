import type { Context } from "hono";
import { nanoid } from "../x/nanoid.js";
import type { AppContext } from "../svc/context.js";
import { proxyChatCompletions } from "../svc/proxy.js";

export async function chatCompletionsHandler(
  c: Context,
  app: AppContext
): Promise<Response> {
  const requestId = nanoid();

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const entryModel = body?.model;
  if (typeof entryModel !== "string" || !entryModel) {
    return c.json({ error: { message: "Missing body.model" } }, 400);
  }

  return proxyChatCompletions({
    app,
    requestId,
    clientReq: c.req.raw,
    clientBody: body,
    entryModel
  });
}
