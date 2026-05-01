import type { Message } from '../core/types.js'
import type { LLMProvider, ProviderRequestOptions } from '../providers/types.js'
import type { MemoryManager } from './manager.js'
import { DEFAULT_MEMORY_EXTRACT_CONFIG } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('memory-extractor')

export interface MemoryExtractorConfig {
  enabled: boolean
  maxTurnsBetweenExtractions: number
  maxConversationChars: number
}

export const DEFAULT_EXTRACTOR_CONFIG: MemoryExtractorConfig = {
  enabled: true,
  maxTurnsBetweenExtractions: 3,
  maxConversationChars: 20_000,
}

export class MemoryExtractor {
  private memoryManager: MemoryManager
  private provider: LLMProvider | null = null
  private model: string
  private config: MemoryExtractorConfig
  private extracting = false
  private lastExtractMessageCount = 0

  constructor(
    memoryManager: MemoryManager,
    config: MemoryExtractorConfig = DEFAULT_EXTRACTOR_CONFIG,
  ) {
    this.memoryManager = memoryManager
    this.config = config
    this.model = 'haiku'
  }

  setProvider(provider: LLMProvider, model?: string): void {
    this.provider = provider
    if (model) this.model = model
  }

  shouldExtract(messageCount: number): boolean {
    if (!this.config.enabled) return false
    if (!this.provider) return false
    if (this.extracting) return false

    const delta = messageCount - this.lastExtractMessageCount
    return delta >= this.config.maxTurnsBetweenExtractions
  }

  async extractMemories(messages: Message[]): Promise<void> {
    if (!this.provider || this.extracting) return

    this.extracting = true
    this.lastExtractMessageCount = messages.length

    try {
      const summary = this.summarizeConversation(messages)
      if (!summary.trim()) {
        logger.debug('No meaningful conversation content to extract memories from')
        return
      }

      const extractionPrompt = this.memoryManager.buildExtractionPrompt(summary)

      const resolvedModel = this.provider.resolveModel(this.model)
      const modelConfig = this.provider.getModelConfig(this.model)
      const maxTokens = modelConfig?.defaultMaxTokens ?? 2048

      const requestOptions: ProviderRequestOptions = {
        model: resolvedModel,
        messages: [{
          role: 'user',
          content: extractionPrompt,
        }],
        maxTokens,
        temperature: 0.3,
        stream: false,
        systemPrompt: 'You are a memory extraction agent. Extract key information from conversations and output structured memory entries. Be concise and factual.',
      }

      logger.info('Starting memory extraction...')
      const response = await this.provider.createMessage(requestOptions)

      const responseText = response.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n')
        .trim()

      if (!responseText) {
        logger.debug('Memory extraction returned empty result')
        return
      }

      await this.parseAndSaveMemories(responseText)
      logger.info('Memory extraction completed')
    } catch (error) {
      logger.warn(`Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.extracting = false
    }
  }

  private summarizeConversation(messages: Message[]): string {
    const parts: string[] = []
    let totalChars = 0

    for (const msg of messages) {
      const text = msg.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n')

      if (!text.trim()) continue

      const role = msg.role === 'user' ? 'User' : 'Assistant'
      const entry = `[${role}]: ${text}`

      if (totalChars + entry.length > this.config.maxConversationChars) {
        const remaining = this.config.maxConversationChars - totalChars
        if (remaining > 100) {
          parts.push(entry.slice(0, remaining) + '...')
        }
        break
      }

      parts.push(entry)
      totalChars += entry.length
    }

    return parts.join('\n\n')
  }

  private async parseAndSaveMemories(responseText: string): Promise<void> {
    const memoryBlocks = this.parseMemoryBlocks(responseText)

    for (const block of memoryBlocks) {
      try {
        await this.memoryManager.saveMemoryFile(
          block.filename,
          block.type,
          block.description,
          block.content,
        )
      } catch (error) {
        logger.warn(`Failed to save memory "${block.filename}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private parseMemoryBlocks(text: string): Array<{
    filename: string
    type: string
    description: string
    content: string
  }> {
    const blocks: Array<{
      filename: string
      type: string
      description: string
      content: string
    }> = []

    const lines = text.split('\n')
    let currentBlock: typeof blocks[0] | null = null
    let contentLines: string[] = []

    for (const line of lines) {
      const typeMatch = line.match(/^##?\s+(?:Memory\s+)?(?:Type|类型):\s*(\w+)/i)
      const descMatch = line.match(/^##?\s+(?:Memory\s+)?(?:Description|描述):\s*(.+)/i)
      const fileMatch = line.match(/^##?\s+(?:Memory\s+)?(?:File|文件):\s*(.+)/i)
      const separatorMatch = line.match(/^---+$/)

      if (typeMatch || descMatch || fileMatch) {
        if (currentBlock && contentLines.length > 0) {
          currentBlock.content = contentLines.join('\n').trim()
          blocks.push(currentBlock)
          contentLines = []
        }

        if (!currentBlock) {
          currentBlock = {
            filename: `memory-${Date.now()}-${blocks.length}.md`,
            type: 'project',
            description: '',
            content: '',
          }
        }

        if (typeMatch) currentBlock.type = typeMatch[1].toLowerCase()
        else if (descMatch) currentBlock.description = descMatch[1].trim()
        else if (fileMatch) currentBlock.filename = fileMatch[1].trim()
        continue
      }

      if (separatorMatch && currentBlock) {
        if (contentLines.length > 0) {
          currentBlock.content = contentLines.join('\n').trim()
          blocks.push(currentBlock)
          currentBlock = {
            filename: `memory-${Date.now()}-${blocks.length}.md`,
            type: 'project',
            description: '',
            content: '',
          }
          contentLines = []
        }
        continue
      }

      if (currentBlock) {
        contentLines.push(line)
      }
    }

    if (currentBlock && contentLines.length > 0) {
      currentBlock.content = contentLines.join('\n').trim()
      if (currentBlock.content) {
        blocks.push(currentBlock)
      }
    }

    if (blocks.length === 0 && text.trim().length > 0) {
      blocks.push({
        filename: `memory-${Date.now()}.md`,
        type: 'project',
        description: 'Auto-extracted memory',
        content: text.trim(),
      })
    }

    return blocks
  }
}
