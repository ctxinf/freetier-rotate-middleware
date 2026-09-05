use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

use freetier_rotate_middleware::clock::LocalClock;
use freetier_rotate_middleware::config::{normalize_prefix, ConfigStore};
use freetier_rotate_middleware::http;
use freetier_rotate_middleware::state::AppState;
use freetier_rotate_middleware::storage::Db;

#[tokio::main]
async fn main() -> Result<()> {
    let config_path = std::env::var("CONFIG_PATH").unwrap_or_else(|_| "./config.toml".into());
    let store = ConfigStore::load(&config_path)
        .with_context(|| format!("failed to load config from {config_path}"))?;

    let cfg = store.snapshot();
    // RUST_LOG wins so a debug session does not need a config edit.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "freetier_rotate_middleware={},access=info",
            cfg.server.log_level
        ))
    });
    tracing_subscriber::fmt().with_env_filter(filter).init();

    // Resolved once, at startup: every time-window limit and every timestamp
    // the UI renders is read against this one clock.
    let clock = LocalClock::resolve(&cfg.server.timezone).map_err(|e| anyhow::anyhow!(e))?;

    let db_path =
        std::env::var("DATABASE_PATH").unwrap_or_else(|_| cfg.server.database_path.clone());
    let db = Db::open(&db_path)?;

    let port: u16 = match std::env::var("PORT") {
        Ok(v) => v.parse().context("PORT must be a number")?,
        Err(_) => cfg.server.port,
    };
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./static".into());
    // The env override exists so a container can be re-homed without editing
    // the mounted config file.
    let prefix = match std::env::var("PATH_PREFIX").or_else(|_| std::env::var("BASE_PATH")) {
        Ok(v) => normalize_prefix(&v),
        Err(_) => cfg.server.normalized_prefix(),
    };

    let state = AppState::new(store, db, clock.clone())?;
    let app = build_app(state.clone(), &prefix, &static_dir);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let web_url = format!("http://127.0.0.1:{port}{}/", prefix.trim_end_matches('/'));
    info!(
        %addr,
        config = %config_path,
        path_prefix = if prefix.is_empty() { "/" } else { prefix.as_str() },
        timezone = %clock.name(),
        timezone_source = clock.source(),
        local_time = %clock.format_local(chrono::Utc::now()),
        upstreams = cfg.upstreams.len(),
        groups = cfg.groups.len(),
        "freetier-rotate-middleware v2 listening — open  {web_url}  "
    );

    axum::serve(listener, app).await?;
    Ok(())
}

/// Mounts everything — UI, admin API, `/v1/*` and `/mcp` — under one prefix, so
/// the gateway can sit behind a proxy on a sub-path without any rewriting.
///
/// The un-prefixed paths are deliberately *not* also served: one canonical
/// location keeps the UI's relative API calls unambiguous.
fn build_app(state: Arc<AppState>, prefix: &str, static_dir: &str) -> axum::Router {
    let router = http::build_router(state, static_dir);
    if prefix.is_empty() {
        return router;
    }

    // `nest` maps a bare `/gw` onto the nested root but not `/gw/`, which a
    // browser following the UI's own links will ask for. The trailing-slash
    // form is also the one relative `api/...` URLs resolve correctly from, so
    // it is made canonical here: `/gw` redirects to `/gw/`, and `/gw/` is
    // nested in its own right.
    let canonical = format!("{prefix}/");
    let redirect_target = canonical.clone();
    axum::Router::new().nest(&canonical, router).route(
        prefix,
        axum::routing::get(move || {
            let target = redirect_target.clone();
            async move { axum::response::Redirect::permanent(&target) }
        }),
    )
}
