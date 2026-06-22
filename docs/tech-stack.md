# 技术栈总览

> 版本: v0.7 · 最后更新: 2026-06-22
> 范围: `comfy_workflow_agent` ComfyUI 自定义节点 + SGA Agent 框架 + Codex Agent 子模块

本项目是一个 **ComfyUI 自定义节点**，内嵌一个 **Node.js + TypeScript** 的 Agent 后端服务（SGA），并通过子进程方式集成一个 **Rust** 编写的 Codex Agent。本文档列出项目所采用的全部主要技术栈。

---

## 1. 顶层架构一览

| 层 | 技术 | 说明 |
|---|------|------|
| ComfyUI 插件入口 | **Python 3** | `__init__.py` 由 ComfyUI 加载，负责环境检查 + 启动 Node.js 子进程 |
| 后端运行时 | **Node.js 20 LTS** | 通过 `node dist/server/main.js` 启动 Express HTTP 服务 |
| 后端语言 | **TypeScript 5.7+** | ESM 模块（`"type": "module"`），编译为 `dist/` |
| 后端框架 | **Express 4.21+** | 同时承载 `/api/*`（ComfyUI 配置存储）和 `/api/v1/*`（SGA Agent）两条路由前缀 |
| 备用 Agent 运行时 | **Rust (codex-rs)** | Codex CLI/app-server，作为子进程被 spawn |
| 前端 | **React 18 + Vite 5** | `ui/` 目录源码，编译产物输出到 `web/`，由 ComfyUI 直接托管 |
| 样式 | **Tailwind CSS 3.4** | 原子化 CSS |
| 状态/数据流 | React Hooks + 自研轻量 `t(lang, key)` i18n | 无 Redux / Zustand / i18next |
| 持久化 | **文件系统 JSON**（`providers.json`, `sessions/`, `memories/`） | 简单可靠，便于备份/迁移 |
| 进程间通信 | **JSON-RPC (stdio) + SSE** | Codex 子进程 JSON-RPC; 前端聊天用 Server-Sent Events |
| 外部协议 | **MCP (Model Context Protocol) 2024-11-05** | 连接 ComfyUI 自身的 `/mcp` 端点 |
| LLM SDK | **`@anthropic-ai/sdk` 0.80+** | Anthropic Claude 原生协议 |
| LLM 兼容协议 | 自研 OpenAI / Async / Gemini / Custom 4 种 provider 适配 | 支持任意 OpenAI 兼容 API |
| 数据校验 | **zod 3.23+** | 配置/请求体 schema 校验 |
| 日志 | 自研 `utils/logger.ts`（控制台 + 可选文件） | 通过 `LOG_DIR` / `LOG_ENABLE_FILE` 控制 |
| Lint/Format | **ESLint 8 + Prettier 3 + @typescript-eslint 8** | 仅前端 `ui/` 启用 |
| 构建 | **tsc 5.7**（后端） + **tsc + vite build**（前端） | 后端直接 `tsc`；前端 `tsc && vite build` |
| 测试 | 暂无统一框架 | 内置 `codex-e2e-*.ts` 等冒烟脚本 |
| 进程管理 | **PowerShell + msiexec/zip**（Windows）/ **apt-style**（Linux/macOS） | `__init__.py` 自动安装 Node.js |
| 国际化（前端） | 自研 4 语言（zh / en / ja / ko） | 嵌入式字典，无外部 i18n 库 |
| 国际化（后端） | 通过 `language` 请求参数动态切 prompt | 详见 `src/comfyui/context-injector.ts` |

---

## 2. 目录与技术栈映射

```
comfy_workflow_agent/
├── __init__.py                          # Python 3: ComfyUI 入口，环境探测 + 子进程管理
├── start_backend.py                     # Python 3: 后端启动脚本（早期入口，现由 __init__.py 整合）
├── sga_template/                        # Node.js + TypeScript: SGA Agent 框架
│   ├── src/
│   │   ├── server/                      # Express 4.21 HTTP 服务
│   │   │   ├── app.ts                   # Express 装配 + dotenv 加载
│   │   │   ├── main.ts                  # 启动入口（tsx / node dist）
│   │   │   ├── routes.ts                # 所有路由（/api + /api/v1）
│   │   │   ├── session-store.ts         # 文件系统会话存储（proper-lockfile）
│   │   │   └── interaction.ts           # 审批/用户输入请求桥
│   │   ├── agents/                      # Agent 后端（多 Agent 调度）
│   │   │   ├── sga-backend.ts           # SGA 后端（默认）
│   │   │   ├── codex-backend.ts         # Codex 后端（spawn Rust 子进程）
│   │   │   ├── codex/                   # Codex 集成层
│   │   │   │   ├── process.ts           # 子进程 spawn
│   │   │   │   ├── jsonrpc.ts           # JSON-RPC over stdio
│   │   │   │   ├── event-bridge.ts      # Codex 事件 → SGA 事件桥
│   │   │   │   ├── provider-proxy.ts    # OpenAI 兼容反代
│   │   │   │   └── detect.ts            # Codex binary 探测
│   │   │   ├── handoff/                 # Agent 切换时的黑板/提取
│   │   │   └── registry.ts              # AgentRegistry 单例
│   │   ├── providers/                   # LLM Provider 适配
│   │   │   ├── openai.ts                # OpenAI 直连
│   │   │   ├── anthropic.ts             # Anthropic 直连
│   │   │   ├── transformable-provider.ts# 通用 OpenAI 兼容适配
│   │   │   ├── provider-store.ts        # 内存 + 文件双层存储
│   │   │   └── verify.ts                # 验证/拉取/一站式 verify-and-add
│   │   ├── tools/built-in/              # 内置工具集
│   │   │   ├── workflow-analyzer.ts     # 工作流分析
│   │   │   ├── workflow-action.ts       # 工作流修改（add/remove/connect/modify）
│   │   │   ├── comfyui-api.ts           # ComfyUI HTTP API 工具
│   │   │   ├── comfyui-workflow-validate.ts
│   │   │   ├── comfyui-model-list.ts
│   │   │   ├── comfyui-node-search.ts
│   │   │   ├── github-search.ts         # GitHub 搜索（需 GITHUB_TOKEN）
│   │   │   ├── huggingface-download.ts  # HF mirror 支持
│   │   │   ├── civitai.ts               # Civitai 模型下载
│   │   │   ├── web-fetch.ts / web-search.ts
│   │   │   ├── bash.ts / file-read.ts / file-write.ts / file-edit.ts
│   │   │   └── …                        # 30+ 内置工具
│   │   ├── mcp/                         # MCP 协议客户端
│   │   │   ├── client.ts                # streamable-http / stdio 客户端
│   │   │   ├── manager.ts               # 多 server 管理
│   │   │   └── adapter.ts               # MCP 工具 → SGA 工具适配
│   │   ├── memory/                      # 多层记忆系统
│   │   │   ├── manager.ts               # 全局/项目/会话三级
│   │   │   ├── paths.ts                 # SGA_HOME 解析
│   │   │   ├── compact/                 # 上下文压缩（full/micro/session）
│   │   │   ├── consolidation/           # Auto-dream 整合
│   │   │   ├── storage/                 # filesystem / sql / vector / mongodb
│   │   │   └── extraction/              # 从对话中提取记忆
│   │   ├── skills/                      # 技能系统
│   │   ├── comfyui/                     # ComfyUI 专用扩展
│   │   │   ├── team-config.ts           # 团队配置
│   │   │   ├── hooks.ts                 # ComfyUI 钩子
│   │   │   └── mcp-server/              # 暴露给 Codex 的 MCP server
│   │   ├── context/                     # 上下文构建 + 压缩
│   │   ├── core/                        # Agent 主循环
│   │   ├── permissions/                 # 权限检查
│   │   ├── tasks/                       # 后台任务
│   │   ├── teams/                       # 团队协作（mailbox）
│   │   ├── telemetry/                   # 埋点
│   │   ├── feature-gate/                # 功能开关
│   │   ├── hooks/                       # 钩子系统
│   │   ├── utils/                       # logger, circuit-breaker, cost-tracker, helpers
│   │   └── config.ts                    # 全局配置
│   ├── package.json                     # @anthropic-ai/sdk, express, cors, dotenv, zod, chalk, p-map, picomatch, proper-lockfile, uuid, yaml
│   └── tsconfig.json                    # ESNext + ES2022 + strict
├── codex/                               # Rust 子模块（git submodule）
│   ├── codex-rs/                        # Rust workspace（app-server, cli, core, mcp, tui, …）
│   ├── codex-cli/                       # Node.js 封装的 CLI 入口
│   └── .github/workflows/               # CI: ci.yml / rust-ci.yml / sdk.yml / cla.yml / bazel.yml
├── ui/                                  # React + Vite 前端
│   ├── src/
│   │   ├── components/                  # ChatPanel, SettingsModal, WorkflowVisualizer
│   │   ├── services/                    # configService.ts, aiService.ts
│   │   ├── utils/i18n.ts                # 4 语言字典
│   │   └── types.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── vite.config.ts
│   └── package.json                     # react 18, react-dom 18, react-markdown 9, remark-gfm 4,
│                                        # @google/genai 1.39, @google/generative-ai 0.24,
│                                        # lucide-react 0.344, vite 5, tailwindcss 3.4, prettier 3
├── web/                                 # 前端构建产物（ComfyUI 静态资源）
│   ├── main.js                          # React 入口
│   ├── style.css                        # Tailwind 输出
│   ├── vendor-[hash].js                 # React vendor chunk
│   └── locales/{en,zh}/main.json        # Vite/ComfyUI 模板遗留（前端实际未使用）
├── docs/                                # 文档 + SVG 图
│   ├── codex-agent-integration.md
│   └── diagrams/*.svg
├── sga_template/data/.sga/              # SGA 运行时数据（与 SGA_HOME=./data/.sga 对齐）
│   ├── comfyui/api_configs/             # AI 供应商配置 + GitHub Token
│   ├── sessions/                        # 会话存储
│   ├── memories/                        # 记忆
│   ├── skills/                          # 用户技能
│   └── handoff/                         # Agent 切换黑板
└── .node-runtime/                       # 自动安装的 Node.js（Windows: nodejs/, Linux: nodejs/bin/）
```

---

## 3. 后端核心依赖 (sga_template/package.json)

| 包 | 版本 | 用途 |
|---|---|---|
| `@anthropic-ai/sdk` | `>=0.80.0` | Anthropic Claude 原生 LLM 客户端 |
| `express` | `^4.21.0` | HTTP 服务框架 |
| `cors` | `^2.8.5` | 跨域支持（默认 `*`） |
| `dotenv` | `^17.4.2` | 加载 `sga_template/.env` |
| `zod` | `^3.23.0` | Schema 校验 |
| `chalk` | `^5.6.2` | 控制台彩色日志 |
| `p-map` | `^7.0.4` | 并发 Map |
| `picomatch` | `^4.0.4` | glob 模式匹配 |
| `proper-lockfile` | `^4.1.2` | 文件锁（避免多进程并发写 `sessions/`） |
| `uuid` | `^10.0.0` | ID 生成 |
| `yaml` | `^2.8.3` | YAML 解析（provider / skill / agent 定义） |
| `tsx` | `^4.19.0` (dev) | 开发态直接执行 TypeScript |

> **peerDependencies**: `@anthropic-ai/sdk`

---

## 4. 前端核心依赖 (ui/package.json)

| 包 | 版本 | 用途 |
|---|---|---|
| `react` | `^18.2.0` | UI 框架 |
| `react-dom` | `^18.2.0` | React DOM 渲染 |
| `react-markdown` | `^9.0.1` | 渲染 AI 回复中的 Markdown |
| `remark-gfm` | `^4.0.0` | GFM 扩展（表格、任务列表、删除线） |
| `lucide-react` | `^0.344.0` | 图标库 |
| `@google/genai` | `^1.39.0` | Google Gemini 新版 SDK |
| `@google/generative-ai` | `^0.24.1` | Google Gemini 旧版 SDK（保留兼容） |
| `vite` | `^5.2.10` (dev) | 构建工具 + dev server |
| `@vitejs/plugin-react` | `^4.2.1` (dev) | React 快速刷新 |
| `tailwindcss` | `^3.4.1` (dev) | 原子化 CSS |
| `postcss` + `autoprefixer` | latest (dev) | CSS 后处理 |
| `typescript` | `^5.4.2` (dev) | TS 编译 |
| `eslint` | `^8.57.0` (dev) | 代码检查 |
| `@typescript-eslint/*` | `^8.0.0` (dev) | TS ESLint 插件 |
| `prettier` | `^3.2.5` (dev) | 代码格式化 |
| `@comfyorg/comfyui-frontend-types` | `^1.20.2` (dev) | ComfyUI 前端类型声明 |

---

## 5. Codex Rust 子模块 (codex/)

| Crate / 目录 | 用途 |
|---|---|
| `app-server` | 暴露 JSON-RPC over stdio（被 SGA 调用的主入口） |
| `core` | Agent 主循环、工具调用、沙箱（landlock, bwrap） |
| `mcp-server` | Codex 自身作为 MCP server |
| `protocol` | 客户端/服务端共享的协议类型 |
| `otel` | OpenTelemetry 埋点 |
| `tui` | 终端 UI（独立 Codex CLI 时使用，SGA 集成时不走） |
| `state` | 持久化（rollout, log_db, audit） |
| `exec` | 子进程执行 + 沙箱 |
| `login` | ChatGPT 登录（v0.5 已完全旁路） |
| `tools` / `mcp_tool` | Codex 工具系统 |
| `skills` | Codex 技能系统 |
| `secrets` | 密钥管理 |
| `analytics` | 分析埋点 |

> Rust 工具链: 通过 `rust-toolchain.toml` 固定版本; Windows 需 MSVC; Linux 需 gcc/clang。
> Bazel: `BUILD.bazel` / `MODULE.bazel`（与 Cargo 双轨构建）。

---

## 6. 跨进程与跨语言边界

```
┌──────────────────────────────┐
│  ComfyUI 进程 (Python 3)     │
│  - 加载 custom_nodes         │
│  - __init__.py 探测 Node.js  │
│  - Popen 启动 SGA 子进程     │
└──────────┬───────────────────┘
           │ subprocess.Popen (stdout=PIPE, text, encoding='utf-8')
           ▼
┌──────────────────────────────┐
│  SGA 后端 (Node.js 20)       │
│  - dist/server/main.js       │
│  - Express 监听 :8000        │
│  - dotenv 加载 .env          │
│  - ComfyUIConfigStore        │  ← 文件系统持久化（providers.json 等）
│  - ProviderStore             │  ← 内存 + 持久化（sga-provider.json）
│  - AgentRegistry             │  ← 单例, 调度 SGA / Codex
└────┬─────────────────────────┘
     │ spawn (JSON-RPC over stdio)
     ▼
┌──────────────────────────────┐
│  Codex app-server (Rust)     │
│  - codex/codex-rs/app-server │
│  - 接受 SGA 派发的任务       │
│  - 调 SGA 注入的 MCP server  │
│    (comfyui-api @ 8188/mcp)  │
└──────────────────────────────┘
     ▲
     │ HTTP (SSE, /api/chat/stream)
┌────┴─────────────────────────┐
│  前端 (React 18, 浏览器)     │
│  - 经 ComfyUI 静态资源托管   │
│  - 调 :8000 /api/* /api/v1/* │
└──────────────────────────────┘
```

---

## 7. 关键设计决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 模块系统 | **ESM (`"type": "module"`)** | 与现代 Node.js 一致; 但需注意 `import` 提升带来的模块加载顺序问题（已在 `routes.ts` 中通过惰性单例 `getComfyUIConfigStore()` 修复） |
| 配置存储 | **本地 JSON 文件** | 无外部依赖, 便于备份/迁移, 避免数据库部署成本 |
| LLM SDK | **自研多 provider + Anthropic SDK** | 一个项目内支持 OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容 API |
| Agent 切换 | **黑板 + 提取器** | SGA ↔ Codex 切换时序列化状态, 由 handoff/extractor 重建 |
| 前端 i18n | **自研 4 语言字典** | 项目体量无需 i18next; 字典嵌入 `i18n.ts` |
| 状态管理 | **React Hooks + props drilling** | 组件树深度可控; 无 Redux/Zustand 引入成本 |
| 沙箱 | **tool 级 permission checker** | 工具调用前在 `permissions/checker.ts` 中拦截敏感路径/命令 |
| 数据迁移 | **`migrateIfNeeded()` + `.migration_history.json`** | SGA_HOME 变更时自动迁移, 可回退 |
| 进程模型 | **ComfyUI 主进程 → SGA 子进程 → 可选 Codex 孙进程** | 故障隔离, ComfyUI 重启不影响持久化数据 |
| 实时通信 | **SSE (Server-Sent Events)** | 简单单向流, 无需 WebSocket 双工 |

---

## 8. 开发与运行

### 8.1 后端开发

```bash
cd sga_template
npm install
npm run dev      # tsx watch src/server/main.ts
npm run typecheck
npm run build    # tsc → dist/
```

### 8.2 前端开发

```bash
cd ui
npm install
npm run dev      # vite dev server
npm run typecheck
npm run build    # tsc && vite build → ../web/
npm run lint
```

### 8.3 一键启动（生产）

```bash
# 启动 ComfyUI,插件自动:
# 1) 探测或下载 Node.js 20.18.0
# 2) 在 sga_template/ 安装依赖 + 构建
# 3) 在 ui/ 安装依赖 + 构建到 web/
# 4) Popen 启动 node dist/server/main.js
# 5) 后台打印 stdout 到 ComfyUI 控制台
```

### 8.4 可选：构建 Codex

```bash
cd codex/codex-rs
cargo build --release -p codex-app-server
# 或 ./scripts/build-codex.ps1
```

---

## 9. 浏览器 / 运行平台要求

| 组件 | 最低版本 | 推荐 |
|---|---|---|
| ComfyUI | 任意 | 最新 |
| Python | 3.8+ | 3.11+ |
| Node.js | 18 LTS | 20.18.0（与 `NODE_VERSION` 默认对齐） |
| Rust (仅 Codex) | 1.78+ | stable |
| 浏览器 | Chrome 100+ / Firefox 100+ | 任意支持 ES2022 的现代浏览器 |
| 操作系统 | Windows 10 / macOS 12 / Ubuntu 20.04 | 最新 LTS |
