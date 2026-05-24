import type { Request, Response } from 'express'
import type { Session, CreateSessionRequest, SendMessageRequest, SendMessageResponse, StreamEventPayload, UserInputRequest } from './session.js'
import { createSession, addMessageToSession, updateSessionUsage, setSessionWaitingInput, clearSessionWaitingInput, formatSSE } from './session.js'
import type { Message, AgentStreamEvent } from '../core/types.js'
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
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })

const logger = createLogger('routes')
import { createBuiltinTools } from '../tools/built-in/index.js'
import { assembleToolPool } from '../tools/registry.js'
import { getConnectedMCPClients, getAllMCPTools } from '../mcp/index.js'
import { createAllMCPToolAdapters } from '../mcp/adapter.js'
import { getBuiltinAgentDefinitions, getAgentDefinitionByName, runAgent, getAllAgentDefinitions, createAgentFromConfig, agentDefinitionToJSON, isCustomAgent, Coordinator, createCoordinatorPlanFromUserQuery, generateDynamicPlan, listSnapshots, getCoordinatorSystemPrompt } from '../agents/index.js'
import { getTaskManager } from '../tasks/index.js'
import { killRunningTask, getAllRunningTasks, waitForTask, cleanupCompletedTasks } from '../tools/built-in/agent.js'
import { getOrCreateCostManager, getCostManager, removeCostManager, ComfyUIContextInjector } from '../comfyui/adapter.js'
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
        const config = comfyUIConfigStore.getConfigById(configId)
        if (config) {
          await ensureSgaProvider(config)
        } else {
          res.status(400).json({
            error: `ComfyUI config "${configId}" not found. Available configs: ${comfyUIConfigStore.getConfigs().map(c => c.id).join(', ') || 'none'}`,
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

    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

    if (!agentDef) {
      res.status(500).json({ error: 'No agent definition available' })
      return
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

    const costMgr = getCostManager(session.id)
    if (costMgr) {
      costMgr.recordUsage(result.usage)
    }

    triggerMemoryExtraction(session.messages, provider, model, session.id, session.config.agentType)

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
    const { Coordinator, createCoordinatorPlanFromUserQuery, generateDynamicPlan } = await import('../agents/coordinator.js')

    const provider = getProviderForSession(session)
    const model = session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = buildToolPool()
    const agentDefs = await getAllAgentDefinitions()

    const coordinator = new Coordinator({
      maxConcurrency: 2,
      defaultModel: model,
      provider,
      tools,
      agentDefinitions: agentDefs,
      maxTurnsPerAgent: 5,
    })

    let plan
    if (strategy === 'dynamic') {
      plan = await generateDynamicPlan(query as string, agentDefs, provider, model)
    } else {
      plan = createCoordinatorPlanFromUserQuery(query as string, agentDefs)
      if (strategy) {
        plan.strategy = strategy as 'parallel' | 'sequential' | 'hybrid'
      }
    }

    const result = await coordinator.execute(plan)

    res.json({
      success: true,
      synthesis: result.synthesis,
      totalUsage: result.totalUsage,
      totalDurationMs: result.totalDurationMs,
      tasks: result.tasks.map(t => ({
        id: t.id,
        phase: t.phase,
        status: t.status,
        description: t.description,
        result: t.result ? {
          content: t.result.content,
          turnCount: t.result.turnCount,
          durationMs: t.result.durationMs,
        } : undefined,
      })),
    })
  } catch (error) {
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
  const { query, strategy, maxConcurrency, model, providerName, dynamic } = req.body

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

    let plan: import('../agents/coordinator.js').CoordinatorPlan
    if (dynamic) {
      plan = await generateDynamicPlan(query, allAgentDefs, provider, resolvedModel)
    } else {
      plan = createCoordinatorPlanFromUserQuery(query, allAgentDefs)
    }
    if (strategy) plan.strategy = strategy

    const coordinator = new Coordinator({
      maxConcurrency: maxConcurrency ?? 3,
      defaultModel: resolvedModel,
      provider,
      tools: toolPool,
      agentDefinitions: allAgentDefs,
    })

    const result = await coordinator.execute(plan)

    res.json({
      plan: {
        id: result.plan.id,
        query: result.plan.query,
        strategy: result.plan.strategy,
        tasks: result.plan.tasks.map(t => ({
          id: t.id,
          description: t.description,
          phase: t.phase,
          agentType: t.agentType,
          dependsOn: t.dependsOn,
        })),
        createdAt: result.plan.createdAt,
        updatedAt: result.plan.updatedAt,
      },
      tasks: result.tasks.map(t => ({
        id: t.id,
        description: t.description,
        phase: t.phase,
        agentType: t.agentType,
        status: t.status,
        result: t.result ? {
          content: t.result.content,
          durationMs: t.result.durationMs,
          turnCount: t.result.turnCount,
          toolUseCount: t.result.toolUseCount,
        } : undefined,
        error: t.error,
      })),
      synthesis: result.synthesis,
      totalUsage: result.totalUsage,
      totalDurationMs: result.totalDurationMs,
    })
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error(`Coordinator execution failed: ${errMsg}`)
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
    const plan = await generateDynamicPlan(query, allAgentDefs, provider, resolvedModel)

    res.json({
      plan: {
        id: plan.id,
        query: plan.query,
        strategy: plan.strategy,
        tasks: plan.tasks.map(t => ({
          id: t.id,
          description: t.description,
          phase: t.phase,
          agentType: t.agentType,
          prompt: t.prompt,
          dependsOn: t.dependsOn,
        })),
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
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
  const { snapshotPath, maxConcurrency, model, providerName } = req.body

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

    const coordinator = new Coordinator({
      maxConcurrency: maxConcurrency ?? 3,
      defaultModel: resolvedModel,
      provider,
      tools: toolPool,
      agentDefinitions: allAgentDefs,
    })

    const result = await coordinator.resumeFromSnapshot(snapshotPath)

    res.json({
      plan: {
        id: result.plan.id,
        query: result.plan.query,
        strategy: result.plan.strategy,
        tasks: result.plan.tasks.map(t => ({
          id: t.id,
          description: t.description,
          phase: t.phase,
          agentType: t.agentType,
          dependsOn: t.dependsOn,
        })),
      },
      tasks: result.tasks.map(t => ({
        id: t.id,
        description: t.description,
        phase: t.phase,
        agentType: t.agentType,
        status: t.status,
        result: t.result ? {
          content: t.result.content,
          durationMs: t.result.durationMs,
          turnCount: t.result.turnCount,
          toolUseCount: t.result.toolUseCount,
        } : undefined,
        error: t.error,
      })),
      synthesis: result.synthesis,
      totalUsage: result.totalUsage,
      totalDurationMs: result.totalDurationMs,
    })
  } catch (error) {
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

  const validEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'TaskCompleted', 'SessionEnd']
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

  const validEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'TaskCompleted', 'SessionEnd']
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

const comfyUIConfigStore = new ComfyUIConfigStore()

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

export async function handleComfyUIChatStream(req: Request, res: Response): Promise<void> {
  const { message, workflow, session_id, error_log, language, config_id, workflow_context_text } = req.body as Record<string, unknown>
  const sessionId = session_id as string
  const userMessage = message as string
  const errorLog = error_log as string | undefined
  const lang = (language as string) ?? 'en'
  const configId = config_id as string | undefined
  const workflowContextText = workflow_context_text as string | undefined

  try {
    const config = configId ? comfyUIConfigStore.getConfigById(configId) : comfyUIConfigStore.getDefaultConfig()

    if (!config) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.write(formatSSE({ type: 'error', data: 'No provider configuration found. Please configure a provider in settings.' }))
      res.write(formatSSE({ type: 'done', data: null }))
      res.end()
      return
    }

    await ensureSgaProvider(config)
    const providerName = `comfyui-${config.id}`
    const model = config.default_model ?? 'sonnet'

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

    let contextParts: string[] = []
    if (workflow) {
      const workflowStr = typeof workflow === 'string' ? workflow : JSON.stringify(workflow)
      contextParts.push(`[FULL WORKFLOW JSON]\n${workflowStr}`)
    }
    if (workflowContextText) {
      contextParts.push(`[WORKFLOW PANEL CONTEXT (from ComfyUI RightSidePanel data sources)]\n${workflowContextText}`)
    }
    if (errorLog) {
      contextParts.push(`[RUNTIME ERRORS]\nThe user encountered the following errors during execution:\n${errorLog}`)
    }
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
    contextInjector.injectWorkflowSummary(session.messages)

    await handleStreamResponse(req, res, session, {
      content: fullContent,
      stream: true,
      agentType: 'comfyui-workflow',
      providerName,
      model,
    })
  } catch (error) {
    logger.error(`Chat stream error: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    }
    try {
      res.write(formatSSE({ type: 'error', data: error instanceof Error ? error.message : String(error) }))
      res.write(formatSSE({ type: 'done', data: null }))
    } catch {
      // connection closed
    }
    res.end()
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
        }
      } else if (m.role === 'assistant') {
        text = text
          .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
          .replace(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
          .trim()
      }
      return {
        sender: m.role === 'user' ? 'user' : 'ai',
        text,
        timestamp: m.timestamp,
        metadata: m.role === 'assistant' ? { provider: 'sga' } : undefined,
      }
    })

  res.json(history)
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
  const configs = comfyUIConfigStore.getConfigs()
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

    const config = comfyUIConfigStore.createConfig({
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
  const config = comfyUIConfigStore.getConfigById(configId)
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

    const config = comfyUIConfigStore.updateConfig(configId, updates)
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
  const success = comfyUIConfigStore.deleteConfig(configId)
  res.json({ success, message: success ? 'Config deleted successfully' : 'Config not found' })
}

export function handleComfyUISetDefaultConfig(req: Request, res: Response): void {
  const { config_id } = req.body as Record<string, unknown>
  const config = comfyUIConfigStore.setDefaultConfig(config_id as string)
  if (!config) {
    res.status(404).json({ error: 'Config not found' })
    return
  }
  res.json(toFrontendConfig(config))
}

export function handleComfyUIGetGitHubToken(_req: Request, res: Response): void {
  const hasToken = comfyUIConfigStore.hasGitHubToken()
  res.json({ has_token: hasToken })
}

export function handleComfyUIUpdateGitHubToken(req: Request, res: Response): void {
  const { token } = req.body as Record<string, unknown>
  comfyUIConfigStore.updateGitHubToken(token as string)
  res.json({ success: true, message: 'GitHub token updated successfully', has_token: true })
}

export function handleComfyUIDeleteGitHubToken(_req: Request, res: Response): void {
  comfyUIConfigStore.deleteGitHubToken()
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
