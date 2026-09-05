# freetier-rotate-middleware v2 — endpoint reference

All paths are relative to `server.path_prefix` (default `/`). With
`path_prefix = "/gw"`, `/api/status` is served at `/gw/api/status`; the
un-prefixed path is not served at all.

## OpenAI-compatible

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | `model` must be a group's `entry_model`. Streaming supported; usage is parsed out of the SSE stream. `Authorization` is forwarded upstream verbatim. |
| GET | `/v1/models` | The entry models this gateway exposes. |

Failure behaviour: 429 and 5xx from an upstream trigger failover to the next
candidate; other 4xx are returned to the client as-is, so a bad request is not
masked by retrying elsewhere.

## Admin REST

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/api/runtime` | — | `path_prefix`, version, and the `clock` block (timezone, offset, local time). |
| GET | `/api/status` | — | Per-upstream limits with live counters and block state. |
| GET | `/api/config` | — | The whole config as JSON. |
| POST | `/api/config/reload` | — | Re-read the file from disk. |
| PUT | `/api/config/server` | `{upstream_base_url?, log_level?, path_prefix?, timezone?}` | Partial. `port` and `database_path` are restart-only and not editable here. |
| GET | `/api/upstreams` | — | |
| POST | `/api/upstreams` | full upstream object | 400 if the `id` already exists. |
| PUT | `/api/upstreams/:id` | `{model?, enabled?, limits?}` | Partial; `limits` replaces the whole array. |
| DELETE | `/api/upstreams/:id` | — | 400 while any group still routes to it. |
| GET | `/api/groups` | — | |
| POST | `/api/groups` | `{entry_model, routes}` | 400 if it already exists. |
| PUT | `/api/groups/:entry_model` | `{routes?, entry_model?}` | `routes` replaces the whole array. |
| DELETE | `/api/groups/:entry_model` | — | |
| GET | `/api/logs` | `?entry_model=&limit=` | `limit` defaults to 100, clamped to 1000. |
| DELETE | `/api/logs` | `?hours=` \| `?days=` \| `?keep=` | Exactly one. Returns `{deleted}`. |
| GET | `/api/overview/:entry_model` | — | Hourly rollup plus prose summaries. |
| POST | `/mcp` | JSON-RPC | MCP streamable-HTTP. |

Every mutation is validated, written to the TOML file, and published atomically.
A rejected edit leaves both the file and the running config untouched.

## `/api/status` shape

```jsonc
{
  "upstreams": [
    {
      "id": "gpt-5-nano",
      "model": "openai/gpt-5-nano",
      "enabled": true,
      "limits": [
        {"type": "frequency", "used": 2, "limit": 5, "period": "1min", "remaining": 3},
        {"type": "tokens", "used": 41000, "limit": 100000, "period": "1h",
         "weighted": false, "remaining": 59000},
        {"type": "time_window", "forbidden": ["08:00-10:00"], "days": [1,2,3,4,5],
         "blocked": true, "window": "08:00-10:00",
         "until_local": "2026-09-02 10:00:00 +08:00"},
        {"type": "error_backoff", "window": 5, "threshold": 2,
         "blocked": false, "blocked_until": null, "consecutive_trips": 0}
      ]
    }
  ],
  "groups": [ /* as configured */ ],
  "requests_last_hour": 128,
  "config_path": "./config.toml",
  "path_prefix": "",
  "clock": {"timezone": "Asia/Shanghai", "source": "config", "offset_secs": 28800,
            "now_utc": "2026-09-02T11:37:26.400Z",
            "now_local": "2026-09-02 19:37:26 +08:00"}
}
```

`blocked` on `time_window` is purely a function of the clock — it clears by
itself at `until_local` and cannot be cleared early (change the config if the
window itself is wrong). `error_backoff` blocks *can* be cleared early, via the
`clear_backoff` MCP tool.

## `/api/logs` item shape

```jsonc
{
  "request_id": "iJyywnBuCQ80qzAC",
  "entry_model": "group-test",
  "upstream_id": "gpt-5-nano",
  "upstream_model": "openai/gpt-5-nano",
  "status": 200,
  "error_kind": null,          // "timeout" | "upstream_error" | "stream_error" | ...
  "prompt_tokens": 100,
  "completion_tokens": 20,
  "total_tokens": 120,
  "latency_ms": 4,
  "created_at": "2026-09-02T11:37:26.400Z"   // UTC
}
```

## Tables

- `request_logs` — call history; the only durable data.
- `quota_counters` — `(upstream_id, bucket_key)` rolling counts. The key embeds
  the limit's own identity (type + quota + period + anchor), never its position
  in the `limits` array, so a counter follows its limit across config edits.
  Changing a limit's quota or period deliberately starts a fresh count.
- `upstream_states` — transient `error_backoff` state; safe to delete any time.

`time_window` limits have no table: they are evaluated from the clock alone.
