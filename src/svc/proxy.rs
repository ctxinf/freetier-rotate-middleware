//! The request path: pick a candidate, forward, fail over, account for usage.

use anyhow::Result;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use chrono::Utc;
use futures::StreamExt;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::config::Upstream;
use crate::limits::Grant;
use crate::state::AppState;
use crate::storage::logs::{self, LogEntry, Usage};
use crate::svc::sse::{parse_usage, UsageCollector};

/// What to do after trying one candidate.
enum Attempt {
    Done(Response),
    /// This candidate is unusable; try the next one.
    Next(&'static str),
}

pub async fn chat_completions(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: serde_json::Value,
) -> Response {
    let request_id = nanoid::nanoid!(16);
    let cfg = state.config.snapshot();

    let entry_model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    if entry_model.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "missing `model` in request body");
    }

    if cfg.group(&entry_model).is_none() {
        log_terminal(&state, &request_id, &entry_model, 404, "model_not_found");
        return error_response(
            StatusCode::NOT_FOUND,
            &format!("unknown model `{entry_model}`"),
        );
    }

    let stream = wants_stream(&body, &headers);
    let candidates = state.router.candidates(&cfg, &entry_model);
    debug!(
        request_id,
        entry_model,
        stream,
        candidates = candidates.len(),
        "request accepted"
    );

    if candidates.is_empty() {
        log_terminal(&state, &request_id, &entry_model, 503, "no_candidates");
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("no enabled upstreams for `{entry_model}`"),
        );
    }

    let mut saw_upstream_failure = false;
    let mut last_denial: Option<String> = None;

    for upstream in candidates {
        match try_candidate(
            &state,
            &request_id,
            &entry_model,
            upstream,
            &headers,
            &body,
            stream,
        )
        .await
        {
            Ok(Attempt::Done(res)) => return res,
            Ok(Attempt::Next(why)) => {
                if why == "quota" {
                    last_denial = Some(why.to_string());
                } else {
                    saw_upstream_failure = true;
                }
            }
            Err(e) => {
                warn!(request_id, upstream = upstream.model, error = %e, "candidate failed unexpectedly");
                saw_upstream_failure = true;
            }
        }
    }

    let (status, msg) = if saw_upstream_failure {
        (StatusCode::BAD_GATEWAY, "all upstreams failed")
    } else if last_denial.is_some() {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "all upstreams are rate limited",
        )
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "no upstream was available")
    };
    log_terminal(
        &state,
        &request_id,
        &entry_model,
        status.as_u16(),
        "exhausted",
    );
    error_response(status, msg)
}

async fn try_candidate(
    state: &Arc<AppState>,
    request_id: &str,
    entry_model: &str,
    upstream: &Upstream,
    headers: &HeaderMap,
    body: &serde_json::Value,
    stream: bool,
) -> Result<Attempt> {
    let now = Utc::now();
    let grant = match state.limiter.acquire(upstream, now)? {
        Ok(g) => g,
        Err(denied) => {
            debug!(
                request_id,
                upstream = upstream.model,
                reason = denied.reason(),
                "candidate skipped"
            );
            return Ok(Attempt::Next("quota"));
        }
    };

    let mut upstream_body = body.clone();
    upstream_body["model"] = serde_json::Value::String(upstream.model.clone());

    let url = join_url(
        &state.config.snapshot().server.upstream_base_url,
        "/v1/chat/completions",
    );
    let started = std::time::Instant::now();

    let res = state
        .http
        .post(&url)
        .headers(forwarded_headers(headers, request_id))
        .json(&upstream_body)
        .send()
        .await;

    let res = match res {
        Ok(r) => r,
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else {
                "upstream_error"
            };
            warn!(request_id, upstream = upstream.model, error = %e, "upstream request failed");
            settle(state, upstream, &grant, None, None, Some(kind), now);
            record(
                state,
                LogEntry {
                    request_id: request_id.into(),
                    entry_model: entry_model.into(),
                    upstream_id: Some(upstream.model.clone()),
                    upstream_model: Some(upstream.model.clone()),
                    status: Some(502),
                    error_kind: Some(kind.into()),
                    usage: Usage::default(),
                    latency_ms: Some(started.elapsed().as_millis() as i64),
                },
            );
            return Ok(Attempt::Next(kind));
        }
    };

    let status = res.status();
    let first_byte_ms = started.elapsed().as_millis() as i64;

    // 429 and 5xx indicate an upstream worth failing over from. Other 4xx
    // responses describe the client's request and must be returned unchanged.
    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        warn!(
            request_id,
            upstream = upstream.model,
            status = status.as_u16(),
            "retryable upstream status"
        );
        settle(
            state,
            upstream,
            &grant,
            None,
            Some(status.as_u16()),
            None,
            now,
        );
        record(
            state,
            LogEntry {
                request_id: request_id.into(),
                entry_model: entry_model.into(),
                upstream_id: Some(upstream.model.clone()),
                upstream_model: Some(upstream.model.clone()),
                status: Some(status.as_u16()),
                error_kind: None,
                usage: Usage::default(),
                latency_ms: Some(first_byte_ms),
            },
        );
        return Ok(Attempt::Next("upstream_status"));
    }

    let response_headers = passthrough_headers(res.headers());

    if !stream {
        let bytes = res.bytes().await.unwrap_or_default();
        let usage = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| parse_usage(&v));

        settle(
            state,
            upstream,
            &grant,
            usage.as_ref(),
            Some(status.as_u16()),
            None,
            now,
        );
        record(
            state,
            LogEntry {
                request_id: request_id.into(),
                entry_model: entry_model.into(),
                upstream_id: Some(upstream.model.clone()),
                upstream_model: Some(upstream.model.clone()),
                status: Some(status.as_u16()),
                error_kind: None,
                usage: usage.clone().unwrap_or_default(),
                latency_ms: Some(started.elapsed().as_millis() as i64),
            },
        );
        access_log(
            entry_model,
            upstream,
            status.as_u16(),
            first_byte_ms,
            usage.as_ref(),
        );

        let mut out = Response::new(Body::from(bytes));
        *out.status_mut() = status;
        *out.headers_mut() = response_headers;
        return Ok(Attempt::Done(out));
    }

    // Streaming: bytes go straight to the client and usage is accumulated as
    // they pass, so accounting costs no added latency.
    let state2 = state.clone();
    let upstream2 = upstream.clone();
    let request_id2 = request_id.to_string();
    let entry_model2 = entry_model.to_string();
    let status_code = status.as_u16();

    let mut collector = UsageCollector::new();
    let mut upstream_stream = res.bytes_stream();

    let body_stream = async_stream::stream! {
        let mut errored = false;
        while let Some(item) = upstream_stream.next().await {
            match item {
                Ok(chunk) => {
                    collector.push(&chunk);
                    yield Ok::<Bytes, std::io::Error>(chunk);
                }
                Err(e) => {
                    warn!(request_id = request_id2, error = %e, "stream interrupted");
                    errored = true;
                    break;
                }
            }
        }

        let usage = collector.finish();
        let error_kind = errored.then_some("stream_error");
        settle(
            &state2,
            &upstream2,
            &grant,
            usage.as_ref(),
            Some(status_code),
            error_kind,
            now,
        );
        record(
            &state2,
            LogEntry {
                request_id: request_id2.clone(),
                entry_model: entry_model2.clone(),
                upstream_id: Some(upstream2.model.clone()),
                upstream_model: Some(upstream2.model.clone()),
                status: Some(status_code),
                error_kind: error_kind.map(Into::into),
                usage: usage.clone().unwrap_or_default(),
                latency_ms: Some(started.elapsed().as_millis() as i64),
            },
        );
        access_log(&entry_model2, &upstream2, status_code, first_byte_ms, usage.as_ref());
    };

    let mut out = Response::new(Body::from_stream(body_stream));
    *out.status_mut() = status;
    *out.headers_mut() = response_headers;
    Ok(Attempt::Done(out))
}

fn settle(
    state: &AppState,
    upstream: &Upstream,
    grant: &Grant,
    usage: Option<&Usage>,
    status: Option<u16>,
    error_kind: Option<&str>,
    now: chrono::DateTime<Utc>,
) {
    if let Err(e) = state
        .limiter
        .finalize(upstream, grant, usage, status, error_kind, now)
    {
        warn!(upstream = upstream.model, error = %e, "failed to settle quota");
    }
}

fn record(state: &AppState, entry: LogEntry) {
    if let Err(e) = logs::record(&state.db, &entry) {
        warn!(error = %e, "failed to write request log");
    }
}

fn log_terminal(state: &AppState, request_id: &str, entry_model: &str, status: u16, kind: &str) {
    record(
        state,
        LogEntry {
            request_id: request_id.into(),
            entry_model: entry_model.into(),
            upstream_id: None,
            upstream_model: None,
            status: Some(status),
            error_kind: Some(kind.into()),
            usage: Usage::default(),
            latency_ms: None,
        },
    );
}

fn access_log(
    entry_model: &str,
    upstream: &Upstream,
    status: u16,
    ttfb_ms: i64,
    usage: Option<&Usage>,
) {
    let up = usage.and_then(|u| u.prompt_tokens).unwrap_or(0);
    let down = usage.and_then(|u| u.completion_tokens).unwrap_or(0);
    info!(
        target: "access",
        "[{entry_model}]->[{}] {status} {:.3}s {up}↑ {down}↓",
        upstream.model,
        ttfb_ms as f64 / 1000.0
    );
}

fn wants_stream(body: &serde_json::Value, headers: &HeaderMap) -> bool {
    if body.get("stream").and_then(|s| s.as_bool()) == Some(true) {
        return true;
    }
    headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false)
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Headers passed upstream. Authorization is forwarded verbatim — this gateway
/// deliberately does not manage upstream credentials.
fn forwarded_headers(incoming: &HeaderMap, request_id: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Ok(v) = HeaderValue::from_str(request_id) {
        h.insert(HeaderName::from_static("x-request-id"), v);
    }
    for name in ["authorization", "openai-organization", "openai-project"] {
        if let Some(v) = incoming.get(name) {
            if let Ok(name) = HeaderName::try_from(name) {
                h.insert(name, v.clone());
            }
        }
    }
    h
}

/// Only headers that describe the body are echoed back; hop-by-hop headers and
/// upstream-specific ones are dropped.
fn passthrough_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut h = HeaderMap::new();
    for name in ["content-type", "cache-control", "x-request-id"] {
        if let Some(v) = upstream.get(name) {
            if let Ok(name) = HeaderName::try_from(name) {
                h.insert(name, v.clone());
            }
        }
    }
    h
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({
            "error": { "message": message, "type": "gateway_error" }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_detected_from_body_or_accept_header() {
        let empty = HeaderMap::new();
        assert!(wants_stream(&serde_json::json!({"stream": true}), &empty));
        assert!(!wants_stream(&serde_json::json!({"stream": false}), &empty));
        assert!(!wants_stream(&serde_json::json!({}), &empty));

        let mut sse = HeaderMap::new();
        sse.insert(
            axum::http::header::ACCEPT,
            HeaderValue::from_static("text/event-stream"),
        );
        assert!(wants_stream(&serde_json::json!({}), &sse));
    }

    #[test]
    fn urls_join_without_doubling_slashes() {
        assert_eq!(
            join_url("http://x:3000", "/v1/chat/completions"),
            "http://x:3000/v1/chat/completions"
        );
        assert_eq!(
            join_url("http://x:3000/", "/v1/chat/completions"),
            "http://x:3000/v1/chat/completions"
        );
        // A base with a path prefix keeps it.
        assert_eq!(
            join_url("http://x/api/", "v1/chat/completions"),
            "http://x/api/v1/chat/completions"
        );
    }

    #[test]
    fn authorization_is_forwarded_but_cookies_are_not() {
        let mut incoming = HeaderMap::new();
        incoming.insert("authorization", HeaderValue::from_static("Bearer sk-test"));
        incoming.insert("cookie", HeaderValue::from_static("session=secret"));

        let out = forwarded_headers(&incoming, "req-1");
        assert_eq!(out.get("authorization").unwrap(), "Bearer sk-test");
        assert!(
            out.get("cookie").is_none(),
            "client cookies must not leak upstream"
        );
        assert_eq!(out.get("x-request-id").unwrap(), "req-1");
    }

    #[test]
    fn upstream_response_headers_are_filtered() {
        let mut up = HeaderMap::new();
        up.insert(
            "content-type",
            HeaderValue::from_static("text/event-stream"),
        );
        up.insert("set-cookie", HeaderValue::from_static("a=b"));

        let out = passthrough_headers(&up);
        assert_eq!(out.get("content-type").unwrap(), "text/event-stream");
        assert!(out.get("set-cookie").is_none());
    }
}
