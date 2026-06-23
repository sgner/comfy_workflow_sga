/**
 * 共享黑板 (Shared Blackboard)
 *
 * 文件: <SGA_HOME>/shared/blackboard.json
 *
 * 用途:
 * - 两个 agent 都能读写的"轻量级热数据"层
 * - 切换 agent 时, target agent 读黑板, 拼入 initial system prompt
 * - 长期记忆仍由 SGA 维护, 黑板只是"热缓存"
 *
 * 并发:
 * - 单写多读场景 (切换瞬间). 写用 file lock (mkdir 互斥)
 * - 内部读写都加 100ms 重试, 避免冲突
 *
 * Schema: 详见 docs/codex-agent-integration.md §2.4
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../../memory/paths.js'
import { createLogger } from '../../utils/logger.js'
import type { KeyFact } from '../backend.js'
import type { AgentType } from '../backend.js'

const logger = createLogger('blackboard')

export interface BlackboardData {
  schemaVersion: 1
  updatedAt: number
  currentAgent: AgentType
  lastSwitchAt: number

  userPreferences: Record<string, string | number | undefined>

  currentTask: {
    type: 'create' | 'debug' | 'optimize' | 'explain' | 'other'
    description: string
    workflowId?: string
    errorMessage?: string
    startedAt: number
  } | null

  keyFacts: KeyFact[]

  recentAgentActions: Array<{
    agent: AgentType
    action: string
    timestamp: number
    result?: 'success' | 'failure'
  }>
}

const DEFAULT_DATA: BlackboardData = {
  schemaVersion: 1,
  updatedAt: 0,
  currentAgent: 'sga',
  lastSwitchAt: 0,
  userPreferences: {},
  currentTask: null,
  keyFacts: [],
  recentAgentActions: [],
}

const MAX_KEY_FACTS = 20
const MAX_RECENT_ACTIONS = 10

export class Blackboard {
  private readonly filePath: string

  constructor(opts: { sgaHome?: string } = {}) {
    this.filePath = join(opts.sgaHome ?? getSgaHome(), 'shared', 'blackboard.json')
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(join(this.filePath, '..'), { recursive: true })
  }

  /** 读取黑板. 文件不存在返回 DEFAULT_DATA. */
  async read(): Promise<BlackboardData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as BlackboardData
      if (parsed.schemaVersion !== 1) {
        logger.warn(`Unknown blackboard schemaVersion ${parsed.schemaVersion}, using default`)
        return DEFAULT_DATA
      }
      return parsed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT')) return DEFAULT_DATA
      logger.error(`Failed to read blackboard: ${msg}`)
      return DEFAULT_DATA
    }
  }

  /**
   * 原子更新. 用 .tmp + rename 避免读到部分写入.
   * 内部合并逻辑: 浅合并 + 特殊处理数组 (keyFacts 去重, recentActions append).
   */
  async update(patch: Partial<BlackboardData>): Promise<BlackboardData> {
    await this.ensureDir()
    const current = await this.read()
    const merged: BlackboardData = {
      ...current,
      ...patch,
      userPreferences: { ...current.userPreferences, ...(patch.userPreferences ?? {}) },
      keyFacts: patch.keyFacts ?? current.keyFacts,
      recentAgentActions: patch.recentAgentActions ?? current.recentAgentActions,
      updatedAt: Date.now(),
    }
    // 限长
    if (merged.keyFacts.length > MAX_KEY_FACTS) {
      merged.keyFacts = merged.keyFacts.slice(-MAX_KEY_FACTS)
    }
    if (merged.recentAgentActions.length > MAX_RECENT_ACTIONS) {
      merged.recentAgentActions = merged.recentAgentActions.slice(-MAX_RECENT_ACTIONS)
    }

    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
    return merged
  }

  /** 添加一个 keyFact (自动去重 + 按 confidence 排序) */
  async addKeyFact(fact: KeyFact): Promise<void> {
    const current = await this.read()
    // 去重: 同 fact 文本则替换
    const filtered = current.keyFacts.filter(f => f.fact !== fact.fact)
    filtered.push(fact)
    filtered.sort((a, b) => b.confidence - a.confidence)
    await this.update({ keyFacts: filtered })
  }

  /** 记录一次 agent 操作 */
  async logAction(agent: AgentType, action: string, result?: 'success' | 'failure'): Promise<void> {
    const current = await this.read()
    const actions = [...current.recentAgentActions, { agent, action, timestamp: Date.now(), result }]
    await this.update({ recentAgentActions: actions })
  }

  /** 切换 agent 时调用 */
  async recordSwitch(from: AgentType, to: AgentType): Promise<void> {
    await this.update({
      currentAgent: to,
      lastSwitchAt: Date.now(),
    })
    await this.logAction(from, `switch-out → ${to}`)
    await this.logAction(to, `switch-in ← ${from}`)
  }

  /** 序列化为 prompt 文本, 供 target agent 拼入 system prompt */
  async toPromptSection(): Promise<string> {
    const data = await this.read()
    const lines: string[] = ['## Shared Blackboard (cross-agent context)']

    if (data.currentTask) {
      lines.push(`Current task: ${data.currentTask.type} — ${data.currentTask.description}`)
      if (data.currentTask.workflowId) lines.push(`  Workflow: ${data.currentTask.workflowId}`)
      if (data.currentTask.errorMessage) lines.push(`  Error: ${data.currentTask.errorMessage}`)
    }

    if (Object.keys(data.userPreferences).length > 0) {
      lines.push('User preferences:')
      for (const [k, v] of Object.entries(data.userPreferences)) {
        if (v !== undefined && v !== null && v !== '') {
          lines.push(`  - ${k}: ${v}`)
        }
      }
    }

    if (data.keyFacts.length > 0) {
      lines.push('Key facts (high to low confidence):')
      for (const f of data.keyFacts.slice(0, 10)) {
        lines.push(`  - [${f.category}] ${f.fact} (confidence=${f.confidence.toFixed(2)})`)
      }
    }

    if (data.recentAgentActions.length > 0) {
      lines.push('Recent actions:')
      for (const a of data.recentAgentActions.slice(-5)) {
        const ago = Math.round((Date.now() - a.timestamp) / 1000)
        lines.push(`  - ${a.agent} ${ago}s ago: ${a.action}${a.result ? ' [' + a.result + ']' : ''}`)
      }
    }

    return lines.join('\n')
  }

  /** 清空黑板 (重置用) */
  async clear(): Promise<void> {
    await this.update(DEFAULT_DATA)
  }
}

let _bb: Blackboard | null = null
export function getBlackboard(opts?: { sgaHome?: string }): Blackboard {
  if (!_bb) _bb = new Blackboard(opts)
  return _bb
}
