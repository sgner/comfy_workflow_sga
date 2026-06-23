/**
 * 从 SGA memory 抽取 keyFacts 用于 handoff bundle.
 *
 * 策略:
 * 1. 优先取 user-tagged 事实 (用户偏好)
 * 2. 其次取 workflow-tagged 事实 (当前活跃工作流信息)
 * 3. 最后取 tool/preference 类
 * 4. 按 confidence 降序, 截 top 20
 *
 * 注: SGA 的实际 memory schema 各异, 这里提供默认的容错实现.
 *      后续可注入自定义 extractor.
 */

import { createLogger } from '../../utils/logger.js'
import type { KeyFact } from '../backend.js'
import { getMemoryManager } from '../../memory/manager.js'
import { getWorkingSet } from '../../memory/working-set-registry.js'

const logger = createLogger('memory-extractor')

export interface ExtractOptions {
  /** session id (用于过滤 session-scoped facts) */
  sessionId?: string
  /** 返回的最大事实数量, 默认 20 */
  maxFacts?: number
  /** 注入的当前时间 (测试用) */
  now?: number
}

export class MemoryExtractor {
  /** 从 SGA memory 抽取 keyFacts. 若 memory 不可用, 返回空数组. */
  async extractKeyFacts(opts: ExtractOptions = {}): Promise<KeyFact[]> {
    const max = opts.maxFacts ?? 20
    const now = opts.now ?? Date.now()
    const out: KeyFact[] = []

    // 1. 从 working set 拿当前活跃锚点
    try {
      const ws = getWorkingSet()
      if (ws) {
        // 尝试常见 API
        const anchors = (ws as any).getActiveAnchors?.() ?? (ws as any).getAnchors?.() ?? []
        for (const a of anchors) {
          const desc = typeof a === 'string' ? a : (a.summary ?? a.content ?? a.text ?? JSON.stringify(a))
          out.push({
            fact: `[working-set] ${desc}`,
            category: 'project',
            confidence: 0.7,
            source: 'sga-working-set',
            timestamp: now,
          })
        }
      }
    } catch (err) {
      logger.debug(`working set extraction skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 2. 从 memory manager 拿长期记忆
    try {
      const mm = getMemoryManager()
      if (mm) {
        // 尝试常见 API: search / query / list
        const candidates =
          (await (mm as any).search?.({ limit: 50 })) ??
          (await (mm as any).query?.({})) ??
          (await (mm as any).list?.({})) ??
          []
        for (const item of candidates) {
          const fact = this.toKeyFact(item, now)
          if (fact) out.push(fact)
        }
      }
    } catch (err) {
      logger.debug(`memory manager extraction skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 3. 去重 (相同 fact 文本) + 按 confidence 降序
    const seen = new Set<string>()
    const deduped: KeyFact[] = []
    out.sort((a, b) => b.confidence - a.confidence)
    for (const f of out) {
      if (seen.has(f.fact)) continue
      seen.add(f.fact)
      deduped.push(f)
      if (deduped.length >= max) break
    }
    return deduped
  }

  /** 抽取用户偏好 (从 long-term memory 找 category=user 的事实) */
  async extractUserPreferences(): Promise<Record<string, string>> {
    try {
      const facts = await this.extractKeyFacts({ maxFacts: 100 })
      const prefs: Record<string, string> = {}
      for (const f of facts) {
        if (f.category === 'user' || f.category === 'preference') {
          // 尝试从 fact 文本里解析 "key: value" 形式
          const m = f.fact.match(/^([\w-]+):\s*(.+)$/)
          if (m) prefs[m[1]] = m[2]
        }
      }
      return prefs
    } catch {
      return {}
    }
  }

  private toKeyFact(item: unknown, now: number): KeyFact | null {
    if (!item || typeof item !== 'object') return null
    const it = item as Record<string, unknown>
    const text = (it.fact as string) ?? (it.content as string) ?? (it.text as string) ?? (it.summary as string)
    if (!text) return null
    const category = (it.category as KeyFact['category']) ?? 'project'
    const confidence = typeof it.confidence === 'number' ? it.confidence : 0.5
    const source = (it.source as string) ?? 'sga-memory'
    const timestamp = typeof it.timestamp === 'number' ? it.timestamp : now
    return { fact: text, category, confidence, source, timestamp }
  }
}

let _ext: MemoryExtractor | null = null
export function getMemoryExtractor(): MemoryExtractor {
  if (!_ext) _ext = new MemoryExtractor()
  return _ext
}
