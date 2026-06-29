# ComfyUI Computer Use Capability Design Spec

> **Status:** Draft for review
> **Date:** 2026-06-29
> **Author:** SGA team (brainstormed with user)
> **Branch plan:** `feat/computer-use` (stacked on current `main`)

## Goal

Add an opt-in "Computer Use" capability to the SGA backend that lets a multimodal-model-driven agent directly operate ComfyUI — both the canvas (workflow editing, queue, sidebar) and the surrounding UI (third-party custom node dialogs, Manager, settings) — through a dedicated browser session controlled by Playwright, complemented by a high-efficiency JS extension path for direct canvas manipulation.

This is a **complement** to the existing ComfyUI HTTP API / MCP tooling, not a replacement. Computer use covers the API blind spots (visual diagnostics, third-party UI dialogs, interactive canvas arrangement); structured workflow operations continue to use `comfyui-api` and `workflow_action`.

## Scope

### In scope

- **A — Visual diagnostics feedback loop**: agent screenshots the ComfyUI canvas, multimodal model detects visual issues (red error nodes, broken links, layout problems, rendering result verification). Read-only visually; actions still go through API/MCP.
- **B — Fill API gaps**: agent handles UI interactions that have no HTTP API — third-party custom node popups (model browsers, image pickers, reconnect dialogs), settings panel changes, interactive canvas layout/arrangement. Requires coordinate-based clicks and typing.
- **C — Full canvas automation**: agent can do everything a user can — add/remove/move nodes, draw/break connections, adjust widgets, run queue — via direct LiteGraph API access through a JS extension (more efficient than coordinate-based clicks).

### Out of scope

- **D — Cross-application orchestration**: operating other local AI tools (A1111 WebUI, image editors) beyond ComfyUI. Requires OS-level computer use (Anthropic Claude Computer Use / OpenAI CUA on the full desktop). Explicitly deferred; the architecture must not preclude it as a future extension.
- **Modifying the ComfyUI frontend source**: the vendored `ComfyUI_frontend-main/` is a read-only reference copy for understanding structure and APIs. The running ComfyUI frontend is a compiled artifact. Our JS extension must be delivered as part of the `comfy_workflow_agent` custom_node (via ComfyUI's `WEB_DIRECTORY` mechanism), not by patching frontend source.
- **Codex backend support**: the vendored `codex-app-server` (Rust) has no computer use capability. This feature is SGA-only.

## Architecture

### Overview

A new `sga_template/src/computer-use/` module adds four cooperating units:

```
┌─────────────────────────────────────────────────────────────┐
│  SGA Backend (Node.js)                                      │
│                                                             │
│  ┌─────────────────┐   ┌──────────────────┐                │
│  │   Orchestrator  │──▶│ Action Executor  │                │
│  │  (session, loop) │   │  (route actions) │                │
│  └────────┬────────┘   └────┬─────────┬───┘                │
│           │                 │         │                     │
│           │                 ▼         ▼                     │
│           │       ┌──────────┐  ┌──────────────┐           │
│           │       │Playwright│  │ JS Extension │           │
│           │       │  Driver  │  │  WS Client   │           │
│           │       │  (A,B)   │  │     (C)      │           │
│           │       └────┬─────┘  └──────┬───────┘           │
│           │            │               │                    │
│  ┌────────▼─────┐      │               │                    │
│  │   Provider   │      │               │                    │
│  │  Adapters    │      │               │                    │
│  │  (multimodal)│      │               │                    │
│  └──────────────┘      │               │                    │
└────────────────────────┼───────────────┼────────────────────┘
                         │               │
            ┌────────────▼─────┐   ┌──────▼──────────────────┐
            │ Dedicated        │   │ ComfyUI browser          │
            │ Playwright       │   │ (any visitor, incl. the  │
            │ Chromium (A,B)   │   │ dedicated one) running   │
            │                  │   │ the JS extension (C)     │
            │ → http://         │   │                          │
            │   127.0.0.1:8188  │   │ ← window.app + LiteGraph │
            └──────────────────┘   └──────────────────────────┘
```

### Components

#### a) Orchestrator (`computer-use/orchestrator.ts`)

**Responsibility:** Session lifecycle + action loop.

- On `start` signal (user opt-in via UI toggle): launches a Playwright Chromium instance with `--headless=false` (visible window so the user can observe agent actions), navigates to `http://127.0.0.1:8188`, waits for the ComfyUI frontend to signal readiness (JS extension loaded), and registers the `computer_use` tool into the agent tool pool.
- Runs the "screenshot → multimodal model → action → screenshot" loop on each agent invocation.
- On `stop` (user toggle off, SGA shutdown, or session timeout): closes the browser, unregisters the tool, cleans up.
- Exposes HTTP routes under `/api/v1/computer-use/` for the React UI: `start`, `status`, `stop`, `screenshot`, `act`. The agent accesses the same capability through the `computer_use` built-in tool.

**Out of scope:** Does not own the multimodal model itself — that's the Provider Adapter's job. The orchestrator hands screenshots and receives actions from the active provider adapter.

#### b) Action Executor (`computer-use/action-executor.ts`)

**Responsibility:** Route model-returned actions to the right execution path.

Receives a normalized `ComputerUseAction` (union type covering `screenshot`, `click{x,y}`, `type{text}`, `scroll{dx,dy}`, `drag{from,to}`, `key{combo}`, `wait`, plus canvas-specific `addNode{type,x,y}`, `removeNode{id}`, `connect{fromId,fromSlot,toId,toSlot}`, `disconnect{linkId}`, `setWidget{nodeId,widgetName,value}`, `getCanvasState`, `runQueue{prompt}`) and dispatches:

- **Visual/UI actions** (`screenshot`, `click`, `type`, `scroll`, `drag`, `key`, `wait`) → Playwright driver (operates the dedicated browser)
- **Canvas actions** (`addNode`, `removeNode`, `connect`, `disconnect`, `setWidget`, `getCanvasState`, `runQueue`) → JS extension HTTP client (direct LiteGraph API, no coordinates, no screenshots needed)

Each action records an audit log entry (screenshot before/after, action payload, model reasoning summary) into the existing handoff audit trail.

#### c) JS Extension (`web/computer-use-extension.js`)

**Responsibility:** Browser-side canvas API bridge.

- Shipped as part of the `comfy_workflow_agent` custom_node (declared via `WEB_DIRECTORY` in `__init__.py`); ComfyUI auto-loads it into every browser that visits ComfyUI — both the user's main browser and the SGA-launched dedicated browser.
- On load, connects via WebSocket to `ws://127.0.0.1:8000/api/v1/computer-use/ws` (the SGA backend). The WS is the control channel: SGA pushes canvas-op commands, extension responds with results.
- **WebSocket over HTTP polling:** chose WS because (a) SGA backend cannot directly call into a browser tab without a long-lived connection, (b) ComfyUI custom_nodes cannot register server-side HTTP routes that proxy into the browser, and (c) WS gives low-latency bidirectional flow needed for canvas ops. Fallback to HTTP polling is a non-goal; if WS is unavailable, the orchestrator reports the extension as not-ready and degrades to Playwright-only mode (B+C unavailable).
- Exposes (via the WS protocol): `addNode(type, x?, y?)`, `removeNode(nodeId)`, `connectNodes(fromId, fromSlot, toId, toSlot)`, `disconnect(linkId)`, `setWidgetValue(nodeId, widgetName, value)`, `getCanvasState()` (returns serialized graph), `runQueue(promptInput)`, `screenshotCanvas()` (returns base64 PNG of the canvas viewport).
- Implementation uses `window.app` (set by ComfyUI at `GraphCanvas.vue:533`) and the LiteGraph API (`LGraph`, `LGraphNode`). Reads the ComfyUI frontend reference source under `ComfyUI_frontend-main/` as the authoritative API reference; does not modify it.

#### d) Provider Adapters (`computer-use/providers/{anthropic,openai,generic}.ts`)

**Responsibility:** Translate between the orchestrator's normalized `ComputerUseAction` format and each provider's native computer use API.

- **`anthropic.ts`** — Claude Computer Use. Uses the `computer_20241022` tool type on the Messages API with the `anthropic-beta: computer-use-2024-10-22` header. Sends a base64 PNG screenshot as an image content block, receives `tool_use` blocks with `action` + coordinates. Action set: `screenshot`, `left_click`, `right_click`, `double_click`, `triple_click`, `left_click_drag`, `type`, `key`, `hold_key`, `scroll`, `mouse_move`, `cursor_position`, `wait`.
- **`openai.ts`** — OpenAI CUA. Uses the Responses API with `tools: [{type: "computer_use_preview", ...}]`. Receives `computer_call` output items with `click`, `type`, `keypress`, `scroll`, `move`, `wait`, `drag` actions.
- **`generic.ts`** — Fallback for providers without native computer use (Gemini, GLM, DeepSeek, etc.). Sends a screenshot + a structured prompt instructing the model to return a JSON action object matching the normalized `ComputerUseAction` union. Parses the model's text response into an action. Known limitations: format instability, coordinate drift, hallucinated element references — the executor validates every parsed action against the union schema before dispatching.

The orchestrator selects the active adapter based on the configured multimodal provider. The `generic` adapter is selected only when no native adapter matches and the provider advertises multimodal capability.

### Trigger & Session Model

Computer use is **opt-in at session level**, never automatic:

1. User starts ComfyUI normally (their own browser session, usual workflow editing).
2. User opens the SGA chat panel inside ComfyUI.
3. User clicks the "Computer Use" toggle button (in the chat panel header, alongside Provider switch and Codex/SGA switch).
4. SGA backend receives the `start` signal:
   - Verifies the configured provider supports computer use (Anthropic / OpenAI → native; otherwise → generic fallback, with a one-time UI warning about reduced reliability).
   - Launches a dedicated Playwright Chromium (visible window, separate from the user's main browser).
   - Navigates to the ComfyUI URL, waits for the JS extension to signal ready via WS.
   - Registers `computer_use` as a built-in tool in the agent tool pool.
5. The agent can now call `computer_use` in its reasoning loop. It composes naturally with existing tools — the agent decides per-task whether to use API/MCP (structured), `workflow_action` (JSON manipulation), or `computer_use` (visual / UI interaction).
6. User toggles off, or closes the chat panel, or SGA shuts down → orchestrator closes the browser, unregisters the tool, session ends.

**Why dedicated browser (not the user's main browser):**
- Avoids conflicts with the user's manual operations (no two actors driving the same DOM).
- Lets SGA fully control timing, screenshot cadence, and tab focus.
- The JS extension still loads in the user's main browser too, so canvas ops via the WS channel work in both — but the orchestrator only attaches Playwright to the dedicated instance.

**Why a visible browser window (not headless):**
- The user can observe what the agent is doing, which is essential for trust and for the "破坏性操作显式确认" safety tier.
- If the user wants background-only mode, a future `--headless=true` flag can be added; not in the initial scope.

## Phasing & Deliverables

The feature is delivered in five phases. Each phase produces a self-contained, testable increment.

### Phase 0 — Foundation

**Goal:** Wire up the infrastructure; no useful capability yet, but the session loop runs.

- `sga_template/src/computer-use/orchestrator.ts` — session lifecycle, Playwright launch/stop, `/api/v1/computer-use/{start,status,stop}` routes
- `sga_template/src/computer-use/providers/anthropic.ts` — Claude Computer Use adapter (screenshot → `tool_use` action round-trip)
- `sga_template/src/computer-use/action-executor.ts` — only `screenshot` action implemented; other actions throw `NotImplementedError`
- `sga_template/src/tools/built-in/computer-use.ts` — tool skeleton that calls orchestrator
- `ui/src/components/ComputerUseToggle.tsx` — React UI toggle button + status indicator
- Tests: unit tests for orchestrator lifecycle, Anthropic adapter action parsing; integration test that launches Playwright against a mock ComfyUI page and round-trips one screenshot.

**Exit criteria:** User can toggle computer use on, see the dedicated browser open, see the tool register; toggling off closes the browser.

### Phase 1 — A: Visual diagnostics (read-only)

**Goal:** Agent can see ComfyUI and report visual findings.

- Implement `screenshot` action fully (full-page and canvas-viewport variants).
- Extend `computer-use.ts` tool with a `analyze_canvas` sub-command that sends the screenshot to the multimodal model with a prompt tuned for issue detection (red error nodes, disconnected links, layout problems, queue state, last render result).
- Integrate findings into the existing issues stream (alongside `WorkflowIssue[]` from validators). Visual issues use a new `source: 'visual'` (vs. `'native'`).
- Tests: fixture-based visual analysis tests (synthetic ComfyUI screenshots with known issues).

**Exit criteria:** Agent can answer "what's wrong with my current workflow visually?" by screenshotting and analyzing.

### Phase 2 — C: Canvas automation via JS extension

**Goal:** Agent can manipulate the workflow graph directly (high-efficiency path).

- `web/computer-use-extension.js` — the browser-side extension with WS client and LiteGraph API bridge.
- WS protocol spec (`docs/superpowers/specs/computer-use-ws-protocol.md`): message envelope, canvas op request/response, error codes.
- `action-executor.ts` canvas actions: `addNode`, `removeNode`, `connect`, `disconnect`, `setWidget`, `getCanvasState`, `runQueue`.
- `providers/openai.ts` — OpenAI CUA adapter (native computer use for UI actions).
- Tests: extension unit tests (mock `window.app` + LiteGraph), WS protocol tests, end-to-end canvas op tests against a running ComfyUI instance.

**Exit criteria:** Agent can perform "add a KSampler node, connect it to the existing CheckpointLoader, set seed to 42, run queue" via canvas actions, no Playwright clicks needed.

### Phase 3 — B: Dialog & UI interaction via Playwright

**Goal:** Agent can handle UI elements that have no API (third-party custom node popups, settings panel).

- Implement `click`, `type`, `scroll`, `drag`, `key`, `wait` actions in `action-executor.ts` via Playwright.
- `providers/generic.ts` — fallback adapter for non-Anthropic/OpenAI providers.
- Dialog handling flow: detect modal/popup presence (via screenshot + model analysis or Playwright's auto-wait), interact, dismiss, verify outcome.
- Safety confirmation UI: when a destructive action is about to execute, the React UI shows a confirmation dialog with the proposed action and a screenshot preview.
- Tests: Playwright interaction tests against a test ComfyUI instance with known dialogs; generic provider adapter tests with mock multimodal responses.

**Exit criteria:** Agent can handle "open Manager, install custom node X, dismiss the success dialog" or "open settings, change theme to dark" via UI clicks.

### Phase 4 — Polish: safety, observability, hardening

**Goal:** Production-ready.

- Permission tiers (see Safety section below) fully wired to the existing Permission System.
- Cost tracker integration: each screenshot round + model call recorded as a cost entry (existing `CostTracker`).
- Audit log: every action with before/after screenshots, action payload, model reasoning summary, persisted to `<SGA_HOME>/audit/computer-use/<session-id>.jsonl`.
- Circuit breaker: if N consecutive actions fail or the model loops without progress, auto-pause and surface to user.
- Telemetry: usage metrics (sessions started, actions executed, model calls, errors).

**Exit criteria:** Computer use is safe to leave running; all costs and actions are auditable.

## Safety & Permissions

Three tiers, integrated with the existing Permission System (`SGA_CAPABILITY_PLAN.md` Bash classification mechanism):

| Tier | Examples | Behavior |
|---|---|---|
| **Read-only** | `screenshot`, `getCanvasState`, visual analysis | Auto-allowed; no user confirmation |
| **Mutating** | `click`, `type`, `setWidget`, `connect`, `addNode`, `removeNode`, `scroll`, `drag` | Goes through the existing permission check (same tier as `workflow_action`); user can pre-approve per-session or be prompted |
| **Destructive** | `runQueue` (submits prompt execution), install/remove custom nodes via Manager, change system settings | Always prompts user with a confirmation dialog showing the proposed action + screenshot preview; never auto-executed |

Additional safeguards:

- **Session isolation:** the dedicated Playwright browser has no access to the user's main browser session state (cookies, localStorage, etc.) beyond what ComfyUI itself sets on first visit. The user's main browser is untouched.
- **No credential input:** the agent must never type passwords, API keys, or other credentials. If a dialog requests credentials, the agent surfaces it to the user for manual input (the `human_interaction` tool already supports this pattern).
- **Prompt-injection awareness:** screenshots may contain attacker-controlled content (e.g., a malicious workflow image with prompt-injection text). The orchestrator sanitizes by wrapping model reasoning in a tool-use frame, never as raw instructions. Documented limitation: full mitigation requires OS-level isolation (a VM/container), which is out of scope for the initial release and noted as a future hardening item.
- **Audit trail:** every action is logged with before/after screenshots and the model's reasoning summary. The user can review the audit log after the session.

## Alignment with Existing Architecture

- **Provider adapters:** reuses `src/providers/` abstractions. The new computer-use-specific methods are added as optional capabilities on the existing provider interface; providers that don't support computer use return a clear error.
- **Tool pool:** `computer_use` is a new built-in tool under `src/tools/built-in/`, following the same registration pattern as `comfyui-api`, `workflow-action`, etc.
- **MCP:** computer use is SGA-native, not exposed via MCP. The existing `comfyui-api` MCP server (7 tools) and ComfyUI's native `/mcp` endpoint are unchanged. Computer use is a separate capability that complements MCP, not a replacement.
- **React UI:** adds a `ComputerUseToggle` component in the chat panel header, plus an optional "agent action replay" view that shows the audit log entries with screenshots.
- **Permission System:** reuses the existing tier mechanism. The new tool's actions declare their tier; the existing permission check enforces it.
- **Codex backend:** unchanged. The vendored `codex-app-server` has no computer use capability; this feature is SGA-only. The Codex/SGA switch in the UI continues to route to whichever backend is active.
- **Validation engine:** the recently-merged graph-walker validators (`feat/validation-engine-graph-walker` branch) continue to provide structured issue detection. Visual diagnostics (Phase 1) is a complementary signal — same `WorkflowIssue` shape, different `source` (`'visual'` vs `'native'`).

## Non-Goals

- **Replacing existing API/MCP tools for structured operations.** Adding nodes, connecting, validating — all stay on `workflow_action` / `comfyui-api` / MCP. Computer use is for when those don't cover the case.
- **OS-level desktop automation.** Only the ComfyUI browser tab is in scope. General desktop control (other apps, file managers, image editors) is explicitly Phase D / future.
- **Modifying the ComfyUI frontend source.** The vendored `ComfyUI_frontend-main/` is reference-only. All browser-side code we ship goes through the custom_node `WEB_DIRECTORY` mechanism.
- **Automated GUI testing of ComfyUI itself.** While the capability could be used for that, it's not a design goal. GUI testing is a separate concern with different tooling (Playwright test runner, fixtures).
- **Always-on operation.** Computer use is opt-in per session. The agent never auto-starts it.

## Open Questions (for review)

1. **WS vs. ComfyUI custom route for JS extension RPC** — this spec picks WebSocket. Alternative: register a Python-side route in `comfy_workflow_agent`'s `__init__.py` via `@PromptServer.instance.routes.post("/computer-use/canvas-op")` that pushes to a queue the extension polls. Less efficient (polling) but no WS lifecycle to manage. Decision needed: is WS complexity acceptable, or prefer HTTP polling?

2. **Dedicated browser visibility** — this spec defaults to `--headless=false` (visible window). Should we instead default to headless and only show a "what's the agent doing" view inside the SGA chat panel (rendering the screenshots the agent takes)? This would avoid a second visible window but loses the "watch the agent work live" experience.

3. **Generic provider action validation** — when `generic.ts` parses a model's text response into a `ComputerUseAction`, how strict should validation be? Reject unknown action types? Reject out-of-canvas coordinates? Or accept-and-best-effort-execute with audit logging?

4. **Phase ordering** — current order is P0 (foundation) → P1 (visual, read-only) → P2 (canvas via JS) → P3 (UI via Playwright) → P4 (polish). Alternative: P0 → P2 (canvas first, since JS extension is the highest-value and most efficient path) → P1 → P3. Which delivers user value sooner?

## References

- Anthropic Computer Use: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool
- OpenAI CUA: https://platform.openai.com/docs/guides/tools-computer-use
- ComfyUI frontend reference source: `ComfyUI_frontend-main/ComfyUI_frontend-main/` (read-only)
- ComfyUI extension docs: `ComfyUI_frontend-main/ComfyUI_frontend-main/docs/extensions/README.md`
- Existing project docs: `docs/workflow-domain-capability-plan.md`, `SGA_CAPABILITY_PLAN.md`, `docs/codex-agent-integration.md`
- Recent merged work: `feat/validation-engine-graph-walker` branch (graph-walker validators, provides `WorkflowIssue` shape reused by Phase 1 visual diagnostics)
