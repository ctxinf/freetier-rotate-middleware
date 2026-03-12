# my-ai-gateway

OpenAI Chat Completions compatible gateway with custom routing + quota strategies.

## Setup
1. Copy `.env.example` to `.env` and set `UPSTREAM_BASE_URL` (and optionally `UPSTREAM_API_KEY`).
2. Install deps and run dev server:
   - `npm i`
   - `npm run dev`

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
- `GET /_health`

