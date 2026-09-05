//! Shared application state.

use anyhow::Result;
use std::sync::Arc;

use crate::clock::LocalClock;
use crate::config::ConfigStore;
use crate::limits::Limiter;
use crate::storage::Db;
use crate::svc::router::Router;

pub struct AppState {
    pub config: ConfigStore,
    pub db: Db,
    /// Resolved once at startup so every part of the process agrees on what
    /// "local time" means.
    pub clock: LocalClock,
    pub limiter: Limiter,
    pub router: Router,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(config: ConfigStore, db: Db, clock: LocalClock) -> Result<Arc<Self>> {
        let http = reqwest::Client::builder()
            // No overall timeout: a long generation is not a failure. The
            // connect timeout still catches an upstream that is simply down.
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()?;

        Ok(Arc::new(Self {
            limiter: Limiter::new(db.clone(), clock.clone()),
            router: Router::new(),
            config,
            db,
            clock,
            http,
        }))
    }
}
