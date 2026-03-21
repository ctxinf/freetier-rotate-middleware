# freetier-rotate-middleware

一个面向个人免费额度聚合场景的AI网关。  

使用前:
```
手动制定model: doubao-seed-2-0-pro-260215
用完每日额度后手动切换: gemini-flash-latest
用完每日额度后手动切换: z-ai/glm-4.7
....
```

使用后:
```
指定model: group-free
第1优先级使用 doubao-seed-2-0-pro-260215, 每日额度用完后切换下一个
第2优先级使用 gemini-flash-latest, 每分钟最大5次请求, 每日最大100次请求, 用完切换下一个
第3优先级使用 z-ai/glm-4.7, 每分钟最大2次请求, 每日最大1000次请求, 用完切换下一个
...
```

## 架构概览

```text
APP ──[自定义modelname, 如group-free]──► freetier-rotate-middleware ──[重写model名]──► NewAPI ──► Users
                        (按条件 rotate + 重定向)
```


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
```sh
mkdir -p config 
curl -fsSL https://raw.githubusercontent.com/ctxinf/freetier-rotate-middleware/main/config/config.example.jsonc -o config/config.jsonc
vim config/config.jsonc #修改上游地址, 模型名..
```

`compose.yml`：
```yaml
services:
  freetier-rotate-middleware:
    image: ghcr.io/ctxinf/freetier-rotate-middleware:latest
    container_name: freetier-rotate-middleware
    ports:
      - "3001:3001"
    volumes:
      - ./config:/app/config
      - gateway-data:/app/data
    restart: unless-stopped

volumes:
  gateway-data:
```



## 配置说明
请直接参考项目中：`config/config.jsonc` 与 `config/config.example.jsonc`。
