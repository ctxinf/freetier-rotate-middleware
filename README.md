# freetier-rotate-middleware

一个面向个人免费额度聚合场景的AI网关。  


## 项目定位
- 只实现 `OpenAI /v1/chat/completions` 与 `models` 相关接口。
- 不管理 provider，不管理任何上游凭据。
- 只负责路由、限额、日志、状态页与管理 API。
- 本项目作为 `newapi` 的上游地址，由 `newapi` 对外统一鉴权与计费。

## 支持的限流/配额策略
- `token_day`：按天 Token 限额（如每日 200 万 Token，指定 UTC 重置小时）。
- `req_min_day`：每分钟请求数 + 每日请求数双限额。
- 路由优先级按 `priority` 从高到低，命中可用模型即使用。
- 同优先级模型会做轮询（rotate）。

## 快速启动（本地）
1. 安装依赖：`npm i`
2. 复制配置：`cp config.example.jsonc config.jsonc`
3. 启动服务：`npm run dev`

默认入口：
- 首页：`GET /`
- 健康检查：`GET /_health`
- 状态页：`GET /_status`
- 文档页：`GET /docs`

## Docker Compose 部署教程
1. 准备配置文件 `config.jsonc`（可按你的上游模型和额度改）。
2. 使用如下 `compose.yml`：

```yaml
services:
  gateway:
    build:
      context: .
    ports:
      - "3001:3001"
    volumes:
      - gateway-data:/app/data
      # 可选：挂载本地配置覆盖容器内配置
      # - ./config.jsonc:/app/config.jsonc:ro
    # 可选：通过环境变量覆盖配置
    # environment:
    #   UPSTREAM_BASE_URL: "https://your-upstream.example"
    #   PORT: "3001"
    #   DATABASE_PATH: "./data/gateway.sqlite"
    #   CONFIG_PATH: "./config.jsonc"
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3001/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  gateway-data:
```

3. 启动：`docker compose up -d --build`
4. 查看日志：`docker compose logs -f gateway`
5. 停止：`docker compose down`

## 主要接口
所有路径都在 `basePath`（默认 `/`）下。

网关接口：
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /_health`
- `GET /_status`
- `GET /_status/json`

管理接口（REST）：
- `GET /admin/routes`
- `GET /admin/routes/:id`
- `POST /admin/routes`
- `PUT /admin/routes/:id`
- `DELETE /admin/routes/:id`
- `POST /admin/request-logs/cleanup`
- `DELETE /admin/request-logs`
- `GET /admin/settings/upstream-base-url`
- `PUT /admin/settings/upstream-base-url`

`request_logs` 清理支持：
- `olderThan=1h|1d`
- `keepLatest=100..500`

## 配置说明
- `configLoadMode`：
  - `authoritative`：启动时按 `entryModel+upstreamModel` 全量覆盖（增删改）。
  - `load_once`：仅插入不存在的路由，已存在路由保持不变。
- `logLevel`：`debug` / `info` / `warn` / `error`
- `upstreams + groups`：
  - `upstreams` 定义上游模型配额策略。
  - `groups` 定义入口模型到上游模型的路由与优先级映射。

完整配置请直接参考：`config.jsonc` 与 `config.example.jsonc`。
