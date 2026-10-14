# 技术选型

本文是 [Idea.md](Idea.md)
的技术可行性设计，按目标产品选择，不要求兼容半成品。本轮不改应用依赖、不替换运行代码。以下是拟议栈，不是现有能力清单。

按 [MVP 路线](MVP-roadmap.md)
逐轮引入所需能力；首轮不安装/实现全部 Agent、签名、委托模块或管理界面。

## 前端

| 层             | 选择                                                  | 理由                                                                                    |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 应用           | TypeScript + React 19 + Vite                          | 工作台 SPA，首版无需 SEO/SSR；成熟组件生态与静态部署                                    |
| 路由           | React Router                                          | 请求/模板/授权的稳定深链接、登录后回跳、错误页面                                        |
| 服务端状态     | TanStack Query                                        | 查询缓存、分页、轮询取消、错误退避和决定后的失效刷新；请求/权限不复制进全局客户端 store |
| 局部交互状态   | React `useReducer` + 纯 reducer                       | 表单步骤、确认与局部状态转换可预测、可测试，避免为局部状态加全局层                      |
| 跨页面临时状态 | Zustand + Immer middleware（仅确有共享需求时）        | 轻量 action/store 和不可变更新；仅用于导航/显示偏好等 UI 状态，不承载业务事实           |
| 表单与校验     | React Hook Form + Zod；业务载荷使用 Ajv / JSON Schema | Zod 校验 API envelope；Ajv 校验版本化业务 payload；两者职责分开                         |
| 视觉与交互     | shadcn/ui + CSS-variable design tokens                | 以可组合、可本地调整的组件及语义 token 作为界面基础；按需生成和维护组件                 |
| 测试           | Vitest + Testing Library + Playwright                 | 组件状态、键盘操作与跨页面主路径分别验证                                                |

后端是唯一信任边界。前端展示的权限、摘要和“可审批”状态都是提示，不能代替后端检查；请求超时后不能直接把 mutation 视为成功。

不用 Zustand 或其他客户端状态层缓存审批请求、权限、决定结果或凭证；这些属于服务端状态，应由 TanStack
Query 管理并按权限请求。Zustand 的 Immer
middleware 只在多个页面确实需要共享同一短期 UI 状态时引入；纯局部流程优先使用
`useReducer`。目前没有证据需要 Redux
Toolkit 的集中式业务 store 或 XState 全局状态机，因此不作为首选；复杂、长生命周期、带补偿/并行分支的交互流程出现后，再单独评估状态机。

## 后端与持久化

| 层         | 选择                                                                | 理由                                                                                         |
| ---------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| API        | Cloudflare Workers + Hono + TypeScript                              | 符合构想托管边界，类型化 HTTP 路由，静态资源与 API 同源                                      |
| 业务数据库 | Cloudflare D1（SQLite）                                             | 与 Worker binding 配套，支持关系约束、SQL migration 和原子 batch；初期避免引入独立数据库运维 |
| 数据访问   | D1 binding + 参数化 SQL + 显式 migration                            | 写路径明确表达条件更新与审批资格；关键原子边界用 `D1Database.batch()`，不隐藏并发语义        |
| 输入协议   | Zod envelope + Ajv JSON Schema，服务端执行                          | 严格字段、body 大小/深度/复杂度限制；拒绝未知协议版本，限制 schema 关键字与外部引用          |
| 摘要与签名 | RFC 8785 JCS、SHA-256、标准 JWS / ES256；使用经过维护的 JOSE 实现   | 固定规范化封装与算法，避免自造凭证格式及密码学                                               |
| 恢复签发   | D1 transactional outbox + 可重试签发处理器                          | 决定、审计、签发任务同 batch 持久化；签名失败可恢复，不能丢失任务或回退决定                  |
| 部署与质量 | pnpm workspace、明确版本锁定、CI 格式/lint/类型/测试/构建，Wrangler | 同一代码与协议可复现，部署与数据迁移分别审查                                                 |

不用 D1 外的缓存判断审批资格，也不因“边缘运行”就把身份图分散到多个存储。初期采用 D1；先用 D1 原子 batch、SQL 条件和唯一约束表达审批，再以目标 Worker/D1 并发测试证明业务不变量。只有在实测写队列/过载、查询负载、可用性或 D1 事务表达能力成为具体瓶颈后，才重新评估 PostgreSQL/Hyperdrive。

## 认证与授权

- 人类使用标准 OIDC/OAuth 登录，由 Gate 维护 `(issuer, subject)` →
  Identity 绑定和服务端会话；选择能提供可验证 MFA/step-up 证据的身份提供商。认证集成候选为 Auth.js，需先验证 Workers 兼容性与 session/MFA 语义，不把普通 OAuth 登录当作强认证。
- Agent 使用独立 workload 身份与短期 token，验证 issuer、audience、有效期和撤销状态；凭据不进浏览器。首版发行方采用 Gate 自有受控认证入口，外部 workload
  federation 以后再扩展。
- cookie 会话写入检查 CSRF/Origin；Agent
  bearer 路径独立验证 audience/scope，不通过关闭浏览器保护实现接入。HTTP
  scope 不代替数据库里的 Delegate/Grant 检查。
- 授权模块集中检查身份有效性、资格名单、操作范围、Grant 时间/撤销、认证强度；请求详情、列表、创建和决定都复用同一策略。

## D1 原子决定与签发路径

```text
React SPA / Agent
       │ 认证、校验、逐操作授权
       ▼
Hono Worker → D1Database.batch([...])
              ├─ 条件检查 pending 与当前有效审批权限
              ├─ pending → 唯一终态（changes 必须恰为 1）
              ├─ 冻结 Decision 与授权证据
              └─ 追加 AuditEvent + 签发 outbox
                           │ batch 全部成功才提交
                           ▼
                   可重试签名处理器
                           ▼
                    不可变 JWS 凭证
                           │
                独立验证器 + trust-bundle
```

Cloudflare 文档将 `D1Database.batch()`
描述为按顺序执行的 SQL 事务：语句依序执行，任何一条失败都会中止并回滚整批操作。因此把终态条件更新、唯一 Decision、不可变 AuditEvent 与签发 outbox 放入同一 batch，可避免业务状态成功但审计/任务漏写。必须检查条件更新
`meta.changes === 1`；权限不合格或已非 pending 时不能写入任何后续证据。唯一约束仍作为最后一道防线。不要把多个分开的 D1 调用当成同一事务，也不要在事务外查一次审批人名单后无条件提交。

D1 单个数据库按顺序处理查询，并为并发请求排队；过载时会返回错误。审批决定保持短小，不在数据库操作期间做外部网络/签名调用；对明确可重试的过载设置有界退避，超出预算时明确失败并保留 pending，不报告成功。Grant 撤销、名单更新和决定都要通过有序的原子写入来定义先后：若决定 batch 先执行，则在该资格仍有效时完成；若撤销先执行，决定的条件更新必须失败。以目标 D1 的并发测试证明这一线性化规则，而不假设客户端调用的开始时间就是授权时点。

D1
batch 是一组提交/回滚的 SQL 语句，不是跨多个网络调用保持打开的任意交互式事务；先读取再分多次写入不能自动纳入 batch 的原子边界。身份解析可在事务前做，但最终权限、Grant 状态、名单资格及 pending 必须由写入 SQL 条件在原子决策路径中重新约束。签名在提交后处理，outbox 持久化签发工作与冻结 claims；恢复时不得重做决定。

初版可由受控定时 Worker 扫描 outbox 处理任务；扫描频率、租约、防重复签发、重试上限和失败告警在实现前证明。若吞吐需要，再接消息队列；outbox 仍是持久化事实，不以
`waitUntil` 代替可靠任务。

读副本与会话一致性需显式处理：决策后立即读取或后续需因果一致的请求使用 D1
Session/bookmark，或初期不启用读复制并将关键读写留在主库；不能让可能陈旧的副本读取决定、资格或权限事实。

## 凭证协议与密钥边界

JWS
header 固定 alg 和 keyId；claims 固定 protocolVersion、issuer、requestId、模板/schema 版本、outcome、payloadDigest、authorityIdentity、actorIdentity、授权证据及 decidedAt。验证器禁止由 token 自选算法或远程密钥 URL，独立检查预期摘要与 outcome=approved。

初版私钥由受控 Worker
secret 提供，仅签名路径可用；正式运行要明确保管与轮换负责人，风险需要更强隔离时接外部签名服务。公钥与泄露/退役状态通过版本化、可认证来源的 trust-bundle 分发；验证器报告所用版本与新鲜度。退役不等于泄露，不能混为同一种拒绝规则。

## 实现前必须证明

1. D1/Worker 真实运行时验证 batch 原子回滚、条件更新、唯一约束与并发先后；覆盖两人批准/拒绝、请求方撤回、Grant 撤销、名单移除、审计/outbox 原子性和过载失败。SQLite 本地适配器测试不是 D1 排队、读复制或过载行为证明。
2. Worker 签名与独立 Node.js 验证器的交叉向量一致；拒绝、摘要不匹配、错误算法、泄露密钥和旧快照均不误放行。
3. JSON
   Schema 执行有复杂度/大小约束，身份绑定与 step-up 不可伪造；浏览器无权限页和日志不泄漏载荷。
4. 同源静态部署、结构化日志/traces、错误标识、migration、D1 备份/恢复和 outbox 告警可被运维验证；不把 build/dry-run 当上线。

## D1 已知平台边界（2026-10-14 官方文档核对）

- D1 单个数据库一次处理一个查询；并发会排队，队列满时返回 overloaded。吞吐和过载恢复需在目标账户/负载下测试。
- 官方 limits 文档列出每条 SQL 最大长度 100
  KB、查询最长 30 秒、每条查询最多 100 个绑定参数；batch 内每条语句分别受其单条查询限制。将阈值视为平台当前文档值，部署前重新检查。
- `batch()`
  中途失败会回滚该事务序列；需要显式测试“状态更新成功但后续 audit/outbox 约束失败”的整批回滚。
- 启用读复制时，跨请求因果读取应使用 D1 Sessions 的 sequential
  consistency/bookmark 能力；session 是读一致性机制，不替代 batch 的事务写入边界。
- 所核对的官方文档描述自动提交与 batch 事务边界；未找到官方明确声明“手写 BEGIN/COMMIT 一概不支持”，因此不把它说成已证实限制。设计依赖受支持的
  `batch()`，不依赖手写跨调用事务。

官方复核入口：[D1 Database API / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、
[D1 Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)、
[D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)、
[Workers](https://developers.cloudflare.com/workers/)。
