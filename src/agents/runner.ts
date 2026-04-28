import type { Message, ModelAlias, UsageMetrics, PermissionMode } from '../core/types.js'
import type { AgentDefinition } from './definition.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import { filterToolsForAgent } from '../tools/base.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from './definition.js'

export interface AgentRunOptions {
  agentDefinition: AgentDefinition
  prompt: string
  messages?: Message[]
  tools: Tool[]
  model: string
  systemPrompt?: SystemPrompt
  maxTurns?: number
  maxBudgetUsd?: number
  signal?: AbortSignal
  onProgress?: (event: unknown) => void
  parentContext?: ToolUseContext
}

export interface AgentRunResult {
  content: string
  messages: Message[]
  usage: UsageMetrics
  turnCount: number
  totalToolUseCount: number
  totalDurationMs: number
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const startTime = Date.now()
  const { agentDefinition, prompt, tools, model, parentContext } = options

  const resolvedModel = resolveAgentModel(agentDefinition.getModel(), model)
  const agentTools = resolveAgentTools(agentDefinition, tools)
  const systemPromptContent = await agentDefinition.getSystemPrompt({
    toolUseContext: parentContext ?? createDefaultToolUseContext(tools),
  })

  const initialMessages: Message[] = options.messages ?? []
  if (prompt) {
    initialMessages.push({
      id: `agent-prompt-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      timestamp: Date.now(),
    })
  }

  const result = await executeAgentLoop(
    initialMessages,
    agentTools,
    resolvedModel,
    systemPromptContent,
    options,
  )

  const lastAssistantMsg = result.messages
    .filter((m): m is Message & { role: 'assistant' } => m.role === 'assistant')
    .pop()
  const content = extractTextFromMessage(lastAssistantMsg) ?? ''

  return {
    content,
    messages: result.messages,
    usage: result.usage,
    turnCount: result.turnCount,
    totalToolUseCount: result.toolUseCount,
    totalDurationMs: Date.now() - startTime,
  }
}

interface AgentLoopResult {
  messages: Message[]
  usage: UsageMetrics
  turnCount: number
  toolUseCount: number
}

async function executeAgentLoop(
  messages: Message[],
  tools: Tool[],
  model: string,
  systemPromptContent: string,
  options: AgentRunOptions,
): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? 50
  let turnCount = 0
  let toolUseCount = 0
  const usage: UsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  }
  const allMessages = [...messages]

  return { messages: allMessages, usage, turnCount, toolUseCount }
}

function resolveAgentModel(agentModel: ModelAlias | 'inherit' | undefined, parentModel: string): string {
  if (agentModel && agentModel !== 'inherit') {
    return agentModel
  }
  return parentModel
}

function resolveAgentTools(agentDef: AgentDefinition, availableTools: Tool[]): Tool[] {
  const allowed = agentDef.getAllowedTools()
  const disallowed = [...agentDef.getDisallowedTools(), ...ALL_AGENT_DISALLOWED_TOOLS]
  return filterToolsForAgent(availableTools, allowed, disallowed, ALL_AGENT_DISALLOWED_TOOLS)
}

function extractTextFromMessage(message: Message | undefined): string | null {
  if (!message) return null
  return message.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n')
}

function createDefaultToolUseContext(tools: Tool[]): ToolUseContext {
  return {
    tools,
    messages: [],
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
  }
}
