import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { getSgaHome } from '../memory/paths.js'

export interface SgaMdConfig {
  globalPaths?: string[]
  userPath?: string
  projectPaths?: string[]
  localPath?: string
}

/** @deprecated Use SgaMdConfig instead */
export type ClaudeMdConfig = SgaMdConfig

function getGlobalPaths(): string[] {
  const paths: string[] = []
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData ?? 'C:\\ProgramData'
    paths.push(join(programData, 'sga', 'SGA.md'))
    paths.push(join(programData, 'claude-code', 'CLAUDE.md'))
  } else {
    paths.push('/etc/sga/SGA.md')
    paths.push('/etc/claude-code/CLAUDE.md')
  }
  return paths
}

export const DEFAULT_SGA_MD_PATHS: SgaMdConfig = {
  get globalPaths() { return getGlobalPaths() },
  userPath: join(getSgaHome(), 'SGA.md'),
  projectPaths: [],
  localPath: 'SGA.local.md',
}

/** @deprecated Use DEFAULT_SGA_MD_PATHS instead */
export const DEFAULT_CLAUDE_MD_PATHS = DEFAULT_SGA_MD_PATHS

export async function loadSgaMd(config: SgaMdConfig = {}): Promise<string> {
  const paths = resolveSgaMdPaths(config)
  const seen = new Set<string>()
  const contents: string[] = []

  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const content = await loadSingleFile(path)
    if (content) {
      const expanded = await expandAtReferences(content, path)
      contents.push(expanded)
    }
  }

  return contents.join('\n\n')
}

/** @deprecated Use loadSgaMd instead */
export const loadClaudeMd = loadSgaMd

function resolveSgaMdPaths(config: SgaMdConfig): string[] {
  const paths: string[] = []

  for (const p of config.globalPaths ?? DEFAULT_SGA_MD_PATHS.globalPaths ?? []) {
    paths.push(p)
  }

  const sgaHome = getSgaHome()
  paths.push(config.userPath ?? DEFAULT_SGA_MD_PATHS.userPath!)
  if (sgaHome !== join(homedir(), '.claude')) {
    paths.push(join(homedir(), '.claude', 'CLAUDE.md'))
  }

  for (const p of config.projectPaths ?? []) {
    paths.push(join(p, 'SGA.md'))
    paths.push(join(p, 'CLAUDE.md'))
    paths.push(join(p, '.sga', 'SGA.md'))
    paths.push(join(p, '.claude', 'CLAUDE.md'))

    const sgaRulesDir = join(p, '.sga', 'rules')
    if (existsSync(sgaRulesDir)) {
      paths.push(join(sgaRulesDir, '*.md'))
    }
    const claudeRulesDir = join(p, '.claude', 'rules')
    if (existsSync(claudeRulesDir)) {
      paths.push(join(claudeRulesDir, '*.md'))
    }
  }

  if (config.localPath) {
    paths.push(config.localPath)
  }
  if (config.localPath !== 'CLAUDE.local.md') {
    paths.push('CLAUDE.local.md')
  }

  return paths
}

async function loadSingleFile(path: string): Promise<string | null> {
  try {
    if (!existsSync(path)) return null
    const content = await readFile(path, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  }
}

async function expandAtReferences(content: string, basePath: string): Promise<string> {
  const atPattern = /@([^\s\n]+)/g
  const dir = basePath.includes('/') || basePath.includes('\\')
    ? basePath.substring(0, basePath.lastIndexOf('/') + 1 || basePath.lastIndexOf('\\') + 1)
    : process.cwd()

  const matches = [...content.matchAll(atPattern)]
  if (matches.length === 0) return content

  let result = content
  for (const match of matches) {
    const refPath = join(dir, match[1])
    const refContent = await loadSingleFile(refPath)
    if (refContent) {
      result = result.replace(match[0], refContent)
    }
  }

  return result
}
