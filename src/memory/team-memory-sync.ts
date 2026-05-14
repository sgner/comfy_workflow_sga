import { createLogger } from '../utils/logger.js'
import type { MemoryManager } from './manager.js'
import type { MemoryFile, MemoryScope } from './types.js'

const logger = createLogger('team-memory-sync')

export interface TeamMemorySyncConfig {
  enabled: boolean
  syncIntervalMs: number
  maxEntriesPerSync: number
  conflictResolution: 'last_write_wins' | 'merge' | 'manual'
  broadcastToAgents: string[]
}

export const DEFAULT_TEAM_MEMORY_SYNC_CONFIG: TeamMemorySyncConfig = {
  enabled: true,
  syncIntervalMs: 30_000,
  maxEntriesPerSync: 50,
  conflictResolution: 'last_write_wins',
  broadcastToAgents: [],
}

export interface MemorySyncEvent {
  type: 'create' | 'update' | 'delete'
  entry: MemoryFile
  sourceAgentId: string
  sourceSessionId: string
  timestamp: number
}

export interface SyncConflict {
  localEntry: MemoryFile
  remoteEntry: MemoryFile
  resolution: 'local' | 'remote' | 'merged'
  mergedContent?: string
}

export interface SyncResult {
  synced: boolean
  entriesPushed: number
  entriesPulled: number
  conflicts: SyncConflict[]
  errors: string[]
}

export class TeamMemorySync {
  private config: TeamMemorySyncConfig
  private localAgentId: string
  private localSessionId: string
  private pendingEvents: MemorySyncEvent[] = []
  private lastSyncTime = 0
  private syncInProgress = false

  constructor(
    agentId: string,
    sessionId: string,
    config: Partial<TeamMemorySyncConfig> = {},
  ) {
    this.localAgentId = agentId
    this.localSessionId = sessionId
    this.config = { ...DEFAULT_TEAM_MEMORY_SYNC_CONFIG, ...config }
  }

  recordLocalChange(type: MemorySyncEvent['type'], entry: MemoryFile): void {
    if (!this.config.enabled) return

    this.pendingEvents.push({
      type,
      entry,
      sourceAgentId: this.localAgentId,
      sourceSessionId: this.localSessionId,
      timestamp: Date.now(),
    })

    logger.debug(`Recorded local ${type} event for path=${entry.path}`)
  }

  async syncWithTeam(memoryManager: MemoryManager): Promise<SyncResult> {
    if (!this.config.enabled || this.syncInProgress) {
      return {
        synced: false,
        entriesPushed: 0,
        entriesPulled: 0,
        conflicts: [],
        errors: [],
      }
    }

    this.syncInProgress = true
    const errors: string[] = []
    let entriesPushed = 0
    let entriesPulled = 0
    const conflicts: SyncConflict[] = []

    try {
      const eventsToPush = this.pendingEvents.slice(0, this.config.maxEntriesPerSync)
      this.pendingEvents = this.pendingEvents.slice(eventsToPush.length)

      for (const event of eventsToPush) {
        try {
          await this.pushEventToSharedStore(memoryManager, event)
          entriesPushed++
        } catch (e) {
          errors.push(`Push failed for path=${event.entry.path}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      const remoteEvents = await this.pullRemoteEvents(memoryManager)
      for (const event of remoteEvents) {
        if (event.sourceSessionId === this.localSessionId) continue

        try {
          const conflict = await this.applyRemoteEvent(memoryManager, event)
          if (conflict) {
            conflicts.push(conflict)
          }
          entriesPulled++
        } catch (e) {
          errors.push(`Pull failed for path=${event.entry.path}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      this.lastSyncTime = Date.now()

      if (entriesPushed > 0 || entriesPulled > 0) {
        logger.info(
          `Team memory sync complete: pushed=${entriesPushed}, pulled=${entriesPulled}, ` +
          `conflicts=${conflicts.length}, errors=${errors.length}`,
        )
      }
    } catch (e) {
      errors.push(`Sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.syncInProgress = false
    }

    return {
      synced: errors.length === 0,
      entriesPushed,
      entriesPulled,
      conflicts,
      errors,
    }
  }

  private async pushEventToSharedStore(
    memoryManager: MemoryManager,
    event: MemorySyncEvent,
  ): Promise<void> {
    const syncPath = `_team_sync_${event.entry.path}`
    const scope = event.entry.frontmatter.scope ?? 'project'

    await memoryManager.saveMemoryFile(
      syncPath,
      event.entry.type,
      `[Sync] ${event.entry.description}`,
      event.entry.content,
      scope as MemoryScope,
    )
  }

  private async pullRemoteEvents(
    memoryManager: MemoryManager,
  ): Promise<MemorySyncEvent[]> {
    const events: MemorySyncEvent[] = []

    try {
      const projectMemories = await memoryManager.listProjectMemories()
      const syncMemories = projectMemories.filter(m => m.path.startsWith('_team_sync_'))

      for (const entry of syncMemories.slice(0, this.config.maxEntriesPerSync)) {
        const metadata = entry.frontmatter ?? {}
        events.push({
          type: (metadata.eventType as MemorySyncEvent['type']) ?? 'update',
          entry: {
            ...entry,
            path: entry.path.replace('_team_sync_', ''),
          },
          sourceAgentId: (metadata.sourceAgentId as string) ?? 'unknown',
          sourceSessionId: (metadata.sourceSessionId as string) ?? 'unknown',
          timestamp: entry.mtimeMs,
        })
      }
    } catch (e) {
      logger.debug(`Pull remote events failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    return events
  }

  private async applyRemoteEvent(
    memoryManager: MemoryManager,
    event: MemorySyncEvent,
  ): Promise<SyncConflict | null> {
    const scope = event.entry.frontmatter.scope ?? 'project'
    const localMemories = scope === 'global'
      ? await memoryManager.listGlobalMemories()
      : scope === 'session'
        ? await memoryManager.listSessionMemories()
        : await memoryManager.listProjectMemories()

    const localEntry = localMemories.find(m => m.path === event.entry.path)

    if (localEntry && localEntry.mtimeMs > event.timestamp) {
      if (this.config.conflictResolution === 'last_write_wins') {
        return { localEntry, remoteEntry: event.entry, resolution: 'local' }
      }

      if (this.config.conflictResolution === 'merge') {
        const merged = this.mergeEntries(localEntry, event.entry)
        await memoryManager.saveMemoryFile(
          event.entry.path,
          event.entry.type,
          event.entry.description,
          merged,
          scope as MemoryScope,
        )
        return { localEntry, remoteEntry: event.entry, resolution: 'merged', mergedContent: merged }
      }

      return { localEntry, remoteEntry: event.entry, resolution: 'local' }
    }

    if (event.type !== 'delete') {
      await memoryManager.saveMemoryFile(
        event.entry.path,
        event.entry.type,
        event.entry.description,
        event.entry.content,
        scope as MemoryScope,
      )
    }

    return null
  }

  private mergeEntries(local: MemoryFile, remote: MemoryFile): string {
    return `${local.content}\n\n--- Merged from ${new Date(remote.mtimeMs).toISOString()} ---\n\n${remote.content}`
  }

  getPendingEventCount(): number {
    return this.pendingEvents.length
  }

  getLastSyncTime(): number {
    return this.lastSyncTime
  }

  shouldSync(): boolean {
    if (!this.config.enabled) return false
    if (this.pendingEvents.length === 0 && Date.now() - this.lastSyncTime < this.config.syncIntervalMs) {
      return false
    }
    return true
  }
}
