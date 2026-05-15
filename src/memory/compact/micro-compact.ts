import type { Message, MessageContent } from '../../core/types.js'
import { getSgaConfig } from '../../config.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('micro-compact')

export const CLEARED_TOOL_RESULT = '[Old tool result content cleared]'

const COMPACTABLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'FileEdit', 'FileWrite', 'NotebookEdit', 'LSP',
])

export interface MicroCompactConfig {
  enabled: boolean
  gapThresholdMinutes: number
  keepRecent: number
  maxToolResultTokens: number
}

export function getMicroCompactConfig(): MicroCompactConfig {
  const cfg = getSgaConfig().compact
  return {
    enabled: cfg.microEnabled,
    gapThresholdMinutes: cfg.microGapThresholdMinutes,
    keepRecent: cfg.microKeepRecent,
    maxToolResultTokens: cfg.microMaxToolResultTokens,
  }
}

export const DEFAULT_MICRO_COMPACT_CONFIG: MicroCompactConfig = {
  enabled: true,
  gapThresholdMinutes: 10,
  keepRecent: 3,
  maxToolResultTokens: 50_000,
}

export interface MicroCompactResult {
  messages: Message[]
  tokensSaved: number
  toolsCleared: number
  toolsKept: number
  trigger: 'time' | 'count' | 'none'
}

function estimateTokensForContent(content: string | MessageContent[] | undefined): number {
  if (!content) return 0

  if (typeof content === 'string') {
    return Math.ceil(content.length / 4)
  }

  let total = 0
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      total += Math.ceil(block.text.length / 4)
    } else if (block.type === 'image') {
      total += 2000
    } else if (block.type === 'tool_result') {
      total += estimateTokensForContent(block.content)
    } else if (block.type === 'tool_use') {
      total += Math.ceil((block.name?.length ?? 0) / 4)
      total += Math.ceil(JSON.stringify(block.input ?? {}).length / 4)
    }
  }
  return total
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokensForContent(message.content)
  }
  return Math.ceil(total * (4 / 3))
}

function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name && COMPACTABLE_TOOLS.has(block.name)) {
        if (block.id) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

function findLastAssistantTimestamp(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return messages[i].timestamp
    }
  }
  return null
}

export function shouldTriggerTimeBased(messages: Message[], config: MicroCompactConfig): { gapMinutes: number } | null {
  if (!config.enabled) return null

  const lastTs = findLastAssistantTimestamp(messages)
  if (!lastTs) return null

  const gapMinutes = (Date.now() - lastTs) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }

  return { gapMinutes }
}

export function shouldTriggerCountBased(messages: Message[], config: MicroCompactConfig): number | null {
  if (!config.enabled) return null

  const compactableIds = collectCompactableToolIds(messages)
  if (compactableIds.length <= config.keepRecent) return null

  return compactableIds.length - config.keepRecent
}

export function microCompactMessages(
  messages: Message[],
  config: MicroCompactConfig = DEFAULT_MICRO_COMPACT_CONFIG,
): MicroCompactResult {
  const timeTrigger = shouldTriggerTimeBased(messages, config)
  if (timeTrigger) {
    return executeTimeBasedCompact(messages, config, timeTrigger.gapMinutes)
  }

  const countTrigger = shouldTriggerCountBased(messages, config)
  if (countTrigger !== null && countTrigger > 0) {
    return executeCountBasedCompact(messages, config)
  }

  return {
    messages,
    tokensSaved: 0,
    toolsCleared: 0,
    toolsKept: 0,
    trigger: 'none',
  }
}

function executeTimeBasedCompact(
  messages: Message[],
  config: MicroCompactConfig,
  gapMinutes: number,
): MicroCompactResult {
  const compactableIds = collectCompactableToolIds(messages)
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return { messages, tokensSaved: 0, toolsCleared: 0, toolsKept: keepSet.size, trigger: 'time' }
  }

  let tokensSaved = 0
  const result = messages.map(message => {
    if (message.role !== 'user') return message

    let touched = false
    const newContent = message.content.map((block: MessageContent) => {
      if (
        block.type === 'tool_result' &&
        block.tool_use_id &&
        clearSet.has(block.tool_use_id)
      ) {
        const originalTokens = estimateTokensForContent(block.content)
        if (block.content === CLEARED_TOOL_RESULT) return block

        tokensSaved += originalTokens
        touched = true
        return {
          ...block,
          content: CLEARED_TOOL_RESULT,
        } as MessageContent
      }
      return block
    })

    if (!touched) return message
    return { ...message, content: newContent } as Message
  })

  logger.info(
    `Time-based microcompact: gap=${Math.round(gapMinutes)}min, cleared=${clearSet.size} tools, saved≈${tokensSaved} tokens`,
  )

  return {
    messages: result,
    tokensSaved,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    trigger: 'time',
  }
}

function executeCountBasedCompact(
  messages: Message[],
  config: MicroCompactConfig,
): MicroCompactResult {
  const compactableIds = collectCompactableToolIds(messages)
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return { messages, tokensSaved: 0, toolsCleared: 0, toolsKept: keepSet.size, trigger: 'count' }
  }

  let tokensSaved = 0
  const result = messages.map(message => {
    if (message.role !== 'user') return message

    let touched = false
    const newContent = message.content.map((block: MessageContent) => {
      if (
        block.type === 'tool_result' &&
        block.tool_use_id &&
        clearSet.has(block.tool_use_id)
      ) {
        if (block.content === CLEARED_TOOL_RESULT) return block

        const originalTokens = estimateTokensForContent(block.content)
        tokensSaved += originalTokens
        touched = true
        return {
          ...block,
          content: CLEARED_TOOL_RESULT,
        } as MessageContent
      }
      return block
    })

    if (!touched) return message
    return { ...message, content: newContent } as Message
  })

  logger.info(
    `Count-based microcompact: cleared=${clearSet.size} old tools, kept=${keepSet.size} recent, saved≈${tokensSaved} tokens`,
  )

  return {
    messages: result,
    tokensSaved,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    trigger: 'count',
  }
}
