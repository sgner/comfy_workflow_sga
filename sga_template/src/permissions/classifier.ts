import type { ToolUseContext } from '../tools/base.js'
import { createLogger } from '../utils/logger.js'
import { categorizePathRisk } from '../tools/built-in/sensitive-paths.js'

const logger = createLogger('permission-classifier')

export interface ClassificationResult {
  decision: 'allow' | 'deny' | 'ask'
  confidence: number
  reason: string
  ruleId?: string
}

export interface PermissionClassifier {
  classify(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): ClassificationResult
}

const SAFE_READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'LS', 'LSP', 'TodoRead',
])

const SAFE_WRITE_PATTERNS: Array<{
  toolName: string
  pattern: (input: Record<string, unknown>) => boolean
  reason: string
}> = [
  {
    toolName: 'Write',
    pattern: (input) => {
      const path = (input as { path?: string }).path ?? ''
      return path.endsWith('.md') || path.endsWith('.txt') || path.endsWith('.json')
    },
    reason: 'Writing to documentation/data file',
  },
  {
    toolName: 'Edit',
    pattern: (input) => {
      const path = (input as { path?: string }).path ?? ''
      return path.endsWith('.md') || path.endsWith('.txt') || path.endsWith('.json')
    },
    reason: 'Editing documentation/data file',
  },
  {
    toolName: 'Bash',
    pattern: (input) => {
      const command = (input as { command?: string }).command ?? ''
      const readOnlyPrefixes = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'pwd', 'which', 'where', 'type', 'git status', 'git log', 'git diff', 'git branch', 'git remote', 'node --version', 'npm --version', 'python --version', 'pip --version']
      return readOnlyPrefixes.some(prefix => command.trimStart().startsWith(prefix))
    },
    reason: 'Read-only bash command',
  },
  {
    toolName: 'Bash',
    pattern: (input) => {
      const command = (input as { command?: string }).command ?? ''
      const safeWritePrefixes = ['npm install', 'npm ci', 'pip install', 'mkdir', 'touch']
      return safeWritePrefixes.some(prefix => command.trimStart().startsWith(prefix))
    },
    reason: 'Safe package install or directory creation',
  },
]

const DANGEROUS_PATTERNS: Array<{
  toolName: string
  pattern: (input: Record<string, unknown>) => boolean
  reason: string
}> = [
  {
    toolName: 'Bash',
    pattern: (input) => {
      const command = (input as { command?: string }).command ?? ''
      const dangerous = /^(rm\s+-rf|rm\s+-r|dd\s+if=|mkfs|format\s+[a-z]:|shutdown|reboot|poweroff|sudo\s+rm|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh)/i
      return dangerous.test(command.trim())
    },
    reason: 'Dangerous command detected',
  },
  {
    toolName: 'Bash',
    pattern: (input) => {
      const command = (input as { command?: string }).command ?? ''
      return />\s*\/dev\/(null|zero|sda)/i.test(command)
    },
    reason: 'Writing to device file',
  },
  {
    toolName: 'Write',
    pattern: (input) => {
      const path = (input as { path?: string }).path ?? ''
      const risk = categorizePathRisk(path)
      return risk.level === 'critical'
    },
    reason: 'Writing to critical path',
  },
  {
    toolName: 'Edit',
    pattern: (input) => {
      const path = (input as { path?: string }).path ?? ''
      const risk = categorizePathRisk(path)
      return risk.level === 'critical'
    },
    reason: 'Editing critical path',
  },
]

export class DefaultPermissionClassifier implements PermissionClassifier {
  classify(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): ClassificationResult {
    if (context.permissionMode === 'bypassPermissions') {
      return { decision: 'allow', confidence: 1.0, reason: 'bypassPermissions mode', ruleId: 'mode_bypass' }
    }

    if (context.permissionMode === 'auto') {
      return this.classifyForAutoMode(toolName, input, context)
    }

    if (context.permissionMode === 'dontAsk') {
      return this.classifyForDontAskMode(toolName, input, context)
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.toolName === toolName && pattern.pattern(input)) {
        return { decision: 'deny', confidence: 0.95, reason: pattern.reason, ruleId: 'dangerous_pattern' }
      }
    }

    if (SAFE_READ_TOOLS.has(toolName)) {
      return { decision: 'allow', confidence: 0.9, reason: `Safe read-only tool: ${toolName}`, ruleId: 'safe_read_tool' }
    }

    for (const pattern of SAFE_WRITE_PATTERNS) {
      if (pattern.toolName === toolName && pattern.pattern(input)) {
        return { decision: 'allow', confidence: 0.8, reason: pattern.reason, ruleId: 'safe_write_pattern' }
      }
    }

    if (this.isInProjectDirectory(toolName, input)) {
      return { decision: 'ask', confidence: 0.5, reason: 'Operation within project directory, needs confirmation', ruleId: 'in_project' }
    }

    return { decision: 'ask', confidence: 0.3, reason: 'Unknown operation, requires approval', ruleId: 'default_ask' }
  }

  private classifyForAutoMode(
    toolName: string,
    input: Record<string, unknown>,
    _context: ToolUseContext,
  ): ClassificationResult {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.toolName === toolName && pattern.pattern(input)) {
        return { decision: 'deny', confidence: 0.95, reason: pattern.reason, ruleId: 'auto_dangerous' }
      }
    }

    return { decision: 'allow', confidence: 0.7, reason: 'Auto mode: allowing operation', ruleId: 'auto_allow' }
  }

  private classifyForDontAskMode(
    toolName: string,
    input: Record<string, unknown>,
    _context: ToolUseContext,
  ): ClassificationResult {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.toolName === toolName && pattern.pattern(input)) {
        return { decision: 'deny', confidence: 0.95, reason: pattern.reason, ruleId: 'dontask_dangerous' }
      }
    }

    return { decision: 'allow', confidence: 0.6, reason: 'dontAsk mode: allowing without prompt', ruleId: 'dontask_allow' }
  }

  private isInProjectDirectory(toolName: string, input: Record<string, unknown>): boolean {
    const path = (input as { path?: string }).path ?? (input as { command?: string }).command ?? ''
    if (!path) return false

    const cwd = process.cwd()
    const normalizedPath = path.replace(/[/\\]+/g, '/')
    const normalizedCwd = cwd.replace(/[/\\]+/g, '/')

    return normalizedPath.startsWith(normalizedCwd) || normalizedPath.startsWith('./') || normalizedPath.startsWith('../')
  }
}

export class CompositePermissionClassifier implements PermissionClassifier {
  private classifiers: PermissionClassifier[]

  constructor(classifiers: PermissionClassifier[]) {
    this.classifiers = classifiers
  }

  classify(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): ClassificationResult {
    let bestResult: ClassificationResult = {
      decision: 'ask',
      confidence: 0,
      reason: 'No classifier provided a result',
    }

    for (const classifier of this.classifiers) {
      const result = classifier.classify(toolName, input, context)

      if (result.decision === 'deny') {
        return result
      }

      if (result.confidence > bestResult.confidence) {
        bestResult = result
      }
    }

    return bestResult
  }
}

export function createDefaultClassifier(): PermissionClassifier {
  return new DefaultPermissionClassifier()
}

export function createCompositeClassifier(classifiers: PermissionClassifier[]): PermissionClassifier {
  return new CompositePermissionClassifier(classifiers)
}
