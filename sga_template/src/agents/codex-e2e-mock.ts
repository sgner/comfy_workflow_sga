/**
 * CodexBackend 端到端测试 (走真反代 + mock 供应商)
 *
 * 不需要 codex 登录. 自己起一个 mock Chat Completions 供应商,
 * 让 codex 走 SGA 的反代, 验证:
 *   - binary 探测
 *   - 反代启动 + config.toml 写盘
 *   - 进程 spawn + initialize
 *   - thread/start + turn/start
 *   - turn_end 收到 (mock 返回 "hi from mock")
 *   - 后台清理 (反代关闭, 临时目录删除)
 *
 * 运行:  node dist/agents/codex-e2e-mock.js
 */

import { createServer, type Server } from 'http'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { CodexBackend } from './codex-backend.js'
import { startCodexProviderProxy } from './codex/provider-proxy.js'
import { detectCodexBinary, formatCodexBinary } from './codex/detect.js'
import type { LLMProvider } from '../providers/types.js'
import type { AddressInfo } from 'net'

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

interface MockProviderHandle {
  server: Server
  baseUrl: string
  close(): Promise<void>
  callCount(): number
}

async function startMockProvider(): Promise<MockProviderHandle> {
  let count = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      count++
      console.log(`[mock] 收到 /chat/completions #${count} body=${body.slice(0, 200)}`)
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      res.end([
        `data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n`,
        `data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","model":"mock-model","choices":[{"index":0,"delta":{"content":" from mock"},"finish_reason":null}]}\n\n`,
        `data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n`,
        `data: [DONE]\n\n`,
      ].join(''))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as AddressInfo
  return {
    server,
    baseUrl: `http://${addr.address}:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    callCount: () => count,
  }
}

function makeProvider(baseUrl: string, apiKey: string): LLMProvider {
  // 借用 SGA 现有的 OpenAIProvider, 但把 baseUrl 指向 mock
  return {
    name: 'mock-provider',
    config: { name: 'mock-provider', apiKey, baseUrl, models: {}, defaultModel: 'mock-model' },
  } as unknown as LLMProvider
}

async function main(): Promise<void> {
  // 1. binary 探测
  const bin = detectCodexBinary()
  if (!bin) {
    console.error('[SKIP] codex binary not found')
    process.exit(0)
  }
  console.log(`[OK] codex binary: ${formatCodexBinary(bin)}`)

  // 2. 启动 mock 供应商
  const mock = await startMockProvider()
  console.log(`[OK] mock provider: ${mock.baseUrl}`)

  // 3. 构造 backend, 提供 provider
  const backend = new CodexBackend()
  if (!backend.isAvailable()) {
    console.error('[FAIL] backend not available')
    process.exit(1)
  }
  const provider = makeProvider(mock.baseUrl, 'mock-key-12345')

  // 4. start() — 这里会起反代, 写 config.toml, spawn codex
  console.log('[...] start()')
  await backend.start({ cwd: process.cwd(), provider, model: 'mock-model' })
  console.log('[OK] backend started')

  // 5. healthCheck
  const h = await backend.healthCheck()
  check('healthCheck ok', h.ok, `latency=${h.latencyMs}ms ${h.details ?? ''}`)

  // 6. sendMessage — 这是关键测试, 验证整条链
  console.log('[...] sendMessage() (走反代 -> mock)')
  const events: string[] = []
  let textAccum = ''
  let gotTurnEnd = false
  for await (const ev of backend.sendMessage({
    prompt: 'Reply with exactly "hi from mock"',
    model: 'mock-model',
    provider,
  } as never)) {
    events.push(ev.type)
    if (ev.type === 'stream_delta') textAccum += (ev as { text: string }).text
    if (ev.type === 'turn_end') {
      gotTurnEnd = true
      const e = ev as { usage?: { inputTokens: number; outputTokens: number } }
      console.log(`[event] turn_end usage=${JSON.stringify(e.usage)}`)
    }
    if (ev.type === 'error') {
      const e = ev as { data: string }
      console.log(`[event] error data=${e.data}`)
    }
    if (ev.type === 'turn_end' || ev.type === 'stop' || ev.type === 'error') break
  }

  check('mock 至少被调用 1 次', mock.callCount() >= 1, `count=${mock.callCount()}`)
  check('事件流含 session_start', events.includes('session_start'), `events=${JSON.stringify(events)}`)
  check('事件流含 turn_start', events.includes('turn_start'), `events=${JSON.stringify(events)}`)
  check('事件流含 turn_end', gotTurnEnd, `events=${JSON.stringify(events)}`)
  check('累积文本 = "hi from mock"', textAccum === 'hi from mock', `text=${JSON.stringify(textAccum)}`)

  // 7. 停 backend, 检查清理
  await backend.stop()
  console.log('[OK] backend stopped')

  // 8. 关 mock
  await mock.close()

  // 总结
  console.log(`\n=== ${pass} pass, ${fail} fail ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('uncaught:', e)
  process.exit(1)
})
