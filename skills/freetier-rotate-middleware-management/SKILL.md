---
name: freetier-rotate-middleware-management
description: Manage freetier-rotate-middleware v2 — inspect routing/quota state, edit upstreams, groups and rate limits (frequency, tokens, time_window, error_backoff), read call history, and clear backoff. Use when an agent needs to see why a model was skipped, change priorities or limits, or check quota before/after a change. Prefer the MCP endpoint at POST {BASE}/mcp; a REST admin API covers the same ground. Resolve the address from FREETIER_ROTATE_MIDDLEWARE_BASE_URL, defaulting to http://localhost:3001.
---

# freetier-rotate-middleware v2 admin

The config file is the single source of truth. Every write below edits that TOML
file in place (comments preserved) and takes effect immediately — there is no
separate apply or restart step. SQLite holds only call history and counters.

## Base URL

```bash
BASE_URL="${FREETIER_ROTATE_MIDDLEWARE_BASE_URL:-http://localhost:3001}"
```

The gateway serves everything — UI, `/api/*`, `/v1/*` and `/mcp` — under one
`server.path_prefix`. If it is not `/`, include the prefix in the base URL
(e.g. `http://localhost:3001/gw`).

## Orientation

Read these two before changing anything:

```bash
# Where the API lives, and which clock the gateway is on. Time-based limits and
# every timestamp below are in this zone, not yours.
curl -sS "$BASE_URL/api/runtime" | jq .

# Live quota consumption and block state for every upstream.
curl -sS "$BASE_URL/api/status" | jq '.upstreams[] | {id, model, enabled, limits}'
```

## MCP (preferred)

One JSON-RPC endpoint; attach to it directly as an MCP server.

```bash
curl -sS -X POST "$BASE_URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

Tools: `get_overview`, `get_status`, `get_config`, `set_upstream_enabled`,
`set_route_priority`, `clear_backoff`.

```bash
# Hour-by-hour prose summary for one entry model — start here when diagnosing.
curl -sS -X POST "$BASE_URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_overview","arguments":{"entry_model":"group-test"}}}' \
  | jq -r '.result.content[0].text'

# Put a parked upstream back in rotation (omit upstream_id to clear all).
curl -sS -X POST "$BASE_URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"clear_backoff","arguments":{"upstream_id":"qwen3.6-27b"}}}' | jq -r '.result.content[0].text'
```

## Config model

- `upstreams` own the quota: `id` is the stable handle, `model` is the name sent
  upstream. Renaming `model` never breaks a group reference.
- `groups` are pure references: `entry_model` → `[{upstream, priority}]`.
  Highest priority first; equal priorities round-robin.
- **All** of an upstream's limits must pass for it to be used (AND). Hitting any
  one of them skips that upstream and the next candidate is tried.
- All groups pointing at an upstream share its counters.

## Upstreams

```bash
curl -sS "$BASE_URL/api/upstreams" | jq .

curl -sS -X POST "$BASE_URL/api/upstreams" -H 'content-type: application/json' \
  -d '{"id":"gpt-5-nano","model":"openai/gpt-5-nano","enabled":true,
       "limits":[{"type":"frequency","count":5,"period":"1min"}]}' | jq .

# PUT is a partial update: omitted fields are left alone. `id` cannot change.
curl -sS -X PUT "$BASE_URL/api/upstreams/gpt-5-nano" -H 'content-type: application/json' \
  -d '{"enabled":false}' | jq .

# Refused while any group still routes to it.
curl -sS -X DELETE "$BASE_URL/api/upstreams/gpt-5-nano" | jq .
```

Sending `limits` replaces the whole array, so read the current value first and
send it back with your edit applied.

## Limit types

```jsonc
// requests per period
{"type":"frequency","count":5,"period":"1min"}

// tokens per period; weight is optional (uncached input is the 1.0 baseline)
{"type":"tokens","count":"5M","period":"1d","weight":{"output":10,"cache_read":0.1}}

// forbidden wall-clock windows, in the gateway's timezone
{"type":"time_window","forbidden":[{"start":"08:00","end":"10:00"}],"days":[1,2,3,4,5]}

// back off after repeated failures
{"type":"error_backoff","window":5,"threshold":2,"match":["429","5xx"],
 "backoff":{"type":"exponential","start":"60s","max":"24h"}}
```

Notes:
- `period`: `30s`, `1min`, `24h`, `7d`. Bare `m` is rejected as ambiguous.
- `count`: a number or `500K` / `5M`.
- `time_window` times are local to the gateway (`/api/runtime` → `clock`).
  `end` before `start` crosses midnight (`22:00`→`02:00`). `00:00`-`24:00`
  blocks all day; equal start and end is rejected. `days` is 1=Mon…7=Sun,
  omit for every day.
- `error_backoff` `match`: `ALL`, an exact code (`429`), a wildcard (`5xx`),
  `timeout`, or `upstream_error`.

## Groups

```bash
curl -sS "$BASE_URL/api/groups" | jq .

curl -sS -X POST "$BASE_URL/api/groups" -H 'content-type: application/json' \
  -d '{"entry_model":"group-free","routes":[{"upstream":"gpt-5-nano","priority":100}]}' | jq .

# Replaces the whole routes array.
curl -sS -X PUT "$BASE_URL/api/groups/group-free" -H 'content-type: application/json' \
  -d '{"routes":[{"upstream":"gpt-5-nano","priority":100},
                 {"upstream":"qwen3.6-27b","priority":90,"enabled":true}]}' | jq .

curl -sS -X DELETE "$BASE_URL/api/groups/group-free" | jq .
```

## Call history

```bash
curl -sS "$BASE_URL/api/logs?limit=50" | jq '.items[]'
curl -sS "$BASE_URL/api/logs?entry_model=group-free" | jq '.items[]'

# Prose rollup: last day, or last 1000 calls if that reaches further back.
curl -sS "$BASE_URL/api/overview/group-free" | jq -r '.summary, (.hours[].summary)'

# Retention: pick exactly one of hours / days / keep.
curl -sS -X DELETE "$BASE_URL/api/logs?days=7" | jq .
curl -sS -X DELETE "$BASE_URL/api/logs?keep=500" | jq .
```

`created_at` is UTC; convert it into the zone from `/api/runtime` before showing
it to a person, or it will disagree with the `time_window` rules.

## Config file

```bash
curl -sS "$BASE_URL/api/config" | jq .
# Re-read the file from disk after editing it by hand.
curl -sS -X POST "$BASE_URL/api/config/reload" | jq .
# Runtime-editable server fields. port and database_path need a restart.
curl -sS -X PUT "$BASE_URL/api/config/server" -H 'content-type: application/json' \
  -d '{"upstream_base_url":"https://upstream.example.com","timezone":"Asia/Shanghai"}' | jq .
```

## Verifying a change

1. `GET /api/status` before, to record the state you are changing.
2. Apply the write.
3. `GET /api/status` again — a rejected edit changes neither file nor memory.
4. If routing is the question, `GET /api/overview/<entry_model>` shows what
   actually happened per hour.

## Errors

- `400` — invalid payload, or an edit validation refused. The message names the
  offending field; the config file is left untouched.
- `404` — unknown upstream id, group entry_model, or (from `/v1/*`) an
  entry_model that is not in `groups`.
- `429` from `/v1/chat/completions` — every candidate was rate limited. Check
  `/api/status` for which limit, and remember `time_window` blocks are
  time-based, not quota-based: they clear on their own.
- `502` — all upstreams failed. Check `upstream_base_url` reachability.

Full endpoint contract: `references/rest-and-status.md`.
