# Implementation

## Steps

### I-S01: 实现独立 Agent 认证与直接权限

注册稳定 Agent 身份、受控认证材料与短期 token，校验 issuer/audience/有效期及失效状态；独立于浏览器 cookie/CSRF 路径。

### I-S02: 集成请求与调用方恢复

提供认证、幂等创建、授权查询与撤回的接入契约和一个 PGH/Agent 示例；调用方核对状态与预期摘要并控制自己的工作流。

### I-S03: 验证身份与故障边界

测试 token 失效、重复创建、权限隔离、网络结果不明与实际 actor 归属，保持 MVP
1 人类流程可用。

## Acceptance criteria

### I-AC01: Agent 不借用人类权限

认证/授权测试证明创建者关系不继承权限，错误 audience、过期/撤销认证及无权限查询被拒绝，secret 不进日志。

### I-AC02: 调用方不误放行

集成测试证明仅 online
approved 且摘要匹配恢复；拒绝、撤回、不匹配、断网与重试都保持阻塞或明确失败。

### I-AC03: 人类与 Agent 链路可追溯

端到端测试记录 Agent 创建者、人类审批 actor、不可变载荷与结果，且 MVP
1 回归通过。
