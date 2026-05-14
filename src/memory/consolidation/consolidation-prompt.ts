export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200

export function buildConsolidationPrompt(
  memoryRoot: string,
  extra: string,
): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

## Phase 1 — Orient

- List the memory directory to see what already exists
- Read ${ENTRYPOINT_NAME} to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:
1. **Daily logs** if present
2. **Existing memories that drifted** — facts that contradict current code
3. **Recent session context** — grep narrowly for specific context

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file. Focus on:
- Merging new signal into existing topic files
- Converting relative dates to absolute dates
- Deleting contradicted facts
- Removing duplicate information across files

## Phase 4 — Prune and index

Update ${ENTRYPOINT_NAME} so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB.
- Remove pointers to stale/wrong memories
- Demote verbose entries
- Add pointers to newly important memories
- Resolve contradictions

## Memory root
${memoryRoot}

${extra}`
}
