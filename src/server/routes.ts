import type { Request, Response } from 'express'
import type { Session, CreateSessionRequest, SendMessageRequest, SendMessageResponse, StreamEventPayload, UserInputRequest } from './session.js'
import { createSession, addMessageToSession, updateSessionUsage, setSessionWaitingInput, clearSessionWaitingInput } from './session.js'
import type { Message } from '../core/types.js'
import type { PendingAction, UserApprovalResponse, UserInputResponse, SuspendedContext } from './interaction.js'
import { createLogger } from '../utils/logger.js'
import { getSessionStore } from './session-store.js'
import { getMemoryManager } from '../memory/manager.js'
import { MemoryExtractor } from '../memory/extractor.js'

const logger = createLogger('routes')
import { createApprovalRequest } from './interaction.js'
import { createBuiltinTools } from '../tools/built-in/index.js'
import { getBuiltinAgentDefinitions, getAgentDefinitionByName, runAgent } from '../agents/index.js'
import { CostTracker } from '../utils/cost-tracker.js'
import { resolveProvider, getAllProviders, getDefaultProviderName, getDefaultProvider, addProvider, removeProvider, setDefaultProvider, getProviderConfig, getAllProviderNames, getProvider } from '../providers/provider-store.js'
import { getRegisteredProviders, getProviderDefaults } from '../providers/registry.js'
import type { LLMProvider, StoredProviderConfig, ModelConfig } from '../providers/index.js'
import type { PermissionResult } from '../tools/base.js'

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

  logger.info(`Session ${sessionId}: received message, content length=${body.content.length}, stream=${body.stream ?? false}`)

  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: body.content }],
    timestamp: Date.now(),
  }
  store.appendMessage(session.id, userMessage)

  if (body.stream) {
    handleStreamResponse(req, res, session, body)
    return
  }

  try {
    const provider = getProviderForSession(session, body.providerName)
    const model = body.model ?? session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    logger.info(`Session ${sessionId}: using provider=${provider.name}, model=${model}`)

    const tools = createBuiltinTools()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

    if (!agentDef) {
      res.status(500).json({ error: 'No agent definition available' })
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

  const sendEvent = (event: StreamEventPayload) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      // connection closed
    }
  }

  try {
    const provider = getProviderForSession(session, body.providerName)
    const model = body.model ?? session.config.model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = createBuiltinTools()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = body.agentType
      ? getAgentDefinitionByName(body.agentType, agentDefs)
      : agentDefs[0]

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

    const result = await runAgent({
      agentDefinition: agentDef,
      prompt: body.content,
      messages: session.messages,
      tools,
      model,
      provider,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      onProgress: async (event: unknown) => {
        const e = event as { type: string; text?: string; toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown>; toolCallId?: string; message?: string; suggestions?: string[]; reason?: unknown }
        switch (e.type) {
          case 'stream_delta':
            sendEvent({ type: 'text_delta', data: e.text ?? '' })
            break
          case 'tool_use_start':
            sendEvent({ type: 'tool_use_start', data: { toolName: e.toolName, toolUseId: e.toolUseId } })
            break
          case 'tool_use_result':
            sendEvent({ type: 'tool_use_result', data: e })
            break
          case 'turn_end':
            sendEvent({ type: 'turn_end', data: e })
            break
          case 'approval_required': {
            const approvalReq = createApprovalRequest({
              toolName: e.toolName ?? 'unknown',
              toolInput: e.toolInput ?? {},
              message: e.message ?? `Tool "${e.toolName}" requires approval.`,
              sessionId: session.id,
              suggestions: e.suggestions,
              isDestructive: true,
              isReadOnly: false,
            })

            sendEvent({
              type: 'approval_required',
              data: approvalReq,
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

              const permissionResult: PermissionResult = userResponse.decision === 'allow'
                ? { behavior: 'allow', updatedInput: userResponse.updatedInput }
                : { behavior: 'deny', message: userResponse.reason ?? 'User denied' }

              return permissionResult
            } catch (error) {
              clearSessionWaitingInput(session)
              return { behavior: 'deny', message: 'Approval request cancelled' } as PermissionResult
            } finally {
              approvalPromiseMap.delete(approvalReq.id)
              pendingResolvers.delete(approvalReq.id)
            }
          }
        }
      },
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
    sendEvent({ type: 'error', data: session.error })
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

export function handleListAgents(_req: Request, res: Response): void {
  const agents = getBuiltinAgentDefinitions().map(a => ({
    name: a.name,
    description: a.description,
    subagentType: a.subagentType,
    isBackground: a.isBackground(),
    isProactive: a.isProactive(),
  }))
  res.json({ agents })
}

export function handleListTools(_req: Request, res: Response): void {
  const tools = createBuiltinTools().map(t => ({
    name: t.name,
    description: t.description,
    definition: t.getDefinition(),
  }))
  res.json({ tools })
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
  const config: StoredProviderConfig = req.body

  const { validateProviderConfig } = await import('../providers/provider-store.js')
  const validation = validateProviderConfig(config)

  if (!validation.valid) {
    res.status(400).json({
      error: `Provider "${config.name ?? ''}" does not meet minimum configuration requirements`,
      errors: validation.errors,
      warnings: validation.warnings,
    })
    return
  }

  const setAsDefault = req.body.setAsDefault === true
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
