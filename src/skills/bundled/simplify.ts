import { registerBundledSkill } from '../bundled-registry.js'

const SIMPLIFY_PROMPT = `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files.

## Phase 2: Launch Three Review Agents in Parallel

Launch all three review agents concurrently.

### Agent 1: Code Reuse Review

For each change:
1. Search for existing utilities and helpers that could replace newly written code
2. Flag any new function that duplicates existing functionality
3. Flag any inline logic that could use an existing utility

### Agent 2: Code Quality Review

Review for hacky patterns:
1. Redundant state
2. Parameter sprawl
3. Copy-paste with slight variation
4. Leaky abstractions
5. Stringly-typed code
6. Unnecessary comments

### Agent 3: Efficiency Review

Review for efficiency:
1. Unnecessary work: redundant computations, repeated file reads, duplicate API calls
2. Missed concurrency: independent operations run sequentially
3. Hot-path bloat
4. Memory: unbounded data structures, missing cleanup
5. Overly broad operations

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate their findings and fix each issue directly. If a finding is a false positive, note it and move on.

When done, briefly summarize what was fixed (or confirm the code was already clean).
`

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description: 'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
    whenToUse: 'Use when the user wants a comprehensive code review of recent changes.',
    userInvocable: true,
    prompt: SIMPLIFY_PROMPT,
  })
}
