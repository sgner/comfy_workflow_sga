# ComfyUI Workflow Agent

<div align="center">

![ComfyUI Workflow Agent](https://img.shields.io/badge/ComfyUI-Workflow%20Agent-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6)
![Node.js](https://img.shights.io/badge/Node.js-20+-339933)
![Express](https://img.shields.io/badge/Express-4-black)
![License](https://img.shields.io/badge/License-MIT-yellow)

**基于 SGA Agent 框架的智能 ComfyUI 工作流助手**

[中文](#中文) | [English](#english)

</div>

---

## 中文

### 项目简介

ComfyUI Workflow Agent 是一个 AI 驱动的 ComfyUI 工作流助手插件。它基于 SGA（Simple General Agent）框架构建，能够智能分析工作流结构、诊断错误、搜索解决方案、执行修复操作，并通过流式对话与用户交互。

插件随 ComfyUI 启动时自动运行，无需手动配置服务器。如果系统没有 Node.js，插件会自动下载安装。

### 核心功能

#### 🤖 智能对话
- 流式响应，实时显示 AI 回复过程
- 自动分析用户意图（诊断、解释、修改工作流）
- 多语言支持（中文、英文、日文、韩文）
- 自动保存对话历史

#### 📊 工作流分析
- 深入分析 ComfyUI 工作流 JSON 结构
- 检测缺失输入、断开连接、类型不匹配等问题
- 追踪数据流向（如 Load Image → VAE Encode → KSampler → Decode）
- 识别关键节点（加载器、采样器、编码器、解码器、输出节点）
- 提供修复建议

#### 🔍 GitHub 问题搜索
- 搜索 ComfyUI 相关的 GitHub Issues
- 支持自定义 GitHub Token 提高搜索频率限制
- 自动提取错误相关的解决方案

#### ⚡ 工作流修改
- 添加节点（add_node）
- 删除节点（remove_node）
- 连接节点（connect_nodes）
- 断开连接（disconnect_nodes）
- 修改节点属性（modify_node）
- 自动修复工作流（fix_workflow）
- 操作历史记录与撤销（undo）

#### 🌐 多 AI 提供商支持
- **Google** — Gemini 系列
- **OpenAI** — GPT 系列
- **Anthropic** — Claude 系列
- **自定义 API** — 任何兼容 OpenAI 格式的 API（如 DeepSeek、通义千问等）

### 快速开始

#### 1. 安装插件

将本项目放入 ComfyUI 的 `custom_nodes` 目录：

```bash
cd ComfyUI/custom_nodes
git clone <repository-url> comfy_workflow_agent
```

#### 2. 启动 ComfyUI

正常启动 ComfyUI 即可，插件会自动：

1. 检测 Node.js 环境（如未安装则自动下载 Node.js v20 LTS）
2. 安装 `sga_template` 的 npm 依赖
3. 构建 TypeScript 项目
4. 在后台启动后端服务（默认 `http://127.0.0.1:8000`）

启动时你会看到如下日志：

```
🚀 Starting ComfyUI Workflow Agent Backend Server (SGA)
📡 Host: 127.0.0.1
🔌 Port: 8000
📚 API: http://127.0.0.1:8000/api/health
✅ Backend server is running on http://127.0.0.1:8000
```

#### 3. 配置 AI 提供商

首次使用需要配置至少一个 AI 提供商。通过 API 或前端界面添加配置：

**Google Gemini 示例：**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google",
    "name": "Google Gemini",
    "api_key": "your-google-api-key",
    "model_name": "gemini-2.0-flash-exp",
    "is_default": true
  }'
```

**OpenAI 示例：**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "name": "OpenAI GPT-4",
    "api_key": "your-openai-api-key",
    "model_name": "gpt-4o",
    "is_default": true
  }'
```

**Anthropic Claude 示例：**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "name": "Claude",
    "api_key": "your-anthropic-api-key",
    "model_name": "claude-sonnet-4-20250514",
    "is_default": true
  }'
```

**自定义 API 示例（DeepSeek 等）：**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "custom",
    "name": "DeepSeek",
    "api_key": "your-api-key",
    "model_name": "deepseek-chat",
    "base_url": "https://api.deepseek.com/v1",
    "is_default": false
  }'
```

#### 4. 开始对话

```bash
curl -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "帮我分析这个工作流有什么问题",
    "session_id": "my-session",
    "language": "zh",
    "workflow": { "nodes": [...], "links": [...] }
  }'
```

响应为 SSE（Server-Sent Events）流式格式：
```
data: {"chunk":"","type":"status_update","metadata":{"node":"classify_request","display_text":"正在分析您的意图...","status":"processing"}}

data: {"chunk":"","type":"status_update","metadata":{"node":"analyze_workflow","display_text":"正在深入分析 ComfyUI 工作流结构...","status":"processing"}}

data: {"chunk":"我","type":"content","metadata":{"node":"generate_response"}}

data: {"chunk":"发现","type":"content","metadata":{"node":"generate_response"}}

data: {"chunk":"","is_complete":true,"type":"end"}
```

#### 5. 配置 GitHub Token（可选）

配置 GitHub Token 可以提高搜索频率限制：

```bash
curl -X PUT http://127.0.0.1:8000/api/github-token \
  -H "Content-Type: application/json" \
  -d '{"token": "ghp_your_github_token"}'
```

### API 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/chat/stream` | 流式对话（SSE） |
| `GET` | `/api/chat/history/:sessionId` | 获取对话历史 |
| `POST` | `/api/workflow/analyze` | 分析工作流 |
| `POST` | `/api/workflow/parse` | 解析工作流 |
| `POST` | `/api/actions/execute` | 执行工作流操作 |
| `POST` | `/api/actions/undo` | 撤销上一步操作 |
| `GET` | `/api/configs` | 列出所有配置 |
| `POST` | `/api/configs` | 创建配置 |
| `GET` | `/api/configs/:id` | 获取单个配置 |
| `PUT` | `/api/configs/:id` | 更新配置 |
| `DELETE` | `/api/configs/:id` | 删除配置 |
| `POST` | `/api/configs/set-default` | 设置默认配置 |
| `GET` | `/api/github-token` | 检查 GitHub Token |
| `PUT` | `/api/github-token` | 更新 GitHub Token |
| `DELETE` | `/api/github-token` | 删除 GitHub Token |
| `GET` | `/api/health` | 健康检查 |

### 项目结构

```
comfy_workflow_agent/
├── __init__.py                         # ComfyUI 插件入口，自动启动后端
├── nodes.py                            # ComfyUI 节点定义
├── web/                                # 前端界面资源
│   ├── main.js                         # 前端 JS
│   ├── style.css                       # 样式
│   └── locales/                        # 国际化
│       ├── en/main.json
│       └── zh/main.json
├── sga_template/                       # SGA Agent 框架 + ComfyUI 后端
│   ├── src/
│   │   ├── agents/
│   │   │   └── built-in/
│   │   │       └── comfyui-agent.ts    # ComfyUI 工作流 Agent 定义
│   │   ├── tools/built-in/
│   │   │   ├── workflow-analyzer.ts    # 工作流分析工具
│   │   │   ├── workflow-action.ts      # 工作流修改工具
│   │   │   └── github-search.ts        # GitHub 搜索工具
│   │   ├── server/
│   │   │   ├── comfyui-main.ts         # 服务器入口
│   │   │   ├── comfyui-routes.ts       # API 路由（兼容前端）
│   │   │   └── comfyui-config-store.ts # 配置存储
│   │   ├── providers/                  # LLM 提供商支持
│   │   ├── mcp/                        # MCP 协议集成
│   │   ├── memory/                     # 记忆系统
│   │   ├── skills/                     # 技能系统
│   │   └── ...                         # 其他 SGA 框架模块
│   ├── package.json
│   ├── tsconfig.json
│   └── .env                           # 环境变量配置（PORT, HOST, LLM_PROVIDER 等）
└── .node-runtime/                      # 自动安装的 Node.js（如需要）
```

> **配置存储位置**：AI 提供商配置和 GitHub Token 存储在 `~/.sga/comfyui/api_configs/` 目录下（可通过 `COMFYUI_CONFIG_DIR` 环境变量自定义）。

### 对话流程

当用户发送消息时，系统按以下流程处理：

```
用户消息 + 工作流数据
        │
        ▼
  ┌─────────────────┐
  │ classify_request │  分析用户意图
  └────────┬────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
 需要搜索?   需要分析?
     │           │
     ▼           ▼
┌──────────┐ ┌──────────────┐
│ github   │ │ workflow     │
│ search   │ │ analyzer     │
└────┬─────┘ └──────┬───────┘
     │              │
     └──────┬───────┘
            ▼
   ┌─────────────────┐
   │ 需要修改工作流?  │
   └────────┬────────┘
            │
     ┌──────┴──────┐
     │             │
     ▼             ▼
  是              否
     │             │
     ▼             │
┌──────────────┐  │
│ workflow     │  │
│ action       │  │
└──────┬───────┘  │
       │          │
       └────┬─────┘
            ▼
   ┌─────────────────┐
   │ generate_response│  生成最终回复
   └─────────────────┘
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端服务端口 | `8000` |
| `HOST` | 后端服务地址 | `127.0.0.1` |
| `LOG_DIR` | 日志目录 | `logs/` |
| `LOG_ENABLE_FILE` | 是否启用文件日志 | `true` |
| `SESSION_DIR` | 会话存储目录 | `data/sessions/` |
| `GITHUB_TOKEN` | GitHub API Token | — |
| `COMFYUI_CONFIG_DIR` | ComfyUI 配置存储目录 | `~/.sga/comfyui` |
| `NODE_VERSION` | 自动安装的 Node.js 版本 | `20.18.0` |
| `SGA_HOME` | SGA 数据主目录 | `~/.sga` |

### 常见问题

**Q: 插件启动时自动安装 Node.js 需要多长时间？**
A: 下载 Node.js v20 LTS 约 30MB（Windows zip），取决于网速通常 1-3 分钟。安装后不会重复下载。

**Q: 支持哪些 AI 提供商？**
A: 内置支持 Google Gemini、OpenAI GPT、Anthropic Claude。通过 `custom` 类型可接入任何兼容 OpenAI 格式的 API。

**Q: 配置数据存储在哪里？**
A: AI 提供商配置存储在 `~/.sga/comfyui/api_configs/providers.json`，GitHub Token 存储在 `~/.sga/comfyui/api_configs/github_token.json`。可通过 `COMFYUI_CONFIG_DIR` 环境变量自定义路径。

**Q: 如何切换默认 AI 提供商？**
A: 调用 `POST /api/configs/set-default` 接口，或在创建配置时设置 `is_default: true`。

**Q: 对话支持哪些语言？**
A: 支持中文（zh）、英文（en）、日文（ja）、韩文（ko），在对话请求中通过 `language` 参数指定。

---

## English

### Project Overview

ComfyUI Workflow Agent is an AI-powered workflow assistant plugin for ComfyUI. Built on the SGA (Simple General Agent) framework, it can intelligently analyze workflow structures, diagnose errors, search for solutions, execute repair operations, and interact with users through streaming conversations.

The plugin starts automatically with ComfyUI — no manual server configuration needed. If Node.js is not installed, the plugin will download and install it automatically.

### Core Features

#### 🤖 Intelligent Chat
- Streaming responses with real-time AI reply display
- Automatic intent analysis (diagnose, explain, modify workflow)
- Multi-language support (Chinese, English, Japanese, Korean)
- Automatic chat history persistence

#### 📊 Workflow Analysis
- In-depth analysis of ComfyUI workflow JSON structure
- Detect missing inputs, broken connections, type mismatches
- Trace data flow (e.g., Load Image → VAE Encode → KSampler → Decode)
- Identify key nodes (loaders, samplers, encoders, decoders, outputs)
- Provide fix suggestions

#### 🔍 GitHub Issue Search
- Search ComfyUI-related GitHub Issues
- Support custom GitHub Token for higher rate limits
- Automatically extract error-related solutions

#### ⚡ Workflow Modification
- Add nodes (`add_node`)
- Remove nodes (`remove_node`)
- Connect nodes (`connect_nodes`)
- Disconnect nodes (`disconnect_nodes`)
- Modify node properties (`modify_node`)
- Auto-fix workflow (`fix_workflow`)
- Action history and undo support

#### 🌐 Multi AI Provider Support
- **Google** — Gemini series
- **OpenAI** — GPT series
- **Anthropic** — Claude series
- **Custom API** — Any OpenAI-compatible API (e.g., DeepSeek, Qwen, etc.)

### Quick Start

#### 1. Install Plugin

Place this project in ComfyUI's `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone <repository-url> comfy_workflow_agent
```

#### 2. Start ComfyUI

Start ComfyUI normally. The plugin will automatically:

1. Check for Node.js (auto-download Node.js v20 LTS if not installed)
2. Install `sga_template` npm dependencies
3. Build the TypeScript project
4. Start the backend server in the background (default: `http://127.0.0.1:8000`)

You will see startup logs like:

```
🚀 Starting ComfyUI Workflow Agent Backend Server (SGA)
📡 Host: 127.0.0.1
🔌 Port: 8000
📚 API: http://127.0.0.1:8000/api/health
✅ Backend server is running on http://127.0.0.1:8000
```

#### 3. Configure AI Provider

Configure at least one AI provider on first use:

**Google Gemini:**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google",
    "name": "Google Gemini",
    "api_key": "your-google-api-key",
    "model_name": "gemini-2.0-flash-exp",
    "is_default": true
  }'
```

**OpenAI:**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "name": "OpenAI GPT-4",
    "api_key": "your-openai-api-key",
    "model_name": "gpt-4o",
    "is_default": true
  }'
```

**Anthropic Claude:**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "name": "Claude",
    "api_key": "your-anthropic-api-key",
    "model_name": "claude-sonnet-4-20250514",
    "is_default": true
  }'
```

**Custom API (DeepSeek, etc.):**
```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "custom",
    "name": "DeepSeek",
    "api_key": "your-api-key",
    "model_name": "deepseek-chat",
    "base_url": "https://api.deepseek.com/v1",
    "is_default": false
  }'
```

#### 4. Start Chatting

```bash
curl -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Help me analyze this workflow for issues",
    "session_id": "my-session",
    "language": "en",
    "workflow": { "nodes": [...], "links": [...] }
  }'
```

Responses use SSE (Server-Sent Events) streaming format.

#### 5. Configure GitHub Token (Optional)

```bash
curl -X PUT http://127.0.0.1:8000/api/github-token \
  -H "Content-Type: application/json" \
  -d '{"token": "ghp_your_github_token"}'
```

### API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat/stream` | Streaming chat (SSE) |
| `GET` | `/api/chat/history/:sessionId` | Get chat history |
| `POST` | `/api/workflow/analyze` | Analyze workflow |
| `POST` | `/api/workflow/parse` | Parse workflow |
| `POST` | `/api/actions/execute` | Execute workflow action |
| `POST` | `/api/actions/undo` | Undo last action |
| `GET` | `/api/configs` | List all configs |
| `POST` | `/api/configs` | Create config |
| `GET` | `/api/configs/:id` | Get single config |
| `PUT` | `/api/configs/:id` | Update config |
| `DELETE` | `/api/configs/:id` | Delete config |
| `POST` | `/api/configs/set-default` | Set default config |
| `GET` | `/api/github-token` | Check GitHub token |
| `PUT` | `/api/github-token` | Update GitHub token |
| `DELETE` | `/api/github-token` | Delete GitHub token |
| `GET` | `/api/health` | Health check |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `8000` |
| `HOST` | Backend server host | `127.0.0.1` |
| `LOG_DIR` | Log directory | `logs/` |
| `LOG_ENABLE_FILE` | Enable file logging | `true` |
| `SESSION_DIR` | Session storage directory | `data/sessions/` |
| `GITHUB_TOKEN` | GitHub API Token | — |
| `COMFYUI_CONFIG_DIR` | ComfyUI config storage directory | `~/.sga/comfyui` |
| `NODE_VERSION` | Auto-installed Node.js version | `20.18.0` |
| `SGA_HOME` | SGA data home directory | `~/.sga` |

### FAQ

**Q: How long does the automatic Node.js installation take?**
A: Node.js v20 LTS is about 30MB (Windows zip). Typically 1-3 minutes depending on network speed. It won't re-download once installed.

**Q: Which AI providers are supported?**
A: Built-in support for Google Gemini, OpenAI GPT, and Anthropic Claude. The `custom` type allows any OpenAI-compatible API.

**Q: Where is configuration data stored?**
A: AI provider configs are in `~/.sga/comfyui/api_configs/providers.json`, GitHub Token in `~/.sga/comfyui/api_configs/github_token.json`. Customizable via the `COMFYUI_CONFIG_DIR` environment variable.

**Q: How to switch the default AI provider?**
A: Call `POST /api/configs/set-default`, or set `is_default: true` when creating a config.

**Q: Which languages are supported?**
A: Chinese (zh), English (en), Japanese (ja), Korean (ko). Specify via the `language` parameter in chat requests.

### License

MIT
