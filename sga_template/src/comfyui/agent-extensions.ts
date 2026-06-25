import type { ComfyUIAdapterConfig } from './types.js'

/** 解析布尔环境变量, 默认值在未设置时使用 */
function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return defaultValue
  return v === '1' || v.toLowerCase() === 'true'
}

/** 解析整数环境变量, 默认值在未设置时使用 */
function envInt(name: string, defaultValue: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return defaultValue
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? defaultValue : n
}

export const COMFYUI_AGENT_EXTENSIONS: ComfyUIAdapterConfig = {
  maxBudgetUsd: undefined,
  enableFork: envBool('SGA_ENABLE_FORK', true),
  enableCoordinator: envBool('SGA_ENABLE_COORDINATOR', true),
  enableAutoDream: envBool('SGA_ENABLE_AUTODREAM', true),
  autoDreamConfig: {
    minHours: envInt('SGA_AUTODREAM_MIN_HOURS', 12),
    minSessions: envInt('SGA_AUTODREAM_MIN_SESSIONS', 3),
    maxOutputTokens: envInt('SGA_AUTODREAM_MAX_OUTPUT_TOKENS', 12_000),
    model: process.env.SGA_AUTODREAM_MODEL ?? 'gpt-4o-mini',
  },
  autoInjectWorkflowContext: envBool('SGA_AUTO_INJECT_WORKFLOW_CONTEXT', true),
  autoInitWorkingSet: envBool('SGA_AUTO_INIT_WORKING_SET', true),
  enableRetry: envBool('SGA_ENABLE_RETRY', true),
  enableAdvisorOnFailure: envBool('SGA_ENABLE_ADVISOR_ON_FAILURE', true),
  enableTeamSync: envBool('SGA_ENABLE_TEAM_SYNC', true),
  teamSyncConfig: {
    syncIntervalMs: envInt('SGA_TEAM_SYNC_INTERVAL', 30_000),
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
