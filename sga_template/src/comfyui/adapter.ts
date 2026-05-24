import type { ComfyUIRunOptions, ComfyUIAdapterConfig } from './types.js'
import type { AgentRunOptions, AgentRunResult } from '../agents/runner.js'
import type { AgentStreamEvent, UsageMetrics } from '../core/types.js'
import { runAgent } from '../agents/runner.js'
import { ComfyUICostManager } from './cost-manager.js'
import { ComfyUIContextInjector } from './context-injector.js'
import { getAgentExtensions } from './agent-extensions.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('comfyui-adapter')

const costManagers: Map<string, ComfyUICostManager> = new Map()

export function getCostManager(sessionId: string): ComfyUICostManager | undefined {
  return costManagers.get(sessionId)
}

export function getOrCreateCostManager(sessionId: string, maxBudgetUsd?: number): ComfyUICostManager {
  let mgr = costManagers.get(sessionId)
  if (!mgr) {
    mgr = new ComfyUICostManager(maxBudgetUsd)
    costManagers.set(sessionId, mgr)
  }
  return mgr
}

export function removeCostManager(sessionId: string): void {
  costManagers.delete(sessionId)
}

export async function runComfyUIAgent(options: ComfyUIRunOptions): Promise<AgentRunResult> {
  const { agentDefinition, adapterConfig: partialAdapterConfig } = options
  const agentName = agentDefinition.name

  const extensions = getAgentExtensions(agentName)
  const adapterConfig: ComfyUIAdapterConfig = {
    maxBudgetUsd: partialAdapterConfig?.maxBudgetUsd ?? extensions?.maxBudgetUsd,
    enableFork: partialAdapterConfig?.enableFork ?? extensions?.enableFork ?? false,
    enableCoordinator: partialAdapterConfig?.enableCoordinator ?? extensions?.enableCoordinator ?? false,
    enableAutoDream: partialAdapterConfig?.enableAutoDream ?? extensions?.enableAutoDream ?? false,
    autoInjectWorkflowContext: partialAdapterConfig?.autoInjectWorkflowContext ?? extensions?.autoInjectWorkflowContext ?? false,
    autoInitWorkingSet: partialAdapterConfig?.autoInitWorkingSet ?? extensions?.autoInitWorkingSet ?? false,
  }

  const contextInjector = new ComfyUIContextInjector()
  const messages = options.messages ? [...options.messages] : []

  if (adapterConfig.autoInitWorkingSet && messages.length > 0) {
    await contextInjector.onSessionStart(messages)
  }

  if (adapterConfig.autoInjectWorkflowContext && messages.length > 0) {
    contextInjector.injectWorkflowSummary(messages)
  }

  const sessionId = options.parentContext?.agentId ?? `comfyui-${Date.now()}`
  const costManager = getOrCreateCostManager(sessionId, adapterConfig.maxBudgetUsd)

  const abortController = new AbortController()
  costManager.setAbortController(abortController)

  const originalOnProgress = options.onProgress
  const wrappedOnProgress = (event: AgentStreamEvent): void => {
    if (event.type === 'turn_end' && event.usage) {
      costManager.recordUsage(event.usage as UsageMetrics)
      costManager.abortIfOverBudget()
    }
    if (originalOnProgress) {
      originalOnProgress(event)
    }
  }

  const runOptions: AgentRunOptions = {
    agentDefinition: options.agentDefinition,
    prompt: options.prompt,
    messages,
    tools: options.tools,
    model: options.model,
    provider: options.provider,
    maxTurns: options.maxTurns,
    maxBudgetUsd: adapterConfig.maxBudgetUsd,
    stream: options.stream,
    signal: abortController.signal,
    onProgress: wrappedOnProgress,
    parentContext: options.parentContext,
    permissionMode: options.permissionMode,
    requestApproval: options.requestApproval,
    requestHumanInput: options.requestHumanInput,
  }

  try {
    const result = await runAgent(runOptions)
    costManager.recordUsage(result.usage)
    return result
  } catch (error) {
    if (abortController.signal.aborted && costManager.getReport().isOverBudget) {
      return {
        content: costManager.getOverBudgetMessage(),
        messages,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          totalCostUsd: costManager.getReport().totalCostUsd,
        },
        turnCount: 0,
        totalToolUseCount: 0,
        totalDurationMs: 0,
      }
    }
    throw error
  }
}

export { ComfyUICostManager } from './cost-manager.js'
export { ComfyUIContextInjector } from './context-injector.js'
export { getAgentExtensions, registerAgentExtensions } from './agent-extensions.js'
export type { ComfyUIAdapterConfig, ComfyUIRunOptions, ComfyUICostReport } from './types.js'
