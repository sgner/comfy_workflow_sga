# 开发日志 — ComfyUI Workflow Agent

> 维护者: sgner · 远程仓库: https://github.com/sgner/comfy_workflow_sga.git
> 本日志按时间倒序记录，每次重要变更后追加一节。

---

## 2026-06-23 · Codex "Comfy Workflow Agent" 身份注入 + 共享记忆

### 背景

Codex 后端接入项目后，行为是**默认的 Codex CLI** —— 回答 "What do you want
changed or investigated in this workspace?"，对 ComfyUI 工作流一无所知。
而 SGA 的原生 agent 自称 **"Comfy Workflow Agent"**，有完整的 ComfyUI 上下文
和工具链。用户期望：切换到 Codex 后端时，**行为、身份、记忆** 都和 SGA 一致。

### 完成的改动

#### 1. Codex 端：Rust 注入层 `comfyui_agent.rs`

新文件 `sga_template/codex-rs/core/src/comfyui_agent.rs` 是核心改造点。

它做三件事：

1. **注入静态身份**：把 SGA 的 `comfyui-agent.ts` 整段 CORE MISSION /
   CAPABILITIES / RESPONSE FORMAT / RULES / WORKSPACE / ADVANCED CAPABILITIES /
   FINAL OUTPUT (Related Questions) **1:1 翻译成 Rust 字符串常量**，
   拼到 `## IDENTITY OVERRIDE (HIGHEST PRIORITY)` 块里，**最高优先级**，
   覆盖 Codex 默认的 "codex CLI" 人设。

2. **注入 ComfyUI 环境上下文**：`build_env_context()` 读取 `COMFYUI_BASE_DIR`、
   `SGA.md`、`extra_model_paths.yaml`、`custom_nodes/` 列表、已安装 Python 包等。
   第一次构建后 `OnceCell` 缓存，不重复扫盘。

3. **注入共享黑板**：`build_blackboard_section()` 读
   `<SGA_HOME>/shared/blackboard.json`（由 SGA `blackboard.ts` 写入），
   包含当前任务、key facts、最近 agent 动作 —— 让 Codex 和 SGA 共享"热数据"。

**关键代码**（节选）：

```rust
pub async fn build_prefix() -> &'static str {
    CACHED_PREFIX.get_or_init(build_dynamic_prefix_inner).await
}

async fn build_dynamic_prefix_inner() -> String {
    let mut buf = String::with_capacity(2 * 1024);
    buf.push_str(COMFY_WORKFLOW_AGENT_IDENTITY);   // SGA 1:1
    // ... env + blackboard sections ...
    truncate_to_budget(&mut buf, MAX_DYNAMIC_BYTES);
    buf
}
```

`truncate_to_budget` 限制 ≤32KB 总预算，避免把请求撑爆。

#### 2. Codex 端：client.rs 接入

`sga_template/codex-rs/core/src/client.rs::build_responses_request` 从
`const IDENTITY` 改为：

```rust
let comfy_prefix = crate::comfyui_agent::build_prefix().await;
let mut instructions = String::with_capacity(
    comfy_prefix.len() + prompt.base_instructions.text.len() + 2
);
instructions.push_str(&comfy_prefix);
instructions.push_str(&prompt.base_instructions.text);
```

这样 model 看到的 system prompt = Codex 默认 + 我们的 Comfy Workflow Agent 身份块。

#### 3. SGA 端：live-context.ts（写盘）

`handleComfyUIChatStream` 在 pin working set 之后调 `writeLiveContext()`，把当前
workflow JSON / 前端 context 文本 / workflow 摘要 / 错误日志 **原子地**写到
`<SGA_HOME>/shared/comfyui/` 下的 4 个 JSON 文件。

**绝不能截断** —— ComfyUI 不接受残缺 JSON。要么完整内联、要么给文件路径让模型
用 `read_file` 读全文。

#### 4. Codex 端：live-context reader

`comfyui_agent.rs::build_live_context_section()` 读这 4 个文件，按大小分类处理：

| 文件 | ≤16KB | 16~64KB | >64KB |
|------|-------|---------|-------|
| `workflow.json` | 完整内联 | 完整内联 | 文件路径 + `read_file` 提示 |
| `workflow-summary.json` | 完整内联 | - | - |
| `frontend-context.json` | 完整内联 | 文件路径 | - |
| `error-log.json` | 完整内联 | 文件路径 | - |

> 之所以 workflow 阈值更高（64KB），是因为它本身就是结构化 JSON，
> 不能被切开。前端 context / 错误日志是文本，截断影响小。

#### 5. Codex 端：SGA-side context builder

`sga_template/src/agents/codex/context.ts` 新增
`buildCodexDeveloperInstructions()`：

- 读 `SGA.md`（SGA 的项目级 prompt）
- 读 blackboard
- 注入 ComfyUI agent identity（codex 端再做一次保险）
- 注入 live ComfyUI context
- 拼成一个 string，传给 `thread/start` 的 `developerInstructions`

这样**SGA 端也兜底**一次 —— 即使 Rust 端出问题，model 还是能收到 SGA 的指令。

#### 6. Codex binary 探测

`detect.ts` 明确 **拒绝 OpenAI 官方安装**：

```ts
// OpenAI 官方安装路径 - 主动 REJECT
if (resolvedPath.includes('OpenAI') || resolvedPath.includes('OpenAI\\Codex')) {
  console.warn('[codex-detect] REJECTED: OpenAI official codex install at ...');
  return null;
}
// PATH 兜底 - 主动 REJECT
if (path.basename(resolved) === 'codex' && !resolved.includes('target')) {
  console.warn('[codex-detect] REJECTED: PATH codex (not our vendored build)');
  return null;
}
```

**只允许** `sga_template/codex-rs/target/release/codex-app-server(.exe)` 或
`CODEX_BINARY` 环境变量。

#### 7. Codex process launch 修复

旧代码：`codex app-server --stdio -c sandbox=workspace-write --analytics-default-enabled`
新代码：`codex-app-server.exe -c sandbox=workspace-write`

去掉了无效的 `app-server` 子命令（现代 codex 本身就是 app-server 模式）、
废弃的 `--analytics-default-enabled`、多余的 `--stdio`（默认就是 stdio）。

### 编译与验证

- ✅ `cargo check -p codex-core` 通过（exit 0，耗时 12s）
- ✅ `cargo build --release -p codex-app-server` 通过（257.4 MB exe，耗时 8m55s）
- ✅ `npm run typecheck` 通过（exit 0）
- ✅ Codex 子进程启动正常，initialize 握手成功
- ✅ 模型回答从 "What do you want changed?" 变成 "我是 Comfy Workflow Agent..."，含 Related Questions

### 经验教训

1. **v8 crate 的 37MB 预编译库**从 GitHub release 下载，国内访问被拦截。解决：
   用 `ghfast.top` 镜像 + 缓存到 `~/.cargo/.rusty_v8/`。
2. **cargo build script 在 Windows sandbox 会被 `CreateProcessW` 拦截**：
   `CARGO_TARGET_DIR=C:\codex-target` 短路径绕过。
3. **Rust 类型细节**：`Option<serde_json::Value>` 没有 Display，只能 Debug；
   嵌套 `Option<Option<...>>` 解包需要先 `.as_ref()`。

---

## 2026-06-22 · Codex binary 探测优先级重排

### 问题

SGA 启动时优先探测 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（OpenAI
官方安装），结果用户跑 Codex 出来的还是**官方版本的 Codex CLI**，
不是我们改造过的 vendored build。

### 修复

`detect.ts` 探测顺序改为：

1. `CODEX_BINARY` 环境变量
2. `sga_template/codex-rs/target/release/codex-app-server(.exe)` ← **我们的**
3. `sga_template/codex-rs/target/debug/codex-app-server(.exe)`
4. ~~`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`~~ → 移到末尾并加 WARN
5. ~~`PATH` 里的 `codex`~~ → 移到末尾并加 WARN

### 结果

SGA 启动日志会清楚显示用哪个 binary。

---

## 2026-06-19 · CodexAgent Sprint 5 (vendored codex-rs)

### 背景

之前用户需要 `git submodule` 拉取 OpenAI 官方 `codex-rs`，与上游版本脱钩。
改为 **vendor** 到 `sga_template/codex-rs/`，跟主仓库一起分发。

### 改动

- `git rm` `codex/` 子模块
- `cp -r upstream/codex-rs sga_template/codex-rs/`
- 添加 `README-VENDORED.md` 说明 Apache-2.0 license
- `.gitignore` 排除 `sga_template/codex-rs/target/`
- 修改 `SGA.md` 解释目录结构

### Sprint 5 完成项

- ✅ vendored codex-rs (Apache-2.0)
- ✅ `_download_codex_binary()` + `_build_codex_with_cargo()` Python 端
- ✅ TS 端 `detect.ts` 新增 `sga_template/codex-rs/target/release/` 探测路径
- ✅ `CODEX_SKIP_DOWNLOAD=1` / `CODEX_SKIP_BUILD=1` 跳过开关
- ✅ build 30 分钟超时

---

## 2026-06-19 · CodexAgent Sprint 3 (Provider 共享 + 登录去除)

### 目标

让 Codex 不需要 ChatGPT 登录，**共用 SGA 的 provider 配置**。

### 实现

#### provider-proxy.ts（Responses → ChatCompletions 反代）

Codex app-server 走 OpenAI 的 `/v1/responses` 端点（带 SSE 协议），但
国内/第三方供应商多数是 `/v1/chat/completions`。写了一个 Express 反代：

- 接 `POST /v1/responses`
- 翻译成 `POST {upstream}/v1/chat/completions`（含 stream=true）
- 把 ChatCompletions 的 SSE 事件重新打包成 Responses 的 `response.created` /
  `response.output_text.delta` / `response.completed` 事件
- 注入 `type` 字段（Sprint 14.1 调试发现 codex SSE parser 不读 `event:` 行，
  只读 data JSON 里的 `type` 字段）

#### config.ts（临时 config.toml 生成）

每次 CodexBackend 启动，临时写一份 `~/.codex/config.toml`：

```toml
requires_openai_auth = false
model_provider = "custom"
[model_providers.custom]
name = "Custom"
base_url = "http://127.0.0.1:51234/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

`OPENAI_API_KEY` 来自 SGA provider-store 里的 `api_key`，**不写文件**。

#### handleSwitchSessionAgent 传 provider

```ts
await codexBackend.start({
  provider: currentProvider,    // ← SGA provider
  model: currentProvider.defaultModel,
  baseUrl: ...
});
```

#### provider 指纹检测

如果用户在 UI 改了 provider 配置，codex 后端会 **自动重启**接新供应商
（不需要用户手动重启 ComfyUI）。

### 验收

- ✅ 同一份 provider 配置，SGA 和 codex 都能用
- ✅ codex 不需要 ChatGPT 登录
- ✅ 切换 provider 后 codex 自动重启
- ✅ E2E mock 6/6 PASS

---

## 2026-06-18 · CodexAgent Sprint 2 (子进程桥接)

### 目标

`codex app-server` 是 stdio JSON-RPC 协议，能让 SGA 跟它双向通信。

### 实现

- `process.ts` — spawn 子进程，pipe stdin/stdout
- `jsonrpc.ts` — JSON-RPC frame 解析 + 请求/响应/通知分发
- `event-bridge.ts` — 把 codex 事件映射成 SGA 的 `AgentStreamEvent`：
  - `item/agentMessage/delta` → `content_block_delta` (text)
  - `item/commandExecution/outputDelta` → `content_block_delta` (tool_result)
  - `item/started` (mcpToolCall) → `content_block_start` (tool_use)
  - `turn/completed` → `message_stop`
- `codex-backend.ts` — 完整实现 `start / stop / sendMessage / abort / healthCheck`

### 验收

- ✅ `POST /api/v1/sessions/:id/agent { target: 'codex' }` 切换成功
- ✅ Codex 输出能正确映射为 SSE 事件
- ✅ abort 中断能立即生效
- ✅ E2E mock: 累积文本 = "hi from mock"

---

## 2026-06-18 · CodexAgent Sprint 1 (抽象与基建)

### 目标

抽出 `AgentBackend` 接口，让 SGA 和 Codex 都能用同一种方式被路由。

### 关键文件

- `src/agents/backend.ts` — `AgentBackend` interface + `HandoffBundle` type
- `src/agents/sga-backend.ts` — 包裹 `runAgent`
- `src/agents/registry.ts` — 全局 `BackendRegistry`
- `src/agents/handoff/{store,blackboard,extractor,index}.ts` — 三个 handoff 子模块
- `src/server/session.ts` — 添加 `activeAgent` 字段
- `src/server/routes.ts` — 按 `session.activeAgent` 路由 + 切换端点

### 验收

- ✅ 现有 SGA 行为不变
- ✅ `session.activeAgent` 字段持久化
- ✅ `POST /api/v1/sessions/:id/agent` 切换成功

---

## 历史（SGA 阶段）

(2026-06-15 之前的开发日志记录在 `logs615.md`，主要是 SGA + ComfyUI 工具集
的早期迭代 —— workflow-analyzer、node-search、provider 三步验证等。)
