import type { Message, MessageContent } from '../../core/types.js'
import type { LLMProvider, ProviderRequestOptions } from '../../providers/types.js'
import { estimateMessageTokens } from './micro-compact.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('full-compact')

export interface FullCompactConfig {
  enabled: boolean
  maxOutputTokens: number
  maxPTLRetries: number
  bufferTokens: number
  warningThresholdTokens: number
  maxConsecutiveFailures: number
}

export const DEFAULT_FULL_COMPACT_CONFIG: FullCompactConfig = {
  enabled: true,
  maxOutputTokens: 20_000,
  maxPTLRetries: 3,
  bufferTokens: 13_000,
  warningThresholdTokens: 20_000,
  maxConsecutiveFailures: 3,
}

export interface CompactSummaryResult {
  summaryMessage: Message
  messagesToKeep: Message[]
  attachments: Message[]
  preCompactTokenCount: number
  postCompactTokenCount: number
  summary: string
}

export interface CompactBoundary {
  id: string
  timestamp: number
  preCompactTokenCount: number
  type: 'auto' | 'manual'
}

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarization agent. Your task is to create a detailed summary of the conversation so far.

## Rules
1. Be thorough — capture all technical details, file paths, code snippets, and decisions
2. Preserve the user's explicit requests and intents
3. Include specific details: file names, function signatures, error messages
4. Document problems solved and any ongoing troubleshooting
5. List all pending tasks explicitly
6. Describe precisely what was being worked on most recently
7. Keep the summary under 20,000 tokens
8. Do NOT include tool call details unless they contain critical information
9. Focus on the OUTCOMES of tool calls, not the raw output

## Output Format
Structure your summary with these sections:

1. **Primary Request and Intent**: What the user asked for
2. **Key Technical Concepts**: Important concepts, technologies discussed
3. **Files and Code Sections**: Files examined/modified with code snippets
4. **Errors and Fixes**: Problems encountered and how they were resolved
5. **Problem Solving**: What was accomplished
6. **Pending Tasks**: What still needs to be done
7. **Current Work**: What was being worked on immediately before compaction
8. **Context for Continuing**: Key context needed to resume work`

const COMPACT_USER_PROMPT = `Summarize this conversation thoroughly. Focus on technical details, code changes, and decisions made. Include specific file paths, function names, and code snippets where relevant. Preserve all pending tasks and the current work state.`

export function getCompactThreshold(modelMaxTokens: number, config: FullCompactConfig = DEFAULT_FULL_COMPACT_CONFIG): number {
  return modelMaxTokens - config.bufferTokens
}

export function calculateTokenWarningState(
  tokenUsage: number,
  modelMaxTokens: number,
  config: FullCompactConfig = DEFAULT_FULL_COMPACT_CONFIG,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getCompactThreshold(modelMaxTokens, config)
  const warningThreshold = autoCompactThreshold - config.warningThresholdTokens
  const blockingLimit = modelMaxTokens - 3_000

  const percentLeft = Math.max(
    0,
    Math.round(((autoCompactThreshold - tokenUsage) / autoCompactThreshold) * 100),
  )

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  }
}

export function shouldAutoCompact(
  messages: Message[],
  modelMaxTokens: number,
  config: FullCompactConfig = DEFAULT_FULL_COMPACT_CONFIG,
): boolean {
  if (!config.enabled) return false

  const tokenCount = estimateMessageTokens(messages)
  const threshold = getCompactThreshold(modelMaxTokens, config)
  return tokenCount >= threshold
}

function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message

    let hasMedia = false
    const newContent = message.content.map(block => {
      if (block.type === 'image') {
        hasMedia = true
        return { type: 'text' as const, text: '[image]' }
      }
      return block
    })

    if (!hasMedia) return message
    return { ...message, content: newContent } as Message
  })
}

function truncateHeadForPTLRetry(messages: Message[], tokenGap: number): Message[] | null {
  if (messages.length < 4) return null

  const dropRatio = 0.2
  const dropCount = Math.max(1, Math.floor(messages.length * dropRatio))
  const keepFrom = Math.min(dropCount, messages.length - 2)

  if (keepFrom < 1) return null

  const sliced = messages.slice(keepFrom)

  if (sliced[0]?.role === 'assistant') {
    return [
      {
        id: `ptl-marker-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: '[earlier conversation truncated for compaction retry]' }],
        timestamp: Date.now(),
      },
      ...sliced,
    ] as Message[]
  }

  return sliced
}

export async function compactConversation(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  config: FullCompactConfig = DEFAULT_FULL_COMPACT_CONFIG,
  customInstructions?: string,
  isAutoCompact: boolean = false,
): Promise<CompactSummaryResult> {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact.')
  }

  const preCompactTokenCount = estimateMessageTokens(messages)

  let messagesToSummarize = stripImagesFromMessages(messages)
  let summary = ''
  let ptlAttempts = 0

  const systemPrompt = COMPACT_SYSTEM_PROMPT
  let userPrompt = COMPACT_USER_PROMPT
  if (customInstructions?.trim()) {
    userPrompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  for (;;) {
    const conversationText = serializeMessagesForSummary(messagesToSummarize)
    const fullUserPrompt = `${userPrompt}\n\n---\n\n## Conversation to Summarize:\n\n${conversationText}`

    const resolvedModel = provider.resolveModel(model)
    const modelConfig = provider.getModelConfig(model)

    const requestOptions: ProviderRequestOptions = {
      model: resolvedModel,
      messages: [{
        role: 'user',
        content: fullUserPrompt,
      }],
      maxTokens: config.maxOutputTokens,
      temperature: 0.3,
      stream: false,
      systemPrompt,
    }

    const response = await provider.createMessage(requestOptions)

    const responseText = response.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
      .trim()

    if (!responseText) {
      throw new Error('Failed to generate conversation summary - response did not contain valid text content')
    }

    if (responseText.toLowerCase().includes('prompt too long') || responseText.toLowerCase().includes('context window')) {
      ptlAttempts++
      if (ptlAttempts > config.maxPTLRetries) {
        throw new Error('Conversation too long for compaction. Please manually reduce context.')
      }

      const tokenGap = preCompactTokenCount - (modelConfig?.contextWindow ?? 200_000)
      const truncated = truncateHeadForPTLRetry(messagesToSummarize, Math.max(tokenGap, 10_000))
      if (!truncated) {
        throw new Error('Conversation too long for compaction after retries.')
      }
      messagesToSummarize = truncated
      continue
    }

    summary = responseText
    break
  }

  const keepFrom = Math.floor(messages.length * 0.3)
  const messagesToKeep = messages.slice(keepFrom)

  const summaryMessage: Message = {
    id: `compact-summary-${Date.now()}`,
    role: 'user',
    content: [{
      type: 'text',
      text: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}\n\nRecent messages are preserved verbatim. Continue the conversation from where it left off.`,
    }],
    timestamp: Date.now(),
    metadata: {
      isCompactSummary: true,
      compactType: 'full',
      preCompactTokenCount,
    },
  }

  const postCompactMessages = [summaryMessage, ...messagesToKeep]
  const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

  logger.info(
    `Full compact: preTokens≈${preCompactTokenCount}, postTokens≈${postCompactTokenCount}, ` +
    `kept=${messagesToKeep.length}, summary≈${estimateMessageTokens([summaryMessage])} tokens`,
  )

  return {
    summaryMessage,
    messagesToKeep,
    attachments: [],
    preCompactTokenCount,
    postCompactTokenCount,
    summary,
  }
}

function serializeMessagesForSummary(messages: Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System'
    const textParts: string[] = []

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        const name = (block as MessageContent & { name?: string }).name ?? 'unknown'
        textParts.push(`[Tool call: ${name}]`)
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : '[tool result]'
        if (content.length > 500) {
          textParts.push(`[Tool result: ${content.slice(0, 500)}...]`)
        } else {
          textParts.push(`[Tool result: ${content}]`)
        }
      }
    }

    if (textParts.length > 0) {
      parts.push(`[${role}]: ${textParts.join('\n')}`)
    }
  }

  return parts.join('\n\n')
}
