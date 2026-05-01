import type { Message, ModelAlias, UsageMetrics, PermissionMode } from '../core/types.js'
import type { AgentDefinition } from './definition.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import type { LLMProvider, ProviderRequestOptions, ProviderResponse, ProviderStreamChunk } from '../providers/types.js'
import type { ToolExecutionPipeline, ToolOrchestrationConfig } from '../tools/execution.js'
import { filterToolsForAgent } from '../tools/base.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from './definition.js'
import { createDefaultPipeline, orchestrateToolCalls, ToolExecutionError } from '../tools/execution.js'
import { createLogger } from '../utils/logger.js'
import { getMemoryManager } from '../memory/manager.js'

const logger = createLogger('agent-runner')

export interface AgentRunOptions {
  agentDefinition: AgentDefinition
  prompt: string
  messages?: Message[]
  tools: Tool[]
  model: string
  provider: LLMProvider
  systemPrompt?: SystemPrompt
  maxTurns?: number
  maxBudgetUsd?: number
  signal?: AbortSignal
  onProgress?: (event: unknown) => void
  parentContext?: ToolUseContext
  pipeline?: ToolExecutionPipeline
  orchestrationConfig?: ToolOrchestrationConfig
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
  const { agentDefinition, prompt, tools, model, provider } = options

  const resolvedModel = resolveAgentModel(agentDefinition.getModel(), model)
  const agentTools = resolveAgentTools(agentDefinition, tools)
  let systemPromptContent = await agentDefinition.getSystemPrompt({
    toolUseContext: options.parentContext ?? createDefaultToolUseContext(tools),
  })

  const memoryManager = getMemoryManager()
  if (memoryManager) {
    try {
      const memorySection = await memoryManager.buildSystemPromptSection()
      if (memorySection) {
        systemPromptContent = systemPromptContent + '\n\n' + memorySection
      }

      const userQuery = extractTextFromMessages(options.messages) ?? prompt
      if (userQuery) {
        const memoryContext = await memoryManager.getMemoryContextForQuery(userQuery)
        if (memoryContext) {
          systemPromptContent = systemPromptContent + '\n\n' + memoryContext
        }
      }
    } catch (error) {
      logger.warn(`Failed to inject memory context: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

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
    provider,
    options,
    options.pipeline ?? createDefaultPipeline(),
    options.orchestrationConfig,
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
  provider: LLMProvider,
  options: AgentRunOptions,
  pipeline: ToolExecutionPipeline,
  orchestrationConfig?: ToolOrchestrationConfig,
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

  const resolvedModel = provider.resolveModel(model)
  const modelConfig = provider.getModelConfig(model)
  const maxTokens = modelConfig?.defaultMaxTokens ?? provider.config.defaultMaxTokens ?? 4096

  const inputPricePerMToken = modelConfig?.inputPricePerMToken
  const outputPricePerMToken = modelConfig?.outputPricePerMToken

  logger.info(`Starting agent loop, model=${resolvedModel}, maxTurns=${maxTurns}, provider=${provider.name}`)

  while (turnCount < maxTurns) {
    turnCount++
    logger.debug(`Turn ${turnCount} starting`)

    const providerMessages = allMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.map(c => {
        if (c.type === 'text') return { type: 'text' as const, text: c.text ?? '' }
        if (c.type === 'tool_use') return { type: 'tool_use' as const, id: c.id ?? '', name: c.name ?? '', input: c.input ?? {} }
        if (c.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: c.tool_use_id ?? '', content: c.content ?? '', is_error: c.is_error ?? false }
        return c
      }),
    }))

    const toolDefs = tools.filter(t => t.isEnabled()).map(t => t.getDefinition())

    const requestOptions: ProviderRequestOptions = {
      model: resolvedModel,
      messages: providerMessages,
      tools: toolDefs.length > 0 ? toolDefs.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as unknown as Record<string, unknown>,
      })) : undefined,
      maxTokens,
      temperature: modelConfig?.defaultTemperature ?? provider.config.defaultTemperature,
      stream: false,
      systemPrompt: systemPromptContent || undefined,
      signal: options.signal,
    }

    let response: ProviderResponse
    try {
      logger.debug(`Calling provider ${provider.name} with model ${resolvedModel}`)
      response = await provider.createMessage(requestOptions)
      logger.info(`Provider responded, stopReason=${response.stopReason}, usage={in:${response.usage.inputTokens}, out:${response.usage.outputTokens}}`)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Provider call failed: ${errMsg}`)
      allMessages.push({
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: `[Error] Failed to get response from provider: ${errMsg}` }],
        timestamp: Date.now(),
      })
      usage.inputTokens += 0
      usage.outputTokens += 0
      break
    }

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    usage.cacheReadInputTokens += response.usage.cacheReadInputTokens ?? 0
    usage.cacheCreationInputTokens += response.usage.cacheCreationInputTokens ?? 0
    usage.totalTokens += response.usage.inputTokens + response.usage.outputTokens

    if (inputPricePerMToken !== undefined && outputPricePerMToken !== undefined) {
      usage.totalCostUsd +=
        (response.usage.inputTokens * inputPricePerMToken) / 1_000_000 +
        (response.usage.outputTokens * outputPricePerMToken) / 1_000_000
    }

    const assistantMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: response.content.map(block => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text ?? '' }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use' as const, id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }
        }
        return block
      }),
      timestamp: Date.now(),
    }
    allMessages.push(assistantMessage)

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) {
      logger.info(`No tool calls, ending loop at turn ${turnCount}`)
      break
    }

    logger.info(`Model requested ${toolUseBlocks.length} tool call(s)`)

    const toolCalls = toolUseBlocks.map(block => ({
      id: block.id ?? '',
      name: block.name ?? '',
      input: (block.input ?? {}) as Record<string, unknown>,
    }))

    const toolUseContext: ToolUseContext = {
      tools,
      messages: allMessages,
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
    }

    const orchestratedResults = await orchestrateToolCalls(
      toolCalls,
      tools,
      toolUseContext,
      pipeline,
      orchestrationConfig,
    )

    for (const { id, name, result: execResult } of orchestratedResults) {
      toolUseCount++

      if (execResult.error) {
        const errMsg = execResult.error.message
        logger.error(`Tool ${name} failed (${execResult.error.code}): ${errMsg}`)

        allMessages.push({
          id: `result-${id}`,
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: errMsg,
            is_error: true,
          }],
          timestamp: Date.now(),
        })
      } else {
        const resultStr = typeof execResult.output === 'string'
          ? execResult.output
          : JSON.stringify(execResult.output)

        allMessages.push({
          id: `result-${id}`,
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: resultStr,
            is_error: false,
          }],
          timestamp: Date.now(),
        })
      }
    }
  }

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

function extractTextFromMessages(messages?: Message[]): string | null {
  if (!messages || messages.length === 0) return null
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  return extractTextFromMessage(lastUserMsg)
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
