# Skills 与 MCP 管理

> 📄 相关源文件：`src/server/skills-mcp-routes.ts`（管理 API 路由）、`src/skills/bundled-registry.ts`（技能注册中心）、`src/mcp/manager.ts`（MCP 管理器）

## 概述

SGA-Template 提供了三种方式来管理 Skills 和 MCP 服务器：API 接口、文件系统操作和 Agent 自动生成。

## 技能管理

### 方式一：API 接口

```bash
# 列出所有技能
curl http://localhost:3000/api/v1/skills

# 发现用户/项目技能
curl http://localhost:3000/api/v1/skills/discover

# 获取技能详情
curl http://localhost:3000/api/v1/skills/code-review

# 添加新技能
curl -X POST http://localhost:3000/api/v1/skills \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-skill",
    "description": "我的自定义技能",
    "prompt": "你是一个专业助手...",
    "userInvocable": true,
    "saveToDir": "user"
  }'

# 删除技能
curl -X DELETE http://localhost:3000/api/v1/skills/my-skill
```

### 方式二：文件系统操作

在以下目录中创建 Markdown 文件即可添加技能：

**用户级技能目录**：`~/.SGA-Template/skills/`

```bash
mkdir -p ~/.SGA-Template/skills/my-skill
cat > ~/.SGA-Template/skills/my-skill/skill.md << 'EOF'
---
name: my-skill
description: 我的自定义技能
user-invocable: true
---

你是一个专业助手，擅长 $ARGUMENTS。
EOF
```

**项目级技能目录**：`.skills/`

```bash
mkdir -p .skills/code-review
cat > .skills/code-review/skill.md << 'EOF'
---
name: code-review
description: 代码审查技能
allowed-tools: Read, Grep, Glob
---

你是一位代码审查专家，请审查 $ARGUMENTS。
EOF
```

### 方式三：Agent 自动生成

框架内置了 `skillify` 技能，允许 Agent 在运行过程中自动创建新技能：

```
用户：请帮我创建一个技能，用于自动格式化 Python 代码

Agent 会：
1. 分析需求
2. 生成技能 Markdown 文件
3. 保存到技能目录
4. 技能立即可用
```

## MCP 服务器管理

### 方式一：API 接口

```bash
# 列出所有 MCP 服务器
curl http://localhost:3000/api/v1/mcp/servers

# 获取服务器详情
curl http://localhost:3000/api/v1/mcp/servers/filesystem

# 添加 MCP 服务器
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

# 连接/断开服务器
curl -X POST http://localhost:3000/api/v1/mcp/servers/filesystem/connect
curl -X POST http://localhost:3000/api/v1/mcp/servers/filesystem/disconnect

# 删除服务器
curl -X DELETE http://localhost:3000/api/v1/mcp/servers/filesystem

# 列出所有 MCP 工具
curl http://localhost:3000/api/v1/mcp/tools
```

### 方式二：配置文件

配置文件路径：`~/.SGA-Template/mcp-servers.json`

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "transport": "stdio"
    }
  }
}
```

服务启动时会自动加载此配置文件并连接所有服务器。

### 方式三：Agent 自动生成

框架内置了 `mcp-generator` 技能，允许 Agent 在运行过程中自动创建 MCP 服务器：

```
用户：我需要一个 MCP 服务器来访问我的 Redis 数据库

Agent 会：
1. 分析需求
2. 生成 MCP 服务器代码
3. 注册并连接服务器
4. 新工具立即可用
```

## 内置技能列表

| 技能名 | 说明 |
|--------|------|
| `skillify` | 创建新技能 |
| `remember` | 保存记忆 |
| `simplify` | 简化代码 |
| `debug` | 调试代码 |
| `batch` | 批量操作 |
| `verify` | 验证结果 |
| `update-config` | 更新配置 |
| `stuck` | 处理卡住的情况 |
| `lorem-ipsum` | 生成占位文本 |
| `claude-api` | Claude API 调用 |
| `mcp-generator` | 生成 MCP 服务器 |

## 相关文档

- [技能系统](skills.md)
- [MCP 集成](mcp-integration.md)
- [自定义工具](custom-tools.md)
