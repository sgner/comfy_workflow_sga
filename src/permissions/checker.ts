import type { PermissionMode } from '../core/types.js'

export interface PermissionRule {
  tool: string
  pattern?: string
  behavior: 'allow' | 'deny' | 'ask'
  reason?: string
}

export interface PermissionRuleSet {
  allow: PermissionRule[]
  deny: PermissionRule[]
  ask: PermissionRule[]
}

export interface PermissionCheckResult {
  behavior: 'allow' | 'deny' | 'ask'
  reason?: string
  matchedRule?: PermissionRule
}

export interface PermissionConfig {
  mode: PermissionMode
  rules: PermissionRuleSet
  isBypassPermissionsAvailable: boolean
  isAutoModeAvailable: boolean
  shouldAvoidPermissionPrompts: boolean
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  mode: 'default',
  rules: { allow: [], deny: [], ask: [] },
  isBypassPermissionsAvailable: false,
  isAutoModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
}

export class PermissionChecker {
  private config: PermissionConfig

  constructor(config: PermissionConfig = DEFAULT_PERMISSION_CONFIG) {
    this.config = config
  }

  updateConfig(config: Partial<PermissionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  check(toolName: string, input?: Record<string, unknown>): PermissionCheckResult {
    if (this.config.mode === 'bypassPermissions') {
      return { behavior: 'allow', reason: 'bypassPermissions mode' }
    }

    if (this.config.mode === 'auto' && this.config.isAutoModeAvailable) {
      const denyRule = this.findMatchingRule(toolName, input, this.config.rules.deny)
      if (denyRule) return { behavior: 'deny', matchedRule: denyRule, reason: denyRule.reason }
      return { behavior: 'allow', reason: 'auto mode' }
    }

    const denyRule = this.findMatchingRule(toolName, input, this.config.rules.deny)
    if (denyRule) return { behavior: 'deny', matchedRule: denyRule, reason: denyRule.reason }

    const allowRule = this.findMatchingRule(toolName, input, this.config.rules.allow)
    if (allowRule) return { behavior: 'allow', matchedRule: allowRule, reason: allowRule.reason }

    const askRule = this.findMatchingRule(toolName, input, this.config.rules.ask)
    if (askRule) return { behavior: 'ask', matchedRule: askRule, reason: askRule.reason }

    if (this.config.mode === 'plan') {
      return { behavior: 'ask', reason: 'plan mode requires approval for write operations' }
    }

    return { behavior: 'ask', reason: 'No matching rule found' }
  }

  private findMatchingRule(
    toolName: string,
    input: Record<string, unknown> | undefined,
    rules: PermissionRule[],
  ): PermissionRule | undefined {
    return rules.find(rule => {
      if (rule.tool !== toolName && rule.tool !== '*') return false
      if (rule.pattern && input) {
        return matchRulePattern(rule.pattern, input)
      }
      return true
    })
  }
}

function matchRulePattern(pattern: string, input: Record<string, unknown>): boolean {
  const path = (input as { path?: string }).path ?? (input as { command?: string }).command ?? ''
  if (!path) return false

  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return regex.test(path)
  }

  return path.startsWith(pattern)
}

export function parsePermissionRules(rules: string[]): PermissionRule[] {
  return rules.map(rule => {
    const parts = rule.split(':')
    return {
      tool: parts[0],
      pattern: parts[1],
      behavior: parts[2] as 'allow' | 'deny' | 'ask',
      reason: parts.slice(3).join(':'),
    }
  })
}
