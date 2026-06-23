/**
 * Codex 事件桥接
 *
 * 把 codex app-server 推送的 JSON-RPC notification 转换成 SGA 的 AgentStreamEvent.
 *
 * Codex 主要 notification 分类:
 *   - turn/started             (TurnStartedNotification)
 *   - turn/completed           (TurnCompletedNotification) - 含 usage
 *   - turn/diff/updated        (TurnDiffUpdatedNotification)
 *   - item/started             (ItemStartedNotification)   - item 是 ThreadItem enum
 *   - item/agentMessage/delta  (AgentMessageDeltaNotification) - agentMessage 增量文本
 *   - item/completed           (ItemCompletedNotification)
 *   - error                    (ErrorNotification)
 *
 * ThreadItem 类型 (来自 v2/item.rs):
 *   - userMessage           { id, content }
 *   - agentMessage          { id, text }
 *   - reasoning             { id, summary, content }
 *   - commandExecution      { id, command, status, exitCode, aggregatedOutput, ... }
 *   - fileChange            { id, changes, status }
 *   - mcpToolCall           { id, server, tool, status, result, error, ... }
 *   - webSearch             { id, query, action }
 *   - imageView             { id, path, ... }
 *   - enteredReviewMode / exitedReviewMode
 *
 * 桥接策略:
 *   - turn/started      => turn_start
 *   - item/started      => tool_use_start (非文本) 或 (text item 不发 start, 等 completed 一次性给)
 *   - item/completed    => 看 item 类型:
 *       - agentMessage  => stream_delta
 *       - reasoning     => thinking_delta
 *       - commandExecution / fileChange / mcpToolCall => tool_use_end
 *   - turn/completed    => turn_end (含 usage) + done
 *   - error             => error
 *
 * 不实现 (留到 Sprint 2.5+):
 *   - tool_progress (codex 目前不流式推 commandExecution 的 output, 一次给)
 *   - approval_required 透传
 *   - handoff bundle 映射
 */

import { createLogger } from '../../utils/logger.js'
import type { JsonRpcClient } from './jsonrpc.js'
import type { AgentStreamEvent, UsageMetrics } from '../../core/types.js'

const logger = createLogger('codex-event-bridge')

export interface BridgeOptions {
  /** turn id (SGA 内部), 关联到本次 sendMessage */
  turnCount: number
  /** model 标识, 写到 session_start 里 */
  model: string
  /** sessionId 标识 */
  sessionId: string
  /** codex thread id, 用于过滤 (其它 turn 的通知会被忽略) */
  threadId: string
}

export interface BridgeHandle {
  /** 把 codex 事件 push 进来, 同步产出 0..N 个 AgentStreamEvent */
  push(notification: { method: string; params: unknown }): AgentStreamEvent[]
  /** 关闭, 清理监听 */
  dispose(): void
  /** 是否已收到 turn/completed (或 error), sendMessage 主循环据此退出 */
  isTurnEnded(): boolean
  /** 收尾: turn 结束后再冲一次 done / error (必须由 caller 调 turn/completed 后调用 flushDone) */
  flushDone(reason: 'end_turn' | 'cancelled' | 'error', errMsg?: string): AgentStreamEvent[]
}

/** CodeX item type 兼容多种驼峰, 保持宽松 */
interface CodexItem {
  type?: string
  id?: string
  text?: string
  // commandExecution
  command?: string
  commandActions?: unknown[]
  status?: string
  exitCode?: number | null
  aggregatedOutput?: string
  durationMs?: number
  // fileChange
  changes?: Array<{ path: string; kind: string }>
  // mcpToolCall
  server?: string
  tool?: string
  result?: unknown
  error?: { message?: string }
  // reasoning
  summary?: string[]
  content?: string | Array<{ type: string; text: string }>
  // userMessage
  content_array?: Array<{ type: string; text: string }>
}

function emptyUsage(): UsageMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  }
}

function extractUsage(params: unknown): UsageMetrics {
  // TurnCompletedNotification.params.turn.usage = { input_tokens, cached_input_tokens, output_tokens }
  const p = (params ?? {}) as { turn?: { usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } } }
  const u = p.turn?.usage
  if (!u) return emptyUsage()
  const inT = u.input_tokens ?? 0
  const outT = u.output_tokens ?? 0
  const cacheRead = u.cached_input_tokens ?? 0
  return {
    inputTokens: inT,
    outputTokens: outT,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: 0,
    totalTokens: inT + outT,
    totalCostUsd: 0, // codex 不报 cost, SGA 端按 provider 模型表再算
  }
}

function extractItem(item: unknown): CodexItem {
  // item 可能是 { type: "agentMessage", ... } 也可能是 "agent_message" 等. 容错.
  const obj = (item ?? {}) as Record<string, unknown>
  // 一些字段可能用 snake_case
  const normalised: Record<string, unknown> = { ...obj }
  if (normalised.exit_code !== undefined && normalised.exitCode === undefined) {
    normalised.exitCode = normalised.exit_code
  }
  if (normalised.aggregated_output !== undefined && normalised.aggregatedOutput === undefined) {
    normalised.aggregatedOutput = normalised.aggregated_output
  }
  if (normalised.duration_ms !== undefined && normalised.durationMs === undefined) {
    normalised.durationMs = normalised.duration_ms
  }
  return normalised as CodexItem
}

function itemType(item: unknown): string {
  const obj = item as { type?: string }
  if (obj?.type) return obj.type
  // 容错: codex 的 TS 类型 union 序列化时, tag 可能是 'agentMessage' 或 'AgentMessage'
  // 但我们只信 { type: '...' } 字段
  return 'unknown'
}

export function createEventBridge(opts: BridgeOptions): BridgeHandle {
  // 累计本次 turn 的 item 状态, 用于在 item/started 时记录 tool_use_id, 在 item/completed 时回填
  const startedItems = new Map<string, { type: string; name?: string; toolUseId: string }>()
  let turnEnded = false
  let lastError: string | null = null
  /** 缓存 thread/tokenUsage/updated 推送的 usage, turn/completed 时用 */
  let cachedUsage: UsageMetrics | null = null

  // 订阅所有 codex notification. 这里只读, 真正 push 是调用 push().
  // (保留接口对称, 未来如果要直接挂 onNotification 也行)

  function push(notification: { method: string; params: unknown }): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = []
    const { method, params } = notification

    // 过滤: 只关心本次 thread 的事件
    const p = (params ?? {}) as { threadId?: string; turn?: { id?: string; status?: string } }
    if (p.threadId && p.threadId !== opts.threadId) {
      // 其它 turn 的事件, 忽略
      return out
    }

    switch (method) {
      case 'turn/started': {
        out.push({ type: 'turn_start', turnCount: opts.turnCount })
        return out
      }

      case 'item/started': {
        const paramsObj = (params ?? {}) as { item?: unknown }
        const item = extractItem(paramsObj.item)
        const id = item.id ?? `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const t = itemType(item)
        if (t === 'commandExecution' || t === 'fileChange' || t === 'mcpToolCall') {
          const name = t === 'mcpToolCall'
            ? `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`
            : t === 'commandExecution' ? 'bash' : 'edit'
          startedItems.set(id, { type: t, name, toolUseId: id })
          out.push({ type: 'tool_use_start', toolName: name, toolUseId: id })
        }
        // 文本类 (agentMessage / reasoning) 不发 start, 等 completed 一次性给
        return out
      }

      case 'item/agentMessage/delta': {
        // codex 在 agentMessage 流式输出时推送此 notification, params:
        //   { threadId, turnId, itemId, delta }
        // 多个 delta 按 itemId 顺序拼接即得完整回复. 这里直接推 stream_delta.
        const paramsObj = (params ?? {}) as {
          threadId?: string
          itemId?: string
          turnId?: string
          delta?: string
        }
        if (paramsObj.threadId && paramsObj.threadId !== opts.threadId) {
          // 其它 thread 的 delta, 忽略
          return out
        }
        const delta = paramsObj.delta ?? ''
        if (delta) {
          out.push({ type: 'stream_delta', text: delta })
        }
        return out
      }

      case 'item/completed': {
        const paramsObj = (params ?? {}) as { item?: unknown }
        const item = extractItem(paramsObj.item)
        const id = item.id ?? 'unknown'
        const t = itemType(item)

        if (t === 'agentMessage') {
          // 注意: 完整文本已经在 item/agentMessage/delta 阶段逐 token 推过 stream_delta 了,
          // 这里不要再推一次, 否则前端会看到 "打字很快 -> 整段叠加上来" 的非流式观感.
          // 仅作为流结束的信号使用 (消费者据此知道 agentMessage 已经收尾).
          return out
        }
        if (t === 'reasoning') {
          // reasoning 同样: 如果有 thinking_delta 流式, completed 不再补全;
          // 若没收到过 delta (例如非流模式), 才用 completed 补一次.
          // 但当前 codex 协议里 reasoning 也会推 reasoning/summaryDelta 之类的流式通知,
          // 暂时保持兼容: 没收到过 summary 时, 用 completed 补一次.
          const text = item.summary?.join('\n') ?? item.content?.toString() ?? ''
          if (text) out.push({ type: 'thinking_delta', text })
          return out
        }
        if (t === 'commandExecution' || t === 'fileChange' || t === 'mcpToolCall') {
          const started = startedItems.get(id) ?? {
            type: t,
            name: t === 'mcpToolCall' ? 'mcp' : t === 'commandExecution' ? 'bash' : 'edit',
            toolUseId: id,
          }
          const isErr = item.status === 'failed' || item.status === 'declined' || !!item.error
          const content = (() => {
            if (t === 'commandExecution') return item.aggregatedOutput ?? ''
            if (t === 'fileChange') {
              const lines = (item.changes ?? []).map((c) => `${c.kind} ${c.path}`)
              return lines.join('\n')
            }
            // mcpToolCall
            if (item.error) return `error: ${item.error.message ?? JSON.stringify(item.error)}`
            return item.result ? JSON.stringify(item.result) : ''
          })()
          out.push({ type: 'tool_use_end', toolName: started.name ?? t, toolUseId: id, isError: isErr })
          out.push({
            type: 'tool_use_result',
            toolName: started.name ?? t,
            result: { toolUseId: id, content, isError: isErr },
          })
          startedItems.delete(id)
          return out
        }
        // 其它类型忽略 (imageView, webSearch, review mode 等)
        return out
      }

      case 'thread/tokenUsage/updated': {
        // codex app-server 在 turn 过程中或结束时推送 token usage.
        // 格式: { threadId, usage: { input_tokens, cached_input_tokens, output_tokens } }
        // 我们缓存它, 等 turn/completed 时用.
        const p = (params ?? {}) as {
          threadId?: string
          usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
        }
        if (p.usage) {
          const inT = p.usage.input_tokens ?? 0
          const outT = p.usage.output_tokens ?? 0
          const cacheRead = p.usage.cached_input_tokens ?? 0
          cachedUsage = {
            inputTokens: inT,
            outputTokens: outT,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: 0,
            totalTokens: inT + outT,
            totalCostUsd: 0,
          }
          logger.debug(`tokenUsage updated: in=${inT} out=${outT} cache=${cacheRead}`)
        }
        return out
      }

      case 'turn/completed': {
        if (turnEnded) return out
        turnEnded = true
        // 优先用 thread/tokenUsage/updated 缓存的 usage;
        // 如果没收到过 (某些 codex 版本不推), fallback 到 turn/completed.params.turn.usage
        const usage = cachedUsage ?? extractUsage(params)
        out.push({ type: 'turn_end', turnCount: opts.turnCount, usage })
        return out
      }

      case 'error': {
        const errObj = (params ?? {}) as { message?: string }
        lastError = errObj.message ?? 'unknown codex error'
        out.push({ type: 'error', data: lastError })
        turnEnded = true
        return out
      }

      default:
        // 未关心的事件, 忽略
        if (process.env.CODEX_DEBUG === '1') {
          logger.debug(`unhandled notification: ${method}`)
        }
        return out
    }
  }

  function flushDone(reason: 'end_turn' | 'cancelled' | 'error', errMsg?: string): AgentStreamEvent[] {
    if (turnEnded && reason !== 'error') {
      // 正常结束: 不重复 flush done
      return []
    }
    turnEnded = true
    if (reason === 'error') {
      return [{ type: 'error', data: errMsg ?? 'codex turn failed' }]
    }
    if (reason === 'cancelled') {
      return [{ type: 'stop', reason: { reason: 'cancelled' } }]
    }
    return []
  }

  function dispose(): void {
    startedItems.clear()
  }

  function isTurnEnded(): boolean {
    return turnEnded
  }

  return { push, dispose, isTurnEnded, flushDone }
}

/**
 * 在 JsonRpcClient 上挂订阅, 把推送的 notification 喂给 bridge,
 * 产出的 AgentStreamEvent 推到 out 队列.
 *
 * 返回 unsubscribe 函数.
 */
export function bindBridgeToClient(
  client: JsonRpcClient,
  bridge: BridgeHandle,
  out: AgentStreamEvent[],
): () => void {
  const unbind = client.onAnyNotification((method, params) => {
    try {
      const events = bridge.push({ method, params })
      if (events.length > 0) {
        for (const e of events) out.push(e)
      }
    } catch (err) {
      logger.warn(`bridge push failed for ${method}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  return unbind
}
