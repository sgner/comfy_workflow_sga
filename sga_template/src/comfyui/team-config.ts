import { createLogger } from '../utils/logger.js'
import type { TeamFile, TeamMember } from '../teams/types.js'
import { loadTeamFile, saveTeamFile, getTeamDir } from '../teams/mailbox.js'
import { existsSync } from 'fs'
import { mkdirSync } from 'fs'
import type { TeamMemorySyncConfig } from '../memory/team-memory-sync.js'

const logger = createLogger('comfyui-team')

export const COMFYUI_TEAM_NAME = 'comfyui-agents'

export const COMFYUI_TEAM_MEMORY_SYNC_CONFIG: Partial<TeamMemorySyncConfig> = {
  enabled: true,
  syncIntervalMs: 30_000,
  maxEntriesPerSync: 50,
  conflictResolution: 'last_write_wins',
  broadcastToAgents: ['comfyui-workflow', 'comfyui-debug', 'comfyui-research'],
}

export function createComfyUITeamMember(
  agentId: string,
  name: string,
  agentType: string,
  cwd: string,
): TeamMember {
  return {
    agentId,
    name,
    agentType,
    color: getAgentColor(agentType),
    joinedAt: Date.now(),
    cwd,
    isActive: true,
    subscriptions: ['workflow_updates', 'error_reports', 'model_discoveries'],
  }
}

function getAgentColor(agentType: string): string {
  const colors: Record<string, string> = {
    'comfyui-workflow': '#4ECDC4',
    'comfyui-debug': '#FF6B6B',
    'comfyui-research': '#45B7D1',
    'comfyui-verification': '#96CEB4',
    'coordinator': '#FFEAA7',
  }
  return colors[agentType] ?? '#DDA0DD'
}

export async function ensureComfyUITeam(cwd: string): Promise<TeamFile> {
  let team = await loadTeamFile(COMFYUI_TEAM_NAME)

  if (!team) {
    const teamDir = getTeamDir(COMFYUI_TEAM_NAME)
    if (!existsSync(teamDir)) {
      mkdirSync(teamDir, { recursive: true })
    }

    team = {
      name: COMFYUI_TEAM_NAME,
      description: 'ComfyUI Agent collaboration team for workflow creation, debugging, and optimization',
      createdAt: Date.now(),
      leadAgentId: 'comfyui-workflow',
      members: [
        createComfyUITeamMember('comfyui-workflow', 'Workflow Architect', 'comfyui-workflow', cwd),
        createComfyUITeamMember('comfyui-debug', 'Debug Specialist', 'comfyui-debug', cwd),
        createComfyUITeamMember('comfyui-research', 'Research Agent', 'comfyui-research', cwd),
      ],
      teamAllowedPaths: [
        { path: cwd, permissions: ['read', 'write'] },
      ],
    }

    await saveTeamFile(team)
    logger.info(`Created ComfyUI team: ${COMFYUI_TEAM_NAME}`)
  }

  return team
}

export async function addComfyUITeamMember(
  agentId: string,
  name: string,
  agentType: string,
  cwd: string,
): Promise<void> {
  const team = await loadTeamFile(COMFYUI_TEAM_NAME)
  if (!team) {
    await ensureComfyUITeam(cwd)
    return
  }

  const existing = team.members.find(m => m.agentId === agentId)
  if (existing) {
    existing.isActive = true
    await saveTeamFile(team)
    return
  }

  team.members.push(createComfyUITeamMember(agentId, name, agentType, cwd))
  await saveTeamFile(team)
  logger.info(`Added team member: ${name} (${agentType})`)
}

export async function removeComfyUITeamMember(agentId: string): Promise<void> {
  const team = await loadTeamFile(COMFYUI_TEAM_NAME)
  if (!team) return

  const member = team.members.find(m => m.agentId === agentId)
  if (member) {
    member.isActive = false
    await saveTeamFile(team)
    logger.info(`Deactivated team member: ${member.name}`)
  }
}
