# ComfyUI Workflow Agent

ComfyUI Workflow Agent is a ComfyUI custom node that starts a local Agent backend and adds a workflow-focused chat panel to ComfyUI. The stable default backend is SGA, a Node.js/TypeScript agent service. Codex is an optional Rust backend for advanced users and is only shown as usable when its vendored `codex-app-server` binary is ready.

## Current Status

| Layer | Status | Notes |
|---|---|---|
| SGA backend | Stable default | Starts with ComfyUI, handles chat, workflow analysis, tools, memory, providers, and MCP integration. |
| React UI | Stable default | Provides chat, provider setup, workflow diagnostics, system diagnostics, and optional SGA/Codex switching. |
| Codex backend | Optional / experimental | Requires `sga_template/codex-rs/target/release/codex-app-server(.exe)` or explicit `CODEX_BINARY`. Failures do not block SGA. |
| Diagnostics | Available | `/api/v1/diagnostics`, `/api/v1/codex/status`, and handoff status APIs expose redacted health information. |

SGA should be usable even when Codex is missing, not built, or failed. Codex is a capability, not a required dependency.

## What This Project Includes

- A Python ComfyUI extension entry point: `__init__.py`.
- A Node.js/TypeScript SGA backend: `sga_template/`.
- A React/Vite UI: `ui/`, built into `web/`.
- Optional vendored Codex Rust source: `sga_template/codex-rs/`.
- Provider configuration for OpenAI-compatible APIs, Anthropic, Gemini, async providers, and custom endpoints.
- Workflow analysis, action, memory, MCP, and diagnostic modules.

## Quick Start

Place the repository under ComfyUI's `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone <repository-url> comfy_workflow_agent
```

Start ComfyUI normally. The plugin will:

1. Check for Node.js and install a local runtime if needed.
2. Install and build `sga_template`.
3. Build the React UI when needed.
4. Start the backend at `http://127.0.0.1:8000` by default.

Expected startup logs use readable UTF-8/ASCII text, for example:

```text
============================================================
Starting ComfyUI Workflow Agent Backend Server (SGA)
============================================================
Host: 127.0.0.1
Port: 8000
Health API: http://127.0.0.1:8000/api/health
============================================================
```

## API Overview

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Backend health check. |
| `POST` | `/api/chat/stream` | Streaming chat endpoint. |
| `GET` | `/api/configs` | List provider configs. |
| `POST` | `/api/configs` | Create provider config. |
| `POST` | `/api/v1/providers/verify-address` | Verify provider base URL reachability. |
| `POST` | `/api/v1/providers/verify-protocol` | Verify protocol compatibility. |
| `POST` | `/api/v1/providers/fetch-models` | Fetch model list from a provider. |
| `GET` | `/api/v1/codex/status` | Redacted Codex capability state. |
| `GET` | `/api/v1/diagnostics` | Redacted system diagnostics. |
| `GET` | `/api/v1/sessions/:sessionId/handoff/status` | Last agent handoff audit summary. |
| `POST` | `/api/v1/sessions/:sessionId/agent` | Switch a session between SGA and Codex when allowed. |

## Codex Capability

Codex is controlled by `SGA_ENABLE_CODEX`:

| Value | Behavior |
|---|---|
| `auto` | Default. Detect vendored source/binary and report capability state. SGA remains available. |
| `true` | Require Codex to be usable for Codex switching; unavailable states return structured errors. |
| `false` | Disable Codex. Switching to Codex returns `CODEX_DISABLED`. |

Additional variables:

- `CODEX_BINARY`: explicit path to a compatible `codex-app-server` binary.
- `CODEX_SKIP_BUILD=1`: skip automatic background Codex build attempts.

The recommended binary path is:

```text
sga_template/codex-rs/target/release/codex-app-server(.exe)
```

OpenAI's official `codex` CLI binary is not treated as a compatible Comfy Workflow Agent backend because it does not include this project's identity and app-server integration.

## Diagnostics

The system diagnostics API is designed for support and troubleshooting. It reports health and configuration status without exposing API keys, tokens, authorization headers, or full secret values.

Example:

```json
{
  "status": "ok",
  "backend": { "healthy": true, "version": "1.0.0" },
  "providers": { "count": 2, "defaultProvider": "openai", "missingKeys": [] },
  "codex": { "state": "ready", "canSwitchToCodex": true },
  "mcp": { "connected": 1, "total": 1 },
  "comfyui": { "reachable": true },
  "errors": []
}
```

The UI includes a separate **System Diagnostics** panel. It is distinct from workflow diagnostics, which focus on node graph problems.

## Verification

Backend:

```bash
cd sga_template
npm run typecheck
npm test
```

Frontend:

```bash
cd ui
npm run typecheck
npm run lint
npm run build
```

## Documentation

- `ARCHITECTURE.md`: current architecture and runtime boundaries.
- `docs/codex-agent-integration.md`: Codex capability state, API behavior, and completion matrix.
- `docs/tech-stack.md`: technology stack.
- `docs/rust-install-guide.md`: optional Rust/Codex build guide.
- `docs/release-codex.md`: optional prebuilt binary release notes.
- `docs/workflow-domain-capability-plan.md`: future plan for stronger ComfyUI workflow domain support.

## License

MIT for this project. Vendored Codex Rust source keeps its upstream Apache-2.0 licensing where applicable.
