# 记忆系统

> 📄 相关源文件：`src/memory/scanner.ts`（扫描）、`src/memory/retrieval.ts`（检索）、`src/memory/prompt.ts`（提示词构建）、`src/memory/types.ts`（类型定义）

## 概述

记忆系统允许 Agent 跨会话保留和检索信息。它通过扫描指定目录中的 Markdown 文件，将内容作为上下文注入到系统提示词中，使 Agent 能够"记住"用户偏好、项目约定和历史决策。

## 记忆文件格式

记忆文件是带有 frontmatter 的 Markdown 文件：

```markdown
---
type: project
description: 项目编码规范
tags: typescript, lint, convention
---

# 编码规范

- 使用 TypeScript strict 模式
- 所有函数必须有返回类型注解
- 使用 ESLint + Prettier 进行代码格式化
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | 记忆类型：`project` / `user` / `session` |
| `description` | `string` | 记忆描述 |
| `tags` | `string[]` | 标签列表 |

## 记忆文件目录

| 目录 | 说明 |
|------|------|
| `.memory/` | 项目级记忆（在项目根目录下） |
| `~/.SGA-Template/memory/` | 用户级记忆（跨项目共享） |

## 扫描记忆文件

```typescript
import { scanMemoryFiles } from 'SGA-Template'

const memories = await scanMemoryFiles('/project/.memory')
// memories: MemoryFile[]
```

`scanMemoryFiles` 会递归扫描目录中的所有 `.md` 文件（除 `MEMORY.md`），解析 frontmatter，按修改时间排序，并限制最大文件数。

### MemoryFile

```typescript
// src/memory/types.ts
export interface MemoryFile {
  path: string
  type: string
  description: string
  content: string
  frontmatter: MemoryFrontmatter
  mtimeMs: number
  sizeBytes: number
}
```

## 检索相关记忆

```typescript
import { findRelevantMemories } from 'SGA-Template'

const { memories: relevant } = await findRelevantMemories(
  '用户偏好 TypeScript',
  allMemories,
)
```

`findRelevantMemories` 根据查询文本检索最相关的记忆文件，支持基于标签和描述的匹配。

## 构建记忆提示词

```typescript
import { buildMemoryPrompt } from 'SGA-Template'

const memoryPrompt = buildMemoryPrompt(relevant)
// 将记忆内容格式化为可注入系统提示词的文本
```

## 完整工作流

```typescript
import { scanMemoryFiles, findRelevantMemories, buildMemoryPrompt } from 'SGA-Template'
import { BaseAgentDefinition } from 'SGA-Template'

// 1. 扫描记忆文件
const memories = await scanMemoryFiles('/project/.memory')

// 2. 检索相关记忆
const { memories: relevant } = await findRelevantMemories('用户偏好 TypeScript', memories)

// 3. 构建记忆提示词
const memoryPrompt = buildMemoryPrompt(relevant)

// 4. 注入到系统提示词
const agent = new BaseAgentDefinition({
  name: 'Assistant',
  description: '通用助手',
  subagentType: 'assistant',
  systemPrompt: `你是一个智能助手。

${memoryPrompt}

请根据以上记忆信息来辅助你的回答。`,
})
```

## 相关文档

- [自定义系统提示词](custom-prompt.md)
- [技能系统](skills.md)
- [上下文压缩](context-compression.md)
