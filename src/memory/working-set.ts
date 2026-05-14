import type { ContextSlot, ContextPriority } from './context-budget.js'
import { estimateTokens } from './context-budget.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('working-set')

export type AnchorStatus = 'active' | 'fading' | 'expired'

export interface Anchor {
  id: string
  label: string
  content: string
  source: string
  priority: ContextPriority
  status: AnchorStatus
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  maxTokenBudget: number
  summary?: string
  metadata?: Record<string, unknown>
}

export interface WorkingSetConfig {
  maxAnchors: number
  anchorFadeMs: number
  anchorExpireMs: number
  maxAnchorTokens: number
  autoPinThreshold: number
  summaryOnFade: boolean
}

export const DEFAULT_WORKING_SET_CONFIG: WorkingSetConfig = {
  maxAnchors: 5,
  anchorFadeMs: 5 * 60 * 1000,
  anchorExpireMs: 15 * 60 * 1000,
  maxAnchorTokens: 8_000,
  autoPinThreshold: 3,
  summaryOnFade: true,
}

export class WorkingSet {
  private anchors: Map<string, Anchor> = new Map()
  private config: WorkingSetConfig
  private summarizer?: (content: string) => Promise<string>

  constructor(config: WorkingSetConfig = DEFAULT_WORKING_SET_CONFIG) {
    this.config = config
  }

  setSummarizer(fn: (content: string) => Promise<string>): void {
    this.summarizer = fn
  }

  pin(id: string, label: string, content: string, source: string, priority: ContextPriority = 'high', maxTokenBudget?: number): Anchor {
    const existing = this.anchors.get(id)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      existing.accessCount++
      existing.priority = priority
      existing.status = 'active'
      return existing
    }

    if (this.anchors.size >= this.config.maxAnchors) {
      this.evictLowestPriority()
    }

    const tokenEstimate = estimateTokens(content)
    const budget = maxTokenBudget ?? this.config.maxAnchorTokens

    const anchor: Anchor = {
      id,
      label,
      content: tokenEstimate > budget ? this.truncateContent(content, budget) : content,
      source,
      priority,
      status: 'active',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
      maxTokenBudget: budget,
    }

    this.anchors.set(id, anchor)
    logger.debug(`Pinned anchor: ${id} (${label}), tokens≈${tokenEstimate}`)
    return anchor
  }

  unpin(id: string): boolean {
    return this.anchors.delete(id)
  }

  touch(id: string): void {
    const anchor = this.anchors.get(id)
    if (anchor) {
      anchor.lastAccessedAt = Date.now()
      anchor.accessCount++
      if (anchor.status === 'fading') {
        anchor.status = 'active'
      }
    }
  }

  get(id: string): Anchor | undefined {
    return this.anchors.get(id)
  }

  list(): Anchor[] {
    return Array.from(this.anchors.values())
  }

  listActive(): Anchor[] {
    this.updateStatuses()
    return Array.from(this.anchors.values()).filter(a => a.status === 'active')
  }

  listFading(): Anchor[] {
    this.updateStatuses()
    return Array.from(this.anchors.values()).filter(a => a.status === 'fading')
  }

  clear(): void {
    this.anchors.clear()
  }

  async fadeExpired(): Promise<Anchor[]> {
    const expired: Anchor[] = []
    const fading: Anchor[] = []

    for (const [id, anchor] of this.anchors) {
      const age = Date.now() - anchor.lastAccessedAt

      if (age > this.config.anchorExpireMs) {
        expired.push(anchor)
        this.anchors.delete(id)
      } else if (age > this.config.anchorFadeMs && anchor.status === 'active') {
        anchor.status = 'fading'
        fading.push(anchor)

        if (this.config.summaryOnFade && this.summarizer && !anchor.summary) {
          try {
            anchor.summary = await this.summarizer(anchor.content)
            logger.debug(`Summarized fading anchor: ${anchor.id}`)
          } catch (err) {
            logger.warn(`Failed to summarize anchor ${anchor.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }

    if (expired.length > 0) {
      logger.info(`Expired ${expired.length} anchor(s): ${expired.map(a => a.id).join(', ')}`)
    }

    return [...expired, ...fading]
  }

  toContextSlots(): ContextSlot[] {
    this.updateStatuses()
    const slots: ContextSlot[] = []

    for (const anchor of this.anchors.values()) {
      const isFading = anchor.status === 'fading'
      const displayContent = isFading && anchor.summary
        ? `[Summary of "${anchor.label}"]\n${anchor.summary}\n\n[Full content available but faded from focus. Reference: ${anchor.source}]`
        : anchor.content

      slots.push({
        role: isFading ? 'pinned_anchor' : 'working_set',
        priority: isFading ? 'medium' : anchor.priority,
        content: `## 📌 ${anchor.label}\n${displayContent}`,
        source: anchor.source,
        tokenEstimate: estimateTokens(displayContent) + 10,
        evictable: isFading,
        compressible: true,
        metadata: {
          anchorId: anchor.id,
          anchorStatus: anchor.status,
          accessCount: anchor.accessCount,
          originalTokenEstimate: estimateTokens(anchor.content),
        },
      })
    }

    return slots
  }

  detectAndPinFromContent(content: string, source: string): Anchor | null {
    const detected = this.detectAnchorableContent(content)
    if (!detected) return null

    return this.pin(detected.id, detected.label, detected.content, source, 'high')
  }

  detectAnchorableContent(text: string): { id: string; label: string; content: string } | null {
    const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
    if (jsonBlockMatch) {
      const jsonContent = jsonBlockMatch[1]
      const tokenEstimate = estimateTokens(jsonContent)
      if (tokenEstimate > 500) {
        try {
          const parsed = JSON.parse(jsonContent)
          const label = this.inferJsonLabel(parsed)
          return {
            id: `json_${label}_${Date.now()}`,
            label,
            content: jsonContent,
          }
        } catch {
          if (tokenEstimate > 1000) {
            return {
              id: `json_large_${Date.now()}`,
              label: 'Large JSON Block',
              content: jsonContent,
            }
          }
        }
      }
    }

    const codeBlockMatch = text.match(/```(\w+)?\s*\n([\s\S]*?)\n```/)
    if (codeBlockMatch) {
      const lang = codeBlockMatch[1] || 'code'
      const codeContent = codeBlockMatch[2]
      if (estimateTokens(codeContent) > 800) {
        return {
          id: `${lang}_block_${Date.now()}`,
          label: `${lang.charAt(0).toUpperCase() + lang.slice(1)} Code Block`,
          content: codeContent,
        }
      }
    }

    const tableMatch = text.match(/(\|.+\|[\r\n]+\|[-| :]+\|[\r\n]+(\|.+\|[\r\n]*)+)/)
    if (tableMatch) {
      const tableContent = tableMatch[1]
      if (estimateTokens(tableContent) > 500) {
        return {
          id: `table_${Date.now()}`,
          label: 'Data Table',
          content: tableContent,
        }
      }
    }

    return null
  }

  getStats(): {
    totalAnchors: number
    activeAnchors: number
    fadingAnchors: number
    totalTokens: number
  } {
    this.updateStatuses()
    const anchors = Array.from(this.anchors.values())
    return {
      totalAnchors: anchors.length,
      activeAnchors: anchors.filter(a => a.status === 'active').length,
      fadingAnchors: anchors.filter(a => a.status === 'fading').length,
      totalTokens: anchors.reduce((s, a) => s + estimateTokens(a.content), 0),
    }
  }

  private updateStatuses(): void {
    const now = Date.now()
    for (const anchor of this.anchors.values()) {
      const age = now - anchor.lastAccessedAt
      if (age > this.config.anchorExpireMs) {
        anchor.status = 'expired'
      } else if (age > this.config.anchorFadeMs && anchor.status === 'active') {
        anchor.status = 'fading'
      }
    }
  }

  private evictLowestPriority(): void {
    const priorityOrder: Record<AnchorStatus, number> = {
      expired: 0,
      fading: 1,
      active: 2,
    }
    const contextPriorityOrder: Record<ContextPriority, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    }

    let lowestId: string | null = null
    let lowestScore = Infinity

    for (const [id, anchor] of this.anchors) {
      const score = contextPriorityOrder[anchor.priority] * 10 + priorityOrder[anchor.status]
      if (score < lowestScore) {
        lowestScore = score
        lowestId = id
      }
    }

    if (lowestId) {
      this.anchors.delete(lowestId)
      logger.debug(`Evicted anchor: ${lowestId}`)
    }
  }

  private truncateContent(content: string, maxTokens: number): string {
    const maxChars = maxTokens * 4
    if (content.length <= maxChars) return content

    const truncated = content.slice(0, maxChars)
    const lastNewline = truncated.lastIndexOf('\n')
    const cutPoint = lastNewline > maxChars * 0.7 ? lastNewline : maxChars

    return content.slice(0, cutPoint) + '\n\n[... content truncated to fit anchor budget ...]'
  }

  private inferJsonLabel(parsed: unknown): string {
    if (typeof parsed !== 'object' || parsed === null) return 'JSON'

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === 'object') {
        const keys = Object.keys(parsed[0])
        if (keys.includes('nodes') || keys.includes('edges') || keys.includes('connections')) {
          return 'Workflow JSON'
        }
        if (keys.includes('name') && keys.includes('version')) {
          return 'Package JSON'
        }
        return `JSON Array (${parsed.length} items)`
      }
      return `JSON Array (${parsed.length} items)`
    }

    const keys = Object.keys(parsed)
    if (keys.includes('nodes') && keys.includes('edges')) return 'Workflow Definition'
    if (keys.includes('openapi') || keys.includes('swagger')) return 'API Spec'
    if (keys.includes('type') && keys.includes('properties')) return 'JSON Schema'
    if (keys.includes('name') && keys.includes('version') && keys.includes('dependencies')) return 'Package Config'

    return `JSON Object (${keys.length} keys)`
  }
}
