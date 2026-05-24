import type { Message, UsageMetrics } from '../core/types.js'
import type { AgentRunOptions, AgentRunResult } from '../agents/runner.js'
import type { LLMProvider } from '../providers/types.js'
import type { Tool } from '../tools/base.js'
import type { AgentDefinition } from '../agents/definition.js'

export interface ComfyUIAdapterConfig {
  maxBudgetUsd?: number
  enableFork: boolean
  enableCoordinator: boolean
  enableAutoDream: boolean
  autoInjectWorkflowContext: boolean
  autoInitWorkingSet: boolean
}

export const DEFAULT_COMFYUI_ADAPTER_CONFIG: ComfyUIAdapterConfig = {
  enableFork: true,
  enableCoordinator: true,
  enableAutoDream: true,
  autoInjectWorkflowContext: true,
  autoInitWorkingSet: true,
}

export interface ComfyUIRunOptions {
  agentDefinition: AgentDefinition
  prompt: string
  messages?: Message[]
  tools: Tool[]
  model: string
  provider: LLMProvider
  maxTurns?: number
  stream?: boolean
  signal?: AbortSignal
  onProgress?: (event: import('../core/types.js').AgentStreamEvent) => void
  adapterConfig?: Partial<ComfyUIAdapterConfig>
  parentContext?: import('../tools/base.js').ToolUseContext
  permissionMode?: import('../core/types.js').PermissionMode
  requestApproval?: (event: import('../agents/runner.js').ApprovalEvent) => Promise<import('../agents/runner.js').ApprovalResponse>
  requestHumanInput?: (event: import('../agents/runner.js').HumanInputEvent) => Promise<string>
}

export interface ComfyUICostReport {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  isOverBudget: boolean
  isNearBudget: boolean
  remainingBudget: number | undefined
  report: string
}
