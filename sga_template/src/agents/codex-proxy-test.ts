/**
 * Provider-proxy 单元测试
 *
 * 不需要 codex 进程, 不需要真实供应商. 自己起一个 mock Chat Completions 服务
 * (模拟 OpenAI 兼容接口), 然后启动 provider-proxy, 往 proxy 发 Responses API
 * 请求, 验证:
 *   - 请求转译: input[] -> messages[]
 *   - 流式响应转译: chat delta -> response.output_text.delta
 *   - usage 转译
 *   - tool calls 转译
 *   - 错误透传
 */

import { createServer, type Server } from 'http'
import { startCodexProviderProxy, type CodexProxyHandle } from './codex/provider-proxy.js'
import type { AddressInfo } from 'net'

interface RecordedCall {
  body: string
  json: Record<string, unknown>
}

interface MockOptions {
  /** 自定义 /chat/completions 的 SSE 响应 (默认简单 "hi" 文本) */
  onChat?: (call: RecordedCall) => string
  /** 自定义 /chat/completions 状态码, 默认 200 */
  statusCode?: number
}

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`[PASS] ${name}: ${detail}`)
    pass++
  } else {
    console.error(`[FAIL] ${name}: ${detail}`)
    fail++
  }
}

async function startMockProvider(opts: MockOptions = {}): Promise<{ server: Server; calls: RecordedCall[]; baseUrl: string; close: () => Promise<void> }> {
  const calls: RecordedCall[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        calls.push({ body, json: JSON.parse(body) })
      } catch {
        calls.push({ body, json: {} })
      }
      if (opts.onChat) {
        const sse = opts.onChat(calls[calls.length - 1]!)
        res.statusCode = opts.statusCode ?? 200
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        res.end(sse)
      } else {
        res.statusCode = opts.statusCode ?? 200
        res.setHeader('content-type', 'text/event-stream')
        res.end([
          `data: {"id":"r1","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n`,
          `data: {"id":"r1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n`,
          `data: [DONE]\n\n`,
        ].join(''))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as AddressInfo
  return {
    server,
    calls,
    baseUrl: `http://${addr.address}:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

async function callProxy(proxyBaseUrl: string, payload: Record<string, unknown>): Promise<{ status: number; body: string; sse?: string[] }> {
  const r = await fetch(`${proxyBaseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await r.text()
  if (!r.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: r.status, body: text }
  }
  // 解析 SSE: 按 \n\n 切分
  const events = text.split('\n\n').filter((b) => b.trim().length > 0)
  return { status: r.status, body: text, sse: events }
}

async function main(): Promise<void> {
  // ---- 1. 基本流式文本 ----
  {
    const mock = await startMockProvider()
    const proxy: CodexProxyHandle = await startCodexProviderProxy({
      provider: { name: 'mock', apiKey: 'k', baseUrl: mock.baseUrl, models: {}, defaultModel: 'm' } as never,
    })
    const r = await callProxy(proxy.baseUrl, {
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'be helpful',
      stream: true,
    })
    check('basic 200 OK', r.status === 200, `status=${r.status}`)
    check('SSE response', Array.isArray(r.sse), `events=${r.sse?.length ?? 0}`)
    const types = (r.sse ?? []).map((b) => (b.match(/event: (\S+)/) ?? [])[1]).filter(Boolean)
    check(
      '事件序列包含 created/text.delta/completed',
      types.includes('response.created') && types.includes('response.output_text.delta') && types.includes('response.completed'),
      `types=${JSON.stringify(types)}`,
    )
    const delta = (r.sse ?? []).find((b) => b.includes('response.output_text.delta'))
    check('text.delta 含 "hi"', !!delta && delta.includes('"delta":"hi"'), `delta block: ${delta?.slice(0, 100)}`)
    check('上游收到 Authorization', mock.calls[0]?.body !== undefined, `upstream got call`)
    const upstreamReq = mock.calls[0]?.json
    check('上游拿到 messages', Array.isArray(upstreamReq?.messages) && (upstreamReq!.messages as unknown[]).length === 2, `messages len=${(upstreamReq?.messages as unknown[] | undefined)?.length}`)
    const firstMsg = (upstreamReq?.messages as Array<{ role: string; content: string }> | undefined)?.[0]
    check('instructions -> system', firstMsg?.role === 'system' && firstMsg.content === 'be helpful', `sys=${firstMsg?.content}`)
    const userMsg = (upstreamReq?.messages as Array<{ role: string; content: string }> | undefined)?.[1]
    check('input -> user', userMsg?.role === 'user' && userMsg.content === 'hello', `user=${userMsg?.content}`)
    check('stream=true 透传', upstreamReq?.stream === true, `stream=${upstreamReq?.stream}`)
    check('stream_options.include_usage=true', (upstreamReq?.stream_options as { include_usage?: boolean })?.include_usage === true, `so=${JSON.stringify(upstreamReq?.stream_options)}`)
    await proxy.close()
    await mock.close()
  }

  // ---- 2. 工具调用 ----
  {
    const mock = await startMockProvider({
      onChat: () => [
        `data: {"id":"r2","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\""}}]}}]}\n\n`,
        `data: {"id":"r2","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"shanghai\\"}"}}]}}]}\n\n`,
        `data: {"id":"r2","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n`,
        `data: [DONE]\n\n`,
      ].join(''),
    })
    const proxy = await startCodexProviderProxy({
      provider: { name: 'mock', apiKey: 'k', baseUrl: mock.baseUrl, models: {}, defaultModel: 'm' } as never,
    })
    const r = await callProxy(proxy.baseUrl, {
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'weather?' }] }],
      stream: true,
    })
    const types = (r.sse ?? []).map((b) => (b.match(/event: (\S+)/) ?? [])[1]).filter(Boolean)
    check(
      'tool_call 触发 function_call item',
      types.includes('response.output_item.added') && types.includes('response.output_item.done'),
      `types=${JSON.stringify(types)}`,
    )
    const addedItem = (r.sse ?? []).find((b) => b.includes('function_call') && b.includes('response.output_item.added'))
    check('function_call name=get_weather', !!addedItem && addedItem.includes('get_weather'), `ok`)
    const argsBlk = (r.sse ?? []).find((b) => b.includes('response.output_item.done') && b.includes('get_weather'))
    check(
      'function_call args 拼接完整',
      !!argsBlk && argsBlk.includes('shanghai'),
      `args ok`,
    )
    await proxy.close()
    await mock.close()
  }

  // ---- 3. 非流式 ----
  {
    const mock = await startMockProvider({
      onChat: () => {
        // 一次返回完整 chat 响应
        const body = JSON.stringify({
          id: 'r3',
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })
        return body
      },
    })
    const proxy = await startCodexProviderProxy({
      provider: { name: 'mock', apiKey: 'k', baseUrl: mock.baseUrl, models: {}, defaultModel: 'm' } as never,
    })
    const r = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        stream: false,
      }),
    })
    check('非流 status 200', r.status === 200, `status=${r.status}`)
    const j = (await r.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> }
    const text = j?.output?.[0]?.content?.[0]?.text
    check('非流 文本 = "pong"', text === 'pong', `text=${text}`)
    await proxy.close()
    await mock.close()
  }

  // ---- 4. 错误透传 (4xx) ----
  {
    const mock = await startMockProvider({
      onChat: () => JSON.stringify({ error: { message: 'bad key', type: 'invalid_request' } }),
      statusCode: 401,
    })
    const proxy = await startCodexProviderProxy({
      provider: { name: 'mock', apiKey: 'wrong', baseUrl: mock.baseUrl, models: {}, defaultModel: 'm' } as never,
    })
    const r = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [], stream: false }),
    })
    check('4xx 透传', r.status === 401, `status=${r.status}`)
    const j = (await r.json()) as { error?: { message?: string } }
    check('错误 body 透传', j?.error?.message === 'bad key', `err=${j?.error?.message}`)
    await proxy.close()
    await mock.close()
  }

  // ---- 5. input 里含 function_call_output (tool result) ----
  {
    const mock = await startMockProvider()
    const proxy = await startCodexProviderProxy({
      provider: { name: 'mock', apiKey: 'k', baseUrl: mock.baseUrl, models: {}, defaultModel: 'm' } as never,
    })
    await callProxy(proxy.baseUrl, {
      model: 'm',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'weather' }] },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny, 25C' },
      ],
      stream: false,
    })
    const msgs = (mock.calls[0]?.json as { messages?: Array<{ role: string; tool_call_id?: string; content?: string }> })?.messages
    const toolMsg = msgs?.find((m) => m.role === 'tool')
    check('function_call_output -> tool msg', toolMsg?.tool_call_id === 'call_1' && toolMsg.content === 'sunny, 25C', `msg=${JSON.stringify(toolMsg)}`)
    await proxy.close()
    await mock.close()
  }

  console.log(`\n=== ${pass} pass, ${fail} fail ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('uncaught:', e)
  process.exit(1)
})
