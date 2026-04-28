# 自定义系统提示词

> 📄 相关源文件：`src/context/system-prompt.ts`（提示词构建函数）

## 概述

系统提示词是控制 Agent 行为的核心机制。SGA-Template 提供了灵活的系统提示词构建系统，支持静态内容、动态内容、分区管理和优先级覆盖。

## SystemPromptSection

系统提示词由多个 `SystemPromptSection` 组成，每个 Section 有名称、内容和作用域：

```typescript
// src/context/system-prompt.ts
export interface SystemPromptSection {
  name: string
  scope: 'global' | 'ephemeral'
  content: string | (() => Promise<string>)
}
```

- **global** — 全局作用域，内容会被缓存
- **ephemeral** — 临时作用域，每次请求都重新生成

## 构建系统提示词

### 基本用法

```typescript
import { buildSystemPrompt, systemPromptSection } from 'SGA-Template'

const sections = [
  systemPromptSection('identity', '你是一个代码审查助手', 'global'),
  systemPromptSection('rules', '1. 必须指出安全问题\n2. 给出改进建议', 'global'),
]
const prompt = buildSystemPrompt(sections)
```

### 动态内容

Section 的内容可以是异步函数，在每次构建时动态生成：

```typescript
import { systemPromptSection, buildSystemPrompt, resolveSystemPromptSections } from 'SGA-Template'

const sections = [
  systemPromptSection('identity', '你是代码助手', 'global'),
  systemPromptSection('context', async () => {
    const packageJson = await fs.readFile('package.json', 'utf-8')
    return `当前项目的 package.json：\n${packageJson}`
  }, 'ephemeral'),
]

// 需要先解析动态内容
const resolved = await resolveSystemPromptSections(sections)
const prompt = buildSystemPrompt(resolved)
```

### 不缓存内容

对于需要每次请求都刷新的内容，使用 `uncachedSystemPromptSection`：

```typescript
import { uncachedSystemPromptSection } from 'SGA-Template'

const section = uncachedSystemPromptSection(
  'timestamp',
  () => Promise.resolve(`当前时间：${new Date().toISOString()}`),
  '时间戳每次请求都不同',
)
```

## 优先级覆盖

`buildEffectiveSystemPrompt` 提供了优先级覆盖机制，按以下顺序选择系统提示词：

1. **override** — 强制覆盖（最高优先级）
2. **coordinator** — 协调器提示词
3. **agent** — Agent 定义的提示词
4. **custom** — 自定义提示词
5. **default** — 默认提示词
6. **append** — 追加内容（始终添加到末尾）

```typescript
import { buildEffectiveSystemPrompt } from 'SGA-Template'

const prompt = buildEffectiveSystemPrompt({
  agent: '你是代码审查专家',
  custom: '请使用中文回复',
  append: '注意：所有回复必须包含代码示例',
})
```

## 动态边界

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记将静态内容和动态内容分隔开：

```
[静态内容 Section 1]

[静态内容 Section 2]

---DYNAMIC_BOUNDARY---

[动态内容 Section 1]

[动态内容 Section 2]
```

这个边界标记用于缓存优化——静态部分可以缓存，动态部分每次重新生成。

## 在 Agent 中使用

```typescript
import { BaseAgentDefinition } from 'SGA-Template'

const agent = new BaseAgentDefinition({
  name: 'CodeReviewer',
  description: '代码审查',
  subagentType: 'code-reviewer',
  systemPrompt: `你是一位资深代码审查专家。

## 职责
1. 审查代码质量和安全性
2. 提出改进建议
3. 检查编码规范

## 输出格式
请按以下格式输出审查结果：
- 问题等级：🔴 严重 / 🟡 警告 / 🟢 建议
- 问题描述
- 修复建议`,
})
```

## 相关文档

- [自定义 Agent](custom-agent.md)
- [记忆系统](memory.md)
- [上下文压缩](context-compression.md)
