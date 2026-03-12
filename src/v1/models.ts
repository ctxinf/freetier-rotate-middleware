import type { Context } from "hono";
import type { AppContext } from "../svc/context.js";

type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

type OpenAIListModelsResponse = {
  object: "list";
  data: OpenAIModel[];
};

export async function modelsHandler(c: Context, app: AppContext): Promise<Response> {
  const rowsRes = await app.db.raw.execute(
    "SELECT DISTINCT public_model AS id FROM route_items WHERE enabled = 1 ORDER BY public_model ASC"
  );
  const rows = ((rowsRes?.rows as any[]) ?? []) as Array<{ id: string }>;

  const created = Math.floor(Date.now() / 1000);
  const data: OpenAIModel[] = rows
    .map((r) => r.id)
    .filter((id) => typeof id === "string" && id.length > 0)
    .map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "my-ai-gateway"
    }));

  const res: OpenAIListModelsResponse = { object: "list", data };
  c.header("cache-control", "no-store");
  return c.json(res);
}
