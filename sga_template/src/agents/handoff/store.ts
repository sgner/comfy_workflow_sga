/**
 * HandoffBundle 持久化存储
 *
 * 文件布局:
 *   <SGA_HOME>/handoff/
 *     <sessionId>.json           # 主 bundle
 *     <sessionId>.history.json   # 历史切换记录 (最近 5 次)
 *
 * 单写多读: 同一时刻只允许一个 source agent 写入; target agent 读后即删.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../../memory/paths.js'
import { createLogger } from '../../utils/logger.js'
import type { HandoffBundle } from '../backend.js'
import type { AgentType } from '../backend.js'
import { HandoffImportError } from '../backend.js'

const logger = createLogger('handoff-store')

export interface HandoffStoreOptions {
  /** SGA_HOME 覆盖, 测试用 */
  sgaHome?: string
  /** 保留的 history 数量 */
  maxHistory?: number
}

export interface HandoffAuditRecord {
  sessionId: string
  fromAgent: AgentType
  toAgent: AgentType
  switchedAt: number
  activeAgent: AgentType
  lastExport: {
    ok: boolean
    sourceAgent: AgentType
    messageCount: number
    keyFactCount: number
    error?: string
  }
  lastImport: {
    ok: boolean
    targetAgent: AgentType
    error?: string
  }
  warnings: string[]
  errors: string[]
}

export class HandoffStore {
  private readonly baseDir: string
  private readonly maxHistory: number

  constructor(opts: HandoffStoreOptions = {}) {
    this.baseDir = join(opts.sgaHome ?? getSgaHome(), 'handoff')
    this.maxHistory = opts.maxHistory ?? 5
  }

  private fileFor(sessionId: string): string {
    return join(this.baseDir, `${this.sanitize(sessionId)}.json`)
  }

  private historyFileFor(sessionId: string): string {
    return join(this.baseDir, `${this.sanitize(sessionId)}.history.json`)
  }

  private auditFileFor(sessionId: string): string {
    return join(this.baseDir, `${this.sanitize(sessionId)}.audit.json`)
  }

  private sanitize(sessionId: string): string {
    // 防止路径注入
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true })
  }

  /** 写入 bundle, 同时追加一条 history 记录 */
  async write(bundle: HandoffBundle): Promise<void> {
    await this.ensureDir()
    const file = this.fileFor(bundle.sessionId)
    const tmp = `${file}.tmp`
    try {
      // 原子写: 先写 .tmp, 再 rename
      await fs.writeFile(tmp, JSON.stringify(bundle, null, 2), 'utf-8')
      await fs.rename(tmp, file)
      logger.info(`Wrote handoff bundle to ${file} (source=${bundle.sourceAgent}, msgs=${bundle.recentMessages.length})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to write handoff bundle: ${msg}`)
      throw err
    }
    await this.appendHistory(bundle)
  }

  /** 读取 bundle. 读完即删 (one-shot). */
  async consume(sessionId: string): Promise<HandoffBundle | null> {
    const file = this.fileFor(sessionId)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const bundle = JSON.parse(raw) as HandoffBundle
      // 校验 schema
      if (bundle.schemaVersion !== 1) {
        throw new HandoffImportError(sessionId, `unsupported schemaVersion: ${bundle.schemaVersion}`)
      }
      // 读后即删
      try {
        await fs.unlink(file)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('ENOENT')) {
          logger.warn(`Failed to delete consumed bundle: ${msg}`)
        }
      }
      logger.info(`Consumed handoff bundle for session ${sessionId} (source=${bundle.sourceAgent})`)
      return bundle
    } catch (err) {
      if (err instanceof HandoffImportError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT')) return null
      throw new HandoffImportError(sessionId, msg)
    }
  }

  /** 仅读取, 不删除 (用于 UI 显示 "上次交接来自...") */
  async peek(sessionId: string): Promise<HandoffBundle | null> {
    const file = this.fileFor(sessionId)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      return JSON.parse(raw) as HandoffBundle
    } catch {
      return null
    }
  }

  /** 追加 history 记录 */
  private async appendHistory(bundle: HandoffBundle): Promise<void> {
    const file = this.historyFileFor(bundle.sessionId)
    let history: Array<Pick<HandoffBundle, 'sourceAgent' | 'exportedAt' | 'sessionId'>> = []
    try {
      const raw = await fs.readFile(file, 'utf-8')
      history = JSON.parse(raw)
    } catch {
      // 文件不存在则创建新数组
    }
    history.push({
      sessionId: bundle.sessionId,
      sourceAgent: bundle.sourceAgent,
      exportedAt: bundle.exportedAt,
    })
    // 保留最近 N 条
    if (history.length > this.maxHistory) {
      history = history.slice(-this.maxHistory)
    }
    await fs.writeFile(file, JSON.stringify(history, null, 2), 'utf-8')
  }

  /** 删除 session 的所有 handoff 数据 (session 删除时调用) */
  async clear(sessionId: string): Promise<void> {
    const sanitized = this.sanitize(sessionId)
    await Promise.allSettled([
      fs.unlink(this.fileFor(sessionId)).catch(() => {}),
      fs.unlink(this.historyFileFor(sessionId)).catch(() => {}),
      fs.unlink(this.auditFileFor(sessionId)).catch(() => {}),
    ])
    logger.debug(`Cleared handoff for session ${sanitized}`)
  }

  async writeAudit(record: HandoffAuditRecord): Promise<void> {
    await this.ensureDir()
    const file = this.auditFileFor(record.sessionId)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8')
    await fs.rename(tmp, file)
  }

  async readAudit(sessionId: string): Promise<HandoffAuditRecord | null> {
    try {
      const raw = await fs.readFile(this.auditFileFor(sessionId), 'utf-8')
      return JSON.parse(raw) as HandoffAuditRecord
    } catch {
      return null
    }
  }
}

let _store: HandoffStore | null = null
export function getHandoffStore(opts?: HandoffStoreOptions): HandoffStore {
  if (!_store) _store = new HandoffStore(opts)
  return _store
}
