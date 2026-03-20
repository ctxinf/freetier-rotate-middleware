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

## 快速启动（Docker Compose）
1. 准备配置文件：
   `cp config.example.jsonc config.jsonc`
2. 使用如下 `compose.yml`：

```yaml
services:
  gateway:
    image: ghcr.io/ctxinf/freetier-rotate-middleware:latest
    ports:
      - "3001:3001"
    volumes:
      - ./config.jsonc:/app/config.jsonc:ro
      - gateway-data:/app/data
    restart: unless-stopped

volumes:
  gateway-data:
```

3. 启动：`docker compose up -d`
4. 查看日志：`docker compose logs -f gateway`
5. 停止：`docker compose down`

## 配置说明
- `configLoadMode`：
  - `authoritative`：启动时按 `entryModel+upstreamModel` 全量覆盖（增删改）。
  - `load_once`：仅插入不存在的路由，已存在路由保持不变。
- `logLevel`：`debug` / `info` / `warn` / `error`
- `upstreams + groups`：
  - `upstreams` 定义上游模型配额策略。
  - `groups` 定义入口模型到上游模型的路由与优先级映射。

完整配置请直接参考：`config.jsonc` 与 `config.example.jsonc`。
