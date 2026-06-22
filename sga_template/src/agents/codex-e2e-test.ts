/**
 * CodexBackend 端到端冒烟测试 v2
 *
 * 直接调用 CodexBackend 的 start / sendMessage, 验证:
 *   - binary 探测
 *   - 进程 spawn
 *   - JSON-RPC initialize
 *   - thread/start
 *   - turn/start
 *   - notification -> AgentStreamEvent 桥接
 *
 * 不需要 SGA 后端 / HTTP server 启动. 跑这个文件需要:
 *   - 已编译 dist/ (npm run build)
 *   - codex binary 可用 (detectCodexBinary() != null)
 *
 * 运行:  node dist/agents/codex-e2e-test.js
 *
 * 如果 codex 未登录 (无 OPENAI_API_KEY / ChatGPT 登录), 不会收到 turn_end,
 * 这是正常的 - 会在 8s 后停止, 只验证 init / thread / turn_start.
 */

import { CodexBackend } from './codex-backend.js'
import { detectCodexBinary, formatCodexBinary } from './codex/detect.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('codex-e2e')

async function main() {
  // 1. 探测 binary
  const bin = detectCodexBinary()
  if (!bin) {
    console.error('[FAIL] codex binary not found')
    process.exit(1)
  }
  console.log(`[OK] codex binary: ${formatCodexBinary(bin)}`)

  // 2. 实例化 backend (构造时已自动探测)
  const backend = new CodexBackend()
  if (!backend.isAvailable()) {
    console.error('[FAIL] backend reports unavailable')
    process.exit(1)
  }
  console.log(`[OK] backend available: ${backend.displayName}`)

  // 3. start()
  console.log('[...] starting backend (spawn codex app-server)...')
  const t0 = Date.now()
  await backend.start({ cwd: process.cwd() })
  console.log(`[OK] started in ${Date.now() - t0}ms`)

  // 4. healthCheck
  const health = await backend.healthCheck()
  console.log(`[OK] healthCheck: ok=${health.ok} details="${health.details}" version=${health.version}`)

  // 5. sendMessage 一次, 看事件流
  console.log('[...] sendMessage (模型 gpt-5.4) ...')
  const events: string[] = []
  const items: { type: string; name?: string; text?: string }[] = []
  let count = 0
  let textAccum = ''
  let deadline = Date.now() + 8000  // 8s 上限, 没认证时不会 turn_end
  let finished = false
  try {
    for await (const ev of backend.sendMessage({
      prompt: 'Reply with exactly the text "hi from codex e2e" and nothing else.',
      model: 'gpt-5.4',
      provider: { id: 'synthetic', name: 'synthetic', type: 'openai' as const, baseUrl: 'http://localhost', apiKey: 'synthetic' },
    } as never)) {
      events.push(ev.type)
      count++
      if (ev.type === 'stream_delta') textAccum += (ev as { text: string }).text
      if (ev.type === 'tool_use_start' || ev.type === 'tool_use_end') {
        const e = ev as { toolName?: string; toolUseId?: string }
        items.push({ type: ev.type, name: e.toolName })
      }
      console.log(`[event] ${ev.type}${ev.type === 'stream_delta' ? ` text=${JSON.stringify((ev as { text: string }).text.slice(0, 60))}` : ''}`)
      if (ev.type === 'turn_end' || ev.type === 'stop' || ev.type === 'error') {
        finished = true
        break
      }
      if (Date.now() > deadline) {
        console.log(`[...] timeout ${deadline - t0}ms reached, breaking`)
        break
      }
    }
  } catch (err) {
    console.error('[FAIL] sendMessage threw:', err)
    await backend.stop().catch(() => undefined)
    process.exit(1)
  }

  console.log(`[OK] sendMessage finished, ${count} events, types=${JSON.stringify(events)}`)
  console.log(`[OK] accumulated text: ${JSON.stringify(textAccum.slice(0, 200))}`)
  console.log(`[OK] tool items: ${items.length}`)

  // 6. stop
  await backend.stop()
  console.log('[OK] backend stopped')

  // 7. 验证关键事件出现过
  const required = ['session_start', 'turn_start']
  const missing = required.filter((t) => !events.includes(t))
  if (missing.length > 0) {
    console.error(`[FAIL] missing required events: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('[PASS] all required events present (session_start, turn_start)')

  if (finished && events.includes('turn_end')) {
    console.log('[PASS] turn_end observed (有认证, codex 跑完了 turn)')
    if (!textAccum.toLowerCase().includes('hi from codex e2e')) {
      console.warn(`[WARN] text does not contain expected phrase. text="${textAccum}"`)
    } else {
      console.log('[PASS] codex replied with expected text')
    }
  } else {
    console.log('[INFO] turn_end NOT observed. 这通常意味着:')
    console.log('       - 未登录 codex (login status = "Not logged in")')
    console.log('       - 模型调用 hang 在认证阶段')
    console.log('       只要 init / thread / turn_start / 通知流都正常, 集成层就 OK.')
    console.log('       要看到 turn_end, 请先在终端跑: codex login')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FAIL] uncaught:', err)
    process.exit(1)
  })
