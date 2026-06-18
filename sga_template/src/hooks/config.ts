import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import type { HookDefinition, HookEventType } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('hooks-config')

export interface HookConfigFile {
  version: number
  hooks: HookDefinition[]
}

const CURRENT_HOOK_CONFIG_VERSION = 1
const HOOK_CONFIG_FILENAME = 'hooks.json'

function getGlobalHooksDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? ''
  return join(home, '.sga')
}

function getProjectHooksDir(): string {
  return join(process.cwd(), '.sga')
}

function getGlobalHooksPath(): string {
  return join(getGlobalHooksDir(), HOOK_CONFIG_FILENAME)
}

function getProjectHooksPath(): string {
  return join(getProjectHooksDir(), HOOK_CONFIG_FILENAME)
}

export function loadHookConfig(filePath?: string): HookConfigFile {
  const paths = filePath ? [filePath] : [getProjectHooksPath(), getGlobalHooksPath()]

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8')
        const parsed = JSON.parse(content) as HookConfigFile

        if (!parsed.version || parsed.version < CURRENT_HOOK_CONFIG_VERSION) {
          logger.info(`Migrating hook config from version ${parsed.version ?? 0} to ${CURRENT_HOOK_CONFIG_VERSION}`)
          const migrated = migrateHookConfig(parsed)
          saveHookConfig(migrated, p)
          return migrated
        }

        return parsed
      } catch (error) {
        logger.warn(`Failed to load hook config from ${p}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  logger.info('No hook config file found, using defaults')
  return { version: CURRENT_HOOK_CONFIG_VERSION, hooks: [] }
}

export function saveHookConfig(config: HookConfigFile, filePath?: string): void {
  const p = filePath ?? getProjectHooksPath()
  const dir = resolve(p, '..')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  config.version = CURRENT_HOOK_CONFIG_VERSION
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
  logger.info(`Hook config saved to ${p}`)
}

export function addHookToConfig(hook: HookDefinition, filePath?: string): void {
  const config = loadHookConfig(filePath)
  config.hooks.push(hook)
  saveHookConfig(config, filePath)
}

export function removeHookFromConfig(event: HookEventType, command: string, filePath?: string): void {
  const config = loadHookConfig(filePath)
  config.hooks = config.hooks.filter(h => !(h.event === event && h.command === command))
  saveHookConfig(config, filePath)
}

export function listHooksFromConfig(filePath?: string): HookDefinition[] {
  const config = loadHookConfig(filePath)
  return config.hooks
}

function migrateHookConfig(config: HookConfigFile): HookConfigFile {
  return {
    version: CURRENT_HOOK_CONFIG_VERSION,
    hooks: (config.hooks ?? []).map(hook => ({
      event: hook.event,
      matcher: hook.matcher,
      command: hook.command,
      once: hook.once,
      timeout: hook.timeout,
    })),
  }
}

export function getHooksForEvent(event: HookEventType, filePath?: string): HookDefinition[] {
  const config = loadHookConfig(filePath)
  return config.hooks.filter(h => h.event === event)
}
