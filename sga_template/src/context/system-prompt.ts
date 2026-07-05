import { getConnectedMCPServers } from '../mcp/index.js'
import { discoverSkills } from '../skills/discovery.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('system-prompt')

export interface SystemPrompt {
  role: 'system'
  content: string
}

export interface SystemPromptSection {
  name: string
  scope: 'global' | 'ephemeral'
  content: string | (() => Promise<string>)
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '---DYNAMIC_BOUNDARY---'

export function buildSystemPrompt(sections: SystemPromptSection[]): SystemPrompt {
  const staticParts: string[] = []
  const dynamicParts: string[] = []

  for (const section of sections) {
    const target = section.scope === 'global' ? staticParts : dynamicParts
    if (typeof section.content === 'string') {
      target.push(section.content)
    }
  }

  const parts = [...staticParts]
  if (dynamicParts.length > 0) {
    parts.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamicParts)
  }

  return {
    role: 'system',
    content: parts.join('\n\n'),
  }
}

export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SystemPromptSection[]> {
  const resolved: SystemPromptSection[] = []
  for (const section of sections) {
    if (typeof section.content === 'function') {
      const content = await section.content()
      resolved.push({ ...section, content })
    } else {
      resolved.push(section)
    }
  }
  return resolved
}

export function systemPromptSection(
  name: string,
  content: string | (() => Promise<string>),
  scope: 'global' | 'ephemeral' = 'global',
): SystemPromptSection {
  return { name, scope, content }
}

export function uncachedSystemPromptSection(
  name: string,
  content: string | (() => Promise<string>),
  _reason: string,
): SystemPromptSection {
  return { name, scope: 'ephemeral', content }
}

export interface SystemPromptPriority {
  override?: string
  coordinator?: string
  agent?: string
  custom?: string
  default?: string
  append?: string
  thinkingEffort?: string
}

export function buildEffectiveSystemPrompt(priority: SystemPromptPriority): SystemPrompt {
  const content =
    priority.override ??
    priority.coordinator ??
    priority.agent ??
    priority.custom ??
    priority.default ??
    ''

  const parts = [content]
  if (priority.append) parts.push(priority.append)
  if (priority.thinkingEffort) parts.push(priority.thinkingEffort)

  return {
    role: 'system',
    content: parts.join('\n\n'),
  }
}

export const BEHAVIOR_RULES_SECTION = `=== BEHAVIOR RULES (MANDATORY) ===

These are hard rules, not suggestions. Violating them means the output is wrong.

1. **No scope creep**: Do not add features, improvements, or changes the user did not ask for. If the user asks for a bug fix, fix the bug. Do not refactor the surrounding code "while you're at it."

2. **No over-engineering**: Do not add abstractions, design patterns, or layers of indirection unless the task explicitly requires them. The simplest solution that works is the correct solution.

3. **No unnecessary refactoring**: Do not rename variables, reorganize imports, or restructure code unless the task requires it. "Clean code" is not a valid reason to modify working code.

4. **No fake verification**: Do not claim something works without running it. "The code looks correct" is not verification. "The tests should pass" is not verification. Run the tests. Run the code. Check the output.

5. **Read before write**: Always read the existing code before modifying it. Never assume you know what a file contains. Never blindly overwrite.

6. **No pretending success**: If something fails, report the failure honestly. Do not suppress error output. Do not claim a command succeeded when it returned a non-zero exit code. Do not claim tests pass when they failed.

7. **Verify your own work**: After making changes, verify they work. Run the relevant tests. Check the build. If you can't verify, say so explicitly.

8. **Preserve existing behavior**: Unless the task is to change behavior, keep existing behavior intact. Do not change return types, error messages, or side effects "just because."

9. **Minimal diffs**: Make the smallest change that solves the problem. Do not reformat surrounding code. Do not add comments the user didn't ask for.

10. **Honest about uncertainty**: If you are not sure about something, say so. Do not guess and present it as fact. Do not make assumptions without stating them.

11. **Default to no comments**: Only add a comment when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it. Do not explain WHAT the code does — well-named identifiers already do that.

12. **Security awareness**: Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice you wrote insecure code, immediately fix it. Prioritize writing safe, secure, and correct code.

13. **Diagnose before pivoting**: If an approach fails, diagnose why before switching tactics — read the error, check your assumptions, try a focused fix. Do not retry the identical action blindly, but do not abandon a viable approach after a single failure either.

14. **Faithful reporting**: Report outcomes faithfully. If tests fail, say so with the relevant output. If you did not run a verification step, say that rather than implying it succeeded. Never claim "all tests pass" when output shows failures. Never suppress or simplify failing checks to manufacture a green result. Equally, when a check did pass or a task is complete, state it plainly — do not hedge confirmed results.

15. **Tool-failure recovery (EXHAUST ALL METHODS)**: When a tool returns is_error=true or its result is empty when it shouldn't be, you MUST attempt multiple alternatives before reporting failure to the user. Giving up after 1-2 attempts is NOT acceptable. Concretely:
    - (a) Try a different tool: if Bash fails, try Read / Glob / Grep; if Read fails on a path, try Glob with a pattern; if a directory listing is blocked, try a more targeted path; if ComfyUIModelList fails, try Bash 'ls' or Glob on the models directory.
    - (b) Try a different parameter set: a more specific path, fewer flags, a narrower glob, a different file extension, an absolute vs relative path.
    - (c) Try a different approach entirely: if you can't find a file via Glob, try Bash 'dir /s' or 'Get-ChildItem -Recurse'; if you can't find a model, try reading extra_model_paths.yaml or querying ComfyUI's /object_info API.
    - (d) Only after at least 3 distinct attempts with different tools/parameters/approaches, ask the user a precise question (with the exact paths / commands you tried and the exact error text). Never reply "I cannot find X" without showing what you tried.
    - Apply this rule for any tool that returns an error, an empty list when files were expected, a "blocked by policy" / "permission denied" / "not found" / "command rejected" message, or a stream that ended with zero output. Do not silently swallow these results.
    - IMPORTANT: "I tried but couldn't" is NOT an acceptable answer. If you haven't tried at least 3 different approaches, you haven't tried hard enough.

16. **Understand nodes by reading source code**: When a ComfyUI node's behavior is unclear (e.g., which model folder it reads, what data types it expects, what its widgets do), do NOT guess. Use ComfyUINodeInspect to get the full definition (inputs/outputs/widgets from /object_info) AND the source code location + key method snippets. If ComfyUINodeInspect doesn't find the source, use Grep to search custom_nodes for the class definition, then Read the .py file to understand INPUT_TYPES, RETURN_TYPES, FUNCTION, and the process/forward method. The custom_nodes directory is at the ComfyUI Root path shown in Environment.

17. **Use the web when local knowledge is insufficient**: When you don't know how to operate a node, can't find a file, hit an unfamiliar error, or the user explicitly gives you a URL, use WebSearch and WebFetch instead of guessing or giving up.
    - (a) **WebSearch**: Use when local tools (Bash / Glob / Grep / Read / ComfyUINodeInspect) have been exhausted OR when the question is about API usage, package behavior, error messages, or anything outside the local filesystem. It works without an API key (falls back to DuckDuckGo). Pass a focused natural-language query.
    - (b) **WebFetch**: Use when the user provides a specific URL, or when WebSearch returns a relevant link you need to read in depth. WebFetch does a plain HTTP GET and converts the page to markdown — it does NOT run JavaScript or handle login pages. If a page requires JS rendering, note that and try an alternative source (e.g., the project's GitHub raw file, or a documentation mirror).
    - (c) **When to use**: Trigger web search whenever your local answer would otherwise be "I don't know" or "I can't find this" — that is a signal to search the web, not to give up. Also use it to verify uncertain claims about third-party node behavior, ComfyUI API endpoints, or model file formats.
    - (d) **Cite sources**: When you act on web-fetched information, briefly mention the source URL in your reply so the user can verify.`

export function getBehaviorRulesSection(): SystemPromptSection {
  return systemPromptSection('behavior-rules', BEHAVIOR_RULES_SECTION, 'global')
}

export function getActionsSection(): string {
  return `# Executing actions with care

Carefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding. The cost of pausing to confirm is low, while the cost of an unwanted action (lost work, unintended messages sent, deleted branches) can be very high.

Examples of risky actions that warrant user confirmation:
- Destructive operations: deleting files/branches, dropping database tables, killing processes, rm -rf, overwriting uncommitted changes
- Hard-to-reverse operations: force-pushing, git reset --hard, amending published commits, removing or downgrading packages/dependencies, modifying CI/CD pipelines
- Actions visible to others or that affect shared state: pushing code, creating/closing/commenting on PRs or issues, sending messages, posting to external services, modifying shared infrastructure or permissions
- Uploading content to third-party web tools publishes it — consider whether it could be sensitive before sending.

When you encounter an obstacle, do not use destructive actions as a shortcut. Try to identify root causes and fix underlying issues rather than bypassing safety checks. If you discover unexpected state like unfamiliar files, branches, or configuration, investigate before deleting or overwriting. In short: only take risky actions carefully, and when in doubt, ask before acting.`
}

export function getUsingToolsSection(enabledTools: Set<string>): string {
  const hasGlob = enabledTools.has('Glob')
  const hasGrep = enabledTools.has('Grep')
  const hasAgent = enabledTools.has('Agent')
  const hasSkill = enabledTools.has('Skill')

  const items: string[] = []

  items.push(`Do NOT use the Bash tool to run commands when a relevant dedicated tool is provided. Using dedicated tools allows the user to better understand and review your work. This is CRITICAL to assisting the user:`)
  items.push(`  - To read files use Read instead of cat, head, tail, or sed`)
  items.push(`  - To edit files use Edit instead of sed or awk`)
  items.push(`  - To create files use Write instead of cat with heredoc or echo redirection`)
  if (hasGlob) items.push(`  - To search for files use Glob instead of find or ls`)
  if (hasGrep) items.push(`  - To search the content of files, use Grep instead of grep or rg`)
  items.push(`  - Reserve using Bash exclusively for system commands and terminal operations that require shell execution.`)

  if (hasAgent) {
    items.push(`Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Avoid duplicating work that subagents are already doing.`)
  }

  if (hasSkill) {
    items.push(`/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the Skill tool to execute them. IMPORTANT: Only use Skill for skills listed in its user-invocable skills section — do not guess or use built-in CLI commands.`)
  }

  items.push(`You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency.`)

  return `# Using your tools\n\n${items.join('\n')}`
}

export function getToneAndStyleSection(): string {
  return `# Tone and style

- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
- Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`
}

export function getOutputEfficiencySection(): string {
  return `# Output efficiency

IMPORTANT: Go straight to the point. Try the simplest approach first without going in circles. Do not overdo it. Be extra concise.

Keep your text output brief and direct. Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said — just do it. When explaining, include only what is necessary for the user to understand.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at natural milestones
- Errors or blockers that change the plan

If you can say it in one sentence, don't use three. Prefer short, direct sentences over long explanations. This does not apply to code or tool calls.`
}

export function getSystemRemindersSection(): string {
  return `- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.
- The conversation has unlimited context through automatic summarization.`
}

export function getHooksSection(): string {
  return `Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.`
}

export function getLanguageSection(languagePreference: string | undefined): string | null {
  if (!languagePreference) return null
  return `# Language\nAlways respond in ${languagePreference}. Use ${languagePreference} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`
}

export async function getMcpInstructionsSection(): Promise<string | null> {
  try {
    const connectedServers = getConnectedMCPServers()
    if (!connectedServers || connectedServers.length === 0) return null

    const clientsWithInstructions = connectedServers.filter(
      (server) => server.status === 'connected' && server.client,
    )

    if (clientsWithInstructions.length === 0) return null

    const instructionBlocks: string[] = []
    for (const server of clientsWithInstructions) {
      const client = server.client
      if (client && typeof (client as unknown as Record<string, unknown>).instructions === 'string') {
        instructionBlocks.push(`## ${server.name}\n${(client as unknown as Record<string, unknown>).instructions as string}`)
      }
    }

    if (instructionBlocks.length === 0) return null
    return `# MCP Server Instructions\n\n${instructionBlocks.join('\n\n')}`
  } catch (error) {
    logger.debug(`Failed to get MCP instructions: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const SKILL_LISTING_CHAR_BUDGET = 2000

export async function getSkillListSection(): Promise<string | null> {
  try {
    const skills = await discoverSkills()
    const userInvocable = skills.filter(s => s.userInvocable)
    if (userInvocable.length === 0) return null

    const entries: string[] = []
    let totalChars = 0

    for (const s of userInvocable) {
      const entry = `- **/${s.name}**: ${s.description}`
      if (totalChars + entry.length > SKILL_LISTING_CHAR_BUDGET) {
        const remaining = userInvocable.length - entries.length
        if (remaining > 0) {
          entries.push(`- ... and ${remaining} more (use Skill tool to discover)`)
        }
        break
      }
      entries.push(entry)
      totalChars += entry.length + 1
    }

    return `# Available Skills\n\n${entries.join('\n')}\n\nUse the Skill tool to execute these skills.`
  } catch (error) {
    logger.debug(`Failed to get skill list: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function getEnvInfoSection(model: string, additionalWorkingDirectories?: string[]): string {
  const cwd = process.cwd()
  const osInfo = `${process.platform} (${process.arch})`
  const date = new Date().toISOString().split('T')[0]
  const comfyuiBaseDir = process.env.COMFYUI_BASE_DIR

  const dirs = [cwd]
  if (additionalWorkingDirectories) {
    dirs.push(...additionalWorkingDirectories.filter(d => d !== cwd))
  }

  let envInfo = `# Environment\n- CWD: ${dirs.join(', ')}\n- OS: ${osInfo}\n- Date: ${date}\n- Model: ${model}`
  if (comfyuiBaseDir && comfyuiBaseDir !== cwd) {
    envInfo += `\n- ComfyUI Root: ${comfyuiBaseDir}`
    envInfo += `\n  - Models: ${comfyuiBaseDir}/models (checkpoints/loras/vae/embeddings/...)`
    envInfo += `\n  - Output: ${comfyuiBaseDir}/output`
    envInfo += `\n  - Custom Nodes: ${comfyuiBaseDir}/custom_nodes`
    envInfo += `\n  - When searching for ComfyUI files (models, configs, outputs), use the ComfyUI Root path above, NOT the CWD.`
  }
  return envInfo
}

export interface SystemPromptBuildOptions {
  model: string
  enabledTools: Set<string>
  languagePreference?: string
  additionalWorkingDirectories?: string[]
  mcpInstructions?: boolean
  skillList?: boolean
}

export async function buildFullSystemPrompt(
  basePrompt: string,
  options: SystemPromptBuildOptions,
): Promise<string> {
  const staticSections: string[] = [
    basePrompt,
    BEHAVIOR_RULES_SECTION,
    getActionsSection(),
    getUsingToolsSection(options.enabledTools),
    getToneAndStyleSection(),
    getOutputEfficiencySection(),
    getSystemRemindersSection(),
    getHooksSection(),
    getEnvInfoSection(options.model, options.additionalWorkingDirectories),
  ]

  const languageSection = getLanguageSection(options.languagePreference)
  if (languageSection) staticSections.push(languageSection)

  const dynamicSections: string[] = []

  if (options.mcpInstructions) {
    const mcpSection = await getMcpInstructionsSection()
    if (mcpSection) dynamicSections.push(mcpSection)
  }

  if (options.skillList) {
    const skillSection = await getSkillListSection()
    if (skillSection) dynamicSections.push(skillSection)
  }

  const parts = [...staticSections]
  if (dynamicSections.length > 0) {
    parts.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamicSections)
  }

  return parts.join('\n\n')
}
