import type { Message, ModelAlias, UsageMetrics, PermissionMode, ThinkingEffort, AgentStreamEvent, ToolProgressData } from '../core/types.js'
import type { AgentDefinition } from './definition.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import type { LLMProvider, ProviderRequestOptions, ProviderResponse, ProviderStreamChunk, ProviderContentBlock } from '../providers/types.js'
import type { ToolExecutionPipeline, ToolOrchestrationConfig } from '../tools/execution.js'
import { filterToolsForAgent } from '../tools/base.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from './definition.js'
import { createDefaultPipeline, orchestrateToolCalls, ToolExecutionError } from '../tools/execution.js'
import { createPermissionChecker, createDefaultClassifier } from '../permissions/index.js'
import { HookRegistry, HookExecutor, loadHookConfig } from '../hooks/index.js'
import type { HookExecutionContext } from '../hooks/index.js'
import { createLogger } from '../utils/logger.js'
import { getMemoryManager } from '../memory/manager.js'
import { getWorkingSet } from '../memory/working-set-registry.js'
import { buildContext, detectFocusMode } from '../memory/context-builder.js'
import { microCompactMessages, estimateMessageTokens } from '../memory/compact/micro-compact.js'
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../utils/circuit-breaker.js'
import { resolveThinkingStrategy } from './thinking-prompts.js'
import { BEHAVIOR_RULES_SECTION, buildFullSystemPrompt, type SystemPromptBuildOptions } from '../context/system-prompt.js'
import { isFeatureEnabled } from '../feature-gate/index.js'
import { TelemetryManager } from '../telemetry/index.js'
import { classifyError } from '../permissions/index.js'
import { AutoCompactor, getAutoCompactConfig } from '../memory/compact/index.js'
import { CostTracker } from '../utils/cost-tracker.js'
import { MemoryExtractor } from '../memory/extractor.js'
import { computeBudgetAllocation, buildContextFromSlots, type ContextSlot, type ContextBudgetConfig, getBudgetConfig } from '../memory/context-budget.js'
import { generateToolUseSummary, type ToolUseInfo } from '../tools/built-in/tool-use-summary.js'

const logger = createLogger('agent-runner')

export interface ToolRetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  retryableErrors: string[]
}

const DEFAULT_RETRY_CONFIG: ToolRetryConfig = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 3000,
  retryableErrors: [
    'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET',
    'TIMEOUT', 'RATE_LIMIT', 'rate_limit', '429', '503',
  ],
}

interface ToolFailureContext {
  toolName: string
  error: string
  attemptNumber: number
  previousAttempts: Array<{ error: string; timestamp: number }>
}

interface AdvisorSuggestion {
  observation: string
  concern: string
  suggestion: string
  verdict: 'PROCEED' | 'RETHINK' | 'PIVOT'
}

const providerCircuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG)

export interface ApprovalEvent {
  type: 'approval_required'
  toolName: string
  toolInput: Record<string, unknown>
  toolCallId: string
  message: string
  suggestions?: string[]
}

export interface ApprovalResponse {
  decision: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  reason?: string
  permissionUpdate?: {
    type: 'always_allow' | 'always_deny' | 'allow_pattern'
    toolName: string
    pattern?: string
    reason?: string
  }
}

export interface HumanInputEvent {
  type: 'human_input_required'
  message: string
  context?: string
  options?: Array<{ label: string; value: string; description?: string }>
}

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
  stream?: boolean
  onProgress?: (event: AgentStreamEvent) => void
  parentContext?: ToolUseContext
  pipeline?: ToolExecutionPipeline
  orchestrationConfig?: ToolOrchestrationConfig
  permissionMode?: PermissionMode
  requestApproval?: (event: ApprovalEvent) => Promise<ApprovalResponse>
  requestHumanInput?: (event: HumanInputEvent) => Promise<string>
  enableRetry?: boolean
  retryConfig?: Partial<ToolRetryConfig>
  enableAdvisorOnFailure?: boolean
  advisorModel?: string
  agentDefinitions?: AgentDefinition[]
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

  const modelConfig = provider.getModelConfig(resolvedModel)
  const thinkingStrategy = resolveThinkingStrategy(
    agentDefinition.getEffort(),
    modelConfig?.supportsThinking ?? false,
    modelConfig?.supportsReasoningEffort ?? false,
  )

  let systemPromptContent = await agentDefinition.getSystemPrompt({
    toolUseContext: options.parentContext ?? createDefaultToolUseContext(tools),
  })

  if (thinkingStrategy.promptInjection) {
    systemPromptContent = systemPromptContent + '\n\n' + thinkingStrategy.promptSuffix
  }

  const enabledTools = new Set(tools.filter(t => t.isEnabled()).map(t => t.name))

  const buildOptions: SystemPromptBuildOptions = {
    model: resolvedModel,
    enabledTools,
    mcpInstructions: true,
    skillList: true,
  }

  systemPromptContent = await buildFullSystemPrompt(systemPromptContent, buildOptions)

  if (options.agentDefinitions && options.agentDefinitions.length > 0) {
    const agentList = options.agentDefinitions.map(a =>
      `- **${a.name}** (${a.subagentType}): ${a.description}${a.isBuiltIn() ? ' [built-in]' : ''}${a.isBackground() ? ' [background]' : ''}`
    ).join('\n')
    systemPromptContent = systemPromptContent + `\n\n---DYNAMIC_BOUNDARY---\n\n=== AVAILABLE SUB-AGENTS ===\n${agentList}\n\nWhen delegating work, choose the most appropriate agent type for the task.`
  }

  const memoryManager = getMemoryManager()
  if (memoryManager) {
    try {
      const userQuery = extractTextFromMessages(options.messages) ?? prompt
      const agentContextConfig = agentDefinition.getContextConfig()

      const ws = getWorkingSet()
      if (ws && userQuery) {
        const lastUserMsg = options.messages
          ? [...options.messages].reverse().find(m => m.role === 'user')
          : null
        if (lastUserMsg) {
          const msgText = lastUserMsg.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
            .join('\n')
          ws.detectAndPinFromContent(msgText, 'user-message')
        }
      }

      const contextResult = await buildContext(memoryManager, ws, {
        userQuery: userQuery || '',
        messages: options.messages?.map(m => ({
          role: m.role,
          content: m.content.filter(c => c.type === 'text' && c.text).map(c => c.text!).join('\n'),
        })),
        focusMode: agentContextConfig.focusMode,
        budgetConfig: agentContextConfig.budgetConfig,
        maxMemoryItems: agentContextConfig.maxMemoryItems,
        enableDedup: agentContextConfig.enableDedup,
        enableCompression: agentContextConfig.enableCompression,
      })

      if (contextResult.systemPrompt) {
        systemPromptContent = systemPromptContent + '\n\n' + contextResult.systemPrompt
      }

      if (agentContextConfig.enableSgaMd) {
        try {
          const { loadSgaMd } = await import('../context/claudemd.js')
          const comfyuiBaseDir = process.env.COMFYUI_BASE_DIR
          const projectPaths = comfyuiBaseDir ? [process.cwd(), comfyuiBaseDir] : [process.cwd()]
          const sgaMdContent = await loadSgaMd({ projectPaths })
          if (sgaMdContent.trim()) {
            systemPromptContent = systemPromptContent + '\n\n## Project Context (SGA.md)\n' + sgaMdContent
          }
        } catch (err) {
          logger.debug(`SGA.md loading skipped: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (agentContextConfig.enableSkills && agentContextConfig.skillNames?.length) {
        try {
          const { formatSkillListForPrompt, separateConditionalSkills, activateConditionalSkills } = await import('../skills/index.js')
          const { discoverSkills } = await import('../skills/index.js')
          const allSkills = await discoverSkills()
          const skillState = separateConditionalSkills(allSkills)
          const activeSkills = activateConditionalSkills(skillState, userQuery || '')
          const filtered = activeSkills.filter(s => agentContextConfig.skillNames!.includes(s.name))
          if (filtered.length > 0) {
            const skillPrompt = formatSkillListForPrompt(filtered)
            if (skillPrompt.trim()) {
              systemPromptContent = systemPromptContent + '\n\n## Available Skills\n' + skillPrompt
            }
          }
        } catch (err) {
          logger.debug(`Skills loading skipped: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      logger.info(
        `Context built: focus=${contextResult.focusMode}, ` +
        `workingSet=${contextResult.workingSetItems}, ` +
        `memories=${contextResult.memoryItemsInjected}, ` +
        `dedup=${contextResult.dedupRemoved}, ` +
        `compressed=${contextResult.compressedItems}, ` +
        `tokens=${contextResult.totalTokensUsed}`,
      )
    } catch (error) {
      logger.warn(`Failed to inject memory context: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (isFeatureEnabled('context_budget')) {
    try {
      const budgetConfig = getBudgetConfig()
      const systemTokenEstimate = Math.ceil(systemPromptContent.length / 4)
      if (systemTokenEstimate > budgetConfig.reservedForSystem) {
        logger.warn(
          `System prompt exceeds budget: ${systemTokenEstimate} tokens > ${budgetConfig.reservedForSystem} reserved. ` +
          `Consider reducing context injection.`,
        )
      }
      const allocation = computeBudgetAllocation(budgetConfig)
      logger.info(
        `Context budget: system=${allocation.systemInstruction}, ` +
        `workingSet=${allocation.workingSet}, memory=${allocation.memory}, ` +
        `conversation=${allocation.conversation}, tools=${allocation.tools}`,
      )
    } catch (budgetError) {
      logger.debug(`Context budget check skipped: ${budgetError instanceof Error ? budgetError.message : String(budgetError)}`)
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

  if (isFeatureEnabled('task_planning') && prompt && isComplexTask(prompt)) {
    const planningHint = generatePlanningHint(prompt)
    initialMessages.push({
      id: `planning-hint-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: planningHint }],
      timestamp: Date.now(),
    })
    logger.info('Complex task detected, injected planning hint')
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
    thinkingStrategy,
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
  thinkingStrategy?: {
    nativeThinking: boolean
    nativeReasoningEffort: boolean
    promptInjection: boolean
    thinkingBudget: number | undefined
    reasoningEffort: 'low' | 'medium' | 'high' | undefined
    promptSuffix: string
  },
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

  const costTracker = new CostTracker({
    maxBudgetUsd: options.maxBudgetUsd,
    costPerInputToken: inputPricePerMToken ? inputPricePerMToken / 1_000_000 : undefined,
    costPerOutputToken: outputPricePerMToken ? outputPricePerMToken / 1_000_000 : undefined,
  })

  const providerCircuitBreaker = new CircuitBreaker({
    maxConsecutiveFailures: 3,
    cooldownMs: 10_000,
    halfOpenMaxAttempts: 1,
  })

  let memoryExtractor: MemoryExtractor | undefined
  const loopMemoryManager = getMemoryManager()
  if (loopMemoryManager && isFeatureEnabled('memory_extraction')) {
    memoryExtractor = new MemoryExtractor(loopMemoryManager)
    memoryExtractor.setProvider(provider, resolvedModel)
  }

  logger.info(`Starting agent loop, model=${resolvedModel}, maxTurns=${maxTurns}, provider=${provider.name}`)

  const useStream = options.stream ?? false

  let hookRegistry: HookRegistry | undefined
  let hookExecutor: HookExecutor | undefined
  try {
    const hookConfig = loadHookConfig()
    hookRegistry = new HookRegistry()
    for (const hookDef of hookConfig.hooks) {
      hookRegistry.register(hookDef)
    }
    hookExecutor = new HookExecutor(hookRegistry)

    const sessionHookCtx: HookExecutionContext = {
      sessionId: options.parentContext?.agentId,
      cwd: process.cwd(),
    }
    await hookExecutor.execute('SessionStart', sessionHookCtx)
  } catch (error) {
    logger.debug(`Hook system initialization skipped: ${error instanceof Error ? error.message : String(error)}`)
  }

  const consecutiveFailures: Array<{ turn: number; toolName: string; error: string }> = []
  const MAX_CONSECUTIVE_FAILURES = 3

  while (turnCount < maxTurns) {
    turnCount++
    logger.debug(`Turn ${turnCount} starting`)

    if (options.onProgress) {
      options.onProgress({ type: 'turn_start', turnCount })
    }

    if (hookExecutor && turnCount === 1) {
      try {
        const promptCtx: HookExecutionContext = {
          sessionId: options.parentContext?.agentId,
          cwd: process.cwd(),
        }
        await hookExecutor.execute('UserPromptSubmit', promptCtx)
      } catch (err) {
        logger.debug(`UserPromptSubmit hook skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const compactResult = microCompactMessages(allMessages)
    if (compactResult.tokensSaved > 0) {
      logger.info(
        `Micro-compact: trigger=${compactResult.trigger}, cleared=${compactResult.toolsCleared}, saved≈${compactResult.tokensSaved} tokens`,
      )
      allMessages.length = 0
      allMessages.push(...compactResult.messages)
    }

    const currentTokens = estimateMessageTokens(allMessages)
    const maxContextTokens = options.agentDefinition.getContextConfig().budgetConfig?.maxContextTokens ?? 200_000
    if (currentTokens > maxContextTokens * 0.9) {
      try {
        const { compressContext } = await import('../context/compression.js')
        const compressionResult = await compressContext(allMessages, currentTokens, {
          autoCompactEnabled: true,
          autoCompactThreshold: 0.75,
          maxContextTokens,
          snipEnabled: true,
          microEnabled: false,
          collapseEnabled: true,
        })
        if (compressionResult.wasCompressed) {
          logger.info(
            `Context compressed: level=${compressionResult.level}, saved≈${compressionResult.tokensSaved} tokens`,
          )
          allMessages.length = 0
          allMessages.push(...compressionResult.messages)
        }
      } catch (err) {
        logger.warn(`Context compression failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

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
      stream: useStream,
      systemPrompt: systemPromptContent || undefined,
      signal: options.signal,
      thinkingBudget: thinkingStrategy?.nativeThinking ? thinkingStrategy.thinkingBudget : undefined,
      reasoningEffort: thinkingStrategy?.nativeReasoningEffort ? thinkingStrategy.reasoningEffort : undefined,
    }

    let response: ProviderResponse
    try {
      if (!providerCircuitBreaker.canExecute()) {
        const stats = providerCircuitBreaker.getStats()
        logger.warn(`Provider circuit breaker is ${stats.state}, waiting ${stats.timeUntilCooldown}ms`)
        if (stats.timeUntilCooldown > 0) {
          await sleep(stats.timeUntilCooldown)
        }
        if (!providerCircuitBreaker.canExecute()) {
          throw new Error(`Provider circuit breaker is open. Consecutive failures: ${stats.consecutiveFailures}. Please retry later.`)
        }
      }

      logger.debug(`Calling provider ${provider.name} with model ${resolvedModel}, stream=${useStream}`)

      if (options.onProgress) {
        options.onProgress({ type: 'api_call_start', turnCount })
      }

      if (useStream) {
        response = await consumeStream(provider, requestOptions, options.onProgress)
      } else {
        response = await provider.createMessage(requestOptions)
      }

      providerCircuitBreaker.recordSuccess()

      logger.info(`Provider responded, stopReason=${response.stopReason}, usage={in:${response.usage.inputTokens}, out:${response.usage.outputTokens}}`)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      providerCircuitBreaker.recordFailure(error instanceof Error ? error : undefined)
      logger.error(`Provider call failed: ${errMsg}`)
      providerCircuitBreaker.recordFailure(error instanceof Error ? error : new Error(errMsg))
      const errorText = `[Error] Failed to get response from provider: ${errMsg}`
      if (options.onProgress) {
        options.onProgress({ type: 'stream_delta', text: errorText })
        options.onProgress({ type: 'error', data: errMsg })
      }
      allMessages.push({
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: errorText }],
        timestamp: Date.now(),
      })
      break
    }

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    usage.cacheReadInputTokens += response.usage.cacheReadInputTokens ?? 0
    usage.cacheCreationInputTokens += response.usage.cacheCreationInputTokens ?? 0
    usage.totalTokens += response.usage.inputTokens + response.usage.outputTokens

    costTracker.addUsage(response.usage)

    if (costTracker.isOverBudget()) {
      logger.warn(`Budget exceeded: $${costTracker.getTotalCostUsd().toFixed(4)} / $${options.maxBudgetUsd?.toFixed(2) ?? '∞'}`)
      allMessages.push({
        id: `budget-warning-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: `=== BUDGET EXCEEDED ===\nTotal cost: $${costTracker.getTotalCostUsd().toFixed(4)}\nBudget: $${options.maxBudgetUsd?.toFixed(2) ?? '∞'}\nYou must stop here. The budget has been exceeded.` }],
        timestamp: Date.now(),
      })
      break
    }

    if (costTracker.isNearBudget()) {
      const remaining = costTracker.getRemainingBudget()
      logger.info(`Approaching budget limit: $${costTracker.getTotalCostUsd().toFixed(4)} used, $${remaining?.toFixed(4) ?? '∞'} remaining`)
    }

    if (response.content.length === 0) {
      logger.warn(`Provider returned empty content (stopReason=${response.stopReason}, usage={in:${response.usage.inputTokens}, out:${response.usage.outputTokens}}). This may indicate a compatibility issue with the provider.`)
    }

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
      if (options.onProgress) {
        options.onProgress({ type: 'turn_end', turnCount, usage })
      }
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
      getAppState: () => ({
        requestHumanInput: options.requestHumanInput
          ? async (event: { type: string; message: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }) => {
              const convertedOptions = event.options?.map(o => ({
                label: o.label,
                value: o.label,
                description: o.description,
              }))
              return options.requestHumanInput!({
                type: 'human_input_required',
                message: event.message,
                options: convertedOptions,
              })
            }
          : undefined,
      }),
      setAppState: () => {},
      permissionMode: options.permissionMode ?? 'default',
      permissionChecker: createPermissionChecker(options.permissionMode ?? 'default', undefined, createDefaultClassifier()),
    }

    const orchestratedResults = await orchestrateToolCalls(
      toolCalls,
      tools,
      toolUseContext,
      pipeline,
      orchestrationConfig,
      options.onProgress
        ? (toolUseId: string, data: ToolProgressData) => {
            const toolCall = toolCalls.find(tc => tc.id === toolUseId)
            options.onProgress!({
              type: 'tool_progress',
              toolName: toolCall?.name ?? 'unknown',
              toolUseId,
              data,
            })
          }
        : undefined,
    )

    for (const { id, name, result: execResult } of orchestratedResults) {
      toolUseCount++

      if (execResult.error?.code === 'APPROVAL_REQUIRED' && options.requestApproval) {
        logger.info(`Tool ${name} requires approval, requesting user decision`)

        const approvalEvent: ApprovalEvent = {
          type: 'approval_required',
          toolName: name,
          toolInput: execResult.input as Record<string, unknown>,
          toolCallId: id,
          message: execResult.error.message,
        }

        try {
          const userDecision = await options.requestApproval(approvalEvent)

          if (userDecision.decision === 'allow') {
            const tool = tools.find(t => t.name === name)
            const effectiveInput = userDecision.updatedInput ?? execResult.input as Record<string, unknown>

            if (userDecision.permissionUpdate) {
              applyPermissionUpdate(userDecision.permissionUpdate, toolUseContext)
            }

            try {
              const toolProgress = options.onProgress
                ? (data: ToolProgressData) => {
                    options.onProgress!({ type: 'tool_progress', toolName: name, toolUseId: id, data })
                  }
                : undefined
              const result = await tool!.call(effectiveInput, toolUseContext, toolProgress)
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
              allMessages.push({
                id: `result-${id}`,
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: id, content: resultStr, is_error: false }],
                timestamp: Date.now(),
              })
              if (options.onProgress) {
                options.onProgress({ type: 'tool_use_result', toolName: name, result: { toolUseId: id, content: resultStr, isError: false } })
              }
            } catch (callError) {
              const msg = callError instanceof Error ? callError.message : String(callError)
              allMessages.push({
                id: `result-${id}`,
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: id, content: msg, is_error: true }],
                timestamp: Date.now(),
              })
              if (options.onProgress) {
                options.onProgress({ type: 'tool_use_result', toolName: name, result: { toolUseId: id, content: msg, isError: true } })
              }
              if (hookExecutor) {
                try {
                  const failureResults = await hookExecutor.executeFailureHooks(
                    name,
                    effectiveInput,
                    msg,
                    {
                      sessionId: options.parentContext?.agentId,
                      cwd: process.cwd(),
                    },
                  )
                  for (const fr of failureResults) {
                    if (fr.additionalContext) {
                      allMessages.push({
                        id: `hook-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        role: 'user',
                        content: [{ type: 'text', text: `[Hook Context] ${fr.additionalContext}` }],
                        timestamp: Date.now(),
                      })
                    }
                  }
                } catch (hookErr) {
                  logger.debug(`PostToolUseFailure hook failed for ${name}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`)
                }
              }
            }
          } else {
            const denyMsg = userDecision.reason ?? 'User denied this operation.'
            allMessages.push({
              id: `result-${id}`,
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: id, content: denyMsg, is_error: true }],
              timestamp: Date.now(),
            })
            if (options.onProgress) {
              options.onProgress({ type: 'tool_use_result', toolName: name, result: { toolUseId: id, content: denyMsg, isError: true } })
            }
          }
        } catch (approvalError) {
          const msg = approvalError instanceof Error ? approvalError.message : String(approvalError)
          allMessages.push({
            id: `result-${id}`,
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: `Approval request failed: ${msg}`, is_error: true }],
            timestamp: Date.now(),
          })
        }
        continue
      }

      if (execResult.error) {
        const errMsg = execResult.error.message
        const formattedError = execResult.error.toFormattedString()
        logger.error(`Tool ${name} failed (${execResult.error.code}): ${errMsg}`)

        consecutiveFailures.push({ turn: turnCount, toolName: name, error: errMsg })

        const retryConfig: ToolRetryConfig = {
          ...DEFAULT_RETRY_CONFIG,
          ...options.retryConfig,
        }
        const enableRetry = options.enableRetry ?? true
        const enableAdvisor = options.enableAdvisorOnFailure ?? true

        let finalErrorMsg = formattedError
        let retryCount = 0
        let didRetry = false
        const previousErrors: Array<{ error: string; timestamp: number }> = []

        if (enableRetry && isFeatureEnabled('tool_retry') && isRetryableError(errMsg, retryConfig.retryableErrors)) {
          const tool = tools.find(t => t.name === name)
          if (tool) {
            while (retryCount < retryConfig.maxRetries) {
              retryCount++
              const delay = Math.min(
                retryConfig.baseDelayMs * Math.pow(2, retryCount - 1),
                retryConfig.maxDelayMs
              )
              logger.info(`Tool ${name} failed, retrying (${retryCount}/${retryConfig.maxRetries}) after ${delay}ms`)
              await sleep(delay)

              previousErrors.push({ error: errMsg, timestamp: Date.now() })

              try {
                const toolProgress = options.onProgress
                  ? (data: ToolProgressData) => {
                      options.onProgress!({ type: 'tool_progress', toolName: name, toolUseId: id, data })
                    }
                  : undefined
                const retryResult = await tool.call(execResult.input as Record<string, unknown>, toolUseContext, toolProgress)
                const retryResultStr = typeof retryResult === 'string' ? retryResult : JSON.stringify(retryResult)

                allMessages.push({
                  id: `result-${id}`,
                  role: 'user',
                  content: [{
                    type: 'tool_result',
                    tool_use_id: id,
                    content: `[Retry ${retryCount} successful]\n${retryResultStr}`,
                    is_error: false,
                  }],
                  timestamp: Date.now(),
                })
                didRetry = true
                if (options.onProgress) {
                  options.onProgress({ type: 'tool_use_result', toolName: name, result: { toolUseId: id, content: retryResultStr, isError: false } })
                }
                break
              } catch (retryError) {
                finalErrorMsg = retryError instanceof Error ? retryError.message : String(retryError)
                logger.warn(`Retry ${retryCount} failed: ${finalErrorMsg}`)
              }
            }
          }
        }

        if (!didRetry) {
          if (isFeatureEnabled('telemetry')) {
            const telemetry = TelemetryManager.getInstance()
            telemetry.trackToolUse(name, 0, false, classifyError(errMsg))
          }

          if (enableAdvisor && isFeatureEnabled('advisor_agent') && previousErrors.length === 0) {
            previousErrors.push({ error: errMsg, timestamp: Date.now() })
          }

          if (previousErrors.length > 0) {
            const advisorSuggestion = await callAdvisorForFailure(
              name,
              previousErrors,
              allMessages,
              provider,
              options.advisorModel ?? resolvedModel,
              options.signal,
            )

            if (advisorSuggestion) {
              const advisorMsg = formatAdvisorMessage(advisorSuggestion)
              allMessages.push({
                id: `advisor-${Date.now()}`,
                role: 'user',
                content: [{ type: 'text', text: advisorMsg }],
                timestamp: Date.now(),
              })
              logger.info(`Advisor suggested: ${advisorSuggestion.verdict} - ${advisorSuggestion.suggestion}`)
            }
          }

          allMessages.push({
            id: `result-${id}`,
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: id,
              content: didRetry ? finalErrorMsg : formattedError,
              is_error: true,
            }],
            timestamp: Date.now(),
          })

          if (hookExecutor) {
            try {
              const failureResults = await hookExecutor.executeFailureHooks(
                name,
                execResult.input as Record<string, unknown>,
                didRetry ? finalErrorMsg : formattedError,
                {
                  sessionId: options.parentContext?.agentId,
                  cwd: process.cwd(),
                },
              )
              for (const fr of failureResults) {
                if (fr.additionalContext) {
                  allMessages.push({
                    id: `hook-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    role: 'user',
                    content: [{ type: 'text', text: `[Hook Context] ${fr.additionalContext}` }],
                    timestamp: Date.now(),
                  })
                }
              }
            } catch (hookErr) {
              logger.debug(`PostToolUseFailure hook failed for ${name}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`)
            }
          }
        }
      } else {
        const resultStr = typeof execResult.output === 'string'
          ? execResult.output
          : JSON.stringify(execResult.output)

        consecutiveFailures.length = 0

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

        if (hookExecutor) {
          try {
            const postToolCtx: HookExecutionContext = {
              toolName: name,
              toolInput: execResult.input as Record<string, unknown>,
              toolOutput: execResult.output,
              sessionId: options.parentContext?.agentId,
              cwd: process.cwd(),
            }
            await hookExecutor.execute('PostToolUse', postToolCtx)
          } catch (hookErr) {
            logger.debug(`PostToolUse hook failed for ${name}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`)
          }
        }

        if (name === 'workflow_action' && options.onProgress) {
          try {
            const toolInput = execResult.input as Record<string, unknown>
            const actionType = (toolInput.action_type as string) ?? 'unknown'
            const workflowJson = (toolInput.workflow_json as string) ?? ''
            if (workflowJson) {
              options.onProgress({ type: 'workflow_updated', workflowJson, actionType })
            }
          } catch {
            // skip
          }
        }
      }
    }

    if (isFeatureEnabled('tool_batch_summary') && orchestratedResults.length > 1) {
      const summaryParts = orchestratedResults.map(({ name, result: r }) => {
        if (r.error) {
          return `- ${name}: FAILED (${r.error.code})`
        }
        const output = typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
        const truncated = output.length > 200 ? output.slice(0, 200) + '...' : output
        return `- ${name}: OK → ${truncated}`
      })

      let summaryText = `=== Tool Batch Summary ===\n${summaryParts.join('\n')}`

      try {
        const toolInfos: ToolUseInfo[] = orchestratedResults.map((r, i) => {
          const call = toolCalls[i]
          return {
            name: r.name,
            input: call?.input ?? {},
            output: r.result.error ? { error: r.result.error.message } : r.result.output,
          }
        })
        const lastAssistantMsg = allMessages
          .filter((m): m is Message & { role: 'assistant' } => m.role === 'assistant')
          .pop()
        const lastAssistantText = lastAssistantMsg?.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text!)
          .join('\n')

        const llmSummary = await generateToolUseSummary(toolInfos, provider, undefined, lastAssistantText)
        if (llmSummary) {
          summaryText = `=== Tool Batch Summary ===\n${llmSummary}\n\nDetails:\n${summaryParts.join('\n')}`
        }
      } catch (summaryError) {
        logger.debug(`LLM tool summary generation failed, using plain summary: ${summaryError instanceof Error ? summaryError.message : String(summaryError)}`)
      }

      allMessages.push({
        id: `tool-summary-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: summaryText }],
        timestamp: Date.now(),
      })
    }

    if (isFeatureEnabled('consecutive_failure_pivot') && consecutiveFailures.length >= MAX_CONSECUTIVE_FAILURES) {
      const failureSummary = consecutiveFailures
        .map((f, i) => `${i + 1}. Turn ${f.turn}: ${f.toolName} — ${f.error.slice(0, 200)}`)
        .join('\n')

      const pivotMessage = `=== CRITICAL: CONSECUTIVE FAILURE DETECTION ===

You have experienced ${consecutiveFailures.length} consecutive tool failures. This strongly suggests your current approach is not working.

**Failure History:**
${failureSummary}

**Required Action:** You MUST change your approach. Options:
1. **Try a completely different tool or method** — if Bash fails, try a different command; if a script fails, try a different script
2. **Break the problem into smaller steps** — the current step may be too large or complex
3. **Check your assumptions** — verify the environment, paths, and prerequisites
4. **Ask for help** — if you're truly stuck, use AskUserQuestion to get guidance

Do NOT repeat the same action that just failed. That is the definition of insanity.`

      allMessages.push({
        id: `pivot-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: pivotMessage }],
        timestamp: Date.now(),
      })

      logger.warn(`Consecutive failure threshold reached (${consecutiveFailures.length}), injecting pivot message`)
      consecutiveFailures.length = 0
    }

    if (memoryExtractor && isFeatureEnabled('memory_extraction') && turnCount % 3 === 0) {
      try {
        if (memoryExtractor.shouldExtract(allMessages.length)) {
          await memoryExtractor.extractMemories(allMessages)
          logger.info('Memory extraction completed for this turn')
        }
      } catch (extractError) {
        logger.debug(`Memory extraction skipped: ${extractError instanceof Error ? extractError.message : String(extractError)}`)
      }
    }

    if (isFeatureEnabled('auto_compact')) {
      try {
        const currentTokens = estimateMessageTokens(allMessages)
        const compactConfig = getAutoCompactConfig()
        const warningState = compactConfig.full
            ? calculateTokenWarningStateLocal(currentTokens, compactConfig.modelMaxTokens, 0.85)
            : 'ok'

        if (warningState !== 'ok') {
          logger.info(`Context token usage: ${currentTokens}, state=${warningState}, triggering auto-compact`)

          const compactor = new AutoCompactor(compactConfig)
          const sessionMemoryContent = loopMemoryManager
            ? await loopMemoryManager.getMemoryContextForQuery('current session context')
            : undefined

          const compactResult = await compactor.compactIfNeeded(
            allMessages,
            provider,
            resolvedModel,
            sessionMemoryContent,
          )

          if (compactResult.wasCompacted) {
            allMessages.length = 0
            allMessages.push(...compactResult.messages)
            logger.info(
              `Auto-compact completed: strategy=${compactResult.strategy}, ` +
              `messages=${compactResult.messages.length}, ` +
              `wasCompacted=${compactResult.wasCompacted}`,
            )

            if (options.onProgress) {
              options.onProgress({
                type: 'compact_end',
                messagesRemoved: compactResult.messages.length,
              })
            }
          }
        }
      } catch (compactError) {
        logger.warn(`Auto-compact failed: ${compactError instanceof Error ? compactError.message : String(compactError)}`)
      }
    }
  }

  if (options.onProgress) {
    options.onProgress({ type: 'turn_end', turnCount, usage })
  }

  if (hookExecutor) {
    try {
      const stopHookCtx: HookExecutionContext = {
        sessionId: options.parentContext?.agentId,
        cwd: process.cwd(),
      }
      await hookExecutor.execute('Stop', stopHookCtx)
    } catch (error) {
      logger.debug(`Stop hook execution failed: ${error instanceof Error ? error.message : String(error)}`)
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

type TokenWarningState = 'ok' | 'warning' | 'critical'

function calculateTokenWarningStateLocal(
  currentTokens: number,
  maxTokens: number,
  threshold: number,
): TokenWarningState {
  const ratio = currentTokens / maxTokens
  if (ratio >= 0.95) return 'critical'
  if (ratio >= threshold) return 'warning'
  return 'ok'
}

const COMPLEX_TASK_INDICATORS = [
  /implement|build|create|develop|design|refactor|migrate/i,
  /architecture|system|framework|platform/i,
  /multiple|several|various|comprehensive/i,
  /integrate|combine|merge|consolidate/i,
  /end.to.end|full.stack|complete/i,
  /and then|after that|followed by|next step/i,
]

function isComplexTask(prompt: string): boolean {
  const wordCount = prompt.split(/\s+/).length
  const hasMultipleSteps = /\d+[\.\)]\s/.test(prompt) || /step\s+\d+/i.test(prompt)
  const hasComplexIndicators = COMPLEX_TASK_INDICATORS.some(pattern => pattern.test(prompt))
  const hasMultipleRequirements = (prompt.match(/and|also|additionally|furthermore|moreover/gi) || []).length >= 2

  return wordCount > 50 || hasMultipleSteps || (hasComplexIndicators && hasMultipleRequirements)
}

function generatePlanningHint(prompt: string): string {
  const steps = extractImpliedSteps(prompt)
  return `=== TASK PLANNING GUIDANCE ===

This appears to be a complex task. Before diving into execution, you should:

1. **Analyze the task**: Break it down into sub-tasks and identify dependencies
2. **Create a plan**: Use TodoWrite to create a structured plan with ordered steps
3. **Execute sequentially**: Work through the plan step by step, verifying each step
4. **Verify at milestones**: After completing key steps, verify the results before proceeding

${steps.length > 0 ? `**Suggested sub-tasks based on your request:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}
Start by creating a plan using TodoWrite, then execute each item. Update the plan as you progress.`
}

function extractImpliedSteps(prompt: string): string[] {
  const steps: string[] = []

  const numberedItems = prompt.match(/\d+[\.\)]\s+[^\n]+/g)
  if (numberedItems) {
    steps.push(...numberedItems.map(s => s.replace(/^\d+[\.\)]\s+/, '').trim()))
    return steps
  }

  const sentences = prompt.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10)
  if (sentences.length > 1) {
    steps.push(...sentences.slice(0, 5))
  }

  return steps
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
    permissionMode: 'default',
    permissionChecker: createPermissionChecker('default', undefined, createDefaultClassifier()),
  }
}

async function consumeStream(
  provider: LLMProvider,
  options: ProviderRequestOptions,
  onProgress?: (event: AgentStreamEvent) => void,
): Promise<ProviderResponse> {
  const contentBlocks: ProviderContentBlock[] = []
  let currentTextBlock: { type: 'text'; text: string } | null = null
  let currentToolUseBlock: { type: 'tool_use'; id: string; name: string; input: string } | null = null
  let stopReason = 'end_turn'
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationInputTokens: number | undefined
  let cacheReadInputTokens: number | undefined

  for await (const chunk of provider.createStreamingMessage(options)) {
    switch (chunk.type) {
      case 'stream_chunk': {
        if (chunk.contentBlock) {
          if (chunk.contentBlock.type === 'tool_use') {
            currentToolUseBlock = {
              type: 'tool_use',
              id: chunk.contentBlock.id ?? '',
              name: chunk.contentBlock.name ?? '',
              input: '',
            }
            if (onProgress) {
              onProgress({
                type: 'tool_use_start',
                toolName: chunk.contentBlock.name ?? '',
                toolUseId: chunk.contentBlock.id ?? '',
              })
            }
          }
        }

        if (chunk.delta) {
          if (chunk.delta.type === 'text_delta') {
            if (!currentTextBlock) {
              currentTextBlock = { type: 'text', text: '' }
            }
            currentTextBlock.text += chunk.delta.text ?? ''
            if (onProgress) {
              onProgress({ type: 'stream_delta', text: chunk.delta.text ?? '' })
            }
          } else if (chunk.delta.type === 'thinking_delta') {
            if (onProgress) {
              onProgress({ type: 'thinking_delta', text: chunk.delta.thinking ?? '' })
            }
          } else if (chunk.delta.type === 'input_json_delta') {
            if (currentToolUseBlock) {
              currentToolUseBlock.input += chunk.delta.partialJson ?? ''
            }
          } else if (chunk.delta.type === 'message_delta') {
            if (chunk.delta.stopReason) {
              stopReason = chunk.delta.stopReason
            }
          }
        }

        if (chunk.usage) {
          if (chunk.usage.inputTokens != null) inputTokens = chunk.usage.inputTokens
          if (chunk.usage.outputTokens != null) outputTokens = chunk.usage.outputTokens
        }
        break
      }

      case 'message_start':
        if (chunk.usage) {
          inputTokens = chunk.usage.inputTokens ?? 0
        }
        break

      case 'content_block_start':
        if (chunk.contentBlock) {
          if (chunk.contentBlock.type === 'text') {
            currentTextBlock = { type: 'text', text: chunk.contentBlock.text ?? '' }
          } else if (chunk.contentBlock.type === 'tool_use') {
            currentToolUseBlock = {
              type: 'tool_use',
              id: chunk.contentBlock.id ?? '',
              name: chunk.contentBlock.name ?? '',
              input: '',
            }
            if (onProgress) {
              onProgress({
                type: 'tool_use_start',
                toolName: chunk.contentBlock.name ?? '',
                toolUseId: chunk.contentBlock.id ?? '',
              })
            }
          }
        }
        break

      case 'content_block_delta':
        if (chunk.delta) {
          if (chunk.delta.type === 'text_delta' && chunk.delta.text) {
            if (currentTextBlock) {
              currentTextBlock.text += chunk.delta.text
            }
            if (onProgress) {
              onProgress({ type: 'stream_delta', text: chunk.delta.text })
            }
          } else if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking) {
            if (onProgress) {
              onProgress({ type: 'thinking_delta', text: chunk.delta.thinking })
            }
          } else if (chunk.delta.type === 'input_json_delta' && chunk.delta.partialJson) {
            if (currentToolUseBlock) {
              currentToolUseBlock.input += chunk.delta.partialJson
            }
          }
        }
        break

      case 'content_block_stop':
        if (currentTextBlock) {
          contentBlocks.push(currentTextBlock)
          currentTextBlock = null
        }
        if (currentToolUseBlock) {
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = JSON.parse(currentToolUseBlock.input) as Record<string, unknown>
          } catch {
            parsedInput = {}
          }
          contentBlocks.push({
            type: 'tool_use',
            id: currentToolUseBlock.id,
            name: currentToolUseBlock.name,
            input: parsedInput,
          })
          currentToolUseBlock = null
        }
        break

      case 'message_delta':
        if (chunk.delta?.stopReason) {
          stopReason = chunk.delta.stopReason
        }
        if (chunk.usage) {
          outputTokens = chunk.usage.outputTokens ?? outputTokens
        }
        break

      case 'message_stop':
        break
    }
  }

  if (currentTextBlock) {
    contentBlocks.push(currentTextBlock)
    currentTextBlock = null
  }
  if (currentToolUseBlock) {
    let parsedInput: Record<string, unknown> = {}
    try {
      parsedInput = JSON.parse(currentToolUseBlock.input) as Record<string, unknown>
    } catch {
      parsedInput = {}
    }
    contentBlocks.push({
      type: 'tool_use',
      id: currentToolUseBlock.id,
      name: currentToolUseBlock.name,
      input: parsedInput,
    })
    currentToolUseBlock = null
  }

  return {
    id: `stream-${Date.now()}`,
    model: options.model,
    content: contentBlocks,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
  }
}

function applyPermissionUpdate(
  update: {
    type: 'always_allow' | 'always_deny' | 'allow_pattern'
    toolName: string
    pattern?: string
    reason?: string
  },
  context: ToolUseContext,
): void {
  const checker = context.permissionChecker
  if (!checker) {
    logger.warn('Cannot apply permission update: no permission checker in context')
    return
  }

  switch (update.type) {
    case 'always_allow':
      checker.addRule({
        tool: update.toolName,
        behavior: 'allow',
        reason: update.reason ?? 'User approved: always allow',
      })
      logger.info(`Permission update: always allow ${update.toolName}`)
      break

    case 'always_deny':
      checker.addRule({
        tool: update.toolName,
        behavior: 'deny',
        reason: update.reason ?? 'User denied: always deny',
      })
      logger.info(`Permission update: always deny ${update.toolName}`)
      break

    case 'allow_pattern':
      checker.addRule({
        tool: update.toolName,
        pattern: update.pattern,
        behavior: 'allow',
        reason: update.reason ?? 'User approved pattern',
      })
      logger.info(`Permission update: allow ${update.toolName} pattern=${update.pattern ?? '*'}`)
      break
  }
}

function isRetryableError(errorMsg: string, retryablePatterns: string[]): boolean {
  const upperError = errorMsg.toUpperCase()
  return retryablePatterns.some(pattern => upperError.includes(pattern.toUpperCase()))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callAdvisorForFailure(
  toolName: string,
  errors: Array<{ error: string; timestamp: number }>,
  allMessages: Message[],
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal,
): Promise<AdvisorSuggestion | null> {
  const contextMessages = allMessages.slice(-6)
  const contextText = contextMessages
    .map(m => `${m.role}: ${m.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join(' ')}`)
    .join('\n')

  const errorHistory = errors.map((e, i) => `Attempt ${i + 1}: ${e.error}`).join('\n')

  const advisorPrompt = `You are acting as an advisor reviewing a tool failure.

**Failed Tool:** ${toolName}
**Error History:**
${errorHistory}

**Recent Conversation Context:**
${contextText}

Provide specific, actionable advice on what alternative approach the agent should try next.

Output format:
- **Observation**: What I see happening
- **Concern**: Why this approach is failing
- **Suggestion**: Concrete alternative approach to try
- **Verdict**: PROCEED (if current approach can work with adjustment) / RETHINK (if need different approach) / PIVOT (if should stop and reconsider)`

  try {
    const response = await provider.createMessage({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: advisorPrompt }] }],
      maxTokens: 500,
      signal,
    })

    const responseText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')

    const observationMatch = responseText.match(/\*\*Observation\*\*:\s*([\s\S]*?)(?=\*\*Concern\*\*:)/i)
    const concernMatch = responseText.match(/\*\*Concern\*\*:\s*([\s\S]*?)(?=\*\*Suggestion\*\*:)/i)
    const suggestionMatch = responseText.match(/\*\*Suggestion\*\*:\s*([\s\S]*?)(?=\*\*Verdict\*\*:)/i)
    const verdictMatch = responseText.match(/\*\*Verdict\*\*:\s*(PROCEED|RETHINK|PIVOT)/i)

    if (observationMatch && concernMatch && suggestionMatch && verdictMatch) {
      return {
        observation: observationMatch[1].trim(),
        concern: concernMatch[1].trim(),
        suggestion: suggestionMatch[1].trim(),
        verdict: verdictMatch[1].trim() as 'PROCEED' | 'RETHINK' | 'PIVOT',
      }
    }

    if (responseText.toUpperCase().includes('PIVOT')) {
      return {
        observation: `Tool ${toolName} has failed multiple times`,
        concern: 'The current approach is not working',
        suggestion: 'Consider stopping the current approach and trying a fundamentally different method',
        verdict: 'PIVOT',
      }
    }
  } catch (error) {
    logger.warn(`Advisor call failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return null
}

function formatAdvisorMessage(suggestion: AdvisorSuggestion): string {
  return `
=== ADVISOR REVIEW ===

**Observation:**
${suggestion.observation}

**Concern:**
${suggestion.concern}

**Suggestion:**
${suggestion.suggestion}

**Verdict:** ${suggestion.verdict}
`
}
