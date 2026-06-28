# Development Guide — ComfyUI Workflow Agent

> 本文档面向贡献者。涵盖开发工作流、代码组织、扩展指南（加工具 / Provider / 路由 / Agent / UI 面板）、测试策略与代码规范。
>
> 入门请先读 [README.md](README.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 项目结构

```
comfy_workflow_agent/
├── __init__.py                 # ComfyUI 入口（Python）：探测 Node、装依赖、起 SGA、探测 Codex
├── nodes.py                     # 占位（不注册任何 ComfyUI 节点）
├── pyproject.toml               # Python 项目元数据（可选）
├── sga_template/                # SGA 后端（Node.js + TS）
│   ├── src/
│   ├── codex-rs/                # vendored Codex Rust 源码
│   ├── .env.example             # 70+ 环境变量样例
│   ├── package.json
│   └── tsconfig.json            # ESNext + ES2022 + strict
├── ui/                          # React + Vite 前端
│   ├── src/
│   │   ├── App.tsx              # 浮动窗口根组件
│   │   ├── components/          # ChatPanel / SettingsModal / WorkflowVisualizer / SystemDiagnosticsPanel / CodexBuildProgressCard
│   │   ├── services/            # configService / aiService / workflowContextCollector
│   │   ├── utils/i18n.ts        # 4 语言字典
│   │   └── types.ts
│   ├── tailwind.config.js
│   └── vite.config.ts
├── scripts/                     # 构建脚本
│   ├── build-codex.mjs          # 一键编译 vendored codex-app-server
│   ├── build-codex.ps1          # PowerShell 版本
│   ├── build_codex_worker.py   # 后台 cargo build 进度上报
│   ├── install-rust.ps1
│   └── parse-cargo-lock.{ps1,py}
├── web/                         # 前端构建产物（ComfyUI 静态托管）
├── docs/                        # 文档 + 图
├── .node-runtime/               # 自动安装的 Node.js（gitignore）
├── ARCHITECTURE.md
├── DEVLOG.md                    # 时间倒序开发日志
├── CHANGELOG.md                 # 发布版本记录
└── README.md
```

## 2. 开发环境准备

### 必需

- **Node.js 20.18.0+**（开发可装 nvm / nvm-windows 切版本）
- **Python 3.8+**（与 ComfyUI 一致；推荐 3.11+）
- **ComfyUI** 本地运行实例（端口默认 8188）

### 可选（仅当要构建 Codex）

- **Rust stable**（[rustup.rs](https://rustup.rs/)）
- **Windows**：Visual Studio 2022 Build Tools + C++ workload
- **Linux/macOS**：gcc / clang

详见 [docs/rust-install-guide.md](docs/rust-install-guide.md)。

### 首次拉代码后

```bash
# 后端依赖
cd sga_template && npm install

# 前端依赖
cd ../ui && npm install

# 回到根目录
cd ..

# 启动 ComfyUI，插件会自动跑 npm install/build（若未手动跑）
```

## 3. 本地开发工作流

### 3.1 同时开发前后端

开两个终端：

```bash
# 终端 1：SGA 后端热重载
cd sga_template
npm run dev        # tsx watch src/server/main.ts，文件改动自动重启

# 终端 2：UI 热重载
cd ui
npm run dev        # vite dev server，默认 http://localhost:5173
```

UI dev server 会代理 `/api/*` 到 `http://127.0.0.1:8000`（见 [vite.config.ts](ui/vite.config.ts) 的 `server.proxy`）。打开 `http://localhost:5173` 即可调试 UI，但 ComfyUI 工作流上下文需要真实 ComfyUI 环境，**推荐做法**：

1. 启动 ComfyUI（让 `__init__.py` 跑一次构建出 `web/`）
2. 修改 `ui/src/` 后跑 `npm run watch`（增量构建到 `web/`）
3. 浏览器刷新 ComfyUI 页面

### 3.2 只改后端

```bash
cd sga_template
npm run dev
# ComfyUI 会通过 Popen 启动后端，所以也可以重启 ComfyUI 让 __init__.py 起
```

### 3.3 构建 Codex（可选）

```bash
# 项目根目录
node scripts/build-codex.mjs --app-server
# 或
cd sga_template/codex-rs
cargo build --release -p codex-app-server
```

首次 5-20 分钟，增量 30 秒-3 分钟。产物在 `sga_template/codex-rs/target/release/codex-app-server[.exe]`。

## 4. 代码组织与关键模块

### 4.1 后端入口链

```
__init__.py (ComfyUI 加载)
  └─ start_backend_server()
      ├─ _get_node_path() / _install_nodejs()
      ├─ _acquire_install_lock()  ← 跨进程文件锁
      ├─ _ensure_dependencies(sga_template)
      ├─ _build_if_needed(sga_template)
      ├─ _build_ui_if_needed(ui)
      ├─ _ensure_mcp_config()      ← 写 <SGA_HOME>/mcp-servers.json
      ├─ _ensure_codex_binary()    ← 探测 / 后台 cargo build
      └─ _monitor_backend()        ← Popen + stdout 流式 + 5min/3 次自动重启
```

### 4.2 SGA 后端启动链

```
sga_template/src/server/main.ts
  └─ startServer({ port, host, basePath })
      └─ app.ts (Express 装配)
          ├─ routes.ts          ← /api/v1/* + /api/* handler
          ├─ skills-mcp-routes.ts ← /api/v1/skills/* + /api/v1/mcp/*
          ├─ session-store.ts    ← proper-lockfile 文件锁
          ├─ interaction.ts      ← 审批 / 用户输入 SSE 桥
          └─ codex-status.ts     ← Codex 能力探测
```

### 4.3 Agent 后端抽象

[`sga_template/src/agents/backend.ts`](sga_template/src/agents/backend.ts) 定义 `AgentBackend` 接口：

```ts
interface AgentBackend {
  type: 'sga' | 'codex'
  displayName: string
  start(opts: BackendStartOptions): Promise<void>
  stop(): Promise<void>
  sendMessage(opts: BackendMessageOptions): AsyncIterable<AgentStreamEvent>
  abort(threadId?: string): Promise<void>
  healthCheck(): Promise<BackendHealth>
  listAgents(): Promise<AgentInfo[]>
  listSkills(): Promise<Skill[]>
  exportHandoff(sessionId: string): Promise<HandoffBundle | null>
  importHandoff(bundle: HandoffBundle): Promise<void>
  canExportHandoff(): Promise<boolean>
}
```

两个实现：
- **`SgaBackend`** ([sga-backend.ts](sga_template/src/agents/sga-backend.ts)) — in-process，`sendMessage` 委托 [runner.ts](sga_template/src/agents/runner.ts) 的 `runAgent()`
- **`CodexBackend`** ([codex-backend.ts](sga_template/src/agents/codex-backend.ts)) — subprocess，JSON-RPC over stdio

调度入口 [`registry.ts`](sga_template/src/agents/registry.ts) 的 `BackendRegistry` 单例。

### 4.4 SGA Agent 主循环

[`sga_template/src/agents/runner.ts`](sga_template/src/agents/runner.ts) 的 `runAgent(opts)`：

```
classify_request → tool_filter (按 AgentDefinition.allowList)
  → permission_check (按 PermissionMode)
  → hook_pre_tool_use
  → tool execute (并行 / 串行 orchestrator)
  → hook_post_tool_use (失败注入反思)
  → context_build (memory + workingSet + tools)
  → micro_compact (按需)
  → circuit_breaker (按需)
  → cost_track
  → 重复直到 stopReason=end_turn 或 maxTurns
```

### 4.5 Codex 集成层

[`sga_template/src/agents/codex/`](sga_template/src/agents/codex/) 7 个文件各司其职：

| 文件 | 职责 |
|---|---|
| `detect.ts` | 5 级探测（env → release → debug → official-REJECT → PATH-REJECT）；**显式拒绝 OpenAI 官方** |
| `process.ts` | `codex-app-server` subprocess spawn + stdio 接线 |
| `jsonrpc.ts` | JSON-RPC lite 客户端（newline-delimited，无 `jsonrpc:"2.0"` 强制） |
| `event-bridge.ts` | codex 通知 → SGA `AgentStreamEvent`（`item/agentMessage/delta` → `stream_delta` 等） |
| `provider-proxy.ts` | OpenAI Responses API → Chat Completions 反代（含 tool-failure 反思注入、`finish_reason=tool_calls` 处理） |
| `config.ts` | 临时 `config.toml` 写盘（`requires_openai_auth=false`） |
| `context.ts` | `buildCodexDeveloperInstructions()` — 注入 SGA.md + blackboard + live context + recent session + language override |

### 4.6 共享上下文（SGA ↔ Codex）

| 数据流 | 文件 |
|---|---|
| 写 Live ComfyUI 工作流上下文 | [sga_template/src/comfyui/live-context.ts](sga_template/src/comfyui/live-context.ts) — `handleComfyUIChatStream` 调用，原子写到 `<SGA_HOME>/shared/comfyui/` |
| 读 Live ComfyUI 工作流上下文 | [sga_template/codex-rs/core/src/comfyui_agent.rs](sga_template/codex-rs/core/src/comfyui_agent.rs) — `build_live_context_section()` 读上面 4 个文件 |
| 共享黑板 | [sga_template/src/agents/handoff/blackboard.ts](sga_template/src/agents/handoff/blackboard.ts) ↔ Rust `BlackboardData` |
| Handoff bundle 持久化 | [sga_template/src/agents/handoff/store.ts](sga_template/src/agents/handoff/store.ts) — 原子写 + 一次性消费 |
| Handoff 关键事实提取 | [sga_template/src/agents/handoff/extractor.ts](sga_template/src/agents/handoff/extractor.ts) |

**关键不变量**：工作流 JSON 绝不截断（≤64KB 内联，否则给文件路径 + `read_file` 提示），否则会破坏 JSON 可解析性。

### 4.7 ComfyUI Workflow Agent 身份三处镜像

> 这三处必须保持 1:1，改了一处就要同步另外两处。源注释在 [`comfyui_agent.rs`](sga_template/codex-rs/core/src/comfyui_agent.rs) 顶部明确标注。

1. **SGA 运行时**：[sga_template/src/agents/built-in/comfyui-agent.ts](sga_template/src/agents/built-in/comfyui-agent.ts) — SGA 调 LLM 时的 system prompt
2. **Codex developerInstructions**：[sga_template/src/agents/codex/context.ts](sga_template/src/agents/codex/context.ts) — `thread/start` 时注入
3. **Codex Rust 静态前缀**：[sga_template/codex-rs/core/src/comfyui_agent.rs](sga_template/codex-rs/core/src/comfyui_agent.rs) — `OnceCell` 缓存，每个 codex 进程只构建一次

## 5. 扩展指南

### 5.1 加一个内置工具

1. 在 [`sga_template/src/tools/built-in/`](sga_template/src/tools/built-in/) 新建 `my-tool.ts`
2. 实现 `Tool` 接口（`name`、`description`、`inputSchema`（zod）、`execute(args, ctx)`）
3. 在 [`sga_template/src/tools/built-in/index.ts`](sga_template/src/tools/built-in/index.ts) 注册到 `builtInTools`
4. 想让某个 Agent 用，把它加到对应 `AgentDefinition.getAllowedTools()` 的返回里
5. 跑 `npm run typecheck && npm test`

参考实现：[comfyui-api.ts](sga_template/src/tools/built-in/comfyui-api.ts)、[github-search.ts](sga_template/src/tools/built-in/github-search.ts)。

### 5.2 加一个 LLM Provider

1. 在 [`sga_template/src/providers/`](sga_template/src/providers/) 新建 `my-provider.ts`，实现 `Provider` 接口（`name`、`chat(opts)`、`streamChat(opts)`）
2. 在 [`sga_template/src/providers/registry.ts`](sga_template/src/providers/registry.ts) 注册
3. 若是 OpenAI 兼容，更简单：直接复用 [`transformable-provider.ts`](sga_template/src/providers/transformable-provider.ts)，只需提供 baseUrl / apiKey / 默认 model
4. UI 端在 [`ui/src/services/configService.ts`](ui/src/services/configService.ts) 的 `ProviderProtocol` 加上新协议（如需）
5. 跑三步验证流程：`POST /api/v1/providers/verify-address` → `/verify-protocol` → `/fetch-models`

### 5.3 加一条 HTTP 路由

1. 在 [`sga_template/src/server/routes.ts`](sga_template/src/server/routes.ts) 新建 `handleMyThing(req, res)` 并 `export`
2. 在 [`sga_template/src/server/app.ts`](sga_template/src/server/app.ts) 注册：`app.get('${base}/my-thing', handleMyThing)`
3. UI 端在 [`ui/src/services/configService.ts`](ui/src/services/configService.ts) 加调用
4. 跑 `npm run typecheck`

> 不要把 handler 实现写在 `app.ts` 里——所有 handler 都放 `routes.ts` 或 `skills-mcp-routes.ts`，`app.ts` 只做装配。

### 5.4 加一个 Agent 定义

1. 在 [`sga_template/src/agents/built-in/`](sga_template/src/agents/built-in/) 新建 `my-agent.ts`，继承 `BaseAgentDefinition`
2. 实现 `getSystemPrompt`、`getAllowedTools`、`getModel`、`getEffort`、`getPermissionMode`、`getContextConfig`
3. 在 [`built-in/index.ts`](sga_template/src/agents/built-in/index.ts) 导出
4. 想让用户能选这个 Agent，把它的 `subagentType` 加到 fork / coordinator 的候选里

参考实现：[comfyui-agent.ts](sga_template/src/agents/built-in/comfyui-agent.ts)、[ExploreAgent](sga_template/src/agents/built-in/index.ts)（只读，haiku 模型）。

### 5.5 加一个 UI 面板 / Tab

1. 在 [`ui/src/components/`](ui/src/components/) 新建 `MyPanel.tsx`
2. 在 [`ui/src/App.tsx`](ui/src/App.tsx) 引入并放到布局中
3. 需要后端数据，在 [`ui/src/services/configService.ts`](ui/src/services/configService.ts) 加 API 调用
4. 需要翻译，在 [`ui/src/utils/i18n.ts`](ui/src/utils/i18n.ts) 的 4 语言字典都补上对应 key
5. 跑 `cd ui && npm run typecheck && npm run lint && npm run build`

参考实现：[SystemDiagnosticsPanel.tsx](ui/src/components/SystemDiagnosticsPanel.tsx)、[CodexBuildProgressCard.tsx](ui/src/components/CodexBuildProgressCard.tsx)。

### 5.6 加一个 Skill

三种方式（按推荐度排序）：

**API**：`POST /api/v1/skills`，body 为 skill 定义（YAML / JSON）。

**文件系统**：直接放到 `<SGA_HOME>/skills/<name>.md`，下次启动自动 discover。

**Agent 自动生成**：让 Agent 调 `skill` 工具，传 `action=create`。

Skill 文件格式见 [`sga_template/src/skills/`](sga_template/src/skills/)。

### 5.7 加一个 MCP Server

UI 端 **Settings → MCP tab → "+ 添加"**，填：

- `name`：唯一标识
- `transport`：`stdio` / `sse` / `streamable-http`（白名单校验）
- `command` / `args`（stdio）或 `url`（sse / streamable-http）
- `env`：`KEY=val,KEY2=val2` 语法

后端会：
1. `registerMCPServer(config)` 加到内存
2. `connectMCPServer(name)` 立即连接（失败也保留，状态置 `error`）
3. `persistMCPServers()` 写 `<SGA_HOME>/mcp-servers.json`
4. 下次启动 `app.ts` 自动 `loadMCPServersFromConfig()` + `connectAllMCPServers()`

## 6. 测试策略

### 6.1 后端

```bash
cd sga_template
npm test            # vitest run
npm run test:watch  # vitest watch
```

测试覆盖：

- `agents/codex-bridge-test.ts` — Codex event-bridge 单元测试
- `agents/codex-e2e-mock.ts` — Mock Codex 子进程 E2E
- `agents/codex-e2e-real.ts` — 真实 codex-app-server E2E（需要 binary，CI 跳过）
- `agents/codex-proxy-test.ts` — Provider Proxy 翻译测试
- `agents/codex-rpc-smoke.ts` — JSON-RPC 协议烟雾测试
- `agents/handoff/store.test.ts` — HandoffStore 原子性 / 一次性消费测试
- `server/*.test.ts` — 路由 handler 单元测试

**约定**：默认测试**不依赖**真实 codex binary、网络或 API key；`codex-e2e-real` 在 CI 跳过。

### 6.2 前端

```bash
cd ui
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src, max-warnings 0
npm run build       # tsc && vite build
```

UI 当前**没有**单元测试框架，以 typecheck + lint + build 作为基线。

### 6.3 Codex Rust

```bash
cd sga_template/codex-rs
cargo test -p codex-core
cargo test -p codex-app-server
```

详见 `codex-rs/.config/nextest.toml`（nextest 配置）。

## 7. 代码规范

### 7.1 TypeScript

- **ESM**（`"type": "module"`），import 必须带 `.js` 后缀（即便源是 `.ts`）
- **strict** 模式，禁用 `any`（必要时用 `unknown` + 类型守卫）
- **ES2022** target
- 后端日志用 [`utils/logger.ts`](sga_template/src/utils/logger.ts)（控制台彩色 + 可选文件，由 `LOG_DIR` / `LOG_ENABLE_FILE` 控制）
- **绝不**把 API key / token / Authorization header 写进日志或返回给前端

### 7.2 React

- 函数组件 + Hooks，**不**用 class component
- **不**引入 Redux / Zustand / i18next 等外部状态 / i18n 库（保持轻量）
- 翻译走 `t(lang, key)` 自研字典
- Tailwind 原子类，**不**写自定义 CSS（除非必要）
- ESLint `max-warnings 0`，Prettier 格式化

### 7.3 Python

- 仅 [`__init__.py`](__init__.py) 一个文件，保持简单
- 兼容 Python 3.8+
- 日志用 `print()`（被 ComfyUI 控制台捕获），UTF-8 + `errors='replace'`

### 7.4 Rust

- 跟 vendored `codex-rs` 上游风格（`cargo fmt` + `cargo clippy`）
- 改动 [`comfyui_agent.rs`](sga_template/codex-rs/core/src/comfyui_agent.rs) 时**必须**同步 [`comfyui-agent.ts`](sga_template/src/agents/built-in/comfyui-agent.ts) 与 [`codex/context.ts`](sga_template/src/agents/codex/context.ts)

## 8. 调试技巧

### 8.1 看后端日志

ComfyUI 控制台会流式打印 SGA 后端 stdout。手动启动：

```bash
cd sga_template
npm run dev
# 或看编译产物
node dist/server/main.js
```

打开 `LOG_ENABLE_FILE=true` + `LOG_DIR=./logs` 写文件。

### 8.2 调试 Codex 子进程

```bash
CODEX_DEBUG=1 node dist/server/main.js
# 看 codex 子进程 stderr
```

或手动跑 codex 看握手：

```bash
cd sga_template/codex-rs
cargo run --release -p codex-app-server -- -c sandbox_mode=workspace-write
```

### 8.3 模拟 Provider Proxy

```bash
# 起 SGA 后，proxy 监听随机端口，看 /v1/responses 反代日志
curl -X POST http://127.0.0.1:<proxy-port>/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","input":[{"role":"user","content":"hi"}],"stream":true}'
```

### 8.4 看共享状态

```bash
# Blackboard
cat ~/.sga/shared/blackboard.json | jq

# Live ComfyUI context
ls ~/.sga/shared/comfyui/
cat ~/.sga/shared/comfyui/workflow-summary.json | jq

# Handoff bundle（切换前存在，切换后被消费删除）
ls ~/.sga/handoff/
cat ~/.sga/handoff/<sessionId>.audit.json | jq

# Codex build 状态
cat ~/.sga/codex-build.json | jq
```

### 8.5 健康检查

```bash
curl http://127.0.0.1:8000/api/health                 # 最小
curl http://127.0.0.1:8000/api/v1/health              # 完整
curl http://127.0.0.1:8000/api/v1/diagnostics         # 脱敏诊断
curl http://127.0.0.1:8000/api/v1/codex/status        # Codex 能力
curl http://127.0.0.1:8000/api/v1/codex/build-status  # 后台编译进度
curl http://127.0.0.1:8000/api/v1/backends            # 后端列表
curl http://127.0.0.1:8000/api/v1/backends/health     # 后端健康
```

## 9. 发布流程

详见 [docs/release-codex.md](docs/release-codex.md) 与 [.github/workflows/release-codex.yml](.github/workflows/release-codex.yml)。

简要：

1. 改 [CHANGELOG.md](CHANGELOG.md)，按 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 格式追加版本节
2. 在 [DEVLOG.md](DEVLOG.md) 顶部追加开发日志
3. 跑验证基线（后端 + 前端）
4. 打 tag `git tag v0.x.y && git push origin v0.x.y`
5. GitHub Actions 自动跑跨平台 Codex binary 构建 + 发布 Release

## 10. 常见坑

### 10.1 ESM import 后缀

**错**：`import { foo } from './foo'`
**对**：`import { foo } from './foo.js'`（即便源是 `foo.ts`）

### 10.2 模块提升顺序

`routes.ts` 顶部 import 会在模块加载时执行，可能引发循环依赖。惰性单例模式：

```ts
let _store: ComfyUIConfigStore | null = null
function getComfyUIConfigStore() {
  if (!_store) _store = new ComfyUIConfigStore()
  return _store
}
```

### 10.3 Codex 二进制探测失败

- OpenAI 官方 `codex` 被显式 **REJECT**——必须用 vendored 构建或 `CODEX_BINARY`
- `CODEX_SKIP_BUILD=1` 不会启动后台编译
- 后台编译超时（默认 1800s）会标记 `failed`，但 SGA 仍可用

### 10.4 MCP transport 校验

后端只接受 `'stdio' | 'sse' | 'streamable-http'`，前端传其他字符串返回 400。

### 10.5 工作流 JSON 绝不截断

`live-context.ts` 写盘和 `comfyui_agent.rs` 读盘都遵循 **inline-or-reference** 策略：≤64KB 内联，否则给文件路径 + `read_file` 提示。**截断的 JSON 会让模型生成无法解析的工作流**。

### 10.6 跨进程锁

`__init__.py` 用 `_InstallLock`（O_EXCL + stale 检测）防止多个 ComfyUI 进程并发装依赖。若卡住：

```bash
rm ~/.sga/install.lock
```

### 10.7 Codex 身份注入漂移

改 `comfyui-agent.ts` 时**必须**同步：

- [`sga_template/src/agents/codex/context.ts`](sga_template/src/agents/codex/context.ts) 的 `COMFYUI_AGENT_IDENTITY` 常量
- [`sga_template/codex-rs/core/src/comfyui_agent.rs`](sga_template/codex-rs/core/src/comfyui_agent.rs) 的 `COMFY_WORKFLOW_AGENT_IDENTITY` 常量

源文件顶部注释明确标注三处必须 1:1。

## 11. 相关文档

- [README.md](README.md) — 项目总览
- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构与运行时边界
- [DEVLOG.md](DEVLOG.md) — 时间倒序开发日志
- [CHANGELOG.md](CHANGELOG.md) — 发布版本记录
- [docs/codex-agent-integration.md](docs/codex-agent-integration.md) — Codex 集成完成矩阵
- [docs/tech-stack.md](docs/tech-stack.md) — 技术栈总览
- [docs/rust-install-guide.md](docs/rust-install-guide.md) — Rust / Codex 构建指南
- [docs/release-codex.md](docs/release-codex.md) — Codex binary 发布流程
- [docs/workflow-domain-capability-plan.md](docs/workflow-domain-capability-plan.md) — 工作流领域能力未来计划
- [sga_template/README.md](sga_template/README.md) — SGA 后端目录说明
- [sga_template/.env.example](sga_template/.env.example) — 70+ 环境变量样例
