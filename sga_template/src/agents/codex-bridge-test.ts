/**
 * Codex event-bridge 单元测试
 *
 * 不需要起 codex 进程, 直接构造 JSON-RPC 通知, 喂给 bridge, 检查产出的 AgentStreamEvent.
 */

import { createEventBridge } from './codex/event-bridge.js'

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

function main(): void {
  const bridge = createEventBridge({
    turnCount: 1,
    model: 'gpt-5.4',
    sessionId: 'test',
    threadId: 'T-1',
  })

  // 1. turn/started -> turn_start
  let evs = bridge.push({ method: 'turn/started', params: { threadId: 'T-1' } })
  check('turn/started -> turn_start', evs.length === 1 && evs[0].type === 'turn_start', `events=${JSON.stringify(evs.map((e) => e.type))}`)

  // 2. item/started commandExecution -> tool_use_start
  evs = bridge.push({
    method: 'item/started',
    params: {
      threadId: 'T-1',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'ls -la' },
    },
  })
  check(
    'item/started commandExecution -> tool_use_start',
    evs.length === 1 && evs[0].type === 'tool_use_start' && (evs[0] as { toolName: string }).toolName === 'bash',
    `events=${JSON.stringify(evs.map((e) => e.type))}`,
  )

  // 3. item/completed commandExecution -> tool_use_end + tool_use_result
  evs = bridge.push({
    method: 'item/completed',
    params: {
      threadId: 'T-1',
      item: { type: 'commandExecution', id: 'cmd-1', status: 'completed', aggregatedOutput: 'file1\nfile2' },
    },
  })
  check(
    'item/completed commandExecution -> tool_use_end + result',
    evs.length === 2 && evs[0].type === 'tool_use_end' && evs[1].type === 'tool_use_result',
    `events=${JSON.stringify(evs.map((e) => e.type))}`,
  )
  const resultEv = evs[1] as { result: { content: string } }
  check('commandExecution result content', resultEv.result.content === 'file1\nfile2', `content=${resultEv.result.content}`)

  // 4. item/started fileChange -> tool_use_start (name=edit)
  evs = bridge.push({
    method: 'item/started',
    params: {
      threadId: 'T-1',
      item: { type: 'fileChange', id: 'fc-1' },
    },
  })
  check(
    'item/started fileChange -> tool_use_start (edit)',
    evs.length === 1 && evs[0].type === 'tool_use_start' && (evs[0] as { toolName: string }).toolName === 'edit',
    `toolName=${(evs[0] as { toolName: string }).toolName}`,
  )

  // 5. item/completed fileChange
  evs = bridge.push({
    method: 'item/completed',
    params: {
      threadId: 'T-1',
      item: { type: 'fileChange', id: 'fc-1', status: 'completed', changes: [{ path: '/a.txt', kind: 'update' }] },
    },
  })
  check('fileChange end + result', evs.length === 2 && evs[1].type === 'tool_use_result', 'ok')

  // 6. item/started mcpToolCall -> tool_use_start (server/tool)
  evs = bridge.push({
    method: 'item/started',
    params: {
      threadId: 'T-1',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'comfyui', tool: 'workflow' },
    },
  })
  check(
    'mcpToolCall -> tool_use_start (comfyui/workflow)',
    evs.length === 1 && (evs[0] as { toolName: string }).toolName === 'comfyui/workflow',
    `toolName=${(evs[0] as { toolName: string }).toolName}`,
  )

  // 7. item/completed mcpToolCall with error
  evs = bridge.push({
    method: 'item/completed',
    params: {
      threadId: 'T-1',
      item: { type: 'mcpToolCall', id: 'mcp-1', status: 'failed', error: { message: 'tool not found' } },
    },
  })
  check('mcpToolCall fail isError=true', evs.length === 2 && (evs[0] as { isError: boolean }).isError === true, 'ok')

  // 8. item/completed agentMessage -> stream_delta
  evs = bridge.push({
    method: 'item/completed',
    params: {
      threadId: 'T-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'Hello world' },
    },
  })
  check('agentMessage -> stream_delta', evs.length === 1 && evs[0].type === 'stream_delta' && (evs[0] as { text: string }).text === 'Hello world', 'ok')

  // 9. item/completed reasoning -> thinking_delta
  evs = bridge.push({
    method: 'item/completed',
    params: {
      threadId: 'T-1',
      item: { type: 'reasoning', id: 'rs-1', summary: ['thinking about it', 'still thinking'] },
    },
  })
  check('reasoning -> thinking_delta', evs.length === 1 && evs[0].type === 'thinking_delta' && (evs[0] as { text: string }).text === 'thinking about it\nstill thinking', 'ok')

  // 10. turn/completed -> turn_end with usage
  evs = bridge.push({
    method: 'turn/completed',
    params: {
      threadId: 'T-1',
      turn: { id: 'tr-1', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 30 } },
    },
  })
  check('turn/completed -> turn_end', evs.length === 1 && evs[0].type === 'turn_end', 'ok')
  const turnEnd = evs[0] as { usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; totalTokens: number } }
  check('turn_end usage', turnEnd.usage.inputTokens === 100 && turnEnd.usage.outputTokens === 30 && turnEnd.usage.cacheReadInputTokens === 50 && turnEnd.usage.totalTokens === 130, JSON.stringify(turnEnd.usage))

  // 11. isTurnEnded 应该是 true
  check('isTurnEnded after turn/completed', bridge.isTurnEnded() === true, 'ok')

  // 12. error notification
  const bridge2 = createEventBridge({ turnCount: 2, model: 'gpt-5.4', sessionId: 'test', threadId: 'T-2' })
  evs = bridge2.push({ method: 'error', params: { message: 'boom' } })
  check('error -> error event', evs.length === 1 && evs[0].type === 'error' && (evs[0] as { data: string }).data === 'boom', 'ok')

  // 13. 其它 thread 的事件被过滤
  evs = bridge.push({ method: 'turn/started', params: { threadId: 'OTHER-THREAD' } })
  check('其它 thread 事件被忽略', evs.length === 0, `events=${JSON.stringify(evs)}`)

  // 14. 未关心的方法被忽略
  evs = bridge.push({ method: 'thread/status/changed', params: { threadId: 'T-1' } })
  check('未关心的方法被忽略', evs.length === 0, `events=${JSON.stringify(evs)}`)

  // 15. flushDone cancelled
  const bridge3 = createEventBridge({ turnCount: 3, model: 'gpt-5.4', sessionId: 'test', threadId: 'T-3' })
  const flushed = bridge3.flushDone('cancelled')
  check('flushDone cancelled -> stop', flushed.length === 1 && flushed[0].type === 'stop', 'ok')

  // 16. flushDone error
  const bridge4 = createEventBridge({ turnCount: 4, model: 'gpt-5.4', sessionId: 'test', threadId: 'T-4' })
  const flushed2 = bridge4.flushDone('error', 'crashed')
  check('flushDone error -> error', flushed2.length === 1 && flushed2[0].type === 'error' && (flushed2[0] as { data: string }).data === 'crashed', 'ok')

  console.log(`\n=== ${pass} pass, ${fail} fail ===`)
  if (fail > 0) process.exit(1)
}

main()
