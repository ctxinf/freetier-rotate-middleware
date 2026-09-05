# freetier-rotate-middleware

一个面向个人免费额度聚合场景的 AI 网关 (v2, Rust)。

使用前:
```
手动指定 model: doubao-seed-2-0-pro-260215
用完每日额度后手动切换: gemini-flash-latest
用完每日额度后手动切换: z-ai/glm-4.7
....
```

使用后:
```
指定 model: group-free
第1优先级 doubao-seed-2-0-pro-260215, 额度用完自动切下一个
第2优先级 gemini-flash-latest, 每分钟最多5次, 每天最多100次, 用完切下一个
第3优先级 z-ai/glm-4.7, 早高峰 08:00-10:00 不用, 其余时间每分钟最多2次
...
```

## 架构概览

```text
APP ──[自定义 model 名, 如 group-free]──► freetier-rotate-middleware ──[重写 model 名]──► NewAPI ──► Users
                        (按配额/时段 rotate + 重定向)
```

## 项目定位
- 只实现 `OpenAI /v1/chat/completions` 与 `/v1/models` 接口。
- 不管理 provider, 不管理任何上游凭据 (`Authorization` 原样转发)。
- 只负责路由、限额、日志、状态页与管理 API。
- 配置文件是唯一真相; SQLite 只存调用历史和运行态计数器。

## 限流类型
| 类型 | 作用 |
|---|---|
| `frequency` | 每周期请求数 |
| `tokens` | 每周期 token 数, 可对输出/缓存读加权 |
| `time_window` | 禁止时段 (网关本地时间, 支持跨午夜和按星期) |
| `error_backoff` | 连续失败后退避, 指数增长或固定间隔 |

一个上游的所有 limit 必须**全部**通过才会被选中; 命中任意一条就跳过它, 尝试
下一个优先级。同优先级轮询。

## Docker 部署

```sh
curl -fsSL https://raw.githubusercontent.com/ctxinf/freetier-rotate-middleware/main/config.example.toml -o config.toml
vim config.toml   # 至少改 upstream_base_url, 以及 timezone
docker compose up -d
```

`compose.yml`:
```yaml
services:
  freetier-rotate-middleware:
    image: ghcr.io/ctxinf/freetier-rotate-middleware:latest
    container_name: freetier-rotate-middleware
    ports:
      - "3001:3001"
    volumes:
      # 网关会把 UI/MCP 的改动写回这个文件, 所以是读写挂载
      - ./config.toml:/app/config.toml
      - gateway-data:/app/data
    environment:
      TZ: Asia/Shanghai
    restart: unless-stopped

volumes:
  gateway-data:
```

## 安装 skills 让 Agent 管理
```
npx skills add ctxinf/freetier-rotate-middleware
```

或者直接把 `POST /mcp` 作为 MCP server 接给 agent, 见下文。

---

## 从源码运行

OpenAI 兼容的模型路由网关。一个入口模型名 (`entry_model`) 映射到一组上游模型,
按优先级和配额自动选择、失败自动转移。

配置文件是唯一真相, SQLite 只存调用历史和运行态计数器。运行中通过 Web UI 或
MCP 改配置会直接写回 TOML 文件, 注释和格式完整保留。

## 快速开始

### 1. 准备配置

```bash
cp config.example.toml config.toml
```

然后编辑 `config.toml`, 至少要改 `upstream_base_url` 指向你自己的上游
(一个 OpenAI 兼容的 base URL):

```toml
[server]
upstream_base_url = "http://your-upstream:3000"
```

> 网关不管理上游密钥。客户端请求里的 `Authorization` 头会原样转发到上游。

### 2. 启动

```bash
cargo run
```

首次编译需要几分钟 (`rusqlite` 会编译 bundled SQLite)。看到这行就是起来了:

```
INFO freetier_rotate_middleware: freetier-rotate-middleware v2 listening addr=0.0.0.0:3001 config=./config.toml upstreams=8 groups=4
```

打开 <http://localhost:3001> 是管理界面。

### 3. 发一个请求

`model` 填配置里的 `entry_model` (不是上游真实模型名):

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"group-free","messages":[{"role":"user","content":"hi"}]}'
```

流式:

```bash
curl -N -X POST http://localhost:3001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"group-free","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

每个请求会打一行 access 日志, 显示实际路由到了哪个上游:

```
INFO access: [group-free]->[doubao-pro] 200 0.847s 100↑ 20↓
                ↑入口       ↑实际上游   ↑首字节耗时 ↑输入 ↑输出
```

## 常用命令

```bash
cargo run                      # 启动 (debug)
cargo run --release            # 启动 (release, 快很多)
cargo test                     # 跑全部测试
cargo test config::store       # 只跑配置读写的测试
cargo test -- --nocapture      # 显示测试里的 println
cargo check                    # 只做类型检查, 比 build 快
cargo clippy --all-targets     # lint
cargo fmt                      # 格式化
```

## 环境变量

都可以覆盖配置文件里的对应项, 用于临时调试而不改文件:

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONFIG_PATH` | `./config.toml` | 配置文件路径 |
| `PORT` | 配置文件的 `server.port` | 监听端口 |
| `DATABASE_PATH` | 配置文件的 `server.database_path` | SQLite 路径 |
| `STATIC_DIR` | `./static` | 前端静态文件目录 |
| `PATH_PREFIX` | 配置文件的 `server.path_prefix` | 统一路径前缀 |
| `RUST_LOG` | 见下 | 日志过滤, 优先级高于配置文件 |

例如用另一份配置和端口起一个实例:

```bash
CONFIG_PATH=/tmp/test.toml PORT=8891 cargo run
```

## 调试

### 日志级别

默认级别取自配置文件的 `server.log_level`。想临时开 debug 而不改配置, 用
`RUST_LOG`:

```bash
RUST_LOG=freetier_rotate_middleware=debug,access=info cargo run
```

> **注意**: `RUST_LOG` 一旦设置就会完全接管过滤规则。只写
> `RUST_LOG=freetier_rotate_middleware=debug` 会把 access 日志过滤掉 —— access 日志用的是
> 独立的 `access` target, 需要显式带上 `access=info`。

只看某个模块:

```bash
RUST_LOG=freetier_rotate_middleware::limits=debug,access=info cargo run   # 限流决策
RUST_LOG=freetier_rotate_middleware::svc::proxy=debug,access=info cargo run  # 请求转发链路
```

debug 级别下每个请求会打出候选列表和跳过原因:

```
DEBUG freetier_rotate_middleware::svc::proxy: request accepted request_id="ZndACqhu" entry_model="group-fast" stream=false candidates=3
DEBUG freetier_rotate_middleware::svc::proxy: candidate skipped upstream="doubao-pro" reason="token limit #0 exhausted"
```

### 用假上游调试

不想消耗真实额度时, 起一个本地假上游:

```bash
cat > /tmp/mock.py <<'PY'
import json, http.server
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or '{}')
        model = body.get('model', '?')
        # 名字里带 fail 的模型固定返回 429, 用来测失败转移和退避
        if 'fail' in model:
            self.send_response(429); self.end_headers()
            self.wfile.write(b'{"error":{"message":"rate limited"}}'); return
        usage = {"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,
                 "prompt_tokens_details":{"cached_tokens":60}}
        if body.get('stream'):
            self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            self.wfile.write(('data: %s\n\n' % json.dumps({"choices":[],"usage":usage})).encode())
            self.wfile.write(b'data: [DONE]\n\n'); return
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({"choices":[{"message":{"content":"hi"}}],"usage":usage}).encode())
http.server.HTTPServer(('127.0.0.1', 8899), H).serve_forever()
PY
python3 /tmp/mock.py &
```

然后把配置里的 `upstream_base_url` 指向 `http://127.0.0.1:8899`, 把某个上游的
`model` 改成 `fail-me` 就能观察失败转移和 `error_backoff` 的行为。

### 查看运行态

```bash
# 每个上游的配额消耗和退避状态
curl -s localhost:3001/api/status | jq

# 最近的调用记录
curl -s 'localhost:3001/api/logs?limit=20' | jq '.items[]'

# 某个 entry_model 的分小时概述 (文字版)
curl -s localhost:3001/api/overview/group-free | jq -r '.summary, (.hours[].summary)'
```

### 直接查数据库

```bash
sqlite3 ./data/gateway.sqlite

.tables                  -- request_logs / quota_counters / upstream_states
SELECT * FROM quota_counters;                    -- 当前配额计数
SELECT * FROM upstream_states;                   -- error_backoff 状态
SELECT upstream_id, status, total_tokens, created_at
  FROM request_logs ORDER BY created_at DESC LIMIT 10;
```

配额卡住时可以直接清运行态, 不影响配置:

```bash
sqlite3 ./data/gateway.sqlite 'DELETE FROM quota_counters; DELETE FROM upstream_states;'
```

或者只解除某个上游的退避:

```bash
curl -X POST localhost:3001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"clear_backoff","arguments":{"upstream_id":"doubao-pro"}}}'
```

## 路径前缀 (path_prefix)

`server.path_prefix` 是**统一**前缀 —— 管理界面、`/api/*`、`/v1/*`、`/mcp`
全部挂在它下面, 方便网关放在反向代理的子路径上, 代理侧不需要做任何 rewrite:

```toml
[server]
path_prefix = "/gw"
```

```
http://host:3001/gw/                     管理界面
http://host:3001/gw/v1/chat/completions  OpenAI 接口
http://host:3001/gw/api/status           管理 API
http://host:3001/gw/mcp                  MCP
```

`path_prefix = "/"` (默认) 表示挂在根路径。前端用相对路径请求 API, 所以换前缀
不需要重新构建任何东西。旧配置里的 `base_path` 仍然能读, 等价于 `path_prefix`。

## 时区与时段限制

时区在**启动时**解析一次: 优先用 `server.timezone` (IANA 名字, 如
`Asia/Shanghai`), 留空则读系统时区。启动日志会打出用的是哪个、从哪来的:

```
INFO freetier_rotate_middleware: freetier-rotate-middleware v2 listening path_prefix="/gw"
     timezone=Asia/Shanghai timezone_source="config" local_time=2026-09-02 19:32:11 +08:00
```

`time_window` 限制就是按这个时钟判断的 —— 配置里写 `08:00` 就是网关本地的
早上八点:

```toml
[[upstreams]]
id = "qwen3.6-27b"
model = "qwen/qwen3.6-27b"
limits = [
  # 早高峰不用这个上游
  { type = "time_window", forbidden = [
    { start = "08:00", end = "10:00" },
  ] },
]
```

- 一个上游可以配多个禁止时段, 落在任意一个里就跳过该上游。
- `end` 早于 `start` 表示跨午夜: `{ start = "22:00", end = "02:00" }` 是夜里
  22 点到次日 2 点。
- 想覆盖整天用 `00:00`-`24:00`; 起止相同会被判为配置错误 (那样什么也拦不住)。
- 加 `days = [1, 2, 3, 4, 5]` 只在周一到周五生效 (1=周一, 7=周日), 不写就是每天。

被时段拦下时, debug 日志会写清楚是哪个时段、什么时候恢复 (本地时间):

```
DEBUG candidate skipped upstream="qwen3.6-27b"
      reason="inside forbidden window 08:00-10:00 (limit #1), until 2026-09-02 10:00:00 +08:00"
```

前端所有时间都按网关时区渲染 (不是浏览器时区) —— 否则页面显示的时间会和你写的
限流规则对不上。这部分用的是原生 Web Component (`static/components.js`):

- `<local-time value="...">` 把 UTC 时间戳渲染成网关本地时间, 鼠标悬停能看到
  原始 UTC 值。
- `<tz-badge>` 在右上角显示当前时区和它的来源 (配置指定 / 读自系统)。

## 排错

**启动就报 `invalid config`**
配置校验在启动时做, 错误信息会指出具体哪一项。常见原因: `groups` 里引用了
不存在的 `upstream` id; `threshold` 大于 `window`; 漏了 `upstream_base_url`。

**请求返回 404 `unknown model`**
请求里的 `model` 必须是 `groups` 里的 `entry_model`, 不是上游真实模型名。
`curl localhost:3001/v1/models` 可以列出所有可用的入口模型。

**请求返回 429 `all upstreams are rate limited`**
所有候选上游都被限流了。`curl -s localhost:3001/api/status | jq` 看是哪条
limit 触发的, debug 日志里也会打出每个候选的跳过原因。

**请求返回 502 `all upstreams failed`**
上游全部连不上或返回了 5xx。先确认 `upstream_base_url` 可达。

**页面打不开 / 静态文件 404**
确认访问的地址带上了 `path_prefix`。配了 `path_prefix = "/gw"` 就必须访问
`http://host:3001/gw/`, 根路径不再提供服务 (只有一个规范地址, 前端的相对请求
才不会歧义)。访问 `/gw` 会 308 跳到 `/gw/`。

**时段限制没有按预期时间生效**
先看启动日志里的 `timezone=` 和 `local_time=` —— 时段用的是网关的时区, 不是
你本机浏览器的。容器里通常需要装 tzdata 并设置 `TZ`, 或者直接在配置里写死
`server.timezone`。`curl -s localhost:3001/api/runtime | jq .clock` 能看到网关
当前认为的本地时间。

**改了配置文件但没生效**
配置在启动时加载。改文件后重启, 或者调 `curl -X POST localhost:3001/api/config/reload`。
反过来, 从 UI/MCP 改的配置会立即生效并写回文件, 不需要重启。

## 项目结构

```
.
├── config.toml           配置 (唯一真相, 从 config.example.toml 复制)
├── src/
│   ├── clock.rs          本地时区解析 (启动时读取一次)
│   ├── config/           配置模型、单位解析 (5M/1min/08:00)、TOML 读写
│   ├── limits/           限流引擎 (frequency/tokens/time_window/error_backoff)
│   ├── storage/          SQLite: 调用历史、计数器、分小时聚合
│   ├── svc/              路由选择、请求转发、SSE usage 解析
│   ├── http/             REST API、MCP、静态文件
│   └── main.rs           启动入口
├── static/               前端 (Alpine.js + 原生 Web Component, 无构建步骤)
└── data/gateway.sqlite   调用历史和运行态计数器
```

前端没有构建步骤, 改完 `static/` 下的文件刷新浏览器即可。

配置模型的设计说明见 `AGENTS.md`。
