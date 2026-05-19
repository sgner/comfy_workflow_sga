import type { Request, Response } from 'express'
import { createLogger } from '../utils/logger.js'
import { getSessionStore } from './session-store.js'
import { createSession } from './session.js'
import { createBuiltinTools } from '../tools/built-in/index.js'
import { assembleToolPool } from '../tools/registry.js'
import { getConnectedMCPClients } from '../mcp/index.js'
import { createAllMCPToolAdapters } from '../mcp/adapter.js'
import { getBuiltinAgentDefinitions, runAgent } from '../agents/index.js'
import { resolveProvider, addProvider, removeProvider, getAllProviderNames } from '../providers/provider-store.js'
import type { LLMProvider, StoredProviderConfig } from '../providers/index.js'
import type { Message } from '../core/types.js'
import { ComfyUIConfigStore, type ComfyUIProviderConfig } from './comfyui-config-store.js'
import { undoLastAction } from '../tools/built-in/workflow-action.js'
import { getMemoryManager } from '../memory/manager.js'
import { MemoryExtractor } from '../memory/extractor.js'
import { getWorkingSet, initWorkingSet } from '../memory/working-set-registry.js'
import { createApprovalRequest, createHumanInputRequest, type PendingAction, type UserApprovalResponse, type UserInputResponse, type SuspendedContext } from './interaction.js'
import { setSessionWaitingInput, clearSessionWaitingInput } from './session.js'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })

const logger = createLogger('comfyui-routes')

const configStore = new ComfyUIConfigStore()

const pendingResolvers: Map<string, {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
}> = new Map()

const workflowCache: Map<string, { hash: string; summary: string; fullJson: string }> = new Map()

function parseStructuredResponse(text: string): {
  cleanText: string
  updatedWorkflow: Record<string, unknown> | null
  issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>
  relatedQuestions: string[]
} {
  let updatedWorkflow: Record<string, unknown> | null = null
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
  if (jsonMatch?.[1]) {
    try {
      updatedWorkflow = JSON.parse(jsonMatch[1])
    } catch { /* ignore */ }
  }

  let issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }> = []
  const issuesMatch = text.match(/ISSUES_JSON:\s*(?:```(?:json)?\s*)?(\[[\s\S]*?\])(?:\s*```)?/)
  if (issuesMatch?.[1]) {
    try {
      const parsed = JSON.parse(issuesMatch[1])
      if (Array.isArray(parsed)) {
        issues = parsed.map((issue: Record<string, unknown>, idx: number) => ({
          nodeId: (issue.nodeId as string) ?? (issue.node_id as string) ?? null,
          severity: (issue.severity as string) ?? 'warning',
          message: (issue.message as string) ?? (issue.issue as string) ?? (issue.details as string) ?? 'Unknown issue',
          fixSuggestion: (issue.fixSuggestion as string) ?? (issue.fix_suggestion as string) ?? undefined,
        }))
      }
    } catch { /* ignore */ }
  }

  let relatedQuestions: string[] = []
  const relatedMatch = text.match(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?(\[[\s\S]*?\])(?:\s*```)?/)
  if (relatedMatch?.[1]) {
    try {
      relatedQuestions = JSON.parse(relatedMatch[1])
    } catch { /* ignore */ }
  }

  const cleanText = text
    .replace(/```json\s*[\s\S]*?\s*```/, '[Workflow updated]')
    .replace(/ISSUES_JSON:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
    .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
    .replace(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
    .trim()

  return { cleanText, updatedWorkflow, issues, relatedQuestions }
}

function computeWorkflowHash(workflowStr: string): string {
  let hash = 0
  for (let i = 0; i < workflowStr.length; i++) {
    const char = workflowStr.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36)
}

function buildWorkflowSummary(nodes: Array<Record<string, unknown>>): string {
  const typeCount: Record<string, number> = {}
  const nodeLinks: string[] = []

  for (const n of nodes) {
    const type = (n.type as string) ?? 'Unknown'
    typeCount[type] = (typeCount[type] ?? 0) + 1

    const inputs = n.inputs as Array<Record<string, unknown>> | undefined
    if (inputs) {
      for (const input of inputs) {
        if (input.link != null) {
          nodeLinks.push(`${n.id}<-${input.link}`)
        }
      }
    }
  }

  const summaryParts: string[] = []
  for (const [type, count] of Object.entries(typeCount)) {
    summaryParts.push(count > 1 ? `${type}×${count}` : type)
  }

  return `Nodes: ${nodes.length} | Types: ${summaryParts.join(', ')} | Links: ${nodeLinks.length}`
}

const NODE_DESCRIPTIONS: Record<string, string> = {
  classify_request: '正在分析您的意图...',
  search_solutions: '正在检索知识库和 GitHub...',
  analyze_workflow: '正在深入分析 ComfyUI 工作流结构...',
  prepare_action: '正在规划修复方案...',
  execute_action: '正在执行修复指令...',
  generate_response: '正在整理最终回复...',
}

function buildToolPool() {
  const builtinTools = createBuiltinTools()
  const mcpClients = getConnectedMCPClients()
  const mcpToolAdapters = createAllMCPToolAdapters(mcpClients)
  return assembleToolPool(builtinTools, mcpToolAdapters)
}

async function ensureSgaProvider(config: ComfyUIProviderConfig): Promise<LLMProvider> {
  const providerName = `comfyui-${config.id}`
  const existingNames = getAllProviderNames()

  if (existingNames.includes(providerName)) {
    removeProvider(providerName)
  }

  let extension: import('../providers/types.js').ProviderExtension | undefined
  let effectiveBaseUrl = config.base_url

  if (config.provider === 'custom' && config.custom_config) {
    const customConfig = config.custom_config
    const endpoint = (customConfig.endpoint as string) || '/chat/completions'
    const headersTemplate = customConfig.headers as string | undefined
    const bodyTemplate = customConfig.body as string | undefined

    const endpointWithoutChatCompletions = endpoint.replace(/\/chat\/completions$/, '').replace(/\/$/, '')
    if (effectiveBaseUrl && endpointWithoutChatCompletions) {
      effectiveBaseUrl = effectiveBaseUrl.replace(/\/$/, '') + endpointWithoutChatCompletions
    }

    if (bodyTemplate || headersTemplate) {
      const requestTransformerSrc = `(body, headers) => {
  const result = { body: { ...body }, headers: { ...headers } };
  ${bodyTemplate ? `try { const tpl = ${JSON.stringify(bodyTemplate)}; const parsed = JSON.parse(tpl); const skipKeys = ['messages','tools','tool_choice','stream']; for (const [k,v] of Object.entries(parsed)) { if (skipKeys.includes(k)) continue; if (typeof v === 'string' && v.startsWith('$')) continue; result.body[k] = v; } } catch(e) {}` : ''}
  ${headersTemplate ? `try { const tpl = ${JSON.stringify(headersTemplate)}; const parsed = JSON.parse(tpl.replace(/\\$apiKey/g, result.headers['Authorization']?.replace('Bearer ', '') || '')); for (const [k,v] of Object.entries(parsed)) { if (typeof v === 'string' && v.startsWith('$')) continue; result.headers[k] = v; } } catch(e) {}` : ''}
  return result;
}`
      extension = {
        requestTransformer: requestTransformerSrc,
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
    headers: config.headers,
    extra: config.custom_config as Record<string, unknown> | undefined,
    extension,
  }

  await addProvider(storedConfig)
  return resolveProvider(providerName)
}

export async function handleComfyUIChatStream(req: Request, res: Response): Promise<void> {
  const { message, workflow, session_id, error_log, language, config_id } = req.body as Record<string, unknown>
  const sessionId = session_id as string
  const userMessage = message as string
  const errorLog = error_log as string | undefined
  const lang = (language as string) ?? 'en'
  const configId = config_id as string | undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const sendEvent = (data: Record<string, unknown>) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch {
      // connection closed
    }
  }

  try {
    const config = configId ? configStore.getConfigById(configId) : configStore.getDefaultConfig()

    if (!config) {
      sendEvent({ chunk: 'Error: No provider configuration found. Please configure a provider in settings.', type: 'content', metadata: { node: 'generate_response' } })
      sendEvent({ chunk: '', is_complete: true, type: 'end' })
      res.end()
      return
    }

    const languageInstruction = `\nIMPORTANT: You MUST respond in the following language code: "${lang}". Translate your advice and interface text accordingly.`

    const memoryManager = getMemoryManager()
    if (memoryManager) {
      memoryManager.setSessionId(sessionId)
    }

    let ws = getWorkingSet()
    if (!ws) {
      ws = initWorkingSet()
    }

    let workflowContext = ''
    let shouldPinFullWorkflow = false
    if (workflow) {
      const workflowStr = typeof workflow === 'string' ? workflow : JSON.stringify(workflow)
      const workflowObj = workflow as Record<string, unknown> | undefined
      const nodes = (workflowObj?.nodes ?? []) as Array<Record<string, unknown>>
      const nodesSummary = nodes.map(n => {
        const props = n.properties as Record<string, unknown> | undefined
        return { id: n.id, type: n.type, title: props?.['Node name for S&R'] }
      })
      const currentHash = computeWorkflowHash(workflowStr)
      const cached = workflowCache.get(sessionId)
      const workflowChanged = !cached || cached.hash !== currentHash

      if (workflowChanged) {
        workflowCache.set(sessionId, {
          hash: currentHash,
          summary: buildWorkflowSummary(nodes),
          fullJson: workflowStr,
        })
        shouldPinFullWorkflow = true
      }

      if (workflowChanged) {
        workflowContext = `
[CURRENT WORKFLOW STATE]
Node Count: ${nodes.length}
Nodes Summary: ${JSON.stringify(nodesSummary)}

[FULL WORKFLOW JSON]
${workflowStr}
`
      } else {
        workflowContext = `
[CURRENT WORKFLOW STATE] (unchanged since last message)
Node Count: ${nodes.length}
Summary: ${cached?.summary ?? buildWorkflowSummary(nodes)}
Nodes Summary: ${JSON.stringify(nodesSummary)}
[Workflow JSON is available in context - no changes detected]
`
      }
    }

    if (errorLog) {
      workflowContext += `\n[RUNTIME ERRORS]\nThe user encountered the following errors during execution:\n${errorLog}\n`
    }

    const fullPrompt = `${workflowContext}\n[USER REQUEST]\n"${userMessage}"\n\n[INSTRUCTIONS]\n- If the user wants to change the workflow, output the NEW JSON in a \`\`\`json block.\n- If the user asks to DIAGNOSE, ANALYZE, or CHECK the workflow, output the issues in \`ISSUES_JSON: [...] \`.\n- If the user asks to EXPLAIN, provide a detailed summary of the logic and data flow.\n- Provide 3 Related Questions in the format \`RELATED_QUESTIONS: ["Q1", "Q2"]\`.\n${languageInstruction}`

    if (shouldPinFullWorkflow && workflow) {
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
    }

    sendEvent({
      chunk: '',
      type: 'status_update',
      metadata: { node: 'classify_request', display_text: NODE_DESCRIPTIONS.classify_request, status: 'processing' },
    })

    const provider = await ensureSgaProvider(config)
    const model = config.default_model ?? provider.config.defaultModel ?? 'sonnet'
    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = agentDefs.find(a => a.name === 'comfyui-workflow') ?? agentDefs[0]

    if (!agentDef) {
      sendEvent({ chunk: 'Error: No agent definition available', type: 'content', metadata: { node: 'generate_response' } })
      sendEvent({ chunk: '', is_complete: true, type: 'end' })
      res.end()
      return
    }

    const store = getSessionStore()
    let session = store.get(sessionId)
    if (!session) {
      session = createSession({
        model,
        providerName: `comfyui-${config.id}`,
        systemPrompt: undefined,
        agentType: 'comfyui-workflow',
      })
      session.id = sessionId
      store.set(session)
    }

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: fullPrompt }],
      timestamp: Date.now(),
    }
    store.appendMessage(session.id, userMsg)

    sendEvent({
      chunk: '',
      type: 'status_update',
      metadata: { node: 'analyze_workflow', display_text: NODE_DESCRIPTIONS.analyze_workflow, status: 'processing' },
    })

    const result = await runAgent({
      agentDefinition: agentDef,
      prompt: '',
      messages: session.messages,
      tools,
      model,
      provider,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      onProgress: async (event: unknown) => {
        const e = event as { type: string; text?: string; toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown>; toolCallId?: string; message?: string; suggestions?: string[]; context?: string; options?: Array<{ label: string; value: string; description?: string }> }
        switch (e.type) {
          case 'stream_delta':
            if (e.text) {
              sendEvent({ chunk: e.text, type: 'content', metadata: { node: 'generate_response' } })
            }
            break
          case 'tool_use_start':
            sendEvent({
              type: 'tool_use_start',
              data: { toolName: e.toolName, toolUseId: e.toolUseId },
            })
            if (e.toolName === 'github_search') {
              sendEvent({
                chunk: '',
                type: 'status_update',
                metadata: { node: 'search_solutions', display_text: NODE_DESCRIPTIONS.search_solutions, status: 'processing' },
              })
            } else if (e.toolName === 'workflow_analyzer') {
              sendEvent({
                chunk: '',
                type: 'status_update',
                metadata: { node: 'analyze_workflow', display_text: NODE_DESCRIPTIONS.analyze_workflow, status: 'processing' },
              })
            } else if (e.toolName === 'workflow_action') {
              sendEvent({
                chunk: '',
                type: 'status_update',
                metadata: { node: 'execute_action', display_text: NODE_DESCRIPTIONS.execute_action, status: 'processing' },
              })
            }
            break
          case 'tool_use_result':
            sendEvent({
              type: 'tool_use_result',
              data: { toolName: e.toolName },
            })
            if (e.toolName === 'github_search') {
              sendEvent({
                chunk: '',
                type: 'meta_update',
                metadata: { node: 'search_solutions', step_data: { search_previews: ['GitHub search completed'] } },
              })
            }
            break
          case 'approval_required': {
            const approvalReq = createApprovalRequest({
              toolName: e.toolName ?? 'unknown',
              toolInput: e.toolInput ?? {},
              message: e.message ?? `Tool "${e.toolName}" requires approval.`,
              sessionId,
              suggestions: e.suggestions,
              isDestructive: true,
              isReadOnly: false,
            })

            sendEvent({
              type: 'approval_required',
              data: approvalReq,
            })

            const approvalPromise = new Promise<UserApprovalResponse>((resolve, reject) => {
              pendingResolvers.set(approvalReq.id, { resolve: resolve as (resp: unknown) => void, reject })
            })

            setSessionWaitingInput(session!, {
              type: 'approval',
              request: approvalReq,
              resolve: (resp: unknown) => {
                pendingResolvers.get(approvalReq.id)?.resolve(resp as UserApprovalResponse)
              },
              reject: (error: Error) => {
                pendingResolvers.get(approvalReq.id)?.reject(error)
              },
            } as PendingAction, {
              actionId: approvalReq.id,
              sessionId,
              messages: session!.messages,
              toolCalls: [],
              pendingToolCallIndex: 0,
              turnCount: 0,
              usage: session!.usage,
              model: model,
              systemPromptContent: '',
            } as SuspendedContext)

            try {
              const userResponse = await approvalPromise
              clearSessionWaitingInput(session!)
              pendingResolvers.delete(approvalReq.id)

              const permissionResult = userResponse.decision === 'allow'
                ? { behavior: 'allow' as const, updatedInput: userResponse.updatedInput }
                : { behavior: 'deny' as const, message: userResponse.reason ?? 'User denied' }

              return permissionResult
            } catch {
              clearSessionWaitingInput(session!)
              pendingResolvers.delete(approvalReq.id)
              return { behavior: 'deny' as const, message: 'Approval request cancelled' }
            }
          }
          case 'human_input_required': {
            const inputReq = createHumanInputRequest({
              message: e.message ?? 'Input required',
              sessionId,
              context: e.context,
              options: e.options,
              allowFreeText: true,
            })

            sendEvent({
              type: 'human_input_required',
              data: inputReq,
            })

            const inputPromise = new Promise<UserInputResponse>((resolve, reject) => {
              pendingResolvers.set(inputReq.id, { resolve: resolve as (resp: unknown) => void, reject })
            })

            setSessionWaitingInput(session!, {
              type: 'human_input',
              request: inputReq,
              resolve: (resp: unknown) => {
                pendingResolvers.get(inputReq.id)?.resolve(resp as UserInputResponse)
              },
              reject: (error: Error) => {
                pendingResolvers.get(inputReq.id)?.reject(error)
              },
            } as PendingAction, {
              actionId: inputReq.id,
              sessionId,
              messages: session!.messages,
              toolCalls: [],
              pendingToolCallIndex: 0,
              turnCount: 0,
              usage: session!.usage,
              model: model,
              systemPromptContent: '',
            } as SuspendedContext)

            try {
              const userInput = await inputPromise
              clearSessionWaitingInput(session!)
              pendingResolvers.delete(inputReq.id)
              return userInput.value
            } catch {
              clearSessionWaitingInput(session!)
              pendingResolvers.delete(inputReq.id)
              return ''
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
    store.appendMessage(session.id, assistantMessage)
    store.appendUsage(session.id, result.usage)

    triggerMemoryExtraction(session.messages, provider, model)

    const structured = parseStructuredResponse(result.content)
    sendEvent({
      type: 'result',
      data: {
        chatResponse: structured.cleanText,
        updatedWorkflow: structured.updatedWorkflow,
        issues: structured.issues,
        relatedQuestions: structured.relatedQuestions,
        missingNodes: [],
        groundingSources: [],
      },
    })

    sendEvent({ chunk: '', is_complete: true, type: 'end' })
  } catch (error) {
    logger.error(`Chat stream error: ${error instanceof Error ? error.message : String(error)}`)
    sendEvent({
      chunk: `Error: ${error instanceof Error ? error.message : String(error)}`,
      is_complete: true,
      metadata: { error: true },
    })
  }

  res.end()
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
    extension: config.provider === 'custom' && config.custom_config
      ? { providerModule: undefined }
      : undefined,
    has_api_key: !!config.api_key,
    created_at: new Date(config.created_at * 1000).toISOString(),
  }
}

export function handleComfyUIListConfigs(_req: Request, res: Response): void {
  const configs = configStore.getConfigs()
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

    const config = configStore.createConfig({
      provider,
      name: body.name as string,
      api_key: body.api_key as string,
      default_model: body.default_model as string,
      base_url: body.base_url as string | undefined,
      is_default: (body.is_default as boolean) ?? false,
      default_max_tokens: body.default_max_tokens as number | undefined,
      default_temperature: body.default_temperature as number | undefined,
      retries: body.retries as number | undefined,
      retry_delay: body.retry_delay as number | undefined,
      headers: body.headers as Record<string, string> | undefined,
      custom_config,
    })

    res.json(toFrontendConfig(config))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleComfyUIGetConfig(req: Request, res: Response): void {
  const configId = req.params.configId as string
  const config = configStore.getConfigById(configId)
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

    const config = configStore.updateConfig(configId, updates)
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
  const success = configStore.deleteConfig(configId)
  res.json({ success, message: success ? 'Config deleted successfully' : 'Config not found' })
}

export function handleComfyUISetDefaultConfig(req: Request, res: Response): void {
  const { config_id } = req.body as Record<string, unknown>
  const config = configStore.setDefaultConfig(config_id as string)
  if (!config) {
    res.status(404).json({ error: 'Config not found' })
    return
  }
  res.json(toFrontendConfig(config))
}

export function handleComfyUIGetGitHubToken(_req: Request, res: Response): void {
  const hasToken = configStore.hasGitHubToken()
  res.json({ has_token: hasToken })
}

export function handleComfyUIUpdateGitHubToken(req: Request, res: Response): void {
  const { token } = req.body as Record<string, unknown>
  configStore.updateGitHubToken(token as string)
  res.json({ success: true, message: 'GitHub token updated successfully', has_token: true })
}

export function handleComfyUIDeleteGitHubToken(_req: Request, res: Response): void {
  configStore.deleteGitHubToken()
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
