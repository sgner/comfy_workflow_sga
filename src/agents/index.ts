import type { AgentDefinition, AgentFrontmatter } from './definition.js'
import { BaseAgentDefinition } from './definition.js'
import { GeneralPurposeAgent, ExploreAgent, PlanAgent, VerificationAgent } from './built-in/index.js'

export type { AgentDefinition, AgentDefinitionFile, AgentFrontmatter } from './definition.js'
export { BaseAgentDefinition, ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS, ASYNC_AGENT_ALLOWED_TOOLS } from './definition.js'
export { runAgent, type AgentRunOptions, type AgentRunResult } from './runner.js'
export type { ForkedAgentParams, SubagentContextOverrides, ForkedAgentResult } from './fork.js'
export { buildForkedMessages, createSubagentContext, FORK_BOILERPLATE } from './fork.js'

export function getBuiltinAgentDefinitions(): AgentDefinition[] {
  return [
    new GeneralPurposeAgent(),
    new ExploreAgent(),
    new PlanAgent(),
    new VerificationAgent(),
  ]
}

export function getAgentDefinitionByName(name: string, definitions: AgentDefinition[]): AgentDefinition | undefined {
  return definitions.find(d => d.name === name || d.subagentType === name)
}
