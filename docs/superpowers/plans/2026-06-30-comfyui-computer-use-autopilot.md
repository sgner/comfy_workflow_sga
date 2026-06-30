# ComfyUI Computer Use Autopilot (代驾) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an autonomous screenshot → model-decision → execute → feedback loop to the Computer Use capability, enabling "代驾" (autopilot) mode where the agent drives ComfyUI toward a user-specified goal.

**Architecture:** The orchestrator gains a `runGoal()` async generator that loops screenshot → adapter → execute → feedback, yielding `StepEvent`s. A new SSE endpoint streams events to the frontend. The `computer_use` tool gains a `run_goal` action that triggers the loop. Both Anthropic and OpenAI adapters gain `interpretActionResult()`.

**Tech Stack:** TypeScript 5.7, Express 4.21, Vitest 2.1, Playwright, React 18 + Vite 5, SSE (Server-Sent Events).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-30-comfyui-computer-use-autopilot-design.md` (approved, commit `f387415`)
- **Branch:** `feat/computer-use` (continue on existing branch)
- **Test framework:** Vitest (`sga_template/vitest.config.ts`); run via `cd sga_template && npm test`
- **Verify command (backend):** `cd sga_template && npm run verify` (typecheck + test)
- **Verify command (UI):** `cd ui && npm run verify` (typecheck + lint + build)
- **UI has no test framework** — typecheck + lint + build is the baseline; no UI unit tests
- **Existing tests must not regress** — 153/153 backend tests must continue to pass
- **Logger convention:** `createLogger('computer-use:<module>')` — keep existing colon-separated namespacing for consistency with Phase 0+1
- **Action union:** `ComputerUseAction` in `sga_template/src/computer-use/types.ts:228` — add new types to this union
- **Provider interface:** `ComputerUseAdapter` defined in this plan's Task 1, implemented by both adapters
- **SSE:** Standard `text/event-stream` with `data: <json>\n\n` framing

---

## File Structure

### Files to create

| File | Responsibility |
|------|----------------|
| `sga_template/src/computer-use/types.test.ts` | Unit tests for `isTerminalAction()` helper |
| `ui/src/hooks/useComputerUseRunEvents.ts` | SSE EventSource hook for autopilot step events |
| `ui/src/components/AutopilotStepFlow.tsx` | Real-time step flow display component |

### Files to modify

| File | Change |
|------|--------|
| `sga_template/src/computer-use/types.ts` | Add `RunGoalAction`, `DoneAction`, `RequireApprovalAction`, `StepEvent`, `ComputerUseAdapter` interface, `isTerminalAction()`; add `'running'` to `ComputerUseSessionState` |
| `sga_template/src/computer-use/action-executor.ts` | Implement `click`, `type`, `wait` (replace 3 stubs) |
| `sga_template/src/computer-use/providers/anthropic.ts` | Add `interpretActionResult()` |
| `sga_template/src/computer-use/providers/openai.ts` | Add `interpretActionResult()` |
| `sga_template/src/computer-use/providers/anthropic.test.ts` | Add `interpretActionResult` tests |
| `sga_template/src/computer-use/providers/openai.test.ts` | Add `interpretActionResult` tests |
| `sga_template/src/computer-use/orchestrator.ts` | Add `runGoal()` async generator, `setActiveAdapter()`, cancel flag, `'running'` state |
| `sga_template/src/computer-use/orchestrator.test.ts` | Add `runGoal()` tests with mocked adapter |
| `sga_template/src/tools/built-in/computer-use.ts` | Add `run_goal` action, wire `runGoal()` + event stream storage |
| `sga_template/src/server/routes.ts` | Add SSE handler, approve handler, provider selection |
| `sga_template/src/server/app.ts` | Register SSE + approve routes |
| `ui/src/services/configService.ts` | Add `approveComputerUseAction()` |
| `ui/src/components/ChatPanel.tsx` | Render `AutopilotStepFlow` when active |
| `ui/src/App.tsx` | Wire autopilot active state |

---

## Task 1: New types, StepEvent, ComputerUseAdapter interface, helpers

**Files:**
- Modify: `sga_template/src/computer-use/types.ts`
- Create: `sga_template/src/computer-use/types.test.ts`

**Interfaces:**
- Consumes: existing `ComputerUseResult`, `ComputerUseAction` union
- Produces: `RunGoalAction`, `DoneAction`, `RequireApprovalAction` (added to union), `StepEvent`, `ComputerUseAdapter`, `isTerminalAction()`, updated `ComputerUseSessionState` with `'running'`

- [ ] **Step 1: Write the failing test**

Create `sga_template/src/computer-use/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { isTerminalAction, isCanvasAction, isVisualAction } from './types.js'

describe('isTerminalAction', () => {
  it('returns true for done action', () => {
    expect(isTerminalAction({ type: 'done', summary: 'finished' })).toBe(true)
  })

  it('returns true for require_approval action', () => {
    expect(isTerminalAction({ type: 'require_approval', question: 'proceed?' })).toBe(true)
  })

  it('returns false for screenshot action', () => {
    expect(isTerminalAction({ type: 'screenshot' })).toBe(false)
  })

  it('returns false for click action', () => {
    expect(isTerminalAction({ type: 'click', x: 10, y: 20 })).toBe(false)
  })

  it('returns false for run_goal action', () => {
    expect(isTerminalAction({ type: 'run_goal', goal: 'test' })).toBe(false)
  })

  it('returns false for canvas actions', () => {
    expect(isTerminalAction({ type: 'addNode', nodeType: 'KSampler' })).toBe(false)
  })
})

describe('new action types routing', () => {
  it('run_goal is not canvas or visual', () => {
    const action = { type: 'run_goal', goal: 'test' }
    expect(isCanvasAction(action)).toBe(false)
    expect(isVisualAction(action)).toBe(false)
  })

  it('done is not canvas or visual', () => {
    const action = { type: 'done', summary: 'finished' }
    expect(isCanvasAction(action)).toBe(false)
    expect(isVisualAction(action)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/types.test.ts`
Expected: FAIL with "Failed to resolve import './types.js'" or "isTerminalAction is not a function"

- [ ] **Step 3: Add new types and helpers to types.ts**

Open `sga_template/src/computer-use/types.ts`. Make 4 changes:

**Change 1:** Add `'running'` to `ComputerUseSessionState` (around line 117):

```typescript
export type ComputerUseSessionState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'       // autopilot loop active
  | 'stopping'
  | 'stopped'
  | 'error'
```

**Change 2:** Add 3 new action interfaces after `RunQueueAction` (around line 225, before the union):

```typescript
// ── Autopilot actions ──

export interface RunGoalAction {
  type: 'run_goal'
  goal: string
  maxSteps?: number
}

export interface DoneAction {
  type: 'done'
  summary: string
}

export interface RequireApprovalAction {
  type: 'require_approval'
  question: string
}
```

**Change 3:** Add the 3 new types to the `ComputerUseAction` union (around line 228):

```typescript
export type ComputerUseAction =
  | ScreenshotAction
  | ClickAction
  | TypeAction
  | ScrollAction
  | DragAction
  | KeyAction
  | WaitAction
  | AddNodeAction
  | RemoveNodeAction
  | ConnectAction
  | DisconnectAction
  | SetWidgetAction
  | GetCanvasStateAction
  | RunQueueAction
  | RunGoalAction
  | DoneAction
  | RequireApprovalAction
```

**Change 4:** Add `isTerminalAction()` helper and `StepEvent` + `ComputerUseAdapter` interfaces at the end of the file (after `isVisualAction`):

```typescript
// ── Helper: is this a terminal action (ends or pauses the autopilot loop)? ──

const TERMINAL_ACTION_TYPES = new Set(['done', 'require_approval'])

export function isTerminalAction(action: ComputerUseAction): boolean {
  return TERMINAL_ACTION_TYPES.has(action.type)
}

// ── Autopilot loop types ──

export interface StepEvent {
  step: number
  type: 'step_start' | 'screenshot_taken' | 'action_decided'
      | 'action_executed' | 'step_done' | 'loop_done'
      | 'error' | 'approval_required' | 'stopped'
  action?: ComputerUseAction
  result?: ComputerUseResult
  screenshot?: string
  summary?: string
  error?: string
  question?: string
  timestamp: number
}

export interface ComputerUseAdapter {
  name: string
  sendScreenshotAndGetCurrentAction(
    screenshotBase64: string,
    instructions: string,
    history?: string,
  ): Promise<ComputerUseAction>
  interpretActionResult(result: ComputerUseResult): string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/types.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run full suite to verify no regressions**

Run: `cd sga_template && npm test`
Expected: 160/160 pass (153 existing + 7 new)

- [ ] **Step 6: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean (no errors)

- [ ] **Step 7: Commit**

```bash
cd sga_template
git add src/computer-use/types.ts src/computer-use/types.test.ts
git commit -m "feat(computer-use): add autopilot types, StepEvent, ComputerUseAdapter interface"
```

---

## Task 2: Implement click, type, wait visual actions

**Files:**
- Modify: `sga_template/src/computer-use/action-executor.ts`
- Modify: `sga_template/src/computer-use/action-executor.test.ts`

**Interfaces:**
- Consumes: `ComputerUseAction` union (click/type/wait variants), Playwright `Page`
- Produces: working `click`, `type`, `wait` cases in `executeVisualAction()`

- [ ] **Step 1: Write the failing tests**

Open `sga_template/src/computer-use/action-executor.test.ts`. Add 3 new tests after the existing "returns error for unimplemented visual action (click)" test:

```typescript
  it('executes click via Playwright mouse', async () => {
    const mockPage = {
      mouse: {
        click: vi.fn().mockResolvedValue(undefined),
      },
    } as any

    const result = await executor.executeVisualAction(
      { type: 'click', x: 150, y: 250, button: 'left' },
      mockPage,
    )

    expect(result.success).toBe(true)
    expect(result.action.type).toBe('click')
    expect(mockPage.mouse.click).toHaveBeenCalledWith(150, 250, { button: 'left' })
  })

  it('executes type via Playwright keyboard', async () => {
    const mockPage = {
      keyboard: {
        type: vi.fn().mockResolvedValue(undefined),
      },
    } as any

    const result = await executor.executeVisualAction(
      { type: 'type', text: 'hello world' },
      mockPage,
    )

    expect(result.success).toBe(true)
    expect(mockPage.keyboard.type).toHaveBeenCalledWith('hello world')
  })

  it('executes wait via Playwright waitForTimeout', async () => {
    const mockPage = {
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as any

    const result = await executor.executeVisualAction(
      { type: 'wait', ms: 500 },
      mockPage,
    )

    expect(result.success).toBe(true)
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(500)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sga_template && npx vitest run src/computer-use/action-executor.test.ts`
Expected: 3 new tests FAIL (current stubs return `{ success: false, error: 'not implemented' }`)

- [ ] **Step 3: Replace the 3 stubs with real implementations**

Open `sga_template/src/computer-use/action-executor.ts`. Replace the `click`, `type`, and `wait` cases in the `switch` block (around lines 28-39). The current stub block:

```typescript
      case 'click':
      case 'type':
      case 'scroll':
      case 'drag':
      case 'key':
      case 'wait':
        // Phase 3 — not implemented yet
        return {
          success: false,
          error: `Visual action "${action.type}" not implemented (Phase 3)`,
          action,
        }
```

Replace with:

```typescript
      case 'click': {
        const button = action.button ?? 'left'
        await page.mouse.click(action.x, action.y, { button })
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

      case 'scroll':
      case 'drag':
      case 'key':
        // Phase 3 — not implemented yet
        return {
          success: false,
          error: `Visual action "${action.type}" not implemented (Phase 3)`,
          action,
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sga_template && npx vitest run src/computer-use/action-executor.test.ts`
Expected: All tests PASS (existing 4 + new 3 = 7 tests)

- [ ] **Step 5: Run full suite**

Run: `cd sga_template && npm test`
Expected: 163/163 pass (160 + 3 new)

- [ ] **Step 6: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
cd sga_template
git add src/computer-use/action-executor.ts src/computer-use/action-executor.test.ts
git commit -m "feat(computer-use): implement click, type, wait visual actions"
```

---

## Task 3: Add interpretActionResult() to both provider adapters

**Files:**
- Modify: `sga_template/src/computer-use/providers/anthropic.ts`
- Modify: `sga_template/src/computer-use/providers/anthropic.test.ts`
- Modify: `sga_template/src/computer-use/providers/openai.ts`
- Modify: `sga_template/src/computer-use/providers/openai.test.ts`

**Interfaces:**
- Consumes: `ComputerUseResult` from `../types.js`
- Produces: `interpretActionResult(result: ComputerUseResult): string` on both adapter classes

- [ ] **Step 1: Write the failing tests for Anthropic adapter**

Open `sga_template/src/computer-use/providers/anthropic.test.ts`. Add a new describe block at the end of the file:

```typescript
describe('AnthropicComputerUseAdapter.interpretActionResult', () => {
  const adapter = new AnthropicComputerUseAdapter({
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet-20241022',
  })

  it('returns screenshot feedback for successful screenshot', () => {
    const result = {
      success: true,
      screenshot: 'abc123',
      action: { type: 'screenshot' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toMatch(/screenshot.*captured/i)
  })

  it('returns data feedback for successful canvas action', () => {
    const result = {
      success: true,
      data: { nodeId: '42' },
      action: { type: 'addNode', nodeType: 'KSampler' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action succeeded')
    expect(feedback).toContain('nodeId')
  })

  it('returns error feedback for failed action', () => {
    const result = {
      success: false,
      error: 'Node not found',
      action: { type: 'removeNode', nodeId: '99' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action failed')
    expect(feedback).toContain('Node not found')
  })

  it('returns generic success for action without screenshot or data', () => {
    const result = {
      success: true,
      action: { type: 'click', x: 10, y: 20 },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toBe('Action succeeded')
  })
})
```

- [ ] **Step 2: Write the failing tests for OpenAI adapter**

Open `sga_template/src/computer-use/providers/openai.test.ts`. Add a new describe block at the end:

```typescript
describe('OpenAIComputerUseAdapter.interpretActionResult', () => {
  const adapter = new OpenAIComputerUseAdapter({
    apiKey: 'sk-test',
    model: 'computer-use-preview',
  })

  it('returns screenshot feedback for successful screenshot', () => {
    const result = {
      success: true,
      screenshot: 'abc123',
      action: { type: 'screenshot' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toMatch(/screenshot.*captured/i)
  })

  it('returns data feedback for successful canvas action', () => {
    const result = {
      success: true,
      data: { nodeId: '42' },
      action: { type: 'addNode', nodeType: 'KSampler' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action succeeded')
    expect(feedback).toContain('nodeId')
  })

  it('returns error feedback for failed action', () => {
    const result = {
      success: false,
      error: 'Node not found',
      action: { type: 'removeNode', nodeId: '99' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action failed')
    expect(feedback).toContain('Node not found')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd sga_template && npx vitest run src/computer-use/providers/anthropic.test.ts src/computer-use/providers/openai.test.ts`
Expected: 7 new tests FAIL with "adapter.interpretActionResult is not a function"

- [ ] **Step 4: Add interpretActionResult() to Anthropic adapter**

Open `sga_template/src/computer-use/providers/anthropic.ts`. Add this method to the `AnthropicComputerUseAdapter` class (after the existing `sendScreenshotAndGetCurrentAction` method, before the closing brace):

```typescript
  interpretActionResult(result: ComputerUseResult): string {
    if (result.success) {
      if (result.screenshot) {
        return `Screenshot captured (${result.screenshot.length} bytes base64)`
      }
      if (result.data !== undefined) {
        return `Action succeeded. Response: ${JSON.stringify(result.data).slice(0, 500)}`
      }
      return 'Action succeeded'
    }
    return `Action failed: ${result.error ?? 'unknown error'}`
  }
```

- [ ] **Step 5: Add interpretActionResult() to OpenAI adapter**

Open `sga_template/src/computer-use/providers/openai.ts`. Add this method to the `OpenAIComputerUseAdapter` class (after the existing `sendScreenshotAndGetCurrentAction` method, before the closing brace):

```typescript
  interpretActionResult(result: ComputerUseResult): string {
    if (result.success) {
      if (result.screenshot) {
        return `Screenshot captured (${result.screenshot.length} bytes base64)`
      }
      if (result.data !== undefined) {
        return `Action succeeded. Response: ${JSON.stringify(result.data).slice(0, 500)}`
      }
      return 'Action succeeded'
    }
    return `Action failed: ${result.error ?? 'unknown error'}`
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd sga_template && npx vitest run src/computer-use/providers/anthropic.test.ts src/computer-use/providers/openai.test.ts`
Expected: All tests PASS (existing + 7 new)

- [ ] **Step 7: Run full suite**

Run: `cd sga_template && npm test`
Expected: 170/170 pass (163 + 7 new)

- [ ] **Step 8: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 9: Commit**

```bash
cd sga_template
git add src/computer-use/providers/anthropic.ts src/computer-use/providers/anthropic.test.ts src/computer-use/providers/openai.ts src/computer-use/providers/openai.test.ts
git commit -m "feat(computer-use): add interpretActionResult to both provider adapters"
```

---

## Task 4: Orchestrator runGoal() async generator

**Files:**
- Modify: `sga_template/src/computer-use/orchestrator.ts`
- Modify: `sga_template/src/computer-use/orchestrator.test.ts`

**Interfaces:**
- Consumes: `ComputerUseAdapter` (from Task 1), `StepEvent` (from Task 1), `isTerminalAction()` (from Task 1), existing `executeAction()` / `takeScreenshot()`
- Produces: `runGoal(goal, opts)` async generator, `setActiveAdapter(adapter)`, `cancelRun()` method

- [ ] **Step 1: Write the failing tests**

Open `sga_template/src/computer-use/orchestrator.test.ts`. Add a new describe block at the end:

```typescript
describe('ComputerUseOrchestrator.runGoal', () => {
  // Helper: create a mock adapter with a scripted sequence of actions
  function createMockAdapter(actions: ComputerUseAction[]): ComputerUseAdapter {
    let callIndex = 0
    return {
      name: 'mock',
      sendScreenshotAndGetCurrentAction: vi.fn().mockImplementation(async () => {
        const action = actions[callIndex] ?? { type: 'done', summary: 'default done' }
        callIndex++
        return action
      }),
      interpretActionResult: vi.fn().mockReturnValue('mock feedback'),
    }
  }

  it('terminates when adapter returns done action', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    // Mock start() by setting internal state — use a spy
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    const adapter = createMockAdapter([
      { type: 'screenshot' },
      { type: 'done', summary: 'Task completed' },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 5 })) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'loop_done')
    expect(doneEvent).toBeDefined()
    expect((doneEvent as StepEvent).summary).toBe('Task completed')
  })

  it('terminates when maxSteps is reached', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    // Adapter never returns done — always clicks
    const adapter = createMockAdapter([
      { type: 'click', x: 0, y: 0 },
      { type: 'click', x: 1, y: 1 },
      { type: 'click', x: 2, y: 2 },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 2 })) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'loop_done')
    expect(doneEvent).toBeDefined()
    expect((doneEvent as StepEvent).summary).toMatch(/max steps/i)
    expect((doneEvent as StepEvent).step).toBe(2)
  })

  it('terminates after 3 consecutive failures', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    // Adapter returns scroll (not implemented) 3 times
    const adapter = createMockAdapter([
      { type: 'scroll', dx: 0, dy: 0 },
      { type: 'scroll', dx: 0, dy: 0 },
      { type: 'scroll', dx: 0, dy: 0 },
    ])
    // Mock executeAction to always fail
    vi.spyOn(orchestrator, 'executeAction').mockResolvedValue({
      success: false,
      error: 'not implemented',
      action: { type: 'scroll', dx: 0, dy: 0 },
    })

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 10 })) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as StepEvent).error).toMatch(/consecutive.*fail/i)
  })

  it('throws if state is not ready', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    // state is 'idle' by default
    const adapter = createMockAdapter([])

    await expect(async () => {
      for await (const _event of orchestrator.runGoal('test', { adapter })) {
        // should not iterate
      }
    }).rejects.toThrow(/not ready/i)
  })

  it('rejects nested run_goal action from adapter', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    const adapter = createMockAdapter([
      { type: 'run_goal', goal: 'nested' },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test', { adapter, maxSteps: 5 })) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as StepEvent).error).toMatch(/nested/i)
  })
})
```

You'll need to add these imports at the top of the test file (if not already present):

```typescript
import type { ComputerUseAdapter, ComputerUseAction, StepEvent } from './types.js'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sga_template && npx vitest run src/computer-use/orchestrator.test.ts`
Expected: 5 new tests FAIL with "orchestrator.runGoal is not a function"

- [ ] **Step 3: Add runGoal() and supporting methods to orchestrator.ts**

Open `sga_template/src/computer-use/orchestrator.ts`. Make 4 changes:

**Change 1:** Add imports for new types (update the existing import from `./types.js`):

```typescript
import {
  type ComputerUseConfig,
  type ComputerUseSessionState,
  type ComputerUseAction,
  type ComputerUseResult,
  type ComputerUseAdapter,
  type StepEvent,
  DEFAULT_COMPUTER_USE_CONFIG,
  isCanvasAction,
  isTerminalAction,
} from './types.js'
```

**Change 2:** Add fields to the class (after `private sessionTimeoutHandle`):

```typescript
  private activeAdapter: ComputerUseAdapter | null = null
  private cancelRequested = false
```

**Change 3:** Add `setActiveAdapter()` and `cancelRun()` methods (after `setCanvasBridge()`):

```typescript
  /** Set the provider adapter for autopilot mode. */
  setActiveAdapter(adapter: ComputerUseAdapter): void {
    this.activeAdapter = adapter
    logger.info(`Active adapter set: ${adapter.name}`)
  }

  /** Request cancellation of the current autopilot run. */
  cancelRun(): void {
    this.cancelRequested = true
    logger.info('Run cancellation requested')
  }
```

**Change 4:** Add the `runGoal()` async generator (after `cancelRun()`):

```typescript
  /**
   * Run the autopilot loop: screenshot → adapter → execute → feedback.
   * Yields StepEvents for real-time streaming.
   * Terminates on: done action, maxSteps, 3 consecutive failures, or cancel.
   */
  async *runGoal(
    goal: string,
    opts: { adapter: ComputerUseAdapter; maxSteps?: number },
  ): AsyncIterable<StepEvent> {
    if (this.state !== 'ready') {
      throw new Error(`Cannot run goal: session not ready (state: ${this.state})`)
    }

    const adapter = opts.adapter
    const maxSteps = Math.min(opts.maxSteps ?? 20, 50)
    let history = ''
    let consecutiveFailures = 0
    let step = 0

    this.state = 'running'
    this.cancelRequested = false
    logger.info(`Starting autopilot run: "${goal}" (max ${maxSteps} steps)`)

    try {
      while (step < maxSteps) {
        if (this.cancelRequested) {
          yield { step, type: 'stopped', timestamp: Date.now() }
          break
        }

        yield { step, type: 'step_start', timestamp: Date.now() }

        // 1. Take screenshot
        const screenshot = await this.takeScreenshot('full')
        yield { step, type: 'screenshot_taken', screenshot, timestamp: Date.now() }

        // 2. Ask adapter for next action
        const action = await adapter.sendScreenshotAndGetCurrentAction(screenshot, goal, history)
        yield { step, type: 'action_decided', action, timestamp: Date.now() }

        // 3. Check for terminal actions
        if (action.type === 'done') {
          yield { step, type: 'loop_done', summary: action.summary, timestamp: Date.now() }
          break
        }

        if (action.type === 'require_approval') {
          yield { step, type: 'approval_required', question: action.question, timestamp: Date.now() }
          // MVP: auto-stop on approval request
          break
        }

        if (action.type === 'run_goal') {
          yield { step, type: 'error', error: 'Nested run_goal not allowed', timestamp: Date.now() }
          break
        }

        // 4. Execute the action
        const result = await this.executeAction(action)
        yield { step, type: 'action_executed', action, result, timestamp: Date.now() }

        // 5. Track failures
        if (!result.success) {
          consecutiveFailures++
          if (consecutiveFailures >= 3) {
            yield {
              step,
              type: 'error',
              error: `Autopilot stopped: 3 consecutive failures`,
              timestamp: Date.now(),
            }
            break
          }
        } else {
          consecutiveFailures = 0
        }

        // 6. Accumulate feedback
        const feedback = adapter.interpretActionResult(result)
        history += `\nStep ${step + 1}: ${feedback}`

        yield { step, type: 'step_done', timestamp: Date.now() }
        step++
      }

      if (step >= maxSteps && !this.cancelRequested) {
        yield { step, type: 'loop_done', summary: `Max steps reached (${maxSteps})`, timestamp: Date.now() }
      }
    } finally {
      this.state = 'ready'
      this.cancelRequested = false
      logger.info(`Autopilot run ended after ${step} steps`)
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sga_template && npx vitest run src/computer-use/orchestrator.test.ts`
Expected: All tests PASS (existing + 5 new)

- [ ] **Step 5: Run full suite**

Run: `cd sga_template && npm test`
Expected: 175/175 pass (170 + 5 new)

- [ ] **Step 6: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
cd sga_template
git add src/computer-use/orchestrator.ts src/computer-use/orchestrator.test.ts
git commit -m "feat(computer-use): add runGoal async generator with safety net"
```

---

## Task 5: Wire run_goal into ComputerUseTool + SSE event stream

**Files:**
- Modify: `sga_template/src/tools/built-in/computer-use.ts`

**Interfaces:**
- Consumes: `runGoal()` from orchestrator (Task 4), `ComputerUseAdapter` (Task 1)
- Produces: `run_goal` action in tool, module-level `currentRunEventStream` for SSE coordination, `getComputerUseRunEventStream()` / `setComputerUseRunEventStream()` accessors

- [ ] **Step 1: Add the run_goal case to buildAction() and wire runGoal() in call()**

Open `sga_template/src/tools/built-in/computer-use.ts`. Make 4 changes:

**Change 1:** Add imports for new types (update existing import from computer-use/types.js):

```typescript
import type { ComputerUseAction, ComputerUseResult, StepEvent } from '../../computer-use/types.js'
```

**Change 2:** Add module-level event stream storage (after `activeOrchestrator` variable, before `setComputerUseOrchestrator`):

```typescript
// Module-level event stream for SSE coordination.
// Set by the tool when runGoal starts; read by the SSE handler.
let currentRunEventStream: AsyncIterable<StepEvent> | null = null

export function getComputerUseRunEventStream(): AsyncIterable<StepEvent> | null {
  return currentRunEventStream
}

export function setComputerUseRunEventStream(stream: AsyncIterable<StepEvent> | null): void {
  currentRunEventStream = stream
}
```

**Change 3:** Add `run_goal` to the `buildAction()` switch (before the `default` case):

```typescript
      case 'run_goal': {
        return {
          type: 'run_goal',
          goal: String(args?.goal ?? ''),
          maxSteps: typeof args?.maxSteps === 'number' ? args.maxSteps : undefined,
        }
      }
```

**Change 4:** In the `call()` method, add `run_goal` handling. After the `buildAction` call and before the existing `executeAction` try/catch, add:

```typescript
    // Handle run_goal specially — enters autopilot loop
    if (action.type === 'run_goal') {
      const adapter = activeOrchestrator.getActiveAdapter()
      if (!adapter) {
        return 'Autopilot not available: no provider adapter configured. Start the session with a supported provider (anthropic or openai).'
      }

      const maxSteps = action.maxSteps ?? 20
      const goalText = action.goal
      logger.info(`Starting autopilot run: "${goalText}" (max ${maxSteps} steps)`)

      const eventStream = activeOrchestrator.runGoal(goalText, { adapter, maxSteps })
      setComputerUseRunEventStream(eventStream)

      let stepCount = 0
      let finalSummary = 'Autopilot run completed'

      try {
        for await (const event of eventStream) {
          if (event.type === 'loop_done') {
            finalSummary = event.summary ?? finalSummary
          }
          if (event.type === 'error') {
            finalSummary = `Autopilot error: ${event.error}`
          }
          if (event.type === 'stopped') {
            finalSummary = 'Autopilot stopped by user'
          }
          if (event.type === 'approval_required') {
            finalSummary = `Approval required: ${event.question}`
          }
          stepCount = event.step + 1
        }
      } finally {
        setComputerUseRunEventStream(null)
      }

      return `Autopilot completed after ${stepCount} steps. ${finalSummary}`
    }
```

**Change 5:** Update the tool description and input schema to include `run_goal`. In the `description` field, add after `runQueue` line:

```
  - run_goal: enter autopilot loop to achieve a goal (args: goal, maxSteps?)
```

In `getInputSchema()`, update the action description:

```typescript
        action: {
          type: 'string',
          description: 'The action to perform: screenshot, addNode, removeNode, connect, disconnect, setWidget, getCanvasState, runQueue, run_goal',
        },
```

- [ ] **Step 2: Add getActiveAdapter() to orchestrator**

Open `sga_template/src/computer-use/orchestrator.ts`. Add a getter (after `setActiveAdapter`):

```typescript
  /** Get the active provider adapter (or null if none set). */
  getActiveAdapter(): ComputerUseAdapter | null {
    return this.activeAdapter
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Run full suite**

Run: `cd sga_template && npm test`
Expected: 175/175 pass (no new tests — tool integration is tested via orchestrator tests)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/tools/built-in/computer-use.ts src/computer-use/orchestrator.ts
git commit -m "feat(computer-use): wire run_goal action into ComputerUseTool with SSE stream"
```

---

## Task 6: SSE endpoint + approve endpoint + provider selection

**Files:**
- Modify: `sga_template/src/server/routes.ts`
- Modify: `sga_template/src/server/app.ts`

**Interfaces:**
- Consumes: `getComputerUseRunEventStream()` from Task 5, `AnthropicComputerUseAdapter` / `OpenAIComputerUseAdapter` from existing code
- Produces: `handleComputerUseRunEvents` (SSE GET), `handleComputerUseApprove` (POST), provider selection in `handleComputerUseStart`

- [ ] **Step 1: Add imports to routes.ts**

Open `sga_template/src/server/routes.ts`. Add imports near the top (with the existing computer-use imports):

```typescript
import { getComputerUseRunEventStream } from '../tools/built-in/computer-use.js'
import { AnthropicComputerUseAdapter } from '../computer-use/providers/anthropic.js'
import { OpenAIComputerUseAdapter } from '../computer-use/providers/openai.js'
import type { ComputerUseAdapter } from '../computer-use/types.js'
```

- [ ] **Step 2: Add provider selection to handleComputerUseStart**

Find the `handleComputerUseStart` function (around line 4371). After the existing bridge wiring (after `computerUseOrchestrator.setCanvasBridge(bridge)`), add provider selection:

```typescript
  // Select provider adapter based on config
  let adapter: ComputerUseAdapter | null = null
  const provider = (config as any).llmProvider ?? 'anthropic'
  if (provider === 'anthropic') {
    adapter = new AnthropicComputerUseAdapter({
      apiKey: (config as any).anthropicApiKey ?? '',
      model: 'claude-3-5-sonnet-20241022',
    })
  } else if (provider === 'openai') {
    adapter = new OpenAIComputerUseAdapter({
      apiKey: (config as any).openaiApiKey ?? '',
      model: 'computer-use-preview',
    })
  }
  if (adapter && computerUseOrchestrator) {
    computerUseOrchestrator.setActiveAdapter(adapter)
  }
```

- [ ] **Step 3: Add the SSE handler**

Add this new exported function after `handleComputerUseStop`:

```typescript
/** SSE endpoint: streams StepEvents from the active autopilot run. */
export async function handleComputerUseRunEvents(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')  // Disable nginx buffering

  const eventStream = getComputerUseRunEventStream()
  if (!eventStream) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'No active autopilot run', step: 0, timestamp: Date.now() })}\n\n`)
    res.end()
    return
  }

  try {
    for await (const event of eventStream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'loop_done' || event.type === 'stopped' || event.type === 'error' || event.type === 'approval_required') {
        break
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    res.write(`data: ${JSON.stringify({ type: 'error', error: msg, step: 0, timestamp: Date.now() })}\n\n`)
  } finally {
    res.end()
  }
}
```

- [ ] **Step 4: Add the approve handler**

Add this new exported function after `handleComputerUseRunEvents`:

```typescript
/** Approve or reject a pending require_approval from the autopilot. */
export async function handleComputerUseApprove(req: Request, res: Response): Promise<void> {
  const { approved } = req.body as { approved?: boolean }
  // MVP: just acknowledge — the loop auto-stops on approval_required
  // Future: resume the loop with the approval result
  res.json({ success: true, message: approved ? 'Approved' : 'Rejected — autopilot will stop' })
}
```

- [ ] **Step 5: Register routes in app.ts**

Open `sga_template/src/server/app.ts`. Find the computer-use route registrations (around line 282-284). Add after them:

```typescript
  app.get(`${base}/computer-use/run-events`, handleComputerUseRunEvents)
  app.post(`${base}/computer-use/approve`, handleComputerUseApprove)
```

Also add the imports at the top of app.ts (with the existing computer-use imports):

```typescript
  handleComputerUseRunEvents,
  handleComputerUseApprove,
```

- [ ] **Step 6: Typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Run full suite**

Run: `cd sga_template && npm test`
Expected: 175/175 pass

- [ ] **Step 8: Commit**

```bash
cd sga_template
git add src/server/routes.ts src/server/app.ts
git commit -m "feat(computer-use): add SSE run-events endpoint and provider selection"
```

---

## Task 7: Frontend — SSE hook, step flow component, ChatPanel integration

**Files:**
- Create: `ui/src/hooks/useComputerUseRunEvents.ts`
- Create: `ui/src/components/AutopilotStepFlow.tsx`
- Modify: `ui/src/services/configService.ts`
- Modify: `ui/src/components/ChatPanel.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: SSE endpoint `/api/v1/computer-use/run-events` (Task 6), `stopComputerUse()` from existing configService
- Produces: `useComputerUseRunEvents()` hook, `<AutopilotStepFlow>` component, `approveComputerUseAction()` API

- [ ] **Step 1: Create the SSE hook**

Create `ui/src/hooks/useComputerUseRunEvents.ts`:

```typescript
import { useEffect, useState, useCallback } from 'react'

export interface StepEvent {
  step: number
  type: 'step_start' | 'screenshot_taken' | 'action_decided'
      | 'action_executed' | 'step_done' | 'loop_done'
      | 'error' | 'approval_required' | 'stopped'
  action?: Record<string, unknown>
  result?: { success: boolean; error?: string; data?: unknown; screenshot?: string }
  screenshot?: string
  summary?: string
  error?: string
  question?: string
  timestamp: number
}

export function useComputerUseRunEvents(baseUrl: string) {
  const [steps, setSteps] = useState<StepEvent[]>([])
  const [isActive, setIsActive] = useState(false)
  const [eventSource, setEventSource] = useState<EventSource | null>(null)

  const connect = useCallback(() => {
    if (eventSource) eventSource.close()

    const es = new EventSource(`${baseUrl}/computer-use/run-events`)
    setEventSource(es)
    setIsActive(true)
    setSteps([])

    es.onmessage = (e) => {
      const event: StepEvent = JSON.parse(e.data)
      setSteps(prev => [...prev, event])
      if (event.type === 'loop_done' || event.type === 'stopped' || event.type === 'error' || event.type === 'approval_required') {
        es.close()
        setIsActive(false)
      }
    }

    es.onerror = () => {
      es.close()
      setIsActive(false)
    }
  }, [baseUrl, eventSource])

  const disconnect = useCallback(() => {
    if (eventSource) {
      eventSource.close()
      setEventSource(null)
    }
    setIsActive(false)
  }, [eventSource])

  useEffect(() => {
    return () => {
      if (eventSource) eventSource.close()
    }
  }, [eventSource])

  return { steps, isActive, connect, disconnect }
}
```

- [ ] **Step 2: Create the AutopilotStepFlow component**

Create `ui/src/components/AutopilotStepFlow.tsx`:

```typescript
import { useState } from 'react'
import type { StepEvent } from '../hooks/useComputerUseRunEvents'

interface AutopilotStepFlowProps {
  steps: StepEvent[]
  isActive: boolean
  onStop: () => void
}

export function AutopilotStepFlow({ steps, isActive, onStop }: AutopilotStepFlowProps) {
  const [enlargedScreenshot, setEnlargedScreenshot] = useState<string | null>(null)

  if (steps.length === 0 && !isActive) return null

  return (
    <div style={{
      border: '1px solid var(--border-color, #444)',
      borderRadius: '8px',
      padding: '12px',
      marginTop: '8px',
      maxHeight: '400px',
      overflowY: 'auto',
      background: 'var(--bg-color, #1a1a1a)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong>Autopilot {isActive ? '(running)' : '(finished)'}</strong>
        {isActive && (
          <button
            onClick={onStop}
            style={{
              padding: '4px 12px',
              background: '#d33',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Stop
          </button>
        )}
      </div>

      {steps.map((event, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px', fontSize: '13px' }}>
          <span style={{ color: '#888', minWidth: '32px' }}>#{event.step + 1}</span>
          {event.screenshot && (
            <img
              src={`data:image/png;base64,${event.screenshot}`}
              alt={`Step ${event.step + 1} screenshot`}
              onClick={() => setEnlargedScreenshot(event.screenshot!)}
              style={{
                width: '60px',
                height: '40px',
                objectFit: 'cover',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            />
          )}
          <div style={{ flex: 1 }}>
            <span style={{ color: event.type === 'error' ? '#f66' : event.type === 'loop_done' ? '#6f6' : '#ccc' }}>
              {event.type.replace(/_/g, ' ')}
            </span>
            {event.action && (
              <span style={{ color: '#88f', marginLeft: '4px' }}>
                {(event.action as { type: string }).type}
              </span>
            )}
            {event.summary && <div style={{ color: '#6f6' }}>{event.summary}</div>}
            {event.error && <div style={{ color: '#f66' }}>{event.error}</div>}
            {event.question && <div style={{ color: '#ff6' }}>Approval: {event.question}</div>}
          </div>
        </div>
      ))}

      {enlargedScreenshot && (
        <div
          onClick={() => setEnlargedScreenshot(null)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            cursor: 'pointer',
          }}
        >
          <img
            src={`data:image/png;base64,${enlargedScreenshot}`}
            alt="Enlarged screenshot"
            style={{ maxWidth: '90%', maxHeight: '90%' }}
          />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add approveComputerUseAction to configService**

Open `ui/src/services/configService.ts`. Add this function after the existing `stopComputerUse()` function:

```typescript
export async function approveComputerUseAction(baseUrl: string, approved: boolean): Promise<void> {
  const res = await fetch(`${baseUrl}/computer-use/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved }),
  })
  if (!res.ok) {
    throw new Error(`Failed to approve: ${res.status}`)
  }
}
```

- [ ] **Step 4: Integrate into ChatPanel**

Open `ui/src/components/ChatPanel.tsx`. Make 3 changes:

**Change 1:** Add imports at the top:

```typescript
import { AutopilotStepFlow } from './AutopilotStepFlow'
import { useComputerUseRunEvents } from '../hooks/useComputerUseRunEvents'
import { stopComputerUse } from '../services/configService'
```

**Change 2:** Inside the ChatPanel component function, add the hook:

```typescript
const autopilot = useComputerUseRunEvents(backendUrl ?? '')
```

**Change 3:** Render the AutopilotStepFlow. Find where messages are rendered. Add after the messages list (or in the footer area, before the input):

```typescript
{(autopilot.steps.length > 0 || autopilot.isActive) && (
  <AutopilotStepFlow
    steps={autopilot.steps}
    isActive={autopilot.isActive}
    onStop={async () => {
      try {
        await stopComputerUse(backendUrl ?? '')
        autopilot.disconnect()
      } catch (e) {
        console.error('Stop failed:', e)
      }
    }}
  />
)}
```

- [ ] **Step 5: UI typecheck + lint + build**

Run: `cd ui && npm run verify`
Expected: typecheck + lint + build all pass

- [ ] **Step 6: Backend full suite (verify no regressions)**

Run: `cd sga_template && npm test`
Expected: 175/175 pass

- [ ] **Step 7: Commit**

```bash
git add ui/src/hooks/useComputerUseRunEvents.ts ui/src/components/AutopilotStepFlow.tsx ui/src/services/configService.ts ui/src/components/ChatPanel.tsx
git commit -m "feat(computer-use): add autopilot step flow UI with SSE streaming"
```

---

## Task 8: Final integration verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Backend full suite**

Run: `cd sga_template && npm test`
Expected: 175/175 pass

- [ ] **Step 2: Backend typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: UI verify**

Run: `cd ui && npm run verify`
Expected: typecheck + lint + build all pass

- [ ] **Step 4: Extension syntax check**

Run: `node --check web/computer-use-extension.js`
Expected: no syntax errors

- [ ] **Step 5: Verify all commits**

Run: `git log --oneline -10`
Expected: 8 new commits on `feat/computer-use` since the Phase 0+1 completion

- [ ] **Step 6: Manual integration checklist**

Verify these endpoints exist and respond:
- `GET /api/v1/computer-use/status` — existing, returns state
- `POST /api/v1/computer-use/start` — existing, now also sets adapter
- `POST /api/v1/computer-use/stop` — existing, also cancels autopilot
- `GET /api/v1/computer-use/run-events` — new SSE endpoint
- `POST /api/v1/computer-use/approve` — new approve endpoint

- [ ] **Step 7: Final commit (if any cleanup needed)**

If all verification passes, no commit needed. If issues found, fix and commit.

---

## Self-Review Notes

**Spec coverage:**
- Section 4 (New Action Types) → Task 1 ✓
- Section 5 (Orchestrator runGoal) → Task 4 ✓
- Section 6 (interpretActionResult) → Task 3 ✓
- Section 7 (Visual Actions) → Task 2 ✓
- Section 8 (SSE Streaming) → Task 6 (backend) + Task 7 (frontend) ✓
- Section 9 (ComputerUseTool Changes) → Task 5 ✓
- Section 10 (Provider Selection) → Task 6 ✓
- Section 11 (Safety Net) → Task 4 (maxSteps, consecutive failures, cancel, nested guard) ✓; require_approval pause → Task 4 (auto-stop MVP) ✓
- Section 12 (Testing) → Tasks 1-4 have unit tests; Task 8 has integration verification ✓

**Type consistency:** `StepEvent`, `ComputerUseAdapter`, `RunGoalAction`, `DoneAction`, `RequireApprovalAction` — all defined in Task 1, used consistently in Tasks 3-7. `runGoal()` signature matches between spec and Task 4. `getActiveAdapter()` added in Task 5 (not in spec but needed by tool to pass adapter to runGoal).

**Placeholder scan:** All code blocks contain complete implementations. No "TODO", "TBD", or "similar to" references.
