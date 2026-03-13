# my-ai-gateway

OpenAI Chat Completions compatible gateway with custom routing + quota strategies.

## Setup
1. Copy `.env.example` to `.env` and set `UPSTREAM_BASE_URL`.
2. Install deps and run dev server:
   - `npm i`
   - `npm run dev`

## Docker
- Build is npm-only (no apt/apk in Dockerfile).
- If you want fully reproducible builds, run `npm install` once locally to update `package-lock.json`, then Docker will use `npm ci`.

## Seed A Route Item
Example: per-minute + per-day request limits
```bash
npm run db:seed -- all-free doubao-seed-2-0-mini-260215 req_min_day 100 '{"reqPerMin":1,"reqPerDay":2}'
```

Example: daily token limit with UTC reset hour bucketting
```bash
npm run db:seed -- doubao-seed-xxx doubao-seed-xxx token_day 100 '{"dailyTokenLimit":2000000,"resetHourUtc":8}'
```

## API
- `POST /v1/chat/completions` proxies to upstream `/v1/chat/completions`
- `GET /v1/models` lists enabled models (OpenAI-compatible)
- `GET /_health`
- `GET /_status` and `GET /_status/json`

## Admin REST API
- `GET /admin/routes`
- `GET /admin/routes/:id`
- `POST /admin/routes`
- `PUT /admin/routes/:id`
- `DELETE /admin/routes/:id`
- `POST /admin/request-logs/cleanup` or `DELETE /admin/request-logs`
  - `olderThan=1h|1d`
  - `keepLatest=100..500`
- `GET /admin/settings/upstream-base-url`
- `PUT /admin/settings/upstream-base-url`

## Config Notes
- `configLoadMode`:
  - `authoritative`: startup config fully overwrites DB routes by unique key `entryModel+upstreamModel` (insert/update/delete).
  - `load_once`: startup only inserts missing routes by `entryModel+upstreamModel`, existing ones are kept unchanged.
- `LOG_LEVEL`: `debug` / `info` / `warn` / `error` (also supported in config file via `logLevel`).
- `logtape` backend is auto-detected. Install to enable:
  - `npm i @logtape/logtape @logtape/console`
