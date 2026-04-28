import type { MemoryFile, MemoryRetrievalResult } from './types.js'
import { MEMORY_MAX_RELEVANT } from './types.js'

export interface MemoryRetrieverConfig {
  maxRelevant: number
  freshnessThresholdDays: number
  useSemanticSearch: boolean
}

export const DEFAULT_RETRIEVER_CONFIG: MemoryRetrieverConfig = {
  maxRelevant: MEMORY_MAX_RELEVANT,
  freshnessThresholdDays: 1,
  useSemanticSearch: true,
}

export async function findRelevantMemories(
  query: string,
  allMemories: MemoryFile[],
  alreadySurfaced: Set<string> = new Set(),
  config: MemoryRetrieverConfig = DEFAULT_RETRIEVER_CONFIG,
): Promise<MemoryRetrievalResult> {
  const candidates = allMemories.filter(m => !alreadySurfaced.has(m.path))

  if (candidates.length === 0) {
    return { memories: [], freshnessWarnings: new Map() }
  }

  const scored = candidates.map(memory => ({
    memory,
    score: computeRelevanceScore(query, memory),
  }))

  scored.sort((a, b) => b.score - a.score)

  const selected = scored.slice(0, config.maxRelevant).map(s => s.memory)
  const freshnessWarnings = new Map<string, string>()

  for (const memory of selected) {
    const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
    if (ageDays > config.freshnessThresholdDays) {
      freshnessWarnings.set(
        memory.path,
        `This memory is ${Math.round(ageDays)} days old. Verify against current code before asserting as fact.`,
      )
    }
  }

  return { memories: selected, freshnessWarnings }
}

function computeRelevanceScore(query: string, memory: MemoryFile): number {
  const queryLower = query.toLowerCase()
  const queryTerms = queryLower.split(/\s+/)
  const descLower = memory.description.toLowerCase()
  const contentLower = memory.content.toLowerCase()

  let score = 0

  for (const term of queryTerms) {
    if (descLower.includes(term)) score += 3
    if (contentLower.includes(term)) score += 1
  }

  const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
  if (ageDays <= 1) score += 2
  else if (ageDays <= 7) score += 1

  return score
}
