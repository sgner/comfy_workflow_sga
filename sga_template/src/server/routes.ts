import type { Request, Response } from 'express'
import type { Session, CreateSessionRequest, SendMessageRequest, SendMessageResponse, StreamEventPayload, UserInputRequest } from './session.js'
import { createSession, addMessageToSession, updateSessionUsage, setSessionWaitingInput, clearSessionWaitingInput, formatSSE } from './session.js'
import type { Message, AgentStreamEvent, UsageMetrics } from '../core/types.js'
import type { PendingAction, UserApprovalResponse, UserInputResponse, SuspendedContext } from './interaction.js'
import { createApprovalRequest, createHumanInputRequest, pendingResolvers } from './interaction.js'
import { createLogger } from '../utils/logger.js'
import { getSessionStore } from './session-store.js'
import { getMemoryManager } from '../memory/manager.js'
import { MemoryExtractor, DEFAULT_EXTRACTOR_CONFIG } from '../memory/extractor.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../memory/paths.js'
import { undoLastAction } from '../tools/built-in/workflow-action.js'
import { getWorkingSet, initWorkingSet } from '../memory/working-set-registry.js'
import { resolve } from 'path'

const logger = createLogger('routes')
import { createBuiltinTools } from '../tools/built-in/index.js'
import { assembleToolPool } from '../tools/registry.js'
import { getConnectedMCPClients, getAllMCPTools } from '../mcp/index.js'
import { createAllMCPToolAdapters } from '../mcp/adapter.js'
import { getBuiltinAgentDefinitions, getAgentDefinitionByName, runAgent, getAllAgentDefinitions, createAgentFromConfig, agentDefinitionToJSON, isCustomAgent, getCoordinatorAgentDefinition, isCoordinatorMode, setCoordinatorMode, getCoordinatorSystemPrompt, listSnapshots, getPlanManager } from '../agents/index.js'
import { buildCodexDeveloperInstructions } from '../agents/codex/context.js'
import { getTaskManager } from '../tasks/index.js'
import { killRunningTask, getAllRunningTasks, waitForTask, cleanupCompletedTasks, setTaskNotificationCallback, formatTaskNotificationXml } from '../tools/built-in/agent.js'
import { getOrCreateCostManager, getCostManager, removeCostManager, ComfyUIContextInjector } from '../comfyui/adapter.js'
import { getAgentExtensions } from '../comfyui/agent-extensions.js'
import { CostTracker } from '../utils/cost-tracker.js'
import { resolveProvider, getAllProviders, getDefaultProviderName, getDefaultProvider, addProvider, removeProvider, setDefaultProvider, getProviderConfig, getAllProviderNames, getProvider, normalizeProviderConfig, validateProviderConfig } from '../providers/provider-store.js'
import { getRegisteredProviders, getProviderDefaults } from '../providers/registry.js'
import type { LLMProvider, StoredProviderConfig, ModelConfig } from '../providers/index.js'
import type { PermissionResult } from '../tools/base.js'
import {
  loadPermissionRules,
  savePermissionRules,
  addRuleToConfig,
  removeRuleFromConfig,
  listRulesFromConfig,
  ruleFileToRuleSet,
  createPermissionCheckerFromConfig,
  createDefaultClassifier,
} from '../permissions/index.js'
import type { PermissionRuleFile } from '../permissions/index.js'
import {
  loadHookConfig,
  addHookToConfig,
  removeHookFromConfig,
  listHooksFromConfig,
} from '../hooks/config.js'
import { HookRegistry, HookExecutor } from '../hooks/executor.js'
import type { HookEventType, HookExecutionContext } from '../hooks/types.js'
import { FeatureGateManager, isFeatureEnabled } from '../feature-gate/index.js'
import type { FeatureGateConfig } from '../feature-gate/index.js'
import { TelemetryManager, initTelemetry } from '../telemetry/index.js'
import { classifyBashCommand, classifyError } from '../permissions/index.js'
import { buildFullSystemPrompt, type SystemPromptBuildOptions } from '../context/system-prompt.js'

const activeSSEConnections: Map<string, Response> = new Map()
const activeAbortControllers: Map<string, AbortController> = new Map()
const costTrackers: Map<string, CostTracker> = new Map()

function initSSEResponse(res: Response): void {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    // 关键: flushHeaders 让浏览器立即知道这是一个流式响应, 不会等待第一个 write
    res.flushHeaders?.()
  }
}

/** 立即把缓冲区的数据刷到 TCP socket, 保证每个 SSE event 真正实时到达浏览器 */
function flushSSE(res: Response): void {
  // Node.js 13.10+ 提供 res.flush() (http.ServerResponse.flush)
  // Express 的 response 继承自 http.ServerResponse, 直接调用即可
  const r = res as Response & { flush?: () => void; flushHeaders?: () => void }
  try {
    r.flush?.()
  } catch {
    // 老 Node 版本或不支持 flush 时, 静默降级
  }
}

function sendComfyUIEvent(res: Response, event: AgentStreamEvent): void {
  try {
    if (res.writableEnded) return
    if (!res.headersSent) {
      initSSEResponse(res)
    }
    res.write(formatSSE(event))
    flushSSE(res)
  } catch {
    // connection closed
  }
}

function closeSSEConnection(sessionId: string): void {
  const existing = activeSSEConnections.get(sessionId)
  if (existing) {
    try {
      existing.end()
    } catch {
      // already closed
    }
    activeSSEConnections.delete(sessionId)
  }

  const abortCtrl = activeAbortControllers.get(sessionId)
  if (abortCtrl) {
    try {
      abortCtrl.abort()
    } catch {
      // already aborted
    }
    activeAbortControllers.delete(sessionId)
  }
}

function getSessionId(req: Request): string {
  return req.params.sessionId as string
}

function getProviderForSession(session: Session, messageProviderName?: string): LLMProvider {
  return resolveProvider(messageProviderName ?? session.config.providerName)
}

function buildToolPool(): import('../tools/base.js').Tool[] {
  const builtinTools = createBuiltinTools()
  const mcpClients = getConnectedMCPClients()
  const mcpToolAdapters = createAllMCPToolAdapters(mcpClients)
  return assembleToolPool(builtinTools, mcpToolAdapters)
}

async function buildToolPoolWithAgents(): Promise<import('../tools/base.js').Tool[]> {
  const agentDefs = await getAllAgentDefinitions()
  const builtinTools = createBuiltinTools(agentDefs)
  const mcpClients = getConnectedMCPClients()
  const mcpToolAdapters = createAllMCPToolAdapters(mcpClients)
  return assembleToolPool(builtinTools, mcpToolAdapters)
}

const COMPLEXITY_KEYWORDS = [
  'implement', 'refactor', 'migrate', 'redesign', 'architect', 'rewrite',
  'integrate', 'build', 'create a', 'develop', 'design and implement',
  'end-to-end', 'full-stack', 'multi-step', 'comprehensive',
  '实现', '重构', '迁移', '重新设计', '架构', '重写',
  '集成', '构建', '开发', '设计并实现', '端到端', '全栈',
  '多步骤', '综合', '完整实现', '从零开始',
]

const SIMPLE_KEYWORDS = [
  'what is', 'explain', 'show me', 'list', 'how does', 'where is',
  'read', 'cat', 'echo', 'print', 'tell me',
  '什么是', '解释', '列出', '怎么', '在哪', '读取', '显示',
]

function shouldUseCoordinator(query: string, agentType?: string): boolean {
  if (!isFeatureEnabled('auto_coordinator')) return false

  if (agentType && agentType !== 'general-purpose') return false

  const lowerQuery = query.toLowerCase()

  const simpleScore = SIMPLE_KEYWORDS.reduce((acc, kw) => acc + (lowerQuery.includes(kw) ? 1 : 0), 0)
  if (simpleScore >= 2 && !lowerQuery.includes('and')) return false

  if (lowerQuery.length < 30) return false

  const complexScore = COMPLEXITY_KEYWORDS.reduce((acc, kw) => acc + (lowerQuery.includes(kw) ? 1 : 0), 0)
  if (complexScore >= 2) return true

  const sentenceCount = query.split(/[.!?。！？]+/).filter(s => s.trim().length > 5).length
  if (sentenceCount >= 3) return true

  const hasMultipleActions = (lowerQuery.match(/\band\b|&|，|；|然后|接着|之后/g) || []).length >= 2
  if (hasMultipleActions) return true

  return false
}

export function handleListSessions(_req: Request, res: Response): void {
  const store = getSessionStore()
  const list = Array.from(store.values()).map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: s.status,
    messageCount: s.messages.length,
    model: s.config.model,
    providerName: s.config.providerName,
    pendingActionId: s.pendingAction
      ? (s.pendingAction.type === 'approval' ? s.pendingAction.request.id : s.pendingAction.request.id)
      : undefined,
  }))
  res.json({ sessions: list })
}

export async function handleCreateSession(req: Request, res: Response): Promise<void> {
  const body: CreateSessionRequest = req.body

  if (body.providerName) {
    const available = getAllProviderNames()
    if (!available.includes(body.providerName)) {
      if (body.providerName.startsWith('comfyui-')) {
        const configId = body.providerName.slice('comfyui-'.length)
        const config = getComfyUIConfigStore().getConfigById(configId)
        if (config) {
          await ensureSgaProvider(config)
        } else {
          res.status(400).json({
            error: `ComfyUI config "${configId}" not found. Available configs: ${getComfyUIConfigStore().getConfigs().map(c => c.id).join(', ') || 'none'}`,
          })
          return
        }
      } else {
        res.status(400).json({
          error: `Provider "${body.providerName}" is not configured. Available providers: ${available.join(', ') || 'none'}`,
        })
        return
      }
    }
  }

  const store = getSessionStore()
  const session = createSession({
    model: body.model,
    permissionMode: body.permissionMode,
    maxTurns: body.maxTurns,
    maxBudgetUsd: body.maxBudgetUsd,
    systemPrompt: body.systemPrompt,
    agentType: body.agentType,
    mcpServers: body.mcpServers,
    providerName: body.providerName,
  })
  store.set(session)
  getOrCreateCostManager(session.id, body.maxBudgetUsd)
  res.status(201).json({ session })
}

export function handleGetSession(req: Request, res: Response): void {
  const sessionId = getSessionId(req)
  const store = getSessionStore()
  const session = store.get(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const result: Record<string, unknown> = {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    config: session.config,
    status: session.status,
    usage: session.usage,
    messageCount: session.messages.length,
  }

  if (session.status === 'waiting_input' && session.pendingAction) {
    result.pendingAction = {
      type: session.pendingAction.type,
      request: session.pendingAction.request,
    }
  }

  res.json({ session: result })
}

export function handleDeleteSession(req: Request, res: Response): void {
  const sessionId = getSessionId(req)
  const store = getSessionStore()
  if (!store.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  store.delete(sessionId)
  removeCostManager(sessionId)
  pendingResolvers.delete(sessionId)
  activeSSEConnections.delete(sessionId)
  res.json({ success: true })
}

export async function handleSendMessage(req: Request, res: Response): Promise<void> {
  const sessionId = getSessionId(req)
  const body: SendMessageRequest = req.body
  const store = getSessionStore()
  const session = store.get(sessionId)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (session.status === 'waiting_input') {
    res.status(409).json({
      error: 'Session is waiting for user input',
      pendingAction: session.pendingAction
        ? { type: session.pendingAction.type, request: session.pendingAction.request }
        : undefined,
    })
    return
  }

  if (session.status !== 'active') {
    res.status(400).json({ error: `Session is ${session.status}, cannot send messages` })
    return
  }

  const useStream = body.stream === true || body.stream === 'true'

  logger.info(`Session ${sessionId}: received message, content length=${body.content.length}, stream=${useStream}`)

  if (session.config.agentType === 'comfyui-workflow' || body.agentType === 'comfyui-workflow') {
    let ws = getWorkingSet()
    if (!ws) {
      ws = initWorkingSet()
    }
    const workflowMatch = body.content.match(/\[FULL WORKFLOW JSON\]\s*([\s\S]*?)(?:\n\[|$)/)
    if (workflowMatch) {
      try {
        const workflowObj = JSON.parse(workflowMatch[1].trim())
        const nodes = (workflowObj?.nodes ?? []) as Array<Record<string, unknown>>
        ws.pin(
          `workflow-${sessionId}`,
          `ComfyUI Workflow (${nodes.length} nodes)`,
          JSON.stringify(workflowObj),
          'comfyui-workflow',
          'critical',
          20_000,
        )

        const nodeTypes = nodes.map(n => n.type as string).filter(Boolean)
        const uniqueTypes = [...new Set(nodeTypes)]
        const typeCounts = new Map<string, number>()
        for (const t of nodeTypes) {
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
        }
        const summaryLines = [
          `Total nodes: ${nodes.length}`,
          `Unique node types: ${uniqueTypes.length}`,
          `Node types: ${uniqueTypes.map(t => `${t}(${typeCounts.get(t)})`).join(', ')}`,
        ]
        ws.pin(
          `workflow-summary-${sessionId}`,
          `Workflow Summary`,
          summaryLines.join('\n'),
          'comfyui-workflow',
          'high',
          1_000,
        )
      } catch {
        // not valid JSON, skip
      }
    }

    const errorMatch = body.content.match(/\[RUNTIME ERRORS\]\s*([\s\S]*?)(?:\n\[|$)/)
    if (errorMatch && errorMatch[1].trim()) {
      ws.pin(
        `error-log-${sessionId}`,
        `Runtime Errors`,
        errorMatch[1].trim(),
        'comfyui-workflow',
        'high',
        3_000,
      )
    }
  }

  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: body.content }],
    timestamp: Date.now(),
  }
  store.appendMessage(session.id, userMessage)

  if (useStream) {
    handleStreamResponse(req, res, session, body)
    return
  }

  try {
    const provider = getProviderForSession(session, body.providerName)
    const model = body.model ?? session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    logger.info(`Session ${sessionId}: using provider=${provider.name}, model=${model}`)

    // ===== Codex backend 派发 (非流式) =====
    const activeAgentNonStream = ((session as any).activeAgent ?? 'sga') as AgentType
    if (activeAgentNonStream === 'codex') {
      const registry = getBackendRegistry()
      const codexBackend = registry.get('codex')
      let codexContent = ''
      let codexUsage: UsageMetrics = {
        inputTokens: 0, outputTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        totalTokens: 0, totalCostUsd: 0,
      }
      // 提取 language hint 并用 buildCodexDeveloperInstructions 构建完整 Comfy Agent 上下文
      const langMatchNonStream = body.content.match(
        /IMPORTANT: You MUST respond in the following language code: "([^"]*)"\./,
      )
      const languageNonStream = langMatchNonStream?.[1]
      const developerInstructionsNonStream = buildCodexDeveloperInstructions({
        sessionId: session.id,
        language: languageNonStream,
      })
      for await (const ev of codexBackend.sendMessage({
        prompt: body.content,
        messages: session.messages,
        model,
        provider,
        ...(developerInstructionsNonStream ? { developerInstructions: developerInstructionsNonStream } : {}),
      } as any)) {
        if (ev.type === 'stream_delta' && (ev as any).text) {
          codexContent += (ev as any).text
        }
        if (ev.type === 'turn_end' && (ev as any).usage) {
          const u = (ev as any).usage
          codexUsage = {
            inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
            outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: u.totalTokens ?? u.total_tokens ?? 0,
            totalCostUsd: 0,
          }
        }
        if (ev.type === 'stop' || ev.type === 'error' || ev.type === 'turn_end') {
          break
        }
      }

      if (codexContent) {
        const assistantMessage: Message = {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: codexContent }],
          timestamp: Date.now(),
        }
        store.appendMessage(session.id, assistantMessage)
        store.appendUsage(session.id, codexUsage)
      }

      const response: SendMessageResponse = {
        sessionId: session.id,
        content: codexContent,
        usage: codexUsage,
        messages: session.messages,
      }
      res.json(response)
      return
    }

    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

    if (!agentDef) {
      res.status(500).json({ error: 'No agent definition available' })
      return
    }

    if (shouldUseCoordinator(body.content, body.agentType)) {
      logger.info(`Session ${sessionId}: complex task detected, routing to Coordinator agent`)

      try {
        const allAgentDefs = await getAllAgentDefinitions()
        const toolPool = await buildToolPoolWithAgents()
        const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

        setCoordinatorMode(true)

        const pendingNotifications: Array<{ taskId: string; status: string; summary: string; result?: string }> = []

        setTaskNotificationCallback((notification) => {
          pendingNotifications.push(notification)
        })

        const result = await runAgent({
          agentDefinition: coordinatorDef,
          prompt: body.content,
          messages: session.messages,
          tools: toolPool,
          model,
          provider,
          maxTurns: session.config.maxTurns ?? 50,
          maxBudgetUsd: session.config.maxBudgetUsd,
          agentDefinitions: allAgentDefs,
        })

        setCoordinatorMode(false)
        setTaskNotificationCallback(null)

        const assistantMessage: Message = {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: result.content }],
          timestamp: Date.now(),
        }
        store.appendMessage(session.id, assistantMessage)
        store.appendUsage(session.id, result.usage)

        triggerMemoryExtraction(session.messages, provider, model, session.id, session.config.agentType)

        const response: SendMessageResponse = {
          sessionId: session.id,
          content: result.content,
          usage: result.usage,
          messages: session.messages,
        }

        res.json(response)
        return
      } catch (coordError) {
        setCoordinatorMode(false)
        setTaskNotificationCallback(null)
        logger.warn(`Coordinator agent failed, falling back to direct agent: ${coordError instanceof Error ? coordError.message : String(coordError)}`)
      }
    }

    const requestApproval = async (event: import('../agents/runner.js').ApprovalEvent): Promise<import('../agents/runner.js').ApprovalResponse> => {
      const approvalReq = createApprovalRequest({
        toolName: event.toolName,
        toolInput: event.toolInput,
        message: event.message,
        sessionId: session.id,
        suggestions: event.suggestions,
        isDestructive: true,
        isReadOnly: false,
      })

      const approvalPromise = new Promise<UserApprovalResponse>((resolve, reject) => {
        pendingResolvers.set(approvalReq.id, {
          resolve: (resp: unknown) => resolve(resp as UserApprovalResponse),
          reject,
        })
      })

      const suspendedCtx: SuspendedContext = {
        actionId: approvalReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model,
        systemPromptContent: '',
        agentType: body.agentType,
        providerName: session.config.providerName,
      }

      setSessionWaitingInput(session, {
        type: 'approval',
        request: approvalReq,
        resolve: (resp: unknown) => {
          pendingResolvers.get(approvalReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          pendingResolvers.get(approvalReq.id)?.reject(error)
        },
      } as PendingAction, suspendedCtx)

      try {
        const userResponse = await approvalPromise
        clearSessionWaitingInput(session)
        return {
          decision: userResponse.decision,
          updatedInput: userResponse.updatedInput,
          reason: userResponse.reason,
          permissionUpdate: userResponse.permissionUpdate,
        }
      } catch (error) {
        clearSessionWaitingInput(session)
        return { decision: 'deny', reason: 'Approval request cancelled' }
      } finally {
        pendingResolvers.delete(approvalReq.id)
      }
    }

    const requestHumanInput = async (event: import('../agents/runner.js').HumanInputEvent): Promise<string> => {
      const inputReq = createHumanInputRequest({
        message: event.message,
        sessionId: session.id,
        context: event.context,
        options: event.options,
        allowFreeText: true,
      })

      const inputPromise = new Promise<UserInputResponse>((resolve, reject) => {
        pendingResolvers.set(inputReq.id, {
          resolve: (resp: unknown) => resolve(resp as UserInputResponse),
          reject,
        })
      })

      const suspendedCtx: SuspendedContext = {
        actionId: inputReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model,
        systemPromptContent: '',
        agentType: body.agentType,
        providerName: session.config.providerName,
      }

      setSessionWaitingInput(session, {
        type: 'human_input',
        request: inputReq,
        resolve: (resp: unknown) => {
          pendingResolvers.get(inputReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          pendingResolvers.get(inputReq.id)?.reject(error)
        },
      } as PendingAction, suspendedCtx)

      try {
        const userResponse = await inputPromise
        clearSessionWaitingInput(session)
        return userResponse.value
      } catch (error) {
        clearSessionWaitingInput(session)
        return '[Input request cancelled]'
      } finally {
        pendingResolvers.delete(inputReq.id)
      }
    }

    const result = await runAgent({
      agentDefinition: agentDef,
      prompt: body.content,
      messages: session.messages,
      tools,
      model,
      provider,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      requestApproval,
      requestHumanInput,
    })

    logger.info(`Session ${sessionId}: agent completed, content length=${result.content.length}, turns=${result.turnCount}, tokens={in:${result.usage.inputTokens}, out:${result.usage.outputTokens}}`)

    const assistantMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: [{ type: 'text', text: result.content }],
      timestamp: Date.now(),
    }
    store.appendMessage(session.id, assistantMessage)
    store.appendUsage(session.id, result.usage)

    triggerMemoryExtraction(session.messages, provider, model, session.id, session.config.agentType)

    const response: SendMessageResponse = {
      sessionId: session.id,
      content: result.content,
      usage: result.usage,
      messages: session.messages,
    }

    res.json(response)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    store.updateStatus(session.id, 'error', errMsg)
    logger.error(`Session ${sessionId}: error during message processing: ${errMsg}`)
    res.status(500).json({ error: errMsg })
  }
}

async function handleStreamResponse(
  _req: Request,
  res: Response,
  session: Session,
  body: SendMessageRequest,
): Promise<void> {
  const abortController = activeAbortControllers.get(session.id) ?? new AbortController()
  activeAbortControllers.set(session.id, abortController)

  initSSEResponse(res)

  activeSSEConnections.set(session.id, res)

  const sendEvent = (event: AgentStreamEvent) => {
    try {
      if (res.writableEnded || abortController.signal.aborted) return
      if (!res.headersSent) {
        initSSEResponse(res)
      }
      res.write(formatSSE(event))
      flushSSE(res)
    } catch {
      // connection closed
    }
  }

  let partialText = ''

  try {
    const provider = getProviderForSession(session, body.providerName)
    const model = body.model ?? session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

    sendEvent({ type: 'session_start', sessionId: session.id, model, agentType: body.agentType })

    // ===== Codex backend 派发 =====
    // 如果 session.activeAgent === 'codex', 走 codex 子进程, 不走 SGA runAgent.
    // codex 自己有 agent / tool / sandbox 能力, SGA 这边的 coordinator / planMgr /
    // approval / autoDream 等副作用都不适用.
    const activeAgent = ((session as any).activeAgent ?? 'sga') as AgentType
    if (activeAgent === 'codex') {
      const registry = getBackendRegistry()
      const codexBackend = registry.get('codex')
      try {
        let codexContent = ''
        let codexUsage: UsageMetrics = {
          inputTokens: 0, outputTokens: 0,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          totalTokens: 0, totalCostUsd: 0,
        }
        // 关键修复: 用 buildCodexDeveloperInstructions 构建完整 Comfy Workflow Agent
        // developerInstructions: 1. Agent 身份+能力+规则  2. 当前工作流摘要
        // 3. 最近 SGA 会话上下文 (切换 Agent 时不丢记忆)  4. 语言偏好
        const langMatch = body.content.match(
          /IMPORTANT: You MUST respond in the following language code: "([^"]*)"\./,
        )
        const language = langMatch?.[1]
        const developerInstructions = buildCodexDeveloperInstructions({
          sessionId: session.id,
          language,
        })
        logger.info(
          `codex developerInstructions: sessionId=${session.id}, lang=${language ?? 'en'}, ` +
          `len=${developerInstructions.length}`,
        )
        for await (const ev of codexBackend.sendMessage({
          prompt: body.content,
          messages: session.messages,
          model,
          provider,
          signal: abortController.signal,
          developerInstructions,
        } as any)) {
          sendEvent(ev)
          if (ev.type === 'stream_delta' && (ev as any).text) {
            codexContent += (ev as any).text
          }
          if (ev.type === 'turn_end' && (ev as any).usage) {
            const u = (ev as any).usage
            codexUsage = {
              inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
              outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: u.totalTokens ?? u.total_tokens ?? 0,
              totalCostUsd: 0,
            }
          }
          if (ev.type === 'stop' || ev.type === 'error') {
            break
          }
        }

        // 落库: 把 codex 的回复存到 session
        if (codexContent) {
          const assistantMessage: Message = {
            id: `msg-${Date.now()}`,
            role: 'assistant',
            content: [{ type: 'text', text: codexContent }],
            timestamp: Date.now(),
          }
          getSessionStore().appendMessage(session.id, assistantMessage)
          getSessionStore().appendUsage(session.id, codexUsage)
        }

        sendEvent({ type: 'done', data: { content: codexContent, usage: codexUsage } })
      } catch (codexErr) {
        const msg = codexErr instanceof Error ? codexErr.message : String(codexErr)
        logger.error(`codex backend sendMessage failed: ${msg}`)
        sendEvent({ type: 'error', data: `codex backend error: ${msg}` })
        sendEvent({ type: 'done', data: null })
      }
      res.end()
      activeSSEConnections.delete(session.id)
      activeAbortControllers.delete(session.id)
      return
    }

    if (!agentDef) {
      sendEvent({ type: 'error', data: 'No agent definition available' })
      sendEvent({ type: 'done', data: null })
      res.end()
      activeSSEConnections.delete(session.id)
      return
    }

    const approvalPromiseMap: Map<string, {
      resolve: (response: unknown) => void
      reject: (error: Error) => void
    }> = new Map()

    const requestApproval = async (event: import('../agents/runner.js').ApprovalEvent): Promise<import('../agents/runner.js').ApprovalResponse> => {
      const approvalReq = createApprovalRequest({
        toolName: event.toolName,
        toolInput: event.toolInput,
        message: event.message,
        sessionId: session.id,
        suggestions: event.suggestions,
        isDestructive: true,
        isReadOnly: false,
      })

      sendEvent({
        type: 'approval_required',
        actionId: approvalReq.id,
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolCallId: event.toolCallId,
        message: event.message,
        suggestions: event.suggestions,
      })

      const approvalPromise = new Promise<UserApprovalResponse>((resolve, reject) => {
        const wrappedResolve = (resp: unknown) => resolve(resp as UserApprovalResponse)
        const wrappedReject = (err: Error) => reject(err)
        approvalPromiseMap.set(approvalReq.id, { resolve: wrappedResolve, reject: wrappedReject })
        pendingResolvers.set(approvalReq.id, { resolve: wrappedResolve, reject: wrappedReject })
      })

      const suspendedCtx: SuspendedContext = {
        actionId: approvalReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model,
        systemPromptContent: '',
        agentType: body.agentType,
        providerName: session.config.providerName,
      }

      setSessionWaitingInput(session, {
        type: 'approval',
        request: approvalReq,
        resolve: (resp: unknown) => {
          approvalPromiseMap.get(approvalReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          approvalPromiseMap.get(approvalReq.id)?.reject(error)
        },
      } as PendingAction, suspendedCtx)

      try {
        const userResponse = await approvalPromise
        clearSessionWaitingInput(session)
        return {
          decision: userResponse.decision,
          updatedInput: userResponse.updatedInput,
          reason: userResponse.reason,
          permissionUpdate: userResponse.permissionUpdate,
        }
      } catch (error) {
        clearSessionWaitingInput(session)
        return { decision: 'deny', reason: 'Approval request cancelled' }
      } finally {
        approvalPromiseMap.delete(approvalReq.id)
        pendingResolvers.delete(approvalReq.id)
      }
    }

    const requestHumanInput = async (event: import('../agents/runner.js').HumanInputEvent): Promise<string> => {
      const inputReq = createHumanInputRequest({
        message: event.message,
        sessionId: session.id,
        context: event.context,
        options: event.options,
        allowFreeText: true,
      })

      sendEvent({
        type: 'human_input_required',
        actionId: inputReq.id,
        message: event.message,
        context: event.context,
        options: event.options,
      })

      const inputPromise = new Promise<UserInputResponse>((resolve, reject) => {
        pendingResolvers.set(inputReq.id, {
          resolve: (resp: unknown) => resolve(resp as UserInputResponse),
          reject: (err: Error) => reject(err),
        })
      })

      const suspendedCtx: SuspendedContext = {
        actionId: inputReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model,
        systemPromptContent: '',
        agentType: body.agentType,
        providerName: session.config.providerName,
      }

      setSessionWaitingInput(session, {
        type: 'human_input',
        request: inputReq,
        resolve: (resp: unknown) => {
          pendingResolvers.get(inputReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          pendingResolvers.get(inputReq.id)?.reject(error)
        },
      } as PendingAction, suspendedCtx)

      try {
        const userResponse = await inputPromise
        clearSessionWaitingInput(session)
        return userResponse.value
      } catch (error) {
        clearSessionWaitingInput(session)
        return '[Input request cancelled]'
      } finally {
        pendingResolvers.delete(inputReq.id)
      }
    }

    if (shouldUseCoordinator(body.content, body.agentType)) {
      logger.info(`Session ${session.id} (stream): complex task detected, routing to Coordinator agent`)

      sendEvent({ type: 'coordinator_start', data: { query: body.content } })

      try {
        const allAgentDefs = await getAllAgentDefinitions()
        const toolPool = await buildToolPoolWithAgents()
        const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

        setCoordinatorMode(true)

        setTaskNotificationCallback((notification) => {
          sendEvent({
            type: 'task_notification',
            taskId: notification.taskId,
            status: notification.status === 'killed' ? 'stopped' : notification.status,
            summary: notification.summary,
          })
        })

        const planMgr = getPlanManager()
        planMgr.setNotificationCallback((event) => {
          sendEvent({
            type: 'plan_update',
            data: event,
          } as unknown as AgentStreamEvent)
        })

        const result = await runAgent({
          agentDefinition: coordinatorDef,
          prompt: body.content,
          messages: session.messages,
          tools: toolPool,
          model,
          provider,
          maxTurns: session.config.maxTurns ?? 50,
          maxBudgetUsd: session.config.maxBudgetUsd,
          agentDefinitions: allAgentDefs,
          signal: abortController.signal,
          requestApproval,
          requestHumanInput,
        })

        setCoordinatorMode(false)
        setTaskNotificationCallback(null)
        planMgr.setNotificationCallback(null)

        const assistantMessage: Message = {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: result.content }],
          timestamp: Date.now(),
        }
        getSessionStore().appendMessage(session.id, assistantMessage)
        getSessionStore().appendUsage(session.id, result.usage)

        triggerMemoryExtraction(session.messages, provider, model, session.id, session.config.agentType)

        sendEvent({ type: 'coordinator_end', data: { planId: 'coordinator-agent', totalTasks: 0, completedTasks: 0 } })
        sendEvent({ type: 'done', data: { content: result.content, usage: result.usage } })
      } catch (coordError) {
        setCoordinatorMode(false)
        setTaskNotificationCallback(null)
        logger.warn(`Coordinator agent failed (stream), falling back to direct agent: ${coordError instanceof Error ? coordError.message : String(coordError)}`)
        sendEvent({ type: 'coordinator_fallback', data: { reason: coordError instanceof Error ? coordError.message : String(coordError) } })
      }

      res.end()
      activeSSEConnections.delete(session.id)
      return
    }

    const result = await runAgent({
      agentDefinition: agentDef,
      prompt: body.content,
      messages: session.messages,
      tools,
      model,
      provider,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      stream: true,
      signal: abortController.signal,
      onProgress: (event: AgentStreamEvent) => {
        if (event.type === 'stream_delta' && event.text) {
          partialText += event.text
        }
        sendEvent(event)
      },
      requestApproval,
      requestHumanInput,
    })

    const assistantMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: [{ type: 'text', text: result.content }],
      timestamp: Date.now(),
    }
    getSessionStore().appendMessage(session.id, assistantMessage)
    getSessionStore().appendUsage(session.id, result.usage)

    const costMgr = getCostManager(session.id)
    if (costMgr) {
      costMgr.recordUsage(result.usage)
    }

    try {
      const taskMgr = getTaskManager()
      const existingTask = taskMgr.get(session.id)
      if (existingTask) {
        taskMgr.completeWithUsage(
          session.id,
          result.content.slice(0, 200),
          {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.inputTokens + result.usage.outputTokens,
            totalCostUsd: costMgr?.getReport().totalCostUsd ?? 0,
          },
          Date.now() - existingTask.createdAt,
        )
      }
    } catch {
      // task completion tracking is optional
    }

    triggerMemoryExtraction(session.messages, provider, model, session.id, session.config.agentType)

    try {
      const { extractWorkflowJSON, validateWorkflowJSON } = await import('../comfyui/verification-strategies.js')
      const workflowJson = extractWorkflowJSON(result.content)
      if (workflowJson) {
        // 发送 workflow_updated 事件让前端立刻应用工作流
        sendEvent({ type: 'workflow_updated', workflowJson: JSON.stringify(workflowJson), actionType: 'agent_response' })
        const validationResult = validateWorkflowJSON(workflowJson)
        sendEvent({
          type: 'verification_result',
          data: {
            verdict: validationResult.verdict,
            strategy: validationResult.strategy,
            summary: validationResult.summary,
            checks: validationResult.checks,
          },
        } as AgentStreamEvent)
      }
    } catch (e) {
      logger.debug(`Workflow verification skipped: ${e instanceof Error ? e.message : String(e)}`)
    }

    sendEvent({ type: 'done', data: { content: result.content, usage: result.usage } })

    TelemetryManager.getInstance().trackEvent('comfyui_chat_complete', {
      sessionId: session.id,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      contentLength: result.content.length,
      hasWorkflowJson: /\{.*"nodes".*\}/s.test(result.content),
    })

    try {
      const extensions = getAgentExtensions(session.config.agentType ?? 'comfyui-workflow')
      if (extensions?.enableAutoDream) {
        const memoryManager = getMemoryManager()
        if (memoryManager) {
          const { executeAutoDream, DEFAULT_AUTO_DREAM_CONFIG } = await import('../memory/consolidation/auto-dream.js')
          const { buildComfyUIConsolidationPrompt } = await import('../comfyui/consolidation-prompt.js')
          const extConfig = extensions.autoDreamConfig ?? {}
          const autoDreamConfig = {
            ...DEFAULT_AUTO_DREAM_CONFIG,
            ...extConfig,
            customPromptBuilder: buildComfyUIConsolidationPrompt,
          }
          const sessionCount = getSessionStore().size()
          executeAutoDream(memoryManager, provider, sessionCount, autoDreamConfig).catch(e => {
            logger.debug(`AutoDream background error: ${e instanceof Error ? e.message : String(e)}`)
          })
        }
      }
    } catch (e) {
      logger.debug(`AutoDream trigger skipped: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const extensions = getAgentExtensions(session.config.agentType ?? 'comfyui-workflow')
      if (extensions?.enableTeamSync) {
        const memoryManager = getMemoryManager()
        if (memoryManager) {
          const { TeamMemorySync } = await import('../memory/team-memory-sync.js')
          const { COMFYUI_TEAM_MEMORY_SYNC_CONFIG } = await import('../comfyui/team-config.js')
          const syncConfig = {
            ...COMFYUI_TEAM_MEMORY_SYNC_CONFIG,
            ...extensions.teamSyncConfig,
          }
          const sync = new TeamMemorySync(
            session.config.agentType ?? 'comfyui-workflow',
            session.id,
            syncConfig,
          )
          if (sync.shouldSync()) {
            sync.syncWithTeam(memoryManager).catch(e => {
              logger.debug(`Team memory sync error: ${e instanceof Error ? e.message : String(e)}`)
            })
          }
        }
      }
    } catch (e) {
      logger.debug(`Team memory sync skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      logger.info(`Session ${session.id}: agent run was aborted`)
      if (partialText.trim()) {
        const partialMsg: Message = {
          id: `msg-partial-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: partialText + '\n\n[Response interrupted - workflow was switched]' }],
          timestamp: Date.now(),
        }
        getSessionStore().appendMessage(session.id, partialMsg)
      }
    } else {
      getSessionStore().updateStatus(session.id, 'error', error instanceof Error ? error.message : String(error))
      sendEvent({ type: 'error', data: session.error ?? 'Unknown error' })
      sendEvent({ type: 'done', data: null })
    }
  }

  if (!res.writableEnded) {
    res.end()
  }
  activeSSEConnections.delete(session.id)
  activeAbortControllers.delete(session.id)
}

export function handleUserInput(req: Request, res: Response): void {
  const sessionId = getSessionId(req)
  const body: UserInputRequest = req.body
  const store = getSessionStore()
  const session = store.get(sessionId)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (session.status !== 'waiting_input') {
    res.status(400).json({ error: 'Session is not waiting for input' })
    return
  }

  if (!session.pendingAction) {
    res.status(400).json({ error: 'No pending action found' })
    return
  }

  const actionId = body.actionId
  const pendingResolver = pendingResolvers.get(actionId)

  if (!pendingResolver) {
    res.status(400).json({ error: 'Invalid or expired action ID' })
    return
  }

  if (session.pendingAction.type === 'approval') {
    const response: UserApprovalResponse = {
      actionId,
      decision: body.decision ?? 'deny',
      updatedInput: body.updatedInput,
      reason: body.reason,
      permissionUpdate: body.permissionUpdate,
    }
    pendingResolver.resolve(response)
  } else {
    const response: UserInputResponse = {
      actionId,
      value: body.value ?? '',
      optionValue: body.optionValue,
    }
    pendingResolver.resolve(response)
  }

  pendingResolvers.delete(actionId)

  res.json({
    success: true,
    sessionId: session.id,
    message: 'Input received, agent execution will resume',
  })
}

export async function handleComfyUIFork(req: Request, res: Response): Promise<void> {
  const { session_id, directive, max_turns } = req.body as Record<string, unknown>

  const store = getSessionStore()
  const session = store.get(session_id as string)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  try {
    const { buildForkedMessagesFromParentContext } = await import('../agents/fork.js')
    const { runComfyUIAgent } = await import('../comfyui/adapter.js')

    const provider = getProviderForSession(session)
    const model = session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = buildToolPool()
    const agentDefs = await getAllAgentDefinitions()
    const agentDef = agentDefs.find(a => a.name === 'comfyui-workflow') ?? agentDefs[0]

    if (!agentDef) {
      res.status(500).json({ error: 'No agent definition available' })
      return
    }

    const forkedMessages = buildForkedMessagesFromParentContext(
      directive as string,
      session.messages,
    )

    const result = await runComfyUIAgent({
      agentDefinition: agentDef,
      prompt: directive as string,
      messages: forkedMessages,
      tools,
      model,
      provider,
      maxTurns: (max_turns as number) ?? 5,
    })

    res.json({
      success: true,
      content: result.content,
      usage: result.usage,
      turnCount: result.turnCount,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`Fork failed: ${msg}`)
    res.status(500).json({ error: msg })
  }
}

export async function handleComfyUICoordinator(req: Request, res: Response): Promise<void> {
  const { session_id, query, strategy } = req.body as Record<string, unknown>

  const store = getSessionStore()
  const session = store.get(session_id as string)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  try {
    const allAgentDefs = await getAllAgentDefinitions()
    const provider = getProviderForSession(session)
    const model = session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const toolPool = await buildToolPoolWithAgents()
    const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

    setCoordinatorMode(true)

    const result = await runAgent({
      agentDefinition: coordinatorDef,
      prompt: query as string,
      tools: toolPool,
      model,
      provider,
      maxTurns: 50,
      agentDefinitions: allAgentDefs,
    })

    setCoordinatorMode(false)

    res.json({
      success: true,
      content: result.content,
      usage: result.usage,
      turnCount: result.turnCount,
      totalDurationMs: result.totalDurationMs,
    })
  } catch (error) {
    setCoordinatorMode(false)
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`Coordinator failed: ${msg}`)
    res.status(500).json({ error: msg })
  }
}

export async function handleComfyUIAutoDream(req: Request, res: Response): Promise<void> {
  const { session_id } = req.body as Record<string, unknown>

  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(500).json({ error: 'Memory manager not initialized' })
    return
  }

  try {
    const { shouldConsolidate, executeAutoDream } = await import('../memory/consolidation/auto-dream.js')

    const store = getSessionStore()
    const session = session_id ? store.get(session_id as string) : null
    const provider = session ? getProviderForSession(session) : null

    if (!provider) {
      res.status(500).json({ error: 'No provider available' })
      return
    }

    const sessionCount = store.size()

    const { shouldRun, hoursSinceLast } = shouldConsolidate(
      memoryManager.getMemoryDir(),
      sessionCount,
    )

    if (!shouldRun) {
      res.json({
        success: true,
        consolidated: false,
        hoursSinceLast,
        sessionCount,
        message: `Not enough time or sessions since last consolidation (${hoursSinceLast.toFixed(1)}h, ${sessionCount} sessions)`,
      })
      return
    }

    const result = await executeAutoDream(memoryManager, provider, sessionCount)

    res.json({
      success: true,
      consolidated: result.consolidated,
      hoursSinceLast: result.hoursSinceLast,
      sessionsReviewed: result.sessionsReviewed,
      summary: result.summary,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`Auto-dream failed: ${msg}`)
    res.status(500).json({ error: msg })
  }
}

export function handleComfyUICost(req: Request, res: Response): void {
  const { session_id } = req.query as Record<string, unknown>
  const store = getSessionStore()
  const session = session_id ? store.get(session_id as string) : null
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  const costMgr = getCostManager(session.id)
  const report = costMgr?.getReport()
  res.json({
    session_id: session.id,
    usage: session.usage,
    costReport: report?.report ?? 'No cost tracker',
    totalCostUsd: report?.totalCostUsd ?? 0,
    isOverBudget: report?.isOverBudget ?? false,
    isNearBudget: report?.isNearBudget ?? false,
    remainingBudget: report?.remainingBudget,
  })
}

export function handleGetMessages(req: Request, res: Response): void {
  const sessionId = getSessionId(req)
  const store = getSessionStore()
  const session = store.get(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  res.json({ messages: session.messages })
}

export function handleGetUsage(req: Request, res: Response): void {
  const sessionId = getSessionId(req)
  const store = getSessionStore()
  const session = store.get(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  const costMgr = getCostManager(sessionId)
  res.json({
    usage: session.usage,
    costReport: costMgr?.getReport().report ?? 'No cost tracker',
  })
}

// ===== Sprint 1+2: AgentBackend (SGA / Codex) 相关路由 =====

import { getBackendRegistry, BackendNotAvailableError, getHandoffStore, getBlackboard } from '../agents/index.js'
import type { AgentType } from '../agents/backend.js'

/**
 * 列出所有可用的 agent backend
 * GET /api/v1/backends
 */
export async function handleListBackends(_req: Request, res: Response): Promise<void> {
  try {
    const registry = getBackendRegistry()
    const items = await registry.listAll()
    res.json({ backends: items })
  } catch (err) {
    logger.error(`handleListBackends failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ error: 'failed to list backends' })
  }
}

/**
 * 列出所有 backend 的 health (慢, 用于状态检查)
 * GET /api/v1/backends/health
 */
export async function handleBackendsHealth(_req: Request, res: Response): Promise<void> {
  try {
    const registry = getBackendRegistry()
    const items = await registry.listAll()
    res.json({ backends: items })
  } catch (err) {
    logger.error(`handleBackendsHealth failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ error: 'failed to check backend health' })
  }
}

/**
 * 查询 Codex 后台编译状态 (供 UI 轮询, 显示进度).
 * GET /api/v1/codex/build-status
 *
 * 数据源:  <SGA_HOME>/codex-build.json, 由 __init__.py 派生的 worker 进程写入.
 * 没在编译 / 文件不存在时返 { status: "idle" }.
 */
export function handleCodexBuildStatus(_req: Request, res: Response): void {
  try {
    const sgaHome = (() => {
      try { return getSgaHome() } catch { return null }
    })()
    if (!sgaHome) {
      res.json({ status: 'idle', note: 'SGA_HOME not set' })
      return
    }
    const statusFile = join(sgaHome, 'codex-build.json')
    if (!existsSync(statusFile)) {
      res.json({ status: 'idle', sgaHome })
      return
    }
    const raw = readFileSync(statusFile, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // 探活 PID: 如果 status 是 building/pending 但 PID 已死, 视为 failed
    if (parsed.status === 'building' || parsed.status === 'pending') {
      const pid = parsed.pid as number | undefined
      if (pid && !isProcessAlive(pid)) {
        parsed.status = 'failed'
        parsed.error = parsed.error || `worker process (pid=${pid}) exited unexpectedly`
        parsed.finished_at = parsed.finished_at || new Date().toISOString()
      }
    }
    res.json({ ...parsed, sgaHome })
  } catch (err) {
    logger.error(`handleCodexBuildStatus failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ status: 'error', error: String(err) })
  }
}

/** 探活 PID. 跨平台. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM 表示存在但无权限, 也算 alive; 其它情况视为已死
    const err = e as NodeJS.ErrnoException
    return err.code === 'EPERM'
  }
}

/**
 * 获取 session 当前使用的 backend
 * GET /api/v1/sessions/:id/agent
 */
export async function handleGetSessionAgent(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = getSessionId(req)
    const store = getSessionStore()
    const session = store.get(sessionId)
    if (!session) {
      // session 不存在时返回默认值, 不报 404
      res.json({ sessionId, activeAgent: 'sga', pendingHandoff: null, blackboard: null })
      return
    }
    const activeAgent = (session as any).activeAgent ?? 'sga'
    const handoffStore = getHandoffStore()
    const peek = await handoffStore.peek(sessionId)
    const bb = getBlackboard()
    const bbData = await bb.read()
    res.json({
      sessionId,
      activeAgent,
      pendingHandoff: peek ? { sourceAgent: peek.sourceAgent, exportedAt: peek.exportedAt } : null,
      blackboard: {
        currentAgent: bbData.currentAgent,
        lastSwitchAt: bbData.lastSwitchAt,
      },
    })
  } catch (err) {
    logger.error(`handleGetSessionAgent failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ error: 'failed to get session agent' })
  }
}

/**
 * 切换 session 使用的 backend (触发 handoff)
 * POST /api/v1/sessions/:id/agent
 * body: { target: 'sga' | 'codex' }
 */
export async function handleSwitchSessionAgent(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = getSessionId(req)
    const body = req.body as { target?: AgentType }
    const target = body?.target
    if (target !== 'sga' && target !== 'codex') {
      res.status(400).json({ error: 'target must be "sga" or "codex"' })
      return
    }

    const store = getSessionStore()
    let session = store.get(sessionId)
    if (!session) {
      // session 不存在时自动创建 (用户可能在发消息前就切换 agent)
      session = createSession({
        agentType: 'comfyui-workflow',
      })
      session.id = sessionId
      store.set(session)
      logger.info(`handleSwitchSessionAgent: auto-created session ${sessionId}`)
    }
    const currentAgent = ((session as any).activeAgent ?? 'sga') as AgentType
    if (currentAgent === target) {
      res.json({ sessionId, activeAgent: currentAgent, handoff: null, message: 'no change' })
      return
    }

    const registry = getBackendRegistry()
    registry.setActive(target)

    // 1. 源 agent 导出 handoff
    let handoff: any = null
    let handoffError: string | null = null
    try {
      const sourceBackend = registry.get(currentAgent)
      if (await sourceBackend.canExportHandoff()) {
        const bundle = await sourceBackend.exportHandoff(sessionId)
        handoff = bundle ? { sourceAgent: bundle.sourceAgent, exportedAt: bundle.exportedAt, keyFactCount: bundle.keyFacts.length, messageCount: bundle.recentMessages.length } : null
      } else {
        handoffError = `${currentAgent} backend cannot export handoff at this moment`
      }
    } catch (err) {
      handoffError = err instanceof Error ? err.message : String(err)
      logger.warn(`handoff export failed: ${handoffError}`)
    }

    // 2. 更新 session.activeAgent
    ;(session as any).activeAgent = target

    // 3. 目标 agent 启动 + import handoff
    //    关键: codex 需要拿到 session 的 provider/model 才能起反代 + 写 config.toml,
    //    否则会 fallback 到 codex 默认的 OpenAI 登录路径.
    let startError: string | null = null
    try {
      const targetBackend = registry.get(target)
      const provider = getProviderForSession(session)
      const model = session.config.model ?? provider.config.defaultModel ?? 'sonnet'
      await targetBackend.start({
        provider,
        model,
        cwd: process.cwd(),
      })
      // consume bundle (read + delete)
      const handoffStore = getHandoffStore()
      const bundle = await handoffStore.consume(sessionId)
      if (bundle) {
        await targetBackend.importHandoff(bundle)
      }
    } catch (err) {
      if (err instanceof BackendNotAvailableError) {
        startError = err.message
      } else {
        startError = err instanceof Error ? err.message : String(err)
      }
      logger.error(`target backend ${target} start/import failed: ${startError}`)
    }

    // 4. 更新 blackboard
    const bb = getBlackboard()
    await bb.recordSwitch(currentAgent, target)

    res.json({
      sessionId,
      previousAgent: currentAgent,
      activeAgent: target,
      handoff,
      handoffError,
      startError,
      success: !startError,
    })
  } catch (err) {
    logger.error(`handleSwitchSessionAgent failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ error: 'failed to switch agent' })
  }
}

/**
 * 清理 session 的 handoff bundle (手动)
 * DELETE /api/v1/sessions/:id/handoff
 */
export async function handleClearHandoff(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = getSessionId(req)
    const store = getHandoffStore()
    await store.clear(sessionId)
    res.json({ sessionId, cleared: true })
  } catch (err) {
    logger.error(`handleClearHandoff failed: ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ error: 'failed to clear handoff' })
  }
}

export async function handleListAgents(_req: Request, res: Response): Promise<void> {
  const allAgents = await getAllAgentDefinitions()
  const agents = allAgents.map(a => {
    const base = {
      name: a.name,
      description: a.description,
      subagentType: a.subagentType,
      isBuiltIn: a.isBuiltIn(),
      isBackground: a.isBackground(),
      isProactive: a.isProactive(),
    }
    if (isCustomAgent(a)) {
      return { ...base, source: a.source, isUserInvocable: a.isUserInvocable, contextMode: a.contextMode }
    }
    return base
  })
  res.json({ agents })
}

export async function handleCreateAgent(req: Request, res: Response): Promise<void> {
  const { name, description, prompt, tools, disallowedTools, model, background } = req.body

  if (!name || !description || !prompt) {
    res.status(400).json({ error: 'name, description, and prompt are required' })
    return
  }

  const agentDef = createAgentFromConfig({
    name,
    description,
    prompt,
    tools,
    disallowedTools,
    model,
    background,
    source: 'api',
  })

  res.status(201).json({ agent: agentDefinitionToJSON(agentDef) })
}

export async function handleCoordinate(req: Request, res: Response): Promise<void> {
  const { query, model, providerName } = req.body

  if (!query) {
    res.status(400).json({ error: 'query is required' })
    return
  }

  try {
    const allAgentDefs = await getAllAgentDefinitions()
    const provider = providerName
      ? resolveProvider(providerName)
      : getDefaultProvider()

    if (!provider) {
      res.status(500).json({ error: 'No LLM provider available' })
      return
    }

    const resolvedModel = model ?? provider.config.defaultModel ?? 'sonnet'
    const toolPool = await buildToolPoolWithAgents()
    const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

    setCoordinatorMode(true)

    const result = await runAgent({
      agentDefinition: coordinatorDef,
      prompt: query,
      tools: toolPool,
      model: resolvedModel,
      provider,
      maxTurns: 50,
      agentDefinitions: allAgentDefs,
    })

    setCoordinatorMode(false)

    res.json({
      content: result.content,
      usage: result.usage,
      turnCount: result.turnCount,
      totalDurationMs: result.totalDurationMs,
    })
  } catch (error) {
    setCoordinatorMode(false)
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error(`Coordinator agent failed: ${errMsg}`)
    res.status(500).json({ error: errMsg })
  }
}

export async function handleGeneratePlan(req: Request, res: Response): Promise<void> {
  const { query, model, providerName } = req.body

  if (!query) {
    res.status(400).json({ error: 'query is required' })
    return
  }

  try {
    const allAgentDefs = await getAllAgentDefinitions()
    const provider = providerName
      ? resolveProvider(providerName)
      : getDefaultProvider()

    if (!provider) {
      res.status(500).json({ error: 'No LLM provider available' })
      return
    }

    const resolvedModel = model ?? provider.config.defaultModel ?? 'sonnet'
    const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

    res.json({
      message: 'Plan generation is now handled by the Coordinator agent at runtime. Use the /coordinate endpoint to execute tasks.',
      coordinatorAgent: {
        name: coordinatorDef.name,
        description: coordinatorDef.description,
        subagentType: coordinatorDef.subagentType,
      },
      availableAgents: allAgentDefs.map(a => ({
        name: a.name,
        description: a.description,
        subagentType: a.subagentType,
      })),
    })
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error(`Plan generation failed: ${errMsg}`)
    res.status(500).json({ error: errMsg })
  }
}

export function handleListSnapshots(_req: Request, res: Response): void {
  const snapshots = listSnapshots()
  res.json({ snapshots })
}

export async function handleResumePlan(req: Request, res: Response): Promise<void> {
  const { snapshotPath, model, providerName } = req.body

  if (!snapshotPath) {
    res.status(400).json({ error: 'snapshotPath is required' })
    return
  }

  try {
    const provider = providerName
      ? resolveProvider(providerName)
      : getDefaultProvider()

    if (!provider) {
      res.status(500).json({ error: 'No LLM provider available' })
      return
    }

    const resolvedModel = model ?? provider.config.defaultModel ?? 'sonnet'
    const allAgentDefs = await getAllAgentDefinitions()
    const toolPool = await buildToolPoolWithAgents()
    const coordinatorDef = getCoordinatorAgentDefinition(allAgentDefs)

    setCoordinatorMode(true)

    const result = await runAgent({
      agentDefinition: coordinatorDef,
      prompt: `Resume the previously saved coordination plan from snapshot: ${snapshotPath}. Read the snapshot file, understand what was done and what remains, then continue the work.`,
      tools: toolPool,
      model: resolvedModel,
      provider,
      maxTurns: 50,
      agentDefinitions: allAgentDefs,
    })

    setCoordinatorMode(false)

    res.json({
      content: result.content,
      usage: result.usage,
      turnCount: result.turnCount,
      totalDurationMs: result.totalDurationMs,
    })
  } catch (error) {
    setCoordinatorMode(false)
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error(`Resume plan failed: ${errMsg}`)
    res.status(500).json({ error: errMsg })
  }
}

export function handleListTasks(_req: Request, res: Response): void {
  const taskManager = getTaskManager()
  const tasks = taskManager.getAll().map(t => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    status: t.status,
    agentType: t.agentType,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    progress: t.progress,
    output: t.output,
    error: t.error,
    parentTaskId: t.parentTaskId,
  }))
  res.json({ tasks })
}

export function handleGetTask(req: Request, res: Response): void {
  const taskId = req.params.taskId as string
  const taskManager = getTaskManager()
  const task = taskManager.get(taskId)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json({
    id: task.id,
    name: task.name,
    kind: task.kind,
    status: task.status,
    agentType: task.agentType,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    progress: task.progress,
    output: task.output,
    error: task.error,
    parentTaskId: task.parentTaskId,
    metadata: task.metadata,
  })
}

export function handleKillTask(req: Request, res: Response): void {
  const taskId = req.params.taskId as string

  const agentTaskKilled = killRunningTask(taskId)
  if (agentTaskKilled) {
    res.json({ success: true, message: `Agent task ${taskId} killed` })
    return
  }

  const taskManager = getTaskManager()
  const task = taskManager.get(taskId)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  taskManager.kill(taskId)
  res.json({ success: true, message: `Task ${taskId} killed` })
}

export function handleTaskNotifications(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const taskManager = getTaskManager()

  const handler = (notification: import('../tasks/types.js').TaskNotification) => {
    try {
      res.write(`event: task_notification\ndata: ${JSON.stringify(notification)}\n\n`)
    } catch {
      // connection closed
    }
  }

  taskManager.onNotification(handler)

  req.on('close', () => {
    taskManager.removeNotificationHandler(handler)
  })
}

export function handleListTools(_req: Request, res: Response): void {
  const tools = buildToolPool().map(t => ({
    name: t.name,
    description: t.description,
    definition: t.getDefinition(),
  }))
  const mcpTools = getAllMCPTools().map(t => ({
    name: `mcp__${t.serverName}__${t.name}`,
    originalName: t.name,
    serverName: t.serverName,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  res.json({ tools, mcpTools, total: tools.length + mcpTools.length })
}

export function handleListConfiguredProviders(_req: Request, res: Response): void {
  const configured = getAllProviders().map(p => {
    const instance = getProvider(p.name)
    const modelConfigs = instance?.config.modelConfigs
    const modelList = modelConfigs
      ? Object.entries(modelConfigs).map(([key, mc]: [string, ModelConfig]) => ({
          key,
          id: mc.id,
          displayName: mc.displayName,
          contextWindow: mc.contextWindow,
          maxOutputTokens: mc.maxOutputTokens,
          supportsVision: mc.supportsVision,
          supportsToolUse: mc.supportsToolUse,
          supportsThinking: mc.supportsThinking,
        }))
      : undefined

    return {
      name: p.name,
      isDefault: p.isDefault,
      baseUrl: p.config.baseUrl,
      defaultModel: p.config.defaultModel,
      hasApiKey: !!p.config.apiKey,
      models: modelList,
      hasExtension: !!p.config.extension,
      extensionType: p.config.extension?.providerModule
        ? 'custom_provider'
        : p.config.extension?.requestTransformer || p.config.extension?.responseTransformer || p.config.extension?.streamChunkTransformer
          ? 'transformer'
          : undefined,
    }
  })
  const availableTypes = getRegisteredProviders().map(name => {
    const defaults = getProviderDefaults(name)
    const defaultModelConfigs = defaults?.modelConfigs
    const availableModels = defaultModelConfigs
      ? Object.entries(defaultModelConfigs).map(([key, mc]: [string, ModelConfig]) => ({
          key,
          id: mc.id,
          displayName: mc.displayName,
          contextWindow: mc.contextWindow,
          maxOutputTokens: mc.maxOutputTokens,
          supportsVision: mc.supportsVision,
          supportsToolUse: mc.supportsToolUse,
          supportsThinking: mc.supportsThinking,
        }))
      : defaults?.models
    return {
      name,
      defaultBaseUrl: defaults?.baseUrl,
      defaultModel: defaults?.defaultModel,
      availableModels,
    }
  })
  res.json({
    configured,
    availableTypes,
    defaultProvider: getDefaultProviderName(),
  })
}

export async function handleAddProvider(req: Request, res: Response): Promise<void> {
  const config = normalizeProviderConfig(req.body as Record<string, unknown>)

  const validation = validateProviderConfig(config)

  if (!validation.valid) {
    res.status(400).json({
      error: `Provider "${config.name ?? ''}" does not meet minimum configuration requirements`,
      errors: validation.errors,
      warnings: validation.warnings,
    })
    return
  }

  const setAsDefault = req.body.setAsDefault === true || req.body.is_default === true
  try {
    const provider = await addProvider(config, setAsDefault)
    res.status(201).json({
      name: provider.name,
      defaultModel: provider.config.defaultModel,
      isDefault: getDefaultProviderName() === config.name,
      hasExtension: !!config.extension,
      warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
    })
  } catch (error) {
    res.status(400).json({
      error: `Failed to add provider: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

export function handleRemoveProvider(req: Request, res: Response): void {
  const name = req.params.name as string
  if (!removeProvider(name)) {
    res.status(404).json({ error: `Provider "${name}" not found` })
    return
  }
  res.json({ success: true })
}

/**
 * Step 1: 验证地址可达性
 * POST /api/v1/providers/verify-address
 * body: { baseUrl, apiKey?, protocol?, ... }
 */
export async function handleVerifyProviderAddress(req: Request, res: Response): Promise<void> {
  const { parseVerifyInputsFromBody, verifyAddress } = await import('../providers/verify.js')
  const inputs = parseVerifyInputsFromBody(req.body as Record<string, unknown>)
  try {
    const result = await verifyAddress(inputs)
    res.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`verify-address failed: ${msg}`)
    res.status(500).json({ ok: false, message: msg })
  }
}

/**
 * Step 2: 验证协议兼容性
 * POST /api/v1/providers/verify-protocol
 */
export async function handleVerifyProviderProtocol(req: Request, res: Response): Promise<void> {
  const { parseVerifyInputsFromBody, verifyProtocol } = await import('../providers/verify.js')
  const inputs = parseVerifyInputsFromBody(req.body as Record<string, unknown>)
  try {
    const result = await verifyProtocol(inputs)
    res.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`verify-protocol failed: ${msg}`)
    res.status(500).json({ ok: false, message: msg, protocol: inputs.protocol })
  }
}

/**
 * Step 3: 拉取上游模型列表
 * POST /api/v1/providers/fetch-models
 */
export async function handleFetchProviderModels(req: Request, res: Response): Promise<void> {
  const { parseVerifyInputsFromBody, fetchRemoteModels } = await import('../providers/verify.js')
  const inputs = parseVerifyInputsFromBody(req.body as Record<string, unknown>)
  try {
    const result = await fetchRemoteModels(inputs)
    res.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`fetch-models failed: ${msg}`)
    res.status(500).json({ ok: false, message: msg, protocol: inputs.protocol, models: [] })
  }
}

/**
 * 一站式: 验证 + 拉取 + 保存
 * POST /api/v1/providers/verify-and-add
 * body: { name, displayName?, baseUrl, apiKey, protocol, defaultModel?, isDefault?, customConfig? }
 */
export async function handleVerifyAndAddProvider(req: Request, res: Response): Promise<void> {
  const {
    parseVerifyInputsFromBody,
    verifyAndAdd,
    remoteModelsToStoredModelConfigs,
  } = await import('../providers/verify.js')
  const body = req.body as Record<string, unknown>
  const inputs = parseVerifyInputsFromBody(body)

  try {
    const verifyResult = await verifyAndAdd(body)

    if (!verifyResult.addressOk) {
      res.status(400).json({
        success: false,
        ...verifyResult,
        message: verifyResult.errors.join('; ') || '地址不可达',
      })
      return
    }

    // 把验证结果存为 provider
    const name = ((body.name ?? body.id ?? '') as string).trim()
    if (!name) {
      res.status(400).json({
        success: false,
        ...verifyResult,
        message: 'name 不能为空',
      })
      return
    }

    const config = normalizeProviderConfig({
      ...body,
      name,
      apiKey: inputs.apiKey,
      baseUrl: inputs.baseUrl,
    })

    // 用拉到的模型构建 modelConfigs(优先使用 verifyAndAdd 返回的;它现在会自动用 body 里的 modelConfigs)
    if (verifyResult.models.length > 0) {
      config.modelConfigs = remoteModelsToStoredModelConfigs(verifyResult.models)
      if (!config.defaultModel) {
        config.defaultModel = verifyResult.models[0].id
      }
    } else if (body.modelConfigs) {
      // 兜底: 如果 verifyAndAdd 没返回 models 但 body 里有,直接用
      config.modelConfigs = body.modelConfigs as Record<string, never>
    }

    // 兜底: 如果仍然没有 defaultModel,主动报错
    if (!config.defaultModel) {
      res.status(400).json({
        success: false,
        ...verifyResult,
        message:
          verifyResult.errors.join('; ') ||
          '未提供默认模型且未成功拉取模型列表，请先点击「拉取模型」或手动填写默认模型',
      })
      return
    }

    // 兼容多种 isDefault 字段命名(camelCase / snake_case / setAsDefault)
    const setAsDefault =
      body.setAsDefault === true ||
      body.set_as_default === true ||
      body.isDefault === true ||
      body.is_default === true

    try {
      const provider = await addProvider(config, setAsDefault)

      // 关键:同时把 provider 持久化到 ComfyUI 配置文件(与 .env 的 SGA_HOME 一致)
      // 否则前端 /api/configs 永远读不到,刷新就消失
      try {
        const providerName = (body.protocol as string) || 'openai'
        const store = getComfyUIConfigStore()
        // 如果已存在同名(name)配置,先删除,避免重复
        const existing = store
          .getConfigs()
          .find(c => c.name === config.name)
        if (existing) {
          store.deleteConfig(existing.id)
        }
        const comfyConfig = store.createConfig({
          provider: providerName,
          name: config.name,
          api_key: config.apiKey,
          default_model: config.defaultModel ?? '',
          base_url: config.baseUrl,
          is_default: setAsDefault,
          default_max_tokens: config.defaultMaxTokens,
          default_temperature: config.defaultTemperature,
          retries: config.retries,
          retry_delay: config.retryDelay,
          headers: config.headers,
          custom_config: config.extra,
          model_configs: config.modelConfigs as Record<string, ComfyUIModelConfig> | undefined,
        })
        logger.info(`Persisted provider "${config.name}" to ComfyUI config store (id=${comfyConfig.id})`)
      } catch (persistErr) {
        logger.error(`Failed to persist provider to ComfyUI config store: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`)
      }
      res.status(201).json({
        success: true,
        name: provider.name,
        defaultModel: provider.config.defaultModel,
        isDefault: getDefaultProviderName() === config.name,
        models: verifyResult.models,
        addressOk: verifyResult.addressOk,
        protocolOk: verifyResult.protocolOk,
        fetchOk: verifyResult.fetchOk,
        protocol: verifyResult.protocol,
        warnings: verifyResult.warnings,
        errors: verifyResult.errors,
      })
    } catch (addErr) {
      res.status(400).json({
        success: false,
        ...verifyResult,
        message: `验证通过但保存失败: ${addErr instanceof Error ? addErr.message : String(addErr)}`,
      })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`verify-and-add failed: ${msg}`)
    res.status(500).json({ success: false, message: msg, errors: [msg] })
  }
}

export function handleSetDefaultProvider(req: Request, res: Response): void {
  const name = req.params.name as string
  if (!setDefaultProvider(name)) {
    res.status(404).json({ error: `Provider "${name}" not found` })
    return
  }
  res.json({ success: true, defaultProvider: name })
}

export function handleHealth(_req: Request, res: Response): void {
  const dp = getDefaultProvider()
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    sessions: getSessionStore().size(),
    defaultProvider: dp?.name ?? 'none',
    configuredProviders: getAllProviderNames(),
    availableProviderTypes: getRegisteredProviders(),
  })
}

function triggerMemoryExtraction(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  sessionId: string,
  agentType?: string,
): void {
  const memoryManager = getMemoryManager()
  if (!memoryManager) return

  if (memoryManager.getSessionId() !== sessionId) {
    memoryManager.setSessionId(sessionId)
  }

  memoryManager.setProvider(provider, model)

  const isComfyUIAgent = agentType === 'comfyui-workflow'
  const extractorConfig = isComfyUIAgent
    ? { ...DEFAULT_EXTRACTOR_CONFIG, forceScope: 'session' as const }
    : DEFAULT_EXTRACTOR_CONFIG

  const extractor = new MemoryExtractor(memoryManager, extractorConfig)
  extractor.setProvider(provider, model)

  if (!extractor.shouldExtract(messages.length)) return

  extractor.extractMemories(messages).catch(err => {
    logger.warn(`Background memory extraction failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

export function handleGetPermissionRules(_req: Request, res: Response): void {
  const rules = listRulesFromConfig()
  res.json({ rules })
}

export function handleUpdatePermissionMode(req: Request, res: Response): void {
  const { mode } = req.body as { mode: string }
  const validModes = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'auto', 'bubble', 'dontAsk']
  if (!mode || !validModes.includes(mode)) {
    res.status(400).json({ error: `Invalid permission mode. Valid modes: ${validModes.join(', ')}` })
    return
  }

  const ruleFile = loadPermissionRules()
  ruleFile.mode = mode as PermissionRuleFile['mode']
  savePermissionRules(ruleFile)
  res.json({ mode: ruleFile.mode, rules: ruleFile })
}

export function handleAddPermissionRule(req: Request, res: Response): void {
  const { tool, pattern, behavior, reason } = req.body as {
    tool: string
    pattern?: string
    behavior: 'allow' | 'deny' | 'ask'
    reason?: string
  }

  if (!tool || !behavior) {
    res.status(400).json({ error: 'tool and behavior are required' })
    return
  }

  if (!['allow', 'deny', 'ask'].includes(behavior)) {
    res.status(400).json({ error: 'behavior must be one of: allow, deny, ask' })
    return
  }

  addRuleToConfig({ tool, pattern, behavior, reason })
  const rules = listRulesFromConfig()
  res.json({ rules })
}

export function handleRemovePermissionRule(req: Request, res: Response): void {
  const { tool, pattern, behavior } = req.body as {
    tool: string
    pattern?: string
    behavior: 'allow' | 'deny' | 'ask'
  }

  if (!tool || !behavior) {
    res.status(400).json({ error: 'tool and behavior are required' })
    return
  }

  removeRuleFromConfig(behavior, tool, pattern)
  const rules = listRulesFromConfig()
  res.json({ rules })
}

export function handleCheckPermission(req: Request, res: Response): void {
  const { toolName, input } = req.body as { toolName: string; input?: Record<string, unknown> }

  if (!toolName) {
    res.status(400).json({ error: 'toolName is required' })
    return
  }

  const checker = createPermissionCheckerFromConfig()
  const result = checker.check(toolName, input)
  res.json({ result })
}

export function handleListHooks(_req: Request, res: Response): void {
  const hooks = listHooksFromConfig()
  res.json({ hooks })
}

export function handleAddHook(req: Request, res: Response): void {
  const { event, matcher, command, once, timeout } = req.body as {
    event: string
    matcher?: string
    command: string
    once?: boolean
    timeout?: number
  }

  const validEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Cancel', 'Stop', 'TaskCompleted', 'SessionEnd']
  if (!event || !validEvents.includes(event)) {
    res.status(400).json({ error: `event is required and must be one of: ${validEvents.join(', ')}` })
    return
  }
  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command is required and must be a string' })
    return
  }

  addHookToConfig({
    event: event as HookEventType,
    matcher,
    command,
    once,
    timeout,
  })

  const hooks = listHooksFromConfig()
  res.json({ hooks })
}

export function handleRemoveHook(req: Request, res: Response): void {
  const { event, command } = req.body as { event: string; command: string }

  if (!event || !command) {
    res.status(400).json({ error: 'event and command are required' })
    return
  }

  removeHookFromConfig(event as HookEventType, command)

  const hooks = listHooksFromConfig()
  res.json({ hooks })
}

export function handleTestHook(req: Request, res: Response): void {
  const { event, toolName, toolInput } = req.body as {
    event: string
    toolName?: string
    toolInput?: Record<string, unknown>
  }

  const validEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Cancel', 'Stop', 'TaskCompleted', 'SessionEnd']
  if (!event || !validEvents.includes(event)) {
    res.status(400).json({ error: `event is required and must be one of: ${validEvents.join(', ')}` })
    return
  }

  const config = loadHookConfig()
  const registry = new HookRegistry()
  for (const hookDef of config.hooks) {
    registry.register(hookDef)
  }
  const executor = new HookExecutor(registry)

  const context: HookExecutionContext = {
    toolName,
    toolInput,
    cwd: process.cwd(),
  }

  executor.execute(event as HookEventType, context)
    .then(results => {
      res.json({ results })
    })
    .catch(error => {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    })
}

export function handleClassifyPermission(req: Request, res: Response): void {
  const { toolName, input, permissionMode } = req.body as {
    toolName: string
    input?: Record<string, unknown>
    permissionMode?: string
  }

  if (!toolName) {
    res.status(400).json({ error: 'toolName is required' })
    return
  }

  const classifier = createDefaultClassifier()

  const context: import('../tools/base.js').ToolUseContext = {
    tools: [],
    messages: [],
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    permissionMode: permissionMode ?? 'default',
  }

  const result = classifier.classify(toolName, input ?? {}, context)
  res.json({ classification: result })
}

export interface ComfyUIModelConfig {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputPricePerMToken?: number
  outputPricePerMToken?: number
  /** Price unit: 'M' = per million tokens (default), 'K' = per thousand tokens */
  priceUnit?: 'M' | 'K'
  supportsVision?: boolean
  supportsToolUse?: boolean
  supportsStreaming?: boolean
  supportsThinking?: boolean
  supportsReasoningEffort?: boolean
  defaultMaxTokens?: number
  defaultTemperature?: number
  maxTemperature?: number
  thinkingBudget?: number
  baseUrl?: string
  streamingBaseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  extra?: Record<string, unknown>
}

export interface ComfyUIProviderConfig {
  id: string
  provider: string
  name: string
  api_key: string
  default_model: string
  base_url?: string
  is_default: boolean
  default_max_tokens?: number
  default_temperature?: number
  retries?: number
  retry_delay?: number
  headers?: Record<string, string>
  custom_config?: Record<string, unknown>
  model_configs?: Record<string, ComfyUIModelConfig>
  created_at: number
  updated_at: number
}

export class ComfyUIConfigStore {
  private configDir: string
  private configFile: string
  private githubTokenFile: string

  constructor() {
    const baseDir = process.env.COMFYUI_CONFIG_DIR ?? join(getSgaHome(), 'comfyui')
    this.configDir = join(baseDir, 'api_configs')
    this.configFile = join(this.configDir, 'providers.json')
    this.githubTokenFile = join(this.configDir, 'github_token.json')

    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true })
    }
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
  }

  private loadConfigs(): ComfyUIProviderConfig[] {
    if (!existsSync(this.configFile)) {
      return []
    }

    try {
      const content = readFileSync(this.configFile, 'utf-8')
      const data = JSON.parse(content)
      return Array.isArray(data) ? data : []
    } catch (e) {
      logger.error(`Error loading configs: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  private saveConfigs(configs: ComfyUIProviderConfig[]): void {
    try {
      writeFileSync(this.configFile, JSON.stringify(configs, null, 2), 'utf-8')
    } catch (e) {
      logger.error(`Error saving configs: ${e instanceof Error ? e.message : String(e)}`)
      throw new Error(`Error saving configs: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  getConfigs(): ComfyUIProviderConfig[] {
    return this.loadConfigs()
  }

  getConfigById(id: string): ComfyUIProviderConfig | undefined {
    return this.loadConfigs().find(c => c.id === id)
  }

  getDefaultConfig(): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const defaultConfig = configs.find(c => c.is_default)
    if (defaultConfig) return defaultConfig
    return configs.length > 0 ? configs[0] : undefined
  }

  createConfig(input: {
    provider: string
    name: string
    api_key: string
    default_model?: string
    base_url?: string
    is_default: boolean
    default_max_tokens?: number
    default_temperature?: number
    retries?: number
    retry_delay?: number
    headers?: Record<string, string>
    custom_config?: Record<string, unknown>
    model_configs?: Record<string, ComfyUIModelConfig>
  }): ComfyUIProviderConfig {
    const configs = this.loadConfigs()
    const now = Date.now() / 1000
    const id = crypto.randomUUID()

    if (input.is_default) {
      for (const c of configs) {
        c.is_default = false
      }
    }

    let resolvedDefaultModel = input.default_model || ''
    if (!resolvedDefaultModel && input.model_configs) {
      const firstKey = Object.keys(input.model_configs)[0]
      if (firstKey) {
        resolvedDefaultModel = input.model_configs[firstKey].id
      }
    }

    const newConfig: ComfyUIProviderConfig = {
      id,
      provider: input.provider,
      name: input.name,
      api_key: input.api_key,
      default_model: resolvedDefaultModel,
      base_url: input.base_url,
      is_default: input.is_default,
      default_max_tokens: input.default_max_tokens,
      default_temperature: input.default_temperature,
      retries: input.retries,
      retry_delay: input.retry_delay,
      headers: input.headers,
      custom_config: input.custom_config,
      model_configs: input.model_configs,
      created_at: now,
      updated_at: now,
    }

    configs.push(newConfig)
    this.saveConfigs(configs)
    return newConfig
  }

  updateConfig(id: string, updates: Partial<ComfyUIProviderConfig>): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const index = configs.findIndex(c => c.id === id)

    if (index === -1) return undefined

    const config = configs[index]

    if (updates.provider !== undefined) config.provider = updates.provider
    if (updates.name !== undefined) config.name = updates.name
    if (updates.api_key !== undefined) config.api_key = updates.api_key
    if (updates.default_model !== undefined) config.default_model = updates.default_model
    if (updates.base_url !== undefined) config.base_url = updates.base_url
    if (updates.default_max_tokens !== undefined) config.default_max_tokens = updates.default_max_tokens
    if (updates.default_temperature !== undefined) config.default_temperature = updates.default_temperature
    if (updates.retries !== undefined) config.retries = updates.retries
    if (updates.retry_delay !== undefined) config.retry_delay = updates.retry_delay
    if (updates.headers !== undefined) config.headers = updates.headers
    if (updates.custom_config !== undefined) {
      if (config.provider === 'custom') {
        config.custom_config = updates.custom_config
      } else {
        config.custom_config = undefined
      }
    }
    if (updates.model_configs !== undefined) config.model_configs = updates.model_configs

    if (updates.is_default !== undefined) {
      if (updates.is_default) {
        for (const c of configs) {
          c.is_default = false
        }
      }
      config.is_default = updates.is_default
    }

    config.updated_at = Date.now() / 1000
    configs[index] = config
    this.saveConfigs(configs)
    return config
  }

  deleteConfig(id: string): boolean {
    const configs = this.loadConfigs()
    const index = configs.findIndex(c => c.id === id)

    if (index === -1) return false

    configs.splice(index, 1)
    this.saveConfigs(configs)
    return true
  }

  setDefaultConfig(id: string): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const target = configs.find(c => c.id === id)

    if (!target) return undefined

    for (const c of configs) {
      c.is_default = false
    }

    target.is_default = true
    target.updated_at = Date.now() / 1000
    this.saveConfigs(configs)
    return target
  }

  hasGitHubToken(): boolean {
    return existsSync(this.githubTokenFile)
  }

  getGitHubToken(): string | undefined {
    if (!existsSync(this.githubTokenFile)) return undefined

    try {
      const content = readFileSync(this.githubTokenFile, 'utf-8')
      const data = JSON.parse(content)
      return data.token as string
    } catch {
      return undefined
    }
  }

  updateGitHubToken(token: string): void {
    const data = { token, created_at: Date.now() / 1000, updated_at: Date.now() / 1000 }
    writeFileSync(this.githubTokenFile, JSON.stringify(data, null, 2), 'utf-8')

    process.env.GITHUB_TOKEN = token
  }

  deleteGitHubToken(): void {
    if (existsSync(this.githubTokenFile)) {
      unlinkSync(this.githubTokenFile)
    }
    delete process.env.GITHUB_TOKEN
  }
}

// 惰性单例: 不能在模块加载时创建,否则 dotenv 还没执行,SGA_HOME 未设置,
// 会回退到 ~/.sga 而不是 .env 里配置的 ./data/.sga
let _comfyUIConfigStore: ComfyUIConfigStore | null = null
export function getComfyUIConfigStore(): ComfyUIConfigStore {
  if (!_comfyUIConfigStore) {
    _comfyUIConfigStore = new ComfyUIConfigStore()
  }
  return _comfyUIConfigStore
}

async function ensureSgaProvider(config: ComfyUIProviderConfig): Promise<LLMProvider> {
  const providerName = `comfyui-${config.id}`
  const existingNames = getAllProviderNames()

  if (existingNames.includes(providerName)) {
    removeProvider(providerName)
  }

  let effectiveBaseUrl = config.base_url
  let resolvedHeaders: Record<string, string> = { ...config.headers }

  if (config.provider === 'custom' && config.custom_config) {
    const customConfig = config.custom_config
    const endpoint = (customConfig.endpoint as string) || '/chat/completions'
    const headersTemplate = customConfig.headers as string | undefined

    const endpointWithoutChatCompletions = endpoint.replace(/\/chat\/completions$/, '').replace(/\/$/, '')
    if (effectiveBaseUrl && endpointWithoutChatCompletions) {
      effectiveBaseUrl = effectiveBaseUrl.replace(/\/$/, '') + endpointWithoutChatCompletions
    }

    if (headersTemplate) {
      try {
        const resolved = headersTemplate.replace(/\$apiKey/g, config.api_key)
        const parsed = JSON.parse(resolved) as Record<string, unknown>
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.startsWith('$')) continue
          resolvedHeaders[k] = String(v)
        }
      } catch (e) {
        console.warn('[SGA] Failed to parse headers template:', e)
      }
    }
  }

  const storedConfig: StoredProviderConfig = {
    name: providerName,
    apiKey: config.api_key,
    baseUrl: effectiveBaseUrl,
    defaultModel: config.default_model,
    defaultMaxTokens: config.default_max_tokens,
    defaultTemperature: config.default_temperature,
    retries: config.retries,
    retryDelay: config.retry_delay,
    headers: Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
    modelConfigs: config.model_configs as Record<string, import('../providers/types.js').ModelConfig> | undefined,
    extra: config.custom_config as Record<string, unknown> | undefined,
  }

  await addProvider(storedConfig)
  return resolveProvider(providerName)
}

async function handleComfyUIChatStreamWithCoordinator(
  _req: Request,
  res: Response,
  session: Session,
  options: {
    userMessage: string
    errorLog?: string
    providerName: string
    model: string
  },
): Promise<void> {
  const abortController = activeAbortControllers.get(session.id) ?? new AbortController()
  activeAbortControllers.set(session.id, abortController)

  initSSEResponse(res)

  const sendEvent = (event: AgentStreamEvent) => {
    try {
      if (res.writableEnded || abortController.signal.aborted) return
      if (!res.headersSent) {
        initSSEResponse(res)
      }
      res.write(formatSSE(event))
      flushSSE(res)
    } catch {
      // connection closed
    }
  }

  let partialText = ''

  try {
    const { detectTaskIntent, createComfyUICoordinatorPlan } = await import('../comfyui/coordinator-plans.js')
    const intent = detectTaskIntent(options.userMessage)

    const telemetry = TelemetryManager.getInstance()
    telemetry.trackEvent('comfyui_coordinator_start', {
      sessionId: session.id,
      taskIntent: intent.type,
      model: options.model,
      hasErrorLog: !!options.errorLog,
    })

    const provider = resolveProvider(options.providerName)
    const toolPool = await buildToolPoolWithAgents()
    const agentDefs = await getAllAgentDefinitions()

    const coordinatorDef = getCoordinatorAgentDefinition(agentDefs)

    const approvalPromiseMap: Map<string, {
      resolve: (response: unknown) => void
      reject: (error: Error) => void
    }> = new Map()

    const requestApproval = async (event: import('../agents/runner.js').ApprovalEvent): Promise<import('../agents/runner.js').ApprovalResponse> => {
      const approvalReq = createApprovalRequest({
        toolName: event.toolName,
        toolInput: event.toolInput,
        message: event.message,
        sessionId: session.id,
        suggestions: event.suggestions,
        isDestructive: true,
        isReadOnly: false,
      })

      sendEvent({
        type: 'approval_required',
        actionId: approvalReq.id,
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolCallId: event.toolCallId,
        message: event.message,
        suggestions: event.suggestions,
      })

      const approvalPromise = new Promise<UserApprovalResponse>((resolve, reject) => {
        const wrappedResolve = (resp: unknown) => resolve(resp as UserApprovalResponse)
        const wrappedReject = (err: Error) => reject(err)
        approvalPromiseMap.set(approvalReq.id, { resolve: wrappedResolve, reject: wrappedReject })
        pendingResolvers.set(approvalReq.id, { resolve: wrappedResolve, reject: wrappedReject })
      })

      setSessionWaitingInput(session, {
        type: 'approval',
        request: approvalReq,
        resolve: (resp: unknown) => {
          approvalPromiseMap.get(approvalReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          approvalPromiseMap.get(approvalReq.id)?.reject(error)
        },
      } as PendingAction, {
        actionId: approvalReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model: options.model,
        systemPromptContent: '',
        providerName: options.providerName,
      })

      try {
        const userResponse = await approvalPromise
        clearSessionWaitingInput(session)
        return {
          decision: userResponse.decision,
          updatedInput: userResponse.updatedInput,
          reason: userResponse.reason,
          permissionUpdate: userResponse.permissionUpdate,
        }
      } catch (error) {
        clearSessionWaitingInput(session)
        return { decision: 'deny', reason: 'Approval request cancelled' }
      } finally {
        approvalPromiseMap.delete(approvalReq.id)
        pendingResolvers.delete(approvalReq.id)
      }
    }

    const requestHumanInput = async (event: import('../agents/runner.js').HumanInputEvent): Promise<string> => {
      const inputReq = createHumanInputRequest({
        message: event.message,
        sessionId: session.id,
        context: event.context,
        options: event.options,
        allowFreeText: true,
      })

      sendEvent({
        type: 'human_input_required',
        actionId: inputReq.id,
        message: event.message,
        context: event.context,
        options: event.options,
      })

      const inputPromise = new Promise<UserInputResponse>((resolve, reject) => {
        pendingResolvers.set(inputReq.id, {
          resolve: (resp: unknown) => resolve(resp as UserInputResponse),
          reject: (err: Error) => reject(err),
        })
      })

      setSessionWaitingInput(session, {
        type: 'human_input',
        request: inputReq,
        resolve: (resp: unknown) => {
          pendingResolvers.get(inputReq.id)?.resolve(resp)
        },
        reject: (error: Error) => {
          pendingResolvers.get(inputReq.id)?.reject(error)
        },
      } as PendingAction, {
        actionId: inputReq.id,
        sessionId: session.id,
        messages: [...session.messages],
        toolCalls: [],
        pendingToolCallIndex: 0,
        turnCount: 0,
        usage: session.usage,
        model: options.model,
        systemPromptContent: '',
        providerName: options.providerName,
      })

      try {
        const userResponse = await inputPromise
        clearSessionWaitingInput(session)
        return userResponse.value
      } catch (error) {
        clearSessionWaitingInput(session)
        return '[Input request cancelled]'
      } finally {
        pendingResolvers.delete(inputReq.id)
      }
    }

    setCoordinatorMode(true)

    const planMgr = getPlanManager()
    planMgr.setNotificationCallback((event) => {
      sendEvent({
        type: 'plan_update',
        data: event,
      } as unknown as AgentStreamEvent)
    })

    const result = await runAgent({
      agentDefinition: coordinatorDef,
      prompt: options.userMessage,
      tools: toolPool,
      model: options.model,
      provider,
      maxTurns: 50,
      agentDefinitions: agentDefs,
      signal: abortController.signal,
      onProgress: (event: AgentStreamEvent) => {
        if (event.type === 'stream_delta' && event.text) {
          partialText += event.text
        }
        sendEvent(event)
      },
      requestApproval,
      requestHumanInput,
    })

    setCoordinatorMode(false)
    planMgr.setNotificationCallback(null)

    const synthesis = result.content

    const assistantMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: [{ type: 'text', text: synthesis }],
      timestamp: Date.now(),
    }
    getSessionStore().appendMessage(session.id, assistantMessage)
    getSessionStore().appendUsage(session.id, result.usage)

    const costMgr = getCostManager(session.id)
    if (costMgr) {
      costMgr.recordUsage(result.usage)
    }

    try {
      const taskMgr = getTaskManager()
      const existingTask = taskMgr.get(session.id)
      if (existingTask) {
        taskMgr.completeWithUsage(
          session.id,
          synthesis.slice(0, 200),
          {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.inputTokens + result.usage.outputTokens,
            totalCostUsd: costMgr?.getReport().totalCostUsd ?? 0,
          },
          result.totalDurationMs,
        )
      }
    } catch {
      // task completion tracking is optional
    }

    triggerMemoryExtraction(session.messages, provider, options.model, session.id, session.config.agentType)

    // 从最终回复中提取工作流 JSON 并发送 workflow_updated 事件
    try {
      const { extractWorkflowJSON } = await import('../comfyui/verification-strategies.js')
      const workflowJson = extractWorkflowJSON(synthesis)
      if (workflowJson) {
        sendEvent({ type: 'workflow_updated', workflowJson: JSON.stringify(workflowJson), actionType: 'coordinator_synthesis' })
      }
    } catch (e) {
      logger.debug(`Workflow JSON extraction from coordinator synthesis skipped: ${e instanceof Error ? e.message : String(e)}`)
    }

    sendEvent({
      type: 'coordinator_complete',
      data: {
        synthesis,
        totalDurationMs: result.totalDurationMs,
      },
    } as AgentStreamEvent)

    sendEvent({ type: 'done', data: { content: synthesis, usage: result.usage } })

    telemetry.trackEvent('comfyui_coordinator_complete', {
      sessionId: session.id,
      totalDurationMs: result.totalDurationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })

    try {
      const extensions = getAgentExtensions(session.config.agentType ?? 'comfyui-workflow')
      if (extensions?.enableAutoDream) {
        const memoryManager = getMemoryManager()
        if (memoryManager) {
          const { executeAutoDream, DEFAULT_AUTO_DREAM_CONFIG } = await import('../memory/consolidation/auto-dream.js')
          const { buildComfyUIConsolidationPrompt } = await import('../comfyui/consolidation-prompt.js')
          const extConfig = extensions.autoDreamConfig ?? {}
          const autoDreamConfig = {
            ...DEFAULT_AUTO_DREAM_CONFIG,
            ...extConfig,
            customPromptBuilder: buildComfyUIConsolidationPrompt,
          }
          const sessionCount = getSessionStore().size()
          executeAutoDream(memoryManager, provider, sessionCount, autoDreamConfig).catch(e => {
            logger.debug(`AutoDream background error: ${e instanceof Error ? e.message : String(e)}`)
          })
        }
      }
    } catch (e) {
      logger.debug(`AutoDream trigger skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      logger.info(`Session ${session.id}: coordinator agent run was aborted`)
      if (partialText.trim()) {
        const partialMsg: Message = {
          id: `msg-partial-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: partialText + '\n\n[Response interrupted - workflow was switched]' }],
          timestamp: Date.now(),
        }
        getSessionStore().appendMessage(session.id, partialMsg)
      }
    } else {
      logger.error(`Coordinator stream error: ${error instanceof Error ? error.message : String(error)}`)
      sendEvent({ type: 'error', data: error instanceof Error ? error.message : String(error) })
      sendEvent({ type: 'done', data: null })
    }
  }

  activeSSEConnections.delete(session.id)
  activeAbortControllers.delete(session.id)
  if (!res.writableEnded) {
    res.end()
  }
}

export async function handleComfyUIChatStream(req: Request, res: Response): Promise<void> {
  const { message, workflow, session_id, error_log, language, config_id, workflow_context_text } = req.body as Record<string, unknown>
  const sessionId = session_id as string
  const userMessage = message as string
  const errorLog = error_log as string | undefined
  const lang = (language as string) ?? 'en'
  const configId = config_id as string | undefined
  const workflowContextText = workflow_context_text as string | undefined

  closeSSEConnection(sessionId)
  initSSEResponse(res)
  activeSSEConnections.set(sessionId, res)

  const abortController = new AbortController()
  activeAbortControllers.set(sessionId, abortController)

  const onConnectionClose = () => {
    activeSSEConnections.delete(sessionId)
    abortController.abort()
    activeAbortControllers.delete(sessionId)
  }
  req.on('close', onConnectionClose)
  res.on('close', onConnectionClose)

  try {
    const config = configId ? getComfyUIConfigStore().getConfigById(configId) : getComfyUIConfigStore().getDefaultConfig()

    if (!config) {
      sendComfyUIEvent(res, { type: 'error', data: 'No provider configuration found. Please configure a provider in settings.' })
      res.write(formatSSE({ type: 'done', data: null }))
      res.end()
      activeAbortControllers.delete(sessionId)
      return
    }

    await ensureSgaProvider(config)
    const providerName = `comfyui-${config.id}`
    const model = config.default_model ?? 'sonnet'

    const telemetry = TelemetryManager.getInstance()
    telemetry.trackEvent('comfyui_chat_start', {
      sessionId,
      model,
      hasErrorLog: !!errorLog,
      language: lang,
      hasWorkflowContext: !!workflowContextText,
    })

    const store = getSessionStore()
    let session = store.get(sessionId)
    if (!session) {
      session = createSession({
        model,
        providerName,
        agentType: 'comfyui-workflow',
      })
      session.id = sessionId
      store.set(session)
    }

    getOrCreateCostManager(session.id)

    try {
      const taskMgr = getTaskManager()
      if (!taskMgr.get(session.id)) {
        const task = taskMgr.create({
          id: session.id,
          name: `ComfyUI Chat: ${userMessage.slice(0, 50)}`,
          kind: 'agent',
          agentType: 'comfyui-workflow',
        })
        taskMgr.onNotification((notification) => {
          try {
            sendComfyUIEvent(res, {
              type: 'task_status_update',
              data: {
                taskId: notification.taskId,
                status: notification.status,
                summary: notification.summary,
                usage: notification.usage,
                durationMs: notification.durationMs,
              },
            })
          } catch {
            // SSE connection may be closed
          }
        })
        sendComfyUIEvent(res, {
          type: 'task_created',
          data: {
            taskId: task.id,
            name: task.name ?? '',
            kind: task.kind,
            agentType: task.agentType,
          },
        })
      }
    } catch {
      // task creation is optional
    }

    try {
      const { registerComfyUIHooks } = await import('../comfyui/hooks.js')
      registerComfyUIHooks()
    } catch (hookErr) {
      logger.debug(`ComfyUI hooks registration skipped: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`)
    }

    let ws = getWorkingSet()
    if (!ws) {
      ws = initWorkingSet()
    }

    if (workflow) {
      const workflowStr = typeof workflow === 'string' ? workflow : JSON.stringify(workflow)
      const workflowObj = workflow as Record<string, unknown> | undefined
      const nodes = (workflowObj?.nodes ?? []) as Array<Record<string, unknown>>
      ws.pin(
        `workflow-${sessionId}`,
        `ComfyUI Workflow (${nodes.length} nodes)`,
        workflowStr,
        'comfyui-workflow',
        'critical',
        20_000,
      )

      const nodeTypes = nodes.map(n => n.type as string).filter(Boolean)
      const uniqueTypes = [...new Set(nodeTypes)]
      const typeCounts = new Map<string, number>()
      for (const t of nodeTypes) {
        typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
      }
      const summaryLines = [
        `Total nodes: ${nodes.length}`,
        `Unique node types: ${uniqueTypes.length}`,
        `Node types: ${uniqueTypes.map(t => `${t}(${typeCounts.get(t)})`).join(', ')}`,
      ]
      const lastNodeId = workflowObj?.last_node_id ?? 'unknown'
      const lastLinkId = workflowObj?.last_link_id ?? 'unknown'
      summaryLines.push(`Last node ID: ${lastNodeId}, Last link ID: ${lastLinkId}`)

      ws.pin(
        `workflow-summary-${sessionId}`,
        `Workflow Summary`,
        summaryLines.join('\n'),
        'comfyui-workflow',
        'high',
        1_000,
      )
    }

    if (workflowContextText) {
      ws.pin(
        `workflow-panel-context-${sessionId}`,
        `Workflow Panel Context`,
        workflowContextText,
        'comfyui-workflow',
        'high',
        5_000,
      )
    }

    if (errorLog) {
      ws.pin(
        `error-log-${sessionId}`,
        `Runtime Errors`,
        errorLog,
        'comfyui-workflow',
        'high',
        3_000,
      )
    }

    // 同步一份到 <SGA_HOME>/shared/comfyui/, 让 codex 进程 (comfyui_agent 模块)
    // 也能读到完整 workflow / 前端上下文 / 错误日志. working set 是在内存里,
    // codex 拿不到; 这里写到磁盘上, 跨进程共享.
    try {
      const { writeLiveContext } = await import('../comfyui/live-context.js')
      await writeLiveContext({
        workflow: workflow ?? undefined,
        frontendContext: workflowContextText ?? undefined,
        errorLog: errorLog ?? undefined,
      })
    } catch (lcErr) {
      logger.debug(
        `writeLiveContext skipped: ${lcErr instanceof Error ? lcErr.message : String(lcErr)}`,
      )
    }

    let contextParts: string[] = []
    if (lang && lang !== 'en') {
      contextParts.push(`IMPORTANT: You MUST respond in the following language code: "${lang}". Translate your advice and interface text accordingly.`)
    }

    const fullContent = contextParts.length > 0
      ? `${contextParts.join('\n\n')}\n\n${userMessage}`
      : userMessage

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: fullContent }],
      timestamp: Date.now(),
    }
    store.appendMessage(session.id, userMsg)

    const contextInjector = new ComfyUIContextInjector()
    await contextInjector.onSessionStart(session.messages)

    const { shouldUseCoordinator, detectTaskIntent, createComfyUICoordinatorPlan } = await import('../comfyui/coordinator-plans.js')
    const useCoordinator = shouldUseCoordinator(userMessage, errorLog)

    if (useCoordinator) {
      await handleComfyUIChatStreamWithCoordinator(req, res, session, {
        userMessage,
        errorLog,
        providerName,
        model,
      })
    } else {
      // 把 fullContent (含 language hint) 传给 handleStreamResponse,
      // 否则 codex 后端拿不到 user message, 只能回默认 "What do you want..." 之类的占位回复
      await handleStreamResponse(req, res, session, {
        content: fullContent,
        stream: true,
        agentType: 'comfyui-workflow',
        providerName,
        model,
      })
    }
  } catch (error) {
    logger.error(`Chat stream error: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.writableEnded) {
      sendComfyUIEvent(res, { type: 'error', data: error instanceof Error ? error.message : String(error) })
      sendComfyUIEvent(res, { type: 'done', data: null })
      res.end()
    }
  }
}

export function handleComfyUIChatHistory(req: Request, res: Response): void {
  const sessionId = req.params.sessionId as string
  const store = getSessionStore()
  const session = store.get(sessionId)

  if (!session) {
    res.json([])
    return
  }

  const history = session.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      let text = m.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n')
      if (m.role === 'user') {
        const requestMatch = text.match(/\[USER REQUEST\]\s*"([^"]*)"/)
        if (requestMatch) {
          text = requestMatch[1]
        } else {
          text = text
            .replace(/\[FULL WORKFLOW JSON\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/\[WORKFLOW PANEL CONTEXT[^\]]*\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/\[RUNTIME ERRORS\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/\[CURRENT WORKFLOW STATE\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/\[Current Workflow Context\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/IMPORTANT: You MUST respond in the following language code: "[^"]*"\.[^\n]*\n?/, '')
            .replace(/\[WORKFLOW CONTEXT\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/, '')
            .replace(/\[USER REQUEST\]\s*"?/, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        }
      } else if (m.role === 'assistant') {
        text = text
          .replace(/=== TASK PLANNING GUIDANCE ===[\s\S]*?=== END TASK PLANNING ===/, '')
          .replace(/=== TASK PLANNING GUIDANCE ===[\s\S]*?(?=\n\n[A-Z]|\n\n$|$)/, '')
          .replace(/\[CURRENT WORKFLOW STATE\][\s\S]*?(?=\n\n[A-Z]|\n\n$|$)/, '')
          .replace(/\[WORKFLOW CONTEXT\][\s\S]*?(?=\n\n[A-Z]|\n\n$|$)/, '')
          .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
          .replace(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }
      return {
        sender: m.role === 'user' ? 'user' : 'ai',
        text,
        timestamp: m.timestamp,
        metadata: m.role === 'assistant' ? { provider: 'sga' } : undefined,
      }
    })

  res.json({ messages: history, isActive: activeAbortControllers.has(sessionId) })
}

export function handleComfyUIChatAbort(req: Request, res: Response): void {
  const sessionId = req.params.sessionId as string

  const abortCtrl = activeAbortControllers.get(sessionId)
  if (!abortCtrl) {
    res.json({ success: true, message: 'No active agent running for this session' })
    return
  }

  try {
    abortCtrl.abort()
  } catch {
    // already aborted
  }
  activeAbortControllers.delete(sessionId)

  const existing = activeSSEConnections.get(sessionId)
  if (existing) {
    try {
      existing.end()
    } catch {
      // already closed
    }
    activeSSEConnections.delete(sessionId)
  }

  logger.info(`Session ${sessionId}: agent aborted via API`)
  res.json({ success: true, message: 'Agent aborted successfully' })
}

export async function handleComfyUIWorkflowAnalyze(req: Request, res: Response): Promise<void> {
  const { workflow, language } = req.body as Record<string, unknown>

  try {
    const tools = buildToolPool()
    const analyzerTool = tools.find(t => t.name === 'workflow_analyzer')

    if (!analyzerTool) {
      res.json({ issues: [] })
      return
    }

    const workflowJson = typeof workflow === 'string' ? workflow : JSON.stringify(workflow)
    const result = await analyzerTool.call(
      { workflow_json: workflowJson, language: (language as string) ?? 'en' },
      {
        tools,
        messages: [],
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
      },
    )

    const analysis = JSON.parse(result as string)
    res.json({ issues: analysis.issues ?? [], analysis })
  } catch (error) {
    logger.error(`Workflow analyze error: ${error instanceof Error ? error.message : String(error)}`)
    res.json({ issues: [] })
  }
}

export async function handleComfyUIWorkflowParse(req: Request, res: Response): Promise<void> {
  const { workflow, language } = req.body as Record<string, unknown>

  try {
    const tools = buildToolPool()
    const analyzerTool = tools.find(t => t.name === 'workflow_analyzer')

    if (!analyzerTool) {
      res.json({ analysis: { summary: '', data_flow: [], key_nodes: [], issues: [], suggestions: [] }, workflow_json: workflow })
      return
    }

    const workflowJson = typeof workflow === 'string' ? workflow : JSON.stringify(workflow)
    const result = await analyzerTool.call(
      { workflow_json: workflowJson, language: (language as string) ?? 'en' },
      {
        tools,
        messages: [],
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
      },
    )

    const analysis = JSON.parse(result as string)
    res.json({ analysis, workflow_json: workflow })
  } catch (error) {
    logger.error(`Workflow parse error: ${error instanceof Error ? error.message : String(error)}`)
    res.json({ analysis: { summary: '', data_flow: [], key_nodes: [], issues: [], suggestions: [] }, workflow_json: workflow })
  }
}

export function handleComfyUIActionExecute(req: Request, res: Response): void {
  const { action_type, action_data } = req.body as Record<string, unknown>

  try {
    res.json({
      success: true,
      message: `Action ${action_type as string} executed successfully`,
      data: action_data,
      can_undo: true,
      undo_action: 'undo',
    })
  } catch (error) {
    res.json({
      success: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function handleComfyUIActionUndo(_req: Request, res: Response): void {
  try {
    const lastAction = undoLastAction()
    if (lastAction) {
      res.json({
        success: true,
        message: 'Action undone successfully',
        restored_state: lastAction.workflow_before,
      })
    } else {
      res.json({
        success: false,
        message: 'No action to undo',
      })
    }
  } catch (error) {
    res.json({
      success: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function toFrontendConfig(config: ComfyUIProviderConfig): Record<string, unknown> {
  return {
    id: config.id,
    provider: config.provider,
    name: config.name,
    default_model: config.default_model,
    base_url: config.base_url,
    is_default: config.is_default,
    default_max_tokens: config.default_max_tokens,
    default_temperature: config.default_temperature,
    retries: config.retries,
    retry_delay: config.retry_delay,
    headers: config.headers,
    custom_config: config.custom_config,
    model_configs: config.model_configs,
    extension: config.provider === 'custom' && config.custom_config
      ? { providerModule: undefined }
      : undefined,
    has_api_key: !!config.api_key,
    created_at: new Date(config.created_at * 1000).toISOString(),
  }
}

export function handleComfyUIListConfigs(_req: Request, res: Response): void {
  const configs = getComfyUIConfigStore().getConfigs()
  res.json({ configs: configs.map(toFrontendConfig), total: configs.length })
}

export function handleComfyUICreateConfig(req: Request, res: Response): void {
  try {
    const body = req.body as Record<string, unknown>
    const provider = body.provider as string
    const custom_config = body.custom_config as Record<string, unknown> | undefined

    if (provider !== 'custom' && custom_config) {
      res.status(400).json({ error: 'custom_config is only allowed for custom provider' })
      return
    }

    const config = getComfyUIConfigStore().createConfig({
      provider,
      name: body.name as string,
      api_key: body.api_key as string,
      default_model: body.default_model as string | undefined,
      base_url: body.base_url as string | undefined,
      is_default: (body.is_default as boolean) ?? false,
      default_max_tokens: body.default_max_tokens as number | undefined,
      default_temperature: body.default_temperature as number | undefined,
      retries: body.retries as number | undefined,
      retry_delay: body.retry_delay as number | undefined,
      headers: body.headers as Record<string, string> | undefined,
      custom_config,
      model_configs: body.model_configs as Record<string, ComfyUIModelConfig> | undefined,
    })

    res.json(toFrontendConfig(config))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleComfyUIGetConfig(req: Request, res: Response): void {
  const configId = req.params.configId as string
  const config = getComfyUIConfigStore().getConfigById(configId)
  if (!config) {
    res.status(404).json({ error: 'Config not found' })
    return
  }
  res.json(toFrontendConfig(config))
}

export function handleComfyUIUpdateConfig(req: Request, res: Response): void {
  try {
    const configId = req.params.configId as string
    const body = req.body as Record<string, unknown>

    const updates: Partial<ComfyUIProviderConfig> = {}
    if (body.provider !== undefined) updates.provider = body.provider as string
    if (body.name !== undefined) updates.name = body.name as string
    if (body.api_key !== undefined) updates.api_key = body.api_key as string
    if (body.default_model !== undefined) updates.default_model = body.default_model as string
    if (body.base_url !== undefined) updates.base_url = body.base_url as string | undefined
    if (body.is_default !== undefined) updates.is_default = body.is_default as boolean
    if (body.default_max_tokens !== undefined) updates.default_max_tokens = body.default_max_tokens as number | undefined
    if (body.default_temperature !== undefined) updates.default_temperature = body.default_temperature as number | undefined
    if (body.retries !== undefined) updates.retries = body.retries as number | undefined
    if (body.retry_delay !== undefined) updates.retry_delay = body.retry_delay as number | undefined
    if (body.headers !== undefined) updates.headers = body.headers as Record<string, string> | undefined
    if (body.custom_config !== undefined) updates.custom_config = body.custom_config as Record<string, unknown> | undefined
    if (body.model_configs !== undefined) updates.model_configs = body.model_configs as Record<string, ComfyUIModelConfig> | undefined

    const config = getComfyUIConfigStore().updateConfig(configId, updates)
    if (!config) {
      res.status(404).json({ error: 'Config not found' })
      return
    }
    res.json(toFrontendConfig(config))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleComfyUIDeleteConfig(req: Request, res: Response): void {
  const configId = req.params.configId as string
  const success = getComfyUIConfigStore().deleteConfig(configId)
  res.json({ success, message: success ? 'Config deleted successfully' : 'Config not found' })
}

export function handleComfyUISetDefaultConfig(req: Request, res: Response): void {
  const { config_id } = req.body as Record<string, unknown>
  const config = getComfyUIConfigStore().setDefaultConfig(config_id as string)
  if (!config) {
    res.status(404).json({ error: 'Config not found' })
    return
  }
  res.json(toFrontendConfig(config))
}

export function handleComfyUIGetGitHubToken(_req: Request, res: Response): void {
  const hasToken = getComfyUIConfigStore().hasGitHubToken()
  res.json({ has_token: hasToken })
}

export function handleComfyUIUpdateGitHubToken(req: Request, res: Response): void {
  const { token } = req.body as Record<string, unknown>
  getComfyUIConfigStore().updateGitHubToken(token as string)
  res.json({ success: true, message: 'GitHub token updated successfully', has_token: true })
}

export function handleComfyUIDeleteGitHubToken(_req: Request, res: Response): void {
  getComfyUIConfigStore().deleteGitHubToken()
  res.json({ success: true, message: 'GitHub token deleted successfully', has_token: false })
}

export function handleComfyUIUserInput(req: Request, res: Response): void {
  const { session_id, action_id, decision, updatedInput, reason, value, optionValue } = req.body as Record<string, unknown>

  const store = getSessionStore()
  const session = store.get(session_id as string)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (session.status !== 'waiting_input') {
    res.status(400).json({ error: 'Session is not waiting for input' })
    return
  }

  if (!session.pendingAction) {
    res.status(400).json({ error: 'No pending action found' })
    return
  }

  const pendingResolver = pendingResolvers.get(action_id as string)
  if (!pendingResolver) {
    res.status(400).json({ error: 'Invalid or expired action ID' })
    return
  }

  if (session.pendingAction.type === 'approval') {
    const response: UserApprovalResponse = {
      actionId: action_id as string,
      decision: (decision as 'allow' | 'deny') ?? 'deny',
      updatedInput: updatedInput as Record<string, unknown> | undefined,
      reason: reason as string | undefined,
    }
    pendingResolver.resolve(response)
  } else {
    const response: UserInputResponse = {
      actionId: action_id as string,
      value: (value as string) ?? '',
      optionValue: optionValue as string | undefined,
    }
    pendingResolver.resolve(response)
  }

  pendingResolvers.delete(action_id as string)

  res.json({
    success: true,
    sessionId: session.id,
    message: 'Input received, agent execution will resume',
  })
}

export function handleListFeatureGates(_req: Request, res: Response): void {
  const gate = FeatureGateManager.getInstance()
  const gates = gate.listGates()
  res.json({ gates })
}

export function handleGetFeatureGate(req: Request, res: Response): void {
  const name = req.params.name as string
  const gate = FeatureGateManager.getInstance()
  const gates = gate.listGates()
  const found = gates.find(g => g.name === name)
  if (!found) {
    res.status(404).json({ error: `Feature gate "${name}" not found` })
    return
  }
  res.json({ gate: found })
}

export function handleOverrideFeatureGate(req: Request, res: Response): void {
  const { name, enabled } = req.body as { name: string; enabled: boolean }

  if (!name || typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'name and enabled (boolean) are required' })
    return
  }

  const gate = FeatureGateManager.getInstance()
  gate.override(name, enabled)
  const gates = gate.listGates()
  const updated = gates.find(g => g.name === name)
  res.json({ gate: updated })
}

export function handleResetFeatureGate(req: Request, res: Response): void {
  const { name } = req.body as { name: string }

  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }

  const gate = FeatureGateManager.getInstance()
  gate.clearOverride(name)
  const gates = gate.listGates()
  const updated = gates.find(g => g.name === name)
  res.json({ gate: updated })
}

export function handleResetAllFeatureGates(_req: Request, res: Response): void {
  const gate = FeatureGateManager.getInstance()
  gate.clearAllOverrides()
  const gates = gate.listGates()
  res.json({ gates })
}

export function handleRegisterFeatureGate(req: Request, res: Response): void {
  const { name, description, defaultEnabled, envVar } = req.body as {
    name: string
    description: string
    defaultEnabled: boolean
    envVar?: string
  }

  if (!name || !description || typeof defaultEnabled !== 'boolean') {
    res.status(400).json({ error: 'name, description, and defaultEnabled (boolean) are required' })
    return
  }

  const config: FeatureGateConfig = { name, description, defaultEnabled, envVar }
  const gate = FeatureGateManager.getInstance()
  gate.registerGate(config)
  const gates = gate.listGates()
  const created = gates.find(g => g.name === name)
  res.status(201).json({ gate: created })
}

export function handleGetTelemetryStatus(_req: Request, res: Response): void {
  const telemetry = TelemetryManager.getInstance()
  res.json({
    enabled: telemetry.isEnabled(),
    sessionId: (telemetry as unknown as { sessionId: string }).sessionId,
  })
}

export function handleToggleTelemetry(req: Request, res: Response): void {
  const { enabled } = req.body as { enabled: boolean }

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' })
    return
  }

  const telemetry = TelemetryManager.getInstance()
  if (enabled) {
    telemetry.enable()
  } else {
    telemetry.disable()
  }

  const gate = FeatureGateManager.getInstance()
  gate.override('telemetry', enabled)

  res.json({ enabled: telemetry.isEnabled() })
}

export function handleFlushTelemetry(_req: Request, res: Response): void {
  const telemetry = TelemetryManager.getInstance()
  telemetry.flush()
    .then(() => res.json({ success: true }))
    .catch(error => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }))
}

export function handleGetTelemetryEvents(_req: Request, res: Response): void {
  const telemetry = TelemetryManager.getInstance()
  const queue = (telemetry as unknown as { eventQueue: Array<{ name: string; properties: Record<string, unknown>; timestamp: number; sessionId?: string }> }).eventQueue
  res.json({
    eventCount: queue.length,
    events: queue.slice(-100),
  })
}

export function handleClassifyBashCommand(req: Request, res: Response): void {
  const { command } = req.body as { command: string }

  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command is required and must be a string' })
    return
  }

  const result = classifyBashCommand(command)
  res.json({ classification: result })
}

export function handleClassifyError(req: Request, res: Response): void {
  const { error } = req.body as { error: string }

  if (!error || typeof error !== 'string') {
    res.status(400).json({ error: 'error is required and must be a string' })
    return
  }

  const category = classifyError(error)
  res.json({ category })
}

export async function handlePreviewSystemPrompt(req: Request, res: Response): Promise<void> {
  const { model, enabledTools, languagePreference, mcpInstructions, skillList } = req.body as {
    model?: string
    enabledTools?: string[]
    languagePreference?: string
    mcpInstructions?: boolean
    skillList?: boolean
  }

  const options: SystemPromptBuildOptions = {
    model: model ?? 'sonnet',
    enabledTools: new Set(enabledTools ?? ['Read', 'Write', 'Bash', 'Glob', 'Grep']),
    languagePreference,
    mcpInstructions: mcpInstructions ?? true,
    skillList: skillList ?? true,
  }

  try {
    const prompt = await buildFullSystemPrompt('', options)
    const boundaryIndex = prompt.indexOf('---DYNAMIC_BOUNDARY---')
    res.json({
      fullPrompt: prompt,
      totalLength: prompt.length,
      staticPart: boundaryIndex > 0 ? prompt.slice(0, boundaryIndex).trim() : prompt,
      dynamicPart: boundaryIndex > 0 ? prompt.slice(boundaryIndex + '---DYNAMIC_BOUNDARY---'.length).trim() : '',
      hasDynamicBoundary: boundaryIndex > 0,
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleGetConfig(_req: Request, res: Response): void {
  const { getSgaConfig } = require('../config.js') as typeof import('../config.js')
  const config = getSgaConfig()
  res.json({ config })
}

export function handleGetConfigSection(req: Request, res: Response): void {
  const { getSgaConfig } = require('../config.js') as typeof import('../config.js')
  const config = getSgaConfig()
  const section = req.params.section as string

  if (!(section in config)) {
    res.status(404).json({ error: `Config section "${section}" not found. Available: ${Object.keys(config).join(', ')}` })
    return
  }

  res.json({ section, config: (config as unknown as Record<string, unknown>)[section] })
}

export function handleGetCostTracker(req: Request, res: Response): void {
  const sessionId = req.params.sessionId as string
  const tracker = costTrackers.get(sessionId)

  if (!tracker) {
    res.status(404).json({ error: `Cost tracker not found for session "${sessionId}"` })
    return
  }

  res.json({
    sessionId,
    totalCostUsd: tracker.getTotalCostUsd(),
    totalInputTokens: tracker.getTotalInputTokens(),
    totalOutputTokens: tracker.getTotalOutputTokens(),
    isOverBudget: tracker.isOverBudget(),
    isNearBudget: tracker.isNearBudget(),
    remainingBudget: tracker.getRemainingBudget(),
    report: tracker.getUsageReport(),
  })
}

export function handleSetBudget(req: Request, res: Response): void {
  const sessionId = req.params.sessionId as string
  const { maxBudgetUsd } = req.body as { maxBudgetUsd?: number }

  if (typeof maxBudgetUsd !== 'number' || maxBudgetUsd < 0) {
    res.status(400).json({ error: 'maxBudgetUsd must be a non-negative number' })
    return
  }

  let tracker = costTrackers.get(sessionId)
  if (!tracker) {
    const store = getSessionStore()
    if (!store.has(sessionId)) {
      res.status(404).json({ error: `Session "${sessionId}" not found` })
      return
    }
    tracker = new CostTracker({ maxBudgetUsd })
    costTrackers.set(sessionId, tracker)
  } else {
    const oldTracker = tracker
    tracker = new CostTracker({
      maxBudgetUsd,
      costPerInputToken: (oldTracker as unknown as { costPerInputToken: number }).costPerInputToken,
      costPerOutputToken: (oldTracker as unknown as { costPerOutputToken: number }).costPerOutputToken,
    })
    tracker.addUsage({
      inputTokens: oldTracker.getTotalInputTokens(),
      outputTokens: oldTracker.getTotalOutputTokens(),
    })
    costTrackers.set(sessionId, tracker)
  }

  res.json({
    sessionId,
    maxBudgetUsd,
    totalCostUsd: tracker.getTotalCostUsd(),
    remainingBudget: tracker.getRemainingBudget(),
  })
}

export function handleListMemories(_req: Request, res: Response): void {
  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(503).json({ error: 'Memory manager not initialized' })
    return
  }

  Promise.all([
    memoryManager.listGlobalMemories(),
    memoryManager.listProjectMemories(),
    memoryManager.listSessionMemories(),
  ]).then(([global, project, session]) => {
    const all = [...global, ...project, ...session]
    res.json({
      count: all.length,
      global: global.length,
      project: project.length,
      session: session.length,
      memories: all.map(m => ({
        path: m.path,
        type: m.type,
        scope: m.frontmatter.scope ?? 'project',
        description: m.description,
        mtimeMs: m.mtimeMs,
        sizeBytes: m.sizeBytes,
      })),
    })
  }).catch(error => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  })
}

export function handleGetMemory(req: Request, res: Response): void {
  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(503).json({ error: 'Memory manager not initialized' })
    return
  }

  const name = req.params.name as string

  Promise.all([
    memoryManager.listGlobalMemories(),
    memoryManager.listProjectMemories(),
    memoryManager.listSessionMemories(),
  ]).then(([global, project, session]) => {
    const all = [...global, ...project, ...session]
    const found = all.find(m => m.path.endsWith(`${name}.md`) || m.description === name)

    if (!found) {
      res.status(404).json({ error: `Memory "${name}" not found` })
      return
    }

    res.json({
      path: found.path,
      type: found.type,
      scope: found.frontmatter.scope ?? 'project',
      description: found.description,
      content: found.content,
      frontmatter: found.frontmatter,
      mtimeMs: found.mtimeMs,
      sizeBytes: found.sizeBytes,
    })
  }).catch(error => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  })
}

export async function handleSearchMemories(req: Request, res: Response): Promise<void> {
  const { query } = req.body as { query: string }

  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'query is required and must be a string' })
    return
  }

  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(503).json({ error: 'Memory manager not initialized' })
    return
  }

  try {
    const result = await memoryManager.findRelevant(query)
    res.json({
      query,
      count: result.memories.length,
      memories: result.memories.map(m => ({
        path: m.path,
        type: m.type,
        scope: m.frontmatter.scope ?? 'project',
        description: m.description,
        content: m.content,
        freshnessWarning: result.freshnessWarnings.get(m.path),
      })),
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export async function handleDeleteMemory(req: Request, res: Response): Promise<void> {
  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(503).json({ error: 'Memory manager not initialized' })
    return
  }

  const scope = req.params.scope as string
  try {
    if (scope === 'session') {
      const deleted = await memoryManager.deleteSessionMemories()
      res.json({ success: true, deleted, scope: 'session' })
    } else {
      res.status(400).json({ error: 'Only session scope deletion is supported. Use scope=session.' })
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export async function handleExtractMemories(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.body as { sessionId?: string }

  const memoryManager = getMemoryManager()
  if (!memoryManager) {
    res.status(503).json({ error: 'Memory manager not initialized' })
    return
  }

  const defaultProvider = getDefaultProvider()
  if (!defaultProvider) {
    res.status(503).json({ error: 'No default provider configured' })
    return
  }

  const extractor = new MemoryExtractor(memoryManager)
  extractor.setProvider(defaultProvider, defaultProvider.config.defaultModel)

  let messages: Message[] = []
  if (sessionId) {
    const store = getSessionStore()
    const session = store.get(sessionId)
    if (!session) {
      res.status(404).json({ error: `Session "${sessionId}" not found` })
      return
    }
    messages = session.messages
  }

  try {
    if (messages.length > 0 && extractor.shouldExtract(messages.length)) {
      await extractor.extractMemories(messages)
    }
    res.json({ success: true, messageCount: messages.length })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleGetCircuitBreakerStatus(_req: Request, res: Response): void {
  const { CompactCircuitBreaker, ConsolidationCircuitBreaker } = require('../utils/circuit-breaker.js') as typeof import('../utils/circuit-breaker.js')

  const compact = new CompactCircuitBreaker()
  const consolidation = new ConsolidationCircuitBreaker()

  res.json({
    compact: compact.getStats(),
    consolidation: consolidation.getStats(),
  })
}

export function handleResetCircuitBreaker(req: Request, res: Response): void {
  const { type } = req.body as { type?: 'compact' | 'consolidation' | 'all' }
  const resetType = type ?? 'all'
  const { CompactCircuitBreaker, ConsolidationCircuitBreaker } = require('../utils/circuit-breaker.js') as typeof import('../utils/circuit-breaker.js')

  const results: Record<string, unknown> = {}

  if (resetType === 'compact' || resetType === 'all') {
    const cb = new CompactCircuitBreaker()
    cb.reset()
    results.compact = cb.getStats()
  }

  if (resetType === 'consolidation' || resetType === 'all') {
    const cb = new ConsolidationCircuitBreaker()
    cb.reset()
    results.consolidation = cb.getStats()
  }

  res.json({ success: true, ...results })
}

export function handleGetContextBudget(_req: Request, res: Response): void {
  const { getBudgetConfig, computeBudgetAllocation } = require('../memory/context-budget.js') as typeof import('../memory/context-budget.js')
  const config = getBudgetConfig()
  const allocation = computeBudgetAllocation(config)

  res.json({
    config,
    allocation,
  })
}
