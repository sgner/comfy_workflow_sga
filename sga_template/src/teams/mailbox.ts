import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { getSgaHome } from '../memory/paths.js'
import type { TeamFile, TeamMessage } from './types.js'

export function getTeamsBaseDir(): string {
  return join(getSgaHome(), 'teams')
}

export function getTeamDir(teamName: string): string {
  return join(getTeamsBaseDir(), teamName)
}

export function getTeamConfigPath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

export function getInboxPath(teamName: string, agentName: string): string {
  return join(getTeamDir(teamName), 'inboxes', `${agentName}.json`)
}

export async function loadTeamFile(teamName: string): Promise<TeamFile | null> {
  const configPath = getTeamConfigPath(teamName)
  if (!existsSync(configPath)) return null
  try {
    const content = await readFile(configPath, 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch {
    return null
  }
}

export async function saveTeamFile(teamFile: TeamFile): Promise<void> {
  const dir = getTeamDir(teamFile.name)
  await mkdir(dir, { recursive: true })
  await writeFile(getTeamConfigPath(teamFile.name), JSON.stringify(teamFile, null, 2), 'utf-8')
}

export async function readUnreadMessages(
  teamName: string,
  agentName: string,
): Promise<TeamMessage[]> {
  const inboxPath = getInboxPath(teamName, agentName)
  if (!existsSync(inboxPath)) return []

  try {
    const content = await readFile(inboxPath, 'utf-8')
    const messages: TeamMessage[] = JSON.parse(content)
    const unread = messages.filter(m => !m.read)

    if (unread.length > 0) {
      const updated = messages.map(m => ({ ...m, read: true }))
      await writeFile(inboxPath, JSON.stringify(updated, null, 2), 'utf-8')
    }

    return unread
  } catch {
    return []
  }
}

export async function sendMessage(
  teamName: string,
  to: string,
  message: Omit<TeamMessage, 'timestamp' | 'read'>,
): Promise<void> {
  if (to === '*') {
    const teamFile = await loadTeamFile(teamName)
    if (!teamFile) throw new Error(`Team "${teamName}" not found`)
    for (const member of teamFile.members) {
      if (member.name !== message.from) {
        await sendMessage(teamName, member.name, message)
      }
    }
    return
  }

  const inboxPath = getInboxPath(teamName, to)
  const dir = join(inboxPath, '..')
  await mkdir(dir, { recursive: true })

  let messages: TeamMessage[] = []
  if (existsSync(inboxPath)) {
    try {
      const content = await readFile(inboxPath, 'utf-8')
      messages = JSON.parse(content)
    } catch {
      messages = []
    }
  }

  messages.push({
    ...message,
    timestamp: new Date().toISOString(),
    read: false,
  })

  await writeFile(inboxPath, JSON.stringify(messages, null, 2), 'utf-8')
}
