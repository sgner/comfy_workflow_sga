import type { ToolUseContext } from '../tools/base.js'
import { createLogger } from '../utils/logger.js'
import { categorizePathRisk } from '../tools/built-in/sensitive-paths.js'

const logger = createLogger('permission-classifier')

export interface ClassificationResult {
  decision: 'allow' | 'deny' | 'ask'
  confidence: number
  reason: string
  ruleId?: string
  errorCategory?: ErrorCategory
}

export type ErrorCategory =
  | 'network'
  | 'filesystem'
  | 'permission'
  | 'validation'
  | 'timeout'
  | 'resource'
  | 'unknown'

export interface PermissionClassifier {
  classify(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): ClassificationResult
}

export interface BashCommandCategory {
  category: 'safe_read' | 'safe_write' | 'build' | 'test' | 'install' | 'git_read' | 'git_write' | 'dangerous' | 'network' | 'system' | 'unknown'
  confidence: number
  reason: string
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
      const readOnlyPrefixes = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'pwd', 'which', 'where', 'type', 'git status', 'git log', 'git diff', 'git branch', 'git remote', 'node --version', 'npm --version', 'python --version', 'pip --version',
        'dir', 'Get-Content', 'Get-ChildItem', 'Select-String', 'Get-Process', 'Get-Service', 'Get-Location', 'Test-Path', 'Get-Command', 'Get-Date', 'Get-Host', 'Get-Help', 'Get-Item', 'Get-ItemProperty', 'Get-Volume',
        'where.exe', 'systeminfo', 'tasklist', 'ipconfig', 'hostname', 'whoami', 'ver']
      return readOnlyPrefixes.some(prefix => command.trimStart().startsWith(prefix))
    },
    reason: 'Read-only bash command',
  },
  {
    toolName: 'Bash',
    pattern: (input) => {
      const command = (input as { command?: string }).command ?? ''
      const safeWritePrefixes = ['npm install', 'npm ci', 'pip install', 'mkdir', 'touch',
        'New-Item', 'Copy-Item', 'Move-Item', 'Set-Content', 'Add-Content', 'Install-Module']
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

export function classifyBashCommand(command: string): BashCommandCategory {
  const trimmed = command.trimStart()

  const safeReadPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(ls|cat|head|tail|grep|find|wc|pwd|which|where|type|file|stat|du|df|uname|env|printenv|echo)\b/, reason: 'Read-only system command' },
    { pattern: /^(git\s+status|git\s+log|git\s+diff|git\s+branch|git\s+remote|git\s+show|git\s+stash\s+list)\b/, reason: 'Read-only git command' },
    { pattern: /^(node|npm|npx|yarn|pnpm|python|python3|pip|pip3|java|javac|go|cargo|rustc)\s+--version/, reason: 'Version check command' },
    { pattern: /^(npm\s+run|npm\s+test|yarn\s+test|pnpm\s+test|pytest|jest|vitest|mocha)\b/, reason: 'Test runner command' },
    { pattern: /^(npm\s+run\s+build|npm\s+run\s+lint|npm\s+run\s+typecheck|tsc|eslint|prettier)\b/, reason: 'Build/lint command' },
    { pattern: /^(dir|Get-Content|Get-ChildItem|Select-String|Get-Process|Get-Service|Get-Item|Get-ItemProperty|Get-Location|Get-Date|Get-Host|Get-Command|Get-Help|Test-Path|Get-Volume)\b/i, reason: 'PowerShell read-only command' },
    { pattern: /^(where\.exe|systeminfo|tasklist|ipconfig|hostname|whoami|ver|type)\b/i, reason: 'Windows read-only system command' },
  ]

  for (const { pattern, reason } of safeReadPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'safe_read', confidence: 0.9, reason }
    }
  }

  const gitReadPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^git\s+(status|log|diff|branch|remote|show|stash\s+list|tag\s+list|rev-parse)\b/, reason: 'Read-only git operation' },
  ]

  for (const { pattern, reason } of gitReadPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'git_read', confidence: 0.9, reason }
    }
  }

  const gitWritePatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash\s+pop|stash\s+drop|cherry-pick|tag)\b/, reason: 'Write git operation' },
  ]

  for (const { pattern, reason } of gitWritePatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'git_write', confidence: 0.85, reason }
    }
  }

  const installPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(npm\s+install|npm\s+ci|yarn\s+install|pnpm\s+install|pip\s+install|pip3\s+install|cargo\s+add|go\s+get)\b/, reason: 'Package installation' },
    { pattern: /^(Install-Module|Install-Package)\b/i, reason: 'PowerShell package installation' },
  ]

  for (const { pattern, reason } of installPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'install', confidence: 0.8, reason }
    }
  }

  const buildPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(npm\s+run\s+build|yarn\s+build|pnpm\s+build|cargo\s+build|go\s+build|make|cmake)\b/, reason: 'Build command' },
    { pattern: /^(npm\s+run\s+lint|eslint|prettier|tsc|pylint|mypy|ruff)\b/, reason: 'Lint/typecheck command' },
  ]

  for (const { pattern, reason } of buildPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'build', confidence: 0.8, reason }
    }
  }

  const testPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(npm\s+test|yarn\s+test|pnpm\s+test|pytest|jest|vitest|mocha|cargo\s+test|go\s+test)\b/, reason: 'Test command' },
  ]

  for (const { pattern, reason } of testPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'test', confidence: 0.85, reason }
    }
  }

  const networkPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(curl|wget|ssh|scp|rsync|nc|netcat)\b/, reason: 'Network command' },
  ]

  for (const { pattern, reason } of networkPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'network', confidence: 0.7, reason }
    }
  }

  const systemPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(sudo|su|chmod|chown|systemctl|service|docker|kubectl|terraform)\b/, reason: 'System administration command' },
    { pattern: /^(net\s+(user|localgroup|stop|start)|reg\s+(add|delete|query)|diskpart|bcdedit|sfc|netsh)\b/i, reason: 'Windows system administration command' },
    { pattern: /^(Start-Service|Stop-Service|Set-Service|New-Service|Remove-Service)\b/i, reason: 'PowerShell service management command' },
  ]

  for (const { pattern, reason } of systemPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'system', confidence: 0.6, reason }
    }
  }

  const dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^(rm\s+-rf|rm\s+-r\s|dd\s+if=|mkfs|format\s+[a-z]:|shutdown|reboot|poweroff)\b/i, reason: 'Destructive command' },
    { pattern: /curl\s+.*\|\s*(sh|bash|zsh)/, reason: 'Remote script execution' },
    { pattern: /wget\s+.*\|\s*(sh|bash|zsh)/, reason: 'Remote script execution' },
    { pattern: />\s*\/dev\/(null|zero|sda)/i, reason: 'Writing to device file' },
    { pattern: /sudo\s+rm\b/, reason: 'Privileged deletion' },
    { pattern: /^(rd\s+\/s|del\s+\/[fq]\s+\/s|rmdir\s+\/s)\b/i, reason: 'Windows destructive delete command' },
    { pattern: /\bRemove-Item\s+.*-Recurse\s+-Force/i, reason: 'PowerShell destructive remove' },
    { pattern: /\b(Stop-Computer|Restart-Computer)\b/i, reason: 'PowerShell shutdown/restart command' },
    { pattern: /\bdiskpart\b/i, reason: 'Windows disk partition tool' },
  ]

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return { category: 'dangerous', confidence: 0.95, reason }
    }
  }

  return { category: 'unknown', confidence: 0.3, reason: 'Unclassified command' }
}

export function classifyError(error: string): ErrorCategory {
  const lower = error.toLowerCase()

  if (/econnrefused|etimedout|enotfound|econnreset|network|dns|socket/.test(lower)) {
    return 'network'
  }
  if (/enoent|eacces|eperm|enoent|not found|no such file|permission denied|access denied/.test(lower)) {
    return 'filesystem'
  }
  if (/forbidden|unauthorized|authentication|auth|token|credential/.test(lower)) {
    return 'permission'
  }
  if (/validation|invalid|malformed|schema|type error|typeerror/.test(lower)) {
    return 'validation'
  }
  if (/timeout|timed out|deadline|expired/.test(lower)) {
    return 'timeout'
  }
  if (/out of memory|oom|resource|quota|limit|capacity/.test(lower)) {
    return 'resource'
  }

  return 'unknown'
}

export class DefaultPermissionClassifier implements PermissionClassifier {
  private hookDecisions: Map<string, ClassificationResult> = new Map()

  setHookDecision(key: string, result: ClassificationResult): void {
    this.hookDecisions.set(key, result)
  }

  classify(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): ClassificationResult {
    const hookKey = `${toolName}:${JSON.stringify(input)}`
    const hookDecision = this.hookDecisions.get(hookKey)
    if (hookDecision) {
      logger.debug(`Using hook decision for ${toolName}`)
      return hookDecision
    }

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

    if (toolName === 'Bash') {
      return this.classifyBashTool(input)
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

  private classifyBashTool(input: Record<string, unknown>): ClassificationResult {
    const command = (input as { command?: string }).command ?? ''
    const category = classifyBashCommand(command)

    switch (category.category) {
      case 'safe_read':
        return { decision: 'allow', confidence: category.confidence, reason: category.reason, ruleId: 'bash_safe_read' }
      case 'git_read':
        return { decision: 'allow', confidence: category.confidence, reason: category.reason, ruleId: 'bash_git_read' }
      case 'test':
        return { decision: 'allow', confidence: category.confidence, reason: category.reason, ruleId: 'bash_test' }
      case 'build':
        return { decision: 'allow', confidence: category.confidence, reason: category.reason, ruleId: 'bash_build' }
      case 'install':
        return { decision: 'ask', confidence: category.confidence, reason: category.reason, ruleId: 'bash_install' }
      case 'git_write':
        return { decision: 'ask', confidence: category.confidence, reason: category.reason, ruleId: 'bash_git_write' }
      case 'network':
        return { decision: 'ask', confidence: category.confidence, reason: category.reason, ruleId: 'bash_network' }
      case 'system':
        return { decision: 'ask', confidence: category.confidence, reason: category.reason, ruleId: 'bash_system' }
      case 'dangerous':
        return { decision: 'deny', confidence: category.confidence, reason: category.reason, ruleId: 'bash_dangerous' }
      case 'safe_write':
        return { decision: 'ask', confidence: category.confidence, reason: category.reason, ruleId: 'bash_safe_write' }
      default:
        return { decision: 'ask', confidence: 0.3, reason: 'Unclassified bash command', ruleId: 'bash_unknown' }
    }
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

    if (toolName === 'Bash') {
      const category = classifyBashCommand((input as { command?: string }).command ?? '')
      if (category.category === 'dangerous') {
        return { decision: 'deny', confidence: category.confidence, reason: category.reason, ruleId: 'auto_bash_dangerous' }
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
