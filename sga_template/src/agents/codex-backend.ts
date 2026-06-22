/**
 * CodexBackend — Codex 子进程后端
 *
 * 实现 AgentBackend, 内部通过 stdio JSON-RPC 跟 `codex app-server` 子进程通讯.
 *
 * 启动时序:
 *   1. start(opts)               -> spawn codex app-server
 *   2. sendRequest('initialize') -> 握手 (拿到 userAgent / codexHome / platform)
 *   3. (后续) sendRequest('thread/start', { model, cwd, ... })
 *   4. sendMessage(prompt)       -> sendRequest('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
 *   5. 监听 item/started / item/completed / turn/completed notification, 桥接为 AgentStreamEvent
 *
 * 状态机:
 *   - constructed -> binary probed
 *   - start()     -> subprocess + initialize (once)
 *   - per-message -> thread/start (lazy) + turn/start
 *   - stop()      -> kill subprocess
 *
 * 错误处理:
 *   - binary 不存在 -> BackendNotAvailableError, isAvailable() = false
 *   - 子进程 crash   -> 抛 error, sendMessage 终止
 *   - 单次 RPC 失败  -> 透传
 */

import { spawn, type ChildProcess } from 'child_process'
import type {
  AgentBackend,
  BackendStartOptions,
  BackendMessageOptions,
  BackendHealth,
  AgentInfo,
  Skill,
  HandoffBundle,
} from './backend.js'
import type { AgentStreamEvent } from '../core/types.js'
import { BackendNotAvailableError } from './backend.js'
import {
  detectCodexBinary,
  formatCodexBinary,
  spawnCodexAppServer,
  attachJsonRpcClient,
  createEventBridge,
  bindBridgeToClient,
  startCodexProviderProxy,
  writeCodexConfig,
  type CodexBinaryInfo,
  type CodexProcessHandle,
  type CodexProxyHandle,
  type CodexConfigHandle,
  type JsonRpcClient,
} from './codex/index.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('codex-backend')

/** 保存 start() 的 cwd 等上下文, 用于后续 turn */
interface CodexSessionState {
  proc: CodexProcessHandle
  client: JsonRpcClient
  threadId: string | null
  cwd: string
  model: string
  initializeInfo: unknown
  proxy: CodexProxyHandle | null   // 反代 (如果启动时给了 provider)
  config: CodexConfigHandle | null // 临时 config.toml
}

export class CodexBackend implements AgentBackend {
  readonly type = 'codex' as const
  readonly displayName = 'Codex (CLI coding agent)'

  private binary: CodexBinaryInfo | null
  private started = false
  private state: CodexSessionState | null = null
  private startAttempts = 0
  private lastStartError: string | null = null
  private turnCount = 0
  /** 上次 start() 用的 provider 指纹, 用来判断是否需要重启 codex 子进程 */
  private lastProviderKey: string | null = null
  /** 崩溃重启计数 (每次成功 start() 后重置为 0) */
  private restartCount = 0
  /** 最大重启次数, 超过后标记 backend unavailable */
  private readonly maxRestarts = parseInt(process.env.CODEX_MAX_RESTARTS ?? '1', 10)
  /** stop() 主动停止标志, exit 事件处理器据此跳过重启 */
  private stopping = false

  constructor() {
    this.binary = detectCodexBinary()
    if (this.binary) {
      logger.info(`CodexBackend ready: ${formatCodexBinary(this.binary)}`)
    } else {
      logger.warn('CodexBackend unavailable: binary not found. Run scripts/build-codex.ps1 to build it.')
    }
  }

  isAvailable(): boolean {
    return this.binary !== null
  }

  getBinaryInfo(): CodexBinaryInfo | null {
    return this.binary
  }

  async start(opts: BackendStartOptions): Promise<void> {
    if (!this.binary) {
      throw new BackendNotAvailableError(
        'codex',
        'codex binary not found. Build it via scripts/build-codex.ps1 or set CODEX_BINARY env.',
      )
    }

    // 计算 provider 指纹. 如果跟上次不一样, 必须重启 codex 子进程,
    // 因为反代 baseUrl / apiKey / config.toml 都变了, 旧子进程还在连旧反代.
    const providerCfg = opts.provider
      ? (opts.provider as { config?: { apiKey?: string; baseUrl?: string; name?: string } }).config
      : undefined
    const providerKey = providerCfg
      ? `${providerCfg.name ?? 'sga'}@${providerCfg.baseUrl ?? 'default'}#${(providerCfg.apiKey ?? '').slice(0, 6)}`
      : 'none'

    if (this.started && this.state) {
      if (providerKey === this.lastProviderKey) {
        // 同一个 provider, 复用子进程
        return
      }
      logger.info(`provider changed (${this.lastProviderKey} -> ${providerKey}), restarting codex subprocess`)
      await this.stop()
    }

    // 清除 stop() 设置的标志, 让新子进程的 exit 事件能触发自动重启
    this.stopping = false

    this.startAttempts += 1
    this.lastStartError = null

    const cwd = opts.cwd ?? process.cwd()
    const model = (opts as { model?: string }).model ?? process.env.CODEX_DEFAULT_MODEL ?? 'gpt-5-codex'

    // 1. 启动反代 (如果有 provider 配置) + 写 config.toml
    //    这样 codex 起来后, 所有 /v1/responses 请求都会被反代收下, 翻译后转给真实供应商.
    let proxy: CodexProxyHandle | null = null
    let config: CodexConfigHandle | null = null
    let extraEnv: Record<string, string> = {
      CODEX_PROJECT_ROOT: process.env.CODEX_PROJECT_ROOT ?? '',
    }

    if (opts.provider && providerCfg?.apiKey) {
      try {
        proxy = await startCodexProviderProxy({
          provider: {
            name: providerCfg.name ?? 'sga',
            apiKey: providerCfg.apiKey,
            baseUrl: providerCfg.baseUrl ?? 'https://api.openai.com/v1',
            headers: (providerCfg as { headers?: Record<string, string> }).headers,
          } as never,
        })
        const providerTag = (providerCfg.name ?? 'sga').replace(/[^a-zA-Z0-9_]/g, '_')
        config = writeCodexConfig({
          proxyBaseUrl: proxy.baseUrl,
          providerName: `sga_${providerTag}`,
          providerDisplayName: providerCfg.name ?? 'SGA Provider',
          model,
          sandbox: 'workspace-write',
        })
        extraEnv = {
          ...extraEnv,
          CODEX_HOME: config.codexHome,
          OPENAI_API_KEY: providerCfg.apiKey, // codex 从 env_key 读
        }
        logger.info(`provider-proxy up: ${proxy.baseUrl} -> ${providerCfg.baseUrl} (key length=${providerCfg.apiKey.length})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`failed to start provider-proxy: ${msg}. Falling back to codex without provider.`)
        if (proxy) {
          try { await proxy.close() } catch { /* ignore */ }
        }
        proxy = null
        config = null
      }
    } else if (opts.provider && !providerCfg?.apiKey) {
      logger.warn('provider has no apiKey configured, codex will fall back to default auth')
    }

    // 2. spawn codex app-server
    let proc: CodexProcessHandle
    try {
      proc = spawnCodexAppServer(this.binary, {
        cwd,
        sandbox: 'workspace-write',
        extraEnv,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastStartError = msg
      if (proxy) try { await proxy.close() } catch { /* ignore */ }
      if (config) try { config.cleanup() } catch { /* ignore */ }
      throw new BackendNotAvailableError('codex', `failed to spawn codex: ${msg}`)
    }

    const client = attachJsonRpcClient(proc)
    let initializeInfo: unknown
    try {
      initializeInfo = await client.sendRequest('initialize', {
        clientInfo: {
          name: 'sga-codex-backend',
          title: 'SGA Codex Backend',
          version: '0.4.0',
        },
        capabilities: {
          experimentalApi: false,
        },
      })
      logger.info(`codex initialize OK: ${JSON.stringify(initializeInfo).slice(0, 200)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastStartError = msg
      try { await proc.kill() } catch { /* ignore */ }
      if (proxy) try { await proxy.close() } catch { /* ignore */ }
      if (config) try { config.cleanup() } catch { /* ignore */ }
      throw new BackendNotAvailableError('codex', `codex initialize failed: ${msg}`)
    }

    this.state = {
      proc,
      client,
      threadId: null,
      cwd,
      model,
      initializeInfo,
      proxy,
      config,
    }
    this.started = true
    this.lastProviderKey = providerKey
    this.restartCount = 0

    // 监听子进程 exit: 非正常退出 (且非 stop() 触发) 时自动重启, 最多 maxRestarts 次
    const restartOpts: BackendStartOptions = { cwd, model, provider: opts.provider }
    proc.onExit((code, signal) => {
      void this.handleProcessExit(code, signal, restartOpts)
    })

    logger.info(`CodexBackend started (binary=${this.binary.path}, proxy=${proxy ? proxy.baseUrl : 'none'})`)
  }

  async stop(): Promise<void> {
    // 标记主动停止, exit 事件处理器据此跳过自动重启
    this.stopping = true
    if (this.state) {
      try {
        await this.state.proc.kill()
      } catch (err) {
        logger.warn(`failed to kill codex process: ${err instanceof Error ? err.message : String(err)}`)
      }
      // 关反代 + 清临时目录
      if (this.state.proxy) {
        try {
          await this.state.proxy.close()
        } catch (err) {
          logger.warn(`failed to close provider-proxy: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (this.state.config) {
        try {
          this.state.config.cleanup()
        } catch (err) {
          logger.warn(`failed to cleanup codex config: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      this.state = null
    }
    this.started = false
    this.lastProviderKey = null
    this.turnCount = 0
    logger.info('CodexBackend stopped')
  }

  /**
   * 处理 codex 子进程 exit 事件.
   * 由 proc.onExit 回调触发 (同步调用, 内部 async fire-and-forget).
   * - stop() 触发的退出 (this.stopping === true): 跳过, 不重启
   * - 正常退出 (code === 0): 跳过, 不重启
   * - 崩溃 (code !== 0): 若 restartCount < maxRestarts 则自动重启, 否则标记 unavailable
   */
  private async handleProcessExit(
    code: number | null,
    signal: string | null,
    restartOpts: BackendStartOptions,
  ): Promise<void> {
    // stop() 主动触发, 不重启
    if (this.stopping) return
    // 正常退出, 不重启
    if (code === 0) return

    if (this.restartCount < this.maxRestarts) {
      this.restartCount += 1
      logger.warn(
        `codex subprocess crashed (code=${code}, signal=${signal}), ` +
        `auto-restarting (${this.restartCount}/${this.maxRestarts})`,
      )
      // 清理旧状态: 进程已死, 但 proxy/config 可能还活着, 需要释放避免泄漏
      if (this.state?.proxy) {
        try { await this.state.proxy.close() } catch { /* ignore */ }
      }
      if (this.state?.config) {
        try { this.state.config.cleanup() } catch { /* ignore */ }
      }
      this.state = null
      this.started = false
      this.lastProviderKey = null
      // 用相同的 provider/model/cwd 重启
      try {
        await this.start(restartOpts)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`codex auto-restart failed: ${msg}, marking backend unavailable`)
        this.binary = null
      }
    } else {
      logger.error(
        `codex subprocess crashed (code=${code}, signal=${signal}), ` +
        `max restarts (${this.maxRestarts}) reached, marking backend unavailable`,
      )
      this.binary = null
    }
  }

  async *sendMessage(opts: BackendMessageOptions): AsyncIterable<AgentStreamEvent> {
    if (!this.binary) {
      throw new BackendNotAvailableError('codex', 'codex binary not found.')
    }
    if (!this.started || !this.state) {
      // 自动启动时把 provider 也带上, 这样第一次发消息就能起反代
      await this.start({ cwd: process.cwd(), model: opts.model, provider: opts.provider })
    }
    const state = this.state
    if (!state) {
      throw new BackendNotAvailableError('codex', 'backend not started')
    }

    this.turnCount += 1
    const turnCount = this.turnCount

    // 1. 拿到 threadId. 复用现有 thread 或新建.
    if (!state.threadId) {
      try {
        const resp = (await state.client.sendRequest('thread/start', {
          model: opts.model || state.model,
          cwd: state.cwd,
        })) as { thread?: { id?: string } }
        const threadId = resp?.thread?.id
        if (!threadId) {
          throw new Error('thread/start response missing thread.id')
        }
        state.threadId = threadId
        logger.info(`codex thread started: ${threadId}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        yield { type: 'error', data: `codex thread/start failed: ${msg}` }
        return
      }
    }

    // 2. 注册 bridge, 把 codex notification -> AgentStreamEvent 推到队列
    const queue: AgentStreamEvent[] = []
    const bridge = createEventBridge({
      turnCount,
      model: opts.model,
      sessionId: opts.prompt.slice(0, 32),
      threadId: state.threadId,
    })
    const unbind = bindBridgeToClient(state.client, bridge, queue)

    // 3. 推一个 session_start (SGA 抽象层要求的 "会话开始" 事件, codex
    //    没有对应概念, 我们在第一次 sendMessage 时合成一次).
    //    turn_start 由 bridge 在收到 turn/started notification 时自动推.
    queue.push({
      type: 'session_start',
      sessionId: state.threadId,
      model: opts.model,
      agentType: 'codex',
    })

    // 4. 发 turn/start. 失败时 yield error 并退出
    const turnStartPromise = state.client.sendRequest('turn/start', {
      threadId: state.threadId,
      input: [{ type: 'text', text: opts.prompt }],
    })

    // 5. 边收事件边 yield. 收到 turn/completed 或 error 时退出.
    // turnStartPromise 完成后, 并不代表 turn 结束, 只是请求已被 server 接受.
    // 真正的结束是 turn/completed notification (在 turnCount 用尽后由 bridge 推 turn_end).
    let rpcDone = false
    turnStartPromise
      .then(() => {
        rpcDone = true
        // 不主动 flush, 等 turn/completed
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`turn/start failed: ${msg}`)
        queue.push({ type: 'error', data: `codex turn/start failed: ${msg}` })
      })

    // 用于停转条件: turn/completed 已经推过 (bridge.turnEnded)
    // 或外部 abort.
    const abortHandler = (): void => {
      logger.info('sendMessage aborted by signal')
      queue.push({ type: 'stop', reason: { reason: 'cancelled' } })
    }
    if (opts.signal) {
      opts.signal.addEventListener('abort', abortHandler, { once: true })
    }

    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift()!
          yield ev
          if (ev.type === 'stop' || ev.type === 'error') {
            break
          }
          // 收到 turn_end 后, 看是否已经收到 done. 实际上 turn/completed
          // 只推 turn_end, done 由 sga 端 sendMessage 调用方在 turn_end 之后拼.
          // 我们这里如果 turn_end 出现, 视作 turn 收尾完成, 再 yield 一次 done.
          if (ev.type === 'turn_end') {
            // 不再 yield done, 让上层 routes.ts 处理 turn_end -> done
            break
          }
          continue
        }
        if (rpcDone && bridge.isTurnEnded()) {
          // 等不到新事件, 退出
          break
        }
        // 防御: 100ms 一次轮询
        await new Promise<void>((r) => setTimeout(r, 50))
      }
    } finally {
      unbind()
      bridge.dispose()
      if (opts.signal) {
        opts.signal.removeEventListener('abort', abortHandler)
      }
    }
  }

  async abort(_threadId?: string): Promise<void> {
    if (!this.state?.threadId) return
    try {
      // 尽力发 turn/interrupt; 没拿到 turnId 也无所谓, server 内部用 active turn
      await this.state.client.sendRequest('turn/interrupt', {
        threadId: this.state.threadId,
        // turnId 是 server 在 turn/started 时给的, 我们没记, 先传空串由 server fallback
        turnId: '',
      }).catch(() => undefined)
    } catch (err) {
      logger.warn(`abort failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async healthCheck(): Promise<BackendHealth> {
    const start = Date.now()
    if (!this.binary) {
      return {
        ok: false,
        latencyMs: 0,
        details: 'codex binary not found. Run scripts/build-codex.ps1 to build it.',
        version: '0.0.0-missing',
      }
    }
    if (!this.started || !this.state) {
      return {
        ok: false,
        latencyMs: 0,
        details: `codex binary available at ${this.binary.path} but backend not started`,
        version: this.binary.revision ? `git:${this.binary.revision}` : 'unknown',
      }
    }
    const alive = this.state.proc.pid > 0
    return {
      ok: alive,
      latencyMs: Date.now() - start,
      details: alive
        ? `running (threadId=${this.state.threadId ?? 'none'})`
        : (this.lastStartError ?? 'process not running'),
      version: this.binary.revision ? `git:${this.binary.revision}` : 'unknown',
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    if (!this.binary) return []
    return [
      { name: 'default', description: 'Codex default agent', isBuiltIn: true },
    ]
  }

  async listSkills(): Promise<Skill[]> {
    if (!this.binary) return []
    return []
  }

  async canExportHandoff(): Promise<boolean> {
    // Codex thread 是可恢复的, 所以总是可以
    return this.started && this.state !== null
  }

  async exportHandoff(sessionId: string): Promise<HandoffBundle | null> {
    if (!this.binary || !this.state) return null
    const state = this.state

    try {
      // 1. 通过 thread/loadedResources 拿当前 thread 的消息列表
      //    codex app-server 协议: sendRequest('thread/loadedResources', { threadId })
      //    返回 { items: ThreadItem[] } — 包含 userMessage / agentMessage / reasoning 等
      let threadItems: unknown[] = []
      if (state.threadId) {
        try {
          const resp = (await state.client.sendRequest('thread/loadedResources', {
            threadId: state.threadId,
          })) as { items?: unknown[] }
          threadItems = resp?.items ?? []
        } catch (err) {
          logger.warn(`exportHandoff: thread/loadedResources failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // 2. 把 ThreadItem 转成 SGA Message 格式
      const recentMessages: import('../core/types.js').Message[] = []
      for (const itemRaw of threadItems) {
        const item = (itemRaw ?? {}) as {
          type?: string
          text?: string
          content?: string | Array<{ type: string; text: string }>
          content_array?: Array<{ type: string; text: string }>
        }
        if (item.type === 'userMessage') {
          const text = typeof item.content === 'string'
            ? item.content
            : (item.content_array ?? item.content as Array<{ type: string; text: string }> ?? [])
                .map((c) => c.text ?? '')
                .join('')
          recentMessages.push({
            id: `codex-msg-${recentMessages.length}`,
            role: 'user',
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
          })
        } else if (item.type === 'agentMessage') {
          recentMessages.push({
            id: `codex-msg-${recentMessages.length}`,
            role: 'assistant',
            content: [{ type: 'text', text: item.text ?? '' }],
            timestamp: Date.now(),
          })
        }
      }

      // 3. 如果 loadedResources 没拿到消息, 至少把当前 prompt 作为一条 user message
      if (recentMessages.length === 0) {
        logger.info('exportHandoff: no thread items, returning minimal bundle')
      }

      const bundle: HandoffBundle = {
        schemaVersion: 1,
        sessionId,
        sourceAgent: 'codex',
        exportedAt: Date.now(),
        recentMessages,
        workingSetSummary: '',
        sessionMemory: '',
        keyFacts: [],
        userPreferences: {},
        customNotes: `Exported from codex thread ${state.threadId ?? 'unknown'}`,
      }
      logger.info(`exportHandoff: ${recentMessages.length} messages from thread ${state.threadId ?? 'none'}`)
      return bundle
    } catch (err) {
      logger.error(`exportHandoff failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async importHandoff(bundle: HandoffBundle): Promise<void> {
    if (!this.binary || !this.state) {
      logger.warn('importHandoff: backend not started, skipping')
      return
    }
    const state = this.state

    try {
      // 1. 如果还没有 thread, 先建一个
      if (!state.threadId) {
        try {
          const resp = (await state.client.sendRequest('thread/start', {
            model: state.model,
            cwd: state.cwd,
          })) as { thread?: { id?: string } }
          const threadId = resp?.thread?.id
          if (!threadId) {
            throw new Error('thread/start response missing thread.id')
          }
          state.threadId = threadId
          logger.info(`importHandoff: created thread ${threadId}`)
        } catch (err) {
          logger.error(`importHandoff: thread/start failed: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
      }

      // 2. 把 bundle.recentMessages 转成 codex input 格式, 作为 thread 的初始上下文
      //    codex turn/start 的 input 格式: [{ type: 'text', text: '...' }]
      //    我们把 recentMessages 拼成一条 "context" 消息发给 codex
      if (bundle.recentMessages.length > 0) {
        const contextLines: string[] = [
          '=== Previous conversation context (imported from handoff) ===',
          '',
        ]
        for (const msg of bundle.recentMessages) {
          const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System'
          const text = msg.content
            .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
            .join('')
          contextLines.push(`[${role}]: ${text}`)
        }
        contextLines.push('', '=== End of context ===', '')

        // 如果有 keyFacts, 也拼进去
        if (bundle.keyFacts.length > 0) {
          contextLines.push('=== Key facts from previous session ===')
          for (const kf of bundle.keyFacts) {
            contextLines.push(`- [${kf.category}] ${kf.fact}`)
          }
          contextLines.push('=== End of key facts ===', '')
        }

        // 如果有 sessionMemory, 也加进去
        if (bundle.sessionMemory) {
          contextLines.push('=== Session memory ===')
          contextLines.push(bundle.sessionMemory)
          contextLines.push('=== End of session memory ===', '')
        }

        const contextText = contextLines.join('\n')

        // 发一条 turn 把上下文喂给 codex (不等 turn 完成, fire and forget)
        try {
          await state.client.sendRequest('turn/start', {
            threadId: state.threadId,
            input: [{ type: 'text', text: contextText }],
          })
          logger.info(`importHandoff: injected ${bundle.recentMessages.length} messages + ${bundle.keyFacts.length} keyFacts into thread ${state.threadId}`)
        } catch (err) {
          logger.warn(`importHandoff: turn/start for context injection failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      logger.error(`importHandoff failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

let _codex: CodexBackend | null = null
export function getCodexBackend(): CodexBackend {
  if (!_codex) _codex = new CodexBackend()
  return _codex
}
