export type ContextPriority = 'critical' | 'high' | 'medium' | 'low'

export type ContextSlotRole =
  | 'system_instruction'
  | 'working_set'
  | 'pinned_anchor'
  | 'global_memory'
  | 'project_memory'
  | 'session_memory'
  | 'retrieved_memory'
  | 'tool_output'
  | 'conversation'

export interface ContextSlot {
  role: ContextSlotRole
  priority: ContextPriority
  content: string
  source: string
  tokenEstimate: number
  evictable: boolean
  compressible: boolean
  metadata?: Record<string, unknown>
}

export interface ContextBudgetConfig {
  maxContextTokens: number
  reservedForSystem: number
  reservedForConversation: number
  reservedForTools: number
  memoryBudgetRatio: number
  workingSetBudgetRatio: number
  compressionThreshold: number
}

import { getSgaConfig } from '../config.js'

export function getBudgetConfig(): ContextBudgetConfig {
  const cfg = getSgaConfig().budget
  return {
    maxContextTokens: cfg.maxContextTokens,
    reservedForSystem: cfg.reservedForSystem,
    reservedForConversation: cfg.reservedForConversation,
    reservedForTools: cfg.reservedForTools,
    memoryBudgetRatio: cfg.memoryBudgetRatio,
    workingSetBudgetRatio: cfg.workingSetBudgetRatio,
    compressionThreshold: cfg.compressionThreshold,
  }
}

export const DEFAULT_BUDGET_CONFIG: ContextBudgetConfig = {
  maxContextTokens: 200_000,
  reservedForSystem: 4_000,
  reservedForConversation: 50_000,
  reservedForTools: 10_000,
  memoryBudgetRatio: 0.25,
  workingSetBudgetRatio: 0.15,
  compressionThreshold: 0.85,
}

export interface BudgetAllocation {
  total: number
  systemInstruction: number
  workingSet: number
  memory: number
  conversation: number
  tools: number
}

export interface ContextBuildResult {
  systemPrompt: string
  injectedSections: ContextSlot[]
  evictedSections: ContextSlot[]
  compressedSections: Array<{ original: ContextSlot; compressed: ContextSlot }>
  totalTokensUsed: number
  budgetAllocation: BudgetAllocation
}

export function computeBudgetAllocation(config: ContextBudgetConfig): BudgetAllocation {
  const available = config.maxContextTokens
    - config.reservedForSystem
    - config.reservedForConversation
    - config.reservedForTools

  const memoryBudget = Math.floor(available * config.memoryBudgetRatio)
  const workingSetBudget = Math.floor(available * config.workingSetBudgetRatio)

  return {
    total: config.maxContextTokens,
    systemInstruction: config.reservedForSystem,
    workingSet: workingSetBudget,
    memory: memoryBudget,
    conversation: config.reservedForConversation,
    tools: config.reservedForTools,
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function prioritizeSlots(slots: ContextSlot[]): ContextSlot[] {
  const priorityOrder: Record<ContextPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  }

  return [...slots].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 3
    const pb = priorityOrder[b.priority] ?? 3
    if (pa !== pb) return pa - pb
    return b.tokenEstimate - a.tokenEstimate
  })
}

export function fitSlotsWithinBudget(
  slots: ContextSlot[],
  budget: number,
): { fitted: ContextSlot[]; evicted: ContextSlot[] } {
  const sorted = prioritizeSlots(slots)
  const fitted: ContextSlot[] = []
  const evicted: ContextSlot[] = []
  let remaining = budget

  for (const slot of sorted) {
    if (slot.tokenEstimate <= remaining) {
      fitted.push(slot)
      remaining -= slot.tokenEstimate
    } else if (slot.evictable) {
      evicted.push(slot)
    } else {
      fitted.push(slot)
      remaining = 0
    }
  }

  return { fitted, evicted }
}

export function compressSlot(slot: ContextSlot, targetTokens: number): ContextSlot {
  if (!slot.compressible || slot.tokenEstimate <= targetTokens) {
    return slot
  }

  const ratio = targetTokens / slot.tokenEstimate
  const targetChars = Math.floor(slot.content.length * ratio)

  const compressed = slot.content.slice(0, targetChars)
  const lastNewline = compressed.lastIndexOf('\n')

  const truncatedContent = lastNewline > targetChars * 0.5
    ? compressed.slice(0, lastNewline)
    : compressed

  return {
    ...slot,
    content: truncatedContent + '\n\n[... content compressed to fit context budget ...]',
    tokenEstimate: estimateTokens(truncatedContent) + 10,
    metadata: {
      ...slot.metadata,
      originalTokenEstimate: slot.tokenEstimate,
      compressed: true,
    },
  }
}

export function buildContextFromSlots(
  slots: ContextSlot[],
  budget: ContextBudgetConfig,
): ContextBuildResult {
  const allocation = computeBudgetAllocation(budget)
  const totalMemoryBudget = allocation.workingSet + allocation.memory

  const systemSlots = slots.filter(s => s.role === 'system_instruction')
  const workingSetSlots = slots.filter(s => s.role === 'working_set' || s.role === 'pinned_anchor')
  const memorySlots = slots.filter(s =>
    s.role === 'global_memory' ||
    s.role === 'project_memory' ||
    s.role === 'session_memory' ||
    s.role === 'retrieved_memory',
  )

  const systemTokens = systemSlots.reduce((s, sl) => s + sl.tokenEstimate, 0)

  const availableForWorkingSet = Math.max(0, allocation.workingSet)
  const wsResult = fitSlotsWithinBudget(workingSetSlots, availableForWorkingSet)

  const availableForMemory = Math.max(0, totalMemoryBudget - wsResult.fitted.reduce((s, sl) => s + sl.tokenEstimate, 0))
  const memResult = fitSlotsWithinBudget(memorySlots, availableForMemory)

  const allFitted = [...systemSlots, ...wsResult.fitted, ...memResult.fitted]
  const allEvicted = [...wsResult.evicted, ...memResult.evicted]

  const compressedSections: Array<{ original: ContextSlot; compressed: ContextSlot }> = []
  for (let i = 0; i < allFitted.length; i++) {
    const slot = allFitted[i]
    const totalUsed = allFitted.reduce((s, sl) => s + sl.tokenEstimate, 0)
    if (totalUsed > totalMemoryBudget + allocation.systemInstruction && slot.compressible) {
      const targetRatio = (totalMemoryBudget + allocation.systemInstruction) / totalUsed
      const targetTokens = Math.floor(slot.tokenEstimate * targetRatio)
      const compressed = compressSlot(slot, targetTokens)
      if (compressed.tokenEstimate < slot.tokenEstimate) {
        compressedSections.push({ original: slot, compressed })
        allFitted[i] = compressed
      }
    }
  }

  const systemPrompt = allFitted
    .map(slot => slot.content)
    .join('\n\n')

  const totalTokensUsed = allFitted.reduce((s, sl) => s + sl.tokenEstimate, 0)

  return {
    systemPrompt,
    injectedSections: allFitted,
    evictedSections: allEvicted,
    compressedSections,
    totalTokensUsed,
    budgetAllocation: allocation,
  }
}
