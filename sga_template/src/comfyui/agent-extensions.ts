import type { ComfyUIAdapterConfig } from './types.js'

export const COMFYUI_AGENT_EXTENSIONS: ComfyUIAdapterConfig = {
  maxBudgetUsd: undefined,
  enableFork: true,
  enableCoordinator: true,
  enableAutoDream: true,
  autoDreamConfig: {
    minHours: 12,
    minSessions: 3,
    maxOutputTokens: 12_000,
    model: 'haiku',
  },
  autoInjectWorkflowContext: true,
  autoInitWorkingSet: true,
  enableRetry: true,
  enableAdvisorOnFailure: true,
  enableTeamSync: true,
  teamSyncConfig: {
    syncIntervalMs: 30_000,
    conflictResolution: 'last_write_wins',
    broadcastToAgents: ['comfyui-workflow', 'comfyui-debug', 'comfyui-research'],
  },
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
