import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { PermissionMode } from '../core/types.js'
import type { PermissionRule, PermissionRuleSet } from './checker.js'
import { PermissionChecker, createPermissionChecker } from './checker.js'
import { getSgaHome } from '../memory/paths.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('permission-rules')

export interface PermissionRuleFile {
  version: number
  mode: PermissionMode
  rules: {
    allow: Array<{ tool: string; pattern?: string; reason?: string }>
    deny: Array<{ tool: string; pattern?: string; reason?: string }>
    ask: Array<{ tool: string; pattern?: string; reason?: string }>
  }
}

const CURRENT_RULE_FILE_VERSION = 1

const DEFAULT_RULES: PermissionRuleFile = {
  version: CURRENT_RULE_FILE_VERSION,
  mode: 'default',
  rules: {
    allow: [
      { tool: 'Glob', reason: 'Read-only file search' },
      { tool: 'Grep', reason: 'Read-only content search' },
      { tool: 'FileRead', reason: 'Read-only file access' },
      { tool: 'WebFetch', reason: 'Read-only web access' },
      { tool: 'WebSearch', reason: 'Read-only web search' },
      { tool: 'TodoWrite', reason: 'Task tracking' },
      { tool: 'ToolUseSummary', reason: 'Internal tool' },
    ],
    deny: [],
    ask: [
      { tool: 'Bash', pattern: 'rm *', reason: 'Destructive file operations' },
      { tool: 'Bash', pattern: 'chmod *', reason: 'Permission changes' },
      { tool: 'Bash', pattern: 'curl *| *sh', reason: 'Remote script execution' },
    ],
  },
}

export function getPermissionRulesPath(): string {
  return join(getSgaHome(), 'permissions', 'rules.json')
}

export function getProjectPermissionRulesPath(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd()
  return join(root, '.sga', 'permissions.json')
}

export function loadPermissionRules(filePath?: string): PermissionRuleFile {
  const paths = filePath
    ? [filePath]
    : [getProjectPermissionRulesPath(), getPermissionRulesPath()]

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8')
        const parsed = JSON.parse(content) as PermissionRuleFile

        if (!parsed.version || parsed.version < CURRENT_RULE_FILE_VERSION) {
          logger.info(`Migrating permission rules from version ${parsed.version ?? 0} to ${CURRENT_RULE_FILE_VERSION}`)
          const migrated = migrateRuleFile(parsed)
          savePermissionRules(migrated, p)
          return migrated
        }

        return parsed
      } catch (error) {
        logger.warn(`Failed to load permission rules from ${p}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  logger.info('No permission rules file found, using defaults')
  return { ...DEFAULT_RULES }
}

export function savePermissionRules(rules: PermissionRuleFile, filePath?: string): void {
  const targetPath = filePath ?? getProjectPermissionRulesPath()
  const dir = join(targetPath, '..')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  rules.version = CURRENT_RULE_FILE_VERSION
  writeFileSync(targetPath, JSON.stringify(rules, null, 2), 'utf-8')
  logger.info(`Permission rules saved to ${targetPath}`)
}

function migrateRuleFile(old: Partial<PermissionRuleFile>): PermissionRuleFile {
  return {
    version: CURRENT_RULE_FILE_VERSION,
    mode: old.mode ?? 'default',
    rules: {
      allow: old.rules?.allow ?? DEFAULT_RULES.rules.allow,
      deny: old.rules?.deny ?? DEFAULT_RULES.rules.deny,
      ask: old.rules?.ask ?? DEFAULT_RULES.rules.ask,
    },
  }
}

export function ruleFileToRuleSet(rules: PermissionRuleFile): PermissionRuleSet {
  return {
    allow: rules.rules.allow.map(r => ({ tool: r.tool, pattern: r.pattern, behavior: 'allow' as const, reason: r.reason })),
    deny: rules.rules.deny.map(r => ({ tool: r.tool, pattern: r.pattern, behavior: 'deny' as const, reason: r.reason })),
    ask: rules.rules.ask.map(r => ({ tool: r.tool, pattern: r.pattern, behavior: 'ask' as const, reason: r.reason })),
  }
}

export function ruleSetToRuleFile(ruleSet: PermissionRuleSet, mode: PermissionMode): PermissionRuleFile {
  return {
    version: CURRENT_RULE_FILE_VERSION,
    mode,
    rules: {
      allow: ruleSet.allow.map(r => ({ tool: r.tool, pattern: r.pattern, reason: r.reason })),
      deny: ruleSet.deny.map(r => ({ tool: r.tool, pattern: r.pattern, reason: r.reason })),
      ask: ruleSet.ask.map(r => ({ tool: r.tool, pattern: r.pattern, reason: r.reason })),
    },
  }
}

export function createPermissionCheckerFromConfig(projectRoot?: string): PermissionChecker {
  const ruleFile = loadPermissionRules()
  const ruleSet = ruleFileToRuleSet(ruleFile)

  const projectRulePath = getProjectPermissionRulesPath(projectRoot)
  const globalRulePath = getPermissionRulesPath()

  let effectiveRules = ruleSet

  if (existsSync(projectRulePath) && existsSync(globalRulePath)) {
    try {
      const projectRules = loadPermissionRules(projectRulePath)
      const projectRuleSet = ruleFileToRuleSet(projectRules)

      effectiveRules = {
        allow: [...projectRuleSet.allow, ...ruleSet.allow],
        deny: [...projectRuleSet.deny, ...ruleSet.deny],
        ask: [...projectRuleSet.ask, ...ruleSet.ask],
      }
    } catch {
      // Use global rules only
    }
  }

  return createPermissionChecker(ruleFile.mode, [
    ...effectiveRules.allow,
    ...effectiveRules.deny,
    ...effectiveRules.ask,
  ])
}

export function addRuleToConfig(rule: PermissionRule, filePath?: string): void {
  const ruleFile = loadPermissionRules(filePath)
  const targetList = ruleFile.rules[rule.behavior]

  const exists = targetList.some(r => r.tool === rule.tool && r.pattern === rule.pattern)
  if (!exists) {
    targetList.push({ tool: rule.tool, pattern: rule.pattern, reason: rule.reason })
    savePermissionRules(ruleFile, filePath)
  }
}

export function removeRuleFromConfig(behavior: 'allow' | 'deny' | 'ask', tool: string, pattern?: string, filePath?: string): void {
  const ruleFile = loadPermissionRules(filePath)
  const targetList = ruleFile.rules[behavior]
  const idx = targetList.findIndex(r => r.tool === tool && r.pattern === pattern)
  if (idx >= 0) {
    targetList.splice(idx, 1)
    savePermissionRules(ruleFile, filePath)
  }
}

export function listRulesFromConfig(filePath?: string): PermissionRuleFile {
  return loadPermissionRules(filePath)
}
