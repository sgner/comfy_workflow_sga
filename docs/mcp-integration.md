# MCP 集成

> 📄 相关源文件：`src/mcp/manager.ts`（MCPManager 类）、`src/mcp/types.ts`（类型定义）、`src/mcp/client.ts`（MCP 客户端）

## 概述

MCP（Model Context Protocol）是一种标准化的协议，允许 Agent 连接外部工具和数据源。SGA-Template 内置了完整的 MCP 支持，可以轻松接入任何 MCP 兼容的服务器。

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

// 连接服务器
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

配置文件路径：`~/.SGA-Template/mcp-servers.json`

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "transport": "stdio"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "transport": "stdio",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

## MCP 工具适配

MCP 服务器提供的工具会自动适配为 SGA-Template 的 `Tool` 接口，可以与内置工具无缝配合使用：

```typescript
import { getAllMCPTools } from 'SGA-Template'

const mcpTools = getAllMCPTools()
// mcpTools 是 Tool[] 类型，可以直接传给 runAgent
```

## MCP 服务器管理 API

| 函数 | 说明 |
|------|------|
| `registerMCPServer(config)` | 注册 MCP 服务器 |
| `unregisterMCPServer(name)` | 取消注册 |
| `getMCPServer(name)` | 获取服务器状态 |
| `getAllMCPServers()` | 获取所有服务器 |
| `getAllMCPTools()` | 获取所有 MCP 工具 |
| `connectMCPServer(name)` | 连接服务器 |
| `disconnectMCPServer(name)` | 断开服务器 |
| `connectAllMCPServers()` | 连接所有服务器 |
| `loadMCPServersFromConfig()` | 从配置文件加载 |

## MCPServerState

```typescript
// src/mcp/types.ts
export interface MCPServerState {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  config: MCPServerConfig
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
