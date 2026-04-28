import type { Message, StreamEvent, UsageMetrics, StopReason, ContinueReason, ThinkingConfig, ModelAlias } from './types.js'
import type { AgentState } from './state.js'
import { createInitialState, transitionState } from './state.js'
import type { Tool, ToolUseContext, ToolDefinition, PermissionResult } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import type { PermissionChecker } from '../permissions/checker.js'
import type { HookExecutor } from '../hooks/executor.js'

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolUseId: string
  content: string
  isError: boolean
  metadata?: Record<string, unknown>
}

export interface ApprovalNeededEvent {
  type: 'approval_required'
  toolName: string
  toolInput: Record<string, unknown>
  toolCallId: string
  message: string
  suggestions?: string[]
}

export interface HumanInputNeededEvent {
  type: 'human_input_required'
  message: string
  context?: string
  options?: Array<{ label: string; value: string; description?: string }>
}

export interface QueryDeps {
  callModel: (params: ModelCallParams) => AsyncIterable<StreamEvent>
  runTools: (toolCalls: ToolCall[], context: ToolUseContext) => AsyncIterable<ToolResult>
  compressContext: (messages: Message[], context: CompressContext) => Promise<Message[]>
  canUseTool: (tool: Tool, input: unknown, context: ToolUseContext) => Promise<boolean>
  checkToolPermission: (tool: Tool, input: Record<string, unknown>, context: ToolUseContext) => Promise<PermissionResult>
  executeHooks: (event: HookEvent, data: unknown) => Promise<HookResult>
  buildSystemPrompt: (context: PromptBuildContext) => Promise<SystemPrompt>
  getUserContext: () => Record<string, string>
  getSystemContext: () => Record<string, string>
  requestApproval?: (event: ApprovalNeededEvent) => Promise<PermissionResult>
  requestHumanInput?: (event: HumanInputNeededEvent) => Promise<string>
}

export interface ModelCallParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig?: ThinkingConfig
  tools: ToolDefinition[]
  signal?: AbortSignal
  model?: string
  maxTokens?: number
}

export interface CompressContext {
  maxTokens: number
  currentTokens: number
  reason: 'auto' | 'reactive' | 'manual'
}

export interface HookEvent {
  type: string
  source: string
}

export interface HookResult {
  proceed: boolean
  modifiedData?: unknown
  message?: string
}

export interface PromptBuildContext {
  agentType?: string
  memoryContent?: string
  skillList?: string
  envInfo?: Record<string, string>
}

export interface QueryParams {
  messages: Message[]
  systemPrompt?: SystemPrompt
  tools: Tool[]
  model: string
  thinkingConfig?: ThinkingConfig
  maxTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  signal?: AbortSignal
  deps: QueryDeps
  onProgress?: (event: QueryProgressEvent) => void
}

export type QueryProgressEvent =
  | { type: 'turn_start'; turnCount: number }
  | { type: 'api_call_start'; turnCount: number }
  | { type: 'stream_delta'; text: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string }
  | { type: 'tool_use_result'; toolName: string; result: ToolResult }
  | { type: 'turn_end'; turnCount: number; usage: UsageMetrics }
  | { type: 'compact_start'; reason: string }
  | { type: 'compact_end'; messagesRemoved: number }
  | { type: 'recovery'; error: Error; attempt: number }
  | { type: 'stop'; reason: StopReason }
  | { type: 'approval_required'; toolName: string; toolInput: Record<string, unknown>; toolCallId: string; message: string; suggestions?: string[] }
  | { type: 'human_input_required'; message: string; context?: string; options?: Array<{ label: string; value: string; description?: string }> }

export type QueryResult = {
  messages: Message[]
  usage: UsageMetrics
  stopReason: StopReason
  turnCount: number
}

const MAX_TURNS_DEFAULT = 200
const RECOVERY_MAX_ATTEMPTS = 3

export async function* query(params: QueryParams): AsyncGenerator<QueryProgressEvent, QueryResult> {
  const {
    messages: initialMessages,
    tools,
    model,
    thinkingConfig,
    maxTokens,
    maxTurns = MAX_TURNS_DEFAULT,
    maxBudgetUsd,
    signal,
    deps,
    onProgress,
  } = params

  let state: AgentState = createInitialState(initialMessages)
  const abortController = new AbortController()

  if (signal) {
    signal.addEventListener('abort', () => abortController.abort())
  }

  while (true) {
    if (abortController.signal.aborted) {
      const stopReason: StopReason = { reason: 'cancelled' }
      state = transitionState(state, { stopReason })
      yield { type: 'stop', reason: stopReason }
      return buildResult(state)
    }

    if (state.turnCount >= maxTurns) {
      const stopReason: StopReason = { reason: 'max_tokens' }
      state = transitionState(state, { stopReason })
      yield { type: 'stop', reason: stopReason }
      return buildResult(state)
    }

    if (maxBudgetUsd && state.usage.totalCostUsd >= maxBudgetUsd) {
      const stopReason: StopReason = { reason: 'max_tokens' }
      state = transitionState(state, { stopReason })
      yield { type: 'stop', reason: stopReason }
      return buildResult(state)
    }

    yield { type: 'turn_start', turnCount: state.turnCount }

    const systemPrompt = params.systemPrompt ?? await deps.buildSystemPrompt({})
    const userContext = deps.getUserContext()
    const systemContext = deps.getSystemContext()

    const messagesForQuery = prependContext(state.messages, userContext, systemContext)

    const compressedMessages = await compressIfNeeded(messagesForQuery, state, deps)
    if (compressedMessages !== messagesForQuery) {
      state = transitionState(state, { messages: compressedMessages })
    }

    yield { type: 'api_call_start', turnCount: state.turnCount }

    let assistantContent: Message[] = []
    let toolCalls: ToolCall[] = []
    let turnUsage: UsageMetrics = { ...state.usage }
    let stopReasonFromApi: string | null = null

    try {
      const toolDefs = tools.filter(t => t.isEnabled()).map(t => t.getDefinition())
      const stream = deps.callModel({
        messages: compressedMessages,
        systemPrompt,
        thinkingConfig,
        tools: toolDefs,
        signal: abortController.signal,
        model,
        maxTokens: maxTokens ?? state.maxOutputTokensOverride,
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          yield { type: 'stream_delta', text: event.delta.text }
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const tc: ToolCall = {
            id: event.content_block.id ?? '',
            name: event.content_block.name ?? '',
            input: event.content_block.input ?? {},
          }
          toolCalls.push(tc)
          yield { type: 'tool_use_start', toolName: tc.name, toolUseId: tc.id }
        }

        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReasonFromApi = event.delta.stop_reason
        }

        if (event.usage) {
          turnUsage = accumulateUsage(turnUsage, event.usage)
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      state.maxOutputTokensRecoveryCount++
      if (state.maxOutputTokensRecoveryCount <= RECOVERY_MAX_ATTEMPTS) {
        yield { type: 'recovery', error: err, attempt: state.maxOutputTokensRecoveryCount }
        state = transitionState(state, {
          transition: { reason: 'recovery', error: err },
          usage: turnUsage,
        })
        continue
      }
      const stopReason: StopReason = { reason: 'error', error: err }
      state = transitionState(state, { stopReason, usage: turnUsage })
      yield { type: 'stop', reason: stopReason }
      return buildResult(state)
    }

    if (toolCalls.length > 0) {
      const toolResults: ToolResult[] = []
      const toolUseContext = createToolUseContext(tools, state, abortController)

      for (const toolCall of toolCalls) {
        const tool = tools.find(t => t.name === toolCall.name)
        if (!tool) {
          toolResults.push({ toolUseId: toolCall.id, content: `Unknown tool: ${toolCall.name}`, isError: true })
          yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResults[toolResults.length - 1] }
          continue
        }

        const validated = tool.validateInput(toolCall.input)
        if (!validated.success) {
          toolResults.push({ toolUseId: toolCall.id, content: `Invalid input: ${validated.error}`, isError: true })
          yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResults[toolResults.length - 1] }
          continue
        }

        const permission = await deps.checkToolPermission(tool, toolCall.input, toolUseContext)

        if (permission.behavior === 'ask') {
          const askMessage = (permission as { message?: string }).message ?? `Tool "${toolCall.name}" requires your approval to execute.`
          const suggestions = (permission as { suggestions?: string[] }).suggestions

          const approvalEvent: ApprovalNeededEvent = {
            type: 'approval_required',
            toolName: toolCall.name,
            toolInput: toolCall.input,
            toolCallId: toolCall.id,
            message: askMessage,
            suggestions,
          }

          yield {
            type: 'approval_required',
            toolName: toolCall.name,
            toolInput: toolCall.input,
            toolCallId: toolCall.id,
            message: askMessage,
            suggestions,
          }

          if (deps.requestApproval) {
            const userDecision = await deps.requestApproval(approvalEvent)
            if (userDecision.behavior === 'allow') {
              const effectiveInput = (userDecision as { updatedInput?: unknown }).updatedInput
                ? (userDecision as { updatedInput: Record<string, unknown> }).updatedInput
                : toolCall.input
              try {
                const result = await tool.call(effectiveInput, toolUseContext)
                const toolResult: ToolResult = {
                  toolUseId: toolCall.id,
                  content: typeof result === 'string' ? result : JSON.stringify(result),
                  isError: false,
                }
                toolResults.push(toolResult)
                yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                const toolResult: ToolResult = { toolUseId: toolCall.id, content: msg, isError: true }
                toolResults.push(toolResult)
                yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
              }
            } else {
              const denyMessage = (userDecision as { message?: string }).message ?? 'User denied this operation.'
              const toolResult: ToolResult = { toolUseId: toolCall.id, content: denyMessage, isError: true }
              toolResults.push(toolResult)
              yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
            }
          } else {
            const toolResult: ToolResult = {
              toolUseId: toolCall.id,
              content: `Permission required: ${askMessage}. No approval handler available - operation skipped.`,
              isError: true,
            }
            toolResults.push(toolResult)
            yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
          }
          continue
        }

        if (permission.behavior === 'deny') {
          const denyMessage = (permission as { message?: string }).message ?? 'Permission denied.'
          const toolResult: ToolResult = { toolUseId: toolCall.id, content: denyMessage, isError: true }
          toolResults.push(toolResult)
          yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
          continue
        }

        try {
          const effectiveInput = (permission as { updatedInput?: unknown }).updatedInput
            ? (permission as { updatedInput: Record<string, unknown> }).updatedInput
            : toolCall.input
          const result = await tool.call(effectiveInput, toolUseContext)
          const toolResult: ToolResult = {
            toolUseId: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            isError: false,
          }
          toolResults.push(toolResult)
          yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          const toolResult: ToolResult = { toolUseId: toolCall.id, content: msg, isError: true }
          toolResults.push(toolResult)
          yield { type: 'tool_use_result', toolName: toolCall.name, result: toolResult }
        }
      }

      const toolResultMessages = toolResults.map(tr => createToolResultMessage(tr))
      state = transitionState(state, {
        messages: [...state.messages, ...assistantContent, ...toolResultMessages],
        turnCount: state.turnCount + 1,
        usage: turnUsage,
        transition: { reason: 'tool_use', toolName: toolCalls[0]?.name ?? 'unknown' },
      })

      yield { type: 'turn_end', turnCount: state.turnCount, usage: turnUsage }
      continue
    }

    const finalStopReason = mapStopReason(stopReasonFromApi)
    state = transitionState(state, {
      stopReason: finalStopReason,
      usage: turnUsage,
      turnCount: state.turnCount + 1,
    })

    yield { type: 'turn_end', turnCount: state.turnCount, usage: turnUsage }
    yield { type: 'stop', reason: finalStopReason }
    return buildResult(state)
  }
}

function buildResult(state: AgentState): QueryResult {
  return {
    messages: state.messages,
    usage: state.usage,
    stopReason: state.stopReason ?? { reason: 'end_turn' },
    turnCount: state.turnCount,
  }
}

function prependContext(
  messages: Message[],
  userContext: Record<string, string>,
  systemContext: Record<string, string>,
): Message[] {
  return messages
}

async function compressIfNeeded(
  messages: Message[],
  state: AgentState,
  deps: QueryDeps,
): Promise<Message[]> {
  return messages
}

function accumulateUsage(current: UsageMetrics, update: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): UsageMetrics {
  return {
    inputTokens: current.inputTokens + (update.input_tokens ?? 0),
    outputTokens: current.outputTokens + (update.output_tokens ?? 0),
    cacheReadInputTokens: current.cacheReadInputTokens + (update.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: current.cacheCreationInputTokens + (update.cache_creation_input_tokens ?? 0),
    totalTokens: current.totalTokens + (update.input_tokens ?? 0) + (update.output_tokens ?? 0),
    totalCostUsd: current.totalCostUsd,
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn': return { reason: 'end_turn' }
    case 'max_tokens': return { reason: 'max_tokens' }
    case 'stop_sequence': return { reason: 'stop_sequence' }
    case 'tool_use': return { reason: 'tool_use' }
    default: return { reason: 'end_turn' }
  }
}

function createToolUseContext(tools: Tool[], state: AgentState, abortController: AbortController): ToolUseContext {
  return {
    tools,
    messages: state.messages,
    abortController,
    getAppState: () => ({}),
    setAppState: () => {},
  }
}

function createToolResultMessage(result: ToolResult): Message {
  return {
    id: `result-${result.toolUseId}`,
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: result.toolUseId,
      content: result.content,
      is_error: result.isError,
    }],
    timestamp: Date.now(),
  }
}
