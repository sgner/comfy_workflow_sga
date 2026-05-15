import type { Message, MessageContent } from '../../core/types.js'
import { getSgaConfig } from '../../config.js'
import { estimateMessageTokens } from './micro-compact.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('session-memory-compact')

export interface SessionMemoryCompactConfig {
  minTokens: number
  minTextBlockMessages: number
  maxTokens: number
  maxSessionMemoryTokens: number
}

export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  const cfg = getSgaConfig().compact
  return {
    minTokens: cfg.smMinTokens,
    minTextBlockMessages: cfg.smMinTextBlockMessages,
    maxTokens: cfg.smMaxTokens,
    maxSessionMemoryTokens: cfg.smMaxSessionMemoryTokens,
  }
}

export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
  maxSessionMemoryTokens: 30_000,
}

export interface SessionMemoryCompactResult {
  messagesToKeep: Message[]
  summaryMessage: Message
  preCompactTokenCount: number
  postCompactTokenCount: number
  keptMessageCount: number
  removedMessageCount: number
}

function hasTextBlocks(message: Message): boolean {
  if (message.role === 'assistant') {
    return message.content.some(block => block.type === 'text' && block.text && block.text.trim().length > 0)
  }
  if (message.role === 'user') {
    return message.content.some(block => block.type === 'text' && block.text && block.text.trim().length > 0)
  }
  return false
}

function getToolResultIds(message: Message): string[] {
  if (message.role !== 'user') return []
  const ids: string[] = []
  for (const block of message.content) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

function hasToolUseWithIds(message: Message, toolUseIds: Set<string>): boolean {
  if (message.role !== 'assistant') return false
  return message.content.some(
    block => block.type === 'tool_use' && block.id && toolUseIds.has(block.id),
  )
}

export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex
  }

  let adjustedIndex = startIndex

  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    const toolUseIdsInKeptRange = new Set<string>()
    for (let i = adjustedIndex; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIdsInKeptRange.add(block.id)
          }
        }
      }
    }

    const neededToolUseIds = new Set(
      allToolResultIds.filter(id => !toolUseIdsInKeptRange.has(id)),
    )

    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      const message = messages[i]!
      if (hasToolUseWithIds(message, neededToolUseIds)) {
        adjustedIndex = i
        if (message.role === 'assistant') {
          for (const block of message.content) {
            if (block.type === 'tool_use' && block.id && neededToolUseIds.has(block.id)) {
              neededToolUseIds.delete(block.id)
            }
          }
        }
      }
    }
  }

  return adjustedIndex
}

export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
  config: SessionMemoryCompactConfig = DEFAULT_SM_COMPACT_CONFIG,
): number {
  if (messages.length === 0) {
    return 0
  }

  let startIndex =
    lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length

  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!
    totalTokens += estimateMessageTokens([msg])
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
  }

  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  if (
    totalTokens >= config.minTokens &&
    textBlockMessageCount >= config.minTextBlockMessages
  ) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  for (let i = startIndex - 1; i >= 0; i--) {
    const msg = messages[i]!
    const msgTokens = estimateMessageTokens([msg])
    totalTokens += msgTokens
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
    startIndex = i

    if (totalTokens >= config.maxTokens) {
      break
    }

    if (
      totalTokens >= config.minTokens &&
      textBlockMessageCount >= config.minTextBlockMessages
    ) {
      break
    }
  }

  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}

export function buildSessionMemorySummary(messages: Message[]): string {
  const parts: string[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const textBlocks = message.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n')
      if (textBlocks.trim()) {
        parts.push(`[User]: ${textBlocks.slice(0, 500)}`)
      }
    } else if (message.role === 'assistant') {
      const textBlocks = message.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n')
      if (textBlocks.trim()) {
        parts.push(`[Assistant]: ${textBlocks.slice(0, 500)}`)
      }

      const toolUses = message.content.filter(b => b.type === 'tool_use')
      if (toolUses.length > 0) {
        const toolNames = toolUses.map(b => (b as MessageContent & { type: 'tool_use'; name: string }).name).join(', ')
        parts.push(`[Tools used]: ${toolNames}`)
      }
    }
  }

  return parts.join('\n\n')
}

export function sessionMemoryCompact(
  messages: Message[],
  sessionMemoryContent: string,
  config: SessionMemoryCompactConfig = DEFAULT_SM_COMPACT_CONFIG,
): SessionMemoryCompactResult | null {
  if (messages.length === 0) {
    return null
  }

  if (!sessionMemoryContent.trim()) {
    logger.debug('No session memory content available for compaction')
    return null
  }

  const preCompactTokenCount = estimateMessageTokens(messages)

  const lastSummarizedIndex = -1
  const startIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex, config)

  const messagesToKeep = messages.slice(startIndex)
  const messagesToRemove = messages.slice(0, startIndex)

  if (messagesToRemove.length === 0) {
    return null
  }

  const truncatedMemory = sessionMemoryContent.length > config.maxSessionMemoryTokens * 4
    ? sessionMemoryContent.slice(0, config.maxSessionMemoryTokens * 4) + '\n\n[... session memory truncated for length ...]'
    : sessionMemoryContent

  const summaryContent = `This session is being continued from a previous conversation that was compacted.\n\n## Session Memory\n\n${truncatedMemory}\n\nRecent messages are preserved verbatim. Continue the conversation from where it left off.`

  const summaryMessage: Message = {
    id: `sm-compact-${Date.now()}`,
    role: 'user',
    content: [{
      type: 'text',
      text: summaryContent,
    }],
    timestamp: Date.now(),
    metadata: {
      isCompactSummary: true,
      compactType: 'session_memory',
    },
  }

  const postCompactMessages = [summaryMessage, ...messagesToKeep]
  const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

  logger.info(
    `Session memory compact: removed=${messagesToRemove.length}, kept=${messagesToKeep.length}, ` +
    `preTokens≈${preCompactTokenCount}, postTokens≈${postCompactTokenCount}`,
  )

  return {
    messagesToKeep,
    summaryMessage,
    preCompactTokenCount,
    postCompactTokenCount,
    keptMessageCount: messagesToKeep.length,
    removedMessageCount: messagesToRemove.length,
  }
}
