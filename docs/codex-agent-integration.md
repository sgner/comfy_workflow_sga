# Codex Agent Integration

Last updated: 2026-06-28

Codex is an optional backend for ComfyUI Workflow Agent. SGA remains the stable default backend. The integration goal is to let advanced users switch a session to a compatible Codex `app-server` while preserving the default SGA experience when Codex is missing, building, or failed.

## Runtime Contract

| Component | Contract |
|---|---|
| SGA | Always starts independently when Node dependencies are available. |
| Codex | Starts only when the capability state is `ready`. |
| UI | Shows Codex as explainable optional capability, not as an ordinary failed chat backend. |
| API | Returns structured readiness and switch errors without exposing secrets or full sensitive paths. |

## Capability State

`GET /api/v1/codex/status` returns a redacted capability state.

```json
{
  "enabled": true,
  "state": "ready",
  "build": {
    "status": "success",
    "lastCheckedAt": "2026-06-28T00:00:00.000Z",
    "error": null
  },
  "canSwitchToCodex": true,
  "message": "Codex backend is ready."
}
```

Supported states:

| State | User Meaning | Switch Allowed |
|---|---|---|
| `disabled` | Codex is disabled by `SGA_ENABLE_CODEX=false`. | No |
| `unavailable` | No compatible Codex source or binary is available. | No |
| `source-present` | Vendored source exists but no binary is ready. | No |
| `building` | A background build is running. | No |
| `ready` | A compatible `codex-app-server` binary is available. | Yes |
| `failed` | Detection or build failed. | No |

Switch errors use these codes:

- `CODEX_DISABLED`
- `CODEX_NOT_READY`
- `CODEX_BUILD_FAILED`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SGA_ENABLE_CODEX` | `auto` | `auto`, `true`, or `false`. Controls whether Codex can appear as a backend capability. |
| `CODEX_BINARY` | unset | Optional explicit path to a compatible `codex-app-server` binary. |
| `CODEX_SKIP_BUILD` | unset | When `1`, skip automatic background build attempts. |

The preferred binary path is:

```text
sga_template/codex-rs/target/release/codex-app-server(.exe)
```

The official OpenAI Codex CLI binary is not a supported replacement for this integration because the backend expects the vendored app-server behavior and Comfy Workflow Agent identity integration.

## Handoff Behavior

Agent switching writes an audit record through the handoff store. The audit record contains counts and status only:

- source agent and target agent;
- exported message count;
- key fact count;
- import result;
- warning and error summaries;
- switch timestamp.

It does not store complete sensitive message bodies. Handoff status is exposed through:

```text
GET /api/v1/sessions/:sessionId/handoff/status
```

Example:

```json
{
  "sessionId": "abc",
  "activeAgent": "sga",
  "lastSwitchAt": "2026-06-28T00:00:00.000Z",
  "pendingHandoff": false,
  "lastExport": { "ok": true, "messageCount": 12, "keyFactCount": 4 },
  "lastImport": { "ok": true, "targetAgent": "codex" },
  "warnings": [],
  "errors": []
}
```

## Completion Matrix

Only code-backed, locally verifiable items are marked as complete.

| Area | Status | Evidence |
|---|---|---|
| `AgentBackend` abstraction | Complete | `sga_template/src/agents/backend.ts` |
| SGA backend wrapper | Complete | `sga_template/src/agents/sga-backend.ts` |
| Codex backend wrapper | Experimental | `sga_template/src/agents/codex-backend.ts`; depends on compatible binary. |
| Codex capability status API | Complete | `GET /api/v1/codex/status`, `codex-status.ts` |
| Structured Codex switch errors | Complete | Stable switch handler returns readiness codes. |
| Non-blocking SGA startup when Codex missing | Complete | Codex readiness checked separately from SGA startup. |
| Provider sharing | Implemented / needs broader tests | Existing provider config is passed into backend startup. |
| Event bridge | Implemented / tested at unit level where available | `agents/codex/event-bridge.ts` and tests added for baseline behavior. |
| Handoff bundle store | Complete | `agents/handoff/store.ts` |
| Handoff audit/status API | Complete | `GET /api/v1/sessions/:sessionId/handoff/status` |
| UI Codex readiness display | Complete | `ChatPanel`, `App`, and config service integration. |
| UI system diagnostics | Complete | `SystemDiagnosticsPanel.tsx` |
| Codex MCP workflow tools | Partial / experimental | Existing MCP pieces remain, but full domain workflow validation is future work. |
| Production-grade Codex domain skills | Pending | Planned under workflow domain capability work. |
| Real provider E2E coverage | Pending | Automated tests avoid real keys/network by default. |

## Verification

Backend checks:

```bash
cd sga_template
npm run typecheck
npm test
```

Frontend checks:

```bash
cd ui
npm run typecheck
npm run lint
npm run build
```

These checks should not require a real Codex binary, network access, or external API keys.
