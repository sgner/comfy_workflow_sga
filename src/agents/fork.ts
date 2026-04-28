import type { Message, UsageMetrics } from '../core/types.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'

export interface ForkedAgentParams {
  promptMessages: Message[]
  canUseTool: (tool: unknown, input: unknown, context: ToolUseContext) => Promise<boolean>
  querySource: string
  forkLabel: string
  overrides?: SubagentContextOverrides
  maxOutputTokens?: number
  maxTurns?: number
}

export interface SubagentContextOverrides {
  tools?: Tool[]
  agentId?: string
  agentType?: string
  messages?: Message[]
  readFileState?: Map<string, { content: string; timestamp: number }>
  abortController?: AbortController
  shareSetAppState?: boolean
  shareSetResponseLength?: boolean
  shareAbortController?: boolean
  criticalSystemReminder?: string
}

export interface ForkedAgentResult {
  messages: Message[]
  usage: UsageMetrics
  content: string
}

export function buildForkedMessages(
  directive: string,
  assistantMessage: Message,
): Message[] {
  const messages: Message[] = []

  messages.push(assistantMessage)

  const userContent: Message['content'] = []
  for (const block of assistantMessage.content) {
    if (block.type === 'tool_use') {
      userContent.push({
        type: 'tool_result',
        tool_use_id: block.id ?? '',
        content: `[Fork placeholder - will be filled by child]`,
      })
    }
  }

  userContent.push({
    type: 'text',
    text: directive,
  })

  messages.push({
    id: `fork-user-${Date.now()}`,
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  })

  return messages
}

export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides: SubagentContextOverrides = {},
): ToolUseContext {
  return {
    tools: overrides.tools ?? parentContext.tools,
    messages: overrides.messages ?? [],
    abortController: overrides.abortController ?? new AbortController(),
    getAppState: parentContext.getAppState,
    setAppState: overrides.shareSetAppState ? parentContext.setAppState : () => {},
    readFileState: overrides.readFileState ?? new Map(parentContext.readFileState),
    agentId: overrides.agentId,
    agentType: overrides.agentType,
  }
}

export const FORK_BOILERPLATE = `You are a forked worker process, not the main agent.
- Do not converse, ask questions, or suggest next steps
- Use tools directly (Bash, Read, Write, etc.)
- If you modify files, commit changes before reporting
- Do not output text between tool calls
- Stay strictly within the scope of your directive
- Keep your report under 500 words
- Your response must start with "Scope:"`
