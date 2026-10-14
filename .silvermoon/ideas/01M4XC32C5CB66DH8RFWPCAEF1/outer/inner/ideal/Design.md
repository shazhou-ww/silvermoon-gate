# MVP 1 详细设计

本文件支撑 [Idea.md](Idea.md) 的已接受范围；[业务模型](Business-model.md)
是身份、权限、关系与生命周期的设计依据。只设计第一轮，不实现 Agent、Delegate/Grant、MFA、签名、outbox、离线验证或模板后台；本轮没有改动生产代码。

## 1. 最小产品与技术

- 受限测试环境内，Lin 发起测试发布请求，Kai 以独立人类身份决定；第三个已登录但无相关权限的身份用于访问隔离验证。允许一个身份具有两类直接权限，但不能决定自己创建的请求。
- React + TypeScript + Vite、shadcn/ui 与语义 CSS-variable tokens；React
  Router 处理深链接，TanStack Query 管列表/详情，局部纯 `useReducer`
  管核对/确认。不为首轮安装跨页 Zustand store，避免重复保存服务端请求事实。
- 表单用 React Hook Form；API envelope 用 Zod，业务 JSON
  Schema 用 Ajv，客户端仅提示，服务端校验是最终边界。采用 GitHub
  OAuth 的一个登录入口及 Gate 管理的会话/身份绑定；Auth.js 适配必须验证稳定 subject、CSRF 与过期语义，不把默认 session 字段当作授权设计。
- Hono Worker + D1
  binding，参数化 SQL 与显式 migration。所有业务记录留在一个 D1 数据库；初版不启用读副本，不引入 ORM、队列或独立服务。

## 2. 预置模板与业务载荷

预置 `release-review` v1、schema
v1，标题“测试发布审核”。只有测试发布场景：Gate 不执行发布、不接受生产环境发布，避免低保证试点被用在高风险流程。

| 字段             | 类型与校验                    | 展示                              |
| ---------------- | ----------------------------- | --------------------------------- |
| `action`         | 必须是 `"release"`            | 操作：发布                        |
| `candidate`      | 1–100 字符，非空、不仅空白    | 业务标题的版本名称                |
| `artifactDigest` | `sha256:` + 64 位小写十六进制 | 被审阅构建产物的摘要，可展开/复制 |
| `environment`    | 必须是 `"test"`               | 测试环境                          |
| `summary`        | 1–500 字符，非空、不仅空白    | 请求方说明，按纯文本显示          |

payload 为对象、以上字段必填、禁止额外属性。`artifactDigest`
是构建产物的业务摘要，与 Gate 对**整份载荷加 schemaVersion**计算的
`payloadDigest` 不同；必须分开命名和展示。不加载用户 schema 或远程 `$ref`。

新建 body 最多 16
KiB，输入字段有长度限制；schema/envelope 固定且浅层，不接受任意深层结构。不得静默 trim/改写已提交 payload；字段不合格返回错误。摘要以服务端固定的 JCS 封装计算，解析器/JCS 拒绝不合法 Unicode/数值。

`threadId`
可选 1–100 字符纯文本，按 requester 命名空间分组；它不授予权限。标题从已校验 candidate 派生，不作为审批对象。模板与直接名单通过受控配置/迁移初始化，禁止通过浏览器自行选择 requester/actor 或扩大权限。

## 3. 页面与状态

| 路径             | 首屏与主要动作                                     | 特殊状态                                                                |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `/login`         | 试点限定说明、GitHub 登录                          | 未获准身份/停用/提供商故障显式错误；无其他提供商按钮                    |
| `/requests/mine` | 创建入口、按时间倒序的我的请求，状态/版本/创建时间 | 加载、空、失败分开；仅支持状态筛选与游标分页                            |
| `/requests/new`  | 固定模板说明 → 业务字段 → 核对                     | 字段错误保持输入；回退修改使旧核对结果失效                              |
| `/inbox`         | 当前直接有权处理的 pending，业务标题和 requester   | 自己发起的请求不进入待办；无待办与读取失败分开                          |
| `/requests/:id`  | 业务字段、固定版本、完整摘要、状态、历史           | requester 可撤回；其他合格审批人可批准/拒绝；无权统一“不可访问或不存在” |

默认登录后进入
`/inbox`，没有决定权限也可进入只显示空态并链接“我的请求”；不伪造授予权限。有效同源回跳在登录前保留，拒绝外域、协议相对路径和不允许路由。

### 创建与核对

核对页显示 environment=test、candidate、artifactDigest、summary、模板/schema 版本；明确“创建后不可编辑”。用户回退编辑必须重新核对，只有核对当前内容才启用提交。

初次提交生成一个
`Idempotency-Key`，发送期间禁用重复提交。超时保留这次内容和键，显示“结果尚未确认”，允许**原样重试**；内容改变用新键。收到同键不同内容的 409 时解释冲突，可跳转有权读取的原请求，不自动新建。草稿只留当前页面内存，不写 localStorage；离开未提交页面提示丢失草稿。

### 决定与撤回

“准备批准/拒绝”进入内联确认，重述实际人类身份、固定请求与摘要，明确不可修改/首个决定生效。不得预选批准；取消恢复到触发按钮。真正提交前如会话过期需重新登录，不用 UI 复选框制造 MFA 保证。

requester 只可撤回 pending；说明不删除历史。批准/拒绝/撤回在传输中禁用；超时不自动重发决定，先刷新已授权详情。仍 pending 时重新确认；已结束则展示真实 actor/时间/动作并移除按钮。409 不显示本次决定成功。

终态页面不出现下载签名凭证；显示“在线结果，无离线凭证”。拒绝/撤回后可“基于此请求新建”，复制固定字段到新草稿，生成新请求/新键并重新核对。

### 历史与读取

详情展示创建及唯一终态事件；显示实际 actor 与当时稳定身份，可对比当前显示名称但不改旧证据。read 权限以 active
requester 或当前 active 合格审批人为准；名单移除或身份停用后，不因过去处理过就继续公开载荷。

TanStack
Query 使用当前 Identity 的查询命名空间；登出、会话/身份切换或 401 时取消相关请求并清除载荷缓存；403/404 后立即移除详情及历史，不能继续展示旧缓存。禁止先下载全量后前端过滤。

等待请求初期每 15 秒刷新，隐藏页面暂停、网络错误有界退避（上限 60 秒），提供手动刷新；终态停止轮询。自动查询失败保留“最后确认时间/状态可能陈旧”并显示错误，不声称成功，也不将未知错误当无权限。

### 视觉与可访问性

使用 shadcn 的 Card、Form、Button、Badge 与 Alert 语义，中文文案、可见 focus、44px 目标触控高度；不引入复杂管理导航。桌面列表清楚显示核心事实，320px 单列；长摘要可换行/复制，JSON 仅局部滚动。状态有文字与 aria-live，确认区标题可聚焦，键盘阅读顺序一致。最终服务七场景示意仅作风格参考，不表示首轮全部菜单可用。

## 4. API 契约

所有 `/api/*` 返回 JSON，认证/载荷响应
`Cache-Control: no-store`；无效路由不回落 SPA。时间使用 UTC RFC
3339，ID 为稳定不可复用不透明值。

| 方法与路由                        | 输入                                                                         | 输出/行为                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/me`                     | 人类会话                                                                     | Identity ID、显示信息和用于导航的资格摘要；不是可用于写入的授权证明                       |
| `GET /api/templates`              | 会话                                                                         | 当前可创建的预置版本及固定 schema 描述                                                    |
| `POST /api/requests`              | `Idempotency-Key`；templateId/version、schemaVersion、payload、可选 threadId | 201 新建 / 200 相同内容重放，`{request, replayed}`                                        |
| `GET /api/requests?view=mine      | inbox`                                                                       | 可选 status；limit 1–50（默认20）、cursor                                                 | `{items,nextCursor}`，服务端先授权再分页；inbox 仅 pending |
| `GET /api/requests/:id`           | 会话                                                                         | `{request,events,allowedActions}`；事件与状态使用同一数据库快照，避免终态与历史暂时不一致 |
| `POST /api/requests/:id/decision` | `{decision:"approve"                                                         | "reject"}`                                                                                | 成功 200 返回真实结果；不接受 actor/requester 字段         |
| `POST /api/requests/:id/withdraw` | 空 JSON 对象                                                                 | 成功 200；仅 requester 的 pending 可写                                                    |

cursor 使用 `(createdAt,requestId)`
稳定排序，绑定 Identity、view 和筛选；不透明、防篡改，不用页码 offset。任何 cursor 仍重新做授权，不能作为 access
capability。不包含完整载荷或 secret。

错误 envelope 为
`{error:{code,message,traceId,fieldErrors?}}`，不暴露 SQL、secret 或内部堆栈；`traceId`
为请求跟踪 ID，与业务 `requestId` 分开。首轮约定：

| HTTP | code                                        | UX                                            |
| ---- | ------------------------------------------- | --------------------------------------------- |
| 400  | `INVALID_INPUT`                             | 字段附近错误，不丢草稿                        |
| 401  | `SESSION_REQUIRED`                          | 重新登录并安全回跳                            |
| 403  | `ACTION_NOT_ALLOWED`                        | 已获授权可见请求但操作权限失效；不附载荷      |
| 404  | `REQUEST_NOT_ACCESSIBLE`                    | 不存在与无读取权统一，优先于暴露终态冲突      |
| 409  | `IDEMPOTENCY_CONFLICT` / `REQUEST_TERMINAL` | 同键冲突或已终态；获授权后才返回冲突详情      |
| 413  | `PAYLOAD_TOO_LARGE`                         | 大小提示且保留输入                            |
| 503  | `SERVICE_BUSY`                              | 明确可重试/结果未确认；不声称数据库仍 pending |
| 500  | `INTERNAL_ERROR`                            | 显式失败与跟踪 ID；记录脱敏日志               |

响应丢失不代表写入失败，即使 5xx/连接中断也先确认结果；不得自动给失败请求换新幂等键。

## 5. 身份、安全与配置

GitHub OAuth
code/callback 由认证库处理 state、CSRF 和 session；只把经过验证的 provider
subject 映射到预置 Gate
Identity。未注册外部账号登录后不给创建/审批权限，不按邮箱自动创建特权或关联身份。

试点由运维确认稳定 subject 与允许的两个人类身份，通过受控初始化配置身份及模板资格。运维写入同时留配置审计；暂无浏览器管理端点，不把任意环境变量里的显示名字当授权。

服务端维护可撤销会话记录（Identity、期限、generation），浏览器只持安全会话 cookie；过期或注销后不能只靠 UI 清缓存。cookie 为 HttpOnly、Secure（HTTPS 环境）、合适 SameSite；写请求必须验证 CSRF/同源 Origin、JSON 类型和 body 限制。身份启用/会话失效事实进入决定 SQL 条件，不能只在中间件做一次缓存检查。

日志仅记跟踪 ID、动作、稳定 ID、状态与错误分类，不输出 cookie、OAuth 材料、完整 payload/summary。所有展示文本转义，不把 summary 或 schema 说明当 HTML。

## 6. D1 原子写入设计

### 创建

服务端校验固定模板与 schema，规范化 payload 后计算摘要和完整创建内容指纹。一次随机 requestId 对应一次创建尝试；使用唯一
`(requester,idempotencyKey)` 和**定向**冲突处理，而非吞掉所有约束错误的
`INSERT OR IGNORE`。

在同一 batch 中检查 active
Identity、有效 session、create 资格与模板可创建状态，插入请求，并仅为本次新 requestId 追加 created
event。同键重放不生成新事件；成功后读取原记录并对比指纹，不同内容为409。超时原样重试仍只存在一份请求及一条 created
event。

### 决策与撤回

每次写入生成随机
`operationId`。条件 UPDATE 同时要求 request.status=pending、active
actor、有效 session、当前直接资格（决定时 actor≠requester；撤回时 actor=requester），并固定终态 actor、数据库时间和 operationId。

同 batch 后续 `INSERT ... SELECT`
**必须限定本次 operationId 赢得请求终态**：批准/拒绝创建唯一 Decision，并冻结身份/资格修订与直接权限证据；所有终态创建唯一事件。零行更新是正常竞争/权限失败，不会自动导致 batch 报错，因此后续插入也必须为零行，不得仅根据“已经 approved”补造本次操作者的证据。

以 `meta.changes === 1`
判断赢家；Decision.requestId 唯一、终态事件 requestId 唯一（可用终态 partial
unique
index）、operationId 唯一及不可变 trigger 是防线。后续插入发生约束/故障时整 batch 回滚，不能捕获后返回成功。

### 一致性与故障

- 身份/会话/资格启停也经 D1 原子配置写入，决定 SQL 使用数据库时钟核对会话期限，避免排队期间使用客户端旧时间。撤销先执行则决定失败，决定先执行则历史有效，不以客户端点击时间定义先后。
- 详情/事件读取采用同一 SQL 聚合或受控只读 batch 快照，并同时授权；禁止先读已授权 payload 再独立读取可能暴露另一权限状态的历史。
- 初期关键读写走 primary，不启用 read
  replication；以后启用时另行设计 Sessions/bookmark 和授权读取一致性。
- 明确可重试且未提交的过载允许短有界退避；结果不明的决定先查询再确认，创建仅同键重试。D1
  single database 排队和真实 runtime 全回滚需要验证，不用 JavaScript
  Promise.all + 内存 SQLite 冒充云端并发。
- 本阶段只原子保存请求/Decision/审计，**不建签发 outbox**；MVP
  3 的签发任务会在新版本事务中追加，不能在首轮 UI 暗示存在。

## 7. 可测闭环与落地前置

| 案例                               | 必须观察的结果                                                   |
| ---------------------------------- | ---------------------------------------------------------------- |
| Lin 创建，Kai 批准/拒绝            | 请求、唯一 Decision、两条生命周期事件一致；直接 actor=authority  |
| 自己审批、无资格第三人访问         | 自审批失败，第三人详情404；无 payload/事件泄漏                   |
| 同键同内容并发 / 同键异内容        | 一请求、一 created event；异内容409且不覆盖                      |
| 两位合格人竞争决定 / 决定竞争撤回  | 恰一个终态，败者409，无重复 Decision/终态事件；撤回没有 Decision |
| 名单移除/身份停用/会话到期先于提交 | 条件更新零行，pending 和事件不变，界面清除失去读取权的数据       |
| 更新成功后 audit/Decision 插入故障 | batch 全回滚，仍 pending，无孤立决定或终态事件                   |
| 决定成功但响应丢失                 | 再查询发现真实终态，不重新决定或显示假成功                       |
| 登录回跳、切换身份、登出           | 无外域跳转，会话真正失效，缓存取消/清空，无跨身份残留            |
| 重启 Worker / D1 恢复读取          | 原 ID、payloadDigest、决定与历史一致；不宣称完整备份恢复已完成   |
| 1440px / 320px + 键盘              | 可创建/确认/取消/撤回，focus恢复，状态可读、无页面横向溢出       |

先做契约和 SQL 约束测试，再用本地 Worker/D1
runtime 故障注入和浏览器测试，最后在明确授权的隔离云端 D1 验证排队竞争及真实双人试点。外部环境或参与者缺失时保持未完成，不替用户登录、不部署生产，也不勾选验收。

本设计未执行上述生产能力测试。下一步仅审阅 MVP
1 的详细边界；接受设计后再分步实现，后两轮 Idea 不自动开始。
