# Architecture

This document describes the current runtime shape of ComfyUI Workflow Agent. It intentionally separates stable behavior from optional or experimental capabilities.

## Runtime Layers

```text
ComfyUI (Python)
  -> custom node entry: __init__.py
  -> starts SGA backend as a Node.js child process

SGA backend (Node.js + TypeScript)
  -> Express HTTP API
  -> provider config and session storage
  -> SGA agent runtime, tools, memory, MCP, diagnostics
  -> optional Codex backend adapter

React UI (Vite build in web/)
  -> chat panel
  -> provider setup
  -> workflow diagnostics
  -> system diagnostics
  -> optional SGA/Codex session switcher

Codex backend (optional Rust child process)
  -> vendored codex-rs source
  -> compatible codex-app-server binary only
  -> JSON-RPC over stdio
```

## Stable Default: SGA

SGA is the default and expected production path. It does not require Codex, Rust, network access during normal startup, or a Codex binary. The Python extension starts the Node backend, and the backend serves both the UI-facing APIs and the agent runtime.

Important modules:

| Path | Responsibility |
|---|---|
| `__init__.py` | ComfyUI extension entry, Node runtime preparation, backend startup, readable startup logs. |
| `sga_template/src/server/app.ts` | Express app assembly and route registration. |
| `sga_template/src/server/routes.ts` | HTTP handlers for chat, providers, diagnostics, Codex status, and handoff status. |
| `sga_template/src/agents/sga-backend.ts` | SGA implementation of the shared `AgentBackend` interface. |
| `sga_template/src/agents/registry.ts` | Backend registry for SGA and optional Codex instances. |
| `sga_template/src/providers/` | Provider configuration, validation, and request adapters. |
| `sga_template/src/mcp/` | MCP client and adapter integration. |
| `ui/src/` | React UI source. |

## Optional Capability: Codex

Codex is treated as a capability with explicit state, not as a required service. Its lifecycle is exposed through `GET /api/v1/codex/status` and represented by the following states:

| State | Meaning |
|---|---|
| `disabled` | `SGA_ENABLE_CODEX=false`; switching to Codex is blocked. |
| `unavailable` | No compatible source/binary is available. |
| `source-present` | Vendored source exists, but a compatible binary is not ready. |
| `building` | A background build is in progress. SGA remains usable. |
| `ready` | Codex can be selected for a session. |
| `failed` | Build or detection failed; SGA remains usable. |

Switching to Codex is allowed only when the capability is `ready`. Otherwise the backend returns structured errors such as `CODEX_DISABLED`, `CODEX_NOT_READY`, or `CODEX_BUILD_FAILED`.

Important modules:

| Path | Responsibility |
|---|---|
| `sga_template/src/server/codex-status.ts` | Capability state detection and safe API response shape. |
| `sga_template/src/agents/codex-backend.ts` | Codex backend wrapper and process lifecycle. |
| `sga_template/src/agents/codex/detect.ts` | Compatible binary detection. |
| `sga_template/src/agents/codex/process.ts` | Child process spawn and shutdown. |
| `sga_template/src/agents/codex/jsonrpc.ts` | JSON-RPC framing over stdio. |
| `sga_template/src/agents/codex/event-bridge.ts` | Codex event mapping to SGA stream events. |

## Diagnostics

The backend exposes redacted system diagnostics through `GET /api/v1/diagnostics`. The endpoint aggregates:

- backend health and Node/runtime version;
- session/config path availability as booleans;
- provider count, default provider, and missing API key status;
- Codex capability and build state;
- MCP connection counts;
- ComfyUI reachability status when available;
- recent redacted error summaries.

Diagnostics must not return API keys, GitHub tokens, authorization headers, or complete secret values. The UI exposes this as a **System Diagnostics** view, separate from workflow graph diagnostics.

## Agent Handoff Observability

Session agent switching uses a handoff bundle plus an audit record. The audit record stores metadata only: source/target agent, counts, timestamps, import/export status, warnings, and error summaries. It does not persist full chat messages or secret content.

Important modules:

| Path | Responsibility |
|---|---|
| `sga_template/src/agents/handoff/store.ts` | Handoff bundle persistence and audit records. |
| `sga_template/src/server/routes.ts` | `handleSwitchSessionAgentStable` and handoff status handlers. |
| `ui/src/services/configService.ts` | Frontend APIs for active agent and handoff status. |
| `ui/src/App.tsx` | Displays last handoff summary after switching agents. |

`GET /api/v1/sessions/:sessionId/handoff/status` returns the current active agent, last switch time, pending state, export/import summaries, message and key fact counts, warnings, and errors.

## Data Storage

The project relies on filesystem JSON for local state. This keeps deployment simple for a ComfyUI custom node and makes support easier.

| Data | Typical Location |
|---|---|
| Provider configs | `~/.sga/comfyui/api_configs/` or `COMFYUI_CONFIG_DIR` |
| Sessions | `SGA_HOME`-managed session storage |
| Handoff bundles/audits | `<SGA_HOME>/handoff/` |
| Shared blackboard | `<SGA_HOME>/shared/blackboard.json` |
| Codex build state | `<SGA_HOME>/codex-build.json` |

## Verification Baseline

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

These checks are expected to run without a real Codex binary, network access, or external API keys.
