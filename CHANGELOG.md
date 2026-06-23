# Changelog — ComfyUI Workflow Agent

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
