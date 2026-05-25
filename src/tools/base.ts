import type { Message, MessageContent, ToolProgressData } from '../core/types.js'
import type { PermissionChecker } from '../permissions/checker.js'

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: ToolInputSchema
}

export interface ValidationResult {
  success: boolean
  error?: string
}

export interface ToolCallContext {
  toolUseId: string
  turnCount: number
  isBackground: boolean
}

export interface ToolUseContext {
  tools: Tool[]
  messages: Message[]
  abortController: AbortController
  getAppState: () => Record<string, unknown>
  setAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  readFileState?: Map<string, { content: string; timestamp: number }>
  agentId?: string
  agentType?: string
  permissionMode?: string
  permissionChecker?: PermissionChecker
  customSystemPrompt?: string
  appendSystemPrompt?: string
  refreshTools?: () => Tool[]
}

export type ToolProgressCallback = (data: ToolProgressData) => void

export interface Tool<Input = Record<string, unknown>, Output = unknown> {
  name: string
  aliases?: string[]
  description: string
  searchHint?: string

  isEnabled(): boolean
  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  isDestructive(input: Input): boolean
  requiresUserInteraction(): boolean

  validateInput(input: unknown): ValidationResult
  checkPermissions(input: Input, context: ToolUseContext): Promise<PermissionResult>
  call(input: Input, context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<Output>

  getDefinition(): ToolDefinition
  renderToolUseMessage?(input: Input): string
  renderToolResultMessage?(result: Output): string
  getToolUseSummary?(input: Input): string

  maxResultSizeChars?: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: unknown; decisionReason?: string }
  | { behavior: 'ask'; message: string; suggestions?: string[]; decisionReason?: string }
  | { behavior: 'deny'; message: string; decisionReason?: string }
  | { behavior: 'passthrough'; message: string }

export abstract class BaseTool<Input = Record<string, unknown>, Output = unknown> implements Tool<Input, Output> {
  abstract name: string
  aliases?: string[]
  abstract description: string
  searchHint?: string
  maxResultSizeChars?: number
  shouldDefer?: boolean
  alwaysLoad?: boolean

  isEnabled(): boolean {
    return true
  }

  isConcurrencySafe(_input: Input): boolean {
    return false
  }

  isReadOnly(_input: Input): boolean {
    return false
  }

  isDestructive(_input: Input): boolean {
    return !this.isReadOnly(_input as Input)
  }

  requiresUserInteraction(): boolean {
    return false
  }

  abstract validateInput(input: unknown): ValidationResult
  abstract call(input: Input, context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<Output>

  async checkPermissions(input: Input, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.getInputSchema(),
    }
  }

  protected abstract getInputSchema(): ToolInputSchema

  renderToolUseMessage?(input: Input): string
  renderToolResultMessage?(result: Output): string

  getToolUseSummary?(input: Input): string {
    return `${this.name}: ${this.description}`
  }
}

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name || t.aliases?.includes(name))
}

export function filterToolsForMode(tools: Tool[], mode: string): Tool[] {
  return tools.filter(t => t.isEnabled())
}

export function filterToolsForAgent(
  tools: Tool[],
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  globallyDisallowed: string[],
): Tool[] {
  let filtered = tools.filter(t => !globallyDisallowed.includes(t.name))

  if (allowedTools && allowedTools.length > 0 && !allowedTools.includes('*')) {
    filtered = filtered.filter(t => allowedTools.includes(t.name))
  }

  if (disallowedTools && disallowedTools.length > 0) {
    filtered = filtered.filter(t => !disallowedTools.includes(t.name))
  }

  return filtered
}
