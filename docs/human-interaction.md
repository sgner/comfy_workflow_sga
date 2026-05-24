# 人机交互机制

> 📄 相关源文件：`src/server/interaction.ts`（交互类型定义）、`src/core/agent.ts`（Agent 循环暂停/恢复）、`src/server/routes.ts`（用户输入 API）

## 概述

在 Agent 执行过程中，有些场景需要用户参与决策或提供额外信息。SGA-Template 的人机交互机制允许 Agent 在需要时暂停执行，等待用户输入后继续。

## 交互类型

### 1. 审批请求（Approval Required）

当工具执行需要用户确认时触发（例如权限检查返回 `ask`）：

```typescript
// src/server/interaction.ts
export interface ApprovalAction {
  type: 'approval'
  toolName: string
  toolInput: Record<string, unknown>
  message: string
  suggestions?: string[]
}
```

### 2. 输入请求（Human Input Required）

当 Agent 需要用户提供额外信息时触发：

```typescript
// src/server/interaction.ts
export interface InputRequestAction {
  type: 'human_input'
  message: string
  options?: Array<{ label: string; value: string }>
}
```

## 交互流程

![人机交互流程](diagrams/human-interaction.svg)

## SSE 交互事件

### approval_required 事件

```
event: approval_required
data: {
  "type": "approval_required",
  "actionId": "approval-1700000000-abc123",
  "data": {
    "toolName": "Bash",
    "toolInput": { "command": "rm -rf node_modules" },
    "message": "Bash 工具请求执行删除命令，是否允许？",
    "suggestions": ["允许", "拒绝", "修改命令"]
  },
  "sessionId": "sess-xxx"
}
```

### human_input_required 事件

```
event: human_input_required
data: {
  "type": "human_input_required",
  "actionId": "input-1700000000-def456",
  "data": {
    "message": "请选择部署环境",
    "options": [
      { "label": "开发环境", "value": "dev" },
      { "label": "测试环境", "value": "staging" },
      { "label": "生产环境", "value": "prod" }
    ]
  },
  "sessionId": "sess-xxx"
}
```

> ⚠️ `actionId` 是交互请求的唯一标识，客户端提交响应时必须使用此 ID。`actionId` 具有时效性，过期后提交会返回 `{"error": "Invalid or expired action ID"}`。

## 用户输入 API

### 提交审批/输入

```bash
# 审批：允许执行
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-1700000000-abc123",
    "decision": "allow"
  }'

# 审批：拒绝执行
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-1700000000-abc123",
    "decision": "deny",
    "reason": "危险操作"
  }'

# 审批：允许并设置"总是允许"
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-1700000000-abc123",
    "decision": "allow",
    "permissionUpdate": {
      "type": "always_allow",
      "toolName": "Write"
    }
  }'

# 审批：允许并设置模式匹配
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-1700000000-abc123",
    "decision": "allow",
    "permissionUpdate": {
      "type": "allow_pattern",
      "toolName": "Write",
      "pattern": "*.md"
    }
  }'

# 提供输入
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "input-1700000000-def456",
    "value": "prod"
  }'
```

### UserInputRequest 类型

```typescript
// src/server/session.ts
export interface UserInputRequest {
  actionId: string
  decision?: 'allow' | 'deny'
  value?: string
  optionValue?: string
  updatedInput?: Record<string, unknown>
  reason?: string
  permissionUpdate?: {
    type: 'always_allow' | 'always_deny' | 'allow_pattern'
    toolName: string
    pattern?: string
  }
}
```

| 字段 | 说明 |
|------|------|
| `actionId` | 交互请求 ID（来自 SSE 事件的 `actionId` 字段） |
| `decision` | 审批决定：`allow` / `deny` |
| `value` | 自由文本输入值 |
| `optionValue` | 选项值 |
| `updatedInput` | 修改后的工具输入（审批时使用） |
| `reason` | 拒绝原因 |
| `permissionUpdate` | 持久化审批规则（详见下方） |

### PermissionUpdate（持久化审批规则）

当用户审批时附带 `permissionUpdate`，系统会自动创建持久化规则，后续同类操作不再需要审批。

| 类型 | 说明 |
|------|------|
| `always_allow` | 总是允许该工具的所有操作 |
| `always_deny` | 总是拒绝该工具的所有操作 |
| `allow_pattern` | 允许该工具匹配指定模式的操作 |

规则持久化到 `.sga/permissions.json`，详见 [权限控制](permissions.md)。

## 会话状态

人机交互会影响会话状态：

| 状态 | 说明 |
|------|------|
| `active` | 正常执行中 |
| `waiting_input` | 等待用户输入 |
| `completed` | 执行完成 |
| `error` | 执行出错 |

```typescript
// 检查会话状态
const session = getSession(sessionId)
if (session.status === 'waiting_input') {
  console.log('会话等待用户输入:', session.pendingAction)
}
```

## 前端集成示例

```javascript
// 使用 EventSource 监听 SSE 事件
const eventSource = new EventSource('/api/v1/sessions/{sessionId}/messages?stream=true')

eventSource.addEventListener('approval_required', (event) => {
  const data = JSON.parse(event.data)
  showApprovalDialog(data.data, (response) => {
    fetch('/api/v1/sessions/{sessionId}/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionId: data.actionId,
        decision: response.approved ? 'allow' : 'deny',
        permissionUpdate: response.alwaysAllow
          ? { type: 'always_allow', toolName: data.data.toolName }
          : undefined,
      }),
    })
  })
})

eventSource.addEventListener('human_input_required', (event) => {
  const data = JSON.parse(event.data)
  showInputDialog(data.data, (value) => {
    fetch('/api/v1/sessions/{sessionId}/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionId: data.actionId,
        value: value,
      }),
    })
  })
})
```

## 相关文档

- [权限控制](permissions.md)
- [作为后端服务使用](backend-service.md)
- [为任何产品提供 Agent 后端](agent-backend.md)
