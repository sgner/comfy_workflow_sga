# 上下文压缩

> 📄 相关源文件：`src/memory/compact/micro-compact.ts`（微压缩）、`src/memory/compact/session-memory-compact.ts`（会话记忆压缩）、`src/memory/compact/full-compact.ts`（全量压缩）、`src/memory/compact/index.ts`（自动压缩调度）、`src/memory/compact/post-compact-restore.ts`（压缩后状态恢复）、`src/memory/compact/tool-summary.ts`（工具调用摘要）、`src/config.ts`（环境变量配置加载）

## 概述

在与 LLM 的多轮对话中，消息历史会不断增长，最终可能超出模型的上下文窗口限制。上下文压缩机制通过**三级渐进式压缩策略**，智能地压缩历史消息，确保对话可以持续进行而不会丢失关键信息。

### 三级压缩架构

```
消息增长
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Level 1: MicroCompact（微压缩）                   │
│ 无需 LLM，清除旧工具输出                           │
│ 触发条件：时间间隔 + 可压缩工具结果存在              │
│ Token 节省：中等                                   │
├─────────────────────────────────────────────────┤
│ Level 2: SessionMemoryCompact（会话记忆压缩）      │
│ 用会话记忆摘要替代旧消息                            │
│ 触发条件：token 使用超过阈值 + 会话记忆可用          │
│ Token 节省：较高                                   │
├─────────────────────────────────────────────────┤
│ Level 3: FullCompact（全量压缩）                   │
│ LLM 生成结构化摘要                                 │
│ 触发条件：token 使用超过阈值 + 前两级不够            │
│ Token 节省：最高                                   │
└─────────────────────────────────────────────────┘
```

## Level 1: MicroCompact（微压缩）

微压缩是最轻量的压缩方式，**无需 LLM 参与**，仅清除旧的工具输出结果。

### 工作原理

1. 扫描消息中的工具调用结果
2. 识别可压缩的工具类型（Read、Bash、Grep、Glob 等）
3. 保留最近 N 条工具结果，其余替换为占位符

### 压缩示例

```typescript
// 压缩前
[
  { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Read', input: { path: 'a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: '// 很长的文件内容...' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'Read', input: { path: 'b.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: '// 很长的文件内容...' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: '3', name: 'Read', input: { path: 'c.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '3', content: '// 最新的文件内容...' }] },
]

// 压缩后（keepRecent=2，保留最近 2 条）
[
  { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Read', input: { path: 'a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: '[Old tool result content cleared]' }] },
  // 最近 2 条保留原样
  { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'Read', input: { path: 'b.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: '// 很长的文件内容...' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: '3', name: 'Read', input: { path: 'c.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: '3', content: '// 最新的文件内容...' }] },
]
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_COMPACT_MICRO_ENABLED` | `true` | 是否启用微压缩 |
| `SGA_COMPACT_MICRO_GAP_MINUTES` | `10` | 距上次助手消息超过多少分钟触发 |
| `SGA_COMPACT_MICRO_KEEP_RECENT` | `3` | 保留最近 N 条工具结果 |
| `SGA_COMPACT_MICRO_MAX_TOOL_RESULT_TOKENS` | `50000` | 单条工具结果最大 token 数 |

## Level 2: SessionMemoryCompact（会话记忆压缩）

会话记忆压缩用会话记忆摘要替代旧消息，比全量压缩更轻量，无需调用 LLM 生成新摘要。

### 工作原理

1. 检查 token 使用是否超过阈值
2. 如果有可用的会话记忆内容，将其作为摘要消息
3. 保留最近的消息，用摘要消息替代旧消息

### 压缩示例

```typescript
// 压缩前（40k tokens）
[
  { role: 'user', content: '帮我分析这个项目' },
  { role: 'assistant', content: '我来分析项目结构...' },
  // ... 30+ 条消息 ...
  { role: 'user', content: '继续优化' },
  { role: 'assistant', content: '好的，我来优化...' },
]

// 压缩后（~15k tokens）
[
  { role: 'user', content: '[Session Memory]\n用户正在分析项目结构，已完成以下工作：\n1. 读取了 package.json\n2. 分析了目录结构\n3. 修改了配置文件...' },
  // 保留最近几条消息
  { role: 'user', content: '继续优化' },
  { role: 'assistant', content: '好的，我来优化...' },
]
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_COMPACT_SM_MIN_TOKENS` | `10000` | 触发压缩的最小 token 数 |
| `SGA_COMPACT_SM_MIN_TEXT_BLOCK_MESSAGES` | `5` | 触发压缩的最小文本块消息数 |
| `SGA_COMPACT_SM_MAX_TOKENS` | `40000` | 压缩的最大 token 数 |
| `SGA_COMPACT_SM_MAX_SESSION_MEMORY_TOKENS` | `30000` | 会话记忆摘要最大 token 数 |

## Level 3: FullCompact（全量压缩）

全量压缩使用 LLM 生成结构化摘要，是最彻底的压缩方式，能保留最重要的上下文信息。

### 工作原理

1. 将完整消息历史发送给 LLM
2. LLM 生成结构化摘要，包含：
   - 用户请求和意图
   - 技术细节（文件路径、代码片段、错误信息）
   - 已解决的问题和进行中的工作
   - 待办任务
3. 用摘要消息替代旧消息，保留最近几轮对话

### 摘要结构

LLM 生成的摘要遵循以下结构：

```markdown
## Conversation Summary

### User's Requests
- 用户请求分析项目结构
- 用户要求优化性能

### Technical Details
- 文件路径：src/main.ts, src/config.ts
- 关键函数：processData(), validateInput()
- 错误信息：TypeError: Cannot read property 'name' of undefined

### Problems Solved
- 修复了类型错误
- 优化了数据库查询

### Ongoing Work
- 正在实现缓存机制

### Pending Tasks
- 添加单元测试
- 更新文档
```

### Prompt Too Long 处理

当消息历史本身超出模型输入窗口时，FullCompact 会自动：

1. 截断最早的消息
2. 保留系统提示词和最近的消息
3. 重试压缩（最多 `SGA_COMPACT_FULL_MAX_PTL_RETRIES` 次）

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_COMPACT_FULL_ENABLED` | `true` | 是否启用全量压缩 |
| `SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS` | `20000` | LLM 摘要最大输出 token 数 |
| `SGA_COMPACT_FULL_MAX_PTL_RETRIES` | `3` | Prompt Too Long 重试次数 |
| `SGA_COMPACT_FULL_BUFFER_TOKENS` | `13000` | 压缩前保留的缓冲 token 数 |
| `SGA_COMPACT_FULL_WARNING_THRESHOLD_TOKENS` | `20000` | token 譯告阈值 |
| `SGA_COMPACT_FULL_MAX_CONSECUTIVE_FAILURES` | `3` | 连续失败最大次数 |

## 自动压缩调度

`AutoCompactor` 按照三级策略自动调度压缩：

### 调度流程

```
compactIfNeeded(messages)
    │
    ├── 1. 检查熔断器（连续失败是否超限）
    │       └── 超限 → 跳过压缩
    │
    ├── 2. 尝试 MicroCompact
    │       └── 有节省 → 返回微压缩结果
    │
    ├── 3. 检查是否需要更高级压缩
    │       └── 不需要 → 返回原始消息
    │
    ├── 4. 尝试 SessionMemoryCompact（如果 preferSessionMemory=true）
    │       └── 成功 → 返回会话记忆压缩结果
    │
    └── 5. 尝试 FullCompact（需要 Provider）
            ├── 成功 → 返回全量压缩结果，重置失败计数
            └── 失败 → 增加失败计数，返回原始消息
```

### 通用环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_MODEL_MAX_TOKENS` | `200000` | 模型上下文窗口最大 token 数 |
| `SGA_COMPACT_PREFER_SESSION_MEMORY` | `true` | 是否优先使用会话记忆压缩 |

### API

```typescript
import { AutoCompactor, getAutoCompactConfig } from 'SGA-Template'

const compactor = new AutoCompactor(getAutoCompactConfig())

const result = await compactor.compactIfNeeded(
  messages,
  provider,
  model,
  sessionMemoryContent,
)

console.log(result.strategy)     // 'micro' | 'session_memory' | 'full'
console.log(result.wasCompacted) // true | false
console.log(result.messages)     // 压缩后的消息列表
```

## 压缩后状态恢复

压缩后，系统自动恢复关键上下文，确保 Agent 不会丢失工作状态：

### 恢复的内容

| 类型 | 说明 | 配置项 |
|------|------|--------|
| 文件 | 最近读取的文件内容 | `SGA_POST_COMPACT_MAX_FILES`, `SGA_POST_COMPACT_MAX_TOKENS_PER_FILE` |
| 计划 | 活跃的执行计划及进度 | 自动包含 |
| 技能 | 已激活的技能定义 | `SGA_POST_COMPACT_MAX_TOKENS_PER_SKILL`, `SGA_POST_COMPACT_SKILLS_TOKEN_BUDGET` |
| 工作集 | 锚定的重要长内容 | 自动包含 |

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_POST_COMPACT_MAX_FILES` | `5` | 恢复的最大文件数 |
| `SGA_POST_COMPACT_TOKEN_BUDGET` | `50000` | 恢复的总 token 预算 |
| `SGA_POST_COMPACT_MAX_TOKENS_PER_FILE` | `5000` | 单文件最大恢复 token 数 |
| `SGA_POST_COMPACT_MAX_TOKENS_PER_SKILL` | `5000` | 单技能最大恢复 token 数 |
| `SGA_POST_COMPACT_SKILLS_TOKEN_BUDGET` | `25000` | 技能恢复总 token 预算 |

## 工具调用摘要

使用轻量 LLM 对工具调用的输入/输出生成摘要，减少 token 占用：

```typescript
// 原始工具调用（500+ tokens）
{ name: 'Read', input: { path: 'src/main.ts' } }
→ { content: '// 1000 行代码...' }

// 摘要后（~60 tokens）
{ name: 'Read', input: 'src/main.ts', output: '读取了主入口文件，包含 Express 应用配置' }
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_TOOL_SUMMARY_ENABLED` | `true` | 是否启用工具调用摘要 |
| `SGA_TOOL_SUMMARY_MODEL` | `haiku` | 生成摘要使用的模型 |
| `SGA_TOOL_SUMMARY_MAX_INPUT_LENGTH` | `300` | 工具输入最大长度 |
| `SGA_TOOL_SUMMARY_MAX_OUTPUT_LENGTH` | `300` | 工具输出最大长度 |
| `SGA_TOOL_SUMMARY_MAX_SUMMARY_LENGTH` | `60` | 摘要最大长度 |

## 熔断器

压缩和整合操作都配备熔断器，防止连续失败时反复重试：

### 工作原理

```
closed（正常）
    │ 连续失败达到阈值
    ▼
open（熔断，拒绝请求）
    │ 冷却时间过后
    ▼
half_open（半开，允许少量请求）
    │ 成功 → closed
    │ 失败 → open
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_CB_COMPACT_MAX_FAILURES` | `3` | 压缩熔断器：连续失败次数 |
| `SGA_CB_COMPACT_COOLDOWN_MS` | `300000` | 压缩熔断器：冷却时间（毫秒） |
| `SGA_CB_COMPACT_HALF_OPEN_ATTEMPTS` | `1` | 压缩熔断器：半开状态最大尝试次数 |
| `SGA_CB_CONSOLIDATION_MAX_FAILURES` | `2` | 整合熔断器：连续失败次数 |
| `SGA_CB_CONSOLIDATION_COOLDOWN_MS` | `1800000` | 整合熔断器：冷却时间（毫秒） |
| `SGA_CB_CONSOLIDATION_HALF_OPEN_ATTEMPTS` | `1` | 整合熔断器：半开状态最大尝试次数 |

## 配置示例

### 使用 GPT-4o（128k 上下文）

```bash
SGA_MODEL_MAX_TOKENS=128000
SGA_BUDGET_MAX_CONTEXT_TOKENS=128000
SGA_BUDGET_RESERVED_CONVERSATION_TOKENS=30000
SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS=15000
```

### 使用 DeepSeek（64k 上下文）

```bash
SGA_MODEL_MAX_TOKENS=64000
SGA_BUDGET_MAX_CONTEXT_TOKENS=64000
SGA_BUDGET_RESERVED_CONVERSATION_TOKENS=20000
SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS=10000
SGA_BUDGET_COMPRESSION_THRESHOLD=0.70
```

### 更激进的压缩策略

```bash
SGA_BUDGET_COMPRESSION_THRESHOLD=0.70
SGA_COMPACT_MICRO_KEEP_RECENT=2
SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS=10000
SGA_COMPACT_PREFER_SESSION_MEMORY=true
```

### 禁用特定压缩级别

```bash
# 仅使用微压缩和全量压缩，跳过会话记忆压缩
SGA_COMPACT_PREFER_SESSION_MEMORY=false

# 禁用全量压缩（仅使用微压缩和会话记忆压缩）
SGA_COMPACT_FULL_ENABLED=false
```

## 相关文档

- [环境变量配置](environment-variables.md) — 所有可配置参数的完整列表
- [记忆系统](memory.md) — 记忆管理、上下文预算和工作集
- [自定义系统提示词](custom-prompt.md)
- [多供应商 LLM 接入](multi-provider.md)
