import * as fs from 'fs'
import * as path from 'path'
import type { Session } from './session.js'
import type { Message } from '../core/types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('session-store')

type JsonlEntry =
  | { type: 'meta'; id: string; createdAt: number; config: Session['config'] }
  | { type: 'message'; message: Message }
  | { type: 'usage'; usage: Session['usage'] }
  | { type: 'status'; status: Session['status']; error?: string; updatedAt: number }

export class SessionStore {
  private sessions: Map<string, Session> = new Map()
  private storeDir: string
  private dirty: Set<string> = new Set()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushIntervalMs: number
  private appendQueues: Map<string, JsonlEntry[]> = new Map()
  private appendTimer: ReturnType<typeof setTimeout> | null = null
  private appendIntervalMs = 200

  constructor(storeDir?: string, flushIntervalMs = 5000) {
    this.storeDir = storeDir ?? path.resolve(process.cwd(), 'data', 'sessions')
    this.flushIntervalMs = flushIntervalMs
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true })
    }

    await this.loadAllFromDisk()
    this.startFlushTimer()

    logger.info(`SessionStore initialized, dir=${this.storeDir}, loaded=${this.sessions.size} sessions`)
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  set(session: Session): void {
    this.sessions.set(session.id, session)
    this.dirty.add(session.id)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  delete(id: string): boolean {
    const existed = this.sessions.delete(id)
    this.dirty.delete(id)
    this.appendQueues.delete(id)
    if (existed) {
      const metaPath = this.getMetaFilePath(id)
      const jsonlPath = this.getJsonlFilePath(id)
      try { fs.unlinkSync(metaPath) } catch { /* ignore */ }
      try { fs.unlinkSync(jsonlPath) } catch { /* ignore */ }
      logger.info(`Session ${id} deleted from disk`)
    }
    return existed
  }

  values(): IterableIterator<Session> {
    return this.sessions.values()
  }

  size(): number {
    return this.sessions.size
  }

  markDirty(id: string): void {
    if (this.sessions.has(id)) {
      this.dirty.add(id)
    }
  }

  appendMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.messages.push(message)
    session.updatedAt = Date.now()

    this.enqueueEntry(sessionId, { type: 'message', message })
  }

  appendUsage(sessionId: string, usage: Session['usage']): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.usage = {
      inputTokens: session.usage.inputTokens + usage.inputTokens,
      outputTokens: session.usage.outputTokens + usage.outputTokens,
      cacheReadInputTokens: session.usage.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens: session.usage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      totalTokens: session.usage.totalTokens + usage.totalTokens,
      totalCostUsd: session.usage.totalCostUsd + usage.totalCostUsd,
    }
    session.updatedAt = Date.now()

    this.enqueueEntry(sessionId, { type: 'usage', usage: session.usage })
  }

  updateStatus(sessionId: string, status: Session['status'], error?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.status = status
    session.error = error
    session.updatedAt = Date.now()

    this.enqueueEntry(sessionId, { type: 'status', status, error, updatedAt: session.updatedAt })
  }

  async flush(): Promise<void> {
    await this.flushAppendQueues()

    if (this.dirty.size === 0) return

    const ids = Array.from(this.dirty)
    this.dirty.clear()

    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue

      try {
        this.writeMetaFile(session)
      } catch (error) {
        logger.error(`Failed to flush session meta ${id}: ${error instanceof Error ? error.message : String(error)}`)
        this.dirty.add(id)
      }
    }

    logger.debug(`Flushed ${ids.length} session meta(s) to disk`)
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.appendTimer) {
      clearInterval(this.appendTimer)
      this.appendTimer = null
    }
    await this.flushAppendQueues()
    await this.flush()
    logger.info('SessionStore shutdown complete')
  }

  private enqueueEntry(sessionId: string, entry: JsonlEntry): void {
    if (!this.appendQueues.has(sessionId)) {
      this.appendQueues.set(sessionId, [])
    }
    this.appendQueues.get(sessionId)!.push(entry)

    if (!this.appendTimer) {
      this.appendTimer = setTimeout(() => {
        this.flushAppendQueues().catch(err => {
          logger.error(`Append flush failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }, this.appendIntervalMs)
      this.appendTimer.unref()
    }
  }

  private async flushAppendQueues(): Promise<void> {
    if (this.appendTimer) {
      clearTimeout(this.appendTimer)
      this.appendTimer = null
    }

    for (const [sessionId, entries] of this.appendQueues) {
      if (entries.length === 0) continue

      try {
        const jsonlPath = this.getJsonlFilePath(sessionId)
        const dir = path.dirname(jsonlPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
        fs.appendFileSync(jsonlPath, lines, 'utf-8')
      } catch (error) {
        logger.error(`Failed to append JSONL for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.appendQueues.clear()
  }

  private writeMetaFile(session: Session): void {
    const metaPath = this.getMetaFilePath(session.id)
    const dir = path.dirname(metaPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const meta = {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      config: session.config,
      status: session.status,
      error: session.error,
      messageCount: session.messages.length,
      usage: session.usage,
    }

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
  }

  private getMetaFilePath(id: string): string {
    return path.join(this.storeDir, `${id}.meta.json`)
  }

  private getJsonlFilePath(id: string): string {
    return path.join(this.storeDir, `${id}.jsonl`)
  }

  private async loadAllFromDisk(): Promise<void> {
    if (!fs.existsSync(this.storeDir)) return

    const files = fs.readdirSync(this.storeDir)
    const metaFiles = files.filter(f => f.endsWith('.meta.json'))
    let loaded = 0

    for (const metaFile of metaFiles) {
      try {
        const metaPath = path.join(this.storeDir, metaFile)
        const metaContent = fs.readFileSync(metaPath, 'utf-8')
        const meta = JSON.parse(metaContent) as {
          id: string
          createdAt: number
          updatedAt: number
          config: Session['config']
          status: Session['status']
          error?: string
          messageCount: number
          usage: Session['usage']
        }

        const sessionId = meta.id
        const messages = this.loadJsonlMessages(sessionId)

        const session: Session = {
          id: meta.id,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          config: meta.config,
          messages,
          usage: meta.usage,
          status: meta.status,
          error: meta.error,
        }

        this.sessions.set(session.id, session)
        loaded++
      } catch (error) {
        logger.warn(`Failed to load session from ${metaFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const legacyFiles = files.filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'))
    for (const legacyFile of legacyFiles) {
      try {
        const content = fs.readFileSync(path.join(this.storeDir, legacyFile), 'utf-8')
        const data = JSON.parse(content) as {
          id: string
          createdAt: number
          updatedAt: number
          config: Session['config']
          messages: Message[]
          usage: Session['usage']
          status: Session['status']
          error?: string
        }

        if (this.sessions.has(data.id)) continue

        const session: Session = {
          id: data.id,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          config: data.config,
          messages: data.messages,
          usage: data.usage,
          status: data.status,
          error: data.error,
        }

        this.sessions.set(session.id, session)
        this.writeMetaFile(session)

        const jsonlPath = this.getJsonlFilePath(data.id)
        if (!fs.existsSync(jsonlPath)) {
          const lines = data.messages.map((m: Message) =>
            JSON.stringify({ type: 'message', message: m } as JsonlEntry)
          ).join('\n') + '\n'
          fs.writeFileSync(jsonlPath, lines, 'utf-8')
        }

        const oldPath = path.join(this.storeDir, legacyFile)
        fs.unlinkSync(oldPath)

        loaded++
        logger.info(`Migrated legacy session ${data.id} to JSONL format`)
      } catch (error) {
        logger.warn(`Failed to migrate legacy session ${legacyFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (loaded > 0) {
      logger.info(`Loaded ${loaded} session(s) from disk`)
    }
  }

  private loadJsonlMessages(sessionId: string): Message[] {
    const jsonlPath = this.getJsonlFilePath(sessionId)
    if (!fs.existsSync(jsonlPath)) return []

    const messages: Message[] = []
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry
        if (entry.type === 'message') {
          messages.push(entry.message)
        }
      } catch {
        // skip malformed lines
      }
    }

    return messages
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        logger.error(`Periodic flush failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, this.flushIntervalMs)
  }
}

let storeInstance: SessionStore | null = null

export function getSessionStore(): SessionStore {
  if (!storeInstance) {
    storeInstance = new SessionStore()
  }
  return storeInstance
}

export function setSessionStore(store: SessionStore): void {
  storeInstance = store
}
