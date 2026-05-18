# MCP 集成

> 📄 相关源文件：`src/mcp/client.ts`（MCPClient 完整客户端）、`src/mcp/manager.ts`（服务器管理器）、`src/mcp/adapter.ts`（工具适配器）、`src/mcp/types.ts`（类型定义）

## 概述

MCP（Model Context Protocol）是一种标准化的协议，允许 Agent 连接外部工具和数据源。SGA-Template 内置了完整的 MCP 支持，可以轻松接入任何 MCP 兼容的服务器。

MCP 工具会自动适配为框架的 `Tool` 接口，在 Agent 运行时与内置工具合并使用，无需额外配置。

## 架构

```
┌─────────────────────────────────────────────────┐
│                   Agent Runner                   │
│                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ 内置工具  │  │ MCP 工具适配 │  │ 自定义工具 │ │
│  │ (Builtin) │  │ (MCPAdapter) │  │ (Custom)  │ │
│  └──────────┘  └──────┬───────┘  └───────────┘ │
│                       │                          │
│            assembleToolPool() 去重合并            │
└───────────────────────┬─────────────────────────┘
                        │
            ┌───────────┴───────────┐
            │     MCP Manager       │
            │  (服务器生命周期管理)   │
            └───────────┬───────────┘
                        │
            ┌───────────┴───────────┐
            │     MCP Client        │
            │  (JSON-RPC 2.0 协议)  │
            │  (initialize 握手)     │
            └───────────┬───────────┘
                        │
      ┌─────────────────┼─────────────────┐
      │                 │                 │
┌─────┴──────┐  ┌───────┴──────┐  ┌──────┴──────────┐
│   Stdio    │  │     SSE      │  │ Streamable HTTP │
│ Transport  │  │  Transport   │  │   Transport     │
│            │  │              │  │                 │
│ stdin/     │  │ GET /sse     │  │ POST /mcp       │
│ stdout     │  │ POST /msg    │  │ GET /mcp (SSE)  │
│ 子进程通信  │  │ EventSource  │  │ DELETE /mcp     │
│ 消息缓冲   │  │ 端点发现     │  │ 会话管理        │
│ 超时保护   │  │ 双通道通信   │  │ 多模式响应      │
└─────┬──────┘  └───────┬──────┘  └──────┬──────────┘
      │                 │                 │
┌─────┴──────┐  ┌───────┴──────┐  ┌──────┴──────────┐
│  本地进程   │  │  SSE 远程    │  │  HTTP 远程       │
│  (npx/...) │  │  服务器      │  │  服务器          │
└────────────┘  └──────────────┘  └─────────────────┘
```

## MCPServerConfig

```typescript
// src/mcp/types.ts
export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  headers?: Record<string, string>
  restartOnFailure?: boolean
  maxRestartAttempts?: number
  disabled?: boolean
  alwaysAllow?: string[]
}
```

| 字段 | 说明 |
|------|------|
| `name` | 服务器唯一标识名 |
| `command` | 启动命令（stdio 传输） |
| `args` | 命令参数 |
| `env` | 环境变量 |
| `cwd` | 工作目录 |
| `transport` | 传输协议：`stdio` / `sse` / `streamable-http` |
| `url` | 服务器 URL（SSE/HTTP 传输） |
| `headers` | 自定义请求头 |
| `restartOnFailure` | 失败时是否自动重启 |
| `maxRestartAttempts` | 最大重启次数 |
| `disabled` | 是否禁用 |
| `alwaysAllow` | 始终允许的工具列表（跳过权限检查） |

## 注册与连接

### 代码方式

```typescript
import { registerMCPServer, connectMCPServer, getMCPServer } from 'SGA-Template'

// 注册 MCP 服务器
registerMCPServer({
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
  transport: 'stdio',
})

// 连接服务器（使用 MCPClient 完整协议握手）
await connectMCPServer('filesystem')

// 获取服务器状态
const state = getMCPServer('filesystem')
console.log(state.tools)     // 服务器提供的工具列表
console.log(state.resources) // 服务器提供的资源列表
```

### API 方式

```bash
curl -X POST http://localhost:3000/api/v1/mcp/servers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
    "transport": "stdio",
    "autoConnect": true,
    "saveToConfig": true
  }'
```

### 配置文件方式

配置文件路径：`$SGA_HOME/mcp-servers.json`

```json
[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
    "transport": "stdio"
  },
  {
    "name": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "transport": "stdio",
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
    }
  },
  {
    "name": "remote-tools",
    "transport": "sse",
    "url": "https://mcp-server.example.com",
    "headers": {
      "Authorization": "Bearer your-token"
    }
  },
  {
    "name": "remote-tools-v2",
    "transport": "streamable-http",
    "url": "https://mcp-server.example.com/mcp",
    "headers": {
      "Authorization": "Bearer your-token"
    }
  }
]
```

服务器启动时会自动加载此配置文件并连接所有未禁用的 MCP 服务器。

## MCPClient 客户端

> 📄 相关源文件：`src/mcp/client.ts`

`MCPClient` 实现了完整的 MCP 协议，支持 JSON-RPC 2.0 消息格式：

```typescript
import { MCPClient } from 'SGA-Template'

const client = new MCPClient('my-server', {
  name: 'my-server',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  transport: 'stdio',
})

// 连接（initialize + capabilities 握手）
await client.connect()

// 获取工具列表
const tools = client.getTools()

// 调用工具
const result = await client.callTool('read_file', { path: '/tmp/test.txt' })

// 读取资源
const resource = await client.readResource('file:///tmp/test.txt')

// 刷新能力（重新获取工具/资源/提示列表）
await client.refreshCapabilities()

// 断开连接
await client.disconnect()
```

### 支持的传输协议

| 传输方式 | 说明 | 适用场景 |
|----------|------|----------|
| `stdio` | 子进程 stdin/stdout 通信 | 本地 MCP 服务器 |
| `sse` | Server-Sent Events（SSE 远程传输） | 远程 MCP 服务器（旧版协议） |
| `streamable-http` | Streamable HTTP（HTTP 流式传输） | 远程 MCP 服务器（新版推荐） |

### Stdio 传输（本地）

Stdio 传输通过子进程的 stdin/stdout 进行 JSON-RPC 2.0 通信，适用于本地 MCP 服务器：

```typescript
const client = new MCPClient('local-fs', {
  name: 'local-fs',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  transport: 'stdio',
  env: { NODE_ENV: 'production' },
  cwd: '/home/user',
})
```

**实现细节：**
- 使用 `child_process.spawn` 启动子进程
- 消息以 `\n` 分隔的 JSON 格式传输
- 内置消息缓冲区处理跨数据包的消息边界问题
- 每个请求有 30 秒超时保护
- 子进程异常退出时自动拒绝所有待处理请求

### SSE 传输（远程 - 旧版协议）

SSE 传输实现了 MCP 协议规范中的 SSE 远程传输模式，基于 HTTP 长连接和 Server-Sent Events：

```typescript
const client = new MCPClient('remote-sse', {
  name: 'remote-sse',
  transport: 'sse',
  url: 'https://mcp-server.example.com',
  headers: {
    'Authorization': 'Bearer sk-xxx',
  },
})
```

**连接流程：**

```
1. 客户端 GET /sse          → 建立 SSE 事件流
2. 服务器发送 endpoint 事件   → 包含消息端点路径（如 /messages?sessionId=xxx）
3. 客户端 POST /messages     → 向消息端点发送 JSON-RPC 请求
4. 服务器响应                → 通过 SSE 事件流或 POST 响应返回结果
```

**实现细节：**
- **端点发现**：连接时先通过 SSE 流接收 `endpoint` 事件，获取消息发送端点
- **EventSource 支持**：优先使用 Node.js 内置 `EventSource`（22+），回退到 `eventsource` 包，最后使用 fetch-based fallback
- **双通道通信**：
  - SSE 流（GET /sse）：接收服务器推送的通知和响应
  - HTTP POST（消息端点）：发送客户端请求
- **响应格式处理**：自动识别 `application/json` 和 `text/event-stream` 两种响应格式
- **SSE 流解析**：完整解析 SSE 协议（`data:` / `id:` / `event:` 字段），支持事件 ID 跟踪

**配置示例：**

```json
{
  "name": "remote-tools",
  "transport": "sse",
  "url": "https://mcp-server.example.com",
  "headers": {
    "Authorization": "Bearer your-token"
  }
}
```

### Streamable HTTP 传输（远程 - 新版推荐）

Streamable HTTP 是 MCP 协议的新版远程传输方式，使用单一 HTTP 端点支持多种交互模式：

```typescript
const client = new MCPClient('remote-http', {
  name: 'remote-http',
  transport: 'streamable-http',
  url: 'https://mcp-server.example.com/mcp',
  headers: {
    'Authorization': 'Bearer sk-xxx',
  },
})
```

**连接流程：**

```
1. 客户端 GET /mcp (Accept: text/event-stream)  → 尝试建立服务器推送流
   - 200 + SSE → 建立独立通知流
   - 405 → 服务器不支持独立 SSE，使用 POST-only 模式
   - 其他错误 → 降级为 POST-only 模式

2. 客户端 POST /mcp (JSON-RPC 请求)              → 发送请求
   - 200 + application/json → 直接返回 JSON-RPC 响应
   - 200 + text/event-stream → SSE 流式返回响应
   - 202 Accepted → 通知已接收（无响应体）

3. 客户端 DELETE /mcp (MCP-Session-Id)            → 断开会话
```

**实现细节：**
- **会话管理**：通过 `MCP-Session-Id` 头部维护有状态会话，服务器在初始化响应中分配
- **协议版本**：请求中自动携带 `MCP-Protocol-Version: 2024-11-05` 头部
- **多模式响应**：
  - `application/json`：直接解析 JSON 响应
  - `text/event-stream`：流式读取 SSE 事件，提取 JSON-RPC 响应
  - `202 Accepted`：通知类消息，无返回值
- **会话过期处理**：当收到 404 响应时自动清除过期会话 ID
- **优雅断开**：断开连接时发送 DELETE 请求通知服务器清理会话
- **服务器推送流**：如果服务器支持 GET SSE 流，自动建立独立通知通道

**配置示例：**

```json
{
  "name": "remote-tools-v2",
  "transport": "streamable-http",
  "url": "https://mcp-server.example.com/mcp",
  "headers": {
    "Authorization": "Bearer your-token"
  }
}
```

### SSE vs Streamable HTTP 对比

| 特性 | SSE 传输 | Streamable HTTP 传输 |
|------|----------|---------------------|
| 协议版本 | MCP 旧版 | MCP 2024-11-05+ |
| 端点数量 | 2 个（/sse + /messages） | 1 个（/mcp） |
| 请求方式 | GET（接收）+ POST（发送） | POST（发送+接收） |
| 会话管理 | URL 参数（sessionId） | MCP-Session-Id 头部 |
| 服务器推送 | 始终需要 SSE 流 | 可选（405 降级） |
| 响应格式 | SSE 事件流 | JSON 或 SSE 流 |
| 断开方式 | 关闭连接 | DELETE 请求 |
| 推荐程度 | 兼容旧服务器 | 新项目推荐 |

## MCPToolAdapter 工具适配器

> 📄 相关源文件：`src/mcp/adapter.ts`

MCP 服务器提供的工具通过 `MCPToolAdapter` 自动适配为框架的 `Tool` 接口：

```typescript
import { createAllMCPToolAdapters, getConnectedMCPClients } from 'SGA-Template'

// 从所有已连接的 MCP 客户端创建工具适配器
const clients = getConnectedMCPClients()
const mcpToolAdapters = createAllMCPToolAdapters(clients)

// mcpToolAdapters 是 Tool[] 类型，可以直接传给 runAgent
```

### 适配规则

| MCPTool 属性 | Tool 属性 | 转换规则 |
|-------------|-----------|---------|
| `name` | `name` | 加前缀 `mcp__{serverName}__` |
| `description` | `description` | 加前缀 `[MCP:{serverName}]` |
| `inputSchema` | `input_schema` | 直接映射 |
| - | `isReadOnly()` | 默认 `true` |
| - | `isConcurrencySafe()` | 默认 `true` |
| - | `isDestructive()` | 默认 `false` |
| - | `checkPermissions()` | 默认 `allow` |

### 工具命名规范

MCP 工具在框架中的名称格式为 `mcp__{serverName}__{toolName}`，避免与内置工具冲突：

```
内置工具:  FileRead, FileWrite, Bash, Grep, ...
MCP 工具:  mcp__filesystem__read_file, mcp__github__create_issue, ...
```

## Agent 中的 MCP 工具集成

MCP 工具在 Agent 运行时自动合并到工具池中，无需手动配置：

```typescript
// routes.ts 中的集成方式
import { createBuiltinTools } from '../tools/built-in/index.js'
import { assembleToolPool } from '../tools/registry.js'
import { getConnectedMCPClients } from '../mcp/index.js'
import { createAllMCPToolAdapters } from '../mcp/adapter.js'

function buildToolPool(): Tool[] {
  const builtinTools = createBuiltinTools()
  const mcpClients = getConnectedMCPClients()
  const mcpToolAdapters = createAllMCPToolAdapters(mcpClients)
  return assembleToolPool(builtinTools, mcpToolAdapters)
}

// Agent 运行时自动使用包含 MCP 工具的完整工具池
const result = await runAgent({
  tools: buildToolPool(),
  // ...
})
```

### 调用流程

```
Agent 请求调用 mcp__filesystem__read_file
  → 执行管线 (pipeline.execute)
    → MCPToolAdapter.call()
      → MCPClient.callTool('read_file', args)
        → JSON-RPC 2.0 请求
          → MCP 服务器处理
        ← JSON-RPC 2.0 响应
      ← MCPCallResult
    ← 提取文本内容
  ← ToolExecutionResult
← 返回给 Agent
```

## MCP 服务器管理 API

| 函数 | 说明 |
|------|------|
| `registerMCPServer(config)` | 注册 MCP 服务器 |
| `unregisterMCPServer(name)` | 取消注册 |
| `getMCPServer(name)` | 获取服务器状态 |
| `getAllMCPServers()` | 获取所有服务器 |
| `getConnectedMCPServers()` | 获取已连接的服务器 |
| `getAllMCPTools()` | 获取所有 MCP 工具 |
| `getAllMCPResources()` | 获取所有 MCP 资源 |
| `getConnectedMCPClients()` | 获取所有已连接的 MCPClient 实例 |
| `connectMCPServer(name)` | 连接服务器 |
| `disconnectMCPServer(name)` | 断开服务器 |
| `connectAllMCPServers()` | 连接所有服务器 |
| `disconnectAllMCPServers()` | 断开所有服务器 |
| `refreshMCPServer(name)` | 刷新服务器能力列表 |
| `loadMCPServersFromConfig()` | 从配置文件加载 |

## MCPServerState

```typescript
// src/mcp/manager.ts
export interface MCPServerState {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  config: MCPServerConfig
  client: MCPClient | null
  tools: MCPTool[]
  resources: MCPResource[]
  error?: string
  connectedAt?: number
}
```

## 常用 MCP 服务器

| 服务器 | 命令 | 说明 |
|--------|------|------|
| Filesystem | `@modelcontextprotocol/server-filesystem` | 文件系统操作 |
| GitHub | `@modelcontextprotocol/server-github` | GitHub API |
| PostgreSQL | `@modelcontextprotocol/server-postgres` | PostgreSQL 数据库 |
| Brave Search | `@modelcontextprotocol/server-brave-search` | 网络搜索 |
| Google Drive | `@modelcontextprotocol/server-gdrive` | Google Drive |
| Puppeteer | `@modelcontextprotocol/server-puppeteer` | 浏览器自动化 |

## 相关文档

- [Skills 与 MCP 管理](skills-mcp-management.md)
- [自定义工具](custom-tools.md)
- [权限控制](permissions.md)
