import type { Message } from '../core/types.js'

export type CompressionLevel = 'snip' | 'micro' | 'collapse' | 'auto_compact'

export interface CompressionResult {
  messages: Message[]
  level: CompressionLevel
  tokensSaved: number
  wasCompressed: boolean
}

export interface CompressionConfig {
  snipEnabled: boolean
  microEnabled: boolean
  collapseEnabled: boolean
  autoCompactEnabled: boolean
  autoCompactThreshold: number
  maxContextTokens: number
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  snipEnabled: true,
  microEnabled: true,
  collapseEnabled: true,
  autoCompactEnabled: true,
  autoCompactThreshold: 0.85,
  maxContextTokens: 200_000,
}

export async function compressContext(
  messages: Message[],
  currentTokens: number,
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG,
  summarizer?: (messages: Message[]) => Promise<string>,
): Promise<CompressionResult> {
  const threshold = config.maxContextTokens * config.autoCompactThreshold

  if (currentTokens < threshold) {
    return { messages, level: 'snip', tokensSaved: 0, wasCompressed: false }
  }

  let result = messages
  let level: CompressionLevel = 'snip'
  let tokensSaved = 0

  if (config.snipEnabled) {
    const snipped = applySnipCompression(messages)
    if (snipped.length < messages.length) {
      tokensSaved += estimateTokens(messages) - estimateTokens(snipped)
      result = snipped
      level = 'snip'
    }
  }

  if (estimateTokens(result) > threshold && config.collapseEnabled) {
    const collapsed = await applyContextCollapse(result, summarizer)
    tokensSaved += estimateTokens(result) - estimateTokens(collapsed)
    result = collapsed
    level = 'collapse'
  }

  if (estimateTokens(result) > threshold && config.autoCompactEnabled && summarizer) {
    const summary = await summarizer(result)
    result = [createCompactSummaryMessage(summary)]
    tokensSaved = estimateTokens(messages) - estimateTokens(result)
    level = 'auto_compact'
  }

  return { messages: result, level, tokensSaved, wasCompressed: level !== 'snip' || tokensSaved > 0 }
}

function applySnipCompression(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'user') return msg
    return {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === 'tool_result' && block.content && typeof block.content === 'string' && block.content.length > 5000) {
          return { ...block, content: block.content.slice(0, 2000) + '\n...[snipped]' }
        }
        return block
      }),
    }
  })
}

async function applyContextCollapse(
  messages: Message[],
  summarizer?: (messages: Message[]) => Promise<string>,
): Promise<Message[]> {
  if (messages.length <= 4) return messages

  const recent = messages.slice(-4)
  const older = messages.slice(0, -4)

  if (summarizer) {
    const summary = await summarizer(older)
    return [createCompactSummaryMessage(summary), ...recent]
  }

  return [...older.slice(-2), ...recent]
}

function createCompactSummaryMessage(summary: string): Message {
  return {
    id: `compact-${Date.now()}`,
    role: 'system',
    content: [{ type: 'text', text: `[Context Summary]\n${summary}` }],
    timestamp: Date.now(),
  }
}

function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => {
    const text = msg.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join(' ')
    return sum + Math.ceil(text.length / 4)
  }, 0)
}
