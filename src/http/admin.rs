//! Admin REST API. Every config mutation goes through `ConfigStore::update`,
//! so an edit is validated, written to the TOML file, and published atomically —
//! there is no second copy of the config to drift out of sync.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::params;
use serde::Deserialize;
use std::sync::Arc;

use super::routes::json_error;
use crate::config::{Group, Limit, Upstream};
use crate::state::AppState;
use crate::storage::logs::{self, Prune};

fn ok_json(v: serde_json::Value) -> Response {
    Json(v).into_response()
}

fn bad_request(e: impl std::fmt::Display) -> Response {
    json_error(StatusCode::BAD_REQUEST, e.to_string())
}

pub fn get_config(s: &AppState) -> Response {
    match serde_json::to_value(&*s.config.snapshot()) {
        Ok(v) => ok_json(v),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn reload(s: &AppState) -> Response {
    match s.config.reload() {
        Ok(cfg) => ok_json(serde_json::json!({
            "ok": true,
            "upstreams": cfg.upstreams.len(),
            "groups": cfg.groups.len(),
        })),
        Err(e) => bad_request(e),
    }
}

pub fn put_server(s: &AppState, body: serde_json::Value) -> Response {
    let result = s.config.update(|cfg| {
        // Only the fields present in the request are touched; port and
        // database_path are deliberately not editable at runtime because
        // changing them would need a restart to take effect.
        if let Some(v) = body.get("upstream_base_url").and_then(|v| v.as_str()) {
            cfg.server.upstream_base_url = v.to_string();
        }
        if let Some(v) = body.get("log_level").and_then(|v| v.as_str()) {
            cfg.server.log_level = v.to_string();
        }
        // Accept the old spelling too, so an older UI build keeps working.
        if let Some(v) = body
            .get("path_prefix")
            .or_else(|| body.get("base_path"))
            .and_then(|v| v.as_str())
        {
            cfg.server.path_prefix = v.to_string();
        }
        if let Some(v) = body.get("timezone").and_then(|v| v.as_str()) {
            cfg.server.timezone = v.to_string();
        }
        Ok(())
    });
    match result {
        Ok(cfg) => ok_json(serde_json::to_value(&cfg.server).unwrap_or_default()),
        Err(e) => bad_request(e),
    }
}

pub fn list_upstreams(s: &AppState) -> Response {
    let cfg = s.config.snapshot();
    ok_json(serde_json::to_value(&cfg.upstreams).unwrap_or_default())
}

pub fn create_upstream(s: &AppState, body: serde_json::Value) -> Response {
    let up: Upstream = match serde_json::from_value(body) {
        Ok(u) => u,
        Err(e) => return bad_request(format!("invalid upstream: {e}")),
    };
    let result = s.config.update(|cfg| {
        if cfg.upstream(&up.model).is_some() {
            anyhow::bail!("upstream `{}` already exists", up.model);
        }
        cfg.upstreams.push(up.clone());
        Ok(())
    });
    match result {
        Ok(_) => ok_json(serde_json::json!({ "ok": true })),
        Err(e) => bad_request(e),
    }
}

pub fn update_upstream(s: &AppState, model: &str, body: serde_json::Value) -> Response {
    let result = s.config.update(|cfg| {
        let Some(up) = cfg.upstream_mut(model) else {
            anyhow::bail!("unknown upstream `{model}`");
        };
        if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) {
            up.enabled = v;
        }
        if let Some(v) = body.get("limits") {
            let limits: Vec<Limit> = serde_json::from_value(v.clone())
                .map_err(|e| anyhow::anyhow!("invalid limits: {e}"))?;
            up.limits = limits;
        }
        Ok(())
    });
    match result {
        Ok(cfg) => ok_json(serde_json::to_value(cfg.upstream(model)).unwrap_or_default()),
        Err(e) => bad_request(e),
    }
}

pub fn delete_upstream(s: &AppState, model: &str) -> Response {
    let result = s.config.update(|cfg| {
        // Refuse rather than silently leaving groups pointing at nothing;
        // validation would catch it anyway, but the message is clearer here.
        let referenced: Vec<&str> = cfg
            .groups
            .iter()
            .filter(|g| g.routes.iter().any(|r| r.upstream == model))
            .map(|g| g.entry_model.as_str())
            .collect();
        if !referenced.is_empty() {
            anyhow::bail!(
                "upstream `{model}` is still used by: {}",
                referenced.join(", ")
            );
        }
        let before = cfg.upstreams.len();
        cfg.upstreams.retain(|u| u.model != model);
        if cfg.upstreams.len() == before {
            anyhow::bail!("unknown upstream `{model}`");
        }
        Ok(())
    });
    match result {
        Ok(_) => ok_json(serde_json::json!({ "ok": true })),
        Err(e) => bad_request(e),
    }
}

pub fn list_groups(s: &AppState) -> Response {
    let cfg = s.config.snapshot();
    ok_json(serde_json::to_value(&cfg.groups).unwrap_or_default())
}

pub fn create_group(s: &AppState, body: serde_json::Value) -> Response {
    let group: Group = match serde_json::from_value(body) {
        Ok(g) => g,
        Err(e) => return bad_request(format!("invalid group: {e}")),
    };
    let result = s.config.update(|cfg| {
        if cfg.group(&group.entry_model).is_some() {
            anyhow::bail!("group `{}` already exists", group.entry_model);
        }
        cfg.groups.push(group.clone());
        Ok(())
    });
    match result {
        Ok(_) => ok_json(serde_json::json!({ "ok": true })),
        Err(e) => bad_request(e),
    }
}

pub fn update_group(s: &AppState, entry_model: &str, body: serde_json::Value) -> Response {
    let result = s.config.update(|cfg| {
        let Some(group) = cfg.group_mut(entry_model) else {
            anyhow::bail!("unknown group `{entry_model}`");
        };
        if let Some(v) = body.get("routes") {
            group.routes = serde_json::from_value(v.clone())
                .map_err(|e| anyhow::anyhow!("invalid routes: {e}"))?;
        }
        if let Some(v) = body.get("entry_model").and_then(|v| v.as_str()) {
            group.entry_model = v.to_string();
        }
        Ok(())
    });
    match result {
        Ok(_) => ok_json(serde_json::json!({ "ok": true })),
        Err(e) => bad_request(e),
    }
}

pub fn delete_group(s: &AppState, entry_model: &str) -> Response {
    let result = s.config.update(|cfg| {
        let before = cfg.groups.len();
        cfg.groups.retain(|g| g.entry_model != entry_model);
        if cfg.groups.len() == before {
            anyhow::bail!("unknown group `{entry_model}`");
        }
        Ok(())
    });
    match result {
        Ok(_) => ok_json(serde_json::json!({ "ok": true })),
        Err(e) => bad_request(e),
    }
}

/// Everything the frontend needs before it can render: where the API lives and
/// which clock timestamps should be shown in.
pub fn runtime(s: &AppState) -> Response {
    let cfg = s.config.snapshot();
    let now = chrono::Utc::now();
    ok_json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "path_prefix": cfg.server.normalized_prefix(),
        "clock": crate::clock::describe(&s.clock, now),
    }))
}

/// Live view: every upstream with its current counters and backoff state.
pub fn status(s: &AppState) -> Response {
    let cfg = s.config.snapshot();
    let now = chrono::Utc::now();

    let Ok(conn) = s.db.conn() else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable");
    };

    let mut upstreams = Vec::new();
    for up in &cfg.upstreams {
        let mut limits = Vec::new();
        for (idx, limit) in up.limits.iter().enumerate() {
            let entry = match limit {
                Limit::Frequency { count, period } => {
                    let midnight = crate::config::AnchorSpec {
                        time_of_day_secs: 0,
                        utc_offset_secs: s.clock.offset_secs(now),
                    };
                    let key = crate::limits::scoped_bucket_key(
                        &limit.identity(),
                        now,
                        period.as_secs(),
                        Some(midnight),
                    );
                    let used: i64 = conn
                        .query_row(
                            "SELECT used_count FROM quota_counters
                              WHERE upstream_id=?1 AND bucket_key=?2",
                            params![up.model, key],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    serde_json::json!({
                        "type": "frequency",
                        "used": used,
                        "limit": count.get(),
                        "period": period.to_string(),
                        "remaining": (count.get() as i64 - used).max(0),
                    })
                }
                Limit::Tokens {
                    count,
                    period,
                    weight,
                } => {
                    let midnight = crate::config::AnchorSpec {
                        time_of_day_secs: 0,
                        utc_offset_secs: s.clock.offset_secs(now),
                    };
                    let key = crate::limits::scoped_bucket_key(
                        &limit.identity(),
                        now,
                        period.as_secs(),
                        Some(midnight),
                    );
                    let used: f64 = conn
                        .query_row(
                            "SELECT used_weighted FROM quota_counters
                              WHERE upstream_id=?1 AND bucket_key=?2",
                            params![up.model, key],
                            |r| r.get(0),
                        )
                        .unwrap_or(0.0);
                    serde_json::json!({
                        "type": "tokens",
                        "used": used.round() as i64,
                        "limit": count.get(),
                        "period": period.to_string(),
                        "weighted": weight.is_some(),
                        "remaining": (count.get() as f64 - used).max(0.0).round() as i64,
                    })
                }
                Limit::TimeWindow { forbidden, days } => {
                    // Purely clock-driven: no counters to read, just whether
                    // the gateway's local time is inside a forbidden window.
                    let hit = s.limiter.forbidden_now(forbidden, days, now);
                    serde_json::json!({
                        "type": "time_window",
                        "forbidden": forbidden.iter().map(|r| r.to_string()).collect::<Vec<_>>(),
                        "days": days,
                        "blocked": hit.is_some(),
                        "window": hit.as_ref().map(|(w, _)| w.clone()),
                        "until_local": hit.as_ref().map(|(_, u)| u.clone()),
                    })
                }
                Limit::ErrorBackoff {
                    window, threshold, ..
                } => {
                    let row: Option<(Option<String>, i64)> = conn
                        .query_row(
                            "SELECT blocked_until, consecutive_trips FROM upstream_states
                              WHERE upstream_id=?1 AND limit_idx=?2",
                            params![up.model, idx as i64],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .ok();
                    let (blocked_until, trips) = row.unwrap_or((None, 0));
                    let now_s = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
                    let active = blocked_until
                        .as_deref()
                        .map(|b| b > now_s.as_str())
                        .unwrap_or(false);
                    serde_json::json!({
                        "type": "error_backoff",
                        "window": window,
                        "threshold": threshold,
                        "blocked": active,
                        "blocked_until": if active { blocked_until } else { None },
                        "consecutive_trips": trips,
                    })
                }
            };
            limits.push(entry);
        }

        upstreams.push(serde_json::json!({
            "model": up.model,
            "enabled": up.enabled,
            "limits": limits,
        }));
    }

    let recent: i64 = conn
        .query_row(
            "SELECT count(*) FROM request_logs
              WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    ok_json(serde_json::json!({
        "upstreams": upstreams,
        "groups": cfg.groups,
        "requests_last_hour": recent,
        "config_path": s.config.path().display().to_string(),
        "database_path": s.db.path().display().to_string(),
        "upstream_base_url": cfg.server.upstream_base_url,
        "path_prefix": if cfg.server.normalized_prefix().is_empty() {
            "/".to_string()
        } else {
            cfg.server.normalized_prefix()
        },
        "port": cfg.server.port,
        "clock": crate::clock::describe(&s.clock, now),
    }))
}

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    #[serde(default)]
    pub entry_model: Option<String>,
    #[serde(default)]
    pub upstream_model: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub error_kind: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
}

pub fn logs(s: &AppState, q: LogQuery) -> Response {
    if matches!(q.status, Some(code) if !(100..=599).contains(&code)) {
        return bad_request("status must be between 100 and 599");
    }
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1).saturating_mul(page_size);
    let parse_time = |value: Option<String>, field: &str| -> Result<Option<String>, String> {
        value
            .map(|v| {
                chrono::DateTime::parse_from_rfc3339(&v)
                    .map(|t| {
                        t.with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    })
                    .map_err(|_| format!("{field} must be an RFC 3339 timestamp"))
            })
            .transpose()
    };
    let from = match parse_time(q.from, "from") {
        Ok(v) => v,
        Err(e) => return bad_request(e),
    };
    let to = match parse_time(q.to, "to") {
        Ok(v) => v,
        Err(e) => return bad_request(e),
    };
    if matches!((&from, &to), (Some(a), Some(b)) if a > b) {
        return bad_request("from must not be later than to");
    }
    let Ok(conn) = s.db.conn() else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable");
    };

    let where_sql = r#" FROM request_logs
                  WHERE (?1 IS NULL OR entry_model = ?1)
                    AND (?2 IS NULL OR upstream_model = ?2)
                    AND (?3 IS NULL OR status = ?3)
                    AND (?4 IS NULL OR error_kind = ?4)
                    AND (?5 IS NULL OR created_at >= ?5)
                    AND (?6 IS NULL OR created_at <= ?6)"#;
    let total: i64 = match conn.query_row(
        &format!("SELECT count(*){where_sql}"),
        params![
            q.entry_model,
            q.upstream_model,
            q.status,
            q.error_kind,
            from,
            to
        ],
        |r| r.get(0),
    ) {
        Ok(n) => n,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let statuses: Vec<u16> = match conn
        .prepare(
            "SELECT DISTINCT status FROM request_logs WHERE status IS NOT NULL ORDER BY status",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(values) => values,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let error_kinds: Vec<String> = match conn
        .prepare(
            "SELECT DISTINCT error_kind FROM request_logs
             WHERE error_kind IS NOT NULL ORDER BY error_kind",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(values) => values,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let sql = r#"SELECT request_id, entry_model, upstream_id, upstream_model, status,
                        error_kind, prompt_tokens, completion_tokens, total_tokens,
                        latency_ms, created_at
                   FROM request_logs
                  WHERE (?1 IS NULL OR entry_model = ?1)
                    AND (?2 IS NULL OR upstream_model = ?2)
                    AND (?3 IS NULL OR status = ?3)
                    AND (?4 IS NULL OR error_kind = ?4)
                    AND (?5 IS NULL OR created_at >= ?5)
                    AND (?6 IS NULL OR created_at <= ?6)
                  ORDER BY created_at DESC LIMIT ?7 OFFSET ?8"#;
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let rows = stmt.query_map(
        params![
            q.entry_model,
            q.upstream_model,
            q.status,
            q.error_kind,
            from,
            to,
            page_size,
            offset
        ],
        |r| {
            Ok(serde_json::json!({
                "request_id": r.get::<_, String>(0)?,
                "entry_model": r.get::<_, Option<String>>(1)?,
                "upstream_id": r.get::<_, Option<String>>(2)?,
                "upstream_model": r.get::<_, Option<String>>(3)?,
                "status": r.get::<_, Option<i64>>(4)?,
                "error_kind": r.get::<_, Option<String>>(5)?,
                "prompt_tokens": r.get::<_, Option<i64>>(6)?,
                "completion_tokens": r.get::<_, Option<i64>>(7)?,
                "total_tokens": r.get::<_, Option<i64>>(8)?,
                "latency_ms": r.get::<_, Option<i64>>(9)?,
                "created_at": r.get::<_, String>(10)?,
            }))
        },
    );
    match rows.and_then(|r| r.collect::<Result<Vec<_>, _>>()) {
        Ok(items) => ok_json(serde_json::json!({
            "items": items,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": if total == 0 { 0 } else { (total + page_size - 1) / page_size },
            "statuses": statuses,
            "error_kinds": error_kinds,
        })),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct PruneQuery {
    #[serde(default)]
    pub hours: Option<i64>,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub keep: Option<i64>,
}

pub fn prune_logs(s: &AppState, q: PruneQuery) -> Response {
    let what = match (q.hours, q.days, q.keep) {
        (Some(h), _, _) => Prune::OlderThanHours(h),
        (_, Some(d), _) => Prune::OlderThanDays(d),
        (_, _, Some(k)) => Prune::KeepLatest(k),
        _ => return bad_request("specify one of: hours, days, keep"),
    };
    match logs::prune(&s.db, what) {
        Ok(n) => ok_json(serde_json::json!({ "deleted": n })),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn overview(s: &AppState, entry_model: &str) -> Response {
    match logs::overview(&s.db, entry_model) {
        Ok(ov) => ok_json(serde_json::to_value(ov).unwrap_or_default()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Kept for the `Arc<AppState>` handlers in `routes.rs`.
pub type SharedState = Arc<AppState>;
