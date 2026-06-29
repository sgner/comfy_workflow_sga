# ComfyUI Computer Use — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the foundation (Phase 0) and canvas automation via JS extension (Phase 1) of the ComfyUI Computer Use capability, enabling a multimodal-model-driven agent to directly manipulate the ComfyUI workflow canvas.

**Architecture:** A new `sga_template/src/computer-use/` module adds an Orchestrator (session lifecycle + Playwright browser), an Action Executor (routes model actions to Playwright or JS extension), a WebSocket server (control channel to the browser-side JS extension), and provider adapters (Anthropic + OpenAI). The JS extension is shipped via ComfyUI's `WEB_DIRECTORY` mechanism as `web/computer-use-extension.js` and bridges the LiteGraph canvas API over WS.

**Tech Stack:** TypeScript 5.7, Express 4.21, Vitest 2.1, Playwright (new dependency), `ws` WebSocket library (new dependency), React 18 + Vite 5 (UI toggle), plain browser JS (extension).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-29-comfyui-computer-use-design.md` (approved, commit `f1c6b74` on `feat/computer-use` branch)
- **Branch:** `feat/computer-use`
- **Test framework:** Vitest (`sga_template/vitest.config.ts`, `include: ['src/**/*.test.ts']`); run via `cd sga_template && npm test`
- **Test command:** `cd sga_template && npm test` (one-shot) or `npm run test:watch` (watch mode)
- **Verify command (backend):** `cd sga_template && npm run verify` (typecheck + test)
- **Verify command (UI):** `cd ui && npm run verify` (typecheck + lint + build)
- **Tool interface:** `Tool<Input, Output>` in `sga_template/src/tools/base.ts`; extend `BaseTool<Input, Output>`
- **Route pattern:** handlers in `sga_template/src/server/routes.ts` as `export function handleFoo(req, res)`, registered in `app.ts` via `app.get(`${base}/path`, handleFoo)` where `base = config.basePath ?? '/api/v1'`
- **Provider interface:** `LLMProvider` in `sga_template/src/providers/types.ts` with methods `createMessage()`, `createStreamingMessage()`
- **Web extension:** shipped via `WEB_DIRECTORY = "./web"` in `__init__.py`; ComfyUI loads each `web/*.js` as a `<script type="module">`
- **No WebSocket server exists today** — must be added by capturing the `http.Server` from `app.listen` and attaching `ws.WebSocketServer`
- **Playwright is not a dependency** — must be added to `sga_template/package.json`
- **UI has no test framework** — typecheck + lint + build is the baseline; no UI unit tests
- **ComfyUI frontend source is read-only** — `ComfyUI_frontend-main/` is reference only; all browser-side code ships via `web/` directory

---

## File Structure

### Files to create

| File | Responsibility |
|------|----------------|
| `sga_template/src/computer-use/types.ts` | `ComputerUseAction` union type, session state enum, config interface |
| `sga_template/src/computer-use/orchestrator.ts` | Session lifecycle (idle→starting→ready→running→stopped), Playwright launch/stop, `/api/v1/computer-use/{start,status,stop}` route handlers |
| `sga_template/src/computer-use/action-executor.ts` | Dispatches normalized actions: screenshot→Playwright, canvas ops→WS bridge |
| `sga_template/src/computer-use/ws-server.ts` | WebSocket server attached to the Express http.Server; endpoint `/api/v1/computer-use/ws` |
| `sga_template/src/computer-use/canvas-bridge.ts` | WS client that sends canvas op requests to the JS extension and awaits responses |
| `sga_template/src/computer-use/providers/anthropic.ts` | Anthropic Claude Computer Use adapter (screenshot → `tool_use` action round-trip) |
| `sga_template/src/computer-use/providers/openai.ts` | OpenAI CUA adapter (Responses API + `computer_use_preview` tool) |
| `sga_template/src/computer-use/providers/generic.ts` | Placeholder stub (throws "not implemented" — Phase 3) |
| `sga_template/src/tools/built-in/computer-use.ts` | `computer_use` built-in tool that calls the orchestrator |
| `sga_template/src/computer-use/orchestrator.test.ts` | Unit tests for orchestrator lifecycle |
| `sga_template/src/computer-use/providers/anthropic.test.ts` | Unit tests for Anthropic adapter action parsing |
| `sga_template/src/computer-use/providers/openai.test.ts` | Unit tests for OpenAI CUA adapter |
| `sga_template/src/computer-use/canvas-bridge.test.ts` | Unit tests for canvas bridge WS protocol |
| `sga_template/src/computer-use/action-executor.test.ts` | Unit tests for action dispatch |
| `ui/src/components/ComputerUseToggle.tsx` | React toggle button + status indicator |
| `web/computer-use-extension.js` | Browser-side JS extension: WS client + LiteGraph canvas API bridge |
| `docs/superpowers/specs/computer-use-ws-protocol.md` | WS message envelope, canvas op request/response, error codes |

### Files to modify

| File | Change |
|------|--------|
| `sga_template/package.json` | Add `playwright` and `ws` + `@types/ws` dependencies |
| `sga_template/src/server/app.ts` | Capture `http.Server` from `app.listen`; register computer-use routes; attach WS server |
| `sga_template/src/tools/built-in/index.ts` | Register `ComputerUseTool` in `createBuiltinTools()` |
| `ui/src/components/ChatPanel.tsx` | Add `ComputerUseToggle` to header; add props |
| `ui/src/services/configService.ts` | Add `startComputerUse()`, `stopComputerUse()`, `getComputerUseStatus()` |
| `ui/src/App.tsx` | Wire toggle state + API calls |

---

## Task 1: Dependencies and type definitions

**Files:**
- Modify: `sga_template/package.json`
- Create: `sga_template/src/computer-use/types.ts`
- Create: `sga_template/src/computer-use/providers/generic.ts` (stub)

**Interfaces:**
- Produces: `ComputerUseAction` union, `ComputerUseSessionState`, `ComputerUseConfig`, `ComputerUseResult`

- [ ] **Step 1: Add dependencies to `sga_template/package.json`**

Open `sga_template/package.json` and add to `dependencies`:

```json
"playwright": "^1.49.0",
"ws": "^8.18.0"
```

Add to `devDependencies`:

```json
"@types/ws": "^8.5.13"
```

- [ ] **Step 2: Install dependencies**

Run: `cd sga_template && npm install`
Expected: packages installed, no errors

- [ ] **Step 3: Install Playwright browsers**

Run: `cd sga_template && npx playwright install chromium`
Expected: Chromium downloaded (one-time, ~150MB)

- [ ] **Step 4: Write the type definitions**

Create `sga_template/src/computer-use/types.ts`:

```typescript
/**
 * Computer Use capability types.
 *
 * The ComputerUseAction union is the normalized format that all provider
 * adapters translate to/from. The Action Executor dispatches each action
 * to the appropriate backend (Playwright for visual/UI, WS bridge for canvas).
 */

// ── Session lifecycle ──

export type ComputerUseSessionState =
  | 'idle'          // not started
  | 'starting'      // launching browser, waiting for JS extension
  | 'ready'         // browser open, extension connected, tool registered
  | 'stopping'      // shutting down
  | 'stopped'       // finished
  | 'error'         // failed to start or fatal error

export interface ComputerUseConfig {
  /** ComfyUI URL to navigate the dedicated browser to. */
  comfyuiUrl: string
  /** Whether to launch browser in visible mode (default: true). */
  headless: boolean
  /** Session timeout in ms (default: 30 minutes). */
  sessionTimeoutMs: number
}

export const DEFAULT_COMPUTER_USE_CONFIG: ComputerUseConfig = {
  comfyuiUrl: 'http://127.0.0.1:8188',
  headless: false,
  sessionTimeoutMs: 30 * 60 * 1000,
}

// ── Normalized actions ──

export interface ScreenshotAction {
  type: 'screenshot'
  /** Optional viewport variant: 'full' (full page) or 'canvas' (canvas viewport only). */
  variant?: 'full' | 'canvas'
}

export interface ClickAction {
  type: 'click'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
}

export interface TypeAction {
  type: 'type'
  text: string
}

export interface ScrollAction {
  type: 'scroll'
  dx: number
  dy: number
}

export interface DragAction {
  type: 'drag'
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export interface KeyAction {
  type: 'key'
  combo: string  // e.g. "Enter", "Control+c"
}

export interface WaitAction {
  type: 'wait'
  ms: number
}

// ── Canvas-specific actions (scope C, via JS extension) ──

export interface AddNodeAction {
  type: 'addNode'
  nodeType: string
  x?: number
  y?: number
}

export interface RemoveNodeAction {
  type: 'removeNode'
  nodeId: string
}

export interface ConnectAction {
  type: 'connect'
  fromNodeId: string
  fromSlot: number
  toNodeId: string
  toSlot: number
}

export interface DisconnectAction {
  type: 'disconnect'
  linkId: string
}

export interface SetWidgetAction {
  type: 'setWidget'
  nodeId: string
  widgetName: string
  value: unknown
}

export interface GetCanvasStateAction {
  type: 'getCanvasState'
}

export interface RunQueueAction {
  type: 'runQueue'
  prompt?: Record<string, unknown>
}

/** Union of all actions the agent can request. */
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

// ── Action result ──

export interface ComputerUseResult {
  success: boolean
  /** Screenshot as base64 PNG (for visual actions) or null. */
  screenshot?: string
  /** Structured data returned (for canvas actions like getCanvasState). */
  data?: unknown
  /** Error message if success is false. */
  error?: string
  /** Action that was executed (echoed back for audit). */
  action: ComputerUseAction
}

// ── Canvas op WS protocol types ──

export interface CanvasOpRequest {
  id: string
  op: string  // 'addNode' | 'removeNode' | 'connect' | 'disconnect' | 'setWidget' | 'getCanvasState' | 'runQueue'
  args: Record<string, unknown>
}

export interface CanvasOpResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

// ── Helper: is this a canvas action (goes to JS extension via WS)? ──

const CANVAS_ACTION_TYPES = new Set([
  'addNode', 'removeNode', 'connect', 'disconnect',
  'setWidget', 'getCanvasState', 'runQueue',
])

export function isCanvasAction(action: ComputerUseAction): boolean {
  return CANVAS_ACTION_TYPES.has(action.type)
}

// ── Helper: is this a visual/UI action (goes to Playwright)? ──

const VISUAL_ACTION_TYPES = new Set([
  'screenshot', 'click', 'type', 'scroll', 'drag', 'key', 'wait',
])

export function isVisualAction(action: ComputerUseAction): boolean {
  return VISUAL_ACTION_TYPES.has(action.type)
}
```

- [ ] **Step 5: Write the generic provider stub**

Create `sga_template/src/computer-use/providers/generic.ts`:

```typescript
import type { ComputerUseAction, ComputerUseResult } from '../types.js'

/**
 * Generic fallback provider adapter.
 *
 * Placeholder — full implementation is Phase 3 (out of scope for this plan).
 * Throws to make clear it's not yet available.
 */
export class GenericComputerUseAdapter {
  readonly name = 'generic'

  async sendScreenshotAndGetCurrentAction(
    _screenshotBase64: string,
    _instructions: string,
  ): Promise<ComputerUseAction> {
    throw new Error('GenericComputerUseAdapter not implemented (Phase 3)')
  }

  async interpretActionResult(_result: ComputerUseResult): Promise<string> {
    throw new Error('GenericComputerUseAdapter not implemented (Phase 3)')
  }
}
```

- [ ] **Step 6: Verify compilation**

Run: `cd sga_template && npx tsc --noEmit`
Expected: no errors (the new files compile cleanly)

- [ ] **Step 7: Commit**

```bash
cd sga_template
git add src/computer-use/types.ts src/computer-use/providers/generic.ts package.json package-lock.json
git commit -m "feat(computer-use): add dependencies and type definitions"
```

---

## Task 2: Orchestrator — session lifecycle and Playwright

**Files:**
- Create: `sga_template/src/computer-use/orchestrator.ts`
- Create: `sga_template/src/computer-use/orchestrator.test.ts`

**Interfaces:**
- Consumes: `ComputerUseConfig`, `ComputerUseSessionState`, `DEFAULT_COMPUTER_USE_CONFIG` from `types.ts`
- Produces: `ComputerUseOrchestrator` class with `start()`, `stop()`, `getStatus()`, `screenshot()`, `executeAction()`

- [ ] **Step 1: Write the failing test for orchestrator lifecycle**

Create `sga_template/src/computer-use/orchestrator.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ComputerUseOrchestrator } from './orchestrator.js'
import { ComputerUseSessionState } from './types.js'

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

describe('ComputerUseOrchestrator', () => {
  let orchestrator: ComputerUseOrchestrator

  beforeEach(() => {
    orchestrator = new ComputerUseOrchestrator({
      comfyuiUrl: 'http://127.0.0.1:8188',
      headless: true,  // use headless in tests
      sessionTimeoutMs: 5000,
    })
  })

  afterEach(async () => {
    await orchestrator.stop()
  })

  it('starts in idle state', () => {
    expect(orchestrator.getStatus().state).toBe('idle')
  })

  it('transitions to ready after start()', async () => {
    await orchestrator.start()
    expect(orchestrator.getStatus().state).toBe('ready')
    expect(orchestrator.getStatus().browserConnected).toBe(true)
  })

  it('transitions to stopped after stop()', async () => {
    await orchestrator.start()
    await orchestrator.stop()
    expect(orchestrator.getStatus().state).toBe('stopped')
    expect(orchestrator.getStatus().browserConnected).toBe(false)
  })

  it('returns a screenshot from takeScreenshot()', async () => {
    await orchestrator.start()
    const screenshot = await orchestrator.takeScreenshot()
    expect(screenshot).toBeTruthy()
    expect(typeof screenshot).toBe('string')
  })

  it('throws when takeScreenshot() called before start()', async () => {
    await expect(orchestrator.takeScreenshot()).rejects.toThrow(/not started|idle/i)
  })

  it('throws when start() called twice without stop()', async () => {
    await orchestrator.start()
    await expect(orchestrator.start()).rejects.toThrow(/already running/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/orchestrator.test.ts`
Expected: FAIL with "Cannot find module './orchestrator.js'" or similar

- [ ] **Step 3: Write the orchestrator implementation**

Create `sga_template/src/computer-use/orchestrator.ts`:

```typescript
import { chromium, type Browser, type Page } from 'playwright'
import { createLogger } from '../../utils/logger.js'
import {
  type ComputerUseConfig,
  type ComputerUseSessionState,
  type ComputerUseAction,
  type ComputerUseResult,
  DEFAULT_COMPUTER_USE_CONFIG,
  isCanvasAction,
} from './types.js'
import { ActionExecutor } from './action-executor.js'

const logger = createLogger('computer-use:orchestrator')

export interface OrchestratorStatus {
  state: ComputerUseSessionState
  browserConnected: boolean
  extensionConnected: boolean
  startedAt?: number
  config: ComputerUseConfig
}

export class ComputerUseOrchestrator {
  private config: ComputerUseConfig
  private state: ComputerUseSessionState = 'idle'
  private browser: Browser | null = null
  private page: Page | null = null
  private startedAt: number | undefined
  private actionExecutor: ActionExecutor
  private extensionConnected = false
  private sessionTimeoutHandle: NodeJS.Timeout | null = null

  constructor(config?: Partial<ComputerUseConfig>) {
    this.config = { ...DEFAULT_COMPUTER_USE_CONFIG, ...config }
    this.actionExecutor = new ActionExecutor()
  }

  getStatus(): OrchestratorStatus {
    return {
      state: this.state,
      browserConnected: this.browser !== null,
      extensionConnected: this.extensionConnected,
      startedAt: this.startedAt,
      config: this.config,
    }
  }

  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') {
      throw new Error(`Computer use session already running (state: ${this.state})`)
    }

    this.state = 'starting'
    logger.info(`Starting computer use session, navigating to ${this.config.comfyuiUrl}`)

    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      })
      this.page = await this.browser.newPage()
      await this.page.goto(this.config.comfyuiUrl, { waitUntil: 'domcontentloaded' })

      // Wait briefly for the JS extension to connect via WS.
      // In Phase 1, the WS server will signal this; for Phase 0, we just wait.
      await this.page.waitForTimeout(2000)

      this.startedAt = Date.now()
      this.state = 'ready'

      // Set session timeout
      this.sessionTimeoutHandle = setTimeout(
        () => this.stop().catch(err => logger.error('Session timeout stop failed', err)),
        this.config.sessionTimeoutMs,
      )

      logger.info('Computer use session ready')
    } catch (error) {
      this.state = 'error'
      logger.error('Failed to start computer use session', error)
      await this.cleanup()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return
    }

    this.state = 'stopping'
    logger.info('Stopping computer use session')

    await this.cleanup()

    this.state = 'stopped'
    logger.info('Computer use session stopped')
  }

  private async cleanup(): Promise<void> {
    if (this.sessionTimeoutHandle) {
      clearTimeout(this.sessionTimeoutHandle)
      this.sessionTimeoutHandle = null
    }

    if (this.page) {
      try {
        await this.page.close()
      } catch (err) {
        logger.warn('Failed to close page', err)
      }
      this.page = null
    }

    if (this.browser) {
      try {
        await this.browser.close()
      } catch (err) {
        logger.warn('Failed to close browser', err)
      }
      this.browser = null
    }

    this.extensionConnected = false
  }

  async takeScreenshot(variant: 'full' | 'canvas' = 'full'): Promise<string> {
    if (!this.page) {
      throw new Error('Cannot take screenshot: browser not started (state: ' + this.state + ')')
    }

    const buffer = variant === 'canvas'
      ? await this.page.locator('#graph-canvas').screenshot()
      : await this.page.screenshot({ fullPage: true })

    return buffer.toString('base64')
  }

  async executeAction(action: ComputerUseAction): Promise<ComputerUseResult> {
    if (this.state !== 'ready') {
      throw new Error(`Cannot execute action: session not ready (state: ${this.state})`)
    }

    // For Phase 0, only screenshot is fully implemented.
    // Canvas actions require the WS bridge (Phase 1).
    if (isCanvasAction(action)) {
      return this.actionExecutor.executeCanvasAction(action)
    }

    // Visual actions use Playwright
    return this.actionExecutor.executeVisualAction(action, this.page!)
  }

  /** Called by the WS server when the JS extension connects. */
  setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected
    logger.info(`JS extension ${connected ? 'connected' : 'disconnected'}`)
  }

  /** Called by the WS server when a canvas op response arrives. */
  setCanvasOpResponseHandler(handler: (response: unknown) => void): void {
    this.actionExecutor.setCanvasOpResponseHandler(handler)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/orchestrator.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/computer-use/orchestrator.ts src/computer-use/orchestrator.test.ts
git commit -m "feat(computer-use): add orchestrator with session lifecycle and Playwright"
```

---

## Task 3: Action Executor — screenshot + stubs

**Files:**
- Create: `sga_template/src/computer-use/action-executor.ts`
- Create: `sga_template/src/computer-use/action-executor.test.ts`

**Interfaces:**
- Consumes: `ComputerUseAction`, `ComputerUseResult` from `types.ts`; `Page` from `playwright`
- Produces: `ActionExecutor` class with `executeVisualAction()`, `executeCanvasAction()`, `setCanvasOpResponseHandler()`

- [ ] **Step 1: Write the failing test**

Create `sga_template/src/computer-use/action-executor.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { ActionExecutor } from './action-executor.js'
import type { ComputerUseAction, ComputerUseResult } from './types.js'

describe('ActionExecutor', () => {
  const executor = new ActionExecutor()

  it('executes screenshot action via Playwright page', async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
    } as any

    const result = await executor.executeVisualAction(
      { type: 'screenshot', variant: 'full' },
      mockPage,
    )

    expect(result.success).toBe(true)
    expect(result.screenshot).toBe('cG5nLWJ5dGVz')  // base64 of 'png-bytes'
    expect(result.action.type).toBe('screenshot')
  })

  it('returns error for unimplemented visual action (click)', async () => {
    const mockPage = {} as any

    const result = await executor.executeVisualAction(
      { type: 'click', x: 100, y: 200 },
      mockPage,
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not implemented/i)
  })

  it('returns error for canvas action when bridge not connected', async () => {
    const result = await executor.executeCanvasAction(
      { type: 'addNode', nodeType: 'KSampler' },
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not connected|bridge/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/action-executor.test.ts`
Expected: FAIL with "Cannot find module './action-executor.js'"

- [ ] **Step 3: Write the implementation**

Create `sga_template/src/computer-use/action-executor.ts`:

```typescript
import type { Page } from 'playwright'
import { createLogger } from '../../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult } from './types.js'

const logger = createLogger('computer-use:action-executor')

export class ActionExecutor {
  private canvasOpResponseHandler: ((response: unknown) => void) | null = null
  private bridgeConnected = false

  /** Execute a visual/UI action via Playwright. */
  async executeVisualAction(
    action: ComputerUseAction,
    page: Page,
  ): Promise<ComputerUseResult> {
    switch (action.type) {
      case 'screenshot': {
        const buffer = action.variant === 'canvas'
          ? await page.locator('#graph-canvas').screenshot()
          : await page.screenshot({ fullPage: true })
        return {
          success: true,
          screenshot: buffer.toString('base64'),
          action,
        }
      }

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

      default:
        return {
          success: false,
          error: `Unknown visual action type: ${(action as ComputerUseAction).type}`,
          action,
        }
    }
  }

  /** Execute a canvas action via the JS extension WS bridge. */
  async executeCanvasAction(action: ComputerUseAction): Promise<ComputerUseResult> {
    if (!this.bridgeConnected) {
      return {
        success: false,
        error: 'Canvas bridge not connected (JS extension WS not available)',
        action,
      }
    }

    // Phase 1 will implement the actual WS round-trip here.
    // For now, this is a stub that returns not-implemented.
    return {
      success: false,
      error: `Canvas action "${action.type}" not yet wired to WS bridge`,
      action,
    }
  }

  setBridgeConnected(connected: boolean): void {
    this.bridgeConnected = connected
    logger.info(`Canvas bridge ${connected ? 'connected' : 'disconnected'}`)
  }

  setCanvasOpResponseHandler(handler: (response: unknown) => void): void {
    this.canvasOpResponseHandler = handler
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/action-executor.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/computer-use/action-executor.ts src/computer-use/action-executor.test.ts
git commit -m "feat(computer-use): add action executor with screenshot and stubs"
```

---

## Task 4: Anthropic provider adapter

**Files:**
- Create: `sga_template/src/computer-use/providers/anthropic.ts`
- Create: `sga_template/src/computer-use/providers/anthropic.test.ts`

**Interfaces:**
- Consumes: `ComputerUseAction`, `ComputerUseResult` from `../types.js`; provider config from `../../providers/types.js`
- Produces: `AnthropicComputerUseAdapter` class with `sendScreenshotAndGetCurrentAction()`

- [ ] **Step 1: Write the failing test**

Create `sga_template/src/computer-use/providers/anthropic.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { AnthropicComputerUseAdapter, normalizeAnthropicAction } from './anthropic.js'

describe('normalizeAnthropicAction', () => {
  it('converts left_click to click', () => {
    const result = normalizeAnthropicAction({ type: 'left_click', coordinate: [100, 200] })
    expect(result).toEqual({ type: 'click', x: 100, y: 200, button: 'left' })
  })

  it('converts type to type', () => {
    const result = normalizeAnthropicAction({ type: 'type', text: 'hello' })
    expect(result).toEqual({ type: 'type', text: 'hello' })
  })

  it('converts screenshot to screenshot', () => {
    const result = normalizeAnthropicAction({ type: 'screenshot' })
    expect(result).toEqual({ type: 'screenshot' })
  })

  it('converts scroll to scroll', () => {
    const result = normalizeAnthropicAction({ type: 'scroll', scroll_direction: 'down', scroll_amount: 3 })
    expect(result.type).toBe('scroll')
    expect(result.dy).toBeGreaterThan(0)
  })

  it('converts key to key', () => {
    const result = normalizeAnthropicAction({ type: 'key', text: 'Return' })
    expect(result).toEqual({ type: 'key', combo: 'Return' })
  })

  it('converts left_click_drag to drag', () => {
    const result = normalizeAnthropicAction({
      type: 'left_click_drag',
      start_coordinate: [10, 20],
      coordinate: [30, 40],
    })
    expect(result).toEqual({ type: 'drag', fromX: 10, fromY: 20, toX: 30, toY: 40 })
  })

  it('throws on unknown action type', () => {
    expect(() => normalizeAnthropicAction({ type: 'unknown_action' })).toThrow(/unknown.*action/i)
  })
})

describe('AnthropicComputerUseAdapter', () => {
  it('builds the correct request body with computer tool and screenshot', () => {
    const adapter = new AnthropicComputerUseAdapter({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-20250514',
    })

    const body = adapter.buildRequestBody('base64png==', 'What do you see?')

    expect(body.model).toBe('claude-sonnet-4-20250514')
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'computer_20241022' }),
      ]),
    )
    expect(body.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'text' }),
      ]),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/providers/anthropic.test.ts`
Expected: FAIL with "Cannot find module './anthropic.js'"

- [ ] **Step 3: Write the implementation**

Create `sga_template/src/computer-use/providers/anthropic.ts`:

```typescript
import { createLogger } from '../../../utils/logger.js'
import type { ComputerUseAction } from '../types.js'

const logger = createLogger('computer-use:anthropic')

export interface AnthropicAdapterConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

interface AnthropicRawAction {
  type: string
  coordinate?: [number, number]
  text?: string
  start_coordinate?: [number, number]
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  scroll_amount?: number
  duration?: number
}

/** Convert an Anthropic raw tool_use action into our normalized ComputerUseAction. */
export function normalizeAnthropicAction(raw: AnthropicRawAction): ComputerUseAction {
  switch (raw.type) {
    case 'screenshot':
      return { type: 'screenshot' }

    case 'left_click':
    case 'right_click':
    case 'middle_click': {
      if (!raw.coordinate || raw.coordinate.length !== 2) {
        throw new Error(`Action "${raw.type}" requires coordinate [x, y]`)
      }
      return {
        type: 'click',
        x: raw.coordinate[0],
        y: raw.coordinate[1],
        button: raw.type.replace('_click', '') as 'left' | 'right' | 'middle',
      }
    }

    case 'double_click':
    case 'triple_click': {
      if (!raw.coordinate || raw.coordinate.length !== 2) {
        throw new Error(`Action "${raw.type}" requires coordinate [x, y]`)
      }
      // Normalize multi-clicks to a single click for now; Playwright can handle
      // multi-click via the key action or a future click count field.
      return {
        type: 'click',
        x: raw.coordinate[0],
        y: raw.coordinate[1],
        button: 'left',
      }
    }

    case 'type': {
      if (!raw.text) {
        throw new Error('Action "type" requires text')
      }
      return { type: 'type', text: raw.text }
    }

    case 'key': {
      if (!raw.text) {
        throw new Error('Action "key" requires text (key combo)')
      }
      return { type: 'key', combo: raw.text }
    }

    case 'scroll': {
      const amount = raw.scroll_amount ?? 1
      const dy = raw.scroll_direction === 'down' ? amount * 100
        : raw.scroll_direction === 'up' ? -amount * 100
        : 0
      const dx = raw.scroll_direction === 'right' ? amount * 100
        : raw.scroll_direction === 'left' ? -amount * 100
        : 0
      return { type: 'scroll', dx, dy }
    }

    case 'left_click_drag': {
      if (!raw.start_coordinate || !raw.coordinate) {
        throw new Error('Action "left_click_drag" requires start_coordinate and coordinate')
      }
      return {
        type: 'drag',
        fromX: raw.start_coordinate[0],
        fromY: raw.start_coordinate[1],
        toX: raw.coordinate[0],
        toY: raw.coordinate[1],
      }
    }

    case 'wait': {
      const ms = (raw.duration ?? 2) * 1000
      return { type: 'wait', ms }
    }

    case 'cursor_position':
      // Not a real action; return a screenshot to let the model see current state.
      return { type: 'screenshot' }

    case 'mouse_move': {
      if (!raw.coordinate) {
        throw new Error('Action "mouse_move" requires coordinate')
      }
      // Mouse move without click is a no-op for our purposes; screenshot to confirm.
      return { type: 'screenshot' }
    }

    default:
      throw new Error(`Unknown Anthropic action type: ${raw.type}`)
  }
}

export class AnthropicComputerUseAdapter {
  readonly name = 'anthropic'
  private config: AnthropicAdapterConfig

  constructor(config: AnthropicAdapterConfig) {
    this.config = config
  }

  /** Build the Messages API request body for a screenshot + instructions. */
  buildRequestBody(screenshotBase64: string, instructions: string): Record<string, unknown> {
    return {
      model: this.config.model,
      max_tokens: 4096,
      tools: [
        {
          type: 'computer_20241022',
          name: 'computer',
          display_width_px: 1280,
          display_height_px: 720,
          display_number: 1,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshotBase64,
              },
            },
            {
              type: 'text',
              text: instructions,
            },
          ],
        },
      ],
    }
  }

  /** Send screenshot + instructions, parse the model's action response. */
  async sendScreenshotAndGetCurrentAction(
    screenshotBase64: string,
    instructions: string,
  ): Promise<ComputerUseAction> {
    const body = this.buildRequestBody(screenshotBase64, instructions)
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com'

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2024-10-22',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic API error ${response.status}: ${text}`)
    }

    const data = await response.json()

    // Find the tool_use block in the response content
    const toolUseBlock = (data.content as unknown[]).find(
      (block: any) => block.type === 'tool_use',
    )

    if (!toolUseBlock) {
      // Model didn't request an action; default to screenshot to continue the loop.
      logger.warn('No tool_use block in Anthropic response, defaulting to screenshot')
      return { type: 'screenshot' }
    }

    return normalizeAnthropicAction(toolUseBlock.input as AnthropicRawAction)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/providers/anthropic.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/computer-use/providers/anthropic.ts src/computer-use/providers/anthropic.test.ts
git commit -m "feat(computer-use): add Anthropic Claude Computer Use adapter"
```

---

## Task 5: `computer_use` built-in tool

**Files:**
- Create: `sga_template/src/tools/built-in/computer-use.ts`
- Modify: `sga_template/src/tools/built-in/index.ts`

**Interfaces:**
- Consumes: `Tool`, `BaseTool`, `ToolInputSchema`, `ValidationResult`, `ToolUseContext` from `../base.js`; `ComputerUseOrchestrator` from `../../computer-use/orchestrator.js`
- Produces: `ComputerUseTool` class, `setComputerUseOrchestrator()` / `getComputerUseOrchestrator()` registry functions

- [ ] **Step 1: Write the tool implementation**

Create `sga_template/src/tools/built-in/computer-use.ts`:

```typescript
import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { createLogger } from '../../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult } from '../../computer-use/types.js'
import type { ComputerUseOrchestrator } from '../../computer-use/orchestrator.js'

const logger = createLogger('tool:computer-use')

// Singleton orchestrator reference — set by the route handler when user toggles on.
let activeOrchestrator: ComputerUseOrchestrator | null = null

export function setComputerUseOrchestrator(orch: ComputerUseOrchestrator | null): void {
  activeOrchestrator = orch
}

export function getComputerUseOrchestrator(): ComputerUseOrchestrator | null {
  return activeOrchestrator
}

export class ComputerUseTool extends BaseTool<
  { action: string; args?: Record<string, unknown> },
  string
> {
  name = 'computer_use'
  description = `Operate ComfyUI via computer use (screenshot + multimodal model + browser automation).
Accepts an action name and optional args. The orchestrator must be started first (via the UI toggle).
Actions:
  - screenshot: take a screenshot of the ComfyUI canvas
  - addNode: add a node to the canvas (args: nodeType, x?, y?)
  - removeNode: remove a node (args: nodeId)
  - connect: connect two nodes (args: fromNodeId, fromSlot, toNodeId, toSlot)
  - disconnect: remove a link (args: linkId)
  - setWidget: set a widget value (args: nodeId, widgetName, value)
  - getCanvasState: return the current canvas graph as JSON
  - runQueue: submit the current workflow for execution`
  searchHint = 'computer use screenshot canvas browser automation click type'

  isEnabled(): boolean {
    return activeOrchestrator !== null
  }

  isReadOnly(input: { action: string }): boolean {
    return input.action === 'screenshot' || input.action === 'getCanvasState'
  }

  isConcurrencySafe(): boolean {
    return false
  }

  isDestructive(input: { action: string }): boolean {
    return input.action === 'runQueue' || input.action === 'removeNode'
  }

  requiresUserInteraction(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' }
    }
    const obj = input as Record<string, unknown>
    if (!obj.action || typeof obj.action !== 'string') {
      return { success: false, error: 'Input must have a string "action" field' }
    }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The action to perform: screenshot, addNode, removeNode, connect, disconnect, setWidget, getCanvasState, runQueue',
        },
        args: {
          type: 'object',
          description: 'Action-specific arguments (e.g. {nodeType: "KSampler"} for addNode)',
        },
      },
      required: ['action'],
    }
  }

  async call(
    input: { action: string; args?: Record<string, unknown> },
    _context: ToolUseContext,
  ): Promise<string> {
    if (!activeOrchestrator) {
      return 'Computer use is not active. Toggle it on in the chat panel header first.'
    }

    // Build the normalized action from the tool input
    const action = this.buildAction(input.action, input.args)
    if (!action) {
      return `Unknown action: ${input.action}. Valid actions: screenshot, addNode, removeNode, connect, disconnect, setWidget, getCanvasState, runQueue`
    }

    try {
      const result: ComputerUseResult = await activeOrchestrator.executeAction(action)

      if (!result.success) {
        return `Action "${input.action}" failed: ${result.error ?? 'unknown error'}`
      }

      // Format the result for the agent
      if (result.screenshot) {
        return `[Screenshot taken — ${result.screenshot.length} bytes base64 PNG. Use analyze_canvas to interpret it, or continue with the next action.]`
      }
      if (result.data !== undefined) {
        return JSON.stringify(result.data, null, 2)
      }
      return `Action "${input.action}" completed successfully.`
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`computer_use action "${input.action}" failed`, error)
      return `Action "${input.action}" threw: ${msg}`
    }
  }

  private buildAction(name: string, args?: Record<string, unknown>): ComputerUseAction | null {
    switch (name) {
      case 'screenshot':
        return { type: 'screenshot' }
      case 'addNode':
        return {
          type: 'addNode',
          nodeType: String(args?.nodeType ?? ''),
          x: args?.x as number | undefined,
          y: args?.y as number | undefined,
        }
      case 'removeNode':
        return { type: 'removeNode', nodeId: String(args?.nodeId ?? '') }
      case 'connect':
        return {
          type: 'connect',
          fromNodeId: String(args?.fromNodeId ?? ''),
          fromSlot: Number(args?.fromSlot ?? 0),
          toNodeId: String(args?.toNodeId ?? ''),
          toSlot: Number(args?.toSlot ?? 0),
        }
      case 'disconnect':
        return { type: 'disconnect', linkId: String(args?.linkId ?? '') }
      case 'setWidget':
        return {
          type: 'setWidget',
          nodeId: String(args?.nodeId ?? ''),
          widgetName: String(args?.widgetName ?? ''),
          value: args?.value,
        }
      case 'getCanvasState':
        return { type: 'getCanvasState' }
      case 'runQueue':
        return { type: 'runQueue', prompt: args?.prompt as Record<string, unknown> | undefined }
      default:
        return null
    }
  }
}
```

- [ ] **Step 2: Register the tool in `index.ts`**

Open `sga_template/src/tools/built-in/index.ts`. Add to the export block:

```typescript
export { ComputerUseTool, setComputerUseOrchestrator, getComputerUseOrchestrator } from './computer-use.js'
```

Add to the import block:

```typescript
import { ComputerUseTool } from './computer-use.js'
```

Add `new ComputerUseTool()` to the array in `createBuiltinTools()`:

```typescript
    new ComfyUIAPITool(),
    new ComputerUseTool(),
  ]
```

- [ ] **Step 3: Verify compilation**

Run: `cd sga_template && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd sga_template
git add src/tools/built-in/computer-use.ts src/tools/built-in/index.ts
git commit -m "feat(computer-use): add computer_use built-in tool and register it"
```

---

## Task 6: HTTP routes — start, status, stop

**Files:**
- Modify: `sga_template/src/server/routes.ts` (add handlers)
- Modify: `sga_template/src/server/app.ts` (register routes)

**Interfaces:**
- Consumes: `ComputerUseOrchestrator` from `../computer-use/orchestrator.js`; `setComputerUseOrchestrator` from `../tools/built-in/computer-use.js`
- Produces: `handleComputerUseStart`, `handleComputerUseStatus`, `handleComputerUseStop` handlers

- [ ] **Step 1: Add route handlers to `routes.ts`**

Open `sga_template/src/server/routes.ts`. Add these handler functions (place them near the end of the file, before the last export or after the existing handler functions):

```typescript
// ── Computer Use ──

import { ComputerUseOrchestrator } from '../computer-use/orchestrator.js'
import { setComputerUseOrchestrator } from '../tools/built-in/computer-use.js'
import { DEFAULT_COMPUTER_USE_CONFIG } from '../computer-use/types.js'

let computerUseOrchestrator: ComputerUseOrchestrator | null = null

export function handleComputerUseStatus(_req: Request, res: Response): void {
  if (!computerUseOrchestrator) {
    res.json({
      state: 'idle',
      browserConnected: false,
      extensionConnected: false,
      config: DEFAULT_COMPUTER_USE_CONFIG,
    })
    return
  }
  res.json(computerUseOrchestrator.getStatus())
}

export async function handleComputerUseStart(req: Request, res: Response): Promise<void> {
  if (computerUseOrchestrator) {
    const status = computerUseOrchestrator.getStatus()
    if (status.state === 'ready' || status.state === 'starting') {
      res.status(409).json({ error: `Computer use already active (state: ${status.state})` })
      return
    }
  }

  const body = req.body ?? {}
  const config = {
    comfyuiUrl: body.comfyuiUrl ?? DEFAULT_COMPUTER_USE_CONFIG.comfyuiUrl,
    headless: body.headless ?? DEFAULT_COMPUTER_USE_CONFIG.headless,
    sessionTimeoutMs: body.sessionTimeoutMs ?? DEFAULT_COMPUTER_USE_CONFIG.sessionTimeoutMs,
  }

  computerUseOrchestrator = new ComputerUseOrchestrator(config)
  setComputerUseOrchestrator(computerUseOrchestrator)

  try {
    await computerUseOrchestrator.start()
    res.status(201).json(computerUseOrchestrator.getStatus())
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    res.status(500).json({ error: `Failed to start computer use: ${msg}` })
  }
}

export async function handleComputerUseStop(_req: Request, res: Response): Promise<void> {
  if (!computerUseOrchestrator) {
    res.json({ state: 'idle', message: 'Computer use not active' })
    return
  }

  try {
    await computerUseOrchestrator.stop()
    setComputerUseOrchestrator(null)
    res.json({ state: 'stopped', message: 'Computer use stopped' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    res.status(500).json({ error: `Failed to stop computer use: ${msg}` })
  }
}
```

Note: the `Request` and `Response` types are already imported at the top of `routes.ts` from Express. Adjust the import placement if your linter requires imports at the top — move the three `import` lines to the existing import block at the top of the file and keep only the handler functions at the bottom.

- [ ] **Step 2: Register routes in `app.ts`**

Open `sga_template/src/server/app.ts`. Add to the import block from `./routes.js`:

```typescript
import {
  // ... existing imports ...
  handleComputerUseStart,
  handleComputerUseStatus,
  handleComputerUseStop,
} from './routes.js'
```

In the `createApp` function, after the existing route registrations (around line 274, before the legacy `/api/` routes), add:

```typescript
  // Computer Use
  app.get(`${base}/computer-use/status`, handleComputerUseStatus)
  app.post(`${base}/computer-use/start`, handleComputerUseStart)
  app.post(`${base}/computer-use/stop`, handleComputerUseStop)
```

- [ ] **Step 3: Verify compilation**

Run: `cd sga_template && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `cd sga_template && npm test`
Expected: all existing tests still pass (no new test failures)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/server/routes.ts src/server/app.ts
git commit -m "feat(computer-use): add start/status/stop HTTP routes"
```

---

## Task 7: UI toggle component

**Files:**
- Create: `ui/src/components/ComputerUseToggle.tsx`
- Modify: `ui/src/components/ChatPanel.tsx`
- Modify: `ui/src/services/configService.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `backendUrl` prop, `configService` API functions
- Produces: `ComputerUseToggle` React component with on/off state

- [ ] **Step 1: Add API service functions to `configService.ts`**

Open `ui/src/services/configService.ts`. Add these functions (place them after the existing exported functions):

```typescript
// ── Computer Use ──

export interface ComputerUseStatus {
  state: 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'error'
  browserConnected: boolean
  extensionConnected: boolean
  startedAt?: number
  config: { comfyuiUrl: string; headless: boolean; sessionTimeoutMs: number }
}

export const getComputerUseStatus = async (backendUrl: string): Promise<ComputerUseStatus> => {
  const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/computer-use/status`)
  if (!res.ok) throw new Error('Failed to get computer use status')
  return res.json()
}

export const startComputerUse = async (backendUrl: string): Promise<ComputerUseStatus> => {
  const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/computer-use/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(data.error || 'Failed to start computer use')
  }
  return res.json()
}

export const stopComputerUse = async (backendUrl: string): Promise<{ state: string; message: string }> => {
  const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/computer-use/stop`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Failed to stop computer use')
  return res.json()
}
```

- [ ] **Step 2: Create the toggle component**

Create `ui/src/components/ComputerUseToggle.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { Monitor, MonitorOff, Loader2 } from 'lucide-react'

interface ComputerUseToggleProps {
  backendUrl: string
  onStateChange?: (active: boolean) => void
}

export function ComputerUseToggle({ backendUrl, onStateChange }: ComputerUseToggleProps) {
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (active) {
        await import('../services/configService').then(m => m.stopComputerUse(backendUrl))
        setActive(false)
        onStateChange?.(false)
      } else {
        await import('../services/configService').then(m => m.startComputerUse(backendUrl))
        setActive(true)
        onStateChange?.(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [active, backendUrl, onStateChange])

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleToggle}
        disabled={loading}
        title={error ?? (active ? 'Computer Use active — click to stop' : 'Start Computer Use')}
        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
          active
            ? 'bg-purple-600 text-white hover:bg-purple-500'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : active ? (
          <Monitor className="w-3.5 h-3.5" />
        ) : (
          <MonitorOff className="w-3.5 h-3.5" />
        )}
        CU
      </button>
      {error && (
        <span className="text-[10px] text-red-400 max-w-[120px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add the toggle to `ChatPanel.tsx` header**

Open `ui/src/components/ChatPanel.tsx`. 

Add import at the top:

```typescript
import { ComputerUseToggle } from './ComputerUseToggle'
```

In the `ChatPanelProps` interface (around line 188), add:

```typescript
  backendUrl?: string
```

In the header section (around line 305, inside the `flex items-center justify-between gap-2` div), add the toggle before or after the SGA/Codex switch:

```tsx
          {backendUrl && (
            <ComputerUseToggle backendUrl={backendUrl} />
          )}
```

- [ ] **Step 4: Pass `backendUrl` from `App.tsx`**

Open `ui/src/App.tsx`. Find where `<ChatPanel` is rendered (around line 1343). Add the `backendUrl` prop:

```tsx
        <ChatPanel
          // ... existing props ...
          backendUrl={backendUrl}
        />
```

- [ ] **Step 5: Verify UI builds**

Run: `cd ui && npm run verify`
Expected: typecheck + lint + build all pass

- [ ] **Step 6: Commit**

```bash
cd ui
git add src/components/ComputerUseToggle.tsx src/components/ChatPanel.tsx src/services/configService.ts src/App.tsx
git commit -m "feat(computer-use): add UI toggle in chat panel header"
```

---

## Task 8: WebSocket server for JS extension communication

**Files:**
- Create: `sga_template/src/computer-use/ws-server.ts`
- Create: `sga_template/src/computer-use/ws-server.test.ts`
- Modify: `sga_template/src/server/app.ts` (capture http.Server, attach WS)

**Interfaces:**
- Consumes: `http.Server` (captured from `app.listen`), `ComputerUseOrchestrator`
- Produces: `ComputerUseWSServer` class with `attach(httpServer)`, `broadcast()`, `sendCanvasOp()`

- [ ] **Step 1: Write the failing test**

Create `sga_template/src/computer-use/ws-server.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { WebSocket as WSClient, WebSocketServer } from 'ws'
import { ComputerUseWSServer } from './ws-server.js'

describe('ComputerUseWSServer', () => {
  let httpServer: http.Server
  let wsServer: ComputerUseWSServer
  let port: number

  beforeEach(async () => {
    httpServer = http.createServer()
    wsServer = new ComputerUseWSServer()
    wsServer.attach(httpServer, '/api/v1/computer-use/ws')
    await new Promise<void>(resolve => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        if (addr && typeof addr === 'object') {
          port = addr.port
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })

  it('accepts a WS client connection and emits connect event', async () => {
    let connected = false
    wsServer.onConnect(() => { connected = true })

    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    expect(connected).toBe(true)
    client.close()
  })

  it('receives canvas op responses from the client and routes them', async () => {
    let receivedResponse: any = null
    wsServer.onCanvasOpResponse((resp) => { receivedResponse = resp })

    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    client.send(JSON.stringify({ id: 'test-1', success: true, data: { nodes: 3 } }))

    await new Promise<void>(resolve => setTimeout(resolve, 100))

    expect(receivedResponse).toEqual({ id: 'test-1', success: true, data: { nodes: 3 } })
    client.close()
  })

  it('sends canvas op requests to the connected client', async () => {
    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    let receivedMessage: any = null
    client.on('message', (data) => {
      receivedMessage = JSON.parse(data.toString())
    })

    wsServer.sendCanvasOp({ id: 'op-1', op: 'getCanvasState', args: {} })

    await new Promise<void>(resolve => setTimeout(resolve, 100))

    expect(receivedMessage).toEqual({ id: 'op-1', op: 'getCanvasState', args: {} })
    client.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/ws-server.test.ts`
Expected: FAIL with "Cannot find module './ws-server.js'"

- [ ] **Step 3: Write the implementation**

Create `sga_template/src/computer-use/ws-server.ts`:

```typescript
import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createLogger } from '../../utils/logger.js'
import type { CanvasOpRequest, CanvasOpResponse } from './types.js'

const logger = createLogger('computer-use:ws-server')

export class ComputerUseWSServer {
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private connectHandlers: Array<() => void> = []
  private disconnectHandlers: Array<() => void> = []
  private canvasOpResponseHandlers: Array<(response: CanvasOpResponse) => void> = []
  private pendingRequests: Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }> = new Map()

  attach(httpServer: HttpServer, path: string): void {
    this.wss = new WebSocketServer({ server: httpServer, path })

    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('JS extension WS client connected')

      // Only allow one client at a time (the dedicated browser or the user's browser)
      if (this.client) {
        logger.warn('Replacing existing JS extension client')
        this.client.close()
      }
      this.client = ws
      this.connectHandlers.forEach(h => h())

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())

          // Check if this is a canvas op response
          if (msg.id !== undefined && (msg.success !== undefined || msg.error !== undefined)) {
            const response = msg as CanvasOpResponse
            this.canvasOpResponseHandlers.forEach(h => h(response))

            // Resolve pending promise if any
            const pending = this.pendingRequests.get(response.id)
            if (pending) {
              clearTimeout(pending.timeout)
              this.pendingRequests.delete(response.id)
              if (response.success) {
                pending.resolve(response.data)
              } else {
                pending.reject(new Error(response.error ?? 'Canvas op failed'))
              }
            }
          }
        } catch (err) {
          logger.warn('Failed to parse WS message', err)
        }
      })

      ws.on('close', () => {
        logger.info('JS extension WS client disconnected')
        if (this.client === ws) {
          this.client = null
          this.disconnectHandlers.forEach(h => h())
        }
      })

      ws.on('error', (err: Error) => {
        logger.error('JS extension WS client error', err)
      })
    })
  }

  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler)
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler)
  }

  onCanvasOpResponse(handler: (response: CanvasOpResponse) => void): void {
    this.canvasOpResponseHandlers.push(handler)
  }

  get isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN
  }

  /** Send a canvas op request to the JS extension. */
  sendCanvasOp(request: CanvasOpRequest): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('JS extension not connected')
    }
    this.client.send(JSON.stringify(request))
  }

  /** Send a canvas op request and await the response (promise-based). */
  async sendCanvasOpAndWait(request: CanvasOpRequest, timeoutMs = 10000): Promise<unknown> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('JS extension not connected')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id)
        reject(new Error(`Canvas op "${request.op}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(request.id, { resolve, reject, timeout })
      this.client!.send(JSON.stringify(request))
    })
  }

  close(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('WS server closing'))
      this.pendingRequests.delete(id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/ws-server.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Modify `app.ts` to capture http.Server and attach WS server**

Open `sga_template/src/server/app.ts`. Find the `startServer` function. 

At the top of the file, add imports:

```typescript
import { ComputerUseWSServer } from '../computer-use/ws-server.js'
```

In `startServer`, change the `app.listen` call to capture the returned `http.Server`:

```typescript
  const httpServer = app.listen(port, host, () => {
    // ... existing callback ...
  })

  // Attach computer use WebSocket server
  const wsServer = new ComputerUseWSServer()
  wsServer.attach(httpServer, `${base}/computer-use/ws`)
```

Add graceful shutdown for the WS server in the existing shutdown handler:

```typescript
  // In the SIGINT/SIGTERM handler or cleanup section:
  wsServer.close()
```

- [ ] **Step 6: Wire WS server events to the orchestrator**

In the `handleComputerUseStart` handler in `routes.ts`, after creating the orchestrator, wire the WS server:

```typescript
import { ComputerUseWSServer } from '../computer-use/ws-server.js'

// At module level in routes.ts:
let computerUseWSServer: ComputerUseWSServer | null = null

// Add a setter called from app.ts during startup:
export function setComputerUseWSServer(ws: ComputerUseWSServer): void {
  computerUseWSServer = ws
}
```

Then in `handleComputerUseStart`, after `computerUseOrchestrator.start()`:

```typescript
    if (computerUseWSServer) {
      computerUseWSServer.onConnect(() => computerUseOrchestrator!.setExtensionConnected(true))
      computerUseWSServer.onDisconnect(() => computerUseOrchestrator!.setExtensionConnected(false))
    }
```

And in `app.ts`, after creating the WS server, call the setter:

```typescript
  setComputerUseWSServer(wsServer)
```

- [ ] **Step 7: Run all tests**

Run: `cd sga_template && npm test`
Expected: all tests pass (existing + new WS server tests)

- [ ] **Step 8: Commit**

```bash
cd sga_template
git add src/computer-use/ws-server.ts src/computer-use/ws-server.test.ts src/server/app.ts src/server/routes.ts
git commit -m "feat(computer-use): add WebSocket server for JS extension communication"
```

---

## Task 9: WS protocol spec document

**Files:**
- Create: `docs/superpowers/specs/computer-use-ws-protocol.md`

- [ ] **Step 1: Write the protocol spec**

Create `docs/superpowers/specs/computer-use-ws-protocol.md`:

```markdown
# Computer Use WebSocket Protocol

> Control channel between the SGA backend and the browser-side JS extension.

## Endpoint

`ws://127.0.0.1:8000/api/v1/computer-use/ws`

## Connection lifecycle

1. JS extension loads in the browser (via ComfyUI WEB_DIRECTORY) and opens a WS connection to the endpoint above.
2. SGA backend accepts the connection (only one client at a time; replaces existing if a new one connects).
3. Connection stays open for the duration of the ComfyUI page session.
4. On disconnect, the orchestrator degrades to Playwright-only mode (canvas ops unavailable).

## Message format

All messages are JSON strings with the following envelope:

### Canvas op request (SGA → JS extension)

```json
{
  "id": "<uuid>",
  "op": "addNode|removeNode|connect|disconnect|setWidget|getCanvasState|runQueue",
  "args": { ... op-specific args ... }
}
```

### Canvas op response (JS extension → SGA)

```json
{
  "id": "<uuid>",
  "success": true|false,
  "data": { ... },
  "error": "<message if failed>"
}
```

## Operations

### addNode

Request args: `{ "nodeType": string, "x"?: number, "y"?: number }`
Response data: `{ "nodeId": string }`

### removeNode

Request args: `{ "nodeId": string }`
Response data: `{}`

### connect

Request args: `{ "fromNodeId": string, "fromSlot": number, "toNodeId": string, "toSlot": number }`
Response data: `{ "linkId": string }`

### disconnect

Request args: `{ "linkId": string }`
Response data: `{}`

### setWidget

Request args: `{ "nodeId": string, "widgetName": string, "value": any }`
Response data: `{}`

### getCanvasState

Request args: `{}`
Response data: `{ "nodes": [...], "links": [...] }` (LiteGraph serialized graph)

### runQueue

Request args: `{ "prompt"?: object }`
Response data: `{ "promptId": string }`

## Error codes

| Error | Meaning |
|-------|---------|
| `UNKNOWN_OP` | The requested op is not recognized |
| `NODE_NOT_FOUND` | The specified nodeId does not exist on the canvas |
| `NODE_TYPE_UNKNOWN` | The specified nodeType is not registered |
| `LINK_NOT_FOUND` | The specified linkId does not exist |
| `WIDGET_NOT_FOUND` | The specified widgetName does not exist on the node |
| `INVALID_ARGS` | The args are malformed or missing required fields |
| `INTERNAL_ERROR` | An unexpected error occurred in the extension |

## Timeout

The SGA backend waits up to 10 seconds for a response. If no response arrives, the promise rejects with a timeout error and the orchestrator logs the failure.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/computer-use-ws-protocol.md
git commit -m "docs(computer-use): add WS protocol spec"
```

---

## Task 10: Browser-side JS extension

**Files:**
- Create: `web/computer-use-extension.js`

**Interfaces:**
- Consumes: `window.app` (ComfyUI global), LiteGraph API (`LGraph`, `LGraphNode`)
- Produces: a WS client that receives canvas op requests and responds with results

- [ ] **Step 1: Write the JS extension**

Create `web/computer-use-extension.js`:

```javascript
/**
 * ComfyUI Computer Use Extension
 *
 * Bridges the LiteGraph canvas API over WebSocket to the SGA backend.
 * Loaded by ComfyUI via the WEB_DIRECTORY mechanism.
 *
 * This file is plain ES module JS (not built by Vite) — it runs in the browser
 * alongside the ComfyUI frontend. It connects to the SGA backend WS endpoint
 * and handles canvas op requests.
 */

(function () {
  'use strict'

  const WS_URL = 'ws://127.0.0.1:8000/api/v1/computer-use/ws'
  const RECONNECT_INTERVAL_MS = 3000
  const OP_TIMEOUT_MS = 10000

  let ws = null
  let connected = false
  let reconnectTimer = null

  // ── LiteGraph helpers ──

  function getApp() {
    return window.app
  }

  function getCanvas() {
    const app = getApp()
    return app ? app.canvas : null
  }

  function getGraph() {
    const canvas = getCanvas()
    return canvas ? canvas.graph : null
  }

  // ── Op handlers ──

  const opHandlers = {
    addNode: function (args) {
      const canvas = getCanvas()
      if (!canvas) throw new Error('Canvas not available')

      const node = LiteGraph.createNode(args.nodeType)
      if (!node) throw new Error('NODE_TYPE_UNKNOWN: ' + args.nodeType)

      if (typeof args.x === 'number' && typeof args.y === 'number') {
        node.pos = [args.x, args.y]
      }

      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')
      graph.add(node)
      canvas.selectNode(node)
      graph.setDirtyCanvas(true, true)

      return { nodeId: node.id.toString() }
    },

    removeNode: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const node = graph.getNodeById(parseInt(args.nodeId, 10))
      if (!node) throw new Error('NODE_NOT_FOUND: ' + args.nodeId)

      graph.remove(node)
      graph.setDirtyCanvas(true, true)
      return {}
    },

    connect: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const fromNode = graph.getNodeById(parseInt(args.fromNodeId, 10))
      const toNode = graph.getNodeById(parseInt(args.toNodeId, 10))
      if (!fromNode) throw new Error('NODE_NOT_FOUND: ' + args.fromNodeId)
      if (!toNode) throw new Error('NODE_NOT_FOUND: ' + args.toNodeId)

      fromNode.connect(args.fromSlot, toNode, args.toSlot)
      graph.setDirtyCanvas(true, true)
      return { linkId: 'last' }
    },

    disconnect: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      // LiteGraph links are stored in graph.links as an array
      // Each link is [id, origin_id, origin_slot, target_id, target_slot, type]
      const link = graph.links ? graph.links[parseInt(args.linkId, 10)] : null
      if (!link) throw new Error('LINK_NOT_FOUND: ' + args.linkId)

      // Disconnect by finding the target node and disconnecting the input
      const targetNode = graph.getNodeById(link[3])
      if (targetNode) {
        targetNode.disconnectInput(link[4])
      }
      graph.setDirtyCanvas(true, true)
      return {}
    },

    setWidget: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const node = graph.getNodeById(parseInt(args.nodeId, 10))
      if (!node) throw new Error('NODE_NOT_FOUND: ' + args.nodeId)

      const widget = node.widgets ? node.widgets.find(function (w) { return w.name === args.widgetName }) : null
      if (!widget) throw new Error('WIDGET_NOT_FOUND: ' + args.widgetName)

      widget.value = args.value
      if (typeof widget.callback === 'function') {
        widget.callback(args.value)
      }
      graph.setDirtyCanvas(true, true)
      return {}
    },

    getCanvasState: function () {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      return {
        nodes: graph.nodes.map(function (n) {
          return {
            id: n.id.toString(),
            type: n.type,
            title: n.title,
            pos: n.pos,
            size: n.size,
            inputs: n.inputs ? n.inputs.map(function (i) { return { name: i.name, type: i.type, link: i.link } }) : [],
            outputs: n.outputs ? n.outputs.map(function (o) { return { name: o.name, type: o.type, links: o.links } }) : [],
            widgets: n.widgets ? n.widgets.map(function (w) { return { name: w.name, value: w.value, type: w.type } }) : [],
          }
        }),
        links: graph.links ? graph.links.map(function (link, idx) {
          if (!link) return null
          return { id: idx.toString(), origin_id: link[1], origin_slot: link[2], target_id: link[3], target_slot: link[4], type: link[5] }
        }).filter(Boolean) : [],
      }
    },

    runQueue: function (args) {
      const app = getApp()
      if (!app) throw new Error('App not available')

      // Use ComfyUI's queue prompt API
      if (app.queuePrompt) {
        app.queuePrompt(app.workflow_id || 0, args.prompt || app.workflow || {})
        return { promptId: 'queued' }
      }
      throw new Error('INTERNAL_ERROR: queuePrompt not available')
    },
  }

  // ── WS message handling ──

  function handleMessage(event) {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      console.error('[ComputerUse] Failed to parse WS message:', err)
      return
    }

    const handler = opHandlers[msg.op]
    if (!handler) {
      sendResponse(msg.id, false, undefined, 'UNKNOWN_OP: ' + msg.op)
      return
    }

    try {
      const data = handler(msg.args || {})
      sendResponse(msg.id, true, data)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      sendResponse(msg.id, false, undefined, errorMsg)
    }
  }

  function sendResponse(id, success, data, error) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const response = { id: id, success: success }
    if (success && data !== undefined) response.data = data
    if (!success && error) response.error = error
    ws.send(JSON.stringify(response))
  }

  // ── WS connection management ──

  function connect() {
    try {
      ws = new WebSocket(WS_URL)
    } catch (err) {
      console.warn('[ComputerUse] Failed to create WebSocket:', err)
      scheduleReconnect()
      return
    }

    ws.onopen = function () {
      console.log('[ComputerUse] WebSocket connected to SGA backend')
      connected = true
      if (reconnectTimer) {
        clearInterval(reconnectTimer)
        reconnectTimer = null
      }
    }

    ws.onmessage = handleMessage

    ws.onclose = function () {
      console.log('[ComputerUse] WebSocket disconnected')
      connected = false
      ws = null
      scheduleReconnect()
    }

    ws.onerror = function (err) {
      console.error('[ComputerUse] WebSocket error:', err)
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setInterval(function () {
      if (!connected) {
        console.log('[ComputerUse] Attempting to reconnect...')
        connect()
      }
    }, RECONNECT_INTERVAL_MS)
  }

  // ── Extension registration ──

  // Wait for ComfyUI's app to be available, then register the extension
  function tryRegister() {
    if (window.app && window.app.registerExtension) {
      window.app.registerExtension({
        name: 'Comfy.WorkflowAgent.ComputerUse',
        setup: function () {
          console.log('[ComputerUse] Extension setup, connecting WS...')
          connect()
        },
      })
      return true
    }
    return false
  }

  if (!tryRegister()) {
    const retry = setInterval(function () {
      if (tryRegister()) {
        clearInterval(retry)
      }
    }, 500)
  }
})()
```

- [ ] **Step 2: Verify the file is loadable**

The file is plain JS in `web/`. ComfyUI will auto-load it. No build step is needed. To verify syntax:

Run: `cd sga_template && node -e "require('../web/computer-use-extension.js')"` 
Note: this will fail because `window` and `WebSocket` don't exist in Node, but it should fail at runtime (not parse time). If there's a syntax error, it will fail at parse time.

Alternative: run `node --check web/computer-use-extension.js` to check syntax without executing.

- [ ] **Step 3: Commit**

```bash
git add web/computer-use-extension.js
git commit -m "feat(computer-use): add browser-side JS extension with WS client and LiteGraph bridge"
```

---

## Task 11: Wire canvas actions through the WS bridge in Action Executor

**Files:**
- Modify: `sga_template/src/computer-use/action-executor.ts`
- Create: `sga_template/src/computer-use/canvas-bridge.ts`
- Modify: `sga_template/src/computer-use/orchestrator.ts` (pass WS server reference)
- Modify: `sga_template/src/server/routes.ts` (wire WS server to orchestrator on start)

**Interfaces:**
- Consumes: `ComputerUseWSServer` from `./ws-server.js`; `CanvasOpRequest`, `CanvasOpResponse` from `./types.js`
- Produces: `CanvasBridge` class that wraps the WS server and provides `executeOp()` returning promises

- [ ] **Step 1: Write the canvas bridge**

Create `sga_template/src/computer-use/canvas-bridge.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../utils/logger.js'
import type { ComputerUseWSServer } from './ws-server.js'
import type { CanvasOpRequest, ComputerUseAction } from './types.js'

const logger = createLogger('computer-use:canvas-bridge')

export class CanvasBridge {
  private wsServer: ComputerUseWSServer

  constructor(wsServer: ComputerUseWSServer) {
    this.wsServer = wsServer
  }

  get isConnected(): boolean {
    return this.wsServer.isConnected
  }

  /** Execute a canvas action via the JS extension WS bridge. */
  async executeAction(action: ComputerUseAction): Promise<unknown> {
    const request = this.actionToRequest(action)
    return this.wsServer.sendCanvasOpAndWait(request)
  }

  private actionToRequest(action: ComputerUseAction): CanvasOpRequest {
    const id = randomUUID()

    switch (action.type) {
      case 'addNode':
        return { id, op: 'addNode', args: { nodeType: action.nodeType, x: action.x, y: action.y } }
      case 'removeNode':
        return { id, op: 'removeNode', args: { nodeId: action.nodeId } }
      case 'connect':
        return {
          id, op: 'connect',
          args: {
            fromNodeId: action.fromNodeId,
            fromSlot: action.fromSlot,
            toNodeId: action.toNodeId,
            toSlot: action.toSlot,
          },
        }
      case 'disconnect':
        return { id, op: 'disconnect', args: { linkId: action.linkId } }
      case 'setWidget':
        return {
          id, op: 'setWidget',
          args: { nodeId: action.nodeId, widgetName: action.widgetName, value: action.value },
        }
      case 'getCanvasState':
        return { id, op: 'getCanvasState', args: {} }
      case 'runQueue':
        return { id, op: 'runQueue', args: { prompt: action.prompt } }
      default:
        throw new Error(`Cannot convert action "${action.type}" to canvas op request`)
    }
  }
}
```

- [ ] **Step 2: Update Action Executor to use the canvas bridge**

Open `sga_template/src/computer-use/action-executor.ts`. Replace the `executeCanvasAction` method:

```typescript
  private canvasBridge: CanvasBridge | null = null

  setCanvasBridge(bridge: CanvasBridge): void {
    this.canvasBridge = bridge
  }

  /** Execute a canvas action via the JS extension WS bridge. */
  async executeCanvasAction(action: ComputerUseAction): Promise<ComputerUseResult> {
    if (!this.canvasBridge || !this.canvasBridge.isConnected) {
      return {
        success: false,
        error: 'Canvas bridge not connected (JS extension WS not available)',
        action,
      }
    }

    try {
      const data = await this.canvasBridge.executeAction(action)
      return {
        success: true,
        data,
        action,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        action,
      }
    }
  }
```

Add the import at the top:

```typescript
import type { CanvasBridge } from './canvas-bridge.js'
```

Remove the old `bridgeConnected` field and `setBridgeConnected` method (replaced by the canvas bridge).

- [ ] **Step 3: Update the orchestrator to accept a canvas bridge**

Open `sga_template/src/computer-use/orchestrator.ts`. Replace the `setCanvasOpResponseHandler` method and add `setCanvasBridge`:

```typescript
  setCanvasBridge(bridge: CanvasBridge): void {
    this.actionExecutor.setCanvasBridge(bridge)
  }
```

Add the import:

```typescript
import type { CanvasBridge } from './canvas-bridge.js'
```

Remove the old `setCanvasOpResponseHandler` method (no longer needed).

- [ ] **Step 4: Wire the canvas bridge in `routes.ts`**

Open `sga_template/src/server/routes.ts`. In `handleComputerUseStart`, after the orchestrator is created and the WS server event handlers are wired, create and set the canvas bridge:

```typescript
import { CanvasBridge } from '../computer-use/canvas-bridge.js'

// In handleComputerUseStart, after computerUseOrchestrator.start():
    if (computerUseWSServer) {
      const bridge = new CanvasBridge(computerUseWSServer)
      computerUseOrchestrator.setCanvasBridge(bridge)
      computerUseWSServer.onConnect(() => computerUseOrchestrator!.setExtensionConnected(true))
      computerUseWSServer.onDisconnect(() => computerUseOrchestrator!.setExtensionConnected(false))
    }
```

- [ ] **Step 5: Update the action executor test**

Open `sga_template/src/computer-use/action-executor.test.ts`. Update the "returns error for canvas action when bridge not connected" test:

```typescript
  it('returns error for canvas action when bridge not set', async () => {
    const executor = new ActionExecutor()

    const result = await executor.executeCanvasAction(
      { type: 'addNode', nodeType: 'KSampler' },
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not connected|bridge/i)
  })
```

- [ ] **Step 6: Write canvas bridge unit test**

Create `sga_template/src/computer-use/canvas-bridge.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { CanvasBridge } from './canvas-bridge.js'

describe('CanvasBridge', () => {
  it('converts addNode action to correct op request', () => {
    const mockWsServer = {
      isConnected: true,
      sendCanvasOpAndWait: vi.fn().mockResolvedValue({ nodeId: '42' }),
    } as any

    const bridge = new CanvasBridge(mockWsServer)
    bridge.executeAction({ type: 'addNode', nodeType: 'KSampler', x: 100, y: 200 })

    expect(mockWsServer.sendCanvasOpAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'addNode',
        args: { nodeType: 'KSampler', x: 100, y: 200 },
      }),
    )
  })

  it('returns data from WS server', async () => {
    const mockWsServer = {
      isConnected: true,
      sendCanvasOpAndWait: vi.fn().mockResolvedValue({ nodes: [] }),
    } as any

    const bridge = new CanvasBridge(mockWsServer)
    const result = await bridge.executeAction({ type: 'getCanvasState' })

    expect(result).toEqual({ nodes: [] })
  })

  it('throws when WS server not connected', async () => {
    const mockWsServer = {
      isConnected: false,
      sendCanvasOpAndWait: vi.fn(),
    } as any

    const bridge = new CanvasBridge(mockWsServer)

    // The bridge itself doesn't check isConnected — the WS server's
    // sendCanvasOpAndWait throws. But we test the path.
    await expect(bridge.executeAction({ type: 'getCanvasState' }))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 7: Run all tests**

Run: `cd sga_template && npm test`
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
cd sga_template
git add src/computer-use/canvas-bridge.ts src/computer-use/canvas-bridge.test.ts src/computer-use/action-executor.ts src/computer-use/action-executor.test.ts src/computer-use/orchestrator.ts src/server/routes.ts
git commit -m "feat(computer-use): wire canvas actions through WS bridge"
```

---

## Task 12: OpenAI CUA provider adapter

**Files:**
- Create: `sga_template/src/computer-use/providers/openai.ts`
- Create: `sga_template/src/computer-use/providers/openai.test.ts`

**Interfaces:**
- Consumes: `ComputerUseAction` from `../types.js`
- Produces: `OpenAIComputerUseAdapter` class with `sendScreenshotAndGetCurrentAction()`

- [ ] **Step 1: Write the failing test**

Create `sga_template/src/computer-use/providers/openai.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { OpenAIComputerUseAdapter, normalizeOpenAIAction } from './openai.js'

describe('normalizeOpenAIAction', () => {
  it('converts click to click', () => {
    const result = normalizeOpenAIAction({ type: 'click', x: 50, y: 75 })
    expect(result).toEqual({ type: 'click', x: 50, y: 75, button: 'left' })
  })

  it('converts type to type', () => {
    const result = normalizeOpenAIAction({ type: 'type', text: 'hello world' })
    expect(result).toEqual({ type: 'type', text: 'hello world' })
  })

  it('converts keypress to key', () => {
    const result = normalizeOpenAIAction({ type: 'keypress', keys: 'Enter' })
    expect(result).toEqual({ type: 'key', combo: 'Enter' })
  })

  it('converts scroll to scroll', () => {
    const result = normalizeOpenAIAction({ type: 'scroll', x: 0, y: 100 })
    expect(result.type).toBe('scroll')
    expect(result.dy).toBe(100)
  })

  it('converts drag to drag', () => {
    const result = normalizeOpenAIAction({
      type: 'drag',
      path: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    })
    expect(result).toEqual({ type: 'drag', fromX: 10, fromY: 20, toX: 30, toY: 40 })
  })

  it('converts wait to wait', () => {
    const result = normalizeOpenAIAction({ type: 'wait', duration: 2000 })
    expect(result).toEqual({ type: 'wait', ms: 2000 })
  })

  it('throws on unknown action type', () => {
    expect(() => normalizeOpenAIAction({ type: 'unknown' })).toThrow(/unknown.*action/i)
  })
})

describe('OpenAIComputerUseAdapter', () => {
  it('builds the correct request body', () => {
    const adapter = new OpenAIComputerUseAdapter({
      apiKey: 'sk-test',
      model: 'computer-use-preview',
    })

    const body = adapter.buildRequestBody('base64png==', 'What do you see?')

    expect(body.model).toBe('computer-use-preview')
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'computer_use_preview' }),
      ]),
    )
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message' }),
      ]),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sga_template && npx vitest run src/computer-use/providers/openai.test.ts`
Expected: FAIL with "Cannot find module './openai.js'"

- [ ] **Step 3: Write the implementation**

Create `sga_template/src/computer-use/providers/openai.ts`:

```typescript
import { createLogger } from '../../../utils/logger.js'
import type { ComputerUseAction } from '../types.js'

const logger = createLogger('computer-use:openai')

export interface OpenAIAdapterConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

interface OpenAIRawAction {
  type: string
  x?: number
  y?: number
  text?: string
  keys?: string
  dx?: number
  dy?: number
  path?: Array<{ x: number; y: number }>
  duration?: number
  button?: string
}

/** Convert an OpenAI CUA raw action into our normalized ComputerUseAction. */
export function normalizeOpenAIAction(raw: OpenAIRawAction): ComputerUseAction {
  switch (raw.type) {
    case 'screenshot':
      return { type: 'screenshot' }

    case 'click': {
      if (raw.x === undefined || raw.y === undefined) {
        throw new Error('Action "click" requires x and y')
      }
      return {
        type: 'click',
        x: raw.x,
        y: raw.y,
        button: (raw.button as 'left' | 'right' | 'middle') ?? 'left',
      }
    }

    case 'type': {
      if (!raw.text) {
        throw new Error('Action "type" requires text')
      }
      return { type: 'type', text: raw.text }
    }

    case 'keypress': {
      if (!raw.keys) {
        throw new Error('Action "keypress" requires keys')
      }
      return { type: 'key', combo: raw.keys }
    }

    case 'scroll': {
      return {
        type: 'scroll',
        dx: raw.dx ?? 0,
        dy: raw.dy ?? 0,
      }
    }

    case 'drag': {
      if (!raw.path || raw.path.length < 2) {
        throw new Error('Action "drag" requires a path with at least 2 points')
      }
      const start = raw.path[0]
      const end = raw.path[raw.path.length - 1]
      return {
        type: 'drag',
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
      }
    }

    case 'move': {
      // Mouse move without click — return screenshot to confirm position
      return { type: 'screenshot' }
    }

    case 'wait': {
      return { type: 'wait', ms: raw.duration ?? 1000 }
    }

    default:
      throw new Error(`Unknown OpenAI action type: ${raw.type}`)
  }
}

export class OpenAIComputerUseAdapter {
  readonly name = 'openai'
  private config: OpenAIAdapterConfig

  constructor(config: OpenAIAdapterConfig) {
    this.config = config
  }

  /** Build the Responses API request body for a screenshot + instructions. */
  buildRequestBody(screenshotBase64: string, instructions: string): Record<string, unknown> {
    return {
      model: this.config.model,
      tools: [
        {
          type: 'computer_use_preview',
          display_width: 1280,
          display_height: 720,
        },
      ],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: instructions,
            },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${screenshotBase64}`,
            },
          ],
        },
      ],
    }
  }

  /** Send screenshot + instructions, parse the model's action response. */
  async sendScreenshotAndGetCurrentAction(
    screenshotBase64: string,
    instructions: string,
  ): Promise<ComputerUseAction> {
    const body = this.buildRequestBody(screenshotBase64, instructions)
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com'

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    const data = await response.json()

    // Find the computer_call output item
    const computerCall = (data.output as unknown[]).find(
      (item: any) => item.type === 'computer_call',
    )

    if (!computerCall) {
      logger.warn('No computer_call in OpenAI response, defaulting to screenshot')
      return { type: 'screenshot' }
    }

    return normalizeOpenAIAction(computerCall.action as OpenAIRawAction)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sga_template && npx vitest run src/computer-use/providers/openai.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
cd sga_template
git add src/computer-use/providers/openai.ts src/computer-use/providers/openai.test.ts
git commit -m "feat(computer-use): add OpenAI CUA provider adapter"
```

---

## Task 13: Final integration verification

**Files:**
- No new files — this is a verification task

- [ ] **Step 1: Run the full backend test suite**

Run: `cd sga_template && npm test`
Expected: all tests pass (existing 26+ files + new computer-use tests)

- [ ] **Step 2: Run backend typecheck**

Run: `cd sga_template && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run UI verification**

Run: `cd ui && npm run verify`
Expected: typecheck + lint + build all pass

- [ ] **Step 4: Verify the extension file syntax**

Run: `node --check web/computer-use-extension.js`
Expected: no syntax errors

- [ ] **Step 5: Commit any final fixes if needed**

If any issues were found and fixed:

```bash
git add -A
git commit -m "fix(computer-use): address integration test issues"
```

- [ ] **Step 6: Final commit (if there are uncommitted changes)**

```bash
git status
# If clean, nothing to commit
# If there are changes, commit them
```

---

## Self-Review Checklist

After completing all tasks, verify:

1. **Spec coverage:**
   - Phase 0 Foundation: Orchestrator (Task 2) ✓, Anthropic adapter (Task 4) ✓, Action Executor screenshot (Task 3) ✓, tool skeleton (Task 5) ✓, UI toggle (Task 7) ✓, routes (Task 6) ✓
   - Phase 1 Canvas: JS extension (Task 10) ✓, WS protocol spec (Task 9) ✓, WS server (Task 8) ✓, canvas actions in executor (Task 11) ✓, OpenAI adapter (Task 12) ✓

2. **No placeholders:** All steps contain complete code.

3. **Type consistency:** `ComputerUseAction` union is consistent across all files. `CanvasOpRequest`/`CanvasOpResponse` types match between `types.ts`, `ws-server.ts`, `canvas-bridge.ts`, and the JS extension.

4. **Test coverage:** Each task has a TDD cycle (write test → verify fail → implement → verify pass → commit).
