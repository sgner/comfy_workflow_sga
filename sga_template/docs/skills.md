# 技能系统

> 📄 相关源文件：`src/skills/discovery.ts`（技能发现）、`src/skills/activation.ts`（技能激活）、`src/skills/types.ts`（类型定义）、`src/skills/bundled-registry.ts`（注册中心）

## 概述

技能系统允许你为 Agent 添加专业能力。技能本质上是预定义的提示词模板，可以包含工具约束、上下文配置和钩子定义。当用户触发技能时，相关的提示词和配置会被注入到 Agent 的上下文中。

## 技能文件格式

技能由目录中的 Markdown 文件定义：

```markdown
---
name: code-review
description: 代码审查技能
user-invocable: true
disable-model-invocation: false
context: inline
model: sonnet
effort: high
allowed-tools: Read, Grep, Glob
argument-hint: 要审查的文件或目录
---

你是一位资深代码审查专家。请根据以下参数执行任务：$ARGUMENTS

## 审查标准
1. 代码质量和可读性
2. 安全漏洞检测
3. 性能优化建议
```

### Frontmatter 字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | `string` | 目录名 | 技能名称 |
| `description` | `string` | 首个标题 | 技能描述 |
| `user-invocable` | `boolean` | `true` | 用户是否可手动调用 |
| `disable-model-invocation` | `boolean` | `false` | 是否禁止模型自动调用 |
| `context` | `'inline' \| 'fork'` | `'inline'` | 执行上下文模式 |
| `model` | `string` | 无 | 指定模型 |
| `effort` | `string` | 无 | 思考力度 |
| `allowed-tools` | `string` | 无 | 允许使用的工具列表 |
| `paths` | `string` | 无 | 关联的文件路径 |
| `hooks` | `object` | 无 | 钩子定义 |
| `argument-hint` | `string` | 无 | 参数提示 |
| `version` | `string` | 无 | 版本号 |

## 技能发现

```typescript
import { discoverSkills } from 'SGA-Template'

const skills = await discoverSkills({
  cwd: '/project',
  skillDirs: ['/project/.skills'],
})
```

### 发现配置

```typescript
export interface SkillDiscoveryConfig {
  managedDir?: string      // 框架管理的技能目录
  userDir?: string         // 用户级技能目录
  projectDirs?: string[]   // 项目级技能目录
  additionalDirs?: string[] // 额外目录
}
```

### 搜索顺序

1. 管理目录 (`managedDir`)
2. 用户目录 (`~/.sga/skills/`)
3. 用户目录兼容 (`~/.claude/skills/` — 如果存在)
4. 项目目录 (`.sga/skills/` 等)
5. 项目目录兼容 (`.claude/skills/` — 如果存在)
6. 额外目录

> 框架同时兼容 Claude Code 的 skills 目录。如果用户已有 `~/.claude/skills` 或项目中的 `.claude/skills` 目录，框架会自动发现并加载其中的技能。

## 技能激活

```typescript
import { discoverSkills, activateConditionalSkills, separateConditionalSkills } from 'SGA-Template'

const skills = await discoverSkills({ cwd: '/project' })
const { always, conditional } = separateConditionalSkills(skills)

// 始终激活的技能
console.log(always)

// 条件激活的技能（需要根据上下文判断）
const activated = await activateConditionalSkills(conditional, {
  cwd: '/project',
  availableTools: ['Bash', 'Read'],
})
```

## 技能注册中心

```typescript
import { initBundledSkills, registerBundledSkill, getAllBundledSkills } from 'SGA-Template'

// 初始化内置技能
initBundledSkills()

// 注册自定义技能
registerBundledSkill({
  name: 'my-skill',
  description: '我的自定义技能',
  prompt: '你是一个专业助手...',
  userInvocable: true,
})

// 获取所有技能
const allSkills = getAllBundledSkills()
```

## 技能持久化

```typescript
import { saveSkillToDir, getUserSkillsDir, getProjectSkillsDir } from 'SGA-Template'

// 保存到用户级目录
await saveSkillToDir({
  name: 'my-skill',
  description: '我的技能',
  prompt: '...',
  userInvocable: true,
}, 'user')

// 保存到项目级目录
await saveSkillToDir({
  name: 'project-skill',
  description: '项目技能',
  prompt: '...',
  userInvocable: true,
}, 'project')
```

## 相关文档

- [Skills 与 MCP 管理](skills-mcp-management.md)
- [自定义 Agent](custom-agent.md)
- [自定义系统提示词](custom-prompt.md)
