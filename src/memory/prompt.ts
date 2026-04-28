import type { MemoryType, MemoryExtractConfig } from './types.js'
import { DEFAULT_MEMORY_EXTRACT_CONFIG, MEMORY_TYPES } from './types.js'
import { ensureMemoryDirExists, getMemoryEntrypointPath } from './paths.js'
import { MEMORY_ENTRYPOINT_MAX_LINES, MEMORY_ENTRYPOINT_MAX_BYTES } from './types.js'

export function buildMemoryPrompt(memoryDir: string, entrypointContent?: string): string {
  ensureMemoryDirExists(memoryDir)

  const memoryTypesSection = Object.entries(MEMORY_TYPES)
    .map(([type, info]) => `- **${info.label}** (${type}): ${info.description}`)
    .join('\n')

  const entrypoint = entrypointContent ?? 'Currently empty'
  const truncated = truncateEntrypointContent(entrypoint)

  return `# Auto Memory

You have a persistent file-based memory system located at \`${memoryDir}\`.

## Types of Memory
${memoryTypesSection}

## What NOT to Save
- Information already in CLAUDE.md or project documentation
- Temporary debugging state
- Sensitive credentials or secrets
- Verbatim file contents (reference the file path instead)

## How to Save Memories
1. Create a new markdown file in the memory directory
2. Add YAML frontmatter with type and description
3. Write the memory content below the frontmatter

## When to Access Memories
- Before starting a new task, check relevant memories
- After learning something new about the user or project, save it
- Use the memory retrieval system to find relevant context

## MEMORY.md Index
\`\`\`
${truncated.content}
\`\`\`
${truncated.wasTruncated ? `\n> WARNING: MEMORY.md was truncated. Only part of it was loaded.` : ''}`
}

export function truncateEntrypointContent(content: string): { content: string; wasTruncated: boolean } {
  const lines = content.split('\n')
  let truncated = false
  let result = content

  if (lines.length > MEMORY_ENTRYPOINT_MAX_LINES) {
    result = lines.slice(0, MEMORY_ENTRYPOINT_MAX_LINES).join('\n')
    truncated = true
  }

  const bytes = Buffer.byteLength(result, 'utf-8')
  if (bytes > MEMORY_ENTRYPOINT_MAX_BYTES) {
    const truncatedBuffer = Buffer.from(result, 'utf-8').slice(0, MEMORY_ENTRYPOINT_MAX_BYTES)
    const lastNewline = truncatedBuffer.lastIndexOf('\n')
    result = truncatedBuffer.slice(0, lastNewline).toString('utf-8')
    truncated = true
  }

  return { content: result, wasTruncated: truncated }
}

export function buildExtractPrompt(
  conversationSummary: string,
  existingMemoryManifest: string,
): string {
  return `You are a memory extraction agent. Analyze the following conversation and extract any new information worth remembering.

## Existing Memories
${existingMemoryManifest || 'No existing memories.'}

## Recent Conversation
${conversationSummary}

## Instructions
1. Identify new facts, preferences, or patterns worth remembering
2. For each item, determine the appropriate memory type (user/feedback/project/reference)
3. Create memory files with proper frontmatter
4. Do NOT duplicate information already in existing memories
5. Do NOT save temporary debugging state or sensitive information

Output each memory as a separate file write operation.`
}
