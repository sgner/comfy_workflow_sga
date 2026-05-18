import { join, sep, resolve } from 'path'
import { homedir } from 'os'
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, rmdirSync, unlinkSync } from 'fs'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('memory-paths')

export interface MemoryPathConfig {
  baseDir?: string
  overridePath?: string
  settingsPath?: string
  projectRoot?: string
}

export interface MigrationHistory {
  migrations: Array<{
    from: string
    to: string
    timestamp: string
    itemCount: number
  }>
}

const MIGRATION_HISTORY_FILE = '.migration_history.json'

export function getSgaHome(): string {
  if (process.env.SGA_HOME) {
    const raw = process.env.SGA_HOME.replace(/^~/, homedir())
    return resolve(raw)
  }
  return join(homedir(), '.sga')
}

/**
 * 获取迁移历史文件路径
 */
function getMigrationHistoryPath(): string {
  // 存储在用户主目录，不随 SGA_HOME 变化
  return join(homedir(), '.sga_template', MIGRATION_HISTORY_FILE)
}

/**
 * 获取上一次显式配置的 SGA_HOME（非默认路径）
 * 用于检测用户是否取消了 SGA_HOME 配置
 */
function getLastExplicitSgaHome(): string | null {
  const history = readMigrationHistory()
  // 从后往前找，找到最后一次非默认路径的迁移
  const defaultHome = join(homedir(), '.sga')
  for (let i = history.migrations.length - 1; i >= 0; i--) {
    const migration = history.migrations[i]
    if (migration.to !== defaultHome) {
      return migration.to
    }
  }
  return null
}

/**
 * 读取迁移历史
 */
function readMigrationHistory(): MigrationHistory {
  const historyPath = getMigrationHistoryPath()
  if (!existsSync(historyPath)) {
    return { migrations: [] }
  }
  try {
    const content = readFileSync(historyPath, 'utf-8')
    return JSON.parse(content) as MigrationHistory
  } catch {
    return { migrations: [] }
  }
}

/**
 * 写入迁移历史
 */
function writeMigrationHistory(history: MigrationHistory): void {
  const historyPath = getMigrationHistoryPath()
  const historyDir = join(homedir(), '.sga_template')
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true })
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2))
}

/**
 * 获取上一次迁移的目标目录（即当前数据所在位置）
 */
function getLastMigrationTarget(): string | null {
  const history = readMigrationHistory()
  if (history.migrations.length === 0) {
    return null
  }
  const lastMigration = history.migrations[history.migrations.length - 1]
  return lastMigration.to
}

/**
 * 获取所有已知的旧目录（包括历史迁移记录）
 * 排除 .claude 目录（Claude Code 的文件，不应迁移）
 */
function getAllOldDirs(): string[] {
  const dirs = new Set<string>([
    join(homedir(), '.cc-contron'),
    join(homedir(), '.sga'),
  ])

  const history = readMigrationHistory()
  for (const migration of history.migrations) {
    dirs.add(migration.from)
    dirs.add(migration.to)
  }

  const newHome = getSgaHome()
  dirs.delete(newHome)

  // 排除 .claude 目录（Claude Code 的文件，不应迁移）
  dirs.delete(join(homedir(), '.claude'))

  return Array.from(dirs)
}

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string): number {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }

  let count = 0
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
      count++
    }
  }
  return count
}

/**
 * 递归删除目录
 */
function removeDirRecursive(dir: string): void {
  if (!existsSync(dir)) {
    return
  }

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      removeDirRecursive(entryPath)
    } else {
      unlinkSync(entryPath)
    }
  }
  rmdirSync(dir)
}

/**
 * 检查是否启用了迁移后清理
 */
function isMigrationCleanupEnabled(): boolean {
  return process.env.SGA_MIGRATION_CLEANUP === 'true'
}

/**
 * 检查目录是否包含实际文件（非空目录结构）
 */
function hasActualFiles(dir: string): boolean {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (entry.isDirectory()) {
      if (hasActualFiles(join(dir, entry.name))) return true
    }
  }
  return false
}

/**
 * 检查并迁移旧数据到新的 SGA_HOME
 * 支持多次迁移，会记住之前的地址
 * 支持取消 SGA_HOME 配置后迁回默认路径
 * 可通过 SGA_MIGRATION_CLEANUP=true 启用迁移后删除旧目录
 */
export function migrateIfNeeded(): void {
  const newHome = getSgaHome()
  const defaultHome = join(homedir(), '.sga')

  // 如果新目录已存在且包含实际文件，跳过迁移（避免覆盖）
  if (existsSync(newHome) && hasActualFiles(newHome)) {
    logger.debug(`SGA_HOME already exists with actual files, skipping migration`)
    return
  }

  // 获取所有可能的旧目录（包括历史记录）
  const oldDirs = getAllOldDirs()
  const cleanupEnabled = isMigrationCleanupEnabled()

  // 查找第一个存在且有内容的旧目录进行迁移
  for (const oldDir of oldDirs) {
    // 跳过与目标相同的目录
    if (oldDir === newHome) continue

    if (existsSync(oldDir)) {
      try {
        const entries = readdirSync(oldDir)
        if (entries.length === 0) continue

        logger.info(`Migrating data from ${oldDir} to ${newHome}...`)
        const itemCount = copyDirRecursive(oldDir, newHome)

        // 记录迁移历史
        const history = readMigrationHistory()
        history.migrations.push({
          from: oldDir,
          to: newHome,
          timestamp: new Date().toISOString(),
          itemCount,
        })
        writeMigrationHistory(history)

        logger.info(`Migration completed: ${itemCount} items migrated`)

        // 如果启用了清理，删除旧目录
        if (cleanupEnabled) {
          try {
            logger.info(`Cleaning up old directory: ${oldDir}...`)
            removeDirRecursive(oldDir)
            logger.info(`Old directory removed: ${oldDir}`)
          } catch (error) {
            logger.warn(`Failed to remove old directory ${oldDir}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        return
      } catch (error) {
        logger.warn(`Failed to migrate from ${oldDir}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 如果新目录是默认路径，且没有找到其他旧目录，
  // 检查是否有之前显式配置的 SGA_HOME 需要迁回
  if (newHome === defaultHome) {
    const lastExplicit = getLastExplicitSgaHome()
    if (lastExplicit && lastExplicit !== defaultHome && existsSync(lastExplicit)) {
      try {
        const entries = readdirSync(lastExplicit)
        if (entries.length === 0) return

        logger.info(`Migrating data back to default location from ${lastExplicit}...`)
        const itemCount = copyDirRecursive(lastExplicit, newHome)

        const history = readMigrationHistory()
        history.migrations.push({
          from: lastExplicit,
          to: newHome,
          timestamp: new Date().toISOString(),
          itemCount,
        })
        writeMigrationHistory(history)

        logger.info(`Migration back completed: ${itemCount} items migrated`)

        if (cleanupEnabled) {
          try {
            logger.info(`Cleaning up old directory: ${lastExplicit}...`)
            removeDirRecursive(lastExplicit)
            logger.info(`Old directory removed: ${lastExplicit}`)
          } catch (error) {
            logger.warn(`Failed to remove old directory ${lastExplicit}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        logger.warn(`Failed to migrate back to default: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * 获取迁移历史
 */
export function getMigrationHistory(): MigrationHistory {
  return readMigrationHistory()
}

/**
 * 获取当前数据所在目录（根据迁移历史）
 */
export function getCurrentDataLocation(): string {
  const lastTarget = getLastMigrationTarget()
  if (lastTarget && existsSync(lastTarget)) {
    return lastTarget
  }
  return getSgaHome()
}

export function getMemoryBaseDir(): string {
  return getSgaHome()
}

export function getAutoMemPath(config: MemoryPathConfig = {}): string {
  if (config.overridePath) {
    return validateMemoryPath(config.overridePath)
  }

  if (config.settingsPath) {
    const expanded = config.settingsPath.replace(/^~/, homedir())
    return validateMemoryPath(expanded)
  }

  const baseDir = config.baseDir ?? getMemoryBaseDir()
  const projectRoot = config.projectRoot ?? process.cwd()
  const sanitized = sanitizePath(projectRoot)
  return join(baseDir, 'projects', sanitized, 'memory') + sep
}

export function validateMemoryPath(path: string): string {
  if (path.includes('..')) {
    throw new Error('Relative paths with .. are not allowed for memory directory')
  }
  if (path === '/' || path.length < 3) {
    throw new Error('Root or very short paths are not allowed for memory directory')
  }
  if (path.includes('\0')) {
    throw new Error('Null bytes in path are not allowed')
  }
  if (/^[A-Z]:\\$/i.test(path)) {
    throw new Error('Windows drive root is not allowed for memory directory')
  }
  return path
}

export function sanitizePath(path: string): string {
  return path
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

export function ensureMemoryDirExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getMemoryEntrypointPath(dir: string): string {
  return join(dir, 'MEMORY.md')
}

export function isMemoryFilePath(filePath: string, memoryDir: string): boolean {
  return filePath.startsWith(memoryDir)
}
