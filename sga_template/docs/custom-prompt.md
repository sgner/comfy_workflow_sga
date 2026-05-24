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

## 动态系统提示词拼装

> 📄 相关源文件：`src/context/system-prompt.ts` → `buildFullSystemPrompt()`

`buildFullSystemPrompt()` 提供了统一的系统提示词拼装入口，将基础提示词与多个 section 组合为完整的系统提示词。

### 拼装流程

```
基础提示词 (basePrompt)
    │
    ▼
┌─────────────────────────────────────────┐
│ 静态部分 (staticSections)               │
│ ├─ BEHAVIOR_RULES_SECTION  行为规则     │
│ ├─ getActionsSection()     操作谨慎性   │
│ ├─ getUsingToolsSection()  工具使用偏好 │
│ ├─ getToneAndStyleSection() 语气风格    │
│ ├─ getOutputEfficiencySection() 输出效率│
│ ├─ getSystemRemindersSection() 系统提醒 │
│ ├─ getHooksSection()       Hook 反馈    │
│ ├─ getEnvInfoSection()     环境信息     │
│ └─ getLanguageSection()    语言偏好     │
└──────────────────┬──────────────────────┘
                   │
                   ▼
         ---DYNAMIC_BOUNDARY---
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 动态部分 (dynamicSections)              │
│ ├─ getMcpInstructionsSection() MCP 指令 │
│ └─ getSkillListSection()    Skill 列表  │
└─────────────────────────────────────────┘
```

### 使用方式

```typescript
import { buildFullSystemPrompt, type SystemPromptBuildOptions } from 'SGA-Template'

const options: SystemPromptBuildOptions = {
  model: 'sonnet',
  enabledTools: new Set(['Read', 'Write', 'Bash', 'Grep']),
  mcpInstructions: true,
  skillList: true,
  languagePreference: 'zh-CN',
  additionalWorkingDirectories: ['/shared/lib'],
}

const fullPrompt = await buildFullSystemPrompt(basePrompt, options)
```

### Section 说明

| Section | 类型 | 说明 |
|---------|------|------|
| `BEHAVIOR_RULES_SECTION` | 静态 | "不准乱来"行为规则（14 条硬性约束） |
| `getActionsSection()` | 静态 | 操作谨慎性指南（危险操作需确认） |
| `getUsingToolsSection()` | 静态 | 工具使用偏好（优先专用工具而非 Bash） |
| `getToneAndStyleSection()` | 静态 | 语气风格（简洁、无 emoji、文件路径引用） |
| `getOutputEfficiencySection()` | 静态 | 输出效率（直奔主题、不过度解释） |
| `getSystemRemindersSection()` | 静态 | 系统提醒处理规则 |
| `getHooksSection()` | 静态 | Hook 反馈处理规则 |
| `getEnvInfoSection()` | 静态 | 环境信息（CWD/OS/Date/Model） |
| `getLanguageSection()` | 静态 | 语言偏好（可选） |
| `getMcpInstructionsSection()` | 动态 | 已连接 MCP 服务器的 instructions |
| `getSkillListSection()` | 动态 | 已发现的用户可调用 Skill 列表 |

### MCP 指令注入

`getMcpInstructionsSection()` 从已连接的 MCP 服务器中提取 instructions，注入到系统提示词的动态部分：

```typescript
// 自动从已连接的 MCP 服务器提取 instructions
const mcpSection = await getMcpInstructionsSection()
// 输出示例：
// # MCP Server Instructions
//
// ## comfyui-api
// You have access to ComfyUI workflow management tools...
```

### Skill 列表注入

`getSkillListSection()` 从已发现的 Skill 中提取用户可调用的列表，注入到系统提示词的动态部分：

```typescript
// 自动从已发现的 Skill 中提取列表
const skillSection = await getSkillListSection()
// 输出示例：
// # Available Skills
//
// - **code-review**: Code review specialist
// - **security-scan**: Security vulnerability scanner
```

## 行为规则（"不准乱来"规则）

> 📄 相关源文件：`src/context/system-prompt.ts` → `BEHAVIOR_RULES_SECTION`

行为规则是注入到系统提示词中的硬性约束，确保 Agent 遵循严格的行为准则：

| 规则 | 说明 |
|------|------|
| 不扩大范围 | 严格按用户要求执行，不自行添加额外功能 |
| 不过度工程 | 选择最简单的实现方式，不引入不必要的复杂性 |
| 不做不必要的重构 | 除非用户明确要求，否则不重构现有代码 |
| 不做虚假验证 | 验证必须实际运行命令，不能仅凭阅读代码判定 |
| 不忽略错误 | 遇到错误必须报告，不能静默跳过 |
| 不猜测用户意图 | 不确定时主动询问，而非自行假设 |
| 不修改无关文件 | 只修改与任务直接相关的文件 |
| 不创建不必要的文件 | 优先编辑现有文件，而非创建新文件 |
| 默认不加注释 | 除非用户要求，否则不添加代码注释 |
| 安全意识 | 不暴露密钥和敏感信息，遵循安全最佳实践 |
| 失败后先诊断再转向 | 遇到连续失败时先诊断原因，而非盲目切换方案 |
| 如实报告 | 如实报告结果，不夸大成功或隐瞒失败 |

> 行为规则通过 Feature Gate `behavior_rules_injection` 控制启用/禁用，详见 [Feature Gate 特性开关](feature-gate.md)。

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

## SGA.md / CLAUDE.md 自动加载

框架会自动加载以下位置的指令文件，注入到系统提示词中：

### 全局配置
- `/etc/sga/SGA.md`
- `/etc/claude-code/CLAUDE.md`

### 用户级配置
- `~/.sga/SGA.md`（默认）
- `~/.claude/CLAUDE.md`（兼容）

### 项目级配置（按优先级）
- `SGA.md`（项目根目录）
- `CLAUDE.md`（项目根目录，兼容）
- `.sga/SGA.md`
- `.claude/CLAUDE.md`（兼容）
- `.sga/rules/*.md`
- `.claude/rules/*.md`（兼容）

### 本地配置
- `SGA.local.md`
- `CLAUDE.local.md`（兼容）

> **SGA 优先原则**：当 SGA.md 和 CLAUDE.md 同时存在时，SGA.md 的内容优先加载。框架保持与 Claude Code 的兼容性，但推荐使用 SGA 命名空间。

## 相关文档

- [自定义 Agent](custom-agent.md)
- [记忆系统](memory.md)
- [上下文压缩](context-compression.md)
