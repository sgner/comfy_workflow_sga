import { registerBundledSkill, type BundledSkillConfig } from '../bundled-registry.js'

const SKILLIFY_PROMPT = `# Skillify: Capture Session as a Reusable Skill

You are capturing this session's repeatable process as a reusable skill.

## Your Task

### Step 1: Analyze the Session

Before asking any questions, analyze the session to identify:
- What repeatable process was performed
- What the inputs/parameters were
- The distinct steps (in order)
- The success artifacts/criteria for each step
- Where the user corrected or steered you
- What tools and permissions were needed
- What the goals and success artifacts were

### Step 2: Interview the User

Use the AskUserQuestion tool to understand what the user wants to automate. For each round, iterate as much as needed until the user is happy.

**Round 1: High level confirmation**
- Suggest a name and description for the skill based on your analysis. Ask the user to confirm or rename.
- Suggest high-level goal(s) and specific success criteria for the skill.

**Round 2: More details**
- Present the high-level steps you identified as a numbered list.
- If you think the skill will require arguments, suggest arguments based on what you observed.
- Ask where the skill should be saved. Options:
  - **This repo** (\`.sga/skills/<name>/SKILL.md\`) — for workflows specific to this project
  - **Personal** (\`~/.sga/skills/<name>/SKILL.md\`) — follows you across all repos

**Round 3: Breaking down each step**
For each major step, ask:
- What does this step produce that later steps need?
- What proves that this step succeeded?
- Should the user be asked to confirm before proceeding?
- Are any steps independent and could run in parallel?

### Step 3: Write the SKILL.md

Create the skill directory and file at the location the user chose.

Use this format:

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{list of tool permission patterns}}
when_to_use: {{detailed description of when to invoke this skill}}
argument-hint: "{{hint showing argument placeholders}}"
---

# {{Skill Title}}
Description of skill

## Inputs
- \`$arg_name\`: Description of this input

## Goal
Clearly stated goal for this workflow.

## Steps

### 1. Step Name
What to do in this step.

**Success criteria**: What proves this step is done.

...
\`\`\`

### Step 4: Confirm and Save

Before writing the file, output the complete SKILL.md content so the user can review it. Then ask for confirmation using AskUserQuestion.

After writing, tell the user:
- Where the skill was saved
- How to invoke it
- That they can edit the SKILL.md directly to refine it
`

export function registerSkillifySkill(): void {
  registerBundledSkill({
    name: 'skillify',
    description: "Capture this session's repeatable process into a skill. Call at end of the process you want to capture with an optional description.",
    whenToUse: 'Use when the user wants to save a repeatable workflow as a skill for future use.',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'AskUserQuestion', 'Bash(mkdir:*)'],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[description of the process you want to capture]',
    prompt: SKILLIFY_PROMPT,
  })
}
