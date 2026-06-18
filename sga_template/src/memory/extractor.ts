import type { Message } from '../core/types.js'
import type { LLMProvider, ProviderRequestOptions } from '../providers/types.js'
import type { MemoryManager } from './manager.js'
import type { MemoryScope, MemoryType } from './types.js'
import { DEFAULT_MEMORY_EXTRACT_CONFIG, MEMORY_TYPES } from './types.js'
import { shouldDedupBeforeSave } from './dedup.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('memory-extractor')

export interface MemoryExtractorConfig {
  enabled: boolean
  maxTurnsBetweenExtractions: number
  maxConversationChars: number
  forceScope?: MemoryScope
}

export const DEFAULT_EXTRACTOR_CONFIG: MemoryExtractorConfig = {
  enabled: true,
  maxTurnsBetweenExtractions: 3,
  maxConversationChars: 20_000,
}

const SCOPE_INDICATORS: Record<MemoryScope, string[]> = {
  global: [
    'user preference', 'user prefers', 'user always', 'user never',
    '用户偏好', '用户喜欢', '用户不喜欢', '用户总是', '用户从不',
    'universal', 'always apply', 'cross-project',
  ],
  project: [
    'project structure', 'codebase', 'architecture', 'tech stack',
    '项目结构', '代码库', '架构', '技术栈',
    'convention', 'coding style', 'project rule',
  ],
  session: [
    'current task', 'just now', 'in this conversation', 'temporary',
    '当前任务', '刚才', '本次对话', '临时',
    'working on', 'debugging', 'currently',
  ],
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
        systemPrompt: `You are a memory extraction agent. Extract key information from conversations and output structured memory entries. Be concise and factual.

For each memory, also determine the appropriate scope:
- **global**: User preferences, universal patterns that apply across all projects
- **project**: Project-specific knowledge, codebase conventions, architecture decisions
- **session**: Temporary context, current task state, debugging notes specific to this conversation

Output format for each memory:
## Type: <type>
## Scope: <global|project|session>
## Description: <description>
## File: <filename>
<content>`,
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
    const existingMemories = await this.memoryManager.listMemoriesByScope('session')

    for (const block of memoryBlocks) {
      try {
        const dedupCheck = shouldDedupBeforeSave(
          { type: block.type, description: block.description, content: block.content },
          existingMemories,
        )

        if (dedupCheck.isDuplicate) {
          logger.info(`Skipping duplicate memory "${block.filename}": ${dedupCheck.reason} (existing: ${dedupCheck.existingPath})`)
          continue
        }

        const scope = this.config.forceScope ?? block.scope ?? this.inferScopeFromContent(block.type, block.description, block.content)
        await this.memoryManager.saveMemoryFile(
          block.filename,
          block.type,
          block.description,
          block.content,
          scope,
        )
      } catch (error) {
        logger.warn(`Failed to save memory "${block.filename}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  inferScopeFromContent(type: string, description: string, content: string): MemoryScope {
    const typeConfig = MEMORY_TYPES[type as MemoryType]
    if (typeConfig) {
      return typeConfig.defaultScope
    }

    const textToAnalyze = `${description} ${content}`.toLowerCase()

    let globalScore = 0
    let projectScore = 0
    let sessionScore = 0

    for (const indicator of SCOPE_INDICATORS.global) {
      if (textToAnalyze.includes(indicator.toLowerCase())) globalScore += 2
    }

    for (const indicator of SCOPE_INDICATORS.project) {
      if (textToAnalyze.includes(indicator.toLowerCase())) projectScore += 2
    }

    for (const indicator of SCOPE_INDICATORS.session) {
      if (textToAnalyze.includes(indicator.toLowerCase())) sessionScore += 2
    }

    if (type === 'user') globalScore += 3
    if (type === 'session') sessionScore += 5
    if (type === 'project' || type === 'reference') projectScore += 3
    if (type === 'feedback') projectScore += 2

    const maxScore = Math.max(globalScore, projectScore, sessionScore)
    if (maxScore === 0) return 'project'

    if (globalScore === maxScore) return 'global'
    if (sessionScore === maxScore) return 'session'
    return 'project'
  }

  private parseMemoryBlocks(text: string): Array<{
    filename: string
    type: string
    description: string
    content: string
    scope?: MemoryScope
  }> {
    const blocks: Array<{
      filename: string
      type: string
      description: string
      content: string
      scope?: MemoryScope
    }> = []

    const lines = text.split('\n')
    let currentBlock: typeof blocks[0] | null = null
    let contentLines: string[] = []

    for (const line of lines) {
      const typeMatch = line.match(/^##?\s+(?:Memory\s+)?(?:Type|类型):\s*(\w+)/i)
      const descMatch = line.match(/^##?\s+(?:Memory\s+)?(?:Description|描述):\s*(.+)/i)
      const fileMatch = line.match(/^##?\s+(?:Memory\s+)?(?:File|文件):\s*(.+)/i)
      const scopeMatch = line.match(/^##?\s+(?:Memory\s+)?(?:Scope|作用域):\s*(global|project|session)/i)
      const separatorMatch = line.match(/^---+$/)

      if (typeMatch || descMatch || fileMatch || scopeMatch) {
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
        else if (scopeMatch) currentBlock.scope = scopeMatch[1].toLowerCase() as MemoryScope
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
