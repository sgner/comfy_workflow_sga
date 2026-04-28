import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'

export interface ClaudeMdConfig {
  globalPaths?: string[]
  userPath?: string
  projectPaths?: string[]
  localPath?: string
}

export const DEFAULT_CLAUDE_MD_PATHS: ClaudeMdConfig = {
  globalPaths: ['/etc/claude-code/CLAUDE.md'],
  userPath: join(homedir(), '.claude', 'CLAUDE.md'),
  projectPaths: [],
  localPath: 'CLAUDE.local.md',
}

export async function loadClaudeMd(config: ClaudeMdConfig = {}): Promise<string> {
  const paths = resolveClaudeMdPaths(config)
  const contents: string[] = []

  for (const path of paths) {
    const content = await loadSingleFile(path)
    if (content) {
      const expanded = await expandAtReferences(content, path)
      contents.push(expanded)
    }
  }

  return contents.join('\n\n')
}

function resolveClaudeMdPaths(config: ClaudeMdConfig): string[] {
  const paths: string[] = []

  for (const p of config.globalPaths ?? DEFAULT_CLAUDE_MD_PATHS.globalPaths ?? []) {
    paths.push(p)
  }

  paths.push(config.userPath ?? DEFAULT_CLAUDE_MD_PATHS.userPath!)

  for (const p of config.projectPaths ?? []) {
    paths.push(join(p, 'CLAUDE.md'))
    paths.push(join(p, '.claude', 'CLAUDE.md'))
    const rulesDir = join(p, '.claude', 'rules')
    if (existsSync(rulesDir)) {
      paths.push(join(rulesDir, '*.md'))
    }
  }

  if (config.localPath) {
    paths.push(config.localPath)
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
