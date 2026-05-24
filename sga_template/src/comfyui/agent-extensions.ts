import type { ComfyUIAdapterConfig } from './types.js'

export const COMFYUI_AGENT_EXTENSIONS: ComfyUIAdapterConfig = {
  maxBudgetUsd: undefined,
  enableFork: true,
  enableCoordinator: true,
  enableAutoDream: true,
  autoInjectWorkflowContext: true,
  autoInitWorkingSet: true,
  enableRetry: true,
  enableAdvisorOnFailure: true,
}

const agentExtensionMap: Map<string, ComfyUIAdapterConfig> = new Map([
  ['comfyui-workflow', COMFYUI_AGENT_EXTENSIONS],
])

export function getAgentExtensions(agentName: string): ComfyUIAdapterConfig | undefined {
  return agentExtensionMap.get(agentName)
}

export function registerAgentExtensions(agentName: string, config: ComfyUIAdapterConfig): void {
  agentExtensionMap.set(agentName, config)
}
