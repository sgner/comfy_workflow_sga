import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import type { MemoryFile, MemoryFrontmatter } from './types.js'
import { MEMORY_MAX_FILES } from './types.js'

export async function scanMemoryFiles(memoryDir: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = []
  await scanDir(memoryDir, memoryDir, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, MEMORY_MAX_FILES)
}

async function scanDir(dir: string, baseDir: string, results: MemoryFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await scanDir(fullPath, baseDir, results)
    } else if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
      try {
        const fileStat = await stat(fullPath)
        const content = await readFile(fullPath, 'utf-8')
        const frontmatter = parseFrontmatter(content)
        const description = frontmatter.description ?? extractFirstHeading(content) ?? entry.name

        results.push({
          path: fullPath,
          type: frontmatter.type ?? 'project',
          description,
          content,
          frontmatter,
          mtimeMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
        })
      } catch {
        continue
      }
    }
  }
}

export function parseFrontmatter(content: string): MemoryFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: MemoryFrontmatter = {}

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key === 'type') result.type = value as MemoryFrontmatter['type']
    else if (key === 'description') result.description = value
    else if (key === 'tags') result.tags = value.split(',').map(t => t.trim())
    else (result as Record<string, unknown>)[key] = value
  }

  return result
}

function extractFirstHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

export function formatMemoryManifest(memories: MemoryFile[]): string {
  return memories
    .map(m => `[${m.type}] ${m.path} (${new Date(m.mtimeMs).toISOString()}): ${m.description}`)
    .join('\n')
}
