import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { createLogger } from '../../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult, StepEvent } from '../../computer-use/types.js'
import type { ComputerUseOrchestrator } from '../../computer-use/orchestrator.js'

const logger = createLogger('tool:computer-use')

// Singleton orchestrator reference — set by the route handler when user toggles on.
let activeOrchestrator: ComputerUseOrchestrator | null = null

// NEW: subscriber/fan-out bus. The tool is the sole consumer of the
// runGoal() generator; it publishes each event to all subscribers.
type StepEventSubscriber = (event: StepEvent) => void

const runEventSubscribers = new Set<StepEventSubscriber>()

/** Subscribe to live StepEvents. Returns an unsubscribe function. */
export function subscribeToComputerUseRunEvents(subscriber: StepEventSubscriber): () => void {
  runEventSubscribers.add(subscriber)
  return () => {
    runEventSubscribers.delete(subscriber)
  }
}

/** Publish a StepEvent to all current subscribers. Called by the tool as it consumes the generator. */
function publishRunEvent(event: StepEvent): void {
  for (const sub of runEventSubscribers) {
    try {
      sub(event)
    } catch {
      // subscriber threw — remove it to avoid poisoning the set
      runEventSubscribers.delete(sub)
    }
  }
}

/** Clear all subscribers (called when a run ends or is cleared). */
export function clearComputerUseRunEvents(): void {
  runEventSubscribers.clear()
}

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
  - runQueue: submit the current workflow for execution
  - run_goal: enter autopilot loop to achieve a goal (args: goal, maxSteps?)`
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
          description: 'The action to perform: screenshot, addNode, removeNode, connect, disconnect, setWidget, getCanvasState, runQueue, run_goal',
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
      return `Unknown action: ${input.action}. Valid actions: screenshot, addNode, removeNode, connect, disconnect, setWidget, getCanvasState, runQueue, run_goal`
    }

    // Handle run_goal specially — enters autopilot loop
    if (action.type === 'run_goal') {
      const adapter = activeOrchestrator.getActiveAdapter()
      if (!adapter) {
        return 'Autopilot not available: no provider adapter configured. Start the session with a supported provider (anthropic or openai).'
      }

      const maxSteps = action.maxSteps ?? 20
      const goalText = action.goal
      logger.info(`Starting autopilot run: "${goalText}" (max ${maxSteps} steps)`)

      // NEW: tool is sole consumer of the generator; publish each event to subscribers
      clearComputerUseRunEvents()
      const eventStream = activeOrchestrator.runGoal(goalText, { adapter, maxSteps })

      let stepCount = 0
      let finalSummary = 'Autopilot run completed'

      try {
        for await (const event of eventStream) {
          publishRunEvent(event)  // fan out to SSE subscribers
          if (event.type === 'loop_done') {
            finalSummary = event.summary ?? finalSummary
          }
          if (event.type === 'error') {
            finalSummary = `Autopilot error: ${event.error}`
          }
          if (event.type === 'stopped') {
            finalSummary = 'Autopilot stopped by user'
          }
          stepCount++
        }
      } finally {
        // Keep subscribers around briefly so the SSE handler can flush the
        // terminal event; clear on next run start (clearComputerUseRunEvents above).
      }

      return `Autopilot completed after ${stepCount} steps. ${finalSummary}`
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
          x: typeof args?.x === 'number' ? args.x : undefined,
          y: typeof args?.y === 'number' ? args.y : undefined,
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
        return {
          type: 'runQueue',
          prompt: (args?.prompt !== null && typeof args?.prompt === 'object' && !Array.isArray(args.prompt))
            ? args.prompt as Record<string, unknown>
            : undefined,
        }
      case 'run_goal': {
        return {
          type: 'run_goal',
          goal: String(args?.goal ?? ''),
          maxSteps: typeof args?.maxSteps === 'number' ? args.maxSteps : undefined,
        }
      }
      default:
        return null
    }
  }
}
