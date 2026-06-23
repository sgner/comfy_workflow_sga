# 项目结构与关键模块

> 维护者: sgner · 远程仓库: https://github.com/sgner/comfy_workflow_sga.git
>
> 本文档用一句话描述每个**关键文件**是什么、为什么存在。
> 读者目标：第一次接触项目的人能快速找到需要的模块。

## 顶层

```
comfy_workflow_agent/
├── __init__.py                # ComfyUI 插件入口：自动启动 SGA 后端
├── nodes.py                   # ComfyUI 自定义节点定义
├── start_backend.py           # 后端启动脚本（被 __init__ 调用）
├── pyproject.toml             # Python 包配置
├── requirements.txt           # Python 依赖
├── README.md                  # 用户文档（中英双语）
├── CHANGELOG.md               # 版本变更日志
├── DEVLOG.md                  # 开发日志（本次新增）
├── ARCHITECTURE.md            # 本文档
│
├── .github/workflows/
│   └── release-codex.yml      # Codex 二进制多平台 build + Release（本次新增）
│
├── docs/
│   ├── tech-stack.md
│   ├── codex-agent-integration.md
│   ├── rust-install-guide.md
│   ├── release-codex.md       # 预编译下载文档（本次新增）
│   └── diagrams/              # 系统/工作流/API 配置 SVG
│
├── scripts/
│   ├── build-codex.mjs        # Node 端 build 脚本
│   ├── build-codex.ps1        # PowerShell 端 build 脚本
│   ├── build_codex_worker.py  # Python 后台 build worker
│   ├── install-rust.ps1
│   └── parse-cargo-lock.*     # cargo lock 解析
│
├── ui/                        # React 前端（Vite）
│   └── src/components/CodexBuildProgressCard.tsx  # build 进度 UI（本次新增）
│
└── sga_template/              # SGA Agent 框架 + Codex Rust 源码
    ├── SGA.md                 # SGA 注入的项目级 prompt
    ├── package.json
    ├── tsconfig.json
    ├── src/                   # SGA TypeScript 源码
    │   ├── agents/            # Agent 后端（SGA / Codex）
    │   ├── comfyui/           # ComfyUI 工具 + live-context 写入（本次新增）
    │   ├── providers/         # LLM 提供商
    │   ├── server/            # Express HTTP 服务
    │   ├── memory/            # 记忆系统
    │   └── ...
    └── codex-rs/              # vendored Codex 源码（Rust, Apache-2.0）
        └── core/src/
            ├── client.rs           # OpenAI 客户端（已改造：注入 Comfy Workflow Agent）
            ├── comfyui_agent.rs    # ComfyUI 身份注入（本次新增）
            └── lib.rs              # 模块注册（本次新增 mod comfyui_agent）
```

---

## 关键模块详解

### 1. Codex Comfy Workflow Agent 身份注入（本次新增）

#### `sga_template/codex-rs/core/src/comfyui_agent.rs` (NEW)

**职责**：在 Codex model 看到 system prompt 的最前面，注入"Comfy Workflow Agent"身份块。

**三个子函数**：
- `build_prefix()` — 入口，返回 `&'static str`（`OnceCell` 缓存）
- `build_env_context()` — 扫 ComfyUI 目录结构、读 SGA.md
- `build_blackboard_section()` — 读 `<SGA_HOME>/shared/blackboard.json`
- `build_live_context_section()` — 读 `<SGA_HOME>/shared/comfyui/*.json`（实时工作流）

**为什么需要它**：Codex 默认的 system prompt 让 model 自认是"codex CLI coding agent"，
对 ComfyUI 工作流毫无概念。SGA 的 `comfyui-agent.ts` 写得很好（"我看懂工作流 / 排查报错 /
修改工作流 JSON"），把这部分 1:1 翻译成 Rust 字符串常量注入到 Codex，
让 Codex **表现得像 SGA 的 Comfy Workflow Agent**。

**为什么不只用 TS 端做**：codex 进程是独立 Rust 二进制，只读 `thread/start` 的
`developerInstructions`。这部分在 `codex-context.ts` 也做了一次（兜底），
但 Rust 端是最权威的注入点 —— 任何其他方式传 system prompt 都会先经过我们。

#### `sga_template/codex-rs/core/src/client.rs` (MODIFIED)

**职责**：构建发往 OpenAI 的 `ResponsesApiRequest` 时调用
`comfyui_agent::build_prefix()`，把前缀拼到 `instructions` 字段。

**修改点**：原来用 `const IDENTITY: &str` 静态常量；
改为 `async fn` 调用 + `OnceCell` 缓存。

#### `sga_template/codex-rs/core/src/lib.rs` (MODIFIED)

加 `pub(crate) mod comfyui_agent;` 一行，让 crate 内其他文件能 import。

### 2. Codex 端 SGA 兜底（本次新增）

#### `sga_template/src/agents/codex/context.ts` (NEW)

**职责**：在 SGA 这一侧，给 Codex 进程发 `thread/start` 之前，组装一份
**developer-level system prompt**（`developerInstructions` 字段）。

**组装来源**：
1. `SGA.md`（项目级 prompt）
2. Blackboard（共享热数据）
3. ComfyUI agent identity block（从 `comfyui-agent.ts` 直接读）
4. Live ComfyUI context（`live-context.ts` 写到磁盘的 4 个 JSON）

**为什么需要它**：Rust 端注入 + TS 端注入是**双重保险**。
Rust 端是权威（必走），TS 端兜底（如果 codex 进程不读 `developerInstructions`，
至少 model 在 message 早期能看到 SGA 的指令）。

#### `sga_template/src/comfyui/live-context.ts` (NEW)

**职责**：在 SGA 处理 `/api/chat/stream` 时，原子地把当前工作流上下文写到
`<SGA_HOME>/shared/comfyui/`：

- `workflow.json` — 完整 ComfyUI workflow JSON
- `workflow-summary.json` — workflow 摘要
- `frontend-context.json` — 用户在前端"上下文"标签页粘贴的文本
- `error-log.json` — 当前运行错误日志

**为什么需要它**：Codex 进程**不**接收整个 workflow（体积太大），
而 SGA 的 working set 注入对 Codex 不可见（Codex 在子进程里）。
走磁盘文件是最直接的 IPC：写一次，Codex 读一次。

**写入策略**：原子写（`fs.writeFile` + `rename`），避免读到残缺内容。

### 3. Codex binary 探测与启动（本次修复）

#### `sga_template/src/agents/codex/detect.ts` (MODIFIED)

**职责**：探测 `codex-app-server(.exe)` 的位置。

**新探测顺序**：
1. `CODEX_BINARY` 环境变量
2. `sga_template/codex-rs/target/release/codex-app-server(.exe)` ← **唯一推荐**
3. `sga_template/codex-rs/target/debug/codex-app-server(.exe)`
4. ~~OpenAI 官方安装~~ → **REJECTED**（带 WARN 日志）
5. ~~`PATH` 里的 `codex`~~ → **REJECTED**

**为什么**：OpenAI 官方 `codex.exe` 是没经过我们改造的版本，
跑出来仍然是 "What do you want changed?"，不是 Comfy Workflow Agent。
必须强制用 vendored build。

#### `sga_template/src/agents/codex/process.ts` (MODIFIED)

**职责**：spawn `codex-app-server` 子进程。

**修复**：去掉了无效的 `app-server` 子命令、`--stdio` 默认 flag、
`--analytics-default-enabled` 废弃 flag。

**新 spawn 命令**：`codex-app-server.exe -c sandbox=workspace-write`

### 4. Codex 后端核心

#### `sga_template/src/agents/codex-backend.ts`

**职责**：`CodexBackend implements AgentBackend`。
负责 start / stop / sendMessage / abort / healthCheck / exportHandoff / importHandoff。

**关键改动**：注入 `developerInstructions` 来自 `buildCodexDeveloperInstructions()`，
而不是 per-message 注入。

#### `sga_template/src/agents/codex/event-bridge.ts`

**职责**：把 codex 的 JSON-RPC 事件映射成 SGA 的 `AgentStreamEvent`。

| codex event | SGA event |
|-------------|-----------|
| `item/agentMessage/delta` | `content_block_delta` (text) |
| `item/commandExecution/outputDelta` | `content_block_delta` (tool_result) |
| `item/started` (mcpToolCall) | `content_block_start` (tool_use) |
| `item/completed` (mcpToolCall) | `content_block_stop` (tool_use) |
| `turn/completed` | `message_stop` |

#### `sga_template/src/agents/codex/process.ts`

**职责**：spawn `codex-app-server` 子进程，pipe stdin/stdout。

#### `sga_template/src/agents/codex/jsonrpc.ts`

**职责**：JSON-RPC over stdio 双向通讯，frame 解析 + 请求/响应/通知分发。

#### `sga_template/src/agents/codex/config.ts`

**职责**：每次启动时生成临时 `~/.codex/config.toml`，设置
`requires_openai_auth = false` + 注入 `OPENAI_API_KEY` 环境变量。

### 5. AgentBackend 抽象

#### `sga_template/src/agents/backend.ts`

`AgentBackend` interface + `HandoffBundle` + `KeyFact` type 定义。

#### `sga_template/src/agents/sga-backend.ts`

`SgaBackend implements AgentBackend`，包裹 `runAgent`。

#### `sga_template/src/agents/registry.ts`

全局 `BackendRegistry`，管理 SGA + Codex 实例 + 健康检查。

#### `sga_template/src/agents/handoff/{store,blackboard,extractor,index}.ts`

- `store.ts` — `<SGA_HOME>/handoff/<sessionId>.json` 原子写
- `blackboard.ts` — `<SGA_HOME>/shared/blackboard.json` 共享热数据
- `extractor.ts` — 从 SGA memory 抽 key facts

### 6. HTTP 路由

#### `sga_template/src/server/routes.ts`

**职责**：所有 `/api/...` 路由。

**关键改动**：
- `handleComfyUIChatStream` — 调用 `writeLiveContext()` 写盘
- `handleStreamResponse` — 按 `session.activeAgent` 派发到 SGA 或 Codex
- `handleSwitchSessionAgent` — `POST /api/v1/sessions/:id/agent` 切换端点

#### `sga_template/src/server/session.ts`

`session.activeAgent: 'sga' | 'codex'` 字段持久化。

#### `sga_template/src/server/app.ts`

启动时初始化 `BackendRegistry` + CodexBackend 单例。

### 7. 前端

#### `ui/src/components/ChatPanel.tsx`

主聊天面板。**改动**：头部新增 SGA/Codex 切换按钮。

#### `ui/src/components/SettingsModal.tsx`

**改动**：新增 "AI 后端" 选项（default backend: SGA / Codex）。

#### `ui/src/components/CodexBuildProgressCard.tsx` (NEW)

**职责**：在 UI 上显示 Codex 编译进度。

- 解析 `cargo build` stderr，提取百分比（"X/Y compiled"）
- 估算剩余时间
- 编译完成后显示 SHA256 指纹

#### `ui/src/services/configService.ts`

**改动**：`activeAgent` 持久化到 settings。

### 8. 构建与发布

#### `scripts/build-codex.mjs`

**职责**：Node 端 `cargo build --release -p codex-app-server` 包装。

**特性**：
- Windows / Linux / macOS 自动检测
- `--app-server` 只编译 app-server
- `--clean` 清 target 目录
- `--target-dir` 自定义 target 目录

#### `.github/workflows/release-codex.yml` (NEW)

**职责**：GitHub Actions 多平台 build + Release。

- 触发：push tag `v*.*.*` 或手动 dispatch
- 矩阵：windows / linux / macos x86 / macos arm
- 产物：zip / tar.gz + SHA256SUMS
- 发布：自动创建 GitHub Release 并 attach 4 个资产

### 9. Vendored Codex 源码

#### `sga_template/codex-rs/`

完整 vendored `openai/codex` Rust 源码，Apache-2.0。

- `core/src/client.rs` — 已改造（注入 Comfy Workflow Agent）
- `core/src/comfyui_agent.rs` — 本次新增的身份注入模块
- `core/src/lib.rs` — 已改造（注册新模块）
- `app-server/` — JSON-RPC 入口
- `protocol/` — 事件 / 请求 / 响应 Rust 类型
- `target/release/codex-app-server(.exe)` — 编译产物（gitignored）

---

## 数据流：用户问 "你是什么" 时发生了什么

```
1. 浏览器：用户点 SGA/Codex 切换按钮 → 调 POST /api/v1/sessions/:id/agent
2. routes.ts::handleSwitchSessionAgent
   ├─ SgaBackend.exportHandoff() → 写 <SGA_HOME>/handoff/<id>.json
   ├─ session.activeAgent = 'codex' (持久化)
   ├─ BackendRegistry.get('codex') → CodexBackend
   └─ CodexBackend.start({ provider, model })
       ├─ provider-proxy.ts 启动反代 (127.0.0.1:51234 → 上游)
       ├─ config.ts 写临时 ~/.codex/config.toml
       └─ process.ts spawn codex-app-server.exe (stdin/stdout JSON-RPC)
3. 用户输入"你是什么" → 浏览器 → POST /api/chat/stream
4. routes.ts::handleComfyUIChatStream
   ├─ live-context.ts::writeLiveContext() 写 <SGA_HOME>/shared/comfyui/*.json
   └─ handleStreamResponse (activeAgent=codex)
       └─ CodexBackend.sendMessage()
           ├─ context.ts::buildCodexDeveloperInstructions() 拼 SGA prompt
           ├─ codexBackend 发送 thread/start { developerInstructions }
           └─ codex-app-server (Rust 进程)
               ├─ comfyui_agent::build_prefix() 注入 Comfy Workflow Agent 身份
               ├─ OpenAI 客户端发请求 → provider-proxy → 上游 LLM
               └─ 响应通过 event-bridge.ts 映射成 SSE 事件流回浏览器
5. 浏览器显示："我是 Comfy Workflow Agent，专门处理 ComfyUI 工作流..."
```

**关键点**：
- Rust 端（`comfyui_agent.rs`）和 TS 端（`context.ts`）**双重注入**，互为兜底
- 完整工作流通过 `<SGA_HOME>/shared/comfyui/workflow.json` 共享，**绝不截断**
- SGA 写入是**原子的**（tmp + rename），Codex 不会读到残缺 JSON
- Codex 进程在 identity 注入后表现得和 SGA 的 Comfy Workflow Agent **一致**
