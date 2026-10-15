# MVP 1 实现与验证证据

## 已交付的仓库能力

- GitHub 单一认证入口、Gate 稳定身份/直接权限、D1 可撤销会话及 generation/期限检查；未配置 OAuth 时不提供虚假可用的登录。
- 固定测试发布 schema 的请求创建、幂等重放/冲突、授权游标分页、详情/历史、禁止自审批、批准/拒绝/撤回；operationId 绑定赢家证据，Decision/审计与终态同 batch 保存。
- React 中文登录与安全回跳、我的请求、待我审批、新建核对、详情内联确认、结果不明与错误恢复；身份隔离查询缓存、登出/失效后清理，15秒等待状态轮询。
- 本地拥有的 shadcn 风格语义组件与 CSS-variable tokens；服务端状态 TanStack
  Query，表单 React Hook Form/Zod，确认/核对纯 reducer；没有添加无需要的全局 UI
  store。
- 保留旧原型数据库历史的增量迁移；移除浏览器管理员写模板/名单入口，不引入认证测试后门；未实现后轮 Agent、委托、MFA、签名或 outbox。

## 自动化检查

2026-10-15 本地执行（替代此前格式门禁阻断的记录）：

| 检查                                     | 结果与范围                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                             | 格式、lint、typecheck、test、build 全通过；三个 workspace 共 12 个目标成功，contracts 23、Worker 55、web 44 个测试通过，合计 122 个；Worker 构建仅 dry-run                                                         |
| Worker coverage                          | statements98.51%、branches96.53%、functions100%、lines98.84%；保留90%门槛                                                                                                                                          |
| web coverage                             | statements97.70%、branches95.53%、functions97.46%、lines99.64%；仅排除入口挂载文件main.tsx，保留90%门槛                                                                                                            |
| local workerd/D1                         | 实际 Miniflare5 runtime 的原子写入探针通过：竞争单赢家、自审批拒绝、资格/身份失效拒绝、审计故障全 batch 回滚                                                                                                       |
| 生产迁移与 HTTP Worker 探针              | 使用两个实际 migration 与打包 Worker，在本地 D1 验证创建/重放/冲突、决定/撤回竞争、权限失效、会话隔离、Decision/审计故障回滚；Auth.js callback/encode 签发测试会话，未加生产绕过入口                               |
| Chromium UI                              | 使用真实 Vite/React 与测试拦截 API 的一致 fixture；1440px/320px下四条主路由无页面横向溢出/脚本错误，已目视检查；确认前不写入、取消恢复focus、确认后单次写入并显示批准、新建先核对已验证                            |
| Chromium → 生产静态资源/Worker → 本地 D1 | 新增两个可重复的 1440px/320px 测试，无浏览器 API 拦截；各自完成创建/批准/拒绝/撤回、第三身份隔离、自审批按钮缺席、键盘确认取消与焦点恢复、审计故障回滚后的重新确认、名单撤销后清除载荷；主路由无横向溢出或脚本错误 |
| 本地持久化与注销                         | 隔离的项目内 D1 路径，释放并重新创建 Miniflare 后，原加密会话仍可读取固定载荷、终态操作人及两条历史；经真实 Auth.js 注销表单后，重放注销前旧 cookie 返回 401；测试结束释放运行时/浏览器并删除隔离数据              |
| 同键并发                                 | 真实 HTTP Worker/D1 三次同时创建，状态为 201/200/200，返回同一个 requestId，只有一条 created 事件；原有决定竞争及证据故障回滚测试继续通过                                                                          |

本地 OAuth account 输入由测试伪造以验证已认证后的映射，不等于完成 GitHub
provider 登录。此前 API 拦截浏览器检查只证明前端行为；新增完整本地浏览器链路也未连接 GitHub 或云端，不证明真实双人身份。Miniflare/workerd 不是云端 D1 的排队/过载/区域可用性证明。故障注入产生的脱敏
`INTERNAL_ERROR` 日志是预期的 500/回滚证据，不代表通过时遗漏错误。

## 本轮有界审阅与修复

- 未配置 OAuth 时，原登录页仍展示会失败的 GitHub 登录链接；现从 `/api/bootstrap`
  确认提供商，未配置或读取失败时不展示入口，读取失败可重试。新增两个组件测试，真实浏览器注销后的页面也覆盖未配置状态。
- 列表 API 曾允许
  `limit=100`，与已接受设计的 1–50 不一致；现限制为 50，非法过滤器测试覆盖
  `limit=51`。未修改设计标准或服务端身份/直接权限检查。
- 仅使用 Prettier 修复原有五个格式阻断文件：
  `.agents/skills/business-data-model-review/SKILL.md`、
  `.agents/skills/ui-change-review/SKILL.md`、该技能的
  `assets/review-index.html` 与 `assets/review-scenario.html`，以及最终 Idea
  `01M4WTDSPTZT9PJR5QP77C9VC0` 的
  `outer/inner/ideal/Design-notes.md`；不修改这些文件的设计或技能语义。

## 数据与启动

真实本地 Worker/D1 探针已保留为可重复执行的
[d1-runtime.test.ts](../../../../../apps/worker/test/d1-runtime.test.ts)，使用生产源码内存打包、两份生产迁移和 Auth.js 加密会话，限时60秒并释放运行时；随 Worker 测试一起执行。

完整浏览器链路保留为
[browser-runtime.test.ts](../../../../../apps/worker/test/browser-runtime.test.ts)，每个视口限时 120 秒；复用
[runtime-migrations.ts](../../../../../apps/worker/test/runtime-migrations.ts)
执行两份生产迁移。首次检查前执行
`pnpm --filter @workspace/worker exec playwright install chromium`，随后
`pnpm check`
会先构建 web 再运行测试；CI 已增加 Chromium/系统依赖安装。Playwright 使用 pnpm 共享 catalog，未新增测试登录接口或生产环境开关。

参见 [README](../../../../../README.md)
的迁移、OAuth与预置身份说明。先在明确选定的本地环境应用两个 migration，再用独立核对的 GitHub
subject 配置两个 Gate身份与create/decide资格。身份/名单修改需提高revision，不猜测已有subject、不删除旧历史。

数据库会话期限为8小时；退出登录/撤销和Identity
generation变化会使旧会话失效。任何直接权限变更须经过受控运维写入与配置审计，不能从前端自行指定actor或审批权。

## 当前 session 的委托审阅结论

2026-10-15，用户授权逐阶段由子 agent 实施、当前 session 负责 review 和 gate 决策，只有无法确定的决策才上报。本轮由一个独立子 agent 完成 MVP
1 本地收尾，当前 session 审阅变更与可重复测试；此授权不等于未验证的 OAuth/云端结果已经通过，也不构成生产部署授权。

本地实现检查通过，但按当前契约尚不能记录完整实现/部署接受：真实 provider 登录与独立三身份试点、目标云端 D1 的相关证明仍缺失。因此没有伪造
`acceptInner` / `acceptOuter`，也不通过豁免或降低标准绕过实际外部前置。MVP
2 实施仍遵守路线中 MVP 1 完成试点的依赖，不抢先展开后续功能。

### 继续推进所需的外部条件

- 明确授权的隔离非生产 Cloudflare
  Worker/D1 环境，以及环境负责人允许的资源创建/迁移/部署范围；本轮未尝试云端写入。
- 由负责人通过安全渠道配置 GitHub OAuth
  App 的 ID/secret、AUTH_SECRET 与同源回跳，不在聊天、仓库或日志公开真实凭据。
- 两位真实参与者及一个无权限测试身份，通过 GitHub 登录，由运维独立核对稳定 subject 并配置权限；代理不能替用户完成真实登录或伪造参与证据。

条件具备后继续由阶段子 agent 执行试点，当前 session 按证据判定 gate；此处是执行前置报告，不要求重新决定已确定的产品范围或日常技术选型。

## 外部验收明细

- 本轮未读取真实凭据或 `.dev.vars`；尚未提供/核验 GitHub OAuth
  App 归属、授权回调域名、真实凭据及受控运维负责人。
- 需要请求方、独立审批人及无权限第三身份参与真实 OAuth 流程，由运维独立核验稳定 GitHub
  subject 并受控配置 Gate Identity 与直接权限。
- 需要明确授权的受限非敏感 Cloudflare/Worker/D1 试点环境，核验 migration、同源入口与 secrets；本轮没有创建、迁移或改变任何云端资源。
- 未执行GitHub真实双人登录及第三身份隔离试点，未部署生产或修改DNS、生产secret/Cloudflare资源。
- 云端D1排队/过载恢复、真实服务重启后查询及全部Deployment验收仍待授权环境和参与者。
- 本地重启持久化已通过，但不能替代云端真实服务重启、排队/过载恢复及Deployment 验收证据。试点须另行保存真实人类流程、隔离与历史持久化记录。
- 仓库本地门禁缺口已关闭；上述外部证据仍缺失，不能宣称 MVP 已完整验收，也不据此更改未修改的 Implementation/Deployment 验收标准或勾选其完成项。最终审批与同步由父任务负责，本轮未执行 accept/submit、提交、推送或部署。

后续在受限测试环境完成上述证据后，再同步实现候选并提交Implementation验收；后两个MVP不自动开始。
