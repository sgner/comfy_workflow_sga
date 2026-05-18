import type { Message, MessageContent } from '../../core/types.js'
import { getSgaConfig } from '../../config.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('post-compact-restore')

export function getPostCompactConfig() {
  return getSgaConfig().postCompact
}

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

export interface FileReadState {
  content: string
  timestamp: number
  path: string
}

export interface PlanState {
  planId: string
  planContent: string
  currentStepIndex: number
  totalSteps: number
}

export interface SkillState {
  skillName: string
  skillContent: string
  invokedAt: number
}

export interface PostCompactState {
  readFileState: Map<string, FileReadState>
  planState: PlanState | null
  skillStates: SkillState[]
  workingSetAnchors: Array<{ id: string; label: string; content: string }>
}

export interface RestoredAttachment {
  type: 'file' | 'plan' | 'skill' | 'working_set'
  label: string
  content: string
  tokenEstimate: number
}

export function capturePreCompactState(
  readFileState: Map<string, { content: string; timestamp: number }>,
  planState?: PlanState | null,
  skillStates?: SkillState[],
  workingSetAnchors?: Array<{ id: string; label: string; content: string }>,
): PostCompactState {
  const fileState = new Map<string, FileReadState>()
  for (const [path, state] of readFileState) {
    fileState.set(path, {
      content: state.content,
      timestamp: state.timestamp,
      path,
    })
  }

  return {
    readFileState: fileState,
    planState: planState ?? null,
    skillStates: skillStates ?? [],
    workingSetAnchors: workingSetAnchors ?? [],
  }
}

export function createPostCompactAttachments(
  preCompactState: PostCompactState,
): RestoredAttachment[] {
  const cfg = getPostCompactConfig()
  const maxFiles = cfg.maxFilesToRestore
  const tokenBudget = cfg.tokenBudget

  const attachments: RestoredAttachment[] = []
  let tokensUsed = 0

  const fileAttachments = createFileAttachments(
    preCompactState.readFileState,
    maxFiles,
  )

  for (const att of fileAttachments) {
    if (tokensUsed + att.tokenEstimate <= tokenBudget) {
      attachments.push(att)
      tokensUsed += att.tokenEstimate
    }
  }

  if (preCompactState.planState) {
    const planAtt = createPlanAttachment(preCompactState.planState)
    if (tokensUsed + planAtt.tokenEstimate <= tokenBudget) {
      attachments.push(planAtt)
      tokensUsed += planAtt.tokenEstimate
    }
  }

  const skillAttachments = createSkillAttachments(
    preCompactState.skillStates,
    cfg.skillsTokenBudget,
  )

  for (const att of skillAttachments) {
    if (tokensUsed + att.tokenEstimate <= tokenBudget) {
      attachments.push(att)
      tokensUsed += att.tokenEstimate
    }
  }

  for (const anchor of preCompactState.workingSetAnchors) {
    const anchorTokens = Math.ceil(anchor.content.length / 4)
    if (tokensUsed + anchorTokens <= tokenBudget) {
      attachments.push({
        type: 'working_set',
        label: anchor.label,
        content: anchor.content,
        tokenEstimate: anchorTokens,
      })
      tokensUsed += anchorTokens
    }
  }

  logger.info(
    `Post-compact restore: ${attachments.length} attachments, ≈${tokensUsed} tokens ` +
    `(files=${fileAttachments.length}, plan=${preCompactState.planState ? 1 : 0}, ` +
    `skills=${skillAttachments.length}, anchors=${preCompactState.workingSetAnchors.length})`,
  )

  return attachments
}

function createFileAttachments(
  readFileState: Map<string, FileReadState>,
  maxFiles: number,
): RestoredAttachment[] {
  const entries = [...readFileState.entries()]
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles)

  return entries.map(([path, state]) => {
    const maxTokens = getPostCompactConfig().maxTokensPerFile
    const content = state.content.length > maxTokens * 4
      ? state.content.slice(0, maxTokens * 4) + '\n... (truncated)'
      : state.content

    return {
      type: 'file' as const,
      label: path,
      content: `### File: ${path}\n\`\`\`\n${content}\n\`\`\``,
      tokenEstimate: Math.ceil(content.length / 4) + 10,
    }
  })
}

function createPlanAttachment(planState: PlanState): RestoredAttachment {
  const content = `### Active Plan: ${planState.planId}\n` +
    `Progress: Step ${planState.currentStepIndex + 1}/${planState.totalSteps}\n\n` +
    planState.planContent

  return {
    type: 'plan',
    label: `Plan: ${planState.planId}`,
    content,
    tokenEstimate: Math.ceil(content.length / 4),
  }
}

function createSkillAttachments(
  skillStates: SkillState[],
  tokenBudget: number,
): RestoredAttachment[] {
  const attachments: RestoredAttachment[] = []
  let tokensUsed = 0

  for (const skill of skillStates) {
    const maxTokens = getPostCompactConfig().maxTokensPerSkill
    const content = skill.skillContent.length > maxTokens * 4
      ? skill.skillContent.slice(0, maxTokens * 4) + '\n... (truncated)'
      : skill.skillContent

    const tokenEstimate = Math.ceil(content.length / 4) + 10

    if (tokensUsed + tokenEstimate <= tokenBudget) {
      attachments.push({
        type: 'skill',
        label: `Skill: ${skill.skillName}`,
        content: `### Skill: ${skill.skillName}\n${content}`,
        tokenEstimate,
      })
      tokensUsed += tokenEstimate
    }
  }

  return attachments
}

export function buildPostCompactSummaryMessage(
  summary: string,
  attachments: RestoredAttachment[],
  transcriptPath?: string,
): string {
  let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`

  if (transcriptPath) {
    message += `\n\nIf you need specific details from before compaction, read the full transcript at: ${transcriptPath}`
  }

  if (attachments.length > 0) {
    message += '\n\n## Restored Context\n'
    for (const att of attachments) {
      message += `\n${att.content}\n`
    }
  }

  message += '\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.'

  return message
}
