# ComfyUI Computer Use — Autopilot (代驾) Design

> **Status:** Approved design for the "副驾驶 → 代驾" upgrade.
> **Builds on:** `2026-06-29-comfyui-computer-use-design.md` (Phase 0+1, approved & implemented).
> **Branch:** `feat/computer-use-autopilot`

## 1. Goal

Upgrade the Computer Use capability from **copilot mode** (agent occasionally calls `computer_use` as one of many tools) to **autopilot mode** (agent enters a tight screenshot → model-decision → execute → feedback loop driven by a single goal).

**User experience:** The user types a goal in the chat (e.g. "把 KSampler 的 seed 设为 42 并跑队列"). The agent calls `computer_use({ action: 'run_goal', goal: '...' })`. The orchestrator enters an autonomous loop, streaming real-time step events (screenshot + action + result) to the frontend. The loop terminates when the model signals `done`, when `maxSteps` is exhausted, or when the user stops it.

## 2. Scope

### In scope (MVP)

- **Autonomous loop** in orchestrator: `runGoal(goal, opts)` returning `AsyncIterable<StepEvent>`
- **Provider adapter integration**: wire existing Anthropic + OpenAI adapters into the loop; add `interpretActionResult()` to both
- **3 visual actions**: implement `click`, `type`, `wait` in `action-executor.ts` (the other 3 — `scroll`, `drag`, `key` — remain stubs)
- **New action types**: `run_goal` (trigger), `done` (model signals completion), `require_approval` (model requests human input)
- **SSE streaming**: new endpoint `/api/v1/computer-use/run-events` pushes `StepEvent`s to the frontend in real time
- **Minimal safety net**: `maxSteps` (default 20, hard cap 50), consecutive-failure breaker (3 strikes), user-stop support, `require_approval` pause
- **Frontend step flow**: real-time display of steps (screenshot thumbnail + action + result) with stop button

### Out of scope (deferred to later phases)

- Phase 2 visual diagnostics (`analyze_canvas`, `WorkflowIssue` with `source:'visual'`)
- `scroll` / `drag` / `key` visual actions (keep stubs; loop will return error for these)
- Generic adapter (non-Anthropic/OpenAI providers)
- Destructive operation confirmation dialog UI (only `require_approval` pause)
- CostTracker, audit jsonl, circuit breaker with backoff, telemetry
- Multi-session concurrent autopilot (single session only)

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ChatPanel (React)                                          │
│  ├─ ComputerUseToggle (existing)                           │
│  └─ AutopilotStepFlow (new) ← SSE EventSource             │
└────────────────────────┬────────────────────────────────────┘
                         │ 1. user types goal
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Loop (agent.ts, existing)                           │
│  └─ computer_use({ action:'run_goal', goal:'...' })       │
└────────────────────────┬────────────────────────────────────┘
                         │ 2. tool.call()
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  ComputerUseTool.call()                                    │
│  └─ orchestrator.runGoal(goal, { adapter })                │
│     │                                                       │
│     │ 3. while not done and steps < maxSteps:              │
│     │    ├─ screenshot = takeScreenshot()                  │
│     │    ├─ action = adapter.sendScreenshotAndGetCurrent() │
│     │    ├─ result = executeAction(action)                 │
│     │    ├─ feedback = adapter.interpretActionResult()     │
│     │    └─ yield StepEvent                                │
│     │                                                       │
│     │ 4. SSE endpoint forwards StepEvents to frontend     │
│     └─ returns final summary                              │
└─────────────────────────────────────────────────────────────┘
```

## 4. New Action Types (types.ts)

```typescript
/** Trigger autopilot loop. Input to computer_use tool. */
export interface RunGoalAction {
  type: 'run_goal'
  goal: string
  maxSteps?: number  // override default (20), capped at 50
}

/** Model signals goal is complete. Returned by provider adapter. */
export interface DoneAction {
  type: 'done'
  summary: string  // human-readable completion summary
}

/** Model requests human approval before proceeding. */
export interface RequireApprovalAction {
  type: 'require_approval'
  question: string  // what the model is asking
}
```

Add `RunGoalAction` to the `ComputerUseAction` union (it's a tool-input action, not a model-output action). `DoneAction` and `RequireApprovalAction` are model-output actions — they terminate or pause the loop and are not dispatched to Playwright or the canvas bridge.

The `isCanvasAction()` and `isVisualAction()` helpers return `false` for all three new types. A new `isTerminalAction(action)` helper returns `true` for `done` and `require_approval`.

## 5. Orchestrator: `runGoal()` Method

```typescript
export interface StepEvent {
  step: number
  type: 'step_start' | 'screenshot_taken' | 'action_decided'
      | 'action_executed' | 'step_done' | 'loop_done'
      | 'error' | 'approval_required' | 'stopped'
  action?: ComputerUseAction
  result?: ComputerUseResult
  screenshot?: string  // base64, for screenshot_taken events
  summary?: string     // for loop_done
  error?: string       // for error/stopped events
  question?: string    // for approval_required
  timestamp: number
}

export interface ComputerUseAdapter {
  name: string
  sendScreenshotAndGetCurrentAction(
    screenshotBase64: string,
    instructions: string,
    history?: string,  // accumulated feedback from prior steps
  ): Promise<ComputerUseAction>
  interpretActionResult(result: ComputerUseResult): string
}

async *runGoal(
  goal: string,
  opts: { adapter: ComputerUseAdapter; maxSteps?: number },
): AsyncIterable<StepEvent>
```

### Loop logic

1. Validate state is `ready`; if not, throw
2. Set state to `running` (new session state — add to `ComputerUseSessionState`)
3. Initialize `history = ''`, `consecutiveFailures = 0`, `step = 0`
4. While `step < maxSteps`:
   a. Take screenshot → yield `screenshot_taken`
   b. Call `adapter.sendScreenshotAndGetCurrentAction(screenshot, goal, history)` → yield `action_decided`
   c. If action is `done` → yield `loop_done` with summary, break
   d. If action is `require_approval` → yield `approval_required`, pause (await external resume or timeout)
   e. If action is `run_goal` → reject (nested loops not allowed), yield `error`
   f. Execute action via `executeAction(action)` → yield `action_executed` with result
   g. If result failed → `consecutiveFailures++`; if `consecutiveFailures >= 3` → yield `error`, break
   h. If result succeeded → `consecutiveFailures = 0`
   i. Append `adapter.interpretActionResult(result)` to `history`
   j. `step++`
5. If loop exited due to `maxSteps` → yield `loop_done` with "Max steps reached" summary
6. Set state back to `ready`
7. On user cancel (checked between steps) → yield `stopped`, break

### State transitions

- `ready` → `running` (on `runGoal` start)
- `running` → `ready` (on loop completion / cancel)
- `running` → `error` (on unrecoverable error)

The `running` state prevents concurrent `runGoal` invocations and blocks `start()`/`stop()` until the loop finishes. `stop()` during `running` sets a cancel flag checked between steps.

## 6. Provider Adapter: `interpretActionResult()`

Both Anthropic and OpenAI adapters gain this method. It converts a `ComputerUseResult` into a short text string for the model's next-turn context.

```typescript
interpretActionResult(result: ComputerUseResult): string {
  if (result.success) {
    if (result.screenshot) return `Screenshot captured (${result.screenshot.length} bytes base64)`
    if (result.data) return `Action succeeded. Response: ${JSON.stringify(result.data).slice(0, 500)}`
    return 'Action succeeded'
  }
  return `Action failed: ${result.error ?? 'unknown error'}`
}
```

Both adapters use the same implementation (the feedback format is provider-agnostic). The method lives on the adapter interface so provider-specific formatting can diverge later.

## 7. Visual Action Implementation (action-executor.ts)

Replace 3 stubs in `executeVisualAction()`:

```typescript
case 'click': {
  if (action.button === 'right') {
    await page.mouse.click(action.x, action.y, { button: 'right' })
  } else if (action.button === 'middle') {
    await page.mouse.click(action.x, action.y, { button: 'middle' })
  } else {
    await page.mouse.click(action.x, action.y, { button: 'left' })
  }
  return { success: true, action }
}

case 'type': {
  await page.keyboard.type(action.text)
  return { success: true, action }
}

case 'wait': {
  await page.waitForTimeout(action.ms)
  return { success: true, action }
}
```

`scroll`, `drag`, `key` remain stubs — the loop will yield `action_executed` with `success: false` and `error: "not implemented"`, and the consecutive-failure breaker handles it.

## 8. SSE Streaming

### New endpoint: `GET /api/v1/computer-use/run-events`

Returns `text/event-stream`. The endpoint holds the response open and writes `StepEvent`s as SSE `data:` lines as they arrive from `runGoal()`.

```typescript
export async function handleComputerUseRunEvents(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // Get current run's event stream (set by runGoal trigger)
  const eventStream = getComputerUseRunEventStream()
  if (!eventStream) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'No active run' })}\n\n`)
    res.end()
    return
  }

  for await (const event of eventStream) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (event.type === 'loop_done' || event.type === 'stopped' || event.type === 'error') {
      break
    }
  }
  res.end()
}
```

### Run trigger coordination

The `computer_use` tool's `call()` starts `runGoal()` and stores the `AsyncIterable` in a module-level variable (`currentRunEventStream`). The SSE handler reads from this variable. This is a single-session design — only one autopilot run at a time.

### Frontend

New React hook `useComputerUseRunEvents()`:
- Opens `EventSource` to `/api/v1/computer-use/run-events`
- Accumulates `StepEvent[]` in state
- Returns `{ steps, isActive, stop }`

`AutopilotStepFlow` component renders the step list:
- Each step: screenshot thumbnail (click to enlarge) + action type + result status
- Live-updates as new SSE events arrive
- Stop button calls existing `stopComputerUse()` API

## 9. ComputerUseTool Changes

The tool's input schema gains a `run_goal` action:

```typescript
// In buildAction():
case 'run_goal': {
  if (!input.goal) throw new Error('run_goal requires a "goal" field')
  return {
    type: 'run_goal',
    goal: input.goal,
    maxSteps: input.maxSteps,
  }
}
```

The `call()` method:
1. If action is `run_goal`, get the orchestrator and active adapter
2. Call `orchestrator.runGoal(action.goal, { adapter, maxSteps: action.maxSteps })`
3. Iterate the `AsyncIterable`, storing it in `currentRunEventStream` for SSE
4. Accumulate step count and final summary
5. Return the summary as the tool result

## 10. Provider Selection

In `handleComputerUseStart` (routes.ts), after orchestrator start, select the adapter based on the configured LLM provider:

```typescript
const provider = config.llmProvider  // 'anthropic' | 'openai' | other
let adapter: ComputerUseAdapter | null = null
if (provider === 'anthropic') {
  adapter = new AnthropicComputerUseAdapter({ apiKey: config.anthropicApiKey, model: 'claude-3-5-sonnet-20241022' })
} else if (provider === 'openai') {
  adapter = new OpenAIComputerUseAdapter({ apiKey: config.openaiApiKey, model: 'computer-use-preview' })
}
if (adapter) orchestrator.setActiveAdapter(adapter)
```

The orchestrator gains a `setActiveAdapter(adapter)` method. `runGoal()` uses `this.activeAdapter`.

## 11. Safety Net (Minimal)

| Mechanism | Implementation |
|-----------|----------------|
| `maxSteps` | Default 20, hard cap 50. Configurable per `run_goal` action. |
| Consecutive failure breaker | After 3 consecutive `success: false` results, loop yields `error` and terminates. |
| User cancel | `stop()` sets `cancelRequested = true`. Loop checks between steps. |
| `require_approval` | Model can emit this to pause. Loop awaits resume (timeout 60s, then auto-stop). MVP: resume via `POST /api/v1/computer-use/approve` with `approved: boolean`. |
| Nested loop guard | `run_goal` action inside a running loop → immediate `error` yield. |
| State guard | `runGoal()` throws if state is not `ready`. `start()`/`stop()` throw if state is `running`. |

## 12. Testing Strategy

### Unit tests (Vitest)

- `orchestrator.test.ts`: `runGoal()` loop with mocked adapter — verify step count, termination on `done`, termination on `maxSteps`, consecutive failure breaker, cancel mid-loop
- `action-executor.test.ts`: `click`, `type`, `wait` with mocked Playwright `page`
- `providers/anthropic.test.ts`: `interpretActionResult()` returns correct feedback strings
- `providers/openai.test.ts`: `interpretActionResult()` returns correct feedback strings
- `types.test.ts` (new): `isTerminalAction()` helper

### Integration verification

- Manual: start session → trigger `run_goal` via chat → verify SSE events arrive → verify screenshots visible → stop mid-loop
- The existing 153 tests must still pass (no regressions)

## 13. File Changes Summary

### Files to create

| File | Responsibility |
|------|----------------|
| `ui/src/hooks/useComputerUseRunEvents.ts` | SSE EventSource hook for step events |
| `ui/src/components/AutopilotStepFlow.tsx` | Real-time step flow display component |

### Files to modify

| File | Change |
|------|--------|
| `sga_template/src/computer-use/types.ts` | Add `RunGoalAction`, `DoneAction`, `RequireApprovalAction`, `StepEvent`, `ComputerUseAdapter` interface, `isTerminalAction()` helper; add `'running'` to `ComputerUseSessionState` |
| `sga_template/src/computer-use/orchestrator.ts` | Add `runGoal()` async generator, `setActiveAdapter()`, `cancelRequested` flag, `'running'` state handling |
| `sga_template/src/computer-use/action-executor.ts` | Implement `click`, `type`, `wait` (replace 3 stubs) |
| `sga_template/src/computer-use/providers/anthropic.ts` | Add `interpretActionResult()` |
| `sga_template/src/computer-use/providers/openai.ts` | Add `interpretActionResult()` |
| `sga_template/src/tools/built-in/computer-use.ts` | Add `run_goal` action case, wire `runGoal()` call + SSE stream storage |
| `sga_template/src/server/routes.ts` | Add `handleComputerUseRunEvents` SSE handler, `handleComputerUseApprove` handler; add provider selection in `handleComputerUseStart` |
| `sga_template/src/server/app.ts` | Register SSE + approve routes |
| `ui/src/services/configService.ts` | Add `approveComputerUseAction()` API |
| `ui/src/components/ChatPanel.tsx` | Render `AutopilotStepFlow` when autopilot is active |
| `ui/src/App.tsx` | Wire autopilot state |

## 14. Open Questions

None. All key decisions resolved during brainstorming:
- Scope: minimal closed loop ✓
- Providers: Anthropic + OpenAI ✓
- Trigger: via chat (`run_goal` action) ✓
- Visibility: real-time SSE streaming ✓
