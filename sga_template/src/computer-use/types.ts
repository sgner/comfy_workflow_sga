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
