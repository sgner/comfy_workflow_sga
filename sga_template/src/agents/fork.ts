import type { Message, MessageContent, UsageMetrics } from '../core/types.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('fork')

export const FORK_PLACEHOLDER_RESULT = '[Fork placeholder — result not available in this context]'

export const FORK_RECURSION_TAG = '<!-- fork-recursive-guard -->'

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

export function isForkRecursion(messages: Message[]): boolean {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text?.includes(FORK_RECURSION_TAG)) {
        return true
      }
    }
  }
  return false
}

export function buildForkedMessages(
  directive: string,
  assistantMessage: Message,
): Message[] {
  const messages: Message[] = []

  const clonedAssistant: Message = {
    ...assistantMessage,
    id: assistantMessage.id,
    content: [...assistantMessage.content],
  }

  messages.push(clonedAssistant)

  const toolUseBlocks = assistantMessage.content.filter(
    (block): block is MessageContent & { type: 'tool_use'; id: string; name: string } =>
      block.type === 'tool_use' && !!block.id,
  )

  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: FORK_PLACEHOLDER_RESULT,
  }))

  const childDirective = buildChildDirective(directive)

  const userContent: MessageContent[] = [
    ...toolResultBlocks,
    {
      type: 'text',
      text: childDirective,
    },
  ]

  messages.push({
    id: `fork-user-${Date.now()}`,
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  })

  logger.debug(`Built forked messages: ${toolUseBlocks.length} tool_use blocks replaced with placeholders`)
  return messages
}

function buildChildDirective(directive: string): string {
  return `${FORK_RECURSION_TAG}

${directive}

---
You are a forked sub-agent. Execute the above directive directly. Do not spawn further sub-agents.`
}

export function buildForkedMessagesFromParentContext(
  directive: string,
  parentMessages: Message[],
): Message[] {
  if (isForkRecursion(parentMessages)) {
    throw new Error('Cannot fork from within a forked agent — recursive fork detected')
  }

  const lastAssistant = [...parentMessages].reverse().find(m => m.role === 'assistant')
  if (!lastAssistant) {
    return [{
      id: `fork-user-${Date.now()}`,
      role: 'user',
      content: [{
        type: 'text',
        text: buildChildDirective(directive),
      }],
      timestamp: Date.now(),
    }]
  }

  return buildForkedMessages(directive, lastAssistant)
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
- Your response must start with "Scope:"
- Do NOT spawn further sub-agents (no recursive forking)`
