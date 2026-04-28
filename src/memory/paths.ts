import { join, sep } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { mkdirSync } from 'fs'

export interface MemoryPathConfig {
  baseDir?: string
  overridePath?: string
  settingsPath?: string
  projectRoot?: string
}

export function getMemoryBaseDir(): string {
  return join(homedir(), '.claude')
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
