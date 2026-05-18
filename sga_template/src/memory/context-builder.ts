import type { ContextSlot, ContextBudgetConfig } from './context-budget.js'
import { computeBudgetAllocation, estimateTokens, buildContextFromSlots, DEFAULT_BUDGET_CONFIG } from './context-budget.js'
import type { WorkingSet } from './working-set.js'
import type { MemoryManager } from './manager.js'
import type { MemoryFile } from './types.js'
import { findDuplicates, shouldDedupBeforeSave, summarizeMemoryContent } from './dedup.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('context-builder')

export type FocusMode = 'deep_focus' | 'balanced' | 'exploratory'

export interface ContextBuildOptions {
  userQuery: string
  messages?: Array<{ role: string; content: string }>
  focusMode?: FocusMode
  budgetConfig?: ContextBudgetConfig
  maxMemoryItems?: number
  enableDedup?: boolean
  enableCompression?: boolean
}

export interface ContextBuilderResult {
  systemPrompt: string
  focusMode: FocusMode
  workingSetItems: number
  memoryItemsInjected: number
  dedupRemoved: number
  compressedItems: number
  totalTokensUsed: number
  budgetAllocation: ReturnType<typeof computeBudgetAllocation>
}

const FOCUS_MODE_CONFIGS: Record<FocusMode, {
  memoryBudgetRatio: number
  workingSetBudgetRatio: number
  maxMemoryItems: number
  retrievalThreshold: number
}> = {
  deep_focus: {
    memoryBudgetRatio: 0.15,
    workingSetBudgetRatio: 0.30,
    maxMemoryItems: 3,
    retrievalThreshold: 0.7,
  },
  balanced: {
    memoryBudgetRatio: 0.25,
    workingSetBudgetRatio: 0.15,
    maxMemoryItems: 5,
    retrievalThreshold: 0.5,
  },
  exploratory: {
    memoryBudgetRatio: 0.35,
    workingSetBudgetRatio: 0.10,
    maxMemoryItems: 8,
    retrievalThreshold: 0.3,
  },
}

export function detectFocusMode(query: string, messages?: Array<{ role: string; content: string }>): FocusMode {
  const recentText = messages
    ? messages.slice(-6).map(m => m.content).join(' ')
    : query

  const queryLower = query.toLowerCase()

  const deepFocusIndicators = [
    'analyze this', 'debug this', 'fix this', 'refactor this',
    'explain this code', 'review this', 'what does this do',
    '分析这个', '调试这个', '修复这个', '重构这个',
    'explain this json', 'explain this workflow', 'parse this',
  ]

  const exploratoryIndicators = [
    'what are', 'list all', 'compare', 'overview', 'summarize',
    '哪些', '列出', '比较', '概述', '总结',
    'tell me about', 'how does', 'what options',
  ]

  let deepScore = 0
  let explorScore = 0

  for (const indicator of deepFocusIndicators) {
    if (queryLower.includes(indicator)) deepScore += 3
  }

  for (const indicator of exploratoryIndicators) {
    if (queryLower.includes(indicator)) explorScore += 3
  }

  const codeBlockCount = (recentText.match(/```/g) ?? []).length / 2
  if (codeBlockCount >= 2) deepScore += 4
  else if (codeBlockCount >= 1) deepScore += 2

  const jsonIndicators = (recentText.match(/[\{\[]/g) ?? []).length
  if (jsonIndicators > 20) deepScore += 3

  const questionCount = (query.match(/\?|？/g) ?? []).length
  if (questionCount >= 3) explorScore += 2

  if (deepScore > explorScore + 2) return 'deep_focus'
  if (explorScore > deepScore + 2) return 'exploratory'
  return 'balanced'
}

export async function buildContext(
  memoryManager: MemoryManager,
  workingSet: WorkingSet | null,
  options: ContextBuildOptions,
): Promise<ContextBuilderResult> {
  const focusMode = options.focusMode ?? detectFocusMode(options.userQuery, options.messages)
  const modeConfig = FOCUS_MODE_CONFIGS[focusMode]

  const budgetConfig: ContextBudgetConfig = {
    ...DEFAULT_BUDGET_CONFIG,
    ...options.budgetConfig,
    memoryBudgetRatio: modeConfig.memoryBudgetRatio,
    workingSetBudgetRatio: modeConfig.workingSetBudgetRatio,
  }

  const maxMemoryItems = options.maxMemoryItems ?? modeConfig.maxMemoryItems
  const enableDedup = options.enableDedup ?? true
  const enableCompression = options.enableCompression ?? true

  const slots: ContextSlot[] = []
  let workingSetSlotCount = 0

  if (workingSet) {
    await workingSet.fadeExpired()
    const workingSetSlots = workingSet.toContextSlots()
    slots.push(...workingSetSlots)
    workingSetSlotCount = workingSetSlots.length
  }

  const memories = await gatherMemories(memoryManager, focusMode, maxMemoryItems)

  let dedupRemoved = 0
  let filteredMemories = memories
  if (enableDedup) {
    const dedupResult = findDuplicates(memories)
    const removedPaths = new Set(dedupResult.duplicates.flatMap(d => d.removed))
    filteredMemories = memories.filter(m => !removedPaths.has(m.path))
    dedupRemoved = removedPaths.size

    if (dedupRemoved > 0) {
      logger.info(`Dedup removed ${dedupRemoved} duplicate memories`)
    }
  }

  const memorySlots = convertMemoriesToSlots(filteredMemories, focusMode)
  slots.push(...memorySlots)

  const buildResult = buildContextFromSlots(slots, budgetConfig)

  let compressedItems = 0
  if (enableCompression && buildResult.compressedSections.length > 0) {
    compressedItems = buildResult.compressedSections.length
    logger.info(`Compressed ${compressedItems} memory sections to fit budget`)
  }

  if (buildResult.evictedSections.length > 0) {
    logger.info(`Evicted ${buildResult.evictedSections.length} low-priority sections: ${buildResult.evictedSections.map(s => s.source).join(', ')}`)
  }

  return {
    systemPrompt: buildResult.systemPrompt,
    focusMode,
    workingSetItems: workingSetSlotCount,
    memoryItemsInjected: memorySlots.length - compressedItems,
    dedupRemoved,
    compressedItems,
    totalTokensUsed: buildResult.totalTokensUsed,
    budgetAllocation: buildResult.budgetAllocation,
  }
}

async function gatherMemories(
  memoryManager: MemoryManager,
  focusMode: FocusMode,
  maxItems: number,
): Promise<MemoryFile[]> {
  const memories: MemoryFile[] = []

  const globalMemories = await memoryManager.listGlobalMemories({ limit: 3 })
  memories.push(...globalMemories)

  const projectMemories = await memoryManager.listProjectMemories({ limit: Math.floor(maxItems * 0.6) })
  memories.push(...projectMemories)

  const sessionMemories = await memoryManager.listSessionMemories({ limit: Math.floor(maxItems * 0.4) })
  memories.push(...sessionMemories)

  const relevantResult = await memoryManager.findRelevant(memoryManager.getSessionId())
  for (const m of relevantResult.memories) {
    if (!memories.find(existing => existing.path === m.path)) {
      memories.push(m)
    }
  }

  return memories.slice(0, maxItems * 2)
}

function convertMemoriesToSlots(memories: MemoryFile[], focusMode: FocusMode): ContextSlot[] {
  return memories.map(memory => {
    const scope = memory.frontmatter.scope ?? 'project'
    const role = scope === 'global' ? 'global_memory' as const
      : scope === 'project' ? 'project_memory' as const
      : 'session_memory' as const

    const priority = focusMode === 'deep_focus' && scope === 'session'
      ? 'high' as const
      : scope === 'global' ? 'medium' as const
      : scope === 'project' ? 'medium' as const
      : 'low' as const

    const content = formatMemoryContent(memory, focusMode)
    const tokenEstimate = estimateTokens(content)

    return {
      role,
      priority,
      content,
      source: memory.path,
      tokenEstimate,
      evictable: true,
      compressible: tokenEstimate > 500,
      metadata: {
        memoryType: memory.type,
        memoryScope: scope,
        originalTokenEstimate: tokenEstimate,
      },
    }
  })
}

function formatMemoryContent(memory: MemoryFile, focusMode: FocusMode): string {
  const scope = memory.frontmatter.scope ?? 'project'
  const header = `### [${memory.type}][${scope}] ${memory.description}`

  if (focusMode === 'deep_focus') {
    const maxTokens = 2000
    const contentTokens = estimateTokens(memory.content)
    if (contentTokens > maxTokens) {
      const compressed = summarizeMemoryContent(memory.content, maxTokens)
      return `${header}\n${compressed}`
    }
    return `${header}\n${memory.content}`
  }

  if (focusMode === 'exploratory') {
    const maxTokens = 500
    const contentTokens = estimateTokens(memory.content)
    if (contentTokens > maxTokens) {
      const compressed = summarizeMemoryContent(memory.content, maxTokens)
      return `${header}\n${compressed}`
    }
    return `${header}\n${memory.content}`
  }

  const maxTokens = 1000
  const contentTokens = estimateTokens(memory.content)
  if (contentTokens > maxTokens) {
    const compressed = summarizeMemoryContent(memory.content, maxTokens)
    return `${header}\n${compressed}`
  }

  return `${header}\n${memory.content}`
}

export { shouldDedupBeforeSave, findDuplicates, summarizeMemoryContent }
