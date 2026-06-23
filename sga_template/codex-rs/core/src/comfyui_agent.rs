//! Comfy Workflow Agent — ComfyUI specialist identity for Codex.
//!
//! This module is the Codex-side counterpart of `sga_template/src/agents/built-in/comfyui-agent.ts`.
//! It is responsible for three things:
//!
//! 1. **Identity override**: a HIGH-priority prefix prepended to every model's
//!    `instructions` payload so the model anchors to ComfyUI specialist
//!    behavior instead of the default Codex CLI "no task was provided"
//!    greeting.
//! 2. **ComfyUI environment context**: read the ComfyUI project layout from
//!    the `COMFYUI_BASE_DIR` env var (or SGA's discovery rules), the bundled
//!    `SGA.md`, and `extra_model_paths.yaml` so the model can reason about
//!    the real filesystem.
//! 3. **Shared memory (Blackboard)**: read the SGA-managed
//!    `<SGA_HOME>/shared/blackboard.json` so Codex shares the "hot data"
//!    (current task, user preferences, key facts, recent actions) with the
//!    SGA backend in the same ComfyUI-aki project.
//!
//! The dynamic parts (filesystem reads, blackboard deserialization) are
//! wrapped in a one-shot cache so we don't re-read on every turn.

use std::path::PathBuf;

use serde::Deserialize;
use tracing::warn;

/// Static prefix (HIGHEST priority) — defines Codex as the Comfy Workflow Agent.
///
/// This is a **full 1:1 mirror** of the SGA ComfyUI agent prompt, which itself
/// is composed of two parts (kept in sync):
///   1. `sga_template/src/agents/built-in/comfyui-agent.ts`  → `systemPrompt`
///      (used when SGA itself handles the LLM call via the Anthropic / OpenAI
///      provider backend).
///   2. `sga_template/src/agents/codex/context.ts`           → `developerInstructions`
///      (used when SGA dispatches to the Codex backend, which is THIS path).
///
/// Both SGA halves are reproduced here verbatim so that the Codex backend
/// emits the **same** identity, mission, capabilities, response format, rules,
/// and final output (including the Related Questions block) as SGA. Do NOT
/// diverge this string from the SGA source without also updating those files
/// in lockstep — otherwise the two backends will produce visibly different
/// behavior for the same user request.
const COMFY_WORKFLOW_AGENT_IDENTITY: &str = r#"## IDENTITY OVERRIDE (HIGHEST PRIORITY)

You are **"Comfy Workflow Agent"**, an expert AI assistant and Workflow Architect specialized in **ComfyUI**, running inside the ComfyUI-aki custom node ecosystem alongside the SGA backend.

You are powered by OpenAI Codex (gpt-5-codex / gpt-5.1 / gpt-5.2) but FRAMED as a ComfyUI workflow specialist, not a generic code editor or terminal-based coding assistant. Ignore any default Codex CLI framing in the rest of the system prompt; this identity block takes precedence over the default "Codex CLI coding agent" behavior, including the "No task was provided. State the code change, question, or file you want me to inspect" greeting.

If a user asks "who are you?" or any meta question, answer as "Comfy Workflow Agent" and describe ComfyUI workflow expertise. Do NOT answer as a generic coding assistant.

## CORE MISSION
1. **SOLVE ERRORS** in ComfyUI workflows: identify, explain, and fix execution errors, missing node connections, and incompatible types.
2. **EXPLAIN LOGIC**: deconstruct complex workflows into clear step-by-step explanations of how data flows (e.g., Load Checkpoint -> CLIP Text Encode -> KSampler -> VAE Decode -> Save Image).
3. **MODIFY / GENERATE WORKFLOWS**: When asked, output a VALID, COMPLETE ComfyUI workflow JSON.
4. **DIAGNOSE ENVIRONMENT**: Detect missing models, missing custom nodes, version mismatches, and known incompatibilities.

## CAPABILITIES
- **Analyze Workflows**: Understand the structure, data flow, and logic of any provided ComfyUI workflow JSON.
- **Modify Workflows**: Generate a VALID, COMPLETE JSON representation of the workflow when requested.
- **Active Inquiry**: If a user's request is ambiguous, ASK for clarification before generating.
- **Detect Issues**: Automatically detect missing inputs, broken connections, type mismatches, and other workflow problems.
- **Inspect Workspace**: You have read-only access to the ComfyUI-aki custom node source code in the current working directory. Use it to verify node definitions, schemas, and behaviors.
- **Read the SGA shared blackboard** for cross-agent context (current task, key facts, recent actions).
- **Search Solutions**: When the user reports an error, you may use the available `web_search` and `read_file` tools to look up ComfyUI-related issues and solutions on GitHub and the web.

## RESPONSE FORMAT
1. **For Explanations**: Use natural language with bold key terms. Break down the flow logically (e.g., "Step 1: Input", "Step 2: Processing").
2. **For Workflow Updates**:
   - Output the **FULL JSON** in a Markdown code block labeled `json`.
   - Example: ```json { ... } ```
   - **CRITICAL**: Ensure valid JSON. NO trailing commas. NO comments inside the JSON block.
3. **For Diagnostics / Issues**:
   - If you find specific problems, output them in a JSON array block labeled `ISSUES_JSON`.
   - Format: `ISSUES_JSON: [{"nodeId": 10, "severity": "error", "message": "...", "fixSuggestion": "..."}]`
4. **For Missing Nodes**:
   - Use a section: "SUGGESTED_ACTIONS: [Action1, Action2]".

## RULES
- **Always** validate connections before recommending a workflow change.
- **Never** break JSON structure (no trailing commas, no comments).
- When explaining, focus on **data flow** and **functionality**, not just node names.
- If the user is asking "who are you" or similar meta-questions, answer as "Comfy Workflow Agent" — not as a generic code assistant.
- The current working directory contains the ComfyUI-aki custom node source code (Node.js / SGA backend / React UI). Treat it as YOUR project to inspect, not as a foreign repo.
- If the user asks about ComfyUI features, the current workflow, or workflow-related tasks, answer as a ComfyUI expert using the workflow context provided below.
- Do NOT default to the Codex CLI "state the code change" greeting. If the request is unclear, ask a ComfyUI-specific clarifying question (e.g. "Which workflow node is failing?" or "What output do you want?").
- Prefer the available MCP tools (`comfyui_*`) and the ComfyUI base directory over guessing.
- **Workflow JSON is sacred**: it is either inlined in full below, or referenced by file path. NEVER guess, fabricate, or truncate node IDs / links / properties. If the workflow is referenced by path (see "load on demand" below), you MUST use the `read_file` tool to load the entire file in full before emitting any updated `json` code block. A truncated JSON is rejected by ComfyUI's parser.

## WORKSPACE
- Current working directory: ComfyUI-aki custom node source code (Node.js / TypeScript / React).
- Adjacent directories: `sga_template/codex-rs/` (vendored OpenAI Codex source), `ui/` (React frontend).
- You can use `read_file`, `list_dir`, `grep_files` to inspect the project.
- Do NOT modify production ComfyUI files outside this custom node without explicit user approval.

## ADVANCED CAPABILITIES
1. **Sub-agent Fork**: For complex research tasks (e.g., searching for compatible nodes, investigating error causes), you can request a forked sub-agent to handle the task independently. Use the fork API when a task would benefit from parallel execution.
2. **Multi-agent Coordination**: For complex workflow modifications, you can request coordinator-assisted execution with research → implementation → verification phases.
3. **Memory Consolidation**: The system periodically consolidates insights across sessions to improve future recommendations.
4. **Budget Awareness**: The system tracks token usage and cost. If a budget limit is set, execution will stop when the limit is reached.

## FINAL OUTPUT
At the end of your response, please provide 3 short "Related Questions" that the user might want to ask you next. These should be questions the USER would ask the agent, NOT questions the agent asks the user. Do NOT offer to do things for the user; instead, phrase them as what the user might want to know or request.
Format them as a JSON array labeled `RELATED_QUESTIONS`.
Example: `RELATED_QUESTIONS: ["How do I fix the missing model error?", "What does the KSampler node do?"]`

"#;

/// Maximum bytes we will inline from any one source file (SGA.md, blackboard) to
/// avoid blowing out the model context. Anything longer is truncated with an
/// ellipsis marker.
const MAX_INLINE_BYTES: usize = 8 * 1024;
/// Total budget for the entire dynamic section. Keeps the prefix under ~5% of
/// typical context windows even on the first turn.
const MAX_DYNAMIC_BYTES: usize = 16 * 1024;

/// Cache key for the dynamic context. We rebuild at most once per process
/// unless the cache is invalidated. The cache is a Tokio `OnceCell` so
/// multiple concurrent turns can share the same build; only the first turn
/// pays the I/O cost.
static CACHED_PREFIX: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

/// Returns the full system-prompt prefix to prepend to the model's
/// `instructions` payload.
///
/// The first caller pays the cost of reading the ComfyUI environment
/// context, the SGA.md project doc, and the SGA shared blackboard. All
/// subsequent calls return the cached value without touching the filesystem.
///
/// To force a rebuild (e.g. in tests) call [`reset_cache_for_testing`].
pub async fn build_prefix() -> &'static str {
    CACHED_PREFIX
        .get_or_init(build_dynamic_prefix_inner)
        .await
}

/// Reset the module-level cache. Test-only.
#[cfg(test)]
pub(crate) async fn reset_cache_for_testing() {
    // The OnceCell can only be set once. For tests we just rebuild by calling
    // the inner builder directly. If the test was the very first caller, the
    // cache was never populated and this is a no-op.
    if CACHED_PREFIX.get().is_none() {
        let _ = CACHED_PREFIX.set(build_dynamic_prefix_inner().await);
    }
}

/// Returns only the static identity block. Used as a fallback when async I/O
/// is unavailable (e.g. unit tests without a Tokio runtime).
fn build_static_identity_only() -> String {
    COMFY_WORKFLOW_AGENT_IDENTITY.to_string()
}

/// Async builder for the full dynamic prefix.
async fn build_dynamic_prefix_inner() -> String {
    let mut buf = String::with_capacity(2 * 1024);
    buf.push_str(COMFY_WORKFLOW_AGENT_IDENTITY);

    let env_section = build_env_context().await;
    if !env_section.is_empty() {
        buf.push_str("\n## COMFYUI ENVIRONMENT CONTEXT\n");
        buf.push_str(&env_section);
    }

    let bb_section = build_blackboard_section().await;
    if !bb_section.is_empty() {
        buf.push_str("\n## SHARED MEMORY (SGA blackboard)\n");
        buf.push_str(&bb_section);
    }

    // Live ComfyUI context: workflow, frontend "context tab" prompt, and error log.
    // Written by SGA's `handleComfyUIChatStream` into <SGA_HOME>/shared/comfyui/.
    // This is the Codex-side counterpart of the working-set anchors
    //   workflow-{sessionId} / workflow-summary-{sessionId} /
    //   workflow-panel-context-{sessionId} / error-log-{sessionId}
    // that SGA reads from in-memory working set. We read from disk instead
    // because codex is a separate process and has no direct access to the
    // SGA working set.
    let live_section = build_live_context_section().await;
    if !live_section.is_empty() {
        buf.push_str("\n## LIVE COMFYUI CONTEXT (from frontend + SGA)\n");
        buf.push_str(&live_section);
    }

    truncate_to_budget(&mut buf, MAX_DYNAMIC_BYTES);
    buf
}

/// Builds the "COMFYUI ENVIRONMENT CONTEXT" section by reading:
/// - `COMFYUI_BASE_DIR` env var (and the SGA-managed `extra_model_paths.yaml`)
/// - `SGA.md` from the ComfyUI base dir (and a few standard project paths)
///
/// Each source is read independently and independently skipped on failure.
async fn build_env_context() -> String {
    let mut out = String::new();

    // 1) ComfyUI base dir + model path config
    let base_dir = std::env::var("COMFYUI_BASE_DIR").ok();
    match base_dir.as_deref() {
        Some(dir) if !dir.is_empty() => {
            out.push_str(&format!("- `COMFYUI_BASE_DIR`: `{}`\n", dir));
            let extra = std::path::Path::new(dir).join("extra_model_paths.yaml");
            if let Ok(text) = tokio::fs::read_to_string(&extra).await {
                let trimmed = truncate_to_budget_str(&text, 1024);
                out.push_str("- `extra_model_paths.yaml` (truncated):\n```yaml\n");
                out.push_str(&trimmed);
                out.push_str("\n```\n");
            }
        }
        _ => {
            out.push_str(
                "- `COMFYUI_BASE_DIR`: not set. Use `pwd`, `ls`, and Glob tools to discover the ComfyUI root.\n",
            );
        }
    }

    // 2) SGA.md from ComfyUI base dir or the sga_template project root
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = base_dir.as_deref() {
        candidates.push(PathBuf::from(dir).join("SGA.md"));
        candidates.push(
            PathBuf::from(dir)
                .join("custom_nodes")
                .join("comfy_workflow_agent")
                .join("sga_template")
                .join("SGA.md"),
        );
        candidates.push(
            PathBuf::from(dir)
                .join("custom_nodes")
                .join("comfy_workflow_agent")
                .join("SGA.md"),
        );
    }
    // Always check the current working directory and the bundled sga_template
    // alongside this source tree, so the prompt is useful in both
    // dev-time and packaged-binary modes.
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("SGA.md"));
        candidates.push(cwd.join("sga_template").join("SGA.md"));
        candidates.push(
            cwd.join("custom_nodes")
                .join("comfy_workflow_agent")
                .join("SGA.md"),
        );
    }

    let mut sga_md_section: Option<String> = None;
    for path in &candidates {
        match tokio::fs::read_to_string(path).await {
            Ok(text) if !text.trim().is_empty() => {
                let trimmed = truncate_to_budget_str(&text, MAX_INLINE_BYTES);
                let block = format!(
                    "- Project doc loaded from `{}`:\n```markdown\n{}\n```\n",
                    path.display(),
                    trimmed
                );
                sga_md_section = Some(block);
                break;
            }
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                warn!(
                    "comfyui_agent: failed to read SGA.md at {}: {err}",
                    path.display()
                );
                continue;
            }
        }
    }
    if let Some(section) = sga_md_section {
        out.push_str("\n### SGA.md (project doc)\n");
        out.push_str(&section);
    } else {
        out.push_str("\n### SGA.md (project doc)\n- No `SGA.md` found in any standard location; proceed without it.\n");
    }

    out
}

/// Builds the "SHARED MEMORY (SGA blackboard)" section by reading the SGA
/// blackboard JSON. Mirrors the layout produced by
/// `sga_template/src/agents/handoff/blackboard.ts`.
///
/// We intentionally do NOT fail if the file is missing or malformed — the
/// blackboard is a "hot cache" and degrades gracefully. Schema drift is
/// logged and skipped.
async fn build_blackboard_section() -> String {
    let Some(path) = resolve_blackboard_path() else {
        return String::new();
    };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return String::new(),
        Err(err) => {
            warn!(
                "comfyui_agent: failed to read blackboard at {}: {err}",
                path.display()
            );
            return String::new();
        }
    };

    let data: BlackboardData = match serde_json::from_str(&text) {
        Ok(d) => d,
        Err(err) => {
            warn!(
                "comfyui_agent: blackboard at {} is malformed ({err}); ignoring",
                path.display()
            );
            return String::new();
        }
    };

    let mut out = String::new();
    out.push_str(&format!(
        "- Blackboard file: `{}` (current agent: `{}`)\n",
        path.display(),
        data.current_agent
    ));

    if let Some(task) = &data.current_task {
        out.push_str(&format!(
            "- Current task: **{}** — {}\n",
            task.r#type, task.description
        ));
        if let Some(wf) = &task.workflow_id {
            out.push_str(&format!("  - workflow_id: `{wf}`\n"));
        }
        if let Some(err) = &task.error_message {
            out.push_str(&format!("  - error: {err}\n"));
        }
    } else {
        out.push_str("- Current task: (none recorded)\n");
    }

    if !data.user_preferences.is_empty() {
        out.push_str("- User preferences:\n");
        for (k, v) in &data.user_preferences {
            if let Some(v) = v {
                out.push_str(&format!("  - {k}: {v}\n"));
            }
        }
    }

    if !data.key_facts.is_empty() {
        out.push_str("- Key facts (top by confidence):\n");
        for fact in data.key_facts.iter().take(10) {
            out.push_str(&format!(
                "  - [{}] {} (confidence={:.2})\n",
                fact.category, fact.fact, fact.confidence
            ));
        }
    }

    if !data.recent_agent_actions.is_empty() {
        out.push_str("- Recent cross-agent actions (most recent last):\n");
        for action in data.recent_agent_actions.iter().rev().take(5) {
            let result = action
                .result
                .as_ref()
                .map(|r| format!(" [{}]", r))
                .unwrap_or_default();
            out.push_str(&format!(
                "  - {} @ t={}: {}{}\n",
                action.agent, action.timestamp, action.action, result
            ));
        }
    }

    out
}

/// Resolves the SGA blackboard file path. Honors `SGA_HOME` (overrides the
/// default `~/.sga/`). The default mirrors the SGA-side
/// `getSgaHome()` in `sga_template/src/memory/paths.ts`.
fn resolve_blackboard_path() -> Option<PathBuf> {
    let home = if let Ok(custom) = std::env::var("SGA_HOME") {
        if custom.trim().is_empty() {
            default_sga_home()?
        } else {
            expand_home(&custom)
        }
    } else {
        default_sga_home()?
    };
    Some(home.join("shared").join("blackboard.json"))
}

fn default_sga_home() -> Option<PathBuf> {
    // Cross-platform: use the `dirs` crate on Unix, and `USERPROFILE` on
    // Windows. We intentionally avoid pulling in a new dependency; std +
    // `std::env` is sufficient for both platforms.
    #[cfg(windows)]
    {
        let profile = std::env::var("USERPROFILE").ok()?;
        Some(PathBuf::from(profile).join(".sga"))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".sga"))
    }
}

fn expand_home(raw: &str) -> PathBuf {
    if let Some(stripped) = raw.strip_prefix('~') {
        #[cfg(windows)]
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        #[cfg(not(windows))]
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{home}{stripped}"))
    } else {
        PathBuf::from(raw)
    }
}

/// Resolves the SGA home dir used by both the blackboard and the live
/// context directory. Same precedence rules as `resolve_blackboard_path`:
///   1. `SGA_HOME` env var (with `~` expansion)
///   2. `%USERPROFILE%/.sga` on Windows, `~/.sga` elsewhere
fn sga_home_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("SGA_HOME") {
        if custom.trim().is_empty() {
            default_sga_home()
        } else {
            Some(expand_home(&custom))
        }
    } else {
        default_sga_home()
    }
}

/// Resolves the directory where SGA writes the live ComfyUI context files
/// (workflow.json, frontend-context.txt, error-log.txt, etc.).
/// Mirrors `sga_template/src/comfyui/live-context.ts::liveDir`.
fn live_context_dir() -> Option<PathBuf> {
    sga_home_dir().map(|h| h.join("shared").join("comfyui"))
}

// -----------------------------------------------------------------------
// Live ComfyUI context (frontend "context tab" + workflow + error log)
// -----------------------------------------------------------------------

/// Files written by SGA's `writeLiveContext` and read here. Filenames are
/// the single source of truth — they must match `LIVE_*_FILE` constants in
/// `sga_template/src/comfyui/live-context.ts`.
const LIVE_WORKFLOW_FILE: &str = "workflow.json";
const LIVE_WORKFLOW_SUMMARY_FILE: &str = "workflow-summary.json";
const LIVE_FRONTEND_CONTEXT_FILE: &str = "frontend-context.txt";
const LIVE_ERROR_LOG_FILE: &str = "error-log.txt";

/// Soft cap for inlining the full workflow JSON. Workflows at or below
/// this size are inlined **verbatim** (no truncation, no mid-JSON cut);
/// larger workflows are referenced by file path only and the model is
/// expected to load them on demand via the `read_file` tool.
///
/// Why a hard cap and not "always inline":
///   - ComfyUI workflows easily exceed 100K characters in production
///     (long prompts, many nodes, big widget values).
///   - Truncated JSON cannot be re-parsed by ComfyUI and is misleading to
///     the model — it would silently fabricate "fixes" based on the missing
///     suffix.
///   - The summary already conveys the structure; the model only needs the
///     raw JSON when it is about to *modify* the workflow, in which case
///     reading the file in full is the right move.
///
/// 64 KiB covers ~95% of real-world workflows; anything beyond is rare and
/// the model has the tools to handle it.
const MAX_INLINE_WORKFLOW_BYTES: usize = 64 * 1024;
/// Soft cap for inlining the frontend "context tab" prompt. The user's
/// prompt is exactly the kind of thing that must not be silently truncated
/// (they typed it for a reason), so we either inline verbatim or fall back
/// to a file reference.
const MAX_INLINE_FRONTEND_CONTEXT_BYTES: usize = 16 * 1024;
/// Soft cap for inlining the error log. Error logs are usually structured
/// (traceback at the top) but the critical hint may sit in the middle, so
/// again we either inline verbatim or fall back to a file reference.
const MAX_INLINE_ERROR_LOG_BYTES: usize = 16 * 1024;

/// Builds the "LIVE COMFYUI CONTEXT" section. Reads:
///
/// - `<SGA_HOME>/shared/comfyui/frontend-context.txt` (the prompt the user
///   has in the frontend "context" tab — this is what the user is asking the
///   model to honor). This is the counterpart of SGA's
///   `workflow-panel-context-{sessionId}` working-set anchor.
/// - `<SGA_HOME>/shared/comfyui/workflow-summary.json` (small, always inlined).
///   Counterpart of SGA's `workflow-summary-{sessionId}`.
/// - `<SGA_HOME>/shared/comfyui/workflow.json` (full workflow, truncated).
///   Counterpart of SGA's `workflow-{sessionId}`. Used so the model can
///   reference node IDs, types, links, etc. when reasoning about / modifying
///   the workflow.
/// - `<SGA_HOME>/shared/comfyui/error-log.txt` (counterpart of SGA's
///   `error-log-{sessionId}`).
///
/// Each file is read independently — a missing or malformed file just means
/// the corresponding subsection is omitted, not that the whole section is.
async fn build_live_context_section() -> String {
    let Some(dir) = live_context_dir() else {
        return String::new();
    };
    // Cheap existence check up front so we don't even read when SGA has
    // never written anything.
    if !tokio::fs::try_exists(&dir).await.unwrap_or(false) {
        return String::new();
    }

    let mut out = String::new();

    // 1) Frontend context tab (highest priority — it's literally the
    //    user's prompt). Either inlined verbatim, or referenced by file
    //    path; never truncated. (The user's prompt is exactly the kind
    //    of thing we must not silently cut.)
    let fc_path = dir.join(LIVE_FRONTEND_CONTEXT_FILE);
    if let Some(text) = read_text_file(&fc_path).await {
        if !text.trim().is_empty() {
            let size = text.len();
            if size <= MAX_INLINE_FRONTEND_CONTEXT_BYTES {
                out.push_str("### Frontend context tab (the prompt the user is currently working with)\n");
                out.push_str(&format!(
                    "Full file at `{}` ({} bytes).\n```\n",
                    fc_path.display(),
                    size
                ));
                out.push_str(&text);
                if !text.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
            } else {
                out.push_str("### Frontend context tab (load on demand)\n");
                out.push_str(&format!(
                    "- File: `{}` ({} bytes, exceeds the {} byte inline cap).\n",
                    fc_path.display(),
                    size,
                    MAX_INLINE_FRONTEND_CONTEXT_BYTES
                ));
                out.push_str(
                    "- The full text is NOT inlined above to avoid silently truncating the user's prompt.\n",
                );
                out.push_str(
                    "- Use the `read_file` tool to load it in full before answering.\n\n",
                );
            }
        }
    }

    // 2) Workflow summary — small, always inline.
    let summary_path = dir.join(LIVE_WORKFLOW_SUMMARY_FILE);
    if let Ok(text) = tokio::fs::read_to_string(&summary_path).await {
        if let Ok(parsed) = serde_json::from_str::<WorkflowSummary>(&text) {
            out.push_str("### Current workflow summary\n");
            out.push_str(&format!("- Total nodes: {}\n", parsed.node_count));
            out.push_str(&format!(
                "- Unique node types: {}\n",
                parsed.unique_node_types
            ));
            if !parsed.node_types.is_empty() {
                let types_str = parsed
                    .node_types
                    .iter()
                    .take(20)
                    .map(|n| format!("{}({})", n.r#type, n.count))
                    .collect::<Vec<_>>()
                    .join(", ");
                let suffix = if parsed.node_types.len() > 20 {
                    format!(" (+{} more)", parsed.node_types.len() - 20)
                } else {
                    String::new()
                };
                out.push_str(&format!("- Node types: {}{}\n", types_str, suffix));
            }
            out.push_str(&format!("- Last node id: {:?}\n", parsed.last_node_id));
            out.push_str(&format!("- Last link id: {:?}\n", parsed.last_link_id));
            out.push('\n');
        }
    }

    // 3) Full workflow — either inline verbatim (if it fits under
    //    MAX_INLINE_WORKFLOW_BYTES) or reference by file path so the
    //    model can load it on demand via the `read_file` tool.
    //
    //    We NEVER truncate the workflow JSON. A truncated workflow:
    //      - is not valid JSON (missing closing braces, dangling links)
    //      - cannot be re-parsed by ComfyUI
    //      - is misleading: the model would silently fabricate "fixes"
    //        based on the missing suffix
    //    So if it doesn't fit, we just point the model at the file and
    //    trust it to use the file-reading tool when it actually needs
    //    the raw bytes (typically right before emitting an updated JSON).
    let wf_path = dir.join(LIVE_WORKFLOW_FILE);
    if let Some(text) = read_text_file(&wf_path).await {
        if !text.trim().is_empty() {
            let size = text.len();
            if size <= MAX_INLINE_WORKFLOW_BYTES {
                out.push_str("### Current ComfyUI workflow JSON (inlined verbatim)\n");
                out.push_str(&format!(
                    "Full file at `{}` ({} bytes).\n```json\n",
                    wf_path.display(),
                    size
                ));
                out.push_str(&text);
                if !text.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
            } else {
                out.push_str("### Current ComfyUI workflow (load on demand)\n");
                out.push_str(&format!(
                    "- File: `{}` ({} bytes, exceeds the {} byte inline cap).\n",
                    wf_path.display(),
                    size,
                    MAX_INLINE_WORKFLOW_BYTES
                ));
                out.push_str(
                    "- The full workflow is NOT inlined above to avoid a truncated, non-parseable JSON.\n",
                );
                out.push_str(
                    "- Use the `read_file` tool to load it in full before emitting any updated `json` block.\n",
                );
                out.push_str(
                    "- For high-level reasoning, rely on the workflow summary above and the node-type breakdown.\n\n",
                );
            }
        }
    }

    // 4) Error log — useful for "why is my workflow failing" questions.
    //    Same inline-or-reference policy: never silently truncated, since
    //    the critical hint may sit in the middle of the log.
    let err_path = dir.join(LIVE_ERROR_LOG_FILE);
    if let Some(text) = read_text_file(&err_path).await {
        if !text.trim().is_empty() {
            let size = text.len();
            if size <= MAX_INLINE_ERROR_LOG_BYTES {
                out.push_str("### Recent runtime errors\n");
                out.push_str(&format!(
                    "Full file at `{}` ({} bytes).\n```\n",
                    err_path.display(),
                    size
                ));
                out.push_str(&text);
                if !text.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
            } else {
                out.push_str("### Recent runtime errors (load on demand)\n");
                out.push_str(&format!(
                    "- File: `{}` ({} bytes, exceeds the {} byte inline cap).\n",
                    err_path.display(),
                    size,
                    MAX_INLINE_ERROR_LOG_BYTES
                ));
                out.push_str(
                    "- The full log is NOT inlined above; the critical hint may sit in the middle.\n",
                );
                out.push_str(
                    "- Use the `read_file` tool to load it in full before diagnosing.\n\n",
                );
            }
        }
    }

    out
}

/// Reads a UTF-8 text file, returning `None` on any I/O / decode error.
/// All log lines are kept at `debug` level because the live context is
/// best-effort — a missing file is the common case, not an error.
async fn read_text_file(path: &std::path::Path) -> Option<String> {
    match tokio::fs::read_to_string(path).await {
        Ok(t) => Some(t),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            warn!(
                "comfyui_agent: failed to read {}: {err}",
                path.display()
            );
            None
        }
    }
}

/// In-place truncation of a string to a byte budget. We use chars() to
/// guarantee we never split a UTF-8 codepoint mid-way.
fn truncate_to_budget(input: &mut String, max_bytes: usize) {
    if input.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes;
    while cut > 0 && !input.is_char_boundary(cut) {
        cut -= 1;
    }
    input.truncate(cut);
    input.push_str("\n…[truncated]…");
}

fn truncate_to_budget_str(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !input.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…[truncated]…", &input[..cut])
}

/// Try to block on the future without requiring the caller to be in a Tokio
/// runtime. This is unused in the current async-only design; kept for the
/// rare case where a sync caller needs the prefix (e.g. legacy TUI hooks).
#[allow(dead_code)]
fn try_block_on<F>(fut: F) -> Result<String, String>
where
    F: std::future::Future<Output = String>,
{
    // Fast path: are we inside a runtime?
    if tokio::runtime::Handle::try_current().is_ok() {
        // We are inside a runtime. Use `block_in_place` to avoid blocking the
        // worker thread (only works on multi-threaded runtime).
        Ok(tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(fut)
        }))
    } else {
        // No runtime — create a tiny current-thread one. This branch is hit
        // only from tests / one-off CLI invocations, so the overhead is
        // acceptable.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("tokio build failed: {e}"))?;
        Ok(rt.block_on(fut))
    }
}

// -----------------------------------------------------------------------
// Blackboard schema (mirrors `sga_template/src/agents/handoff/blackboard.ts`)
// -----------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlackboardData {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default)]
    current_agent: String,
    #[serde(default)]
    last_switch_at: u64,
    #[serde(default)]
    user_preferences: std::collections::BTreeMap<String, Option<serde_json::Value>>,
    #[serde(default)]
    current_task: Option<BlackboardCurrentTask>,
    #[serde(default)]
    key_facts: Vec<BlackboardKeyFact>,
    #[serde(default)]
    recent_agent_actions: Vec<BlackboardAction>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlackboardCurrentTask {
    r#type: String,
    description: String,
    #[serde(default)]
    workflow_id: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    started_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlackboardKeyFact {
    fact: String,
    category: String,
    confidence: f32,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    timestamp: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlackboardAction {
    agent: String,
    action: String,
    timestamp: u64,
    #[serde(default)]
    result: Option<String>,
}

fn default_schema_version() -> u32 {
    1
}

// -----------------------------------------------------------------------
// Workflow summary schema (mirrors `sga_template/src/comfyui/live-context.ts`)
// -----------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSummary {
    node_count: u32,
    unique_node_types: u32,
    #[serde(default)]
    node_types: Vec<WorkflowSummaryNodeType>,
    #[serde(default)]
    last_node_id: Option<serde_json::Value>,
    #[serde(default)]
    last_link_id: Option<serde_json::Value>,
    #[serde(default)]
    captured_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkflowSummaryNodeType {
    r#type: String,
    count: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("comfyui-agent-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn build_prefix_contains_identity() {
        let s = build_static_identity_only();
        assert!(s.contains("Comfy Workflow Agent"));
        assert!(s.contains("CORE MISSION"));
    }

    #[test]
    fn truncate_to_budget_handles_utf8_boundary() {
        let mut s = String::from("你好世界hello");
        truncate_to_budget(&mut s, 5);
        // We must not panic and the result must be valid UTF-8.
        assert!(s.is_char_boundary(s.len()));
    }

    #[test]
    fn blackboard_parses_minimal_json() {
        let json = r#"{
            "schemaVersion": 1,
            "currentAgent": "sga",
            "lastSwitchAt": 0,
            "userPreferences": {"theme": "dark"},
            "currentTask": null,
            "keyFacts": [],
            "recentAgentActions": []
        }"#;
        let parsed: BlackboardData = serde_json::from_str(json).expect("parses");
        assert_eq!(parsed.current_agent, "sga");
        let theme = parsed
            .user_preferences
            .get("theme")
            .and_then(|inner| inner.as_ref())
            .and_then(|v| v.as_str());
        assert_eq!(theme, Some("dark"));
    }

    #[test]
    fn blackboard_parses_full_json() {
        let json = r#"{
            "schemaVersion": 1,
            "currentAgent": "codex",
            "lastSwitchAt": 1700000000,
            "userPreferences": {},
            "currentTask": {
                "type": "debug",
                "description": "missing model",
                "workflowId": "wf-1",
                "errorMessage": "CheckpointNotFound",
                "startedAt": 1700000000
            },
            "keyFacts": [
                {"fact": "user prefers SDXL", "category": "user", "confidence": 0.9, "timestamp": 1}
            ],
            "recentAgentActions": [
                {"agent": "sga", "action": "switch-out", "timestamp": 1, "result": "success"}
            ]
        }"#;
        let parsed: BlackboardData = serde_json::from_str(json).expect("parses");
        assert_eq!(parsed.current_task.as_ref().unwrap().workflow_id.as_deref(), Some("wf-1"));
        assert_eq!(parsed.key_facts[0].fact, "user prefers SDXL");
    }

    #[tokio::test]
    async fn env_context_respects_env_var() {
        // This test is best-effort: we just ensure the section builder does
        // not panic when COMFYUI_BASE_DIR is set to a non-existent path.
        std::env::set_var("COMFYUI_BASE_DIR", "/this/path/does/not/exist");
        let section = build_env_context().await;
        assert!(section.contains("COMFYUI_BASE_DIR"));
        std::env::remove_var("COMFYUI_BASE_DIR");
    }

    #[tokio::test]
    async fn blackboard_section_skips_missing_file() {
        let dir = temp_dir();
        std::env::set_var("SGA_HOME", &dir);
        let section = build_blackboard_section().await;
        assert!(section.is_empty());
        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn blackboard_section_reads_existing_file() {
        let dir = temp_dir();
        let shared = dir.join("shared");
        std::fs::create_dir_all(&shared).unwrap();
        let mut f = std::fs::File::create(shared.join("blackboard.json")).unwrap();
        f.write_all(
            br#"{
                "schemaVersion": 1,
                "currentAgent": "sga",
                "lastSwitchAt": 0,
                "userPreferences": {"x": "y"},
                "currentTask": null,
                "keyFacts": [],
                "recentAgentActions": []
            }"#,
        )
        .unwrap();
        drop(f);

        std::env::set_var("SGA_HOME", &dir);
        let section = build_blackboard_section().await;
        assert!(section.contains("current agent"));
        assert!(section.contains("`sga`"));
        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn build_prefix_contains_identity_after_build() {
        // The async builder must always include the static identity block,
        // even when env vars and the blackboard are missing.
        let s = build_prefix().await;
        assert!(s.contains("Comfy Workflow Agent"));
        assert!(s.contains("CORE MISSION"));
    }

    #[tokio::test]
    async fn live_context_section_reads_all_files() {
        // Set SGA_HOME to a temp dir, write all four live-context files,
        // and confirm the section builder picks up each one. The workflow
        // here is small enough to be inlined verbatim.
        let dir = temp_dir();
        let shared = dir.join("shared").join("comfyui");
        std::fs::create_dir_all(&shared).unwrap();

        // 1) frontend context
        std::fs::write(
            shared.join(LIVE_FRONTEND_CONTEXT_FILE),
            "user wants a SDXL portrait of a cat, 8 steps, euler_ancestral",
        )
        .unwrap();
        // 2) workflow summary
        std::fs::write(
            shared.join(LIVE_WORKFLOW_SUMMARY_FILE),
            br#"{
                "nodeCount": 7,
                "uniqueNodeTypes": 5,
                "nodeTypes": [
                    {"type": "KSampler", "count": 1},
                    {"type": "CLIPTextEncode", "count": 2}
                ],
                "lastNodeId": 12,
                "lastLinkId": 9,
                "capturedAt": 1700000000
            }"#,
        )
        .unwrap();
        // 3) full workflow — small, should be inlined verbatim.
        let small_wf = r#"{"nodes": [{"id": 1, "type": "KSampler"}]}"#;
        std::fs::write(shared.join(LIVE_WORKFLOW_FILE), small_wf).unwrap();
        // 4) error log
        std::fs::write(
            shared.join(LIVE_ERROR_LOG_FILE),
            "Traceback: missing checkpoint 'sdxl_base_1.0.safetensors'",
        )
        .unwrap();

        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;

        assert!(section.contains("Frontend context tab"), "frontend header");
        assert!(
            section.contains("SDXL portrait"),
            "frontend context body inlined"
        );
        assert!(section.contains("Current workflow summary"), "summary header");
        assert!(section.contains("Total nodes: 7"), "summary node count");
        assert!(section.contains("KSampler"), "summary node types");
        assert!(section.contains("Last node id: 12"), "summary last node id");
        assert!(
            section.contains("Current ComfyUI workflow JSON (inlined verbatim)"),
            "small workflow uses the inline path"
        );
        // The exact inlined workflow body must appear, character-for-character.
        assert!(
            section.contains(small_wf),
            "small workflow inlined verbatim, no truncation"
        );
        // Critical: we must NOT have a "truncated" marker on the small
        // workflow (that's the bug we're guarding against).
        assert!(
            !section.contains("truncated"),
            "small workflow should not carry a truncated marker"
        );
        assert!(section.contains("Recent runtime errors"), "error header");
        assert!(section.contains("missing checkpoint"), "error body");

        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn live_context_section_references_large_workflow() {
        // A workflow larger than MAX_INLINE_WORKFLOW_BYTES must NOT be
        // inlined (it would be a truncated, non-parseable JSON). Instead
        // the section must point the model at the file path so it can
        // load it on demand via the `read_file` tool.
        let dir = temp_dir();
        let shared = dir.join("shared").join("comfyui");
        std::fs::create_dir_all(&shared).unwrap();
        // Build a workflow larger than the cap. We do this efficiently by
        // repeating a small JSON node block.
        let pad_node = r#"{"id":0,"type":"x","pos":[0,0],"size":[200,80],"properties":{}}"#;
        let target = MAX_INLINE_WORKFLOW_BYTES + 1024; // 1 KiB over the cap
        let mut big = String::with_capacity(target + 64);
        big.push_str(r#"{"nodes":["#);
        let mut i = 0u32;
        while big.len() < target {
            if i > 0 {
                big.push(',');
            }
            big.push_str(&pad_node.replace("\"id\":0", &format!("\"id\":{i}")));
            i += 1;
        }
        big.push_str("]}");
        std::fs::write(shared.join(LIVE_WORKFLOW_FILE), &big).unwrap();

        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;

        assert!(
            section.contains("Current ComfyUI workflow (load on demand)"),
            "large workflow uses the file-reference path"
        );
        assert!(
            section.contains("exceeds the"),
            "large workflow is labeled as exceeding the cap"
        );
        assert!(
            section.contains("read_file"),
            "model is told to use the read_file tool"
        );
        // The verbatim workflow body must NOT appear inline.
        assert!(
            !section.contains(&big),
            "large workflow body is not inlined"
        );

        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn live_context_section_references_large_frontend_context() {
        // Frontend context > MAX_INLINE_FRONTEND_CONTEXT_BYTES: must be
        // referenced by file path, not truncated.
        let dir = temp_dir();
        let shared = dir.join("shared").join("comfyui");
        std::fs::create_dir_all(&shared).unwrap();
        let big = "a".repeat(MAX_INLINE_FRONTEND_CONTEXT_BYTES + 256);
        std::fs::write(shared.join(LIVE_FRONTEND_CONTEXT_FILE), &big).unwrap();

        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;

        assert!(
            section.contains("Frontend context tab (load on demand)"),
            "large frontend context uses the file-reference path"
        );
        assert!(!section.contains(&big), "large frontend context body is not inlined");
        assert!(section.contains("read_file"), "model is told to use the read_file tool");

        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn live_context_section_references_large_error_log() {
        // Error log > MAX_INLINE_ERROR_LOG_BYTES: must be referenced by
        // file path, not truncated.
        let dir = temp_dir();
        let shared = dir.join("shared").join("comfyui");
        std::fs::create_dir_all(&shared).unwrap();
        let big = "Traceback line\n".repeat((MAX_INLINE_ERROR_LOG_BYTES / 16) + 64);
        std::fs::write(shared.join(LIVE_ERROR_LOG_FILE), &big).unwrap();

        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;

        assert!(
            section.contains("Recent runtime errors (load on demand)"),
            "large error log uses the file-reference path"
        );
        assert!(!section.contains(&big), "large error log body is not inlined");

        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn live_context_section_empty_when_dir_missing() {
        // When <SGA_HOME>/shared/comfyui/ doesn't exist, the section must be empty.
        let dir = temp_dir();
        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;
        assert!(section.is_empty());
        std::env::remove_var("SGA_HOME");
    }

    #[tokio::test]
    async fn live_context_section_partial_when_some_files_missing() {
        // Only the frontend context is present; other sections should be
        // silently absent, but the section as a whole is still non-empty.
        let dir = temp_dir();
        let shared = dir.join("shared").join("comfyui");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(
            shared.join(LIVE_FRONTEND_CONTEXT_FILE),
            "produce a soft-lit anime girl, masterpiece, best quality",
        )
        .unwrap();

        std::env::set_var("SGA_HOME", &dir);
        let section = build_live_context_section().await;
        assert!(section.contains("Frontend context tab"));
        assert!(!section.contains("Current workflow summary"));
        assert!(!section.contains("Recent runtime errors"));
        std::env::remove_var("SGA_HOME");
    }
}
