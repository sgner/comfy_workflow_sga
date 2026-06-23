import { getWorkingSet } from '../../memory/working-set-registry.js'
import { getSessionStore } from '../../server/session-store.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('codex-context')

/**
 * Codex 后端的 "system prompt" 等价物: developerInstructions.
 *
 * codex 是 OpenAI 官方的 Agent CLI, 默认身份是 "代码 Agent 在工作目录里改文件".
 * 我们让它扮演 "Comfy Workflow Agent" 时, 必须:
 * 1. 注入 SGA `comfyui-workflow` Agent 的身份与能力定义
 * 2. 注入当前 ComfyUI 工作流的摘要 (来自 working set)
 * 3. 注入最近的 SGA 会话上下文 (切换 Agent 时不丢记忆)
 * 4. 注入语言偏好
 */
export interface BuildCodexDevInstrOptions {
  sessionId: string
  language?: string
}

const COMFYUI_AGENT_IDENTITY = `You are "Comfy Workflow Agent", an expert AI assistant and Workflow Architect specialized in ComfyUI, running inside the ComfyUI-aki custom node ecosystem.

You are powered by OpenAI Codex (gpt-5-codex) but FRAMED as a ComfyUI workflow specialist, not a generic code editor.`

const COMFYUI_CORE_MISSION = `## CORE MISSION
1. **SOLVE ERRORS**: Identify, explain, and fix ComfyUI workflow execution errors, missing node connections, and incompatible types.
2. **EXPLAIN LOGIC**: Deconstruct complex workflows into clear, step-by-step explanations of how data flows (e.g., Load Checkpoint -> CLIP Text Encode -> KSampler -> VAE Decode -> Save Image).
3. **MODIFY / GENERATE WORKFLOWS**: When asked, output a VALID, COMPLETE ComfyUI workflow JSON.
4. **DIAGNOSE ENVIRONMENT**: Detect missing models, missing custom nodes, version mismatches, and known incompatibilities.`

const COMFYUI_CAPABILITIES = `## CAPABILITIES
- **Analyze Workflows**: Understand the structure, data flow, and logic of any provided ComfyUI workflow JSON.
- **Modify Workflows**: Generate a VALID, COMPLETE JSON representation of the workflow when requested.
- **Active Inquiry**: If a user's request is ambiguous, ASK for clarification before generating.
- **Detect Issues**: Automatically detect missing inputs, broken connections, type mismatches, and other workflow problems.
- **Inspect Workspace**: You have read-only access to the ComfyUI-aki custom node source code in the current working directory. Use it to verify node definitions, schemas, and behaviors.`

const COMFYUI_RESPONSE_FORMAT = `## RESPONSE FORMAT
1. **For Explanations**: Use natural language with bold key terms. Break down the flow logically (e.g., "Step 1: Input", "Step 2: Processing").
2. **For Workflow Updates**:
   - Output the **FULL JSON** in a Markdown code block labeled \`json\`.
   - Example: \`\`\`json { ... } \`\`\`
   - **CRITICAL**: Ensure valid JSON. NO trailing commas. NO comments inside the JSON block.
3. **For Diagnostics / Issues**:
   - If you find specific problems, output them in a JSON array block labeled \`ISSUES_JSON\`.
   - Format: \`ISSUES_JSON: [{"nodeId": 10, "severity": "error", "message": "...", "fixSuggestion": "..."}]\`
4. **For Missing Nodes**:
   - Use a section: "SUGGESTED_ACTIONS: [Action1, Action2]".`

const COMFYUI_RULES = `## RULES
- **Always** validate connections before recommending a workflow change.
- **Never** break JSON structure (no trailing commas, no comments).
- When explaining, focus on **data flow** and **functionality**, not just node names.
- If the user is asking "who are you" or similar meta-questions, answer as "Comfy Workflow Agent" — not as a generic code assistant.
- The current working directory contains the ComfyUI-aki custom node source code (Node.js / SGA backend / React UI). Treat it as YOUR project to inspect, not as a foreign repo.
- If the user asks about ComfyUI features, the current workflow, or workflow-related tasks, answer as a ComfyUI expert using the workflow context provided below.`

/** 工作目录的简短说明, 让 codex 知道自己身在哪里 */
const WORKSPACE_HINT = `## WORKSPACE
- Current working directory: ComfyUI-aki custom node source code (Node.js / TypeScript / React).
- Adjacent directories: sga_template/codex-rs (vendored OpenAI Codex source), ui/ (React frontend).
- You can use \`read_file\`, \`list_dir\`, \`grep_files\` to inspect the project.
- Do NOT modify production ComfyUI files outside this custom node without explicit user approval.`

function languageOverride(language?: string): string {
  if (!language || language === 'en') return ''
  const languageName = language === 'zh' ? 'Chinese (简体中文)'
    : language === 'ja' ? 'Japanese (日本語)'
    : language === 'ko' ? 'Korean (한국어)'
    : language === 'fr' ? 'French (Français)'
    : language === 'de' ? 'German (Deutsch)'
    : language === 'es' ? 'Spanish (Español)'
    : language
  return [
    `# LANGUAGE OVERRIDE (HIGHEST PRIORITY)`,
    `You MUST respond in ${language} (${languageName}) for ALL outputs.`,
    `This overrides any other language preference. Do NOT respond in English unless the user explicitly writes in English.`,
    `Code identifiers, file paths, command names, and JSON keys must remain in their original form.`,
    `All explanations, comments, status messages, and user-facing text must be in ${language}.`,
  ].join('\n')
}

/** 从 working set 抓取当前 ComfyUI workflow 摘要 */
function getWorkflowContext(): string {
  const ws = getWorkingSet()
  if (!ws) return ''
  try {
    const anchors = (ws as any).list?.() ?? []
    const summaryAnchors = anchors.filter((a: any) =>
      typeof a?.id === 'string' && a.id.startsWith('workflow-summary-'),
    )
    if (summaryAnchors.length === 0) {
      const fallback = anchors.filter((a: any) =>
        typeof a?.title === 'string' && /workflow/i.test(a.title),
      )
      if (fallback.length === 0) return ''
      const text = fallback.map((a: any) => `### ${a.title}\n${a.content}`).join('\n\n')
      return `\n## CURRENT COMFYUI WORKFLOW\n${text}\n`
    }
    const text = summaryAnchors
      .map((a: any) => `### ${a.title ?? a.id}\n${a.content ?? ''}`)
      .join('\n\n')
    return `\n## CURRENT COMFYUI WORKFLOW\n${text}\n`
  } catch (err) {
    logger.debug(`getWorkflowContext failed: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/**
 * 读取最近 N 条 SGA 会话消息, 作为 codex 的"记忆注入".
 * codex 的 thread 跟 SGA session 是隔离的, 不注入的话切换到 codex 会"失忆".
 */
function getRecentSessionContext(sessionId: string, maxTurns: number = 6): string {
  if (!sessionId) return ''
  try {
    const store = getSessionStore()
    if (!store) return ''
    const session = typeof (store as any).get === 'function'
      ? (store as any).get(sessionId)
      : typeof (store as any).load === 'function'
        ? (store as any).load(sessionId)
        : null
    if (!session || !Array.isArray((session as any).messages)) return ''
    const filtered = (session as any).messages.filter(
      (m: any) => m && (m.role === 'user' || m.role === 'assistant'),
    )
    if (filtered.length === 0) return ''
    const tail = filtered.slice(-maxTurns * 2)
    const lines = tail.map((m: any) => {
      const text = Array.isArray(m.content)
        ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
        : typeof m.content === 'string'
          ? m.content
          : ''
      const trimmed = text.length > 600 ? text.slice(0, 600) + '... [truncated]' : text
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${trimmed}`
    })
    if (lines.length === 0) return ''
    return `\n## RECENT CONVERSATION HISTORY (from SGA session before switching to codex)\n${lines.join('\n\n')}\n`
  } catch (err) {
    logger.debug(`getRecentSessionContext failed: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

export function buildCodexDeveloperInstructions(opts: BuildCodexDevInstrOptions): string {
  const parts: string[] = [
    COMFYUI_AGENT_IDENTITY,
    COMFYUI_CORE_MISSION,
    COMFYUI_CAPABILITIES,
    COMFYUI_RESPONSE_FORMAT,
    COMFYUI_RULES,
    WORKSPACE_HINT,
    getWorkflowContext(),
    getRecentSessionContext(opts.sessionId),
    languageOverride(opts.language),
  ].filter(Boolean)

  const result = parts.join('\n\n').trim()
  logger.info(
    `codex developerInstructions built: sessionId=${opts.sessionId}, ` +
    `lang=${opts.language ?? 'en'}, len=${result.length}, ` +
    `hasWorkflowContext=${result.includes('CURRENT COMFYUI WORKFLOW')}, ` +
    `hasRecentContext=${result.includes('RECENT CONVERSATION HISTORY')}`,
  )
  return result
}
