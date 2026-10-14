# 技术选型

本文是 [Idea.md](Idea.md)
的技术可行性设计，按目标产品选择，不要求兼容半成品。本轮不改应用依赖、不替换运行代码。以下是拟议栈，不是现有能力清单。

## 前端

| 层         | 选择                                                  | 理由                                                              |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| 应用       | TypeScript + React 19 + Vite                          | 工作台 SPA，首版无需 SEO/SSR；成熟组件生态与静态部署              |
| 路由       | React Router                                          | 请求/模板/授权的稳定深链接、登录后回跳、错误页面                  |
| 服务端状态 | TanStack Query                                        | 查询缓存、分页、轮询取消、错误退避和决定后的失效刷新              |
| 表单与校验 | React Hook Form + Zod；业务载荷使用 Ajv / JSON Schema | Zod 校验 API envelope；Ajv 校验版本化业务 payload；两者职责分开   |
| 视觉与交互 | CSS design tokens + Radix UI 可访问 primitives        | 统一排版、状态和焦点；只按需用 Dialog/Popover，不先建立庞大组件库 |
| 测试       | Vitest + Testing Library + Playwright                 | 组件状态、键盘操作与跨页面主路径分别验证                          |

后端是唯一信任边界。前端展示的权限、摘要和“可审批”状态都是提示，不能代替后端检查；请求超时后不能直接把 mutation 视为成功。

## 后端与持久化

| 层         | 选择                                                                | 理由                                                                                          |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| API        | Cloudflare Workers + Hono + TypeScript                              | 符合构想托管边界，类型化 HTTP 路由，静态资源与 API 同源                                       |
| 业务数据库 | 托管 PostgreSQL，经 Cloudflare Hyperdrive 访问                      | 授权关系、终态竞争、审计和签发任务需要清晰的事务/锁边界；从模型需要出发，不沿用已有数据库选择 |
| 数据访问   | Drizzle + 参数化 SQL + 显式迁移                                     | 常规关系查询保持类型安全；关键锁/条件更新明确用 SQL，不隐藏并发规则                           |
| 输入协议   | Zod envelope + Ajv JSON Schema，服务端执行                          | 严格字段、body 大小/深度/复杂度限制；拒绝未知协议版本，限制 schema 关键字与外部引用           |
| 摘要与签名 | RFC 8785 JCS、SHA-256、标准 JWS / ES256；使用经过维护的 JOSE 实现   | 固定规范化封装与算法，避免自造凭证格式及密码学                                                |
| 恢复签发   | PostgreSQL 事务性 outbox + 可重试签发处理器                         | 决定、审计、签发任务同时落库；签名失败不能丢失任务或回退决定                                  |
| 部署与质量 | pnpm workspace、明确版本锁定、CI 格式/lint/类型/测试/构建，Wrangler | 同一代码与协议可复现，部署与数据迁移分别审查                                                  |

不用数据库以外的缓存判断审批资格，也不因“边缘运行”就把完整身份图分散到多个存储。PostgreSQL 比单库轻量原型增加运维成本，换来显式关系事务；选择受管服务降低备份/恢复负担。最终供应商、地域和成本在部署阶段确定，不在本轮开通资源。

## 认证与授权

- 人类使用标准 OIDC/OAuth 登录，由 Gate 维护 `(issuer, subject)` →
  Identity 绑定和服务端会话；选择能提供可验证 MFA/step-up 证据的身份提供商。认证集成候选为 Auth.js，需先验证 Workers 兼容性与 session/MFA 语义，不把普通 OAuth 登录当作强认证。
- Agent 使用独立 workload 身份与短期 token，验证 issuer、audience、有效期和撤销状态；凭据不进浏览器。首版发行方采用 Gate 自有受控认证入口，外部 workload
  federation 以后再扩展。
- cookie 会话写入检查 CSRF/Origin；Agent
  bearer 路径独立验证 audience/scope，不通过关闭浏览器保护实现接入。HTTP
  scope 不代替数据库里的 Delegate/Grant 检查。
- 授权模块集中检查身份有效性、资格名单、操作范围、Grant 时间/撤销、认证强度；请求详情、列表、创建和决定都复用同一策略。

## 原子决定与签发路径

```text
React SPA / Agent
       │ 认证、校验、逐操作授权
       ▼
Hono Worker → PostgreSQL 事务
              ├─ 检查并保护相关权限状态
              ├─ pending → 唯一终态
              ├─ 冻结 Decision 与授权证据
              └─ 追加 AuditEvent + issuance outbox
                                  │
                          可重试签名处理器
                                  ▼
                         不可变 JWS 凭证
                                  │
                      独立验证器 + trust-bundle
```

决策与撤销/名单变更必须共用一致的事务锁顺序或 SERIALIZABLE 隔离策略，不能先查权限再无条件写请求。事务冲突有限重试，重试后重做授权检查；请求终态唯一约束为最后防线。签名在事务外执行，签发任务记录状态和错误；恢复时只签冻结 claims，同一 Decision 保存并返回同一凭证。

初版可由受控定时 Worker 扫描 outbox 处理任务；扫描频率、抢占租约、重试上限和失败告警在实现前证明。若吞吐需要，再接消息队列；outbox 仍是持久化事实，不以
`waitUntil` 代替可靠任务。

## 凭证协议与密钥边界

JWS
header 固定 alg 和 keyId；claims 固定 protocolVersion、issuer、requestId、模板/schema 版本、outcome、payloadDigest、authorityIdentity、actorIdentity、授权证据及 decidedAt。验证器禁止由 token 自选算法或远程密钥 URL，独立检查预期摘要与 outcome=approved。

初版私钥由受控 Worker
secret 提供，仅签名路径可用；正式运行要明确保管与轮换负责人，风险需要更强隔离时接外部签名服务。公钥与泄露/退役状态通过版本化、可认证来源的 trust-bundle 分发；验证器报告所用版本与新鲜度。退役不等于泄露，不能混为同一种拒绝规则。

## 实现前必须证明

1. PostgreSQL/Hyperdrive 驱动与事务隔离在目标 Worker
   runtime 可用；竞态测试覆盖两人决定、撤回、撤销 Grant、移除资格与签发恢复。平台连接、CPU/内存与事务限制以当时官方文档及实测确认。
2. Worker 签名与独立 Node.js 验证器的交叉向量一致；拒绝、摘要不匹配、错误算法、泄露密钥和旧快照均不误放行。
3. JSON
   Schema 执行有复杂度/大小约束，身份绑定与 step-up 不可伪造；浏览器无权限页和日志不泄漏载荷。
4. 同源静态部署、结构化日志/traces、错误标识、迁移、数据库备份恢复和 outbox 告警可被运维验证；不把 build/dry-run 当上线。

官方复核入口：[Hyperdrive](https://developers.cloudflare.com/hyperdrive/)、
[Workers](https://developers.cloudflare.com/workers/)、[PostgreSQL transactions](https://www.postgresql.org/docs/current/transaction-iso.html)。本轮 Cloudflare 官方页面受网络解析限制，未验证平台具体限额；上述 runtime 证明是选型落地前置条件，不宣称已经完成。
