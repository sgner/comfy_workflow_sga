/**
 * Codex-Provider 反代 (Responses API -> Chat Completions API)
 *
 * codex 0.138+ 只认 OpenAI Responses API (/v1/responses, wire_api="responses").
 * 但绝大多数三方供应商 (DeepSeek/GLM/Claude/...) 仍只支持 Chat Completions
 * API (/v1/chat/completions). 这里的反代在 SGA 本地起一个 HTTP server,
 * 把 codex 的 /v1/responses 请求实时转译成对供应商的 /v1/chat/completions,
 * 然后把流式响应再翻回 Responses API 的 SSE 事件序列, 让 codex 透明地使用
 * 任意兼容 OpenAI Chat Completions 协议的供应商.
 *
 * 当前覆盖:
 *   - 请求转译: input[] -> messages[] (支持 system / user / assistant / tool)
 *   - 响应转译: Chat Completions delta -> Responses API output_text.delta
 *   - usage 转译: prompt_tokens/completion_tokens -> input_tokens/output_tokens
 *   - 工具调用 (tool_calls) 转译: 函数名 + JSON 串 -> 单独的 output_item
 *   - 错误透传: 供应商 4xx/5xx -> codex 可读的 SSE error 事件
 *
 * 不支持 (后续可补):
 *   - Vision / 图片输入 (codex 是 coding agent, 不太需要)
 *   - 内置 tools (web_search / file_search), 因为我们不带 codex 的内置工具链
 *   - Structured Outputs (response_format)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createLogger } from '../../utils/logger.js'
import type { ProviderConfig } from '../../providers/types.js'

const logger = createLogger('codex-proxy')

/** 反代配置: 转发到哪个供应商, 用哪个 model */
export interface CodexProxyConfig {
  /** SGA 的 ProviderConfig (apiKey, baseUrl, headers, ...) */
  provider: ProviderConfig
  /**
   * 把 codex 发来的 model id 重写成供应商认识的 id.
   * e.g. codex 传 "gpt-5-codex", 我们要重写成 "deepseek-chat" 或 "gpt-4o".
   * 不设置就原样透传 (供应商 resolveModel 兜底).
   */
  modelMap?: (incomingModel: string) => string | undefined
  /** 监听 host, 默认 127.0.0.1 */
  host?: string
  /** 监听 port, 0 = 随机 */
  port?: number
}

export interface CodexProxyHandle {
  /** 反代地址, e.g. http://127.0.0.1:51234  (codex base_url 用这个) */
  baseUrl: string
  /** 关闭反代 */
  close(): Promise<void>
  /** 反代收到的总请求数 (诊断用) */
  stats(): { requests: number; streamsOpen: number; errors: number }
}

// -------- Responses API 请求/响应类型 (只列反代需要处理的字段) --------

interface ResponsesInputItem {
  type?: string
  role?: 'user' | 'assistant' | 'system' | 'developer'
  content?: string | Array<{ type: string; text?: string }>
  // tool call result (codex -> us): 用 function_call_output 类型
  call_id?: string
  output?: string | unknown
  // tool call request (codex -> us): 用 function_call 类型
  // 出现于 input[] 中, 反代必须翻译成 assistant message + tool_calls[]
  name?: string
  arguments?: string | Record<string, unknown>
}

interface ResponsesRequest {
  model?: string
  instructions?: string
  input?: ResponsesInputItem[]
  stream?: boolean
  tools?: Array<{
    type: 'function'
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
  // 透传: temperature, top_p, max_output_tokens, reasoning, etc.
  [key: string]: unknown
}

// -------- Chat Completions 类型 (只列反代要读/写的字段) --------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface ChatCompletionsRequest {
  model: string
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  tools?: Array<{
    type: 'function'
    function: { name: string; description?: string; parameters?: Record<string, unknown> }
  }>
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  stream_options?: { include_usage?: boolean }
}

interface ChatCompletionsChunk {
  id: string
  model: string
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ============== 启动 ==============

export async function startCodexProviderProxy(cfg: CodexProxyConfig): Promise<CodexProxyHandle> {
  const host = cfg.host ?? process.env.CODEX_PROXY_HOST ?? '127.0.0.1'
  const port = cfg.port ?? parseInt(process.env.CODEX_PROXY_PORT ?? '0', 10)
  const providerBaseUrl = cfg.provider.baseUrl.replace(/\/$/, '')

  const stats = { requests: 0, streamsOpen: 0, errors: 0 }

  const server: Server = createServer((req, res) => {
    stats.requests += 1
    handle(req, res, cfg, providerBaseUrl, stats).catch((err) => {
      stats.errors += 1
      logger.error(`unhandled proxy error: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'proxy_error', message: String(err) }))
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const addr = server.address() as AddressInfo
  const baseUrl = `http://${addr.address}:${addr.port}`

  logger.info(`codex-provider-proxy up at ${baseUrl} -> ${providerBaseUrl} (provider=${cfg.provider.name ?? 'unknown'})`)

  return {
    baseUrl,
    stats: () => ({ ...stats }),
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        logger.info('codex-provider-proxy closed')
        resolve()
      })
    }),
  }
}

// ============== 路由 ==============

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: CodexProxyConfig,
  providerBaseUrl: string,
  stats: { requests: number; streamsOpen: number; errors: number },
): Promise<void> {
  // 只处理 POST /v1/responses (codex 唯一会调的端点)
  const url = req.url ?? ''
  if (req.method !== 'POST' || !url.startsWith('/v1/responses')) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'not_found', path: url }))
    return
  }

  const body = await readBody(req)
  let parsed: ResponsesRequest
  try {
    parsed = JSON.parse(body) as ResponsesRequest
  } catch (err) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      error: 'invalid_request',
      message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    }))
    return
  }

  // 1. Responses -> Chat Completions
  const chatReq = translateRequest(parsed, cfg)

  // 诊断: 统计 input 中 tool call / tool output 的数量, 方便排查
  // "No tool call found for function call output with call_id ..." 这类错误.
  let inputToolCalls = 0
  let inputToolOutputs = 0
  for (const item of parsed.input ?? []) {
    if (item.type === 'function_call') inputToolCalls += 1
    else if (item.type === 'function_call_output') inputToolOutputs += 1
  }
  if (inputToolCalls > 0 || inputToolOutputs > 0) {
    logger.info(
      `proxy: input has ${inputToolCalls} function_call, ${inputToolOutputs} function_call_output`,
    )
  }

  // 2. 调供应商
  const upstreamUrl = `${providerBaseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${cfg.provider.apiKey ?? ''}`,
    'accept': parsed.stream ? 'text/event-stream' : 'application/json',
    ...cfg.provider.headers,
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatReq),
    })
  } catch (err) {
    stats.errors += 1
    res.statusCode = 502
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      error: 'upstream_unreachable',
      message: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  if (!upstream.ok) {
    stats.errors += 1
    const errBody = await upstream.text()
    // 诊断: 提取上游报错中的 call_id, 方便定位是哪个 tool result 失败
    const callIdMatch = errBody.match(/call_id\s+(call_[A-Za-z0-9_-]+)/)
    const toolCallIdMatch = errBody.match(/tool_call_id\s+(call_[A-Za-z0-9_-]+)/)
    const callHint = callIdMatch?.[1] ?? toolCallIdMatch?.[1] ?? null
    const hint = callHint
      ? ` (matched call_id=${callHint}; check whether function_call was forwarded as assistant tool_calls[])`
      : ''
    logger.warn(
      `upstream ${upstream.status} from ${providerBaseUrl}${hint}: ${errBody.slice(0, 500)}`,
    )
    // 非 2xx 但供应商给的是 JSON, 透传; 如果是 SSE 也透传
    res.statusCode = upstream.status
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
    res.end(errBody)
    return
  }

  if (parsed.stream) {
    stats.streamsOpen += 1
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.flushHeaders?.()
    await streamChatToResponses(upstream, res, parsed.model ?? '')
      .catch((err) => {
        stats.errors += 1
        logger.error(`stream translation error: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        stats.streamsOpen = Math.max(0, stats.streamsOpen - 1)
      })
  } else {
    // 非流: 一次拿 JSON, 翻成 Responses API 的非流响应
    const upstreamJson = (await upstream.json()) as ChatCompletionsChunk
    const responseObj = chatCompletionsToResponseObject(upstreamJson, parsed.model ?? '')
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(responseObj))
  }
}

// ============== 请求转译 ==============

function translateRequest(req: ResponsesRequest, cfg: CodexProxyConfig): ChatCompletionsRequest {
  // 1. model: codex -> 供应商
  const incomingModel = req.model ?? ''
  const mapped = cfg.modelMap?.(incomingModel)
  const providerModel = mapped ?? incomingModel

  // 2. messages
  const messages: ChatMessage[] = []
  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions })
  }
  for (const item of req.input ?? []) {
    messages.push(...inputItemToChatMessages(item))
  }

  // 3. tools
  const tools = (req.tools ?? []).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  const out: ChatCompletionsRequest = {
    model: providerModel,
    messages,
    stream: !!req.stream,
  }
  if (req.temperature !== undefined) out.temperature = req.temperature as number
  if (req.top_p !== undefined) out.top_p = req.top_p as number
  const maxOut = (req.max_output_tokens ?? req.max_tokens) as number | undefined
  if (maxOut !== undefined) out.max_tokens = maxOut
  if (tools.length > 0) {
    out.tools = tools
    out.tool_choice = 'auto' as const
  }
  if (req.stream) {
    out.stream_options = { include_usage: true }
  }
  return out
}

function inputItemToChatMessages(item: ResponsesInputItem): ChatMessage[] {
  // codex 在 tool_call_output 里同时用 type:"function_call_output" + call_id + output
  if (item.type === 'function_call_output' || (item.call_id && item.output !== undefined && item.type !== 'function_call')) {
    const out = item.output
    const toolContent = typeof out === 'string' ? out : JSON.stringify(out)
    const toolName = item.name ?? ''
    const messages: ChatMessage[] = [{
      role: 'tool',
      tool_call_id: item.call_id ?? '',
      content: toolContent,
    }]

    // ===== Tool-failure recovery 注入 (与 SGA runner.ts 的 is_error 注入对齐) =====
    // 检测 codex tool 输出的失败信号: "blocked by policy" / "rejected" /
    // "permission denied" / "not found" / "command not found" / "exit code 1+"
    // / 空输出. 如果命中, 在 tool message 之后追加一条 user 反思消息, 强制
    // LLM 在下一轮换工具/换参数/问用户, 而不是连续重试同一个失败命令.
    if (looksLikeToolFailure(toolContent, toolName)) {
      const recoveryHint = buildRecoveryHint(toolName, toolContent, item.call_id ?? '')
      messages.push({ role: 'user', content: recoveryHint })
    }

    // 重要: 这里的 call_id 必须是上游 Chat Completions 历史中 assistant message 的
    // tool_calls[].id. 反代必须保证这两者一致. 见下方 function_call 分支.
    return messages
  }
  // function_call: 反代必须把它翻译成 assistant message + tool_calls[], 这样上游
  // Chat Completions 历史里就有对应的 tool call 记录, 后续 tool 角色的
  // tool_call_id 才能匹配上. 否则上游会报 "No tool call found for function call
  // output with call_id ...". 关键: tool_calls[].id 必须使用 codex 的 call_id
  // (与 function_call_output 保持一致).
  if (item.type === 'function_call') {
    const args = typeof item.arguments === 'string'
      ? item.arguments
      : (item.arguments ? JSON.stringify(item.arguments) : '')
    return [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: args },
      }],
    }]
  }

  const role = item.role ?? 'user'
  const text = extractText(item.content)
  return [{ role: role as ChatMessage['role'], content: text }]
}

function extractText(content: ResponsesInputItem['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((b) => {
      if (typeof b.text === 'string') return b.text
      if (b.type === 'input_text' || b.type === 'output_text') return ''
      return ''
    })
    .join('')
}

// ============== 流式响应转译 ==============

async function streamChatToResponses(
  upstream: Response,
  res: ServerResponse,
  incomingModel: string,
): Promise<void> {
  if (!upstream.body) {
    emitSseEvent(res, 'response.failed', { error: { message: 'upstream has no body' } })
    res.end()
    return
  }

  const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`
  const itemId = `item_${Math.random().toString(36).slice(2, 10)}`

  // 1. response.created
  emitSseEvent(res, 'response.created', {
    response: { id: responseId, model: incomingModel, status: 'in_progress' },
  })
  // 2. response.output_item.added (一个空 message)
  emitSseEvent(res, 'response.output_item.added', {
    output_index: 0,
    item: { type: 'message', id: messageId, role: 'assistant', status: 'in_progress', content: [] },
  })
  // 3. response.content_part.added
  emitSseEvent(res, 'response.content_part.added', {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let totalText = ''
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null
  let lastFinishReason: string | null = null
  // tool calls 累积
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  const emitTextDelta = (delta: string): void => {
    if (!delta) return
    totalText += delta
    emitSseEvent(res, 'response.output_text.delta', {
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta,
    })
  }

  const flushToolCalls = (): void => {
    if (toolCalls.size === 0) return
    // 单独 item, 一次性 emit (codex 端的 agentMessage / mcpToolCall 桥接能识别)
    for (const [idx, tc] of toolCalls) {
      const outItemId = `${itemId}_tc_${idx}`
      // 走 mcpToolCall 的形态: type=function_call 的输出, codex 把它识别为 mcpToolCall
      emitSseEvent(res, 'response.output_item.added', {
        output_index: 1 + idx,
        item: {
          type: 'function_call',
          id: outItemId,
          name: tc.name,
          arguments: tc.arguments,
          call_id: tc.id,
          status: 'completed',
        },
      })
      emitSseEvent(res, 'response.output_item.done', {
        output_index: 1 + idx,
        item: {
          type: 'function_call',
          id: outItemId,
          name: tc.name,
          arguments: tc.arguments,
          call_id: tc.id,
          status: 'completed',
        },
      })
    }
    toolCalls.clear()
  }

  const finish = (reason: string | null): void => {
    if (totalText.length > 0) {
      emitSseEvent(res, 'response.output_text.done', {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: totalText,
      })
    }
    if (totalText.length > 0) {
      emitSseEvent(res, 'response.content_part.done', {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: totalText },
      })
      emitSseEvent(res, 'response.output_item.done', {
        output_index: 0,
        item: {
          type: 'message',
          id: messageId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: totalText }],
        },
      })
    }
    flushToolCalls()

    // ===== Critical: 用 finish_reason 决定 response 状态 =====
    // OpenAI Chat Completions 协议下, finish_reason 有 4 个值:
    //   - 'stop'             : LLM 正常完成本轮生成
    //   - 'length'           : 达到 token 上限
    //   - 'content_filter'   : 内容被过滤
    //   - 'tool_calls'       : LLM 决定调用工具 (此时不应发 response.completed,
    //                          否则 codex 会立即认为 turn 结束, 工具还没执行)
    //
    // 之前 proxy 永远发 response.completed (status=completed), 导致
    // finish_reason=tool_calls 时 codex 收到 completed -> 立即发 turn/completed
    // -> SGA 看到 turn 结束 -> 但工具其实没执行.
    // 修复: 在 tool_calls 时, 发 response.incomplete + status=requires_action
    //      并把已收集到的 tool_call_ids 列在 required_action.submit_tool_outputs
    //      里, 让 codex 知道"还没完成, 需要执行工具并提交 tool_outputs".
    const u = usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    const usagePayload = {
      input_tokens: u.input_tokens,
      input_tokens_details: null,
      output_tokens: u.output_tokens,
      output_tokens_details: null,
      total_tokens: u.total_tokens,
    }
    if (reason === 'tool_calls' && toolCalls.size > 0) {
      const submitToolOutputs = Array.from(toolCalls.values())
        .filter(e => e.id)
        .map(e => ({
          type: 'function' as const,
          id: e.id,
          call_id: e.id,
          name: e.name,
          arguments: e.arguments,
        }))
      emitSseEvent(res, 'response.incomplete', {
        response: {
          id: responseId,
          model: incomingModel,
          status: 'requires_action',
          usage: usagePayload,
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: { tool_calls: submitToolOutputs },
          },
        },
      })
      logger.info(
        `[codex-proxy] finish_reason=tool_calls with ${submitToolOutputs.length} tool call(s); ` +
        `emitted response.incomplete + required_action.submit_tool_outputs (NOT response.completed) ` +
        `so codex will wait for tool execution and submit tool_outputs.`
      )
    } else {
      emitSseEvent(res, 'response.completed', {
        response: {
          id: responseId,
          model: incomingModel,
          status: 'completed',
          usage: usagePayload,
        },
      })
    }
    res.end()
    lastFinishReason = reason
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          finish(lastFinishReason)
          return
        }
        if (!data) continue
        let chunk: ChatCompletionsChunk
        try {
          chunk = JSON.parse(data) as ChatCompletionsChunk
        } catch {
          logger.warn(`failed to parse upstream chunk: ${data.slice(0, 200)}`)
          continue
        }

        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
          }
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        if (choice.delta.content) {
          emitTextDelta(choice.delta.content)
        }

        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0
            let entry = toolCalls.get(idx)
            if (!entry) {
              entry = { id: tc.id ?? `call_${idx}_${Math.random().toString(36).slice(2, 6)}`, name: tc.function?.name ?? '', arguments: '' }
              toolCalls.set(idx, entry)
            }
            if (tc.function?.name) entry.name = tc.function.name
            if (tc.function?.arguments) entry.arguments += tc.function.arguments
          }
        }

        if (choice.finish_reason) {
          lastFinishReason = choice.finish_reason
        }
      }
    }
    // 流自然结束, 主动 finish
    finish(lastFinishReason)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`stream error: ${msg}`)
    emitSseEvent(res, 'response.failed', { error: { message: msg } })
    res.end()
  }
}

// ============== 非流响应转译 ==============

// ========= Tool-failure detection & recovery hint =========

/**
 * 检测 codex tool 的输出是否暗示"失败 / 被拦 / 空结果".
 * 命中后 provider-proxy 会在 tool message 后追加一条 user 反思消息,
 * 强制 LLM 在下一轮换工具/换参数/问用户, 而不是继续重试同一个失败命令.
 *
 * 注意: 这与 SGA runner.ts 的反思注入是"双层防护"中的第二层 ——
 *   SGA agent 用 runner.ts (process-local 注入)
 *   Codex agent 用 provider-proxy (process-remote 注入, 跨进程)
 * 两层都触发时, 后触发的会堆在前面的 user message 后面, 不冲突.
 */
function looksLikeToolFailure(content: string, toolName: string): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (trimmed.length === 0) return true   // 完全空输出

  const lower = content.toLowerCase()
  const failureSignals = [
    'blocked by policy',
    'rejected by policy',
    'rejected',
    'permission denied',
    'access is denied',
    'access denied',
    'not recognized',
    'commandnotfound',
    'is not recognized as',
    'not found',
    'no such file',
    'no such directory',
    'cannot find path',
    'cannot find the path',
    '路径找不到',
    '拒绝访问',
    '未找到',
    'exit code 1',
    'exit code 2',
    'exit code 3',
    'exit code 4',
    'exit code 5',
    'exit code: 1',
    'exit code: 2',
    'fatal error',
    'panic',
    'failed:',
    'error:',
    'err:',
  ]
  if (failureSignals.some(s => lower.includes(s))) return true

  // exit code 数字 1-9 (regex 单独算, 避免被 "exit 1xxx" 误命中)
  if (/\bexit\s+code\s*[1-9]\b/.test(lower)) return true
  if (/\bexit\s+[1-9]\b/.test(lower)) return true

  // bash 工具 + 输出全是空白 + 长度 < 5 也算空
  if (toolName === 'Bash' && trimmed.length < 5) return true

  return false
}

function buildRecoveryHint(toolName: string, content: string, callId: string): string {
  const shortContent = content.length > 300 ? content.slice(0, 300) + '...' : content
  return (
    `[codex-proxy: tool-failure recovery] The tool "${toolName}" ` +
    `(call_id=${callId}) returned output that looks like a failure or an empty ` +
    `result. Before you try the exact same command again, you MUST follow the ` +
    `Tool-failure Recovery rule:\n` +
    `(a) Try a different tool: if Bash fails, try Read / Glob / Grep; if Read ` +
    `fails on a path, try Glob with a pattern; if a directory listing is ` +
    `blocked, try a more targeted path.\n` +
    `(b) Try a different parameter set: a more specific path, fewer flags, a ` +
    `narrower glob, a different file extension, an absolute vs relative path.\n` +
    `(c) Only after at least 2 distinct attempts, ask the user a precise ` +
    `question (with the exact paths / commands you tried and the exact error ` +
    `text). Never reply "I cannot read the file" without showing what you tried.\n` +
    `Last tool output: ${shortContent}`
  )
}

function chatCompletionsToResponseObject(chunk: ChatCompletionsChunk, model: string): Record<string, unknown> {
  const choice = chunk.choices?.[0]
  const content = (choice?.delta?.content ?? (choice as unknown as { message?: { content?: string } })?.message?.content) ?? ''
  const outItems: Array<Record<string, unknown>> = []
  outItems.push({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: content }],
  })
  const toolCalls = (choice?.delta?.tool_calls ?? []) as Array<{
    id?: string
    function?: { name?: string; arguments?: string }
  }>
  for (const tc of toolCalls) {
    outItems.push({
      type: 'function_call',
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
      status: 'completed',
    })
  }
  const u = chunk.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  return {
    id: chunk.id ?? `resp_${Date.now()}`,
    model,
    status: 'completed',
    output: outItems,
    usage: {
      input_tokens: u.prompt_tokens,
      input_tokens_details: null,
      output_tokens: u.completion_tokens,
      output_tokens_details: null,
      total_tokens: u.total_tokens,
    },
  }
}

// ============== 工具 ==============

function emitSseEvent(res: ServerResponse, type: string, data: unknown): void {
  // codex 的 SSE parser (codex-rs/codex-api/src/sse/responses.rs) 不是读
  // SSE `event:` 行去 dispatch, 而是读 data JSON 里的 `type` 字段.
  // 这里自动把 type 注入到 data 里, 避免调用方忘写.
  let payload: unknown = data
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    // 没显式给 type 就补一个; 已给的优先用 data 里的
    if (!('type' in obj)) {
      payload = { type, ...obj }
    }
  } else {
    payload = { type, data }
  }
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  res.write(line)
  // 全事件用 INFO 级别方便排错 (e2e 测试时需要)
  logger.info(`proxy -> codex: ${type} ${JSON.stringify(payload).slice(0, 200)}`)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
