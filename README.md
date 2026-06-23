<div align="center">

# ComfyUI Workflow Agent

![ComfyUI Workflow Agent](https://img.shields.io/badge/ComfyUI-Workflow%20Agent-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933)
![Express](https://img.shields.io/badge/Express-4-black)
![License](https://img.shields.io/badge/License-MIT-yellow)

**基于 SGA Agent 框架的智能 ComfyUI 工作流助手**

> 🤖 流式对话 · 📊 工作流分析 · 🔧 自动修复 · 🌐 多 AI 提供商
> [中文](#中文) | [English](#english)

</div>

---

## <a id="中文"></a>中文

### 一图速览

![系统架构](docs/diagrams/system-architecture.svg)

### 项目简介

**ComfyUI Workflow Agent** 是一款 AI 驱动的 ComfyUI 工作流助手插件。它基于 [SGA (Simple General Agent)](./sga_template) 框架构建，能够智能分析工作流结构、诊断错误、搜索 GitHub 解决方案、执行修复操作，并通过流式对话与用户交互。

随 ComfyUI 启动时自动运行，**无需手动配置服务器**。如果系统没有 Node.js，插件会自动下载安装。

### 核心功能

| 图标 | 功能 | 说明 |
|------|------|------|
| 🤖 | **智能对话** | SSE 流式响应，实时显示 AI 回复过程 |
| 🧠 | **意图识别** | 自动分析用户意图（诊断 / 解释 / 修改） |
| 📊 | **工作流分析** | 深入分析 ComfyUI 工作流 JSON 结构 |
| 🔍 | **GitHub 搜索** | 自动搜索 ComfyUI 相关 Issue 解决方案 |
| 🔧 | **工作流修改** | add / remove / connect / modify 节点 |
| ↩️ | **撤销** | 操作历史记录与一键撤销 |
| 🌐 | **多 AI 提供商** | Google / OpenAI / Anthropic / 任何 OpenAI 兼容 API |
| 🌏 | **多语言** | 中文 / 英文 / 日文 / 韩文 |
| 🛠️ | **简化配置** | 三步验证 + 一键拉取模型 |

### 工作流（动画演示）

![Agent 工作流](docs/diagrams/agent-workflow.svg)

> 💡 上述 SVG 包含动画：紫色光点沿主干流动代表数据流，工具节点（橙色）依次高亮表示被调用，决策点（黄色菱形）分叉动画表示分支判断。

### 快速开始

#### 1. 安装插件

将本项目放入 ComfyUI 的 `custom_nodes` 目录下：

```bash
cd ComfyUI/custom_nodes
git clone <repository-url> comfy_workflow_agent
```

> **Codex 集成**：本项目已把 Codex 源码（`openai/codex` 的 Rust 部分，Apache-2.0）**vendor** 到 `sga_template/codex-rs/`。无需 `git submodule`，克隆主仓库即获取全部源码。如要使用 Codex Agent，可选以下任一方式获取二进制：
>
> ```bash
> # 方式 1: 本地编译 (需要先装 Rust: winget install Rustlang.Rustup)
> node scripts/build-codex.mjs --app-server
> # → 产物: sga_template/codex-rs/target/release/codex-app-server(.exe)
> ```
>
> ```bash
> # 方式 2: 从 GitHub Release 下载预编译二进制 (推荐, 无需 Rust)
> # 详见 docs/release-codex.md
> ```
>
> 编译/下载产物放在 `sga_template/codex-rs/target/release/codex-app-server(.exe)`，SGA 启动时**自动探测到此路径**（探测优先级第 2 位，**优先于 OpenAI 官方安装**）。**SGA 在不编译 codex 的情况下完全可用**——只有切换到 Codex Agent 时才需要。
>
> **⚠️ 不要使用 OpenAI 官方 `codex.exe`**（`%LOCALAPPDATA%\OpenAI\Codex\bin\` 或 PATH 里的 `codex`）：它们**没有 Comfy Workflow Agent 身份注入**，会回退到默认 Codex CLI 行为。SGA 的 `detect.ts` 已**显式拒绝**官方安装。
>
> **🎭 Comfy Workflow Agent 身份**：本项目对 Codex 做了**完整身份重写** —— 切换到 Codex 后端后，模型表现得和 SGA 原生 Comfy Workflow Agent **完全一致**（自称、行为、Related Questions、共享记忆）。具体见 [docs/codex-agent-integration.md](docs/codex-agent-integration.md) 和 [ARCHITECTURE.md](ARCHITECTURE.md)。

#### 2. 启动 ComfyUI

正常启动 ComfyUI，插件会自动：

1. 检查 Node.js 环境（缺失时自动下载 Node.js v20 LTS）
2. 安装 `sga_template` 的 npm 依赖
3. 构建 TypeScript 项目
4. 在后台启动后端服务（默认 `http://127.0.0.1:8000`）

启动时你会看到类似日志：

```
🚀 Starting ComfyUI Workflow Agent Backend Server (SGA)
📡 Host: 127.0.0.1
🔌 Port: 8000
📚 API: http://127.0.0.1:8000/api/health
✅ Backend server is running on http://127.0.0.1:8000
```

#### 3. 配置 AI 提供商

新版本采用 **三步简化配置**：

![API 配置流程](docs/diagrams/api-config-flow.svg)

> 🎯 **设计原则**：默认只显示 4 个核心字段（平台名称 / 请求地址 / API Key / 协议），提供三个独立按钮：**验证地址 → 验证协议 → 拉取模型**。只有在验证失败时，才会自动展开「复杂配置(高级)」区域供高级用户调整。

**支持 4 种协议类型**：

| 协议 | 适用场景 |
|------|----------|
| OpenAI 直连 | OpenAI 官方及所有 OpenAI 兼容 API |
| 异步协议 | 火山引擎方舟 / 阿里云百炼等异步任务 API |
| Gemini 协议 | Google Gemini 原生 API |
| 自定义 | 自定义端点 + 自定义 Headers |

**通过 API 添加配置**（OpenAI 示例）：

```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "name": "OpenAI GPT-4",
    "api_key": "sk-your-key",
    "default_model": "gpt-4o",
    "is_default": true
  }'
```

**通过前端 UI 添加**（推荐）：

进入 ComfyUI 侧边栏 → 打开 ChatPanel → 右上角「设置」→ 切换「使用 Python 后端」→ 填入后端地址 → 点击「添加 Provider」。

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

data: {"chunk":"看","type":"content","metadata":{"node":"generate_response"}}

data: {"chunk":"发现","type":"content","metadata":{"node":"generate_response"}}

data: {"chunk":"","is_complete":true,"type":"end"}
```

#### 5. 配置 GitHub Token（可选）

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
| `POST` | `/api/v1/providers/verify-address` | 验证 API 地址可达性 |
| `POST` | `/api/v1/providers/verify-protocol` | 验证 API 协议兼容性 |
| `POST` | `/api/v1/providers/fetch-models` | 从上游拉取模型列表 |
| `POST` | `/api/v1/providers/verify-and-add` | 一站式验证 + 拉取 + 保存 |
| `GET` | `/api/github-token` | 检查 GitHub Token |
| `PUT` | `/api/github-token` | 更新 GitHub Token |
| `DELETE` | `/api/github-token` | 删除 GitHub Token |
| `GET` | `/api/health` | 健康检查 |

### 项目结构

```
comfy_workflow_agent/
├── __init__.py                          # ComfyUI 插件入口，自动启动后端
├── start_backend.py                     # 后端启动脚本
├── CHANGELOG.md                         # 变更日志 (Keep a Changelog 格式)
├── DEVLOG.md                            # 开发日志 (按时间倒序)
├── ARCHITECTURE.md                      # 项目结构与关键模块详解
├── docs/                                # 文档与图示
│   ├── diagrams/                        # SVG 图示（含动画）
│   │   ├── system-architecture.svg      # 系统架构
│   │   ├── agent-workflow.svg           # Agent 工作流（动画）
│   │   └── api-config-flow.svg          # API 配置流程（动画）
│   ├── tech-stack.md                    # 技术栈总览
│   ├── codex-agent-integration.md       # Codex 集成方案 (设计文档)
│   └── release-codex.md                 # 预编译 codex-app-server 下载指南
├── .github/workflows/
│   └── release-codex.yml                # Codex 二进制多平台 build + Release
├── web/                                 # 前端构建产物
├── sga_template/                        # SGA Agent 框架 + ComfyUI 后端
│   ├── SGA.md                           # SGA 注入的项目级 prompt
│   ├── src/
│   │   ├── agents/                      # Agent 后端（含 SGA / Codex）
│   │   │   └── codex/                   # Codex 子进程桥接
│   │   │       ├── detect.ts            #   - binary 探测 (拒绝 OpenAI 官方)
│   │   │       ├── process.ts           #   - 子进程生命周期
│   │   │       ├── jsonrpc.ts           #   - JSON-RPC over stdio
│   │   │       ├── event-bridge.ts      #   - 事件映射
│   │   │       ├── config.ts            #   - 临时 config.toml
│   │   │       └── context.ts           #   - SGA → Codex prompt 注入
│   │   ├── comfyui/                     # ComfyUI 工具 + 上下文写入
│   │   │   └── live-context.ts          #   - 工作流 → 磁盘文件 (IPC)
│   │   ├── tools/built-in/              # 30+ 内置工具
│   │   ├── server/                      # Express HTTP 服务
│   │   ├── providers/                   # LLM 提供商（含 verify 工具）
│   │   ├── mcp/                         # MCP 协议集成
│   │   ├── memory/                      # 记忆系统
│   │   └── skills/                      # 技能系统
│   └── codex-rs/                        # vendored Codex Rust 源码 (Apache-2.0)
│       ├── README-VENDORED.md           # License 合规说明
│       ├── Cargo.toml                   # workspace 根
│       ├── core/ app-server/ cli/ ...   # 子 crate
│       │   └── core/src/
│       │       ├── client.rs            #   - 已改造: 注入 Comfy Workflow Agent
│       │       └── comfyui_agent.rs     #   - 身份注入核心模块
│       └── target/release/              # 编译产物 (gitignored)
├── ui/                                  # React 前端源码
│   └── src/components/
│       ├── ChatPanel.tsx                # 聊天面板 (SGA/Codex 切换)
│       ├── CodexBuildProgressCard.tsx   # Codex 编译进度 UI
│       ├── SettingsModal.tsx            # 简化 API 配置 UI
│       └── WorkflowVisualizer.tsx
├── scripts/
│   ├── build-codex.mjs                  # 编译 codex-app-server (Node)
│   ├── build-codex.ps1                  # 编译 codex-app-server (PowerShell)
│   └── build_codex_worker.py            # Python 后台编译 worker
└── .node-runtime/                       # 自动安装的 Node.js（如需要）
```

> **配置存储位置**：AI 提供商配置和 GitHub Token 存储在 `~/.sga/comfyui/api_configs/` 目录下（可通过 `COMFYUI_CONFIG_DIR` 环境变量自定义）。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端服务端口 | `8000` |
| `HOST` | 后端服务地址 | `127.0.0.1` |
| `LOG_DIR` | 日志目录 | `logs/` |
| `LOG_ENABLE_FILE` | 是否启用文件日志 | `true` |
| `SESSION_DIR` | 会话存储目录 | `data/sessions/` |
| `GITHUB_TOKEN` | GitHub API Token | （空） |
| `COMFYUI_CONFIG_DIR` | ComfyUI 配置存储目录 | `~/.sga/comfyui` |
| `NODE_VERSION` | 自动安装的 Node.js 版本 | `20.18.0` |
| `SGA_HOME` | SGA 数据主目录 | `~/.sga` |

### 常见问题

**Q: 插件启动时自动安装 Node.js 需要多长时间？**
A: 下载 Node.js v20 LTS 约 30MB（Windows zip），取决于网速通常 1-3 分钟。安装后不会重复下载。

**Q: 支持哪些 AI 提供商？**
A: 内置支持 Google Gemini、OpenAI GPT、Anthropic Claude。通过 `custom` 类型可接入任何兼容 OpenAI 格式的 API（如 DeepSeek、通义千问、Qwen 等）。

**Q: 4 种协议类型有什么区别？**
A: OpenAI 直连 = 标准 `/v1/chat/completions`；异步协议 = 火山方舟等带任务轮询的 API；Gemini = Google 原生 `/v1beta/models`；自定义 = 自由配置端点/Headers。

**Q: 三步验证失败后，复杂配置能改什么？**
A: 可自定义 Models 端点路径、Chat 端点路径、HTTP Headers（含 `$apiKey` 占位符替换）、Max Tokens、Temperature。改完后再次点击「验证」即可。

**Q: 配置数据存储在哪里？**
A: AI 提供商配置存储在 `~/.sga/comfyui/api_configs/providers.json`，GitHub Token 存储在 `~/.sga/comfyui/api_configs/github_token.json`。可通过 `COMFYUI_CONFIG_DIR` 环境变量自定义路径。

**Q: 如何切换默认 AI 提供商？**
A: 调用 `POST /api/configs/set-default` 接口，或在创建配置时设置 `is_default: true`。

**Q: 对话支持哪些语言？**
A: 支持中文（zh）、英文（en）、日文（ja）、韩文（ko），在对话请求中通过 `language` 参数指定。

**Q: Codex 子模块是必需的吗？**
A: 不是。SGA 是默认 Agent，完全不依赖 codex。仅当你想切换到 Codex Agent 时才需要 `codex/` 子模块。详见 [docs/codex-submodule-setup.md](docs/codex-submodule-setup.md)。

---

## <a id="english"></a>English

### Visual Overview

![System Architecture](docs/diagrams/system-architecture.svg)

### Project Overview

**ComfyUI Workflow Agent** is an AI-powered workflow assistant plugin for ComfyUI. Built on the [SGA (Simple General Agent)](./sga_template) framework, it can intelligently analyze workflow structures, diagnose errors, search GitHub for solutions, execute repair operations, and interact with users through streaming conversations.

The plugin starts automatically with ComfyUI — no manual server configuration needed. If Node.js is not installed, the plugin will download and install it automatically.

### Core Features

| Icon | Feature | Description |
|------|---------|-------------|
| 🤖 | **Smart Chat** | SSE streaming responses, real-time AI reply display |
| 🧠 | **Intent Recognition** | Auto-classify user intent (diagnose / explain / modify) |
| 📊 | **Workflow Analysis** | In-depth ComfyUI workflow JSON analysis |
| 🔍 | **GitHub Search** | Auto-search ComfyUI-related issues |
| 🔧 | **Workflow Modification** | add / remove / connect / modify nodes |
| ↩️ | **Undo** | Action history with one-click rollback |
| 🌐 | **Multi-Provider** | Google / OpenAI / Anthropic / any OpenAI-compatible API |
| 🌏 | **Multi-language** | Chinese / English / Japanese / Korean |
| 🛠️ | **Simplified Config** | 3-step verification + one-click model fetching |

### Workflow (Animated)

![Agent Workflow](docs/diagrams/agent-workflow.svg)

> 💡 The SVG above includes animations: violet light points flowing down the main path represent data flow, tool nodes (orange) highlight in sequence as they're invoked, and decision diamonds (yellow) show branch evaluation.

### Quick Start

#### 1. Install Plugin

Place this project in ComfyUI's `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone <repository-url> comfy_workflow_agent
```

> **Codex Integration**: This project **vendors** the Codex source code (the Rust part of `openai/codex`, Apache-2.0) into `sga_template/codex-rs/`. No `git submodule` needed — the full source is included in the main clone. To use the Codex Agent, get the binary one of two ways:
>
> ```bash
> # Option 1: Build locally (requires Rust: winget install Rustlang.Rustup)
> node scripts/build-codex.mjs --app-server
> # → output: sga_template/codex-rs/target/release/codex-app-server(.exe)
> ```
>
> ```bash
> # Option 2: Download pre-built binary from GitHub Release (recommended, no Rust needed)
> # See docs/release-codex.md
> ```
>
> SGA auto-detects the vendored binary at `sga_template/codex-rs/target/release/codex-app-server(.exe)` (probe priority #2, **before** OpenAI official install). **SGA works fine without building codex** — only needed when switching to the Codex Agent.
>
> **⚠️ Do NOT use OpenAI official `codex.exe`** (`%LOCALAPPDATA%\OpenAI\Codex\bin\` or `PATH`): it has **no Comfy Workflow Agent identity injection** and will fall back to the default Codex CLI behavior. SGA's `detect.ts` **explicitly rejects** the official install.
>
> **🎭 Comfy Workflow Agent Identity**: The vendored Codex build is **completely re-skinned** — when you switch to the Codex backend, the model behaves identically to SGA's native Comfy Workflow Agent (self-description, behavior, Related Questions, shared memory). See [docs/codex-agent-integration.md](docs/codex-agent-integration.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

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

The new version uses a **3-step simplified configuration**:

![API Config Flow](docs/diagrams/api-config-flow.svg)

> 🎯 **Design principle**: Only 4 core fields are shown by default (Platform Name / Request URL / API Key / Protocol), with three independent buttons: **Verify Address → Verify Protocol → Fetch Models**. The "Advanced" panel auto-expands only when verification fails.

**4 supported protocol types**:

| Protocol | Use Case |
|----------|----------|
| OpenAI Direct | OpenAI official & all OpenAI-compatible APIs |
| Async Protocol | Volcengine Ark / Alibaba Bailian async task APIs |
| Gemini Protocol | Google Gemini native API |
| Custom | Custom endpoints + custom headers |

**Add via API** (OpenAI example):

```bash
curl -X POST http://127.0.0.1:8000/api/configs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "name": "OpenAI GPT-4",
    "api_key": "sk-your-key",
    "default_model": "gpt-4o",
    "is_default": true
  }'
```

**Add via Web UI** (recommended):

Open ComfyUI sidebar → ChatPanel → top-right → Settings → toggle "Use Python Backend" → fill backend URL → click "Add Provider".

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
| `POST` | `/api/v1/providers/verify-address` | Verify API address reachability |
| `POST` | `/api/v1/providers/verify-protocol` | Verify API protocol compatibility |
| `POST` | `/api/v1/providers/fetch-models` | Fetch upstream model list |
| `POST` | `/api/v1/providers/verify-and-add` | One-shot: verify + fetch + save |
| `GET` | `/api/github-token` | Check GitHub token |
| `PUT` | `/api/github-token` | Update GitHub token |
| `DELETE` | `/api/github-token` | Delete GitHub token |
| `GET` | `/api/health` | Health check |

### Project Structure

```
comfy_workflow_agent/
├── __init__.py                          # ComfyUI plugin entry, auto-starts backend
├── start_backend.py                     # Backend startup script
├── docs/                                # Documentation & diagrams
│   ├── diagrams/                        # SVG diagrams (with animations)
│   │   ├── system-architecture.svg      # System architecture
│   │   ├── agent-workflow.svg           # Agent workflow (animated)
│   │   └── api-config-flow.svg          # API config flow (animated)
│   ├── tech-stack.md                    # Tech stack overview
│   ├── resume-example.md                # Resume writing example
│   └── codex-submodule-setup.md         # Codex submodule setup guide
├── web/                                 # Frontend bundle
├── sga_template/                        # SGA Agent framework + backend
│   ├── src/
│   │   ├── agents/                      # Agent backends (SGA / Codex)
│   │   ├── tools/built-in/              # 30+ built-in tools
│   │   ├── server/                      # Express HTTP server
│   │   ├── providers/                   # LLM providers (with verify)
│   │   ├── mcp/                         # MCP integration
│   │   ├── memory/                      # Memory system
│   │   ├── skills/                      # Skills system
│   │   └── ...
│   ├── package.json
│   └── tsconfig.json
├── ui/                                  # React frontend source
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── SettingsModal.tsx        # Simplified API config UI
│   │   │   └── WorkflowVisualizer.tsx
│   │   ├── services/
│   │   │   └── configService.ts         # verify / fetch / save
│   │   └── utils/i18n.ts                # 4-language dictionary
│   ├── package.json
│   └── vite.config.ts
├── codex/                               # Codex submodule (optional, for Codex Agent)
└── .node-runtime/                       # Auto-installed Node.js (if needed)
```

> **Config storage**: AI provider configs and GitHub token are stored under `~/.sga/comfyui/api_configs/` (customizable via `COMFYUI_CONFIG_DIR` env).

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `8000` |
| `HOST` | Backend server host | `127.0.0.1` |
| `LOG_DIR` | Log directory | `logs/` |
| `LOG_ENABLE_FILE` | Enable file logging | `true` |
| `SESSION_DIR` | Session storage directory | `data/sessions/` |
| `GITHUB_TOKEN` | GitHub API Token | (empty) |
| `COMFYUI_CONFIG_DIR` | ComfyUI config storage directory | `~/.sga/comfyui` |
| `NODE_VERSION` | Auto-installed Node.js version | `20.18.0` |
| `SGA_HOME` | SGA data home directory | `~/.sga` |

### FAQ

**Q: How long does the automatic Node.js installation take?**
A: Node.js v20 LTS is about 30MB (Windows zip). Typically 1-3 minutes depending on network speed. It won't re-download once installed.

**Q: Which AI providers are supported?**
A: Built-in support for Google Gemini, OpenAI GPT, Anthropic Claude. The `custom` type allows any OpenAI-compatible API (DeepSeek, Qwen, etc.).

**Q: What's the difference between the 4 protocol types?**
A: OpenAI Direct = standard `/v1/chat/completions`; Async = Volcengine Ark / Alibaba Bailian async task APIs with polling; Gemini = Google native `/v1beta/models`; Custom = free-form endpoint + headers.

**Q: What can I change in the Advanced panel after verification fails?**
A: You can customize the Models endpoint path, Chat endpoint path, HTTP headers (with `$apiKey` placeholder substitution), Max Tokens, and Temperature. After editing, click "Verify" again to re-test.

**Q: Where is configuration data stored?**
A: AI provider configs in `~/.sga/comfyui/api_configs/providers.json`, GitHub token in `~/.sga/comfyui/api_configs/github_token.json`. Customizable via `COMFYUI_CONFIG_DIR`.

**Q: How to switch the default AI provider?**
A: Call `POST /api/configs/set-default`, or set `is_default: true` when creating a config.

**Q: Which languages are supported?**
A: Chinese (zh), English (en), Japanese (ja), Korean (ko). Specify via the `language` parameter in chat requests.

**Q: Is the Codex submodule required?**
A: No. SGA is the default agent and does not depend on codex at all. The `codex/` submodule is only needed if you want to switch to the Codex Agent. See [docs/codex-submodule-setup.md](docs/codex-submodule-setup.md).

---

## License

MIT
