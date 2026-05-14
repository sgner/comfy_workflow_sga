import type { LLMProvider, ProviderRequestOptions } from '../../providers/types.js'
import type { MemoryManager } from '../manager.js'
import { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock, recordConsolidation } from './consolidation-lock.js'
import { buildConsolidationPrompt } from './consolidation-prompt.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('auto-dream')

export interface AutoDreamConfig {
  minHours: number
  minSessions: number
  enabled: boolean
  maxOutputTokens: number
  model: string
}

export const DEFAULT_AUTO_DREAM_CONFIG: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
  enabled: true,
  maxOutputTokens: 16_000,
  model: 'haiku',
}

export interface ConsolidationResult {
  consolidated: boolean
  hoursSinceLast: number
  sessionsReviewed: number
  summary: string
  filesTouched: string[]
}

const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

let lastSessionScanAt = 0

export function shouldConsolidate(
  memoryDir: string,
  sessionCount: number,
  config: AutoDreamConfig = DEFAULT_AUTO_DREAM_CONFIG,
): { shouldRun: boolean; hoursSinceLast: number } {
  if (!config.enabled) {
    return { shouldRun: false, hoursSinceLast: 0 }
  }

  const lastAt = readLastConsolidatedAt(memoryDir)
  const hoursSince = (Date.now() - lastAt) / 3_600_000

  if (hoursSince < config.minHours) {
    return { shouldRun: false, hoursSinceLast: hoursSince }
  }

  if (sessionCount < config.minSessions) {
    logger.debug(`Skip — ${sessionCount} sessions since last consolidation, need ${config.minSessions}`)
    return { shouldRun: false, hoursSinceLast: hoursSince }
  }

  return { shouldRun: true, hoursSinceLast: hoursSince }
}

export async function executeAutoDream(
  memoryManager: MemoryManager,
  provider: LLMProvider,
  sessionCount: number,
  config: AutoDreamConfig = DEFAULT_AUTO_DREAM_CONFIG,
): Promise<ConsolidationResult> {
  const memoryDir = memoryManager.getMemoryDir()

  const { shouldRun, hoursSinceLast } = shouldConsolidate(memoryDir, sessionCount, config)
  if (!shouldRun) {
    return {
      consolidated: false,
      hoursSinceLast,
      sessionsReviewed: 0,
      summary: 'Consolidation not triggered',
      filesTouched: [],
    }
  }

  const sinceScanMs = Date.now() - lastSessionScanAt
  if (sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
    logger.debug(`Scan throttle — last scan was ${Math.round(sinceScanMs / 1000)}s ago`)
    return {
      consolidated: false,
      hoursSinceLast,
      sessionsReviewed: 0,
      summary: 'Scan throttled',
      filesTouched: [],
    }
  }
  lastSessionScanAt = Date.now()

  const lockResult = tryAcquireConsolidationLock(memoryDir)
  if (!lockResult.acquired) {
    logger.debug('Consolidation lock held by another process')
    return {
      consolidated: false,
      hoursSinceLast,
      sessionsReviewed: sessionCount,
      summary: 'Lock held by another process',
      filesTouched: [],
    }
  }

  logger.info(`AutoDream firing — ${hoursSinceLast.toFixed(1)}h since last, ${sessionCount} sessions to review`)

  try {
    const extra = `\nSessions since last consolidation (${sessionCount}):\n${Array.from({ length: Math.min(sessionCount, 20) }, (_, i) => `- session-${i + 1}`).join('\n')}`

    const prompt = buildConsolidationPrompt(memoryDir, extra)

    const resolvedModel = provider.resolveModel(config.model)
    const modelConfig = provider.getModelConfig(config.model)

    const requestOptions: ProviderRequestOptions = {
      model: resolvedModel,
      messages: [{
        role: 'user',
        content: prompt,
      }],
      maxTokens: config.maxOutputTokens,
      temperature: 0.3,
      stream: false,
      systemPrompt: `You are a memory consolidation agent. Your job is to review, organize, and optimize memory files.

Rules:
- Read existing memory files before making changes
- Merge duplicate or overlapping memories
- Remove outdated or contradicted information
- Keep the memory index under 200 lines
- Write concise, factual memories
- Do NOT store sensitive credentials
- Preserve important technical details like file paths, function names, and code patterns`,
    }

    const response = await provider.createMessage(requestOptions)

    const summary = response.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
      .trim()

    const filesTouched = extractTouchedFiles(summary)

    recordConsolidation(memoryDir)

    logger.info(`AutoDream completed — ${filesTouched.length} files touched`)

    return {
      consolidated: true,
      hoursSinceLast,
      sessionsReviewed: sessionCount,
      summary: summary.slice(0, 500),
      filesTouched,
    }
  } catch (error) {
    logger.warn(`AutoDream failed: ${error instanceof Error ? error.message : String(error)}`)
    rollbackConsolidationLock(memoryDir, lockResult.priorMtime)

    return {
      consolidated: false,
      hoursSinceLast,
      sessionsReviewed: sessionCount,
      summary: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      filesTouched: [],
    }
  }
}

function extractTouchedFiles(summary: string): string[] {
  const files: string[] = []
  const filePatterns: RegExp[] = [
    new RegExp('(?:wrote|updated|created|modified|deleted|edited)\\s+[\\x60"]?([^\\s\\x60"\',)]+\\.(md|json|txt|yaml|yml)[\\x60"]?', 'gi'),
    new RegExp('(?:file|memory)[\\s:]+[\\x60"]?([^\\s\\x60"\',)]+\\.(md|json|txt|yaml|yml)[\\x60"]?', 'gi'),
  ]

  for (const pattern of filePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(summary)) !== null) {
      if (match[1] && !files.includes(match[1])) {
        files.push(match[1])
      }
    }
  }

  return files
}
