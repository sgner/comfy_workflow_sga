# SGA-Template

> 可扩展的 Agent 框架，支持多 LLM 供应商、工具系统、技能系统、MCP 集成和人机交互。

## 特性

- 🤖 **多 LLM 供应商** — 支持 Anthropic、OpenAI 兼容供应商（DeepSeek、通义千问等），可扩展自定义供应商
- 🛠 **工具系统** — 内置 12+ 工具（文件操作、终端、网络搜索等），支持自定义工具
- 🧠 **技能系统** — 预定义提示词模板，支持 API / 文件系统 / Agent 自动生成三种添加方式
- 🔌 **MCP 集成** — 完整的 Model Context Protocol 支持，连接外部工具和数据源
- 👥 **人机交互** — 审批请求和输入请求机制，Agent 可暂停等待用户确认
- 📝 **记忆系统** — 跨会话保留和检索信息
- 🔒 **权限控制** — 多种权限模式，精细控制工具执行权限
- 🪝 **Hook 系统** — 在工具调用前后插入自定义逻辑
- 📊 **上下文压缩** — 智能压缩历史消息，突破上下文窗口限制
- 🏗 **团队协作** — 多 Agent 协作，邮箱消息传递

## 快速开始

```bash
cd cc_contron && npm install
npm run dev
```

访问 `http://localhost:3000/api/v1/health` 验证服务。

> 详见 [快速开始](docs/quick-start.md)

## 文档目录

### 入门

| 文档 | 说明 |
|------|------|
| [快速开始](docs/quick-start.md) | 安装、启动、第一次对话 |
| [项目架构](docs/architecture.md) | 整体结构、模块依赖、核心数据流 |
| [环境变量](docs/environment-variables.md) | 配置 LLM 供应商和服务参数 |

### 使用方式

| 文档 | 说明 |
|------|------|
| [作为后端服务使用](docs/backend-service.md) | REST API、SSE 流式输出、会话管理 |
| [作为库使用](docs/library-usage.md) | 在代码中直接调用 runAgent |
| [为任何产品提供 Agent 后端](docs/agent-backend.md) | 前端集成、安全建议、架构模式 |

### 二次开发

| 文档 | 说明 |
|------|------|
| [自定义工具](docs/custom-tools.md) | Tool 接口、BaseTool 基类、注册与执行管线 |
| [自定义 Agent](docs/custom-agent.md) | AgentDefinition 接口、分叉执行、执行引擎 |
| [自定义系统提示词](docs/custom-prompt.md) | SystemPromptSection、优先级覆盖、动态内容 |
| [内置工具一览](docs/builtin-tools.md) | 12+ 内置工具的详细说明 |

### 核心机制

| 文档 | 说明 |
|------|------|
| [多供应商 LLM 接入](docs/multi-provider.md) | Provider 接口、注册中心、自定义供应商 |
| [人机交互机制](docs/human-interaction.md) | 审批请求、输入请求、SSE 事件、前端集成 |
| [权限控制](docs/permissions.md) | PermissionMode、PermissionChecker、检查流程 |
| [Hook 钩子系统](docs/hooks.md) | HookEventType、注册与执行、使用场景 |
| [上下文压缩](docs/context-compression.md) | 压缩策略、触发条件、API |

### 扩展系统

| 文档 | 说明 |
|------|------|
| [技能系统](docs/skills.md) | 技能文件格式、发现、激活、注册中心 |
| [Skills 与 MCP 管理](docs/skills-mcp-management.md) | 三种管理方式：API / 文件系统 / Agent 生成 |
| [MCP 集成](docs/mcp-integration.md) | MCP 服务器配置、连接、工具适配 |
| [记忆系统](docs/memory.md) | 记忆文件格式、扫描、检索、提示词构建 |
| [任务与团队协作](docs/tasks-teams.md) | TaskManager、团队邮箱、协作模式 |

### 参考

| 文档 | 说明 |
|------|------|
| [API 参考](docs/api-reference.md) | 完整的 REST API 接口文档 |

## 技术栈

- **语言**：TypeScript
- **运行时**：Node.js
- **HTTP 框架**：Express.js
- **流式输出**：SSE (Server-Sent Events)
- **LLM SDK**：Anthropic SDK / OpenAI SDK

## 项目结构

```
src/
├── core/           # 核心类型与状态机
├── agents/         # Agent 定义与运行
├── tools/          # 工具系统
├── api/            # LLM API 客户端
├── providers/      # 多供应商 LLM 接入
├── context/        # 上下文管理
├── memory/         # 记忆系统
├── skills/         # 技能系统
├── permissions/    # 权限系统
├── hooks/          # Hook 钩子系统
├── mcp/            # MCP 协议集成
├── tasks/          # 任务系统
├── teams/          # 团队协作
├── server/         # HTTP 服务层
└── utils/          # 工具函数
```

> 详见 [项目架构](docs/architecture.md)

## License

MIT
