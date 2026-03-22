# REST and Status Reference

## Base URL

Resolve gateway base URL from:

```bash
BASE_URL="${FREETIER_ROTATE_MIDDLEWARE_BASE_URL:-http://localhost:3001}"
```

If gateway runs with non-root `basePath`, include it in `BASE_URL`.

## Endpoints

- `GET /_health`
- `GET /_status`
- `GET /_status/json`
- `GET /admin/routes`
- `GET /admin/routes/:id`
- `POST /admin/routes`
- `PUT /admin/routes/:id`
- `DELETE /admin/routes/:id`
- `POST /admin/request-logs/cleanup`
- `DELETE /admin/request-logs`
- `GET /admin/settings/upstream-base-url`
- `PUT /admin/settings/upstream-base-url`

## Route Payload Contract

Common fields for create/update:

```json
{
  "entryModel": "group-free",
  "upstreamModel": "gemini-2.5-flash",
  "strategyType": "req_min_day",
  "priority": 90,
  "enabled": 1,
  "config": {}
}
```

Validation:

- `entryModel` required string.
- `upstreamModel` required string.
- `strategyType` must be `token_day` or `req_min_day`.
- `priority` must be numeric.
- `enabled` accepts `0/1/false/true` (normalized to `0/1`).
- `configJson` (stringified JSON) is supported; `config` object is also supported.
- unique key is `entryModel + upstreamModel`; duplicate create/update returns `409`.

`req_min_day` config:

```json
{"reqPerMin": 5, "reqPerDay": 100}
```

Both fields must be `> 0`.

`token_day` config:

```json
{"dailyTokenLimit": 2000000, "resetHourUtc": 8}
```

Accepted daily token input forms (normalized internally to tokens):

- `dailyTokenLimitTokens`
- `dailyTokenLimitM` (million tokens)
- `dailyTokenLimit` (number or string like `"2m"`)

## Request Logs Cleanup Contract

Two cleanup modes:

1. `olderThan` mode: `1h` or `1d`
2. `keepLatest` mode: integer in `100..500`

Can be provided by JSON body or query string.

Examples:

```bash
curl -sS -X POST "$BASE_URL/admin/request-logs/cleanup" \
  -H 'content-type: application/json' \
  -d '{"olderThan":"1d"}'

curl -sS -X DELETE "$BASE_URL/admin/request-logs?keepLatest=300"
```

## Upstream Base URL Contract

- Read current runtime value:

```bash
curl -sS "$BASE_URL/admin/settings/upstream-base-url"
```

- Update runtime value:

```bash
curl -sS -X PUT "$BASE_URL/admin/settings/upstream-base-url" \
  -H 'content-type: application/json' \
  -d '{"upstreamBaseUrl":"https://your-upstream.example.com"}'
```

Validation:

- required
- must be valid URL
- protocol must be `http` or `https`

## `/_status/json` Shape

Top-level keys:

- `now`: ISO time
- `config`: runtime config snapshot
- `upstreams`: aggregated usage by upstream model
- `routes`: route items with parsed config, buckets, and counters
- `quotaCountersRecent`: recent quota counter rows
- `requestLogsRecent`: latest request logs

Useful `jq` snippets:

```bash
curl -sS "$BASE_URL/_status/json" | jq '.config'
curl -sS "$BASE_URL/_status/json" | jq '.upstreams[] | {upstreamModel, usage, routeCount, enabledCount}'
curl -sS "$BASE_URL/_status/json" | jq '.routes[] | {id, entryModel, upstreamModel, strategyType, priority, buckets, counters}'
```

## Error Expectations

- `400`: invalid input or malformed JSON.
- `404`: target route id does not exist.
- `409`: duplicate `entryModel + upstreamModel` combination.
