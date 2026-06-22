/**
 * CodexBackend 端到端测试 (走真供应商)
 *
 * 需要环境变量:
 *   CODEX_E2E_API_KEY  — 供应商 API key
 *   CODEX_E2E_BASE_URL — 供应商 base URL (如 https://api.deepseek.com/v1)
 *   CODEX_E2E_MODEL    — 模型名 (如 deepseek-chat)
 *   CODEX_E2E_PROVIDER — 供应商显示名 (如 DeepSeek, 默认 "E2E Provider")
 *
 * 运行:
 *   $env:CODEX_E2E_API_KEY="sk-..."; $env:CODEX_E2E_BASE_URL="https://api.deepseek.com/v1"; $env:CODEX_E2E_MODEL="deepseek-chat"; npx tsx src/agents/codex-e2e-real.ts
 */

import { CodexBackend } from './codex-backend.js'
import { detectCodexBinary, formatCodexBinary } from './codex/detect.js'
import type { LLMProvider } from '../providers/types.js'

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

async function main(): Promise<void> {
  const apiKey = process.env.CODEX_E2E_API_KEY
  const baseUrl = process.env.CODEX_E2E_BASE_URL
  const model = process.env.CODEX_E2E_MODEL
  const providerName = process.env.CODEX_E2E_PROVIDER ?? 'E2E Provider'

  if (!apiKey || !baseUrl || !model) {
    console.error('Missing required env vars: CODEX_E2E_API_KEY, CODEX_E2E_BASE_URL, CODEX_E2E_MODEL')
    console.error('Example:')
    console.error('  $env:CODEX_E2E_API_KEY="sk-..."')
    console.error('  $env:CODEX_E2E_BASE_URL="https://api.deepseek.com/v1"')
    console.error('  $env:CODEX_E2E_MODEL="deepseek-chat"')
    process.exit(1)
  }

  console.log('=== Codex E2E Real Provider Test ===')
  console.log(`Provider: ${providerName}`)
  console.log(`Base URL: ${baseUrl}`)
  console.log(`Model:    ${model}`)
  console.log('')

  // 1. 探测 codex binary
  const binary = detectCodexBinary()
  check('codex binary 探测', binary !== null, binary ? formatCodexBinary(binary) : 'NOT FOUND')
  if (!binary) {
    console.error('\n=== 0 pass, 1 fail ===')
    process.exit(1)
  }

  // 2. 构造 LLMProvider
  const provider: LLMProvider = {
    config: {
      id: 'e2e-real',
      name: providerName,
      provider: 'openai' as never,
      baseUrl,
      apiKey,
      defaultModel: model,
    },
    async chatCompletion() {
      throw new Error('should not be called directly — codex goes through proxy')
    },
  } as never

  // 3. 启动 backend
  const backend = new CodexBackend()
  console.log('[info] starting backend...')
  try {
    await backend.start({
      cwd: process.cwd(),
      provider,
      model,
    })
  } catch (err) {
    check('backend start', false, err instanceof Error ? err.message : String(err))
    console.error('\n=== 0 pass, 1 fail ===')
    process.exit(1)
  }
  check('backend started', backend.isAvailable(), 'OK')

  // 4. healthCheck
  try {
    const health = await backend.healthCheck()
    check('healthCheck', health.ok, `ok=${health.ok} latency=${health.latencyMs}ms`)
  } catch (err) {
    check('healthCheck', false, err instanceof Error ? err.message : String(err))
  }

  // 5. 发消息
  console.log('[info] sending message...')
  const events: string[] = []
  let textAccum = ''
  let gotTurnEnd = false
  let gotError = false
  let errorMsg = ''

  try {
    for await (const ev of backend.sendMessage({
      prompt: 'Reply with exactly "hello from codex" and nothing else.',
      model,
      provider,
    } as never)) {
      events.push(ev.type)
      if (ev.type === 'stream_delta') {
        textAccum += (ev as { text: string }).text
      }
      if (ev.type === 'turn_end') {
        gotTurnEnd = true
        const usage = (ev as { usage?: { inputTokens: number; outputTokens: number } }).usage
        if (usage) {
          console.log(`[info] usage: in=${usage.inputTokens} out=${usage.outputTokens}`)
        }
      }
      if (ev.type === 'error') {
        gotError = true
        errorMsg = (ev as { error?: string }).error ?? 'unknown error'
      }
    }
  } catch (err) {
    check('sendMessage loop', false, err instanceof Error ? err.message : String(err))
  }

  // 6. 验证结果
  check('事件流含 session_start', events.includes('session_start'), `events=${events.join(',')}`)
  check('事件流含 turn_start', events.includes('turn_start'), `events=${events.join(',')}`)
  check('收到 turn_end', gotTurnEnd, `gotTurnEnd=${gotTurnEnd}`)
  check('无 error 事件', !gotError, gotError ? `error=${errorMsg}` : 'OK')
  check('有文本输出', textAccum.length > 0, `text=${JSON.stringify(textAccum.slice(0, 100))}`)

  // 7. 清理
  console.log('[info] stopping backend...')
  await backend.stop()
  check('backend stopped', true, 'OK')

  console.log(`\n=== ${pass} pass, ${fail} fail ===`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
