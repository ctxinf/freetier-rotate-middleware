//! HTTP surface: the OpenAI-compatible API, the admin REST API, the MCP
//! endpoint, and the static single-page UI.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router as AxumRouter};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use crate::state::AppState;
use crate::svc::proxy;

/// The UI is served from the same prefix as the API, so a page loaded at
/// `/gw/` reaches `/gw/api/...` with a relative URL and needs no build-time
/// configuration of its own.
pub fn build_router(state: Arc<AppState>, static_dir: &str) -> AxumRouter {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api = AxumRouter::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/models", get(list_models))
        // Config: read, then targeted edits that write straight back to the
        // TOML file with comments preserved.
        .route("/api/config", get(admin_get_config))
        .route("/api/config/reload", post(admin_reload))
        .route("/api/config/server", put(admin_put_server))
        .route(
            "/api/upstreams",
            get(admin_list_upstreams).post(admin_create_upstream),
        )
        .route(
            "/api/upstreams/:id",
            put(admin_update_upstream).delete(admin_delete_upstream),
        )
        .route(
            "/api/groups",
            get(admin_list_groups).post(admin_create_group),
        )
        .route(
            "/api/groups/:entry_model",
            put(admin_update_group).delete(admin_delete_group),
        )
        // Observability.
        .route("/api/runtime", get(admin_runtime))
        .route("/api/status", get(admin_status))
        .route("/api/logs", get(admin_logs))
        .route("/api/logs", delete(admin_prune_logs))
        .route("/api/overview/:entry_model", get(admin_overview))
        // MCP: one JSON-RPC endpoint agents can attach to directly.
        .route("/mcp", post(mcp_handler))
        .with_state(state);

    // `ServeDir` alone does not answer the router's own root (it sees an empty
    // path, not a directory), which is exactly where the UI lives — both at `/`
    // and, when nested, at `/<prefix>/`. Serving index.html there explicitly
    // covers both without special-casing the prefix.
    // Both spellings must work: `nest` maps a bare `/gw` onto `/` here, while a
    // browser that follows the UI's own links asks for `/gw/`, which arrives as
    // `//`. Relative API URLs resolve differently for the two, so the page is
    // pinned to the trailing-slash form and `/` redirects to it.
    // `ServeDir` does not answer the router's own root — it sees an empty path
    // rather than a directory — and that root is exactly where the UI lives.
    // Serving index.html there explicitly covers `/` when unprefixed and, via
    // the nest in `build_app`, `/<prefix>` too. Read per request so editing
    // `static/` needs no restart.
    let index_path = format!("{}/index.html", static_dir.trim_end_matches('/'));
    api.route("/", get(move || serve_index(index_path.clone())))
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true))
        .layer(cors)
}

async fn serve_index(path: String) -> Response {
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [
                (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (axum::http::header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot read {path}: {e}"),
        ),
    }
}

async fn chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    proxy::chat_completions(state, headers, body).await
}

/// The entry models this gateway exposes, in OpenAI's `/v1/models` shape.
async fn list_models(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cfg = state.config.snapshot();
    let data: Vec<_> = cfg
        .groups
        .iter()
        .map(|g| {
            serde_json::json!({
                "id": g.entry_model,
                "object": "model",
                "owned_by": "freetier-rotate-middleware",
                "created": 0,
            })
        })
        .collect();
    Json(serde_json::json!({ "object": "list", "data": data }))
}

// --- admin handlers: thin wrappers so routing stays readable ---------------

use super::admin;

async fn admin_get_config(State(s): State<Arc<AppState>>) -> Response {
    admin::get_config(&s)
}
async fn admin_reload(State(s): State<Arc<AppState>>) -> Response {
    admin::reload(&s)
}
async fn admin_put_server(
    State(s): State<Arc<AppState>>,
    Json(b): Json<serde_json::Value>,
) -> Response {
    admin::put_server(&s, b)
}
async fn admin_list_upstreams(State(s): State<Arc<AppState>>) -> Response {
    admin::list_upstreams(&s)
}
async fn admin_create_upstream(
    State(s): State<Arc<AppState>>,
    Json(b): Json<serde_json::Value>,
) -> Response {
    admin::create_upstream(&s, b)
}
async fn admin_update_upstream(
    State(s): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(b): Json<serde_json::Value>,
) -> Response {
    admin::update_upstream(&s, &id, b)
}
async fn admin_delete_upstream(
    State(s): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    admin::delete_upstream(&s, &id)
}
async fn admin_list_groups(State(s): State<Arc<AppState>>) -> Response {
    admin::list_groups(&s)
}
async fn admin_create_group(
    State(s): State<Arc<AppState>>,
    Json(b): Json<serde_json::Value>,
) -> Response {
    admin::create_group(&s, b)
}
async fn admin_update_group(
    State(s): State<Arc<AppState>>,
    axum::extract::Path(entry): axum::extract::Path<String>,
    Json(b): Json<serde_json::Value>,
) -> Response {
    admin::update_group(&s, &entry, b)
}
async fn admin_delete_group(
    State(s): State<Arc<AppState>>,
    axum::extract::Path(entry): axum::extract::Path<String>,
) -> Response {
    admin::delete_group(&s, &entry)
}
async fn admin_status(State(s): State<Arc<AppState>>) -> Response {
    admin::status(&s)
}
async fn admin_runtime(State(s): State<Arc<AppState>>) -> Response {
    admin::runtime(&s)
}
async fn admin_logs(
    State(s): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<admin::LogQuery>,
) -> Response {
    admin::logs(&s, q)
}
async fn admin_prune_logs(
    State(s): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<admin::PruneQuery>,
) -> Response {
    admin::prune_logs(&s, q)
}
async fn admin_overview(
    State(s): State<Arc<AppState>>,
    axum::extract::Path(entry): axum::extract::Path<String>,
) -> Response {
    admin::overview(&s, &entry)
}

async fn mcp_handler(
    State(s): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    super::mcp::handle(&s, body)
}

pub fn json_error(status: StatusCode, message: impl AsRef<str>) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": { "message": message.as_ref() } })),
    )
        .into_response()
}
