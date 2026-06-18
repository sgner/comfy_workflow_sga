import type { PermissionMode } from '../core/types.js'
import type { PermissionResult } from '../tools/base.js'
import type { PermissionClassifier } from './classifier.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('permission-checker')

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
  classifier?: PermissionClassifier
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  mode: 'default',
  rules: { allow: [], deny: [], ask: [] },
  isBypassPermissionsAvailable: false,
  isAutoModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
}

export const DANGEROUS_ALLOW_PATTERNS: Array<{ tool: string; pattern?: string; reason: string }> = [
  { tool: 'Bash', pattern: '*', reason: 'Bash(*) allows arbitrary command execution, bypassing all safety evaluation' },
  { tool: 'Bash', pattern: 'rm*', reason: 'Bash(rm*) allows destructive deletion commands' },
  { tool: 'PowerShell', pattern: '*', reason: 'PowerShell(*) allows arbitrary PowerShell execution' },
  { tool: 'PowerShell', pattern: 'iex:*', reason: 'PowerShell(iex:*) allows Invoke-Expression, equivalent to eval()' },
  { tool: 'Agent', pattern: '*', reason: 'Agent(*) allows unrestricted subagent spawning, bypassing blast radius control' },
  { tool: 'Write', pattern: '/**', reason: 'Write(/**) allows writing to any path including system directories' },
  { tool: 'Edit', pattern: '/**', reason: 'Edit(/**) allows editing any file including system files' },
]

export interface StrippedRuleRecord {
  originalRule: PermissionRule
  strippedAt: Date
  reason: string
}

export function stripDangerousAllowRules(rules: PermissionRuleSet): {
  cleaned: PermissionRuleSet
  stripped: StrippedRuleRecord[]
} {
  const stripped: StrippedRuleRecord[] = []
  const cleanedAllow: PermissionRule[] = []

  for (const rule of rules.allow) {
    const isDangerous = DANGEROUS_ALLOW_PATTERNS.some(danger =>
      danger.tool === rule.tool &&
      (!danger.pattern || danger.pattern === rule.pattern || (danger.pattern === '*' && (!rule.pattern || rule.pattern === '*')))
    )

    if (isDangerous) {
      const danger = DANGEROUS_ALLOW_PATTERNS.find(d =>
        d.tool === rule.tool &&
        (!d.pattern || d.pattern === rule.pattern || (d.pattern === '*' && (!rule.pattern || rule.pattern === '*')))
      )
      stripped.push({
        originalRule: rule,
        strippedAt: new Date(),
        reason: danger?.reason ?? 'Dangerous allow rule',
      })
    } else {
      cleanedAllow.push(rule)
    }
  }

  return {
    cleaned: { allow: cleanedAllow, deny: rules.deny, ask: rules.ask },
    stripped,
  }
}

export class PermissionChecker {
  private config: PermissionConfig
  private strippedRules: StrippedRuleRecord[] = []
  private originalRules: PermissionRuleSet | null = null

  constructor(config: PermissionConfig = DEFAULT_PERMISSION_CONFIG) {
    this.config = config
  }

  get mode(): PermissionMode {
    return this.config.mode
  }

  updateConfig(config: Partial<PermissionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  enterAutoMode(): StrippedRuleRecord[] {
    if (this.config.mode === 'auto') return []

    this.originalRules = {
      allow: [...this.config.rules.allow],
      deny: [...this.config.rules.deny],
      ask: [...this.config.rules.ask],
    }

    const { cleaned, stripped } = stripDangerousAllowRules(this.config.rules)
    this.config.rules = cleaned
    this.strippedRules = stripped
    this.config.mode = 'auto'
    this.config.isAutoModeAvailable = true
    this.config.shouldAvoidPermissionPrompts = true

    if (stripped.length > 0) {
      logger.warn(`[PermissionChecker] Entering auto mode: stripped ${stripped.length} dangerous allow rule(s): ${stripped.map(s => s.reason).join('; ')}`)
    }

    return stripped
  }

  exitAutoMode(): void {
    if (this.originalRules) {
      this.config.rules = this.originalRules
      this.originalRules = null
      this.strippedRules = []
    }
    this.config.mode = 'default'
    this.config.isAutoModeAvailable = false
    this.config.shouldAvoidPermissionPrompts = false
  }

  getStrippedRules(): StrippedRuleRecord[] {
    return [...this.strippedRules]
  }

  getRules(): PermissionRuleSet {
    return {
      allow: [...this.config.rules.allow],
      deny: [...this.config.rules.deny],
      ask: [...this.config.rules.ask],
    }
  }

  get shouldAvoidPermissionPrompts(): boolean {
    return this.config.shouldAvoidPermissionPrompts
  }

  addRule(rule: PermissionRule): void {
    const list = this.config.rules[rule.behavior]
    const exists = list.some(r => r.tool === rule.tool && r.pattern === rule.pattern)
    if (!exists) {
      list.push(rule)
    }
  }

  removeRule(behavior: 'allow' | 'deny' | 'ask', tool: string, pattern?: string): void {
    const list = this.config.rules[behavior]
    const idx = list.findIndex(r => r.tool === tool && r.pattern === pattern)
    if (idx >= 0) {
      list.splice(idx, 1)
    }
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

    if (this.config.mode === 'dontAsk') {
      const denyRule = this.findMatchingRule(toolName, input, this.config.rules.deny)
      if (denyRule) return { behavior: 'deny', matchedRule: denyRule, reason: denyRule.reason }
      const allowRule = this.findMatchingRule(toolName, input, this.config.rules.allow)
      if (allowRule) return { behavior: 'allow', matchedRule: allowRule, reason: allowRule.reason }
      return { behavior: 'allow', reason: 'dontAsk mode: default allow' }
    }

    if (this.config.mode === 'acceptEdits') {
      const denyRule = this.findMatchingRule(toolName, input, this.config.rules.deny)
      if (denyRule) return { behavior: 'deny', matchedRule: denyRule, reason: denyRule.reason }
      const editTools = ['FileEdit', 'FileWrite', 'NotebookEdit']
      if (editTools.includes(toolName)) {
        return { behavior: 'allow', reason: 'acceptEdits mode: auto-approve edit tools' }
      }
    }

    const denyRule = this.findMatchingRule(toolName, input, this.config.rules.deny)
    if (denyRule) return { behavior: 'deny', matchedRule: denyRule, reason: denyRule.reason }

    const allowRule = this.findMatchingRule(toolName, input, this.config.rules.allow)
    if (allowRule) return { behavior: 'allow', matchedRule: allowRule, reason: allowRule.reason }

    const askRule = this.findMatchingRule(toolName, input, this.config.rules.ask)
    if (askRule) return { behavior: 'ask', matchedRule: askRule, reason: askRule.reason }

    if (this.config.classifier) {
      try {
        const classification = this.config.classifier.classify(toolName, input ?? {}, {
          tools: [],
          messages: [],
          abortController: new AbortController(),
          getAppState: () => ({}),
          setAppState: () => {},
          permissionMode: this.config.mode,
        })

        if (classification.decision === 'deny' && classification.confidence >= 0.8) {
          return { behavior: 'deny', reason: classification.reason }
        }

        if (classification.decision === 'allow' && classification.confidence >= 0.85) {
          return { behavior: 'allow', reason: `Auto-approved by classifier: ${classification.reason}` }
        }
      } catch (error) {
        logger.debug(`Classifier failed for ${toolName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (this.config.mode === 'plan') {
      return { behavior: 'ask', reason: 'plan mode requires approval for write operations' }
    }

    return { behavior: 'ask', reason: 'No matching rule found' }
  }

  resolveWithToolPermission(
    toolResult: PermissionResult,
    toolName: string,
    input?: Record<string, unknown>,
  ): PermissionResult {
    if (toolResult.behavior === 'deny') {
      return toolResult
    }

    if (toolResult.behavior === 'allow') {
      const ruleResult = this.check(toolName, input)
      if (ruleResult.behavior === 'deny') {
        return { behavior: 'deny', message: ruleResult.reason ?? 'Denied by rule', decisionReason: 'rule_deny' }
      }
      return toolResult
    }

    if (toolResult.behavior === 'ask') {
      const ruleResult = this.check(toolName, input)
      if (ruleResult.behavior === 'allow') {
        return { behavior: 'allow', decisionReason: ruleResult.reason ?? 'Allowed by rule' }
      }
      if (ruleResult.behavior === 'deny') {
        return { behavior: 'deny', message: ruleResult.reason ?? 'Denied by rule', decisionReason: 'rule_deny' }
      }

      if (this.config.mode === 'bypassPermissions') {
        return { behavior: 'allow', decisionReason: 'bypassPermissions mode overrides ask' }
      }
      if (this.config.mode === 'auto' && this.config.isAutoModeAvailable) {
        return { behavior: 'allow', decisionReason: 'auto mode overrides ask' }
      }
      if (this.config.mode === 'dontAsk') {
        return { behavior: 'allow', decisionReason: 'dontAsk mode overrides ask' }
      }

      return toolResult
    }

    return toolResult
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

export function createPermissionChecker(mode: PermissionMode, rules?: PermissionRule[], classifier?: PermissionClassifier): PermissionChecker {
  const ruleSet: PermissionRuleSet = { allow: [], deny: [], ask: [] }
  if (rules) {
    for (const rule of rules) {
      ruleSet[rule.behavior].push(rule)
    }
  }

  return new PermissionChecker({
    mode,
    rules: ruleSet,
    isBypassPermissionsAvailable: mode === 'bypassPermissions',
    isAutoModeAvailable: mode === 'auto',
    shouldAvoidPermissionPrompts: mode === 'auto' || mode === 'bypassPermissions' || mode === 'dontAsk',
    classifier,
  })
}
