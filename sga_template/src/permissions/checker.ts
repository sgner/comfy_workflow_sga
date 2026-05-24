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

export class PermissionChecker {
  private config: PermissionConfig

  constructor(config: PermissionConfig = DEFAULT_PERMISSION_CONFIG) {
    this.config = config
  }

  get mode(): PermissionMode {
    return this.config.mode
  }

  updateConfig(config: Partial<PermissionConfig>): void {
    this.config = { ...this.config, ...config }
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
