/**
 * SgaBackend — SGA agent 的 AgentBackend 实现
 *
 * 包裹现有的 runAgent (sga_template/src/agents/runner.ts), 对外暴露统一的 AgentBackend 接口.
 * 这是默认 backend, 所有现有用户行为不变.
 *
 * Handoff 实现:
 * - exportHandoff: 从 session.messages 取最近 20 轮 + 从 working set 压缩 + 从 memory manager 抽 keyFacts
 * - importHandoff: 把 recentMessages 追加到 session.messages 头, 把 keyFacts 写入 memory manager
 */

import { runAgent, type AgentRunOptions, type AgentRunResult } from './runner.js'
import type { AgentBackend, BackendStartOptions, BackendMessageOptions, BackendHealth, AgentInfo, Skill, HandoffBundle } from './backend.js'
import type { AgentStreamEvent } from '../core/types.js'
import { getHandoffStore, Blackboard, getMemoryExtractor } from './handoff/index.js'
import { createLogger } from '../utils/logger.js'
import { getMemoryManager } from '../memory/manager.js'
import { getWorkingSet } from '../memory/working-set-registry.js'

const logger = createLogger('sga-backend')

export class SgaBackend implements AgentBackend {
  readonly type = 'sga' as const
  readonly displayName = 'SGA (Comfy Workflow Agent)'

  private started = false
  private currentOptions: BackendStartOptions | null = null

  async start(opts: BackendStartOptions): Promise<void> {
    if (this.started) {
      logger.debug('SgaBackend already started, skipping')
      return
    }
    this.currentOptions = opts
    this.started = true
    logger.info(`SgaBackend started (cwd=${opts.cwd ?? process.cwd()})`)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.currentOptions = null
    logger.info('SgaBackend stopped')
  }

  isStarted(): boolean {
    return this.started
  }

  async *sendMessage(opts: BackendMessageOptions): AsyncIterable<AgentStreamEvent> {
    if (!this.started) await this.start({})
    // 委托给现有 runAgent. 用一个简单的 adapter 模式.
    // runAgent 接受 AgentRunOptions 并返回 AgentRunResult (一次性结果),
    // 但我们想要流式输出. 这里先适配为: 收集所有 events 再 yield.
    //
    // 真实情况: runAgent 内部其实有 onProgress 回调, 我们需要先重构为 AsyncIterable.
    // 临时方案: 用 runAgent 同步版本, 包装为单 yield.
    // TODO (Sprint 1.5): 拆分 runAgent 为 AsyncIterable 形式
    const queue: AgentStreamEvent[] = []
    // 包成对象, 避免 TS 在 try/finally 边界对 `let` 变量 narrowing
    const waitHandle: { resolve: ((value: void) => void) | null } = { resolve: null }
    let done = false
    let error: Error | null = null

    const runOptions: AgentRunOptions = {
      // Sprint 1: opts.systemPrompt 在 sendMessage 时不一定含 agentDefinition,
      // 兼容两种来源: opts 上的额外字段, 或单独字段. 此处先放空, 由调用方注入.
      agentDefinition: (opts as any).agentDefinition ?? (opts.systemPrompt as any)?.agentDefinition,
      prompt: opts.prompt,
      messages: opts.messages,
      tools: opts.tools ?? [],
      model: opts.model,
      provider: opts.provider,
      systemPrompt: opts.systemPrompt,
      parentContext: opts.toolUseContext,
      signal: opts.signal,
      stream: true,
      onProgress: (event: AgentStreamEvent) => {
        queue.push(event)
        const r = waitHandle.resolve
        if (r) {
          waitHandle.resolve = null
          r()
        }
      },
    }

    // 异步执行 runAgent, 通过 onProgress 推送事件
    const execPromise = (async () => {
      try {
        // runAgent 是导出的函数, 直接调用
        await runAgent(runOptions)
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err))
      } finally {
        done = true
        const r = waitHandle.resolve
        if (r) {
          waitHandle.resolve = null
          r()
        }
      }
    })()
    // 让 promise 漂着, 不被 unhandled rejection 检测
    execPromise.catch(() => {})

    while (true) {
      if (queue.length > 0) {
        const ev = queue.shift()!
        yield ev
        continue
      }
      if (error) throw error
      if (done) return
      await new Promise<void>(resolve => { waitHandle.resolve = resolve })
    }
  }

  async abort(_threadId?: string): Promise<void> {
    // 现有 runAgent 通过 signal 实现 abort; 调用方负责传 signal
    logger.debug('SgaBackend.abort called (handled via AbortSignal in sendMessage)')
  }

  async healthCheck(): Promise<BackendHealth> {
    const start = Date.now()
    try {
      // SGA 总是 in-process, 健康检查只看内存是否足够
      const mem = process.memoryUsage()
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024)
      const ok = heapUsedMB < 4096 // 4GB 上限
      return {
        ok,
        latencyMs: Date.now() - start,
        details: ok ? `heap=${heapUsedMB}MB` : `heap too high: ${heapUsedMB}MB`,
        version: '1.0.0',
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        details: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    const { getBuiltinAgentDefinitions } = await import('./index.js')
    return getBuiltinAgentDefinitions().map(a => ({
      name: a.name,
      description: a.description,
      isBuiltIn: a.isBuiltIn(),
    }))
  }

  async listSkills(): Promise<Skill[]> {
    const { getAllBundledSkills } = await import('../skills/bundled-registry.js')
    const all = getAllBundledSkills()
    return Object.entries(all).map(([name, def]: [string, any]) => ({
      name,
      description: def?.description ?? def?.frontmatter?.description ?? '',
      source: 'sga' as const,
    }))
  }

  async canExportHandoff(): Promise<boolean> {
    return true
  }

  async exportHandoff(sessionId: string): Promise<HandoffBundle | null> {
    if (!this.started) return null
    const extractor = getMemoryExtractor()
    const store = getHandoffStore()

    // 1. 取最近消息 (从 session store / 调用方注入)
    //    注: SGA 的 session 在 server 层管理, 这里从 opts / 全局拿到的是有限的.
    //    简化方案: 从 working set 拿锚点, 从 memory 拿 facts; messages 留给 caller 注入.
    const recentMessages = this.extractRecentMessages(sessionId)

    // 2. 压缩 working set
    let workingSetSummary = ''
    try {
      const ws = getWorkingSet()
      if (ws) {
        const anchors = (ws as any).getActiveAnchors?.() ?? (ws as any).getAnchors?.() ?? []
        workingSetSummary = anchors
          .slice(0, 10)
          .map((a: any, i: number) => `${i + 1}. ${typeof a === 'string' ? a : (a.summary ?? a.content ?? a.text ?? JSON.stringify(a))}`)
          .join('\n')
      }
    } catch (err) {
      logger.debug(`working set read skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 3. 抽 keyFacts
    const keyFacts = await extractor.extractKeyFacts({ sessionId, maxFacts: 20 })

    // 4. 抽 userPreferences
    const userPreferences = await extractor.extractUserPreferences()

    // 5. 读 session memory (简化: 取最近一次 extract 的摘要)
    let sessionMemory = ''
    try {
      const mm = getMemoryManager()
      if (mm) {
        sessionMemory = (mm as any).getSessionSummary?.(sessionId) ?? ''
      }
    } catch {
      // ignore
    }

    const bundle: HandoffBundle = {
      schemaVersion: 1,
      sessionId,
      sourceAgent: 'sga',
      exportedAt: Date.now(),
      recentMessages: recentMessages ?? [],
      workingSetSummary,
      sessionMemory,
      keyFacts,
      userPreferences: userPreferences as Record<string, string>,
      customNotes: 'Exported from SGA. Codex 接收后, AGENTS.md 中的指引继续生效.',
    }

    await store.write(bundle)
    return bundle
  }

  async importHandoff(bundle: HandoffBundle): Promise<void> {
    if (!this.started) await this.start({})
    logger.info(`Importing handoff bundle from ${bundle.sourceAgent} for session ${bundle.sessionId}`)

    // 1. 把 recentMessages 追加到 working memory (供后续 turn 使用)
    try {
      const ws = getWorkingSet()
      if (ws && bundle.recentMessages.length > 0) {
        // 把 messages 压缩成锚点加入 working set
        for (const m of bundle.recentMessages.slice(-5)) {
          const text = (m.content as any[])
            ?.filter((c: any) => c.type === 'text')
            ?.map((c: any) => c.text)
            ?.join(' ')
            ?.slice(0, 500)
          if (text && (ws as any).addAnchor) {
            ;(ws as any).addAnchor({
              summary: `[handoff-from-${bundle.sourceAgent}] ${text}`,
              source: `handoff:${bundle.exportedAt}`,
              timestamp: bundle.exportedAt,
            })
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to inject handoff messages into working set: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 2. 把 keyFacts 写入 memory manager
    try {
      const mm = getMemoryManager()
      if (mm && bundle.keyFacts.length > 0) {
        for (const f of bundle.keyFacts) {
          // 尝试常见 API
          await (mm as any).remember?.(f) ??
            (mm as any).addFact?.(f) ??
            (mm as any).add?.(f)
        }
      }
    } catch (err) {
      logger.warn(`Failed to write keyFacts to memory: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 3. 更新 blackboard
    try {
      const bb = new Blackboard()
      for (const [k, v] of Object.entries(bundle.userPreferences)) {
        if (v !== undefined) {
          await bb.update({ userPreferences: { [k]: v } })
        }
      }
      await bb.logAction('sga', `import-handoff from ${bundle.sourceAgent} (${bundle.keyFacts.length} facts, ${bundle.recentMessages.length} msgs)`)
    } catch (err) {
      logger.debug(`Blackboard update skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    logger.info(`Handoff import complete: ${bundle.keyFacts.length} keyFacts, ${bundle.recentMessages.length} msgs`)
  }

  private extractRecentMessages(sessionId: string): HandoffBundle['recentMessages'] {
    // 简化: 从全局 session 拿
    try {
      const { getSessionStore } = require('../server/session-store.js')
      const store = getSessionStore()
      const session = store.get(sessionId)
      if (!session) return []
      return (session.messages ?? []).slice(-20)
    } catch {
      return []
    }
  }
}

let _sga: SgaBackend | null = null
export function getSgaBackend(): SgaBackend {
  if (!_sga) _sga = new SgaBackend()
  return _sga
}
