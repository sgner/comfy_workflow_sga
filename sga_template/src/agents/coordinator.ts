import type { AgentDefinition } from './definition.js'
import type { UsageMetrics } from '../core/types.js'
import { createLogger } from '../utils/logger.js'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const logger = createLogger('coordinator')

export type CoordinatorPhase = 'research' | 'synthesis' | 'implementation' | 'verification'

export interface CoordinatorTask {
  id: string
  description: string
  phase: CoordinatorPhase
  agentType: string
  prompt: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result?: CoordinatorTaskResult
  error?: string
  dependsOn?: string[]
}

export interface CoordinatorTaskResult {
  content: string
  usage: UsageMetrics
  turnCount: number
  toolUseCount: number
  durationMs: number
}

export interface CoordinatorPlan {
  id: string
  query: string
  tasks: CoordinatorTaskStep[]
  strategy: 'parallel' | 'sequential' | 'hybrid'
  createdAt: number
  updatedAt: number
}

export interface CoordinatorTaskStep {
  id?: string
  description: string
  phase: CoordinatorPhase
  agentType: string
  prompt: string
  dependsOn?: string[]
}

export interface CoordinatorResult {
  plan: CoordinatorPlan
  tasks: CoordinatorTask[]
  synthesis: string
  totalUsage: UsageMetrics
  totalDurationMs: number
}

export interface CoordinatorConfig {
  maxConcurrency: number
  defaultModel: string
  agentDefinitions: AgentDefinition[]
  maxTurnsPerAgent?: number
  maxRetriesPerTask?: number
  snapshotDir?: string
}

export interface CoordinatorSnapshot {
  plan: CoordinatorPlan
  tasks: Array<{
    id: string
    description: string
    phase: CoordinatorPhase
    agentType: string
    prompt: string
    status: CoordinatorTask['status']
    result?: {
      content: string
      durationMs: number
      turnCount: number
      toolUseCount: number
    }
    error?: string
    dependsOn?: string[]
  }>
  totalUsage: UsageMetrics
  startedAt: number
  savedAt: number
}

export function getCoordinatorSystemPrompt(): string {
  return `You are a coordinator agent that orchestrates work across multiple sub-agents. Use the Agent tool to spawn workers, SendMessage to continue them, and TaskStop to stop them.`
}

export function listSnapshots(snapshotDir?: string): Array<{ planId: string; query: string; savedAt: number; pendingCount: number; path: string }> {
  const dir = snapshotDir ?? join(process.cwd(), '.sga', 'snapshots')
  if (!existsSync(dir)) return []

  const results: Array<{ planId: string; query: string; savedAt: number; pendingCount: number; path: string }> = []

  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'))

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const snapshot: CoordinatorSnapshot = JSON.parse(content)
        const pendingCount = snapshot.tasks.filter(t => t.status === 'pending').length
        results.push({
          planId: snapshot.plan.id,
          query: snapshot.plan.query,
          savedAt: snapshot.savedAt,
          pendingCount,
          path: join(dir, file),
        })
      } catch {
        // skip invalid snapshots
      }
    }
  } catch {
    // dir not accessible
  }

  return results.sort((a, b) => b.savedAt - a.savedAt)
}

export { CoordinatorAgent, getCoordinatorSystemPrompt as getCoordinatorAgentSystemPrompt } from './coordinator-mode.js'
