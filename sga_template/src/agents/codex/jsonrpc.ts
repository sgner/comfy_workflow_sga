/**
 * JSON-RPC "lite" 客户端 (针对 Codex app-server)
 *
 * 与标准 JSON-RPC 2.0 的差异 (见 codex-rs/app-server-protocol/src/jsonrpc_lite.rs):
 *   - 不强制带 "jsonrpc": "2.0" 字段 (codex 实现忽略, 我们也不发)
 *   - id 允许 String 或 Integer
 *
 * 核心能力:
 *   - sendRequest(method, params) => Promise<result>    阻塞到拿到 response
 *   - sendNotification(method, params)                  发完就忘
 *   - onNotification(method, cb)                        订阅 server 推过来的事件
 *   - onError(cb) / onClose(cb)                         错误 / 关闭回调
 *
 * 帧格式: 每行一个 JSON, 以 '\n' 分隔. 这是 LSP / JSON-RPC over stdio 的标准做法.
 */

import { createLogger } from '../../utils/logger.js'
import type { CodexProcessHandle } from './process.js'

const logger = createLogger('codex-jsonrpc')

export type RequestId = string | number

export interface JsonRpcResponse {
  id: RequestId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

export type JsonRpcRequest = {
  jsonrpc?: '2.0'
  id: RequestId
  method: string
  params?: unknown
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface JsonRpcClient {
  /** 发送请求, 阻塞到拿到 response (含 error) */
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R>
  /** 发送单向通知, 不等响应 */
  sendNotification(method: string, params?: unknown): void
  /** 订阅 server 推过来的 notification (按 method 过滤) */
  onNotification(method: string, cb: (params: unknown) => void): () => void
  /** 订阅所有未匹配的 notification (debug 用) */
  onAnyNotification(cb: (method: string, params: unknown) => void): () => void
  /** 底层连接关闭时触发 */
  onClose(cb: () => void): () => void
  /** 解析错误 (非法 JSON 等) 触发 */
  onError(cb: (err: Error) => void): () => void
  /** 关闭客户端 (不再收发) */
  close(): void
}

export function attachJsonRpcClient(proc: CodexProcessHandle): JsonRpcClient {
  const write = proc.getStdinWriter()

  // ---- id 分配 ----
  let nextId = 1
  const pending = new Map<RequestId, {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
    method: string
    startedAt: number
  }>()

  // ---- notification 路由 ----
  const notifByMethod = new Map<string, Array<(params: unknown) => void>>()
  const anyNotifCbs: Array<(method: string, params: unknown) => void> = []
  const closeCbs: Array<() => void> = []
  const errorCbs: Array<(err: Error) => void> = []

  function allocId(): RequestId {
    return nextId++
  }

  function sendRaw(frame: object): void {
    try {
      write(JSON.stringify(frame))
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      logger.error(`failed to encode frame: ${e.message}`)
      for (const cb of errorCbs) cb(e)
    }
  }

  function handleLine(line: string): void {
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(line) as JsonRpcFrame
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      logger.warn(`invalid JSON from codex: ${line.slice(0, 200)}`)
      for (const cb of errorCbs) cb(e)
      return
    }

    // debug 探针: 打印所有 frame
    if ('method' in frame && !('id' in frame)) {
      logger.info(`[codex notif] ${frame.method} ${JSON.stringify((frame as JsonRpcNotification).params).slice(0, 250)}`)
    } else if ('id' in frame && ('result' in frame || 'error' in frame)) {
      const resp = frame as JsonRpcResponse
      if (resp.error) {
        logger.warn(`[codex resp err] id=${String(resp.id)} ${JSON.stringify(resp.error).slice(0, 200)}`)
      } else {
        logger.debug(`[codex resp ok] id=${String(resp.id)}`)
      }
    }

    // response (id 命中 pending) — 不管 result 还是 error 都 resolve/reject
    if ('id' in frame && (frame as { result?: unknown }).result !== undefined ||
        'id' in frame && (frame as { error?: unknown }).error !== undefined) {
      const resp = frame as JsonRpcResponse
      const entry = pending.get(resp.id)
      if (!entry) {
        logger.warn(`orphan response id=${String(resp.id)}, ignoring`)
        return
      }
      pending.delete(resp.id)
      if (resp.error) {
        entry.reject(Object.assign(
          new Error(`codex rpc error: ${resp.error.message} (code=${resp.error.code})`),
          { code: resp.error.code, data: resp.error.data, method: entry.method },
        ))
      } else {
        entry.resolve(resp.result)
      }
      return
    }

    // request (server -> client): 我们当前不实现, 忽略
    if ('id' in frame && 'method' in frame) {
      logger.debug(`ignoring server->client request method=${(frame as { method: string }).method}`)
      return
    }

    // notification (server -> client)
    if ('method' in frame) {
      const notif = frame as JsonRpcNotification
      const cbs = notifByMethod.get(notif.method)
      if (cbs) {
        for (const cb of cbs) {
          try {
            cb(notif.params)
          } catch (err) {
            logger.warn(`notification handler threw: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      for (const cb of anyNotifCbs) {
        try {
          cb(notif.method, notif.params)
        } catch (err) {
          logger.warn(`any-notification handler threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return
    }

    logger.warn(`unrecognized JSON-RPC frame: ${line.slice(0, 200)}`)
  }

  proc.onStdoutLine(handleLine)
  proc.onExit(() => {
    // 拒绝所有 in-flight 请求
    for (const [, entry] of pending) {
      entry.reject(new Error('codex process exited before response'))
    }
    pending.clear()
    for (const cb of closeCbs) {
      try { cb() } catch { /* ignore */ }
    }
  })

  return {
    sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
      const id = allocId()
      const frame: JsonRpcRequest = { id, method, params }
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, startedAt: Date.now() })
        sendRaw(frame)
      })
    },
    sendNotification(method: string, params?: unknown): void {
      sendRaw({ method, params })
    },
    onNotification(method: string, cb: (params: unknown) => void): () => void {
      let arr = notifByMethod.get(method)
      if (!arr) {
        arr = []
        notifByMethod.set(method, arr)
      }
      arr.push(cb)
      return () => {
        const list = notifByMethod.get(method)
        if (!list) return
        const idx = list.indexOf(cb)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    onAnyNotification(cb: (method: string, params: unknown) => void): () => void {
      anyNotifCbs.push(cb)
      return () => {
        const idx = anyNotifCbs.indexOf(cb)
        if (idx >= 0) anyNotifCbs.splice(idx, 1)
      }
    },
    onClose(cb: () => void): () => void {
      closeCbs.push(cb)
      return () => {
        const idx = closeCbs.indexOf(cb)
        if (idx >= 0) closeCbs.splice(idx, 1)
      }
    },
    onError(cb: (err: Error) => void): () => void {
      errorCbs.push(cb)
      return () => {
        const idx = errorCbs.indexOf(cb)
        if (idx >= 0) errorCbs.splice(idx, 1)
      }
    },
    close(): void {
      notifByMethod.clear()
      anyNotifCbs.length = 0
      closeCbs.length = 0
      errorCbs.length = 0
      for (const [, entry] of pending) {
        entry.reject(new Error('jsonrpc client closed'))
      }
      pending.clear()
    },
  }
}
