## 项目目的
个性化定制的大模型路由 AI 网关。
路由产品举例: newapi-计费, 重定向, 多渠道管理

本项目功能:
1. 定制化负载均衡策略

## v2 架构 (Rust)

代码在 `src/`, 前端静态文件在 `static/`, 配置示例在 `config.example.toml`
(实际配置是根目录的 `config.toml`, 不入库)。

### 配置模型
唯一真相是 TOML 配置文件, SQLite 只存调用历史和运行态计数器, 不再有"双配置"。
运行中通过 Web UI 或 MCP 修改配置会直接写回文件, 注释和格式完整保留 (toml_edit)。

- `upstreams` 持有额度 (真实账号配额的所有者), `id` 是稳定标识, `model` 是发给上游的名字
- `groups` 是纯引用: entryModel -> [{upstream, priority}]
- 一个 upstream 的所有 limits 必须全部通过才放行 (AND 语义), 命中任一条即跳过该 upstream
- 所有指向同一 upstream 的 group 共享它的计数器

### limit 类型 (tagged union, 加新类型不破坏旧配置)
- `frequency`: 每周期请求数
- `tokens`: 每周期 token 数, 可按 `weight` 给输出/缓存读/缓存写加权 (输入未命中缓存恒为 1.0 基准)
- `time_window`: 禁止时段, 本地墙钟时间; `end` 早于 `start` 表示跨午夜, `days` 限定星期 (1=周一)
- `error_backoff`: 最近 `window` 次中有 `threshold` 次匹配 `match` 就退避, 支持指数增长/固定间隔

### 时区
启动时解析一次 (`server.timezone`, 留空则读系统时区), 存在 `AppState::clock`。
`time_window` 判断、日志展示、前端渲染共用这一个时钟 —— 否则规则和界面会对不上。
前端用原生 Web Component (`static/components.js`) 把 UTC 时间戳按网关时区渲染,
而不是浏览器时区。

### 路径前缀
`server.path_prefix` 是统一前缀, web / api / v1 / mcp 全挂在它下面。
只提供这一个规范地址 (不再同时服务根路径), 前端用相对路径请求 API。

### 数据表
- `request_logs`: 调用历史 (唯一持久化数据)
- `quota_counters`: (upstream_id, bucket_key) 的滚动计数。bucket_key 内嵌 limit
  自身的身份 (类型+额度+周期+对齐), **不含数组下标** —— 早期按下标做 key, 导致
  增删/重排 limits 时计数器会串到另一条 limit 上, 已用满的上游会被重新放行
- `upstream_states`: error_backoff 的临时状态, 随时可删

### 关键实现约束
- token 花费在响应后才知道: `acquire` 预留槽位, `finalize` 结算真实开销; 失败的尝试会退款, 不烧额度
- 流式响应边转发边累计 usage, 不增加链路延迟
- 4xx (除 429) 直接返回给客户端, 不做故障转移, 避免掩盖客户端的错误请求

## 技术细节
1. 提供一个 openai chat completion API 入口
2. 不关注"渠道", 只配置一个上游的 openai chat completion base URL
3. 不影响请求的流式传输
4. 只关注 openai chat completion API 这一种 API
5. stream(SSE) 的 usage 从流中解析
6. MCP 挂在 `POST /mcp`, 供 agent 直接接入
