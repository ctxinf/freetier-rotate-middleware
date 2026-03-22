---
name: freetier-rotate-middleware-management
description: Manage freetier-rotate-middleware through REST admin endpoints and inspect `/_status/json`. Use when an agent needs to list/create/update/delete routes, clean request logs, change runtime `upstreamBaseUrl`, or verify quota and usage state after changes. Resolve gateway address from `FREETIER_ROTATE_MIDDLEWARE_BASE_URL` and default to `http://localhost:3001`.
---

# Freetier Gateway Admin Status

## Initialize Base URL

Use one base URL for all calls:

```bash
BASE_URL="${FREETIER_ROTATE_MIDDLEWARE_BASE_URL:-http://localhost:3001}"
```

If the gateway is configured with a non-root `basePath`, include it in `FREETIER_ROTATE_MIDDLEWARE_BASE_URL`.

## Standard Workflow

1. Check service health and connectivity.
2. Read `/_status/json` to capture current state.
3. Perform targeted REST operation (`/admin/...`).
4. Re-read route data and `/_status/json` to verify the change.
5. Report exact request and response snippets when a write fails.

Use these quick probes:

```bash
curl -sS "$BASE_URL/_health" | jq .
curl -sS "$BASE_URL/_status/json" | jq '{now, config, upstream_count: (.upstreams|length), route_count: (.routes|length)}'
```

## Route Management

List and read:

```bash
curl -sS "$BASE_URL/admin/routes" | jq .
curl -sS "$BASE_URL/admin/routes/1" | jq .
```

Create `token_day` route (daily token quota):

```bash
curl -sS -X POST "$BASE_URL/admin/routes" \
  -H 'content-type: application/json' \
  -d '{
    "entryModel": "group-free",
    "upstreamModel": "doubao-seed-2-0-pro-250415",
    "strategyType": "token_day",
    "priority": 100,
    "enabled": 1,
    "config": {"dailyTokenLimit": 2000000, "resetHourUtc": 8}
  }' | jq .
```

Create `req_min_day` route (dual request limits):

```bash
curl -sS -X POST "$BASE_URL/admin/routes" \
  -H 'content-type: application/json' \
  -d '{
    "entryModel": "group-free",
    "upstreamModel": "gemini-2.5-flash",
    "strategyType": "req_min_day",
    "priority": 90,
    "enabled": 1,
    "config": {"reqPerMin": 5, "reqPerDay": 100}
  }' | jq .
```

Update and delete:

```bash
curl -sS -X PUT "$BASE_URL/admin/routes/1" \
  -H 'content-type: application/json' \
  -d '{
    "entryModel": "group-free",
    "upstreamModel": "gemini-2.5-flash",
    "strategyType": "req_min_day",
    "priority": 120,
    "enabled": 1,
    "config": {"reqPerMin": 6, "reqPerDay": 120}
  }' | jq .

curl -sS -X DELETE "$BASE_URL/admin/routes/1" | jq .
```

## Request Logs Cleanup

Time window cleanup:

```bash
curl -sS -X POST "$BASE_URL/admin/request-logs/cleanup" \
  -H 'content-type: application/json' \
  -d '{"olderThan":"1h"}' | jq .
```

Keep latest N rows (`100..500`):

```bash
curl -sS -X DELETE "$BASE_URL/admin/request-logs?keepLatest=300" | jq .
```

## Runtime Upstream Base URL

Read and update:

```bash
curl -sS "$BASE_URL/admin/settings/upstream-base-url" | jq .

curl -sS -X PUT "$BASE_URL/admin/settings/upstream-base-url" \
  -H 'content-type: application/json' \
  -d '{"upstreamBaseUrl":"https://your-upstream.example.com"}' | jq .
```

## Read `/_status/json`

Inspect route and usage state after every write:

```bash
curl -sS "$BASE_URL/_status/json" | jq '.upstreams[] | {upstreamModel, strategyType, usage, routeCount, enabledCount}'
curl -sS "$BASE_URL/_status/json" | jq '.routes[] | {id, entryModel, upstreamModel, strategyType, priority, enabled, buckets, counters}'
```

## Validation Rules and Errors

- Expect `400` for invalid payloads.
- Expect `404` for missing route IDs.
- Expect `409` when `entryModel + upstreamModel` already exists.
- For `req_min_day`, require `reqPerMin > 0` and `reqPerDay > 0`.
- For `token_day`, require `dailyTokenLimit > 0` (normalized to tokens).

For full endpoint contract and payload notes, read `references/rest-and-status.md`.
