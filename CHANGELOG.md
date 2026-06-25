# Changelog — ComfyUI Workflow Agent

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **MCP server persistence** (`sga_template/src/mcp/manager.ts`, `skills-mcp-routes.ts`)
  - MCP servers added at runtime were lost on SGA restart because `registerMCPServer` only
    mutated the in-memory map. New `persistMCPServers()` writes the full config list to
    `<SGA_HOME>/mcp-servers.json`; `app.ts` already loads it on boot via
    `loadMCPServersFromConfig()` + `connectAllMCPServers()`. Add/Delete now also call
    persist so the file stays in sync.
  - Transport field is now strictly validated server-side: only `stdio | sse | streamable-http`
    are accepted; the previous weak `string` type allowed the frontend to inject anything.
- **MCP auto-connect on add** (`skills-mcp-routes.ts`)
  - `POST /api/v1/mcp/servers` now immediately calls `connectMCPServer` so the new server
    is up in one click instead of two. If connect fails (bad command, port in use, etc.) the
    server is still created with `status: 'error'` and the error message is returned in the
    response body so the UI can surface it.
- **MCP/Skill form silent failure** (`ui/src/components/WorkflowVisualizer.tsx`)
  - Add forms previously had no `.catch`; a 4xx/5xx from the backend disappeared. Both
    `addMCPServer` and `addSkill` now surface errors via a new `formError` state rendered
    above the action buttons.
- **MCP transport type safety** (`WorkflowVisualizer.tsx`)
  - `mcpForm.transport` is now a strict `'stdio' | 'sse' | 'streamable-http'` union instead of
    `string`; the `<select>` cast guards the boundary.

### Added

- **MCP environment-variable input** (`WorkflowVisualizer.tsx`, i18n)
  - The backend's `MCPServerConfig.env` was always supported but the form had no input for
    it. New `mcpForm.env` field accepts `KEY=val,KEY2=val2` syntax and is parsed into a
    `Record<string, string>` before submit. Missing `=` triggers a frontend form error.
- **MCP `getAllMCPServerConfigs()`** (`mcp/manager.ts`)
  - Small helper that returns the list of currently-registered `MCPServerConfig` objects;
    used by `persistMCPServers()` but exported for tests / future tooling.

### Changed

- **MCP connect-startup diagnostic** (`server/app.ts`)
  - Boot now logs `MCP servers: N/M connected` so operators can see at a glance whether
    their persisted servers came up cleanly.

- **Codex Comfy Workflow Agent identity** (`sga_template/codex-rs/core/src/comfyui_agent.rs`)
  - New Rust module that injects a `## IDENTITY OVERRIDE (HIGHEST PRIORITY)` system-prompt
    block into every Codex turn, turning the default Codex CLI into **"Comfy Workflow Agent"**
  - Fully mirrors SGA's `comfyui-agent.ts` identity: CORE MISSION, CAPABILITIES,
    RESPONSE FORMAT (ISSUES_JSON + SUGGESTED_ACTIONS), RULES, WORKSPACE,
    ADVANCED CAPABILITIES, FINAL OUTPUT (Related Questions)
  - Static identity cached in `OnceCell`, rebuilt once per process

- **ComfyUI environment context injection** (same file)
  - `build_env_context()` discovers `COMFYUI_BASE_DIR`, `SGA.md`, `extra_model_paths.yaml`,
    `custom_nodes/` listings, `output/` directory, installed Python packages
  - Async, reads from filesystem only when needed; cached after first build

- **SGA shared blackboard integration** (same file)
  - `build_blackboard_section()` reads `<SGA_HOME>/shared/blackboard.json`
  - Injects current task, key facts, recent agent actions into every Codex turn
  - Proper nested Option type handling (`Option<Option<serde_json::Value>>`)

- **Live ComfyUI workflow context** (`sga_template/src/comfyui/live-context.ts`)
  - SGA-side writer: on every `handleComfyUIChatStream`, writes the current workflow,
    frontend context text, workflow summary, and error log as atomic JSON files to
    `<SGA_HOME>/shared/comfyui/`
  - Codex-side reader: `build_live_context_section()` reads all four files
  - Zero-truncation policy: content is either **fully inlined** or **referenced by
    file path** with a `read_file` instruction — a truncated JSON would be invalid

- **Codex context builder** (`sga_template/src/agents/codex/context.ts`)
  - `buildCodexDeveloperInstructions()` assembles the Codex `thread/start` developer
    instructions from three sources: `SGA.md`, `Blackboard`, and the live ComfyUI
    context files
  - Returns a `string` ready to pass as `developerInstructions` to the Codex backend

- **Codex binary detection hardening** (`sga_template/src/agents/codex/detect.ts`)
  - **OpenAI official install explicitly rejected**: any binary under
    `%LOCALAPPDATA%\OpenAI\Codex\` or on `PATH` as `codex` triggers a WARN log and is
    excluded from the result — users must build the vendored binary or set
    `CODEX_BINARY` env var

- **Codex process launch cleanup** (`sga_template/src/agents/codex/process.ts`)
  - Removed invalid `--stdio` and `--analytics-default-enabled` CLI flags
  - Removed erroneous `app-server` subcommand argument
  - Spawned process is now simply `codex-app-server.exe -c sandbox=workspace-write`

- **Frontend build progress card** (`ui/src/components/CodexBuildProgressCard.tsx`)
  - Real-time progress UI for Codex compilation: shows Rust compilation progress
    percentage (parsed from `cargo build` stderr lines), estimated time, and final
    success state with SHA256 fingerprint

- **GitHub Actions release workflow** (`.github/workflows/release-codex.yml`)
  - Triggers on `git push -t v*.*.*` or manual workflow dispatch
  - Parallel cross-platform build: Windows (zip), Linux (tar.gz), macOS x86 + ARM
  - Produces SHA256SUMS for each binary; publishes all assets to a GitHub Release

- **Release download documentation** (`docs/release-codex.md`)
  - Windows PowerShell + Linux/macOS one-liner install scripts
  - Explains what the vendored build does differently vs OpenAI official codex

### Fixed

- **Option type display in blackboard** (`comfyui_agent.rs`)
  - `user_preferences["theme"]` has type `Option<Option<serde_json::Value>>`; added
    `.and_then(|inner| inner.as_ref())` to unwrap before `.as_str()`

- **Option type formatting** (`comfyui_agent.rs`)
  - `Option<serde_json::Value>` does not implement `Display`; changed `{:?}` (Debug fmt)
    for optional values so the `Debug` impl is used instead

### Changed

- **Codex `developerInstructions` injection point** (`sga_template/src/agents/codex-backend.ts`)
  - Moved from per-message injection (fragile, every turn) to per-thread injection
    (`thread/start` params) via `buildCodexDeveloperInstructions()`
  - Thread-level injection persists across turns without repeating the context

- **Static identity → dynamic prefix** (`sga_template/codex-rs/core/src/client.rs`)
  - Replaced hard-coded `const IDENTITY` with async `comfyui_agent::build_prefix()`
  - Full prefix built once (cached in `OnceCell`) then prepended to every request

### Removed

- **Static identity constant** (`client.rs`)
  - `const IDENTITY: &str` deleted; replaced by `build_prefix()` function call

---

## [0.1.0] — 2026-06-23

### Added

- **ComfyUI Workflow Agent plugin** (initial public release)
  - TypeScript + Node.js backend (SGA framework) auto-starts with ComfyUI
  - React frontend with SSE streaming chat
  - Multi-provider support: OpenAI, Anthropic, Gemini, any OpenAI-compatible API
  - Built-in tools: workflow analyzer, node search, model list, GitHub issue search
  - Provider proxy architecture for flexible LLM routing
  - Memory extraction and long-term context
  - Multi-language UI: zh / en / ja / ko

### Features

- SSE streaming with status updates per processing stage
- Agent-style chat with tool use and execution
- Automatic Node.js download if not present
- Provider config via API or web UI
- 3-step provider verification flow (address → protocol → model fetch)
- Handoff bundle and shared blackboard for session continuity
- Backend registry with health checks
