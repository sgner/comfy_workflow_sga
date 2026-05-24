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
import type { Message, UsageMetrics } from '../core/types.js'
import { ComfyUIConfigStore, type ComfyUIProviderConfig, type ComfyUIModelConfig } from './comfyui-config-store.js'
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

function extractBalancedJsonArray(text: string, startIndex: number): string | null {
  if (text[startIndex] !== '[') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) return text.slice(startIndex, i + 1) }
  }
  return null
}

function findJsonArrayAfterMarker(text: string, marker: string): string | null {
  const markerIdx = text.indexOf(marker)
  if (markerIdx === -1) return null
  const afterMarker = text.slice(markerIdx + marker.length)
  const skipMatch = afterMarker.match(/^\s*(?:```(?:json)?\s*)?/)
  const arrayStart = skipMatch ? skipMatch[0].length : 0
  if (afterMarker[arrayStart] !== '[') return null
  return extractBalancedJsonArray(afterMarker, arrayStart)
}

function removeMarkerAndJson(text: string, marker: string): string {
  const jsonStr = findJsonArrayAfterMarker(text, marker)
  if (!jsonStr) return text
  const markerIdx = text.indexOf(marker)
  const afterMarker = text.slice(markerIdx + marker.length)
  const jsonStartInAfter = afterMarker.indexOf(jsonStr)
  const endIdx = markerIdx + marker.length + jsonStartInAfter + jsonStr.length
  return text.slice(0, markerIdx) + text.slice(endIdx)
}

function parseStructuredResponse(text: string): {
  cleanText: string
  updatedWorkflow: Record<string, unknown> | null
  issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>
  relatedQuestions: string[]
} {
  let updatedWorkflow: Record<string, unknown> | null = null
  const allJsonMatches = text.matchAll(/```json\s*([\s\S]*?)\s*```/g)
  for (const jsonMatch of allJsonMatches) {
    if (jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1])
        if (parsed && parsed.nodes && parsed.links && !Array.isArray(parsed)) {
          updatedWorkflow = parsed
          break
        }
      } catch { /* ignore */ }
    }
  }

  let issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }> = []
  const issuesJsonStr = findJsonArrayAfterMarker(text, 'ISSUES_JSON:')
  if (issuesJsonStr) {
    try {
      const parsed = JSON.parse(issuesJsonStr)
      if (Array.isArray(parsed)) {
        issues = parsed.map((issue: Record<string, unknown>, idx: number) => ({
          nodeId: (issue.nodeId as string) ?? (issue.node_id as string) ?? null,
          severity: (issue.severity as string) ?? 'warning',
          message: (issue.message as string) ?? (issue.issue as string) ?? (issue.details as string) ?? 'Unknown issue',
          fixSuggestion: (issue.fixSuggestion as string) ?? (issue.fix_suggestion as string) ?? (issue.recommendation as string) ?? undefined,
        }))
      }
    } catch { /* ignore */ }
  }

  let relatedQuestions: string[] = []
  const relatedJsonStr = findJsonArrayAfterMarker(text, 'RELATED_QUESTIONS:')
  if (relatedJsonStr) {
    try {
      relatedQuestions = JSON.parse(relatedJsonStr)
    } catch { /* ignore */ }
  }

  let cleanText = text
  if (updatedWorkflow) {
    cleanText = cleanText.replace(/```json\s*[\s\S]*?\s*```/, '[Workflow updated]')
  }
  cleanText = removeMarkerAndJson(cleanText, 'ISSUES_JSON:')
  cleanText = removeMarkerAndJson(cleanText, 'RELATED_QUESTIONS:')
  cleanText = cleanText
    .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
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

const TOOL_LABELS: Record<string, string> = {
  github_search: '搜索 GitHub 和知识库',
  workflow_analyzer: '分析工作流结构',
  workflow_action: '执行工作流操作',
  ask_user: '等待用户输入',
}

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || `调用工具: ${toolName}`
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
  const { message, workflow, session_id, error_log, language, config_id, workflow_context, workflow_context_text } = req.body as Record<string, unknown>
  const sessionId = session_id as string
  const userMessage = message as string
  const errorLog = error_log as string | undefined
  const lang = (language as string) ?? 'en'
  const configId = config_id as string | undefined
  const workflowContextText = workflow_context_text as string | undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const sendEvent = (eventType: string, data: Record<string, unknown>) => {
    try {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      // connection closed
    }
  }

  try {
    const config = configId ? configStore.getConfigById(configId) : configStore.getDefaultConfig()

    if (!config) {
      sendEvent('content', { chunk: 'Error: No provider configuration found. Please configure a provider in settings.', metadata: { node: 'generate_response' } })
      sendEvent('end', { chunk: '', is_complete: true })
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

    if (workflowContextText) {
      workflowContext += `\n[WORKFLOW PANEL CONTEXT (from ComfyUI RightSidePanel data sources)]\n${workflowContextText}\n`
    }

    const fullPrompt = `${workflowContext}\n[USER REQUEST]\n"${userMessage}"\n\n[INSTRUCTIONS]\n- If the user wants to change the workflow, output the NEW JSON in a \`\`\`json block.\n- If the user asks to DIAGNOSE, ANALYZE, or CHECK the workflow, output the issues in \`ISSUES_JSON: [...] \`.\n- If the user asks to EXPLAIN, provide a detailed summary of the logic and data flow.\n- Use the WORKFLOW PANEL CONTEXT to understand current errors, node parameters, and settings when diagnosing issues.\n- Provide 3 Related Questions in the format \`RELATED_QUESTIONS: ["Q1", "Q2"]\`. These must be questions the USER would ask the agent, NOT questions the agent asks the user. Do NOT phrase them as offers or suggestions from the agent (e.g. avoid "Do you want me to..."); instead phrase them as what the user might want to know or request next.\n${languageInstruction}`

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

    const provider = await ensureSgaProvider(config)
    const model = config.default_model ?? provider.config.defaultModel ?? 'sonnet'
    const modelConfig = provider.getModelConfig(model)
    const useStream = modelConfig?.supportsStreaming !== false
    const tools = buildToolPool()
    const agentDefs = getBuiltinAgentDefinitions()
    const agentDef = agentDefs.find(a => a.name === 'comfyui-workflow') ?? agentDefs[0]

    if (!agentDef) {
      sendEvent('error', { chunk: 'Error: No agent definition available', is_complete: true })
      sendEvent('end', { chunk: '', is_complete: true })
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

    sendEvent('agent_start', { sessionId, model })

    let hasStartedGenerating = false
    let toolHeartbeat: ReturnType<typeof setInterval> | null = null
    const result = await runAgent({
      agentDefinition: agentDef,
      prompt: '',
      messages: session.messages,
      tools,
      model,
      provider,
      stream: useStream,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      onProgress: async (event: unknown) => {
        const e = event as { type: string; text?: string; toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown>; toolCallId?: string; message?: string; suggestions?: string[]; context?: string; options?: Array<{ label: string; value: string; description?: string }>; usage?: UsageMetrics }
        switch (e.type) {
          case 'thinking_delta':
            if (e.text) {
              sendEvent('thinking', { text: e.text })
            }
            break
          case 'stream_delta':
            if (e.text) {
              if (!hasStartedGenerating) {
                hasStartedGenerating = true
                sendEvent('status_update', {
                  metadata: { node: 'generating', display_text: '正在生成回复...', status: 'processing' },
                })
              }
              sendEvent('content', { chunk: e.text })
            }
            break
          case 'tool_use_start':
            hasStartedGenerating = false
            if (toolHeartbeat) clearInterval(toolHeartbeat)
            toolHeartbeat = setInterval(() => {
              sendEvent('heartbeat', { timestamp: Date.now() })
            }, 15000)
            sendEvent('tool_use_start', {
              data: { toolName: e.toolName, toolUseId: e.toolUseId, toolInput: e.toolInput },
            })
            sendEvent('status_update', {
              metadata: { node: `tool_${e.toolName}`, display_text: getToolLabel(e.toolName ?? 'unknown'), status: 'processing' },
            })
            break
          case 'tool_use_result':
            if (toolHeartbeat) {
              clearInterval(toolHeartbeat)
              toolHeartbeat = null
            }
            sendEvent('tool_use_result', {
              data: { toolName: e.toolName, toolUseId: e.toolUseId },
            })
            break
          case 'tool_use_input_complete':
            sendEvent('tool_use_input_complete', {
              data: { toolName: e.toolName, toolUseId: e.toolUseId, toolInput: e.toolInput },
            })
            break
          case 'turn_end':
            if (e.usage) {
              store.appendUsage(session.id, e.usage)
              sendEvent('usage', { usage: session.usage })
            }
            break
        }
      },
      requestApproval: async (event) => {
        const approvalReq = createApprovalRequest({
          toolName: event.toolName,
          toolInput: event.toolInput,
          message: event.message,
          sessionId,
          suggestions: event.suggestions,
          isDestructive: true,
          isReadOnly: false,
        })

        sendEvent('approval_required', {
          data: approvalReq,
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

        const heartbeat = setInterval(() => {
          sendEvent('heartbeat', { timestamp: Date.now() })
        }, 15000)

        try {
          const userResponse = await new Promise<UserApprovalResponse>((resolve, reject) => {
            pendingResolvers.set(approvalReq.id, { resolve: resolve as (resp: unknown) => void, reject })
          })
          clearInterval(heartbeat)
          clearSessionWaitingInput(session!)
          pendingResolvers.delete(approvalReq.id)

          return userResponse.decision === 'allow'
            ? { decision: 'allow' as const, updatedInput: userResponse.updatedInput }
            : { decision: 'deny' as const, reason: userResponse.reason ?? 'User denied' }
        } catch {
          clearInterval(heartbeat)
          clearSessionWaitingInput(session!)
          pendingResolvers.delete(approvalReq.id)
          return { decision: 'deny' as const, reason: 'Approval request cancelled' }
        }
      },
      requestHumanInput: async (event) => {
        const inputReq = createHumanInputRequest({
          message: event.message,
          sessionId,
          context: event.context,
          options: event.options,
          allowFreeText: true,
        })

        sendEvent('human_input_required', {
          data: inputReq,
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

        const inputHeartbeat = setInterval(() => {
          sendEvent('heartbeat', { timestamp: Date.now() })
        }, 15000)

        try {
          const userInput = await new Promise<UserInputResponse>((resolve, reject) => {
            pendingResolvers.set(inputReq.id, { resolve: resolve as (resp: unknown) => void, reject })
          })
          clearInterval(inputHeartbeat)
          clearSessionWaitingInput(session!)
          pendingResolvers.delete(inputReq.id)
          return userInput.value
        } catch {
          clearInterval(inputHeartbeat)
          clearSessionWaitingInput(session!)
          pendingResolvers.delete(inputReq.id)
          return ''
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

    sendEvent('usage', { usage: session.usage })

    triggerMemoryExtraction(session.messages, provider, model)

    const structured = parseStructuredResponse(result.content)
    sendEvent('result', {
      data: {
        chatResponse: structured.cleanText,
        updatedWorkflow: structured.updatedWorkflow,
        issues: structured.issues,
        relatedQuestions: structured.relatedQuestions,
        missingNodes: [],
        groundingSources: [],
      },
    })

    sendEvent('end', { chunk: '', is_complete: true })
  } catch (error) {
    logger.error(`Chat stream error: ${error instanceof Error ? error.message : String(error)}`)
    sendEvent('error', {
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
    model_configs: config.model_configs,
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
    if (body.model_configs !== undefined) updates.model_configs = body.model_configs as Record<string, ComfyUIModelConfig> | undefined

    console.log('[DEBUG] handleComfyUIUpdateConfig - body.model_configs:', JSON.stringify(body.model_configs))
    console.log('[DEBUG] handleComfyUIUpdateConfig - updates.model_configs:', JSON.stringify(updates.model_configs))

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
