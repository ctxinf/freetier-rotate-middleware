## 项目目的
个性化定制的大模型路由AI网关
路由产品举例: newapi-计费,重定向,多渠道管理

本项目功能:
1. 定制化负载均衡策略



## 负载均衡策略
配置item: [模型名]-[策略]-[优先级]-[config values]

策略种类:
1. 按日/Token计费(如doubao-seed-xxx), 比如每日200WToken, 每日8点刷新
2. req/min+req/day双重限制(如gemini-xxx), 比如每分钟req最多5, 每天req最多100


负载均衡轮询策略:
1. 按优先级从高到底遍历
   1. 找到一个可用的模型, 就是用
   2. 如果用完它的的可用额度(根据策略),设置不可用


## 技术细节
1. 提供一个 openai chat completion API入口
2. 不关注"渠道", 只配置一个上游的 openai chat completion base URL
3. 性能: 不影响请求的流式传输, 采用流fork的方式实现这个功能? (简而言之,不影响链路性能)
4. 使用sqlite+orm实现数据存储
5. 只关注 openai chat completion API 这个一种API
6. stream(SSE), response的结果是sse, 需要组装为完整response
7. 模型的token usage, 从response body中读取

