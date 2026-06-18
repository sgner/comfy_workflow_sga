import type { AgentDefinition, AgentFrontmatter } from './definition.js'
import { BaseAgentDefinition } from './definition.js'
import { GeneralPurposeAgent, ExploreAgent, PlanAgent, VerificationAgent, ComfyUIWorkflowAgent } from './built-in/index.js'
import { loadCustomAgents, createAgentFromConfig, isCustomAgent, agentDefinitionToJSON, type CustomAgentDefinition, type AgentSource } from './loader.js'
import { CoordinatorAgent, getCoordinatorSystemPrompt, isCoordinatorMode, setCoordinatorMode } from './coordinator-mode.js'

export type { AgentDefinition, AgentDefinitionFile, AgentFrontmatter } from './definition.js'
export { BaseAgentDefinition, ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS, ASYNC_AGENT_ALLOWED_TOOLS } from './definition.js'
export { runAgent, type AgentRunOptions, type AgentRunResult } from './runner.js'
export type { ForkedAgentParams, SubagentContextOverrides, ForkedAgentResult } from './fork.js'
export { buildForkedMessages, createSubagentContext, FORK_BOILERPLATE } from './fork.js'
export { loadCustomAgents, createAgentFromConfig, isCustomAgent, agentDefinitionToJSON, type CustomAgentDefinition, type AgentSource } from './loader.js'
export { CoordinatorAgent, getCoordinatorSystemPrompt, isCoordinatorMode, setCoordinatorMode } from './coordinator-mode.js'
export { listSnapshots, type CoordinatorConfig, type CoordinatorPlan, type CoordinatorResult, type CoordinatorTask, type CoordinatorTaskStep, type CoordinatorTaskResult, type CoordinatorPhase, type CoordinatorSnapshot } from './coordinator.js'
export { PlanManager, getPlanManager, resetPlanManager, type PlanNotificationCallback } from './plan-manager.js'

export function getBuiltinAgentDefinitions(): AgentDefinition[] {
  return [
    new ComfyUIWorkflowAgent(),
    new GeneralPurposeAgent(),
    new ExploreAgent(),
    new PlanAgent(),
    new VerificationAgent(),
  ]
}

export function getCoordinatorAgentDefinition(agentDefinitions: AgentDefinition[]): CoordinatorAgent {
  return new CoordinatorAgent(agentDefinitions)
}

export function getAgentDefinitionByName(name: string, definitions: AgentDefinition[]): AgentDefinition | undefined {
  return definitions.find(d => d.name === name || d.subagentType === name)
}

export async function getAllAgentDefinitions(baseDir?: string): Promise<AgentDefinition[]> {
  const builtin = getBuiltinAgentDefinitions()
  const custom = await loadCustomAgents(baseDir)
  return [...builtin, ...custom]
}
