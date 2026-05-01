import type { MemoryFile, MemoryRetrievalResult } from './types.js'
import { MEMORY_MAX_RELEVANT } from './types.js'
import type { LLMProvider, ProviderRequestOptions } from '../providers/types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('memory-retrieval')

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

let cachedProvider: LLMProvider | null = null
let cachedModel: string = 'haiku'

export function setRetrievalProvider(provider: LLMProvider, model?: string): void {
  cachedProvider = provider
  if (model) cachedModel = model
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

  if (candidates.length <= config.maxRelevant) {
    return buildResult(candidates, config)
  }

  let selected: MemoryFile[]

  if (config.useSemanticSearch && cachedProvider) {
    try {
      selected = await llmSelectMemories(query, candidates, config.maxRelevant)
    } catch (error) {
      logger.debug(`LLM retrieval fallback to keyword: ${error instanceof Error ? error.message : String(error)}`)
      selected = keywordSelectMemories(query, candidates, config.maxRelevant)
    }
  } else {
    selected = keywordSelectMemories(query, candidates, config.maxRelevant)
  }

  return buildResult(selected, config)
}

function buildResult(memories: MemoryFile[], config: MemoryRetrieverConfig): MemoryRetrievalResult {
  const freshnessWarnings = new Map<string, string>()

  for (const memory of memories) {
    const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
    if (ageDays > config.freshnessThresholdDays) {
      freshnessWarnings.set(
        memory.path,
        `This memory is ${Math.round(ageDays)} days old. Verify against current code before asserting as fact.`,
      )
    }
  }

  return { memories, freshnessWarnings }
}

function keywordSelectMemories(query: string, candidates: MemoryFile[], maxRelevant: number): MemoryFile[] {
  const scored = candidates.map(memory => ({
    memory,
    score: computeRelevanceScore(query, memory),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, maxRelevant).map(s => s.memory)
}

async function llmSelectMemories(query: string, candidates: MemoryFile[], maxRelevant: number): Promise<MemoryFile[]> {
  if (!cachedProvider) return keywordSelectMemories(query, candidates, maxRelevant)

  const candidateList = candidates.map((m, i) =>
    `[${i}] [${m.type}] ${m.description}: ${m.content.slice(0, 200).replace(/\n/g, ' ')}`
  ).join('\n')

  const prompt = `Given the following user query and a list of memory entries, select the ${maxRelevant} most relevant memory indices.

User query: ${query}

Memory entries:
${candidateList}

Respond with ONLY the indices of the most relevant memories, separated by commas. For example: 0,3,7
Do not include any other text.`

  const resolvedModel = cachedProvider.resolveModel(cachedModel)
  const modelConfig = cachedProvider.getModelConfig(cachedModel)
  const maxTokens = modelConfig?.defaultMaxTokens ?? 256

  const requestOptions: ProviderRequestOptions = {
    model: resolvedModel,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature: 0,
    stream: false,
  }

  const response = await cachedProvider.createMessage(requestOptions)
  const responseText = response.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('')
    .trim()

  const indices = responseText
    .split(/[,\s]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(i => !isNaN(i) && i >= 0 && i < candidates.length)

  if (indices.length === 0) {
    return keywordSelectMemories(query, candidates, maxRelevant)
  }

  const uniqueIndices = [...new Set(indices)].slice(0, maxRelevant)
  return uniqueIndices.map(i => candidates[i])
}

function computeRelevanceScore(query: string, memory: MemoryFile): number {
  const queryLower = query.toLowerCase()
  const queryTerms = queryLower.split(/\s+/)
  const descLower = memory.description.toLowerCase()
  const contentLower = memory.content.toLowerCase()

  let score = 0

  for (const term of queryTerms) {
    if (term.length < 2) continue
    if (descLower.includes(term)) score += 3
    if (contentLower.includes(term)) score += 1
  }

  if (queryLower.includes(descLower) || descLower.includes(queryLower)) score += 5

  const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
  if (ageDays <= 1) score += 2
  else if (ageDays <= 7) score += 1

  return score
}
