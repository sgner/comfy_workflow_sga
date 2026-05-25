import type { Request, Response } from 'express'
import type { Session, CreateSessionRequest, SendMessageRequest, SendMessageResponse, StreamEventPayload, UserInputRequest } from './session.js'
import { createSession, addMessageToSession, updateSessionUsage, setSessionWaitingInput, clearSessionWaitingInput, formatSSE } from './session.js'
import type { Message, AgentStreamEvent } from '../core/types.js'
import type { PendingAction, UserApprovalResponse, UserInputResponse, SuspendedContext } from './interaction.js'
import { createLogger } from '../utils/logger.js'
import { getSessionStore } from './session-store.js'
import { getMemoryManager } from '../memory/manager.js'
import { MemoryExtractor } from '../memory/extractor.js'

const logger = createLogger('routes')
import { createApprovalRequest, createHumanInputRequest } from './interaction.js'
import { createBuiltinTools } from '../tools/built-in/index.js'
import { assembleToolPool } from '../tools/registry.js'
import { getConnectedMCPClients, getAllMCPTools } from '../mcp/index.js'
import { createAllMCPToolAdapters } from '../mcp/adapter.js'
import { getBuiltinAgentDefinitions, getAgentDefinitionByName, runAgent, getAllAgentDefinitions, createAgentFromConfig, agentDefinitionToJSON, isCustomAgent, getCoordinatorAgentDefinition, isCoordinatorMode, setCoordinatorMode, getCoordinatorSystemPrompt, listSnapshots } from '../agents/index.js'
import { getTaskManager } from '../tasks/index.js'
import { killRunningTask, getAllRunningTasks, waitForTask, cleanupCompletedTasks, setTaskNotificationCallback, formatTaskNotificationXml } from '../tools/built-in/agent.js'
import { CostTracker } from '../utils/cost-tracker.js'
import { resolveProvider, getAllProviders, getDefaultProviderName, getDefaultProvider, addProvider, removeProvider, setDefaultProvider, getProviderConfig, getAllProviderNames, getProvider } from '../providers/provider-store.js'
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

const costTrackers: Map<string, CostTracker> = new Map()
const pendingResolvers: Map<string, {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
}> = new Map()
const activeSSEConnections: Map<string, Response> = new Map()

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

export function handleCreateSession(req: Request, res: Response): void {
  const body: CreateSessionRequest = req.body

  if (body.providerName) {
    const available = getAllProviderNames()
    if (!available.includes(body.providerName)) {
      res.status(400).json({
        error: `Provider "${body.providerName}" is not configured. Available providers: ${available.join(', ') || 'none'}`,
      })
      return
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
  costTrackers.set(session.id, new CostTracker({ maxBudgetUsd: body.maxBudgetUsd }))
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
  costTrackers.delete(sessionId)
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

        triggerMemoryExtraction(session.messages, provider, model)

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

    triggerMemoryExtraction(session.messages, provider, model)

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
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  activeSSEConnections.set(session.id, res)

  const sendEvent = (event: AgentStreamEvent) => {
    try {
      res.write(formatSSE(event))
    } catch {
      // connection closed
    }
  }

  try {
    const provider = getProviderForSession(session, body.providerName)
    const model = body.model ?? session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

    sendEvent({ type: 'session_start', sessionId: session.id, model, agentType: body.agentType })

    if (!agentDef) {
      sendEvent({ type: 'error', data: 'No agent definition available' })
      sendEvent({ type: 'done', data: null })
      res.end()
      activeSSEConnections.delete(session.id)
      return
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
        getSessionStore().appendMessage(session.id, assistantMessage)
        getSessionStore().appendUsage(session.id, result.usage)

        triggerMemoryExtraction(session.messages, provider, model)

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
      onProgress: (event: AgentStreamEvent) => {
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

    triggerMemoryExtraction(session.messages, provider, model)

    sendEvent({ type: 'done', data: { content: result.content, usage: result.usage } })
  } catch (error) {
    getSessionStore().updateStatus(session.id, 'error', error instanceof Error ? error.message : String(error))
    sendEvent({ type: 'error', data: session.error ?? 'Unknown error' })
    sendEvent({ type: 'done', data: null })
  }

  res.end()
  activeSSEConnections.delete(session.id)
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
  const tracker = costTrackers.get(sessionId)
  res.json({
    usage: session.usage,
    costReport: tracker?.getUsageReport() ?? 'No cost tracker',
  })
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
  const { normalizeProviderConfig, validateProviderConfig } = await import('../providers/provider-store.js')
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
): void {
  const memoryManager = getMemoryManager()
  if (!memoryManager) return

  const extractor = new MemoryExtractor(memoryManager)
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
