//! MCP over a single JSON-RPC endpoint (`POST /mcp`), so an agent can inspect
//! and adjust routing without a separate process. Streamable-HTTP transport:
//! request in, JSON-RPC response out.

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::storage::logs;

const PROTOCOL_VERSION: &str = "2025-06-18";

pub fn handle(state: &AppState, req: Value) -> Response {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // Notifications have no id and expect no response body.
    let is_notification = req.get("id").is_none();

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "freetier-rotate-middleware", "version": env!("CARGO_PKG_VERSION") },
        })),
        "notifications/initialized" => Ok(Value::Null),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(state, &params),
        other => Err(rpc_error(-32601, format!("unknown method `{other}`"))),
    };

    if is_notification {
        return StatusCode204.into_response();
    }

    match result {
        Ok(value) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": value })).into_response(),
        Err(err) => Json(json!({ "jsonrpc": "2.0", "id": id, "error": err })).into_response(),
    }
}

struct StatusCode204;
impl IntoResponse for StatusCode204 {
    fn into_response(self) -> Response {
        axum::http::StatusCode::ACCEPTED.into_response()
    }
}

fn rpc_error(code: i64, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

/// Tool results are text content blocks; agents read them directly.
fn text_result(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

fn json_result(value: &Value, summary: Option<&str>) -> Value {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_default();
    let text = match summary {
        Some(s) => format!("{s}\n\n{pretty}"),
        None => pretty,
    };
    text_result(text)
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "get_overview",
            "description": "Hour-by-hour summary of recent traffic for one entry model: \
                            success rate, token spend, which upstreams served it, and why \
                            calls failed. Covers the last day, or the last 1000 calls if \
                            that reaches further back.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "entry_model": { "type": "string", "description": "e.g. group-free" }
                },
                "required": ["entry_model"]
            }
        }),
        json!({
            "name": "get_status",
            "description": "Current quota consumption and backoff state for every upstream.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "get_config",
            "description": "The full routing configuration as JSON.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "set_upstream_enabled",
            "description": "Enable or disable an upstream. Writes through to the config file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "enabled": { "type": "boolean" }
                },
                "required": ["id", "enabled"]
            }
        }),
        json!({
            "name": "set_route_priority",
            "description": "Change an upstream's priority inside one group. Higher wins; \
                            equal priorities round-robin.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "entry_model": { "type": "string" },
                    "upstream": { "type": "string" },
                    "priority": { "type": "integer" }
                },
                "required": ["entry_model", "upstream", "priority"]
            }
        }),
        json!({
            "name": "clear_backoff",
            "description": "Clear error-backoff state, putting a parked upstream back into \
                            rotation immediately. Omit `upstream_id` to clear all.",
            "inputSchema": {
                "type": "object",
                "properties": { "upstream_id": { "type": "string" } }
            }
        }),
    ]
}

fn call_tool(state: &AppState, params: &Value) -> Result<Value, Value> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| rpc_error(-32602, "missing tool name"))?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let str_arg = |key: &str| -> Result<String, Value> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| rpc_error(-32602, format!("`{key}` is required")))
    };

    match name {
        "get_overview" => {
            let entry_model = str_arg("entry_model")?;
            let ov = logs::overview(&state.db, &entry_model)
                .map_err(|e| rpc_error(-32603, e.to_string()))?;

            // Lead with the prose so an agent can act on it without parsing.
            let mut text = String::new();
            text.push_str(&ov.summary);
            text.push_str("\n\n");
            if ov.hours.is_empty() {
                text.push_str("（窗口内无调用记录）");
            } else {
                for h in &ov.hours {
                    text.push_str("- ");
                    text.push_str(&h.summary);
                    text.push('\n');
                }
            }
            let value = serde_json::to_value(&ov).unwrap_or_default();
            Ok(json!({
                "content": [
                    { "type": "text", "text": text },
                    { "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }
                ]
            }))
        }

        "get_status" => {
            let cfg = state.config.snapshot();
            let value = serde_json::to_value(&*cfg).unwrap_or_default();
            Ok(json_result(&value, Some("当前配置与上游状态：")))
        }

        "get_config" => {
            let cfg = state.config.snapshot();
            let value = serde_json::to_value(&*cfg).unwrap_or_default();
            Ok(json_result(&value, None))
        }

        "set_upstream_enabled" => {
            let id = str_arg("id")?;
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| rpc_error(-32602, "`enabled` must be a boolean"))?;

            state
                .config
                .update(|cfg| {
                    let up = cfg
                        .upstream_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("unknown upstream `{id}`"))?;
                    up.enabled = enabled;
                    Ok(())
                })
                .map_err(|e| rpc_error(-32602, e.to_string()))?;

            Ok(text_result(format!(
                "upstream `{id}` is now {}，已写入配置文件。",
                if enabled { "enabled" } else { "disabled" }
            )))
        }

        "set_route_priority" => {
            let entry_model = str_arg("entry_model")?;
            let upstream = str_arg("upstream")?;
            let priority = args
                .get("priority")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| rpc_error(-32602, "`priority` must be an integer"))?;

            state
                .config
                .update(|cfg| {
                    let group = cfg
                        .group_mut(&entry_model)
                        .ok_or_else(|| anyhow::anyhow!("unknown group `{entry_model}`"))?;
                    let route = group
                        .routes
                        .iter_mut()
                        .find(|r| r.upstream == upstream)
                        .ok_or_else(|| {
                            anyhow::anyhow!("group `{entry_model}` does not route to `{upstream}`")
                        })?;
                    route.priority = priority;
                    Ok(())
                })
                .map_err(|e| rpc_error(-32602, e.to_string()))?;

            Ok(text_result(format!(
                "`{entry_model}` → `{upstream}` priority 已设为 {priority}，已写入配置文件。"
            )))
        }

        "clear_backoff" => {
            let target = args.get("upstream_id").and_then(|v| v.as_str());
            let conn = state
                .db
                .conn()
                .map_err(|e| rpc_error(-32603, e.to_string()))?;
            let n = match target {
                Some(id) => conn.execute(
                    "DELETE FROM upstream_states WHERE upstream_id = ?1",
                    rusqlite::params![id],
                ),
                None => conn.execute("DELETE FROM upstream_states", []),
            }
            .map_err(|e| rpc_error(-32603, e.to_string()))?;
            Ok(text_result(format!("已清除 {n} 条退避状态。")))
        }

        other => Err(rpc_error(-32602, format!("unknown tool `{other}`"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_advertised_tool_has_a_schema() {
        for tool in tool_definitions() {
            assert!(tool.get("name").and_then(|n| n.as_str()).is_some());
            assert!(tool.get("description").is_some());
            let schema = tool.get("inputSchema").expect("tool needs an inputSchema");
            assert_eq!(schema.get("type").and_then(|t| t.as_str()), Some("object"));
        }
    }

    #[test]
    fn required_args_are_declared_as_properties() {
        for tool in tool_definitions() {
            let schema = &tool["inputSchema"];
            let Some(required) = schema.get("required").and_then(|r| r.as_array()) else {
                continue;
            };
            for key in required {
                let key = key.as_str().unwrap();
                assert!(
                    schema["properties"].get(key).is_some(),
                    "tool {} requires `{key}` but does not declare it",
                    tool["name"]
                );
            }
        }
    }
}
