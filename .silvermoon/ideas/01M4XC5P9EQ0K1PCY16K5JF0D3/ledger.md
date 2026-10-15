# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 实现独立 Agent 认证与直接权限
- [x] **I-S02:** 集成请求与调用方恢复
- [x] **I-S03:** 验证身份与故障边界

### Implementation acceptance criteria

- [x] **I-AC01:** Agent 不借用人类权限
- [x] **I-AC02:** 调用方不误放行
- [x] **I-AC03:** 人类与 Agent 链路可追溯

## Deployment

### Deployment steps

- [ ] **D-S01:** 配置受限调用方身份
- [ ] **D-S02:** 演练在线阻塞与恢复
- [ ] **D-S03:** 演练失效与网络故障

### Deployment acceptance criteria

- [ ] **D-AC01:** 调用方认证真实可用
- [ ] **D-AC02:** 工作流能安全恢复
- [ ] **D-AC03:** 故障不会变成放行
