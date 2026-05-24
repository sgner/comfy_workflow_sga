# 权限控制

> 📄 相关源文件：`src/permissions/checker.ts`（PermissionChecker 类）、`src/permissions/classifier.ts`（权限分类器）、`src/permissions/rules.ts`（规则配置持久化）、`src/tools/built-in/sensitive-paths.ts`（敏感路径检测）

## 概述

权限系统控制 Agent 可以执行哪些操作。每个工具在执行前都会经过权限检查，确保不会执行未经授权的危险操作。权限系统由以下组件构成：

1. **PermissionMode** — 权限模式，控制全局检查策略
2. **PermissionRule** — 规则系统，基于工具名/模式的 allow/deny/ask 规则
3. **PermissionClassifier** — 分类器，基于模式匹配自动决策
4. **SensitivePathChecker** — 敏感路径检测，保护关键文件和目录
5. **PermissionUpdate** — 持久化审批规则，支持"总是允许"功能

## PermissionMode

```typescript
// src/core/types.ts
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'auto'
  | 'bubble'
  | 'dontAsk'
```

| 模式 | 说明 |
|------|------|
| `default` | 默认模式，未匹配规则的工具需要用户确认 |
| `plan` | 计划模式，写操作需要审批 |
| `acceptEdits` | 接受编辑模式，自动允许文件编辑 |
| `bypassPermissions` | 绕过所有权限检查（危险！仅用于可信环境） |
| `auto` | 自动模式，除明确拒绝的规则外全部允许 |
| `bubble` | 冒泡模式，将权限决策传递给上层 |
| `dontAsk` | 不询问模式，未匹配规则时默认允许 |

## PermissionChecker

```typescript
import { PermissionChecker } from 'SGA-Template'

const checker = new PermissionChecker({
  mode: 'default',
  rules: {
    allow: [{ tool: 'Read', behavior: 'allow' }],
    deny: [{ tool: 'Bash', pattern: 'rm -rf', behavior: 'deny', reason: '危险命令' }],
    ask: [{ tool: 'Write', behavior: 'ask' }],
  },
  classifier: createDefaultClassifier(),
  isBypassPermissionsAvailable: true,
  isAutoModeAvailable: true,
  shouldAvoidPermissionPrompts: false,
})
```

### 检查权限

```typescript
const result = checker.check('Bash', { command: 'ls -la' })
// result: { behavior: 'allow' | 'deny' | 'ask', reason?: string, matchedRule?: PermissionRule }
```

### 检查流程

权限检查按以下优先级进行：

1. **规则匹配** — 遍历 deny → allow → ask 规则，匹配则直接返回
2. **分类器决策** — 规则无匹配时，调用分类器自动决策
   - `deny` 且 confidence ≥ 0.8 → 拒绝
   - `allow` 且 confidence ≥ 0.85 → 自动允许
   - 其他 → 返回 `ask`
3. **模式兜底** — 分类器无明确决策时，根据 PermissionMode 返回默认行为

### 动态添加规则

```typescript
checker.addRule({ tool: 'Write', behavior: 'allow', pattern: '*.md' })
checker.addRule({ tool: 'Bash', behavior: 'deny', pattern: 'rm', reason: '禁止删除命令' })
```

### 更新配置

```typescript
checker.updateConfig({
  mode: 'auto',
  shouldAvoidPermissionPrompts: true,
})
```

## PermissionRule

```typescript
// src/permissions/checker.ts
export interface PermissionRule {
  tool: string
  pattern?: string
  behavior: 'allow' | 'deny' | 'ask'
  reason?: string
}
```

| 字段 | 说明 |
|------|------|
| `tool` | 工具名称 |
| `pattern` | 匹配模式（可选，用于匹配工具输入中的特定内容） |
| `behavior` | 匹配时的行为 |
| `reason` | 原因说明 |

### 规则配置文件

权限规则可持久化到配置文件，支持项目级和全局级：

- **项目级**：`.sga/permissions.json`
- **全局级**：`~/.sga/permissions.json`

项目级优先于全局级。

```json
{
  "version": 1,
  "rules": {
    "allow": [
      { "tool": "Read", "behavior": "allow" },
      { "tool": "Glob", "behavior": "allow" },
      { "tool": "Grep", "behavior": "allow" }
    ],
    "deny": [
      { "tool": "Bash", "pattern": "rm -rf", "behavior": "deny", "reason": "危险删除命令" },
      { "tool": "Write", "pattern": ".env", "behavior": "deny", "reason": "不允许写入环境变量文件" }
    ],
    "ask": [
      { "tool": "Write", "behavior": "ask" },
      { "tool": "Edit", "behavior": "ask" }
    ]
  }
}
```

## PermissionClassifier（权限分类器）

分类器基于模式匹配自动决策，减少不必要的审批提示。

### DefaultPermissionClassifier

```typescript
import { createDefaultClassifier } from 'SGA-Template'

const classifier = createDefaultClassifier()
const result = classifier.classify('Read', { path: '/src/index.ts' }, context)
// result: { decision: 'allow', confidence: 0.9, reason: 'Safe read-only tool: Read', ruleId: 'safe_read_tool' }
```

#### 分类规则

| 类别 | 规则 | 决策 | 置信度 |
|------|------|------|--------|
| 安全只读工具 | Read, Glob, Grep, WebSearch, WebFetch, LS, LSP, TodoRead | `allow` | 0.9 |
| 安全写模式 | 写入 .md/.txt/.json 文件、只读 bash 命令、npm install | `allow` | 0.8 |
| 危险模式 | rm -rf, dd, mkfs, 写入 .env/.ssh 等关键路径 | `deny` | 0.95 |
| 项目内操作 | 路径在项目目录内 | `ask` | 0.5 |
| 未知操作 | 无匹配规则 | `ask` | 0.3 |

#### 模式适配

| PermissionMode | 危险操作 | 其他操作 |
|---------------|---------|---------|
| `auto` | `deny` | `allow` |
| `dontAsk` | `deny` | `allow` |
| `bypassPermissions` | `allow` | `allow` |
| `default` | `deny` | 按规则/分类器 |

### CompositePermissionClassifier

支持组合多个分类器，取最高置信度结果，`deny` 优先：

```typescript
import { createCompositeClassifier, createDefaultClassifier } from 'SGA-Template'

const classifier = createCompositeClassifier([
  createDefaultClassifier(),
  customClassifier,
])
```

### ClassificationResult

```typescript
interface ClassificationResult {
  decision: 'allow' | 'deny' | 'ask'
  confidence: number    // 0.0 ~ 1.0
  reason: string
  ruleId?: string       // 触发的规则 ID
}
```

## 敏感路径检测

敏感路径检测保护关键文件和目录不被意外修改。

### 检测分类

| 分类 | 级别 | 示例 |
|------|------|------|
| `version_control` | high | `.git/`, `.svn/`, `.hg/`, `.gitignore` |
| `secrets` | critical | `.ssh/`, `.env`, `.pem`, `.key`, `credentials.json`, `.aws/`, `.kube/` |
| `system` | high | `/etc/passwd`, `/etc/shadow`, `/etc/sudoers` |
| `config` | high | `.bashrc`, `.zshrc`, `.npmrc`, `.sga/` |
| `ide` | medium | `.vscode/`, `.idea/` |
| `framework` | medium | `node_modules/`, `__pycache__/`, `.next/`, `dist/` |

### 使用方式

```typescript
import { isSensitivePath, categorizePathRisk, isPathOutsideProject } from 'SGA-Template'

// 检测是否为敏感路径
const result = isSensitivePath('/home/user/.ssh/id_rsa')
// result: { reason: 'SSH private key', category: 'secrets' }

// 综合风险评估
const risk = categorizePathRisk('/home/user/.env', '/home/user/project')
// risk: { level: 'critical', reasons: ['Environment variables file'] }

// 检测路径是否在项目外
const outside = isPathOutsideProject('/etc/passwd', '/home/user/project')
// outside: true
```

### 风险级别

| 级别 | 说明 | 工具行为 |
|------|------|---------|
| `critical` | 密钥/凭证等 | Write 直接 deny，Edit 返回 ask |
| `high` | 版本控制/系统文件 | 返回 ask |
| `medium` | IDE/框架目录 | 返回 ask |
| `low` | 普通文件 | 正常权限检查 |

## PermissionUpdate（持久化审批规则）

当用户审批时选择"总是允许"，系统会自动创建持久化规则，后续同类操作不再需要审批。

### 类型定义

```typescript
// src/server/interaction.ts
export interface PermissionUpdate {
  type: 'always_allow' | 'always_deny' | 'allow_pattern'
  toolName: string
  pattern?: string
  reason?: string
}
```

| 类型 | 说明 |
|------|------|
| `always_allow` | 总是允许该工具 |
| `always_deny` | 总是拒绝该工具 |
| `allow_pattern` | 允许该工具匹配指定模式的操作 |

### 使用方式

在提交审批响应时附带 `permissionUpdate`：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-xxx",
    "decision": "allow",
    "permissionUpdate": {
      "type": "always_allow",
      "toolName": "Write"
    }
  }'
```

带模式匹配的持久化：

```json
{
  "actionId": "approval-xxx",
  "decision": "allow",
  "permissionUpdate": {
    "type": "allow_pattern",
    "toolName": "Write",
    "pattern": "*.md"
  }
}
```

## 权限检查流程

```
工具调用请求
    │
    ▼
PermissionChecker.check(toolName, input)
    │
    ├─ 1. 规则匹配（deny → allow → ask）
    │     └─ 匹配 → 返回对应行为
    │
    ├─ 2. 分类器决策
    │     ├─ deny (confidence ≥ 0.8) → 拒绝
    │     ├─ allow (confidence ≥ 0.85) → 自动允许
    │     └─ 其他 → ask
    │
    └─ 3. 模式兜底
          ├─ bypassPermissions → allow
          ├─ auto/dontAsk → allow（危险操作除外）
          └─ default → ask
    │
    ▼
┌─ allow ──→ 工具执行
├─ deny ───→ 拒绝执行，返回错误
└─ ask ────→ 触发人机交互审批
              │
              ├─ 用户允许 → 工具执行
              │   └─ 附带 permissionUpdate → 添加持久化规则
              └─ 用户拒绝 → 拒绝执行
```

## 与人机交互的配合

当权限检查返回 `ask` 时，会触发人机交互流程：

1. Agent 循环暂停
2. 通过 SSE 发送 `approval_required` 事件（含 `actionId`）
3. 前端展示审批界面
4. 用户选择允许/拒绝（可选附带 `permissionUpdate`）
5. Agent 循环恢复

详见 [人机交互机制](human-interaction.md)。

## 相关文档

- [人机交互机制](human-interaction.md)
- [自定义工具](custom-tools.md)
- [Hook 钩子系统](hooks.md)
- [API 参考 — 权限接口](api-reference.md)
