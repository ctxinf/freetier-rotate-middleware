import type { Hono } from "hono";
import type { AppConfig } from "../config.js";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withBasePath(basePath: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (basePath === "/") return normalized;
  return `${basePath}${normalized}`;
}

function buildOpenApiSpec(basePath: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "my-ai-gateway API",
      version: "0.1.0",
      description: "OpenAI-compatible gateway with custom route and quota strategies."
    },
    servers: [{ url: basePath === "/" ? "/" : basePath }],
    tags: [
      { name: "Gateway" },
      { name: "Status" },
      { name: "Admin" }
    ],
    paths: {
      "/_health": {
        get: { tags: ["Status"], summary: "Health check" }
      },
      "/_status": {
        get: { tags: ["Status"], summary: "Status dashboard page" }
      },
      "/_status/json": {
        get: { tags: ["Status"], summary: "Status JSON payload" }
      },
      "/models": {
        get: { tags: ["Gateway"], summary: "List available models" }
      },
      "/v1/models": {
        get: { tags: ["Gateway"], summary: "OpenAI-compatible model list" }
      },
      "/v1/chat/completions": {
        post: {
          tags: ["Gateway"],
          summary: "OpenAI-compatible chat completions proxy",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: {
            "200": {
              description: "Success (JSON or SSE stream depending on request)"
            }
          }
        }
      },
      "/admin/routes": {
        get: { tags: ["Admin"], summary: "List route items" },
        post: { tags: ["Admin"], summary: "Create route item" }
      },
      "/admin/routes/{id}": {
        get: { tags: ["Admin"], summary: "Get route item by id" },
        put: { tags: ["Admin"], summary: "Update route item by id" },
        delete: { tags: ["Admin"], summary: "Delete route item by id" }
      },
      "/admin/request-logs/cleanup": {
        post: { tags: ["Admin"], summary: "Cleanup request logs by options" }
      },
      "/admin/request-logs": {
        delete: { tags: ["Admin"], summary: "Cleanup request logs by options" }
      },
      "/admin/settings/upstream-base-url": {
        get: { tags: ["Admin"], summary: "Get runtime upstream base URL" },
        put: { tags: ["Admin"], summary: "Set runtime upstream base URL" }
      }
    }
  };
}

export function registerHomeAndDocsRoutes(app: Hono, config: AppConfig): void {
  app.get("/", (c) => {
    const docsPath = withBasePath(config.basePath, "/docs");
    const statusPath = withBasePath(config.basePath, "/_status");
    const chatPath = withBasePath(config.basePath, "/v1/chat/completions");
    const modelsPath = withBasePath(config.basePath, "/v1/models");
    const docsPathEscaped = escapeHtml(docsPath);
    const statusPathEscaped = escapeHtml(statusPath);
    const chatPathEscaped = escapeHtml(chatPath);
    const modelsPathEscaped = escapeHtml(modelsPath);
    const basePathEscaped = escapeHtml(config.basePath);

    const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>my-ai-gateway</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; line-height: 1.5; color: #1d1d1f; }
      h1 { margin: 0 0 8px 0; }
      p { margin: 0 0 12px 0; max-width: 880px; }
      .hint { color: #555; font-size: 14px; }
      ul { margin: 12px 0 0 18px; }
      code { background: #f4f4f5; padding: 2px 5px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Welcome to my-ai-gateway</h1>
    <p>
      This gateway provides an OpenAI-compatible Chat Completions entrypoint with customizable model routing,
      quota/usage controls, and admin APIs for runtime operations.
    </p>
    <p class="hint">Current basePath: <code>${basePathEscaped}</code></p>
    <ul>
      <li>API docs: <a href="${docsPathEscaped}">${docsPathEscaped}</a></li>
      <li>Status page: <a href="${statusPathEscaped}">${statusPathEscaped}</a></li>
      <li>Models API: <code>GET ${modelsPathEscaped}</code></li>
      <li>Chat API: <code>POST ${chatPathEscaped}</code></li>
    </ul>
  </body>
</html>`;

    return c.html(body);
  });

  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec(config.basePath)));

  app.get("/docs", (c) => {
    const specUrl = withBasePath(config.basePath, "/openapi.json");
    const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>my-ai-gateway docs</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    </script>
  </body>
</html>`;
    return c.html(body);
  });
}
