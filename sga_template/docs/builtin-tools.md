# 内置工具一览

> 📄 相关源文件：`src/tools/built-in/` 目录下所有文件

## 概述

SGA-Template 内置了丰富的工具集，覆盖文件操作、代码搜索、终端执行、网络访问等常见场景。

## 工具列表

### 文件操作

| 工具名 | 源文件 | 说明 |
|--------|--------|------|
| `Read` | `src/tools/built-in/file-read.ts` | 读取文件内容 |
| `Write` | `src/tools/built-in/file-write.ts` | 写入文件 |
| `Edit` | `src/tools/built-in/file-edit.ts` | 编辑文件（搜索替换） |
| `Glob` | `src/tools/built-in/glob.ts` | 按模式匹配文件名 |
| `Grep` | `src/tools/built-in/grep.ts` | 按内容搜索文件 |

### 终端操作

| 工具名 | 源文件 | 说明 |
|--------|--------|------|
| `Bash` | `src/tools/built-in/bash.ts` | 执行 Shell 命令 |

### 网络操作

| 工具名 | 源文件 | 说明 |
|--------|--------|------|
| `WebSearch` | `src/tools/built-in/web-search.ts` | 网络搜索 |
| `WebFetch` | `src/tools/built-in/web-fetch.ts` | 抓取网页内容 |

### 交互与任务

| 工具名 | 源文件 | 说明 |
|--------|--------|------|
| `AskUserQuestion` | `src/tools/built-in/ask-user.ts` | 向用户提问 |
| `TodoWrite` | `src/tools/built-in/todo-write.ts` | 管理任务列表 |

### 开发工具

| 工具名 | 源文件 | 说明 |
|--------|--------|------|
| `NotebookEdit` | `src/tools/built-in/notebook-edit.ts` | 编辑 Jupyter Notebook |
| `Skill` | `src/tools/built-in/skill.ts` | 调用技能 |
| `LSP` | `src/tools/built-in/lsp.ts` | 语言服务协议集成 |

## 工具详细说明

### Read — 文件读取

```typescript
// 输入参数
{
  file_path: string    // 文件绝对路径
  offset?: number      // 起始行号
  limit?: number       // 读取行数
}
```

### Write — 文件写入

```typescript
// 输入参数
{
  file_path: string    // 文件绝对路径
  content: string      // 写入内容
}
```

### Edit — 文件编辑

```typescript
// 输入参数
{
  file_path: string    // 文件绝对路径
  old_str: string      // 要替换的原始内容
  new_str: string      // 替换后的新内容
}
```

### Glob — 文件名匹配

```typescript
// 输入参数
{
  pattern: string      // Glob 模式（如 "**/*.ts"）
  path?: string        // 搜索目录
}
```

### Grep — 内容搜索

```typescript
// 输入参数
{
  pattern: string      // 正则表达式
  path?: string        // 搜索目录
  glob?: string        // 文件名过滤
  output_mode?: 'files_with_matches' | 'content' | 'count'
  head_limit?: number  // 限制输出数量
}
```

### Bash — Shell 命令

```typescript
// 输入参数
{
  command: string      // 要执行的命令
  cwd?: string         // 工作目录
  timeout?: number     // 超时时间（毫秒）
}
```

#### 权限检查

Bash 工具在执行前会进行权限检查：

1. **PreToolUse Hook** — 执行已注册的 PreToolUse Hook，可通过 exit code 2 阻止执行
2. **权限规则匹配** — 检查 deny/allow/ask 规则，如 `rm -rf` 模式会被默认拒绝
3. **分类器决策** — 自动判断命令安全性（只读命令自动允许，危险命令自动拒绝）
4. **人机交互** — 权限检查返回 `ask` 时，通过 SSE 发送 `approval_required` 事件等待用户审批

#### 敏感路径检测

Bash 工具执行涉及路径操作时，会自动检测敏感路径：

| 路径类型 | 示例 | 行为 |
|---------|------|------|
| 密钥/凭证 | `.ssh/`, `.env`, `.pem`, `.key` | 自动拒绝写入 |
| 版本控制 | `.git/`, `.svn/` | 需要审批 |
| 系统文件 | `/etc/passwd`, `/etc/shadow` | 需要审批 |
| 配置文件 | `.bashrc`, `.zshrc`, `.npmrc` | 需要审批 |

#### 实时输出

Bash 工具支持实时输出进度：

- **有 onProgress**：使用 `spawn` 异步执行，实时发射 `stdout`/`stderr` 增量和 `bash_progress` 结构化数据
- **无 onProgress**：使用 `execSync` 同步执行（向后兼容）

详见 [SSE 事件协议 — Bash 实时输出](agent-events-sse.md)。

### Write — 文件写入

```typescript
// 输入参数
{
  file_path: string    // 文件绝对路径
  content: string      // 写入内容
}
```

#### 敏感路径检测

Write 工具在写入前会检测目标路径是否为敏感路径：

- **critical 级别**（`.ssh/`, `.env`, `.key` 等）：直接拒绝
- **high 级别**（`.git/`, `/etc/` 等）：返回 `ask`，需要用户审批
- **medium 级别**（`.vscode/`, `node_modules/` 等）：返回 `ask`
- **low 级别**（普通文件）：正常权限检查

#### 路径校验

- 必须使用绝对路径
- 检测路径是否在项目目录外（项目外路径需要额外审批）

### Edit — 文件编辑

```typescript
// 输入参数
{
  file_path: string    // 文件绝对路径
  old_str: string      // 要替换的原始内容
  new_str: string      // 替换后的新内容
}
```

#### 敏感路径检测

与 Write 工具相同，但 critical 级别路径返回 `ask` 而非直接拒绝（编辑操作风险低于覆盖写入）。

### WebSearch — 网络搜索

```typescript
// 输入参数
{
  query: string        // 搜索关键词
  num?: number         // 结果数量
}
```

### WebFetch — 网页抓取

```typescript
// 输入参数
{
  url: string          // 目标 URL
}
```

### AskUserQuestion — 用户提问

```typescript
// 输入参数
{
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}
```

### TodoWrite — 任务列表

```typescript
// 输入参数
{
  todos: Array<{
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    priority: 'high' | 'medium' | 'low'
  }>
}
```

## 获取内置工具

```typescript
import { createBuiltinTools } from 'SGA-Template'

const tools = createBuiltinTools()
// tools: Tool[]
```

## 相关文档

- [自定义工具](custom-tools.md)
- [权限控制](permissions.md)
- [MCP 集成](mcp-integration.md)
