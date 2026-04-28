import { registerBundledSkill } from '../bundled-registry.js'

const BATCH_PROMPT = `# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## User Instruction

$ARGUMENTS

## Phase 1: Research and Plan

1. **Understand the scope.** Research what this instruction touches. Find all the files, patterns, and call sites that need to change.

2. **Decompose into independent units.** Break the work into 5–30 self-contained units. Each unit must:
   - Be independently implementable
   - Be mergeable on its own without depending on another unit
   - Be roughly uniform in size

3. **Write the plan.** Include:
   - A summary of what you found during research
   - A numbered list of work units with title, file list, and change description
   - The test recipe for verification

4. **Present the plan for user approval** using AskUserQuestion.

## Phase 2: Spawn Workers

Once the plan is approved, spawn one background agent per work unit. Launch them all in parallel.

For each agent, the prompt must be fully self-contained. Include:
- The overall goal
- This unit's specific task
- Codebase conventions
- The test recipe
- Worker instructions for implementation, testing, and PR creation

## Phase 3: Track Progress

After launching all workers, render a status table:

| # | Unit | Status | PR |
|---|------|--------|----|
| 1 | <title> | running | — |

As agents complete, update the table with status and PR links.

When all agents have reported, render the final table and summary.
`

export function registerBatchSkill(): void {
  registerBundledSkill({
    name: 'batch',
    description: 'Research and plan a large-scale change, then execute it in parallel across multiple isolated agents.',
    whenToUse: 'Use when the user wants to make a sweeping, mechanical change across many files that can be decomposed into independent parallel units.',
    argumentHint: '<instruction>',
    userInvocable: true,
    disableModelInvocation: true,
    prompt: BATCH_PROMPT,
  })
}
