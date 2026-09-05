//! Request-log writes and the aggregations the status page and MCP expose.

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use super::db::Db;

#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub prompt_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub request_id: String,
    pub entry_model: String,
    pub upstream_id: Option<String>,
    pub upstream_model: Option<String>,
    pub status: Option<u16>,
    pub error_kind: Option<String>,
    pub usage: Usage,
    pub latency_ms: Option<i64>,
}

pub fn record(db: &Db, e: &LogEntry) -> Result<()> {
    let conn = db.conn()?;
    conn.execute(
        r#"INSERT INTO request_logs
             (request_id, entry_model, upstream_id, upstream_model, status, error_kind,
              prompt_tokens, cached_tokens, completion_tokens, total_tokens, latency_ms, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(request_id) DO UPDATE SET
             upstream_id       = coalesce(excluded.upstream_id, upstream_id),
             upstream_model    = coalesce(excluded.upstream_model, upstream_model),
             status            = coalesce(excluded.status, status),
             error_kind        = coalesce(excluded.error_kind, error_kind),
             prompt_tokens     = coalesce(excluded.prompt_tokens, prompt_tokens),
             cached_tokens     = coalesce(excluded.cached_tokens, cached_tokens),
             completion_tokens = coalesce(excluded.completion_tokens, completion_tokens),
             total_tokens      = coalesce(excluded.total_tokens, total_tokens),
             latency_ms        = coalesce(excluded.latency_ms, latency_ms)"#,
        params![
            e.request_id,
            e.entry_model,
            e.upstream_id,
            e.upstream_model,
            e.status,
            e.error_kind,
            e.usage.prompt_tokens,
            e.usage.cached_tokens,
            e.usage.completion_tokens,
            e.usage.total_tokens,
            e.latency_ms,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct HourBucket {
    /// UTC hour, `YYYY-MM-DDTHH`.
    pub hour: String,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub success_rate: f64,
    pub total_tokens: i64,
    pub p50_latency_ms: Option<i64>,
    pub models: Vec<ModelStat>,
    pub failures: Vec<FailureStat>,
    /// Human-readable one-line summary of this hour.
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStat {
    pub upstream_id: String,
    pub upstream_model: String,
    pub total: i64,
    pub succeeded: i64,
    pub success_rate: f64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailureStat {
    pub reason: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Overview {
    pub entry_model: String,
    pub window_from: String,
    pub window_to: String,
    pub sampled_requests: i64,
    pub hours: Vec<HourBucket>,
    pub summary: String,
}

/// Rows considered by an overview: everything from the last day, or the last
/// 1000 calls if that reaches further back.
fn overview_rows(
    db: &Db,
    entry_model: &str,
) -> Result<
    Vec<(
        String,
        String,
        String,
        Option<u16>,
        Option<String>,
        i64,
        Option<i64>,
    )>,
> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare(
        r#"SELECT created_at,
                  coalesce(upstream_id, '-')    AS upstream_id,
                  coalesce(upstream_model, '-') AS upstream_model,
                  status,
                  error_kind,
                  coalesce(total_tokens, 0)     AS total_tokens,
                  latency_ms
             FROM request_logs
            WHERE entry_model = ?1
              AND (created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
                   OR request_id IN (
                     SELECT request_id FROM request_logs
                      WHERE entry_model = ?1
                      ORDER BY created_at DESC LIMIT 1000))
            ORDER BY created_at ASC"#,
    )?;
    let rows = stmt
        .query_map(params![entry_model], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<u16>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<i64>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn is_success(status: Option<u16>, error_kind: &Option<String>) -> bool {
    error_kind.is_none() && status.map(|s| (200..400).contains(&s)).unwrap_or(false)
}

fn failure_reason(status: Option<u16>, error_kind: &Option<String>) -> String {
    match (error_kind, status) {
        (Some(kind), Some(s)) => format!("{kind} ({s})"),
        (Some(kind), None) => kind.clone(),
        (None, Some(s)) => format!("HTTP {s}"),
        (None, None) => "unknown".into(),
    }
}

fn pct(num: i64, den: i64) -> f64 {
    if den == 0 {
        0.0
    } else {
        (num as f64 / den as f64 * 1000.0).round() / 10.0
    }
}

fn fmt_tokens(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// Per-hour rollup of recent traffic for one entry model, with a prose summary
/// per hour so an agent can read it without post-processing.
pub fn overview(db: &Db, entry_model: &str) -> Result<Overview> {
    use std::collections::BTreeMap;

    let rows = overview_rows(db, entry_model)?;
    let sampled = rows.len() as i64;

    struct Acc {
        total: i64,
        ok: i64,
        tokens: i64,
        latencies: Vec<i64>,
        per_model: BTreeMap<(String, String), (i64, i64, i64)>,
        failures: BTreeMap<String, i64>,
    }
    let mut buckets: BTreeMap<String, Acc> = BTreeMap::new();

    for (created_at, up_id, up_model, status, error_kind, tokens, latency) in &rows {
        // `2026-09-01T14:23:11.123Z` -> `2026-09-01T14`
        let hour = created_at.chars().take(13).collect::<String>();
        let acc = buckets.entry(hour).or_insert_with(|| Acc {
            total: 0,
            ok: 0,
            tokens: 0,
            latencies: Vec::new(),
            per_model: BTreeMap::new(),
            failures: BTreeMap::new(),
        });

        let ok = is_success(*status, error_kind);
        acc.total += 1;
        acc.tokens += tokens;
        if ok {
            acc.ok += 1;
        } else {
            *acc.failures
                .entry(failure_reason(*status, error_kind))
                .or_insert(0) += 1;
        }
        if let Some(ms) = latency {
            acc.latencies.push(*ms);
        }

        let m = acc
            .per_model
            .entry((up_id.clone(), up_model.clone()))
            .or_insert((0, 0, 0));
        m.0 += 1;
        if ok {
            m.1 += 1;
        }
        m.2 += tokens;
    }

    let hours: Vec<HourBucket> = buckets
        .into_iter()
        .map(|(hour, mut acc)| {
            acc.latencies.sort_unstable();
            let p50 = acc.latencies.get(acc.latencies.len() / 2).copied();

            let mut models: Vec<ModelStat> = acc
                .per_model
                .into_iter()
                .map(|((upstream_id, upstream_model), (total, ok, tokens))| ModelStat {
                    upstream_id,
                    upstream_model,
                    total,
                    succeeded: ok,
                    success_rate: pct(ok, total),
                    total_tokens: tokens,
                })
                .collect();
            models.sort_by(|a, b| b.total.cmp(&a.total));

            let mut failures: Vec<FailureStat> = acc
                .failures
                .into_iter()
                .map(|(reason, count)| FailureStat { reason, count })
                .collect();
            failures.sort_by(|a, b| b.count.cmp(&a.count));

            let failed = acc.total - acc.ok;
            let model_part = models
                .iter()
                .map(|m| format!("{} {}次 {:.0}%成功", m.upstream_id, m.total, m.success_rate))
                .collect::<Vec<_>>()
                .join("、");
            let failure_part = if failures.is_empty() {
                String::new()
            } else {
                format!(
                    "；失败原因 {}",
                    failures
                        .iter()
                        .map(|f| format!("{}×{}", f.reason, f.count))
                        .collect::<Vec<_>>()
                        .join("、")
                )
            };
            let latency_part = p50
                .map(|ms| format!("，中位延迟 {ms}ms"))
                .unwrap_or_default();

            let summary = format!(
                "{hour}:00 UTC 共 {} 次调用，成功率 {:.1}%（失败 {}），消耗 {} token{}。路由分布：{}{}",
                acc.total,
                pct(acc.ok, acc.total),
                failed,
                fmt_tokens(acc.tokens),
                latency_part,
                if model_part.is_empty() { "无".into() } else { model_part },
                failure_part
            );

            HourBucket {
                hour,
                total: acc.total,
                succeeded: acc.ok,
                failed,
                success_rate: pct(acc.ok, acc.total),
                total_tokens: acc.tokens,
                p50_latency_ms: p50,
                models,
                failures,
                summary,
            }
        })
        .collect();

    let total: i64 = hours.iter().map(|h| h.total).sum();
    let ok: i64 = hours.iter().map(|h| h.succeeded).sum();
    let tokens: i64 = hours.iter().map(|h| h.total_tokens).sum();
    let summary = if total == 0 {
        format!("entry model `{entry_model}` 在最近的窗口内没有调用记录。")
    } else {
        format!(
            "entry model `{entry_model}`：最近 {} 小时内共 {total} 次调用，总成功率 {:.1}%，累计消耗 {} token。",
            hours.len(),
            pct(ok, total),
            fmt_tokens(tokens)
        )
    };

    Ok(Overview {
        entry_model: entry_model.to_string(),
        window_from: rows.first().map(|r| r.0.clone()).unwrap_or_default(),
        window_to: rows.last().map(|r| r.0.clone()).unwrap_or_default(),
        sampled_requests: sampled,
        hours,
        summary,
    })
}

/// Retention options exposed by the admin API.
pub enum Prune {
    OlderThanHours(i64),
    OlderThanDays(i64),
    KeepLatest(i64),
}

pub fn prune(db: &Db, what: Prune) -> Result<usize> {
    let conn = db.conn()?;
    let n = match what {
        Prune::OlderThanHours(h) => conn.execute(
            "DELETE FROM request_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?1)",
            params![format!("-{h} hours")],
        )?,
        Prune::OlderThanDays(d) => conn.execute(
            "DELETE FROM request_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?1)",
            params![format!("-{d} days")],
        )?,
        Prune::KeepLatest(n) => conn.execute(
            "DELETE FROM request_logs WHERE request_id NOT IN
               (SELECT request_id FROM request_logs ORDER BY created_at DESC LIMIT ?1)",
            params![n],
        )?,
    };
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, up: &str, status: u16, tokens: i64) -> LogEntry {
        LogEntry {
            request_id: id.into(),
            entry_model: "group-free".into(),
            upstream_id: Some(up.into()),
            upstream_model: Some(format!("{up}-model")),
            status: Some(status),
            error_kind: None,
            usage: Usage {
                total_tokens: Some(tokens),
                ..Default::default()
            },
            latency_ms: Some(100),
        }
    }

    #[test]
    fn overview_aggregates_success_and_failures() {
        let db = Db::open_in_memory().unwrap();
        record(&db, &entry("a", "up1", 200, 100)).unwrap();
        record(&db, &entry("b", "up1", 200, 200)).unwrap();
        record(&db, &entry("c", "up1", 429, 0)).unwrap();
        record(&db, &entry("d", "up2", 200, 50)).unwrap();

        let ov = overview(&db, "group-free").unwrap();
        assert_eq!(ov.sampled_requests, 4);
        let h = &ov.hours[0];
        assert_eq!(h.total, 4);
        assert_eq!(h.succeeded, 3);
        assert_eq!(h.failed, 1);
        assert_eq!(h.success_rate, 75.0);
        assert_eq!(h.total_tokens, 350);
        assert_eq!(h.failures[0].reason, "HTTP 429");
        // Busiest upstream first.
        assert_eq!(h.models[0].upstream_id, "up1");
        assert!(h.summary.contains("成功率 75.0%"), "got: {}", h.summary);
    }

    #[test]
    fn overview_of_unknown_entry_model_is_empty_not_an_error() {
        let db = Db::open_in_memory().unwrap();
        let ov = overview(&db, "nope").unwrap();
        assert_eq!(ov.sampled_requests, 0);
        assert!(ov.hours.is_empty());
        assert!(ov.summary.contains("没有调用记录"));
    }

    #[test]
    fn record_upserts_usage_arriving_after_the_response() {
        let db = Db::open_in_memory().unwrap();
        // The proxy logs the status first, then usage once the stream ends.
        record(
            &db,
            &LogEntry {
                request_id: "x".into(),
                entry_model: "g".into(),
                upstream_id: Some("u".into()),
                upstream_model: Some("m".into()),
                status: Some(200),
                error_kind: None,
                usage: Usage::default(),
                latency_ms: Some(10),
            },
        )
        .unwrap();
        record(
            &db,
            &LogEntry {
                request_id: "x".into(),
                entry_model: "g".into(),
                upstream_id: None,
                upstream_model: None,
                status: None,
                error_kind: None,
                usage: Usage {
                    total_tokens: Some(999),
                    ..Default::default()
                },
                latency_ms: None,
            },
        )
        .unwrap();

        let conn = db.conn().unwrap();
        let (status, tokens): (i64, i64) = conn
            .query_row(
                "SELECT status, total_tokens FROM request_logs WHERE request_id='x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // The late usage write must not clobber the earlier status.
        assert_eq!(status, 200);
        assert_eq!(tokens, 999);
    }

    #[test]
    fn prune_keeps_only_the_latest_n() {
        let db = Db::open_in_memory().unwrap();
        for i in 0..10 {
            record(&db, &entry(&format!("r{i}"), "up", 200, 1)).unwrap();
        }
        prune(&db, Prune::KeepLatest(3)).unwrap();
        let conn = db.conn().unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM request_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }
}
