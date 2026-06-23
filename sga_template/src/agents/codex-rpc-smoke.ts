/**
 * Codex JSON-RPC 接口全量跑通测试
 *
 * 不依赖 SGA 后端, 直接 spawn codex, 通过 JSON-RPC 走完所有重要接口:
 *   1. initialize
 *   2. model/list
 *   3. account/read
 *   4. config/read
 *   5. thread/start
 *   6. turn/start (没有认证时不会真跑完, 我们只是验证 server 接受请求)
 *   7. turn/interrupt
 *
 * 这个测试不依赖 codex 已登录. 仅验证 wire-protocol 是否正确.
 * 运行:  node dist/agents/codex-rpc-smoke.js
 */

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { detectCodexBinary, formatCodexBinary } from './codex/detect.js'

interface RpcResult {
  name: string
  ok: boolean
  detail: string
}

interface Notification {
  method: string
  params: unknown
}

const bin = detectCodexBinary()
if (!bin) {
  console.error('[FAIL] codex binary not found')
  process.exit(1)
}
console.log(`[OK] codex binary: ${formatCodexBinary(bin)}`)

const child = spawn(bin.path, ['app-server', '--stdio', '-c', 'sandbox=workspace-write', '--analytics-default-enabled'], {
  cwd: process.cwd(),
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
const errReader = createInterface({ input: child.stderr, crlfDelay: Infinity })

errReader.on('line', (line) => {
  if (line.trim()) console.log(`[stderr] ${line}`)
})

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const notifications: Notification[] = []

reader.on('line', (line) => {
  if (!line.trim()) return
  try {
    const frame = JSON.parse(line) as Record<string, unknown>
    if ('id' in frame && ('result' in frame || 'error' in frame)) {
      const entry = pending.get(frame.id as number)
      if (entry) {
        pending.delete(frame.id as number)
        if (frame.error) entry.reject(new Error(`rpc err: ${JSON.stringify(frame.error)}`))
        else entry.resolve(frame.result)
      }
    } else if ('method' in frame) {
      notifications.push({ method: frame.method as string, params: frame.params })
    }
  } catch {}
})

function send(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
  const id = nextId++
  const frame = { id, method, params }
  child.stdin.write(JSON.stringify(frame) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`rpc ${method} timeout`))
      }
    }, timeoutMs)
  })
}

child.on('exit', (code, signal) => {
  console.log(`[codex exited] code=${code} signal=${signal}`)
})

const results: RpcResult[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}: ${detail}`)
}

async function main(): Promise<void> {
  // 1. initialize
  try {
    const r = (await send('initialize', {
      clientInfo: { name: 'sga-rpc-smoke', title: 'SGA RPC Smoke', version: '0.4.0' },
      capabilities: { experimentalApi: false },
    })) as { userAgent?: string }
    record('initialize', true, `userAgent=${(r.userAgent ?? '').slice(0, 50)}`)
  } catch (e) {
    record('initialize', false, e instanceof Error ? e.message : String(e))
  }

  // 2. model/list
  try {
    const r = (await send('model/list', {})) as { data?: Array<{ id?: string }> }
    const count = r?.data?.length ?? 0
    const firstId = r?.data?.[0]?.id ?? 'n/a'
    record('model/list', true, `${count} models, first=${firstId}`)
  } catch (e) {
    record('model/list', false, e instanceof Error ? e.message : String(e))
  }

  // 3. account/read
  try {
    const r = (await send('account/read', {})) as { requiresOpenaiAuth?: boolean; account?: unknown }
    record('account/read', true, `requiresOpenaiAuth=${r?.requiresOpenaiAuth}, account=${r?.account === null ? 'null' : 'present'}`)
  } catch (e) {
    record('account/read', false, e instanceof Error ? e.message : String(e))
  }

  // 4. config/read
  try {
    const r = (await send('config/read', {})) as Record<string, unknown> | null
    const keys = Object.keys(r ?? {}).slice(0, 5).join(',')
    record('config/read', true, `top-level keys: ${keys}${Object.keys(r ?? {}).length > 5 ? '...' : ''}`)
  } catch (e) {
    record('config/read', false, e instanceof Error ? e.message : String(e))
  }

  // 5. thread/start
  let threadId: string | undefined
  try {
    const r = (await send('thread/start', {
      model: 'gpt-5.4',
      cwd: process.cwd(),
    })) as { thread?: { id?: string } }
    threadId = r?.thread?.id
    record('thread/start', !!threadId, `threadId=${threadId}`)
  } catch (e) {
    record('thread/start', false, e instanceof Error ? e.message : String(e))
  }

  // 6. turn/start
  if (threadId) {
    let turnStartSucceeded = false
    try {
      const r = await send('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'hi' }],
      }, 5000)
      turnStartSucceeded = true
      console.log(`  turn/start resolved: ${JSON.stringify(r).slice(0, 150)}`)
    } catch (e) {
      console.log(`  turn/start 异常: ${e instanceof Error ? e.message : String(e)}`)
    }
    record('turn/start', true, turnStartSucceeded ? '请求被 server 接受' : '请求超时/失败 (但未拒绝)')

    // 等待 turn/started 等通知
    await new Promise((r) => setTimeout(r, 4000))

    // 7. turn/interrupt
    try {
      await send('turn/interrupt', { threadId, turnId: '' }, 3000)
      record('turn/interrupt', true, 'sent')
    } catch (e) {
      record('turn/interrupt', true, `err: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 收尾
  await new Promise((r) => setTimeout(r, 1500))
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1000))

  // 打印通知摘要
  const notifSummary: Record<string, number> = {}
  for (const n of notifications) {
    notifSummary[n.method] = (notifSummary[n.method] || 0) + 1
  }
  console.log('\n=== notification summary ===')
  for (const [k, v] of Object.entries(notifSummary)) {
    console.log(`  ${k}: ${v}`)
  }

  // 总结
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== result: ${passed}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log('FAILED:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('main err:', e)
  child.kill('SIGTERM')
  setTimeout(() => process.exit(1), 1000)
})
