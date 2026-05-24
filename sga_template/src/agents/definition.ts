import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import type { PermissionMode, ModelAlias, ThinkingEffort } from '../core/types.js'
import type { FocusMode, ContextBuildOptions } from '../memory/context-builder.js'
import type { ContextBudgetConfig } from '../memory/context-budget.js'
import { getEffortPrompt } from './thinking-prompts.js'

export interface AgentContextConfig {
  focusMode?: FocusMode
  budgetConfig?: Partial<ContextBudgetConfig>
  maxMemoryItems?: number
  enableDedup?: boolean
  enableCompression?: boolean
  enableSgaMd?: boolean
  enableSkills?: boolean
  skillNames?: string[]
}

export interface AgentDefinition {
  name: string
  description: string
  subagentType: string

  getSystemPrompt(params: { toolUseContext: ToolUseContext }): string | Promise<string>
  getAllowedTools(): string[] | undefined
  getDisallowedTools(): string[]
  getModel(): ModelAlias | 'inherit' | undefined
  getEffort(): ThinkingEffort | undefined
  getThinkingPrompt(effort?: ThinkingEffort, useChainOfThought?: boolean): string
  getPermissionMode(): PermissionMode | undefined
  getContextConfig(): AgentContextConfig

  isBuiltIn(): boolean
  isBackground(): boolean
  isProactive(): boolean
}

export interface AgentDefinitionFile {
  name: string
  description: string
  frontmatter: AgentFrontmatter
  content: string
  filePath: string
}

export interface AgentFrontmatter {
  name?: string
  description?: string
  model?: string
  effort?: string
  tools?: string | string[]
  'disallowed-tools'?: string | string[]
  'user-invocable'?: boolean
  context?: 'inline' | 'fork'
  mode?: string
  background?: boolean
  proactive?: boolean
  'mcp-servers'?: Record<string, unknown>
}

export class BaseAgentDefinition implements AgentDefinition {
  name: string
  description: string
  subagentType: string
  protected systemPromptContent: string
  protected allowedToolsList: string[] | undefined
  protected disallowedToolsList: string[]
  protected modelOverride: ModelAlias | 'inherit' | undefined
  protected effortOverride: ThinkingEffort | undefined
  protected permissionModeOverride: PermissionMode | undefined
  protected contextConfigOverride: AgentContextConfig | undefined
  protected isBg: boolean
  protected isProactiveMode: boolean

  constructor(params: {
    name: string
    description: string
    subagentType: string
    systemPrompt: string
    allowedTools?: string[]
    disallowedTools?: string[]
    model?: ModelAlias | 'inherit'
    effort?: ThinkingEffort
    permissionMode?: PermissionMode
    contextConfig?: AgentContextConfig
    background?: boolean
    proactive?: boolean
  }) {
    this.name = params.name
    this.description = params.description
    this.subagentType = params.subagentType
    this.systemPromptContent = params.systemPrompt
    this.allowedToolsList = params.allowedTools
    this.disallowedToolsList = params.disallowedTools ?? []
    this.modelOverride = params.model
    this.effortOverride = params.effort
    this.permissionModeOverride = params.permissionMode
    this.contextConfigOverride = params.contextConfig
    this.isBg = params.background ?? false
    this.isProactiveMode = params.proactive ?? false
  }

  getSystemPrompt(_params: { toolUseContext: ToolUseContext }): string {
    return this.systemPromptContent
  }

  getAllowedTools(): string[] | undefined {
    return this.allowedToolsList
  }

  getDisallowedTools(): string[] {
    return this.disallowedToolsList
  }

  getModel(): ModelAlias | 'inherit' | undefined {
    return this.modelOverride
  }

  getEffort(): ThinkingEffort | undefined {
    return this.effortOverride
  }

  getThinkingPrompt(effort?: ThinkingEffort, useChainOfThought?: boolean): string {
    const resolvedEffort = effort ?? this.effortOverride ?? 'medium'
    return getEffortPrompt(resolvedEffort, useChainOfThought)
  }

  getPermissionMode(): PermissionMode | undefined {
    return this.permissionModeOverride
  }

  getContextConfig(): AgentContextConfig {
    return this.contextConfigOverride ?? {}
  }

  isBuiltIn(): boolean {
    return true
  }

  isBackground(): boolean {
    return this.isBg
  }

  isProactive(): boolean {
    return this.isProactiveMode
  }
}

export const ALL_AGENT_DISALLOWED_TOOLS = [
  'TaskOutput',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'TaskStop',
]

export const CUSTOM_AGENT_DISALLOWED_TOOLS = [
  'Agent',
]

export const ASYNC_AGENT_ALLOWED_TOOLS = [
  'Read', 'WebSearch', 'TodoWrite', 'Grep', 'WebFetch', 'Glob',
  'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit',
  'Skill', 'SyntheticOutput', 'ToolSearch', 'EnterWorktree', 'ExitWorktree',
]
