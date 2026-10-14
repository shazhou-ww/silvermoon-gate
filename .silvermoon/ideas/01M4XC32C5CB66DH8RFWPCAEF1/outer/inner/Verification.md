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

2026-10-14 本地执行：

| 检查                                            | 结果与范围                                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec turbo run lint typecheck test build` | 三个 workspace 共12个目标通过；contracts23、Worker53、web42个测试通过，合计118个                                                                                                        |
| Worker coverage                                 | statements98.51%、branches96.53%、functions100%、lines98.84%；保留90%门槛                                                                                                               |
| web coverage                                    | statements97.66%、branches95.40%、functions97.36%、lines99.64%；仅排除入口挂载文件main.tsx，保留90%门槛                                                                                 |
| `pnpm check`                                    | 未全通过：源代码目标已单独通过，仓库格式门禁被既有四个 `.agents` 导入技能文件与最终 Idea 的 `Design-notes.md` 格式问题阻断；未改写这些不属于本轮的文件或降低规则                        |
| local workerd/D1                                | 实际 Miniflare5 runtime 的原子写入探针通过：竞争单赢家、自审批拒绝、资格/身份失效拒绝、审计故障全 batch 回滚                                                                            |
| 生产迁移与 HTTP Worker 探针                     | 使用两个实际 migration 与打包 Worker，在本地 D1 验证创建/重放/冲突、决定/撤回竞争、权限失效、会话隔离、Decision/审计故障回滚；Auth.js callback/encode 签发测试会话，未加生产绕过入口    |
| Chromium UI                                     | 使用真实 Vite/React 与测试拦截 API 的一致 fixture；1440px/320px下四条主路由无页面横向溢出/脚本错误，已目视检查；确认前不写入、取消恢复focus、确认后单次写入并显示批准、新建先核对已验证 |

本地 OAuth account 输入由测试伪造以验证已认证后的映射，不等于完成 GitHub
provider 登录。API 拦截浏览器测试只证明前端行为，不证明云端部署或真实双人身份。Miniflare/workerd 不是云端D1的排队/过载/区域可用性证明。

## 数据与启动

真实本地 Worker/D1 探针已保留为可重复执行的
[d1-runtime.test.ts](../../../../../apps/worker/test/d1-runtime.test.ts)，使用生产源码内存打包、两份生产迁移和 Auth.js 加密会话，限时60秒并释放运行时；随 Worker 测试一起执行。

参见 [README](../../../../../README.md)
的迁移、OAuth与预置身份说明。先在明确选定的本地环境应用两个 migration，再用独立核对的 GitHub
subject 配置两个 Gate身份与create/decide资格。身份/名单修改需提高revision，不猜测已有subject、不删除旧历史。

数据库会话期限为8小时；退出登录/撤销和Identity
generation变化会使旧会话失效。任何直接权限变更须经过受控运维写入与配置审计，不能从前端自行指定actor或审批权。

## 外部验收尚未完成

- 本工作区没有 `.dev.vars`，未提供真实OAuth
  App凭据、两位参与者、已授权Cloudflare/D1试点环境。
- 未执行GitHub真实双人登录及第三身份隔离试点，未部署生产或修改DNS、生产secret/Cloudflare资源。
- 云端D1排队/过载恢复、真实服务重启后查询及全部Deployment验收仍待授权环境和参与者。
- 因这些外部证据和仓库既有格式门禁缺口，不能宣称MVP已完整验收或将实现提交为可接受的完整实现revision；ledger保留对应未完成项。

后续在受限测试环境完成上述证据后，再同步实现候选并提交Implementation验收；后两个MVP不自动开始。
