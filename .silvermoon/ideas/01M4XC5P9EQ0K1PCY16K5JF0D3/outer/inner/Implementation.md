# Implementation

## Design context

依据 [详细设计](ideal/Design.md) 实施短期 opaque
token、独立机器路由、显式本人 create/read/withdraw 权限及失败不放行调用方。由阶段子 agent 实施，当前 session 依据用户委托负责审阅和 gate 决策；不把本地实现接受等同于真实试点通过。

MVP
1 外部试点未完成时，仅允许本地并行开发与验证；本阶段真实环境部署及 Deployment 验收仍受前置门禁约束。

## Steps

### I-S01: 实现独立 Agent 认证与直接权限

注册稳定 Agent 身份、受控认证材料与短期 token，校验 issuer/audience/有效期及失效状态；独立于浏览器 cookie/CSRF 路径。

新增 `0003_agent_mvp.sql`
的独立 Agent、credential、token 与直接权限表，保留既有人类表和历史；以 CSPRNG 秘密、域分隔 hash、5 分钟 opaque
token 及逐操作 SQL 认证谓词实现。条件写入和载荷读取比较经认证的 token
hash，不能只信任公开 ID 或解析字段。配置变更审计与不可逆撤销保留归属。

### I-S02: 集成请求与调用方恢复

提供认证、幂等创建、授权查询与撤回的接入契约和一个 PGH/Agent 示例；调用方核对状态与预期摘要并控制自己的工作流。

新增 `/api/agent/token`、机器请求 create/read/withdraw 路由与 `agent:local`
工具；机器路由拒绝 Cookie/Origin，不改变人类 cookie、CSRF、无自审批及当前权限规则。列表/详情增加 requesterType，旧未知来源保留 legacy。可执行
`examples/agent-caller.mjs` 仅在在线 approved、预期摘要及绑定信息一致时 exit
0；示例同时核对终态证据，拒绝不完整响应。结果不明仅允许操作者保留同 key/输入显式重新运行。

### I-S03: 验证身份与故障边界

测试 token 失效、重复创建、权限隔离、网络结果不明与实际 actor 归属，保持 MVP
1 人类流程可用。

持久化 SQLite、真实 workerd D1、调用方/本地 CLI 子进程及 1440/320
Chromium 测试；覆盖竞争、审计故障回滚、旧库迁移、重启、断网/10 秒超时、无隐藏重试和无 secret 日志。完整结果与命令见
[Verification.md](Verification.md)；此处不包含真实 OAuth 或云试点证据。

## Acceptance criteria

### I-AC01: Agent 不借用人类权限

认证/授权测试证明创建者关系不继承权限，错误 audience、过期/撤销认证及无权限查询被拒绝，secret 不进日志。

以 `agent.test.ts`、`agent-runtime.test.ts`
复现：缺少分项权限、跨 Agent、注册者越权、错误 hash/issuer/audience、未来/过期 token、credential/身份撤销均失败；Agent 无决定端点，Bearer 不成为人类会话。

### I-AC02: 调用方不误放行

集成测试证明仅 online
approved 且摘要匹配恢复；拒绝、撤回、不匹配、断网与重试都保持阻塞或明确失败。

以实际 Node 子进程运行示例，只有在线批准且精确绑定匹配 exit
0；pending/rejected/withdrawn 为 75，认证/摘要/响应/超时错误非零。创建提交后响应丢失，再次显式运行仍命中同一 key、同一请求和唯一 created 事件，不自动重复写入。

### I-AC03: 人类与 Agent 链路可追溯

端到端测试记录 Agent 创建者、人类审批 actor、不可变载荷与结果，且 MVP
1 回归通过。

以生产 Worker、静态资源及持久本地 D1 验证人类/Agent 创建、批准、拒绝、撤回、访问拒绝和重启后的归属；旧人类/原型业务行及审计不因 0003 改写。`pnpm check`
全部 149 项测试通过，三个工作区覆盖率均保持原 ≥90% 阈值。实际 OAuth/云试点仍阻塞，不将本地证据作为 Deployment 验收。
