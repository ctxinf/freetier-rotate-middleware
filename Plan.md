# AI Gateway 实施计划

## 1. 目标与范围
- 提供一个兼容 OpenAI Chat Completions 的入口（含 SSE 流式）。
- 基于配置实现多上游模型路由与负载均衡。
- 仅关注单一上游 `base_url`，不引入多渠道管理。
- 使用 SQLite + ORM 存储策略配置、配额与统计数据。

## 2. 技术选型（Node.js vs Rust）

### 2.1 对比
| 维度 | Node.js | Rust |
|---|---|---|
| 研发速度 | 快，生态成熟，SSE/HTTP 代理简单 | 中等，工程复杂度更高 |
| 流式处理 | 原生 Stream 足够，易实现 stream fork | 性能与控制力更强 |
| 团队门槛 | 低，易招聘与维护 | 高，学习成本和维护成本更高 |
| 性能上限 | 中高，满足大多数网关场景 | 高，适合极限低延迟高并发 |
| 交付风险 | 低 | 中高 |

### 2.2 推荐
- **第一阶段推荐 Node.js（TypeScript）**：优先实现正确性与可迭代性。
- 若未来出现极高并发/极低延迟瓶颈，可将核心限流与路由模块迁移到 Rust（或以独立服务方式接入）。

## 3. 架构设计
- API 层：接收 OpenAI Chat Completions 请求（stream / non-stream）。
- Router 层：按策略与优先级选择可用模型。
- Quota 层：管理 token/day 与 req/min+req/day 双策略。
- Proxy 层：转发到上游并透传流。
- Usage Collector：从 response body（SSE 汇总）提取 usage 并回写数据库。
- Storage：SQLite（WAL）+ ORM（推荐 Prisma/Drizzle）。

## 4. 数据模型（SQLite）

### 4.1 `route_items`
- `id`
- `public_model`（对外模型名）
- `upstream_model`（上游真实模型名）
- `strategy_type`（`token_day` / `req_min_day`）
- `priority`（越大优先级越高）
- `config_json`（例如限额、刷新时间）
- `enabled`

### 4.2 `quota_counters`
- `id`
- `route_item_id`
- `bucket_key`（如 `2026-03-12`, `2026-03-12T10:35`）
- `used_tokens`
- `used_req`
- `reserved_tokens`
- `updated_at`

### 4.3 `request_logs`（可选但建议）
- `request_id`
- `route_item_id`
- `status`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `latency_ms`
- `created_at`

## 5. 关键算法描述

### 5.1 路由选择算法（优先级遍历）
1. 读取目标 `public_model` 的所有 `enabled` 配置。
2. 按 `priority DESC, id ASC` 排序。
3. 依次检查每个候选项是否可用：
   - `token_day`：判断当日配额是否未超限。
   - `req_min_day`：同时判断分钟桶与天桶是否未超限。
4. 命中第一个可用项即返回；若全部不可用，返回 429（附错误原因）。

### 5.2 配额一致性算法（并发安全）
- 所有配额扣减在 SQLite 事务中执行。
- `req_min_day`：请求前原子扣减（或计数 +1），失败则尝试下一个候选。
- `token_day`：请求前先做“预留”（`reserved_tokens`，基于 prompt 估算 + 安全余量）；响应结束后用真实 `usage.total_tokens` 结算，释放多余预留。
- 更新语句采用条件写入（例如 `used + delta <= limit`）避免并发超卖。

### 5.3 SSE 透传与 usage 汇总算法
1. 上游返回 SSE 后，主流直接透传给客户端，保证低延迟。
2. 分叉一条只读流给 `Usage Collector`。
3. Collector 解析 `data:` 事件，累计内容并捕获最终 usage（若上游末包提供）。
4. 收到 `[DONE]` 后完成结算并写库；失败则记录异常并做补偿释放。

## 6. 实施计划（里程碑）

### M1 - 基础骨架（1-2 天）
- 初始化 TypeScript 工程（Fastify/Express + Undici）。
- 搭建 `/v1/chat/completions` 兼容入口。
- 接入 SQLite + ORM，完成迁移脚本。

### M2 - 路由与策略（2-3 天）
- 实现 `route_items` 配置加载与优先级遍历。
- 实现 `token_day` / `req_min_day` 可用性判断与事务扣减。
- 返回统一错误码与可观测日志。

### M3 - 流式与 usage 结算（2-3 天）
- 实现 SSE 透传 + stream fork。
- 实现 usage 提取、结算、补偿逻辑。
- 支持 non-stream 响应路径。

### M4 - 稳定性与可运维（2 天）
- 增加重试策略（仅幂等环节）与超时控制。
- 增加健康检查、指标（QPS/429/上游耗时/配额命中率）。
- 增加配置热更新或定时刷新。

### M5 - 测试与发布（2 天）
- 单元测试：路由排序、配额边界、重置逻辑。
- 集成测试：SSE 正确透传、usage 结算、并发场景。
- 压测与灰度发布。

## 7. 重置与时间窗口策略
- `token_day`：按配置时区每日固定时刻（如 `08:00`）重置。
- `req/min`：按自然分钟窗口；`req/day` 按自然日窗口。
- 启动时自动补齐当前桶，避免空桶读取失败。

## 8. 风险与应对
- usage 缺失：记录 `unknown_usage`，采用保守释放策略并告警。
- SQLite 写竞争：启用 WAL，控制事务粒度，必要时拆分读写路径。
- 上游抖动：设置熔断与短路冷却时间，避免雪崩重试。

## 9. 验收标准
- 正确命中优先级最高且可用的模型。
- 双策略配额在并发下不超卖。
- stream 响应不被阻塞，首包延迟可控。
- usage 可回写并驱动后续可用性判断。
