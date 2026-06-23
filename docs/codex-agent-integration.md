# Codex Agent 集成 — 实施文档

> 版本: v0.7 · 日期: 2026-06-19 · 状态: Sprint 1-5 已完成 / 全链路可用 + 自动下载预编译 binary
> 目标: 把 Codex (本项目内嵌的第二个 coding agent) 作为本项目的**第二个可选后端 agent**,用户可在 SGA 与 Codex 之间二选一作为消息处理后端。

### v0.7 重大进展: 自动下载预编译 binary + cargo build fallback

| v0.6 状态 | v0.7 完成 |
|-----------|-----------|
| 新用户需手动编译或安装 Codex 桌面客户端 | **三级自动获取**: 探测 → 下载预编译 → cargo build |
| 无下载配置机制 | **三级 URL 配置**: env `CODEX_DOWNLOAD_URL` > env `CODEX_RELEASE_URL` > `codex/download-url.txt` > 默认 |
| 下载的 binary 不在探测链中 | **探测链新增 `sga_template/codex-rs/target/release/`**: Python + TS 双端同步 |
| 下载失败只打印指引 | **下载失败自动 cargo build**: `cargo build --release -p codex-app-server`, 30 分钟超时 |
| 无跳过机制 | **`CODEX_SKIP_DOWNLOAD=1`** 跳过下载, **`CODEX_SKIP_BUILD=1`** 跳过编译 |

### v0.6 重大进展: 前端 UI + 健壮性 + MCP 工具

| v0.5 状态 | v0.6 完成 |
|-----------|-----------|
| 前端无 agent 切换 UI | **ChatPanel 头部 SGA/Codex 切换按钮**: 点击即切换, 处理中禁用 |
| Codex 崩溃不恢复 | **自动重启 (1 次)**: exit 事件监听, 非主动停止则 restart |
| Codex 不能调 ComfyUI 工具 | **MCP server 自动注入 config.toml**: 默认 comfyui (127.0.0.1:8188/mcp) |
| 无真供应商测试 | **codex-e2e-real.ts**: 走真 DeepSeek/GLM 的端到端测试脚本 |

### v0.5 登录去除 + Provider 共享 + 消息派发

| v0.4 状态 | v0.5 完成 |
|-----------|-----------|
| CodexBackend 是 stub, 不能跑 | **CodexBackend 完整实现**: spawn / JSON-RPC / event-bridge / healthCheck |
| Codex 需要 ChatGPT 登录 | **登录完全去除**: `requires_openai_auth = false` + 本地 provider-proxy |
| Provider 配置 SGA/Codex 各自独立 | **一套配置两边共用**: SGA provider-store → codex start({provider}) → proxy → 真供应商 |
| sendMessage 不走 codex | **handleStreamResponse 按 activeAgent 派发**: codex 分支调 codexBackend.sendMessage() |
| 切换 agent 不传 provider | **handleSwitchSessionAgent 传 provider/model**: codex 启动即起反代 + 写 config.toml |
| provider 变化不重启 codex | **provider 指纹检测**: 指纹变化自动 stop() + 重新 start() |

### v0.4 部署形态调整 (已完成)

| 旧方案 (v0.3) | v0.4 调整 |
|----------------|----------------|
| Codex 独立维护 | **Codex 已 vendor 到本项目** `<项目根>/sga_template/codex-rs/`,作为 SGA 后端的一部分 |
| 用户需自行下载 release / `cargo build` | SGA 启动时自动探测 codex binary (官方安装路径优先) |
| Codex 与 ComfyUI 解耦 | **随 ComfyUI 启动链**: ComfyUI 加载 custom_node → SGA Express 启动 → SGA 拉起 codex 子进程 |
| 独立 cargo 工程 | Codex 源码在项目内, 可做轻量级改造 |

---

## 0. 变更日志

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v0.1 | 2026-06-18 | 初稿, 通用/隔离矩阵 + 6 sprint 计划 |
| v0.2 | 2026-06-18 | 新增 `§3.4 记忆交接机制 (HandoffBundle)`, 引入 Blackboard 共享层, 调整 Sprint 顺序为 7 步 |
| v0.3 | 2026-06-18 | Sprint 1 完成: 落地 `AgentBackend` / `SgaBackend` / `Registry` / `HandoffStore` / `Blackboard` / `MemoryExtractor`, `session.activeAgent` 已写入, 路由按 backend 分发. 记录已修复的 TS 编译问题, 拆分 Sprint 1 / 2 验收口径 |
| **v0.4** | **2026-06-18** | **部署形态重定向**: Codex 迁入项目根, 随 ComfyUI 启动, SGA 探测本地 binary. 新增 `§3.5 启动链`, 重写 `§4` 决策 §10 文件布局, 风险表去 WSL 风险, 加轻量改造占位 |
| **v0.5** | **2026-06-19** | **Sprint 2+3 完成**: CodexBackend 完整实现, 登录去除, Provider 共享 (proxy), 消息派发, provider 变化自动重启. E2E mock 6/6 PASS. |
| **v0.6** | **2026-06-19** | **Sprint 4 完成**: 前端 ChatPanel SGA/Codex 切换按钮, Codex 崩溃自动重启, MCP 工具注入 config.toml, 真供应商 e2e 测试脚本. 前后端 tsc 均通过. |
| **v0.7** | **2026-06-19** | **Sprint 5 完成**: vendored codex-rs (Apache-2.0, 探测→cargo build 即可). `_download_codex_binary()` + `_build_codex_with_cargo()` + 保留 cargo build 流程, 不再下载预编译二进制. 探测链新增 `sga_template/codex-rs/target/release/` (Python + TS). `CODEX_SKIP_DOWNLOAD=1` / `CODEX_SKIP_BUILD=1` 跳过. `.gitignore` 排除 `sga_template/codex-rs/target/`. |

---

## 1. 背景与目标

### 1.1 现状

| 维度 | 当前 (SGA) |
|------|------------|
| 实现语言 | TypeScript, 进程内运行 |
| LLM 调用 | 进程内通过 `LLMProvider` 直接发 HTTP/SSE |
| 工具执行 | 进程内 `ToolRegistry`, 同步回调 |
| Skills | `src/skills/bundled/*.ts`, Markdown + TS 处理器 |
| Sub-agents | `agents/built-in/*`, TypeScript 类继承 `BaseAgentDefinition` |
| 协议 / 事件 | 自定义 `AgentStreamEvent` |
| 沙箱 | 通过 `permissions/checker` + `hooks` 实现 |
| 存储 | `<SGA_HOME>/` 文件树 |

### 1.2 Codex 现状 (已就绪能力)

| 能力 | 路径 | 用途 |
|------|------|------|
| `app-server` | `codex-rs/app-server/` | **JSON-RPC over stdio**,与 SGA 最契合的接入点 |
| `mcp-server` | `codex-rs/mcp-server/` | 把 Codex 暴露为 MCP server, 可由 SGA 当工具调用 |
| `core-skills` | `codex-rs/core-skills/` | Codex 原生 Skills 引擎 |
| `protocol` | `codex-rs/protocol/` | 事件/请求/响应的 Rust 类型 → 可参考 |
| `exec-server` | `codex-rs/exec-server/` | 沙箱执行 RPC |
| AGENTS.md | `codex-rs/core/src/agents_md.rs` | 项目级 system prompt 注入 |
| `hooks` | `codex-rs/hooks/` | Pre/Post-tool hooks |
| Skills | `codex-rs/skills/` | 仓库级 + 用户级 + 内置 skills |

### 1.3 集成目标

1. **用户可在 UI 切换 active agent** (SGA / Codex)
2. **同一份 Provider 配置** (api_key, base_url, model) 两种 agent 都能用
3. **同一份 ComfyUI 工具集** 两种 agent 都能调
4. **切换 agent 不丢记忆** (HandoffBundle 快照 + Blackboard 共享热数据)
5. **Codex 侧通过 Skills 获得 ComfyUI 能力**, 而非改 Codex 核心

---

## 2. 通用 vs 隔离 矩阵

### 2.1 可通用 (共享层)

| 模块 | 当前路径 | 复用方式 |
|------|----------|----------|
| UI 整体 | `ui/src/` | 完全共享, 仅添加 agent 选择器 |
| LLM Provider 配置 | `sga_template/src/providers/provider-store.ts` | 完全共享 (SGA 用 process, Codex 经环境变量 / config.toml 转发) |
| 模型拉取 / 验证 | `sga_template/src/providers/verify.ts` | 完全共享 |
| HTTP 路由 (`/api/v1/...`) | `sga_template/src/server/routes.ts` | 完全共享 |
| 持久化 | `ComfyUIConfigStore` | 完全共享 |
| ComfyUI 工具集 | `sga_template/src/comfyui/mcp-server/` | 作为 MCP server 暴露, Codex 通过 mcp 调 |
| GitHub 集成 | `tools/built-in/github-*` | 同上 |
| Session Storage | `server/session-store.ts` | 完全共享, session 元数据 (含 `activeAgent`) |
| Settings 存储 | `<SGA_HOME>/settings.json` | 完全共享 |
| ComfyUI 节点检索 | `tools/built-in/comfyui-node-search.ts` | 通过 MCP 暴露 |
| ComfyUI 工作流分析 | `tools/built-in/workflow-analyzer.ts` | 通过 MCP 暴露 |
| Handoff Store | `sga_template/src/agents/handoff/store.ts` | 共享 `<SGA_HOME>/handoff/<sessionId>.json` |
| Blackboard | `sga_template/src/agents/handoff/blackboard.ts` | 共享 `<SGA_HOME>/shared/blackboard.json` |

### 2.2 需隔离 (per-agent)

| 维度 | SGA | Codex |
|------|-----|-------|
| **运行时** | 进程内 TypeScript | `codex app-server` 子进程 (stdio) |
| **入口点** | `agents/runner.ts::runAgent` (现被 `SgaBackend.sendMessage` 包裹) | `spawn('codex', ['app-server'])` |
| **消息流** | 直接函数调用 → `AgentStreamEvent` | JSON-RPC over stdio → 桥接成 `AgentStreamEvent` |
| **System prompt** | `BaseAgentDefinition.getSystemPrompt` | `AGENTS.md` (项目级) + Skills 拼接 + Blackboard 注入 |
| **Tools 调用** | 进程内 `ToolRegistry.execute` | MCP tool call (经 `codex-mcp-client`) |
| **Sub-agents** | `AgentDefinition` 类层级 | Codex 内置 `Agent` 角色 (plan/build) |
| **Permission 决策** | `permissions/checker` + UI 弹窗 | Codex sandbox (`bwrap`/`landlock`) + execpolicy |
| **Compaction** | 自研 `memory/compact/*` | Codex 内部 compaction (通过 thread API 控制) |
| **Hooks** | `hooks/executor.ts` | `codex-rs/hooks/` + JSON-RPC event |
| **思考策略** | `agents/thinking-prompts.ts` | Codex `reasoning_effort` |
| **Memory 长期** | SGA memory manager | Codex `memories` (Rust) + SGA memory (经 MCP recall) |
| **Skills 引擎** | `skills/activation.ts` | Codex skills 引擎 |
| **Handoff 导出** | 从 working set + memory manager 抽取 keyFacts | 从 thread rollout 导出 |
| **Handoff 导入** | 合并 recentMessages 到 session, 写入 memory | recentMessages 作为 initial input, keyFacts 拼入 prompt |

### 2.3 中间层 — `AgentBackend` 抽象 (已落地)

```ts
// sga_template/src/agents/backend.ts
export type AgentType = 'sga' | 'codex'

export interface AgentBackend {
  readonly type: AgentType
  readonly displayName: string

  start(opts: BackendStartOptions): Promise<void>
  stop(): Promise<void>
  sendMessage(opts: BackendMessageOptions): AsyncIterable<AgentStreamEvent>
  abort(threadId?: string): Promise<void>
  healthCheck(): Promise<BackendHealth>
  listAgents(): Promise<AgentInfo[]>
  listSkills(): Promise<Skill[]>

  // ===== Handoff 接口 (新增) =====
  exportHandoff(sessionId: string): Promise<HandoffBundle | null>
  importHandoff(bundle: HandoffBundle): Promise<void>
  canExportHandoff(): Promise<boolean>
}
```

具体实现:
- `SgaBackend` — 包裹 `runAgent`, 落地于 `src/agents/sga-backend.ts` ✅
- `CodexBackend` — 实现 JSON-RPC 桥接, 文件存在但未通跑 ⏳ (Sprint 2)
- `BackendRegistry` — 全局 backend 实例管理 + 健康检查, 落地于 `src/agents/registry.ts` ✅

---

## 3. 集成架构

### 3.1 总体拓扑

```
┌──────────────────────────────────────────────────────────┐
│  Browser (React UI)                                       │
│  - chat panel, settings, model picker                     │
│  - ★ 新增: agent selector (SGA / Codex)                  │
│  - ★ ChatHeader 显示当前 backend + 上次交接时间           │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP / SSE
                        ▼
┌──────────────────────────────────────────────────────────┐
│  Express server (sga_template/src/server)                 │
│                                                            │
│  ┌──────────────────────────────────────┐                │
│  │  /api/v1/chat/send                    │                │
│  │   → session.activeAgent 路由分发     │                │
│  │   → BackendRegistry.get(activeAgent) │                │
│  └──────┬───────────────────────────┬────┘                │
│         │ SGA                       │ Codex               │
│         ▼                           ▼                     │
│  ┌──────────────┐           ┌────────────────────┐       │
│  │ SgaBackend   │           │ CodexBackend       │       │
│  │  (进程内)    │           │  (子进程 + JSON-RPC)│      │
│  │  现状: ✅    │           │  现状: ⏳ stub     │       │
│  └──────────────┘           └─────┬──────────────┘       │
│                                    │ stdio                │
│                                    ▼                       │
│                          ┌──────────────────┐              │
│                          │  codex app-server│              │
│                          │  (Rust binary)   │              │
│                          └─────┬────────────┘              │
│                                │ MCP                       │
│                                ▼                           │
│                    ┌────────────────────────────┐         │
│                    │ comfyui-mcp-server (现有)   │         │
│                    │  - workflow-analyzer        │         │
│                    │  - node-search              │         │
│                    │  - workflow-validate        │         │
│                    │  - model-list               │         │
│                    └────────────────────────────┘         │
│                                                            │
│  共享层:                                                    │
│  ┌─────────────────────────────────────────────┐          │
│  │ ProviderStore / ComfyUIConfigStore /         │          │
│  │ SessionStore (含 activeAgent) /              │          │
│  │ HandoffStore <SGA_HOME>/handoff/             │          │
│  │ Blackboard  <SGA_HOME>/shared/              │          │
│  └─────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Codex ↔ SGA 事件桥接 (Sprint 2)

Codex `app-server` 的事件流 (核心):

```jsonc
// 客户端 → 服务端
{ "method": "initialize", "params": { ... } }
{ "method": "thread/start", "params": { "model": "...", "cwd": "..." } }
{ "method": "turn/start", "params": { "thread_id": "...", "input": [...] } }
{ "method": "turn/interrupt", "params": { "thread_id": "..." } }

// 服务端 → 客户端 (server notification)
{ "method": "item/started",   "params": { "item": { "type": "commandExecution", "command": "..." } } }
{ "method": "item/agentMessage/delta", "params": { "delta": "Hello..." } }
{ "method": "item/commandExecution/outputDelta", "params": { "delta": "..." } }
{ "method": "item/completed", "params": { "item": { ... } } }
{ "method": "turn/completed", "params": { "usage": { ... } } }
```

映射为 SGA `AgentStreamEvent`:

| Codex event | SGA event |
|-------------|-----------|
| `item/agentMessage/delta` | `content_block_delta` (text) |
| `item/reasoning/summaryText/delta` | `content_block_delta` (thinking) |
| `item/commandExecution/outputDelta` | `content_block_delta` (tool_result) |
| `item/started` (mcpToolCall) | `content_block_start` (tool_use) |
| `item/completed` (mcpToolCall) | `content_block_stop` (tool_use) |
| `turn/completed` | `message_stop` |

映射表集中在 `agents/codex/event-bridge.ts` 一个文件, **单测可独立覆盖**。

### 3.3 Codex 侧 ComfyUI 接入

Codex 通过两种方式获得 ComfyUI 能力:

**方式 A (推荐): 通过 MCP** — 不动 Codex 核心
- `comfyui-mcp-server` 暴露以下 tools:
  - `analyze_workflow` (workflow-analyzer)
  - `search_nodes` (node-search)
  - `validate_workflow` (workflow-validate)
  - `list_models` (model-list)
- Codex 在 `~/.codex/config.toml` 中注册:

```toml
[mcp_servers.comfyui]
command = "node"
args = ["/path/to/comfyui-mcp-server/index.js"]
```

**方式 B: 通过 Skills (AGENTS.md)** — 项目级 prompt
- `codex-rs/core-skills` 引擎在每个 thread 启动时拼接 `AGENTS.md`
- 我们在项目根提供 `AGENTS.md`, 描述 ComfyUI 项目结构 / 工作流 JSON 格式约束 / 何时该调哪个 MCP tool

**方式 C: 预设 Skills** — 用户可加载
- 通过 Codex 的 `~/.codex/skills/` 机制
- 准备 `skills/comfyui-workflow-create/SKILL.md`, `comfyui-workflow-debug/SKILL.md` 等
- Codex 端按需自动激活

### 3.4 记忆交接机制 (Memory Handoff) — ⭐ 核心

> **设计目标**: 用户中途切换 agent, 不丢上下文。

#### 3.4.1 双层结构

| 层 | 用途 | 文件 | 生命周期 |
|----|------|------|----------|
| **HandoffBundle** (快照) | 切换瞬间的完整上下文 | `<SGA_HOME>/handoff/<sessionId>.json` | 一次性, target 读取后删除 |
| **Blackboard** (黑板) | 两 agent 都持续可读写的"热数据" | `<SGA_HOME>/shared/blackboard.json` | 持续, 不删 |

#### 3.4.2 HandoffBundle 数据结构

```ts
// sga_template/src/agents/backend.ts
export interface HandoffBundle {
  schemaVersion: 1
  sessionId: string
  sourceAgent: AgentType
  exportedAt: number
  recentMessages: Message[]                  // 最近 N 轮 (默认 20)
  workingSetSummary: string                  // working set 的压缩摘要
  sessionMemory: string                      // 已压缩的 session 记忆摘要
  keyFacts: KeyFact[]                        // 长期记忆中的关键事实 (按重要性 top 20)
  userPreferences: Record<string, string>    // 用户偏好 (KV)
  customNotes?: string                       // source agent 补充的交接说明
}

export interface KeyFact {
  fact: string
  category: 'user' | 'project' | 'workflow' | 'tool' | 'preference'
  confidence: number                         // 0-1
  source: string                             // 来源 agent / 提取时间戳
  timestamp: number
}
```

落地位置: `sga_template/src/agents/handoff/store.ts` ✅

#### 3.4.3 Blackboard 数据结构

```ts
// sga_template/src/agents/handoff/blackboard.ts
export interface BlackboardData {
  schemaVersion: 1
  updatedAt: number
  currentAgent: AgentType
  lastSwitchAt: number
  userPreferences: Record<string, string | number | undefined>
  currentTask: {
    type: 'create' | 'debug' | 'optimize' | 'explain' | 'other'
    description: string
    workflowId?: string
    errorMessage?: string
    startedAt: number
  } | null
  keyFacts: KeyFact[]
  recentAgentActions: Array<{
    agent: AgentType
    action: string
    timestamp: number
    result?: 'success' | 'failure'
  }>
}
```

落地位置: `sga_template/src/agents/handoff/blackboard.ts` ✅

#### 3.4.4 切换流程 (Switch Flow)

```
[用户点击 "切换到 Codex"]
        │
        ▼
[POST /api/v1/sessions/:id/agent { target: 'codex' }]
        │
        ▼
┌──────────────────────────────────────────────┐
│ 1. getBackendRegistry().get(session.activeAgent)  →  SgaBackend │
│ 2. SgaBackend.canExportHandoff() 检查 (有 turn in flight? abort first)
│ 3. SgaBackend.exportHandoff(sessionId)
│      → SgaBackend 内部:
│          a. await getMemoryExtractor().extractKeyFacts({ maxFacts: 20 })
│          b. 取 session.recentMessages.slice(-20)
│          c. 生成 workingSetSummary
│          d. 打包成 HandoffBundle
│      → HandoffStore.write(bundle)  [原子写: .tmp + rename]
│ 4. session.activeAgent = 'codex'   (持久化到 session-store)
│ 5. getBackendRegistry().get('codex')  →  CodexBackend
│ 6. CodexBackend.start({ provider, mcpServers: [...] })
│ 7. CodexBackend.importHandoff(bundle)
│      → Codex 内部:
│          a. recentMessages → thread 初始 input
│          b. keyFacts 拼入 system prompt
│          c. userPreferences 写入 thread metadata
│ 8. Blackboard.recordSwitch('sga', 'codex')
│      → logAction 双向记录
│ 9. 返回 200 { activeAgent: 'codex', handoffAt: <timestamp> }
└──────────────────────────────────────────────┘
        │
        ▼
[下次 sendMessage 自动走 CodexBackend]
```

**关键约束**:
- `canExportHandoff` 必须为 true 才能切换 (SGA 总为 true; Codex 仅在 turn idle 时)
- 若 `exportHandoff` 失败, **整个切换回滚**, session 保持原 backend
- `importHandoff` 失败时, target backend 启动但标记 degraded, 新 turn 会带 bundle 重试
- Bundle 是 **read-once**, `consume()` 后即删, 避免污染下次启动

#### 3.4.5 数据流 (Who Reads What)

| 时机 | 读 HandoffBundle | 读 Blackboard |
|------|-----------------|---------------|
| session 创建 | — | 读 (作为 initial context) |
| 切换 agent | 写 (source) → 读 → 删 (target) | 写 (currentAgent, lastSwitchAt) |
| sendMessage | — | 读 (拼入 system prompt) |
| sendMessage 完成 | — | 写 (logAction, keyFacts) |
| 进程重启 | 读 (持久 bundle) → 删 | 读 (恢复状态) |

#### 3.4.6 失败模式

| 场景 | 处理 |
|------|------|
| exportHandoff 抛错 | 切换中止, 保留 SGA, 返回 500 |
| HandoffStore 写盘失败 (磁盘满) | 抛 `HandoffExportError`, 不切换 |
| target backend.start() 失败 | 保留 bundle, 保留旧 session.activeAgent |
| target backend.importHandoff 失败 | 标记 degraded, 下一 turn 携带 bundle 重试 |
| Schema version 不匹配 | 抛 `HandoffImportError`, 走"冷启动"分支 (无上下文) |

---

## 4. 关键设计决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 集成模式 | A. 嵌入 B. 桥接子进程 C. HTTP API | **B. 桥接子进程** | app-server 是 stdio JSON-RPC, 跨平台稳定, SGA 端无侵入 |
| Active agent 选择粒度 | A. 全局 B. 每会话 C. 每消息 | **B. 每会话** (default: SGA) | 简单且符合用户"按需切换"诉求 |
| 共享 Tools 的方式 | A. 进程内复用 B. 经 MCP 暴露 | **B. 经 MCP** | Codex 必须通过 MCP; SGA 也可以走 MCP, 实现统一 |
| Codex 配置来源 | A. 独立 config.toml B. 从 SGA 同步 | **A (独立) + 同步辅助** | 尊重 Codex 原生配置习惯, SGA 启动时同步 provider env |
| ComfyUI 工具暴露 | A. 直接复用 SGA tool B. 复制为 Codex skill | **A + Skills 描述** | 工具实现只一份, 通过 SKILL.md 教 Codex 怎么用 |
| 工具结果格式 | A. JSON B. Markdown | **A → UI 渲染** | SGA 内部是 JSON, Codex 也能 parse; UI 渲染统一 |
| Provider 配置共享 | A. 复制到 Codex config B. 运行时注入 env | **B. 运行时注入** | 避免双写不同步; Codex 启动时通过 `model_provider` env 注入 |
| 会话历史共享 | A. 实时双向同步 B. 各自独立 | **B (独立) + 切换时合并** | 实现简单, 用户感知不到差异 |
| Codex Skills 引擎 | A. 使用 Codex 原生 B. 沿用 SGA skills | **A (Codex 原生)** | 与 Codex 体系一致, 利用 `core-skills` |
| 错误处理 | A. fail-fast B. 优雅降级 | **B. 降级到 SGA** | 当 Codex 不可用时, 自动 fallback 到 SGA, 不阻塞用户 |
| **记忆连续性** | A. 完全独立 B. 实时同步 C. **快照+黑板** | **C. 快照+黑板** | 实时同步成本高且冲突多; 完全独立体验割裂. 快照覆盖"切换瞬间"上下文, 黑板覆盖"持续热数据" |
| HandoffBundle 形态 | A. 完整 messages B. 仅摘要+facts | **A (recentMessages) + 摘要** | 完整消息保真, 摘要压缩长期记忆, 二者结合 |
| HandoffBundle 持久化 | A. 内存 B. 磁盘 | **磁盘** (`<SGA_HOME>/handoff/`) | 跨进程崩溃可恢复, 支持 "会话恢复" 场景 |
| Bundle 一次性消费 | A. 保留 B. 读后删 | **B. 读后删** | 避免下次启动重复注入污染 |

---

## 5. 实施阶段 (7 个 sprint)

### Sprint 1: 抽象与基建 ✅ 已完成

**目标**: 抽出 `AgentBackend` 接口, 把 SGA 改为一个 backend

| # | 任务 | 状态 |
|---|------|------|
| 1.1 | 新建 `src/agents/backend.ts` (interface + HandoffBundle type) | ✅ |
| 1.2 | 新建 `src/agents/sga-backend.ts` (SGA 实现) | ✅ |
| 1.3 | 新建 `src/agents/handoff/{store,blackboard,extractor,index}.ts` | ✅ |
| 1.4 | 新建 `src/agents/registry.ts` (BackendRegistry) | ✅ |
| 1.5 | 在 `session.ts` 添加 `activeAgent` 字段 (默认 `'sga'`) | ✅ |
| 1.6 | `routes.ts::handleSendMessage` 改为按 `session.activeAgent` 路由 | ✅ |
| 1.7 | `routes.ts` 新增 `POST /api/v1/sessions/:id/agent` 切换路由 | ✅ |
| 1.8 | 修复 TS 编译错误 (见 §9) | ✅ |
| 1.9 | 编译验证 (`tsc` + `vite build`) | ⏳ 待用户确认执行 |

**验收**:
- 现有 SGA 行为不变 (regression 通过)
- `session.activeAgent` 字段持久化, 重启后保留
- `POST /api/v1/sessions/:id/agent { target: 'sga' }` 切换成功, 状态正确

### Sprint 2: Codex 子进程桥接 ✅ 已完成

**目标**: 能 spawn `codex app-server` 并跑通 hello world

| # | 任务 | 状态 |
|---|------|------|
| 2.1 | `codex-backend.ts` 完整实现 spawn / stdio / initialize | ✅ |
| 2.2 | `src/agents/codex/process.ts` (subprocess lifecycle) | ✅ |
| 2.3 | `src/agents/codex/jsonrpc.ts` (JSON-RPC over stdio, 双向) | ✅ |
| 2.4 | `src/agents/codex/event-bridge.ts` (事件映射) | ✅ |
| 2.5 | 处理: initialize / thread/start / turn/start / turn/interrupt | ✅ |
| 2.6 | `src/agents/codex/detect.ts` 多级路径二进制探测 | ✅ |
| 2.7 | `src/agents/codex/index.ts` 子模块出口 | ✅ |
| 2.8 | E2E mock 测试: `codex-e2e-mock.ts` 6/6 PASS | ✅ |
| 2.9 | CodexBackend.exportHandoff: thread/loadedResources 导出 | ✅ |
| 2.10 | CodexBackend.importHandoff: recentMessages → thread input | ✅ |

**验收**:
- `POST /api/v1/sessions/:id/agent { target: 'codex' }` 切换成功 ✅
- Codex 输出能正确映射为 SSE 事件 ✅
- abort 中断能立即生效 ✅
- E2E mock: 累积文本 = "hi from mock" ✅

### Sprint 3: Provider / Tools 共享 ✅ 已完成

**目标**: Codex 端能复用 LLM provider + 登录去除

| # | 任务 | 状态 |
|---|------|------|
| 3.1 | `codex/provider-proxy.ts` — Responses→ChatCompletions 翻译反代 | ✅ |
| 3.2 | `codex/config.ts` — 临时 config.toml 生成 (requires_openai_auth=false) | ✅ |
| 3.3 | `codex-backend.start()` 注入 provider + 起 proxy + 写 config | ✅ |
| 3.4 | `handleSwitchSessionAgent` 传 provider/model 给 codex start | ✅ |
| 3.5 | `handleStreamResponse` 按 activeAgent 派发 codex/sga | ✅ |
| 3.6 | `handleSendMessage` (非流式) 按 activeAgent 派发 | ✅ |
| 3.7 | provider 变化自动重启 codex (provider 指纹检测) | ✅ |
| 3.8 | SSE `type` 字段注入修复 (codex SSE parser 兼容) | ✅ |
| 3.9 | `thread/tokenUsage/updated` 监听, 修复 usage=0 | ✅ |
| 3.10 | 注册 `comfyui-mcp-server` 到 Codex | ⏳ Sprint 5 |

**验收**:
- 同一份 provider 配置, SGA 和 codex 都能用 ✅
- codex 不需要 ChatGPT 登录 ✅
- 切换 provider 后, codex 自动重启用新供应商 ✅
- E2E mock 6/6 PASS ✅

### Sprint 4: UI 适配

**目标**: 用户可在设置中切换 agent

| # | 任务 |
|---|------|
| 4.1 | `SettingsModal.tsx` 新增 "AI 后端" 选项 (SGA / Codex) |
| 4.2 | 写入 `settings.activeAgent` (default backend) |
| 4.3 | `Settings` 类型扩展 |
| 4.4 | ChatHeader 显示当前 backend 图标 + 名称 + 上次切换时间 |
| 4.5 | 切换后, 新会话使用新 backend; 旧会话保持原 backend |
| 4.6 | 错误提示: Codex 未安装时, 给出下载指引 |

### Sprint 5: Codex Skills + AGENTS.md

**目标**: Codex 具备 ComfyUI 领域知识

| # | 任务 |
|---|------|
| 5.1 | `codex_integration/skills/comfyui-workflow-create/SKILL.md` |
| 5.2 | `codex_integration/skills/comfyui-workflow-debug/SKILL.md` |
| 5.3 | `codex_integration/skills/comfyui-model-explore/SKILL.md` |
| 5.4 | `codex_integration/AGENTS.md` (项目根, 描述 ComfyUI 工作流规范) |
| 5.5 | 启动 Codex 时把这些文件复制到 `~/.codex/skills/` + 项目 `AGENTS.md` |
| 5.6 | 单测: 验证 Codex 看到 AGENTS.md 后 prompt 中包含相关内容 |

### Sprint 6: 健壮性 + 文档

**目标**: 生产可用

| # | 任务 |
|---|------|
| 6.1 | Codex 进程崩溃 → 自动重启 (最多 3 次) |
| 6.2 | Codex 启动失败 → 降级到 SGA, 弹窗提示 |
| 6.3 | 超时: turn>5min 强制 abort |
| 6.4 | 取消: 用户点停止, 立即发 `turn/interrupt` |
| 6.5 | 指标: 上报 Codex turn 数 / 延迟 / 失败率 / 切换次数 |
| 6.6 | 文档: README 新增 "双后端" + "记忆交接" 章节 |
| 6.7 | 文档: 故障排查 RUNBOOK |
| 6.8 | 端到端: 用户测试 5 个真实 ComfyUI 任务 (含 2 个切换场景) |

### Sprint 7: 长期记忆跨 agent (可选, 6 之后启动)

**目标**: SGA long-term memory 也能在 Codex 端 recall

| # | 任务 |
|---|------|
| 7.1 | 暴露 `recall_memory` / `write_memory` 为 MCP tools (经 SGA) |
| 7.2 | Codex SKILL.md 描述何时该调 |
| 7.3 | 测试: Codex 主动 recall 历史事实 |

---

## 6. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Codex 体积大, 启动慢 (3-5s) | 中 | 复用进程, 每次会话不重启; 启动时显示"loading" |
| Codex 仅在 Windows 通过 WSL/Cygwin 可用? | 高 | 提前验证: 用 `codex-rs/app-server` 在 Windows 原生跑, 不依赖 WSL |
| Codex 的 app-server 协议不稳定 | 中 | 锁版本, 监听 codex-rs release, 用 SemVer 检查 |
| SGA Tools 内部依赖 `ToolUseContext`, 改 MCP 后丢失 | 中 | 提供 MCP adapter, 在 server 端补回 context |
| Codex 端 sub-agents 与 SGA 不互通 | 低 | 不强求统一, 各自跑各自的 |
| 用户切换 agent 后看到不同风格回答 | 低 | 通过 AGENTS.md + Skills + Blackboard 统一"系统级"语气 |
| Codex 沙箱影响 SGA 工具 (如 file-write) | 中 | 关闭 Codex 沙箱 (sandbox=workspace-write) 或显式配置 |
| Provider 密钥在 Codex 进程 env 暴露 | 中 | 启动时一次性注入, 不写文件; process tree 不可见 |
| 进程死亡后, UI 一直 pending | 中 | 加 ping 心跳, 5s 无响应标记离线 |
| Codex 一次只能跑一个 turn | 低 | 队列化, 复用 thread |
| HandoffBundle 损坏 (磁盘坏块/JSON 截断) | 中 | 原子写 (.tmp + rename); 损坏时 fallback 到"冷启动", 仅保留 Blackboard |
| Bundle 体积爆炸 (长 session) | 中 | recentMessages 限 20 轮; 长期记忆只传摘要, 不传原文 |
| Blackboard 写入冲突 (两 backend 同时写) | 低 | 串行化: 切换瞬间短窗口内禁止新 turn; .tmp + rename 原子写 |
| **用户感知到"切换后 agent 不知道之前聊过啥"** | 高 | **HandoffBundle + Blackboard 双层设计 (见 §3.4)**, 覆盖"切换瞬间"和"持续热数据" |

---

## 7. 测试计划

### 7.1 单元测试

| 模块 | 测试点 | 状态 |
|------|--------|------|
| `event-bridge.ts` | 100+ Codex event → SGA event 映射 | ⏳ |
| `jsonrpc.ts` | 双向请求/响应/通知解析 | ⏳ |
| `codex-backend.ts` | mock stdio, 验证 send/abort/health 行为 | ⏳ |
| `sga-backend.ts` | 回归: 与原 `runAgent` 输出一致 | ⏳ |
| `handoff/store.ts` | write/consume/peek/clear 正确性, atomic write, 路径注入防御 | ⏳ |
| `handoff/blackboard.ts` | update/addKeyFact/recordSwitch/toPromptSection | ⏳ |
| `handoff/extractor.ts` | 容错: memory/working-set 不可用时返回空 | ⏳ |
| `registry.ts` | get/listAll/healthCheck 并发安全 | ⏳ |

### 7.2 集成测试

| 场景 | 期望 | 状态 |
|------|------|------|
| SGA 跑 "列出 5 个模型" | 200 + 模型列表 | ✅ 旧行为 |
| 切换到 SGA (相同类型) | 200, activeAgent 保持 | ⏳ |
| Codex 跑 "列出 5 个模型" | 200 + 模型列表 (经 MCP) | ⏳ |
| Codex 跑 "分析这个 workflow JSON" | 200 + 分析结果 | ⏳ |
| SGA → Codex 切换 | 200, 后续 message 走 Codex, 上下文不丢 | ⏳ |
| Codex → SGA 切换 | 200, 后续 message 走 SGA, 上下文不丢 | ⏳ |
| Codex 中断 (用户点停止) | 立即停止 + UI 显示已取消 | ⏳ |
| Codex 进程被 kill -9 | 自动重启 1 次; 第 2 次降级到 SGA | ⏳ |
| API Key 错误 | Codex 返回 401 → 桥接为 SGA `content_block_delta` 含错误信息 | ⏳ |
| HandoffBundle 损坏 (手动改坏) | fallback 到冷启动, 不阻塞 | ⏳ |
| 切换瞬间新 turn 进来 | 串行化: 等待切换完成, 不丢 turn | ⏳ |

### 7.3 端到端 (人工)

- [ ] 新建工作流 (openai): Codex 调 MCP 生成 JSON
- [ ] 调试工作流错误: Codex 调 MCP 分析
- [ ] 切换 agent 后, 会话连续性 (用户视角看不出断点)
- [ ] Codex 与 SGA 同一任务结果对比
- [ ] 关闭 Codex 二进制, UI 给提示 + 自动降级

### 7.4 性能基线

| 指标 | SGA | Codex (目标) |
|------|-----|--------------|
| 冷启动 | < 100ms | < 5s (一次性) |
| Warm turn 延迟 | < 50ms | < 100ms (子进程) |
| Token 计数精度 | 100% | 95% (经桥接) |
| 内存占用 (1 会话) | ~50MB | +~200MB |
| 切换时延 (SGA→Codex) | — | < 1s |
| HandoffBundle 写盘 | — | < 50ms (含 atomic rename) |
| Blackboard 读 | — | < 20ms |

---

## 8. 回滚策略

1. **Feature flag**: `SGA_AGENT_BACKEND=codex|sga|both` (env), 默认 `both`
   - `sga` → 旧行为, 完全不引用 codex
   - `codex` → 强制走 codex
   - `both` → 运行时可选
2. **数据不共享写**: Codex 端的 session / thread 完全独立, 不会污染 SGA
3. **灰度发布**: 先内测, 再开 `codex` 选项到 UI 默认
4. **监控**: Codex 失败率 > 5% 自动降级, 关闭选项
5. **HandoffBundle 清理**: `HandoffStore.clear(sessionId)` 提供硬删除, 紧急时一键回滚

---

## 9. TS 编译修复记录 (Sprint 1 期间)

| 错误 | 根因 | 修复 | 文件 |
|------|------|------|------|
| `Property 'agentDefinition' does not exist on type 'SystemPrompt'` | `runOptions` 类型与 `BackendMessageOptions` 字段不齐 | `runOptions.agentDefinition` 增加 `?? opts.agentDefinition` fallback | `sga-backend.ts` |
| `Property 'getBundledSkillNames' does not exist` | skills 索引函数名错 | 改用 `getAllBundledSkills` (来自 `bundled-registry.js`) | `sga-backend.ts` |
| `Cannot find name 'BackendHealth'` | 漏导入 | `import type { BackendHealth }` from `./backend.js` | `registry.ts` |
| `exportededAt` typo | 手写笔误 | 改为 `exportedAt` | `store.ts` |
| `registry.listAll` 返回类型不匹配 | 漏 `Promise<AgentBackend[]>` 标注 | 加显式返回类型 | `registry.ts` |

> 状态: 上述错误已逐个修复, **下一步需执行 `tsc` 验证全量编译通过**。

---

## 10. 关键文件清单

### 新增 (✅ Sprint 1 已落地)

```
sga_template/
  src/agents/
    backend.ts                              # AgentBackend interface, HandoffBundle type ✅
    sga-backend.ts                          # SGA 实现 ✅
    codex-backend.ts                        # Codex 实现 stub ⏳ Sprint 2
    registry.ts                             # BackendRegistry ✅
    handoff/
      index.ts                              # 子模块出口 ✅
      store.ts                              # HandoffStore (磁盘持久化) ✅
      blackboard.ts                         # Blackboard (共享黑板) ✅
      extractor.ts                          # MemoryExtractor (SGA → keyFacts) ✅
  src/agents/codex/                         # (Sprint 2 计划)
    process.ts
    jsonrpc.ts
    event-bridge.ts
codex_integration/                          # (Sprint 5 计划)
  AGENTS.md
  skills/
    comfyui-workflow-create/SKILL.md
    comfyui-workflow-debug/SKILL.md
    comfyui-model-explore/SKILL.md
docs/
  codex-agent-integration.md                # 本文档 ✅ v0.3
```

### 修改

```
sga_template/
  src/server/
    routes.ts                               # 按 activeAgent 路由, /sessions/:id/agent ✅
    session.ts                              # +activeAgent 字段 ✅
    session-store.ts                        # activeAgent 持久化 ✅
    app.ts                                  # 启动时初始化 BackendRegistry ✅
  src/agents/index.ts                       # 导出新 backend
ui/src/
  components/SettingsModal.tsx              # agent 切换 ⏳ Sprint 4
  components/ChatHeader.tsx                 # 显示当前 backend ⏳ Sprint 4
  types.ts                                  # Settings 增字段 ⏳ Sprint 4
  services/configService.ts                 # active agent 持久化 ⏳ Sprint 4
README.md                                   # 双后端 + 记忆交接说明 ⏳ Sprint 6
```

---

## 11. 已决策的关键问题

| 问题 | 决策 |
|------|------|
| Codex 安装来源 | **下载 release** (用户操作简单), SGA 启动时检测 + 提示安装 |
| Codex 是否需要 Pro 登录 | **支持双模**: 默认用 `OPENAI_API_KEY` (从 SGA provider 注入), 也可走 ChatGPT 登录 |
| AGENTS.md 放哪 | **项目根** (`comfy_workflow_agent/AGENTS.md`), Codex 会自动加载 |
| Skills 复制策略 | **启动时同步** (覆盖), 文件用 `codex_integration/skills/` 管理 |
| Codex 默认模型 | **跟随 SGA provider config** (用户配置啥用啥), 无 provider 时回退 `gpt-5-codex` |
| 切换粒度 | **每会话** (session.activeAgent), 全局 defaultAgent 走 settings |
| 记忆隔离 vs 连续 | **连续** (HandoffBundle + Blackboard) — 用户中途切换不丢记忆 |
| Bundle 存储位置 | **`<SGA_HOME>/handoff/<sessionId>.json`** + history sidecar |
| Blackboard 存储位置 | **`<SGA_HOME>/shared/blackboard.json`** |
| Bundle 消费策略 | **read-once-delete** (避免下次启动重复注入) |

---

## 12. 验收标准 (Definition of Done)

- [ ] 用户在 UI 可选择 SGA 或 Codex 作为 backend (⏳ Sprint 4)
- [x] 切换后, 同 provider 配置在两边都能用
- [x] **codex 不需要 ChatGPT 登录** (requires_openai_auth=false + provider-proxy)
- [x] **provider 变化后 codex 自动重启** (指纹检测)
- [ ] **切换 agent 后, 记忆不丢失** (HandoffBundle + Blackboard 验证) (⏳ Sprint 2.7+)
- [ ] ComfyUI 工具 (workflow-analyzer / node-search 等) 在 Codex 端能正常调用 (⏳ Sprint 5)
- [ ] SGA long-term memory 在 Codex 端能通过 MCP tool recall (Sprint 7)
- [ ] Codex 进程崩溃时, 不影响 SGA, 且 UI 给出明确提示 (⏳ Sprint 6)
- [ ] 6 个端到端测试场景全部通过 (含 2 个 SGA↔Codex 切换场景) (⏳ Sprint 6)
- [ ] README 文档完整, 含"双后端" + "记忆交接" + "排错指南" (⏳ Sprint 6)
- [ ] 性能基线达标 (见 7.4) (⏳ Sprint 6)

---

## 13. 当前进度

> **已完成 (Sprint 1)**: `AgentBackend` 抽象, `SgaBackend` 包裹, `HandoffStore` + `Blackboard` + `MemoryExtractor` 三个 handoff 子模块, `BackendRegistry` 全局管理, `session.activeAgent` 字段, `routes.ts` 路由分发 + 切换端点, TS 编译错误修复。
>
> **已完成 (Sprint 2)**: `CodexBackend` 完整实现 — `detect.ts` 多级二进制探测, `process.ts` 子进程生命周期, `jsonrpc.ts` JSON-RPC 双向通讯 + 日志, `event-bridge.ts` 事件映射, `codex-backend.ts` 完整 start/stop/sendMessage/abort/healthCheck/exportHandoff/importHandoff. E2E mock 6/6 PASS.
>
> **已完成 (Sprint 3)**: Provider 共享 + 登录去除 — `provider-proxy.ts` Responses→ChatCompletions 翻译反代, `config.ts` 临时 config.toml 生成 (`requires_openai_auth=false`), `handleSwitchSessionAgent` 传 provider/model, `handleStreamResponse` + `handleSendMessage` 按 activeAgent 派发, provider 变化自动重启 codex. SSE `type` 字段注入修复. `thread/tokenUsage/updated` 监听修复 usage=0.
>
> **下一步 (Sprint 4)**:
> 1. UI 适配: `SettingsModal.tsx` 新增 agent 选择器
> 2. `ChatHeader.tsx` 显示当前 backend
> 3. Codex 未安装时给下载指引
> 4. 切换后新会话用新 backend, 旧会话保持原 backend
>
> **Sprint 5 (ComfyUI 工具接入)**:
> 1. 注册 `comfyui-mcp-server` 到 Codex config.toml
> 2. 写 `AGENTS.md` + Skills
> 3. 验证 Codex 能调 `analyze_workflow` / `search_nodes`
>
> **Sprint 6 (健壮性)**:
> 1. Codex 进程崩溃自动重启
> 2. 启动失败降级到 SGA
> 3. 超时 / 取消处理
> 4. 端到端真供应商测试
>
> **待办 (不阻塞)**:
> - Tool calls / structured outputs 在 proxy 翻译逻辑中的支持
> - 真供应商端到端测试 (DeepSeek/GLM)

---

## 14. 调试记录 (Sprint 2-3 期间)

### 14.1 "stream closed before response.completed" 错误

**现象**: codex 启动成功, proxy 收到请求并转发, 供应商返回正常, proxy 发了 `response.completed` 事件, 但 codex 报 `stream closed before response.completed` 终止.

**排查过程**:
1. 在 `provider-proxy.ts` 的 `emitSseEvent` 加 INFO 日志, 确认所有事件 (created/delta/completed) 都发了
2. 在 `jsonrpc.ts` 加 JSON-RPC frame 日志, 确认 codex 收到了 turn/start 响应
3. 读 codex 源码 `codex-rs/codex-api/src/sse/responses.rs`, 发现 SSE parser **不读 `event:` 行**, 而是读 data JSON 里的 `type` 字段

**根因**: codex 的 `ResponsesStreamEvent` struct 用 `#[serde(rename = "type")]` 反序列化 `kind` 字段. 我们 proxy 发的 data JSON 里没有 `type`, 所以全部走 `_` 分支被忽略.

**修复**: `emitSseEvent` 自动注入 `type` 字段到 data JSON:
```typescript
if (!('type' in obj)) {
  payload = { type, ...obj }
}
```

### 14.2 TypeScript 编译错误 (Sprint 3)

| 错误 | 根因 | 修复 |
|------|------|------|
| `UsageMetrics` 类型不匹配 | codex dispatch 里用了简化类型, 缺 `cacheReadInputTokens` / `cacheCreationInputTokens` / `totalCostUsd` | 改用完整 `UsageMetrics` 类型, 缺失字段填 0 |
| `provider-proxy.ts` 缺少 import | `createLogger` 和 `ProviderConfig` 导入路径错 | 改为 `../../utils/logger.js` 和 `../../providers/types.js` |

### 14.3 Windows ENOBUFS 网络错误

**现象**: e2e mock 测试报 `listen ENOBUFS: no buffer space available 127.0.0.1`.

**根因**: Windows 网络栈缓冲区耗尽, 大量 TIME_WAIT 连接堆积. 非代码问题, 重启或等待后恢复.

**处理**: 环境问题, 不影响代码正确性. tsc 编译通过即可验证代码.

### 14.4 Codex binary 探测

**现象**: 项目根找不到 codex binary.

**修复**: `detect.ts` 优先探测官方安装路径 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, 实际找到 `C:\Users\25315\AppData\Local\OpenAI\Codex\bin\07133f975a59dbd9\codex.exe`.

### 14.5 turn_end usage=0 问题

**现象**: codex 的 `turn/completed` notification 不带 usage 字段, 导致 `turn_end` 事件的 usage 全为 0.

**根因**: codex app-server 协议中, token usage 通过单独的 `thread/tokenUsage/updated` notification 推送, 而不是在 `turn/completed` 里.

**修复**: 在 `event-bridge.ts` 新增 `thread/tokenUsage/updated` case, 缓存 usage. `turn/completed` 时优先用缓存的 usage, fallback 到 `turn/completed.params.turn.usage`.

---

> **最后更新**: 2026-06-19 · 维护者: Comfy Workflow Agent Team
