import { registerBundledSkill } from '../bundled-registry.js'

const REMEMBER_PROMPT = `# Memory Review

## Goal
Review the user's memory landscape and produce a clear report of proposed changes, grouped by action type. Do NOT apply changes — present proposals for user approval.

## Steps

### 1. Gather all memory layers
Read CLAUDE.md and CLAUDE.local.md from the project root (if they exist). Review the auto-memory content in the system prompt.

### 2. Classify each auto-memory entry
For each substantive entry in auto-memory, determine the best destination:

| Destination | What belongs there | Examples |
|---|---|---|
| **CLAUDE.md** | Project conventions for all contributors | "use bun not npm", "API routes use kebab-case" |
| **CLAUDE.local.md** | Personal instructions not for other contributors | "I prefer concise responses", "don't auto-commit" |
| **Stay in auto-memory** | Working notes, temporary context | Session-specific observations |

### 3. Identify cleanup opportunities
Scan across all layers for:
- **Duplicates**: Entries already captured elsewhere
- **Outdated**: Entries contradicted by newer entries
- **Conflicts**: Contradictions between layers

### 4. Present the report
Output a structured report grouped by action type:
1. **Promotions** — entries to move, with destination and rationale
2. **Cleanup** — duplicates, outdated entries, conflicts
3. **Ambiguous** — entries needing user input
4. **No action needed** — entries that should stay put

## Rules
- Present ALL proposals before making any changes
- Do NOT modify files without explicit user approval
- Ask about ambiguous entries — don't guess
`

export function registerRememberSkill(): void {
  registerBundledSkill({
    name: 'remember',
    description: 'Review auto-memory entries and propose promotions to CLAUDE.md, CLAUDE.local.md, or shared memory. Also detects outdated, conflicting, and duplicate entries across memory layers.',
    whenToUse: 'Use when the user wants to review, organize, or promote their auto-memory entries.',
    userInvocable: true,
    prompt: REMEMBER_PROMPT,
  })
}
