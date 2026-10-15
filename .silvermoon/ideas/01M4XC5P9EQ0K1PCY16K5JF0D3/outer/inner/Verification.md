# MVP 2 本地实现验证

## 结论与边界

2026-10-15，在 `6c28efe6f5eb` 基线上落实已接受的
[设计](ideal/Design.md)；理想世界文件保持不变。本地闭环已通过验证，**不代表部署、真实 OAuth、真实 PGH/Agent 试点或现实世界验收完成**。本轮没有云写入、读取真实凭据、安装依赖、修改全局 runtime、生命周期事件变更、提交或推送；同步/阶段审阅由父会话负责。

## 当前 session 的实现审阅

2026-10-15：当前 session 按用户委托独立审阅认证/机器路由、逐操作 SQL 权限、兼容迁移、调用方 fail-closed 行为与本地 CLI，并独立重跑完整
`pnpm check`：12/12 目标、149 个测试通过，保留 90% 覆盖率门槛。

审阅要求的两项修正已完成并复核：人类与 Agent 创建接口共用实际输入断言，移除双重类型断言；本地管理命令对不存在 Agent 明确失败，对重复 grant/remove 明确返回 unchanged 且不生成虚假配置审计。真实本地 D1 测试覆盖含审计变化计数与零行行为。

实现 gate 的结论为：本轮已接受设计限定的**本地 MVP
2 实现**可通过；实际生命周期通过需绑定同步后的准确 implementationRevision，不能将此结论用于外部部署接受。MVP
1 OAuth/云端试点及 MVP
2 真实调用方部署验收仍未完成，不授权云写入、不推进离线凭证阶段。

## 实现入口明细

| 能力     | 持久文件                                                                | 关键约束                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 兼容迁移 | `apps/worker/migrations/0003_agent_mvp.sql`                             | 仅新增 Agent 侧表/约束/审计，不重建人类表、不改写旧请求/决定/事件；阻止 Agent 认领历史 ID 和跨 kind 重名                                                      |
| 认证     | `apps/worker/src/agent-auth.ts`                                         | 独立随机 bootstrap、域分隔 SHA-256、Web Crypto 常量时间 MAC 校验；300 秒 opaque token，无 refresh；可信 issuer、固定 audience、DB 时钟、generation 与当前撤销 |
| 业务存储 | `apps/worker/src/agent-store.ts`                                        | 每次载荷 SELECT/条件 INSERT/UPDATE 重新比较 token hash、绑定、有效期、状态及分项权限；作用域仅本人请求；终态 CAS+审计原子提交                                 |
| 机器接口 | `apps/worker/src/agent-api.ts`                                          | 只有 token/create/read/withdraw；拒绝 Cookie/Origin/cross-site，不把 Bearer 作为人类会话；未知/过期/错误秘密使用相同认证错误                                  |
| 本地运维 | `apps/worker/src/agent-admin.ts`、`apps/worker/scripts/agent-local.mjs` | 仅持久本地 Miniflare D1，无 remote、隐式迁移或 `.dev.vars` 读取；参数化配置操作，独占受限文件交付，不打印秘密                                                 |
| 调用方   | `examples/agent-caller.mjs`、`examples/release-review.json`             | 使用调用方事先持久保存的 key/固定输入/预期摘要；每次调用只交换一次、创建一次、查询一次；失败不恢复，无静默重试                                                |
| 人类界面 | `apps/web/src/api.ts`、`apps/web/src/app.tsx`                           | 列表/详情显示服务端 requesterType，human/agent/legacy 不靠 ID 前缀猜测；实际操作身份继续独立显示                                                              |

机器创建须显式 create+read；读取须本人+read；撤回须本人+read+withdraw。注册者、Thread、定位符和创建关系都不赋予额外权限。只有已有合格人类会话能决定，直接决定仍 authority=actor、actor!=requester。认证或权限撤销不改写已形成的历史。

本地 CLI 与现有占位 D1
ID/本地存储约定绑定，不能拿它配置另一个真实试点；详细操作和该限制见仓库
`README.md`。Windows 文件交付先移除继承并仅授予当前用户 Modify，再写秘密；Unix 使用
`0600`。文件独占创建，不覆盖已有凭据。D1 配置审计 trigger 的写入会计入
`meta.changes`，运维 helper 据此判断零行拒绝，不把“含审计的两行变化”误判成未注册。

## 持久测试及实际证明

### SQLite / 生产路由

`apps/worker/test/agent.test.ts`：

- 经真实 `exchangeCredential`/`resolveAgent`
  路径验证随机 token、hash 域分隔、issuer/audience、错误秘密、未来/过期 token、过期/未来 credential、逐 token/credential/身份撤销、generation 不复活。
- `assertAgent` 及所有业务函数拒绝只有公开 token
  ID、错误 hash 或已失效 principal 的调用；credential 核验后、token 条件 INSERT 前撤销仍不能签发。
- 显式权限、跨 Agent、注册者/人类与机器访问边界；Agent 不能创建 decide 权限或借用人类会话；create/read/withdraw 分项撤销立即影响后续操作。
- 相同 key 并发只有一个 created，同 key 不同意图冲突；预检后撤销 token/权限，条件写入不越权；审计失败整体回滚，不留下错误终态。
- 生产 Hono 路由拒绝 Cookie/Origin/额外操作者字段；未知/错误认证不枚举凭据存在性，故障响应和日志不包含 secret、hash、原始异常正文。

`apps/worker/test/migration.test.ts`：带有人类身份、会话、权限、已批准请求、Decision 与事件的旧库在新增迁移前后逐表快照相同；人类流程仍能写新请求并由原人类审批。旧原型数据不会被补造 Decision 或自动映射成 Agent。

### 真实 workerd D1 / 调用方 / CLI

`apps/worker/test/agent-runtime.test.ts`：

- 构建生产 Worker，在本地 workerd
  D1 应用真实迁移；旧原型请求与审计逐行保留，API 明示 legacy，不伪造人类绑定。
- HTTP
  token 交换、并发同 key 创建、错误 issuer/audience/未来/过期 token、错误 authenticated
  hash、权限失效、Agent 决定拒绝、cookie/CSRF 回归均走生产路由/谓词。
- 人类决定与 Agent 撤回竞争只有一名赢家；注入审计故障得到 500，pending/事件不被部分提交；重启后历史与终态保留。
- 实际执行 Node 调用方：pending 阻塞 → 人类通过生产决定接口批准 → 相同 key 显式重新运行 exit
  0。digest/ID/requester/type/模板/schema/载荷/终态证据不匹配、错误 issuer/audience、无效 JSON、HTTP
  401/500、重定向、断线和 10 秒超时均非零退出；rejected/withdrawn/pending 不恢复。
- 丢弃**已完成创建**的响应后，下一次显式运行仍使用同 key/同输入并读回同一请求。代理逐路径计数，每次程序调用不重复请求；stdout/stderr 不含 bootstrap
  secret 或 Bearer token。
- 实际执行 `agent:local`
  的注册、权限授予/移除、凭据独占文件交付、停用/启用、撤销与查询；`--remote`、decide 权限、越界凭据文件、重复覆盖均失败。Windows
  ACL 的受限文件可由当前用户正常读/清理，测试没有给其他主体权限。

### Chromium / 原人类流程

`apps/worker/test/browser-runtime.test.ts`：生产静态资源 +
Worker + 持久本地 D1，在 **1440px 和 320px**
均完成原人类创建/批准/拒绝/撤回/无权限/确认弹层/故障恢复/退出/重启流程，同时新增：

- Agent 经机器接口创建，人类从 inbox 进入详情识别 “Agent · 稳定 ID”。
- 实际人类批准、拒绝及机器撤回后显示正确实际 actor、两条不可变历史；注册者不因注册关系得到 Agent 请求读取权限。
- 两种宽度无横向溢出；重启后 Agent
  token 仍按有效期校验，正确返回原批准结果和真实人类 decidedBy。

人类认证只合成“上游已核验的 GitHub account 输入”；Gate 的 signIn/jwt
callback、加密 cookie、HTTP 认证、当前会话和 DB 授权均真实执行。**这不是外部 GitHub
OAuth 成功证据**，没有测试后门 header、固定登录绕过或生产授权弱化。

`apps/web/test/ui.test.tsx`
新增四项 requesterType 测试：三种来源按服务端类型显示；旧响应默认 legacy，未知 kind 拒绝，不将旧历史猜成人类。

## 完整质量门禁

初次完整候选实际运行并通过：

```text
pnpm exec eslint examples\agent-caller.mjs --max-warnings=0
pnpm check
git diff --check
```

`pnpm check` 执行格式、三个工作区 lint/typecheck/test/build；共
**149 项测试通过**，保留基线 122 项并新增 27 项。Worker dry-run
bundle 通过，不是部署。

| 工作区    | 测试数 | Statements | Branches | Functions |  Lines |
| --------- | -----: | ---------: | -------: | --------: | -----: |
| contracts |     23 |     98.63% |   96.36% |      100% | 98.61% |
| web       |     48 |     97.71% |   95.53% |    97.46% | 99.65% |
| worker    |     78 |     98.81% |   96.90% |      100% | 99.26% |

未降低原有任何 ≥90% 覆盖率阈值，未增加依赖。故障注入测试中的固定
`INTERNAL_ERROR` +
traceId/path 是预期日志，不是被忽略的失败；未输出请求 body、Authorization、cookie、hash 或原始异常内容。运行时与子进程都在测试结束释放，操作自建的持久本地测试目录已清理。

### 父会话审阅后的定点修复

- 人类与机器 create 路由都先通过同一个 `validateCreate(Record<string, unknown>)`
  运行时断言守卫，再传入已收窄的类型；移除两条路由的
  `as unknown as`。保留 requireObject 的额外字段拒绝，以及固定模板/schema、载荷、threadId 和 Unicode 检查。两种路由新增错误类型与未知字段断言，均为 400 且不写请求。
- CLI
  `inspect`/grant/remove 对不存在的 Agent 明确 404、非零退出、stdout 为空；错误只打印固定分类，不输出异常 payload 或认证秘密。已有 Agent 的重复 grant/无权限可移除操作明确返回
  `unchanged`，不宣称发生更新。
- SQLite 验证实际权限行与审计行数量；真实 workerd
  D1 验证一条权限插入/删除含配置 trigger 时
  `meta.changes=2`，空操作为 0。重复 grant/remove 不新增审计；缺失 Agent 无权限行或审计副作用。
- 修复后实际执行 Worker lint、typecheck，针对性四文件 **66 项通过**，再执行
  `pnpm --filter @workspace/worker test`，**78 项及原 ≥90% 覆盖率门禁通过**。上表 Worker 覆盖率更新为本次修复后的结果；contracts/web 未改动，沿用前次完整
  `pnpm check` 证据。本次未重新运行整个 workspace
  gate，不将针对性复测冒称为新一轮全仓运行。

## 仍阻塞的外部证明

- MVP 1 的真实 GitHub OAuth 回跳、独立双人受限云端试点及对应验收尚未完成。
- MVP
  2 尚无经过授权的真实环境身份交付、云迁移/部署、真实 PGH/Agent 工作流或现实世界演练。
- 这些必须等待前置外部门禁和明确环境授权；本地 149 项通过、构想已接受或实现已同步均不能替代。`D-*`
  ledger 项保持未完成。
