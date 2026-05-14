import type { MemoryFile, MemoryType, MemoryScope } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('memory-dedup')

export interface DedupResult {
  duplicates: Array<{ kept: string; removed: string[]; reason: string }>
  merged: Array<{ sources: string[]; output: string }>
  clean: string[]
}

export interface MemoryFingerprint {
  path: string
  type: MemoryType
  scope: MemoryScope
  descriptionLower: string
  contentHash: string
  contentPrefix: string
  tokenEstimate: number
  tags: string[]
}

export function computeFingerprint(memory: MemoryFile): MemoryFingerprint {
  const contentStr = memory.content.trim()
  return {
    path: memory.path,
    type: memory.type,
    scope: memory.frontmatter.scope ?? 'project',
    descriptionLower: memory.description.toLowerCase().trim(),
    contentHash: simpleHash(contentStr),
    contentPrefix: contentStr.slice(0, 200).toLowerCase().trim(),
    tokenEstimate: Math.ceil(contentStr.length / 4),
    tags: memory.frontmatter.tags ?? [],
  }
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36)
}

export function findDuplicates(memories: MemoryFile[]): DedupResult {
  const fingerprints = memories.map(computeFingerprint)
  const result: DedupResult = {
    duplicates: [],
    merged: [],
    clean: [],
  }

  const processed = new Set<string>()
  const groups = new Map<string, string[]>()

  for (let i = 0; i < fingerprints.length; i++) {
    if (processed.has(fingerprints[i].path)) continue

    const group = [fingerprints[i].path]
    processed.add(fingerprints[i].path)

    for (let j = i + 1; j < fingerprints.length; j++) {
      if (processed.has(fingerprints[j].path)) continue

      if (areDuplicates(fingerprints[i], fingerprints[j])) {
        group.push(fingerprints[j].path)
        processed.add(fingerprints[j].path)
      }
    }

    if (group.length > 1) {
      const kept = selectBest(group, fingerprints)
      const removed = group.filter(p => p !== kept)
      const reason = determineDupReason(fingerprints.find(f => f.path === kept)!, fingerprints.find(f => f.path === removed[0])!)
      result.duplicates.push({ kept, removed, reason })
    } else {
      result.clean.push(group[0])
    }
  }

  return result
}

function areDuplicates(a: MemoryFingerprint, b: MemoryFingerprint): boolean {
  if (a.contentHash === b.contentHash && a.contentHash !== '0') return true

  if (a.descriptionLower === b.descriptionLower && a.descriptionLower.length > 5) return true

  if (a.contentPrefix === b.contentPrefix && a.contentPrefix.length > 50) return true

  if (a.type === b.type && a.scope === b.scope) {
    const jaccard = computeJaccard(a.tags, b.tags)
    if (jaccard > 0.8 && a.descriptionLower.includes(b.descriptionLower.slice(0, 20))) return true
  }

  return false
}

function computeJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0

  const setA = new Set(a.map(t => t.toLowerCase()))
  const setB = new Set(b.map(t => t.toLowerCase()))
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  return intersection / (setA.size + setB.size - intersection)
}

function selectBest(paths: string[], fingerprints: MemoryFingerprint[]): string {
  const fpMap = new Map(fingerprints.map(f => [f.path, f]))
  const scored = paths.map(path => {
    const fp = fpMap.get(path)!
    let score = 0
    score += fp.tokenEstimate
    if (fp.tags.length > 0) score += 100
    if (fp.descriptionLower.length > 10) score += 50
    return { path, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].path
}

function determineDupReason(a: MemoryFingerprint, b: MemoryFingerprint): string {
  if (a.contentHash === b.contentHash) return 'identical_content'
  if (a.descriptionLower === b.descriptionLower) return 'identical_description'
  if (a.contentPrefix === b.contentPrefix) return 'content_prefix_match'
  return 'semantic_overlap'
}

export interface MemorySummary {
  originalPath: string
  summary: string
  originalTokenEstimate: number
  summaryTokenEstimate: number
  compressionRatio: number
}

export function summarizeMemoryContent(content: string, targetTokens: number): string {
  const currentTokens = Math.ceil(content.length / 4)
  if (currentTokens <= targetTokens) return content

  const ratio = targetTokens / currentTokens
  const targetChars = Math.floor(content.length * ratio)

  const lines = content.split('\n')
  const headerLines: string[] = []
  const bodyLines: string[] = []

  let inFrontmatter = false
  let frontmatterDone = false

  for (const line of lines) {
    if (!frontmatterDone) {
      if (line.trim() === '---') {
        if (inFrontmatter) {
          frontmatterDone = true
          inFrontmatter = false
        } else {
          inFrontmatter = true
        }
        headerLines.push(line)
        continue
      }
      if (inFrontmatter) {
        headerLines.push(line)
        continue
      }
    }
    bodyLines.push(line)
  }

  const headerSize = headerLines.join('\n').length
  const availableChars = targetChars - headerSize

  if (availableChars <= 0) {
    return content.slice(0, targetChars) + '\n\n[... compressed ...]'
  }

  const strategy = detectContentStrategy(bodyLines.join('\n'))
  const compressedBody = compressByStrategy(bodyLines, availableChars, strategy)

  return [...headerLines, '', compressedBody].join('\n')
}

type ContentStrategy = 'structured' | 'prose' | 'code' | 'mixed'

function detectContentStrategy(content: string): ContentStrategy {
  const codeBlockCount = (content.match(/```/g) ?? []).length / 2
  const listCount = (content.match(/^[\s]*[-*]\s/gm) ?? []).length
  const headingCount = (content.match(/^#+\s/gm) ?? []).length
  const totalLines = content.split('\n').length

  if (codeBlockCount >= 2) return 'code'
  if (listCount / totalLines > 0.4 || headingCount / totalLines > 0.2) return 'structured'
  if (codeBlockCount > 0) return 'mixed'
  return 'prose'
}

function compressByStrategy(lines: string[], targetChars: number, strategy: ContentStrategy): string {
  switch (strategy) {
    case 'structured':
      return compressStructured(lines, targetChars)
    case 'code':
      return compressCode(lines, targetChars)
    case 'prose':
      return compressProse(lines, targetChars)
    case 'mixed':
      return compressMixed(lines, targetChars)
  }
}

function compressStructured(lines: string[], targetChars: number): string {
  const result: string[] = []
  let charCount = 0

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('##')) {
      if (charCount + line.length + 1 <= targetChars) {
        result.push(line)
        charCount += line.length + 1
      }
    } else if (line.match(/^[\s]*[-*]\s/)) {
      const truncated = truncateLine(line, Math.min(line.length, 120))
      if (charCount + truncated.length + 1 <= targetChars) {
        result.push(truncated)
        charCount += truncated.length + 1
      }
    } else if (line.trim()) {
      const truncated = truncateLine(line, Math.min(line.length, 80))
      if (charCount + truncated.length + 1 <= targetChars) {
        result.push(truncated)
        charCount += truncated.length + 1
      }
    }

    if (charCount >= targetChars) break
  }

  if (charCount >= targetChars) {
    result.push('[... remaining structured content omitted ...]')
  }

  return result.join('\n')
}

function compressCode(lines: string[], targetChars: number): string {
  const result: string[] = []
  let charCount = 0

  const firstLines = lines.slice(0, Math.floor(lines.length * 0.3))
  const lastLines = lines.slice(-Math.floor(lines.length * 0.2))

  for (const line of firstLines) {
    if (charCount + line.length + 1 <= targetChars * 0.6) {
      result.push(line)
      charCount += line.length + 1
    }
  }

  if (firstLines.length + lastLines.length < lines.length) {
    result.push('')
    result.push(`// ... ${lines.length - firstLines.length - lastLines.length} lines omitted ...`)
    result.push('')
    charCount += 60
  }

  for (const line of lastLines) {
    if (charCount + line.length + 1 <= targetChars) {
      result.push(line)
      charCount += line.length + 1
    }
  }

  return result.join('\n')
}

function compressProse(lines: string[], targetChars: number): string {
  const paragraphs: string[] = []
  let current = ''

  for (const line of lines) {
    if (line.trim() === '') {
      if (current) paragraphs.push(current)
      current = ''
    } else {
      current = current ? current + ' ' + line : line
    }
  }
  if (current) paragraphs.push(current)

  const result: string[] = []
  let charCount = 0

  for (const para of paragraphs) {
    if (charCount + para.length + 2 > targetChars) {
      const remaining = targetChars - charCount
      if (remaining > 50) {
        result.push(para.slice(0, remaining) + '...')
      }
      break
    }
    result.push(para)
    charCount += para.length + 2
  }

  return result.join('\n\n')
}

function compressMixed(lines: string[], targetChars: number): string {
  const sections: Array<{ type: 'text' | 'code'; lines: string[] }> = []
  let currentType: 'text' | 'code' = 'text'
  let currentLines: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock
      currentLines.push(line)
      if (!inCodeBlock) {
        sections.push({ type: currentType, lines: currentLines })
        currentLines = []
        currentType = 'text'
      } else {
        if (currentLines.length > 1) {
          sections.push({ type: 'text', lines: currentLines.slice(0, -1) })
        }
        currentLines = [line]
        currentType = 'code'
      }
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0) {
    sections.push({ type: currentType, lines: currentLines })
  }

  const result: string[] = []
  let charCount = 0
  const perSectionBudget = targetChars / sections.length

  for (const section of sections) {
    const budget = Math.floor(perSectionBudget)
    if (section.type === 'code') {
      const compressed = compressCode(section.lines, budget)
      result.push(compressed)
    } else {
      const compressed = compressProse(section.lines, budget)
      result.push(compressed)
    }
    charCount += result[result.length - 1].length
  }

  return result.join('\n\n')
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line
  return line.slice(0, maxLen - 3) + '...'
}

export function shouldDedupBeforeSave(
  newMemory: { type: string; description: string; content: string },
  existingMemories: MemoryFile[],
): { isDuplicate: boolean; existingPath?: string; reason?: string } {
  const newDesc = newMemory.description.toLowerCase().trim()
  const newContentHash = simpleHash(newMemory.content.trim())
  const newPrefix = newMemory.content.trim().slice(0, 200).toLowerCase()

  for (const existing of existingMemories) {
    const existingDesc = existing.description.toLowerCase().trim()
    const existingHash = simpleHash(existing.content.trim())
    const existingPrefix = existing.content.trim().slice(0, 200).toLowerCase()

    if (newContentHash === existingHash && newContentHash !== '0') {
      return { isDuplicate: true, existingPath: existing.path, reason: 'identical_content' }
    }

    if (newDesc === existingDesc && newDesc.length > 5) {
      return { isDuplicate: true, existingPath: existing.path, reason: 'identical_description' }
    }

    if (newPrefix === existingPrefix && newPrefix.length > 50) {
      return { isDuplicate: true, existingPath: existing.path, reason: 'content_prefix_match' }
    }
  }

  return { isDuplicate: false }
}
