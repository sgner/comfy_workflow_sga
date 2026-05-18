export type { TeamFile, TeamMember, TeamMessage, TeamAllowedPath } from './types.js'
export { TEAM_COLORS } from './types.js'
export { getTeamsBaseDir, getTeamDir, getTeamConfigPath, getInboxPath, loadTeamFile, saveTeamFile, readUnreadMessages, sendMessage } from './mailbox.js'
