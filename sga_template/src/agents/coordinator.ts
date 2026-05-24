import type { AgentDefinition } from '../agents/definition.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { Message, UsageMetrics } from '../core/types.js'
import type { LLMProvider, ProviderRequestOptions } from '../providers/types.js'
import { runAgent, type AgentRunResult } from '../agents/runner.js'
import { isForkRecursion } from './fork.js'
import { filterToolsForAgent } from '../tools/base.js'
import { ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS } from '../agents/definition.js'
import { createLogger } from '../utils/logger.js'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
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
  provider: LLMProvider
  tools: Tool[]
  agentDefinitions: AgentDefinition[]
  maxTurnsPerAgent?: number
  maxRetriesPerTask?: number
  snapshotDir?: string
  onTaskStart?: (task: CoordinatorTask) => void
  onTaskComplete?: (task: CoordinatorTask) => void
  onTaskFailed?: (task: CoordinatorTask) => void
  onPlanUpdated?: (plan: CoordinatorPlan) => void
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

const COORDINATOR_SYSTEM_PROMPT = `You are a coordinator agent that orchestrates work across multiple sub-agents.

## Your Role
- Break down complex tasks into sub-tasks
- Assign sub-tasks to specialized agents
- Synthesize results from multiple agents
- Report a unified answer to the user

## Workflow Phases
1. **Research**: Investigate the codebase, find files, understand the problem
2. **Synthesis**: Read findings, understand the problem, craft implementation specs
3. **Implementation**: Make targeted changes per spec
4. **Verification**: Test that changes work correctly

## Concurrency Guidelines
- Read-only tasks (research) can run in parallel
- Write-heavy tasks (implementation) should run sequentially per file set
- Verification can sometimes run alongside implementation on different areas

## Important Rules
- Every agent prompt must be self-contained with all necessary context
- Include file paths, line numbers, error messages in prompts
- State what "done" looks like for each task
- For research tasks: "Report findings — do not modify files"
- For implementation tasks: "Run relevant tests and commit changes"
- For verification tasks: "Prove the code works, don't just confirm it exists"`

const PLAN_GENERATION_SYSTEM_PROMPT = `You are a task planning assistant. Given a user query and a list of available specialized agents, your job is to create an optimal execution plan.

## Output Format
You MUST respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "strategy": "parallel" | "sequential" | "hybrid",
  "tasks": [
    {
      "description": "Short description of this step",
      "phase": "research" | "synthesis" | "implementation" | "verification",
      "agentType": "exact agent name from the list",
      "prompt": "Detailed, self-contained prompt for the agent. Include ALL context the agent needs.",
      "dependsOn": ["description of prerequisite task", ...]
    }
  ]
}

## Planning Rules
1. Choose the RIGHT agent for each step based on the agent's description and capabilities
2. Each prompt must be self-contained — the agent won't see previous steps' results unless you include them in the prompt
3. Use "dependsOn" to indicate which steps must complete before this one starts (reference by description)
4. For "hybrid" strategy: research/verification tasks can run in parallel; synthesis/implementation should be sequential
5. If a task needs results from a previous step, mention in the prompt: "Based on the previous step's results, ..."
6. Minimize the number of steps while ensuring quality
7. Always include a verification step for implementation tasks`

let taskCounter = 0

function generateCoordinatorTaskId(): string {
  taskCounter++
  return `coord-task-${Date.now()}-${taskCounter}`
}

function generatePlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class Coordinator {
  private config: CoordinatorConfig
  private tasks: Map<string, CoordinatorTask> = new Map()
  private plan: CoordinatorPlan | null = null
  private startedAt: number = 0

  constructor(config: CoordinatorConfig) {
    this.config = config
  }

  async execute(plan: CoordinatorPlan): Promise<CoordinatorResult> {
    this.plan = plan
    this.startedAt = Date.now()
    const totalUsage: UsageMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    }

    for (const step of plan.tasks) {
      const existingTask = step.id ? this.tasks.get(step.id) : undefined
      if (existingTask && existingTask.status !== 'pending') continue

      const task: CoordinatorTask = {
        id: step.id ?? generateCoordinatorTaskId(),
        description: step.description,
        phase: step.phase,
        agentType: step.agentType,
        prompt: step.prompt,
        status: 'pending',
        dependsOn: step.dependsOn,
      }
      this.tasks.set(task.id, task)
    }

    if (plan.strategy === 'parallel') {
      await this.executeParallel(totalUsage)
    } else if (plan.strategy === 'sequential') {
      await this.executeSequential(totalUsage)
    } else {
      await this.executeHybrid(totalUsage)
    }

    const completedTasks = [...this.tasks.values()]
    const synthesis = this.synthesizeResults(completedTasks)

    this.saveSnapshot(totalUsage)

    return {
      plan,
      tasks: completedTasks,
      synthesis,
      totalUsage,
      totalDurationMs: Date.now() - this.startedAt,
    }
  }

  async resumeFromSnapshot(snapshotPath: string): Promise<CoordinatorResult> {
    const snapshot = this.loadSnapshot(snapshotPath)
    if (!snapshot) {
      throw new Error(`Failed to load snapshot from ${snapshotPath}`)
    }

    this.plan = snapshot.plan
    this.startedAt = snapshot.startedAt
    this.tasks.clear()

    for (const t of snapshot.tasks) {
      const task: CoordinatorTask = {
        id: t.id,
        description: t.description,
        phase: t.phase,
        agentType: t.agentType,
        prompt: t.prompt,
        status: t.status,
        dependsOn: t.dependsOn,
      }
      if (t.result) {
        task.result = {
          content: t.result.content,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, totalCostUsd: 0 },
          turnCount: t.result.turnCount,
          toolUseCount: t.result.toolUseCount,
          durationMs: t.result.durationMs,
        }
      }
      if (t.error) task.error = t.error
      this.tasks.set(task.id, task)
    }

    const totalUsage: UsageMetrics = { ...snapshot.totalUsage }

    logger.info(`Resuming plan ${this.plan.id} with ${this.tasks.size} tasks, ${[...this.tasks.values()].filter(t => t.status === 'pending').length} pending`)

    if (this.plan.strategy === 'parallel') {
      await this.executeParallel(totalUsage)
    } else if (this.plan.strategy === 'sequential') {
      await this.executeSequential(totalUsage)
    } else {
      await this.executeHybrid(totalUsage)
    }

    const completedTasks = [...this.tasks.values()]
    const synthesis = this.synthesizeResults(completedTasks)

    this.saveSnapshot(totalUsage)

    return {
      plan: this.plan,
      tasks: completedTasks,
      synthesis,
      totalUsage,
      totalDurationMs: Date.now() - this.startedAt,
    }
  }

  addStep(step: CoordinatorTaskStep): CoordinatorTask {
    if (!this.plan) {
      throw new Error('No active plan. Call execute() first.')
    }

    const task: CoordinatorTask = {
      id: step.id ?? generateCoordinatorTaskId(),
      description: step.description,
      phase: step.phase,
      agentType: step.agentType,
      prompt: step.prompt,
      status: 'pending',
      dependsOn: step.dependsOn,
    }
    this.tasks.set(task.id, task)
    this.plan.tasks.push({ ...step, id: task.id })
    this.plan.updatedAt = Date.now()
    this.config.onPlanUpdated?.(this.plan)

    logger.info(`Added step to plan: ${task.description} (${task.phase}), agent=${task.agentType}`)
    return task
  }

  skipTask(taskId: string, reason?: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || (task.status !== 'pending' && task.status !== 'running')) return false

    task.status = 'skipped'
    if (reason) task.error = `Skipped: ${reason}`
    logger.info(`Skipped task ${taskId}: ${reason ?? 'no reason given'}`)
    return true
  }

  updateTaskPrompt(taskId: string, newPrompt: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'pending') return false

    task.prompt = newPrompt
    logger.info(`Updated prompt for task ${taskId}`)
    return true
  }

  getPlan(): CoordinatorPlan | null {
    return this.plan
  }

  getTask(taskId: string): CoordinatorTask | undefined {
    return this.tasks.get(taskId)
  }

  getAllTasks(): CoordinatorTask[] {
    return [...this.tasks.values()]
  }

  async executeSingleTask(
    description: string,
    phase: CoordinatorPhase,
    agentType: string,
    prompt: string,
    parentMessages?: Message[],
  ): Promise<CoordinatorTaskResult> {
    const agentDef = this.config.agentDefinitions.find(
      a => a.name === agentType || a.subagentType === agentType,
    )
    if (!agentDef) {
      throw new Error(`Unknown agent type: ${agentType}`)
    }

    if (parentMessages && isForkRecursion(parentMessages)) {
      throw new Error('Cannot run coordinator task from within a forked agent — fork and coordinator are mutually exclusive')
    }

    const tools = this.resolveAgentTools(agentDef)
    const model = this.inferModel(agentDef)

    logger.info(`Executing task: ${description}, agent=${agentType}, phase=${phase}`)

    const result = await runAgent({
      agentDefinition: agentDef,
      prompt,
      tools,
      model,
      provider: this.config.provider,
      maxTurns: this.config.maxTurnsPerAgent,
      agentDefinitions: this.config.agentDefinitions,
    })

    return {
      content: result.content,
      usage: result.usage,
      turnCount: result.turnCount,
      toolUseCount: result.totalToolUseCount,
      durationMs: result.totalDurationMs,
    }
  }

  async executeParallelTasks(
    tasks: Array<{
      description: string
      phase: CoordinatorPhase
      agentType: string
      prompt: string
    }>,
  ): Promise<CoordinatorTaskResult[]> {
    const maxConcurrency = this.config.maxConcurrency
    const results: CoordinatorTaskResult[] = []

    for (let i = 0; i < tasks.length; i += maxConcurrency) {
      const batch = tasks.slice(i, i + maxConcurrency)
      const batchResults = await Promise.all(
        batch.map(t => this.executeSingleTask(t.description, t.phase, t.agentType, t.prompt)),
      )
      results.push(...batchResults)
    }

    return results
  }

  private injectContextFromDependencies(task: CoordinatorTask): string {
    if (!task.dependsOn || task.dependsOn.length === 0) return task.prompt

    const completedDeps = [...this.tasks.values()].filter(
      t => task.dependsOn!.includes(t.description) && t.status === 'completed' && t.result,
    )

    if (completedDeps.length === 0) return task.prompt

    const contextParts: string[] = ['## Previous Step Results\n']
    for (const dep of completedDeps) {
      const contentPreview = dep.result!.content.length > 3000
        ? dep.result!.content.slice(0, 3000) + '\n... (truncated)'
        : dep.result!.content
      contextParts.push(`### ${dep.description} (${dep.phase})`)
      contextParts.push(contentPreview)
      contextParts.push('')
    }

    return contextParts.join('\n') + '\n---\n\n' + task.prompt
  }

  private async executeParallel(totalUsage: UsageMetrics): Promise<void> {
    const allTasks = [...this.tasks.values()]
    const pending = allTasks.filter(t => t.status === 'pending')

    const maxConcurrency = this.config.maxConcurrency

    for (let i = 0; i < pending.length; i += maxConcurrency) {
      const batch = pending.slice(i, i + maxConcurrency)
      await Promise.all(batch.map(task => this.runTask(task, totalUsage)))
    }
  }

  private async executeSequential(totalUsage: UsageMetrics): Promise<void> {
    const allTasks = [...this.tasks.values()]
    const pending = allTasks.filter(t => t.status === 'pending')

    for (const task of pending) {
      await this.runTask(task, totalUsage)
    }
  }

  private async executeHybrid(totalUsage: UsageMetrics): Promise<void> {
    const phases: CoordinatorPhase[] = ['research', 'synthesis', 'implementation', 'verification']

    for (const phase of phases) {
      const phaseTasks = [...this.tasks.values()].filter(t => t.phase === phase && t.status === 'pending')
      if (phaseTasks.length === 0) continue

      const maxConcurrency = phase === 'research' || phase === 'verification'
        ? this.config.maxConcurrency
        : 1

      for (let i = 0; i < phaseTasks.length; i += maxConcurrency) {
        const batch = phaseTasks.slice(i, i + maxConcurrency)
        await Promise.all(batch.map(task => this.runTask(task, totalUsage)))
      }

      this.saveSnapshot(totalUsage)
    }
  }

  private async runTask(task: CoordinatorTask, totalUsage: UsageMetrics): Promise<void> {
    task.status = 'running'
    this.config.onTaskStart?.(task)

    const maxRetries = this.config.maxRetriesPerTask ?? 1
    let lastError: string | undefined

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const enrichedPrompt = this.injectContextFromDependencies(task)

        const promptWithContext = attempt > 1
          ? `${enrichedPrompt}\n\n---\n**RETRY ATTEMPT ${attempt}/${maxRetries}**: This task failed previously with error: ${lastError}. Try a different approach. Do not repeat the same steps that led to the previous failure.`
          : enrichedPrompt

        const result = await this.executeSingleTask(
          task.description,
          task.phase,
          task.agentType,
          promptWithContext,
        )

        task.status = 'completed'
        task.result = result

        totalUsage.inputTokens += result.usage.inputTokens
        totalUsage.outputTokens += result.usage.outputTokens
        totalUsage.cacheReadInputTokens += result.usage.cacheReadInputTokens
        totalUsage.cacheCreationInputTokens += result.usage.cacheCreationInputTokens
        totalUsage.totalTokens += result.usage.totalTokens
        totalUsage.totalCostUsd += result.usage.totalCostUsd

        this.config.onTaskComplete?.(task)
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (attempt < maxRetries) {
          logger.warn(`Task ${task.id} attempt ${attempt}/${maxRetries} failed: ${lastError}. Retrying...`)
          task.status = 'running'
        }
      }
    }

    task.status = 'failed'
    task.error = lastError
    this.config.onTaskFailed?.(task)
    logger.error(`Task ${task.id} failed after ${maxRetries} attempt(s): ${task.error}`)
  }

  private synthesizeResults(tasks: CoordinatorTask[]): string {
    const completed = tasks.filter(t => t.status === 'completed' && t.result)
    const failed = tasks.filter(t => t.status === 'failed')
    const skipped = tasks.filter(t => t.status === 'skipped')

    const parts: string[] = []

    if (completed.length > 0) {
      parts.push('## Results\n')
      for (const task of completed) {
        parts.push(`### ${task.description} (${task.phase})`)
        parts.push(task.result!.content)
        parts.push('')
      }
    }

    if (failed.length > 0) {
      parts.push('## Failed Tasks\n')
      for (const task of failed) {
        parts.push(`- **${task.description}**: ${task.error}`)
      }
      parts.push('')
    }

    if (skipped.length > 0) {
      parts.push('## Skipped Tasks\n')
      for (const task of skipped) {
        parts.push(`- **${task.description}**: ${task.error ?? 'No reason'}`)
      }
      parts.push('')
    }

    return parts.join('\n')
  }

  private resolveAgentTools(agentDef: AgentDefinition): Tool[] {
    const disallowed = [
      ...agentDef.getDisallowedTools(),
      ...ALL_AGENT_DISALLOWED_TOOLS,
      ...CUSTOM_AGENT_DISALLOWED_TOOLS,
    ]
    return filterToolsForAgent(this.config.tools, agentDef.getAllowedTools(), disallowed, disallowed)
  }

  private inferModel(agentDef: AgentDefinition): string {
    const model = agentDef.getModel()
    if (model && model !== 'inherit') return model
    return this.config.defaultModel
  }

  private getSnapshotDir(): string {
    return this.config.snapshotDir ?? join(process.cwd(), '.sga', 'snapshots')
  }

  saveSnapshot(totalUsage: UsageMetrics): string {
    if (!this.plan) return ''

    const snapshotDir = this.getSnapshotDir()
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true })
    }

    const snapshot: CoordinatorSnapshot = {
      plan: this.plan,
      tasks: [...this.tasks.values()].map(t => ({
        id: t.id,
        description: t.description,
        phase: t.phase,
        agentType: t.agentType,
        prompt: t.prompt,
        status: t.status,
        result: t.result ? {
          content: t.result.content,
          durationMs: t.result.durationMs,
          turnCount: t.result.turnCount,
          toolUseCount: t.result.toolUseCount,
        } : undefined,
        error: t.error,
        dependsOn: t.dependsOn,
      })),
      totalUsage,
      startedAt: this.startedAt,
      savedAt: Date.now(),
    }

    const snapshotPath = join(snapshotDir, `${this.plan.id}.json`)
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    logger.info(`Saved snapshot to ${snapshotPath}`)
    return snapshotPath
  }

  loadSnapshot(snapshotPath: string): CoordinatorSnapshot | null {
    try {
      if (!existsSync(snapshotPath)) return null
      const content = readFileSync(snapshotPath, 'utf-8')
      return JSON.parse(content) as CoordinatorSnapshot
    } catch (error) {
      logger.error(`Failed to load snapshot from ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}

export function getCoordinatorSystemPrompt(): string {
  return COORDINATOR_SYSTEM_PROMPT
}

export function createCoordinatorPlanFromUserQuery(
  query: string,
  agentDefinitions: AgentDefinition[],
): CoordinatorPlan {
  const agents = agentDefinitions.map(a => a.name)
  const hasExplore = agents.includes('Explore')
  const hasPlan = agents.includes('Plan')
  const hasVerification = agents.includes('verification')
  const hasGeneral = agents.includes('general-purpose')

  const tasks: CoordinatorTaskStep[] = []

  if (hasExplore) {
    tasks.push({
      description: 'Research the codebase',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Investigate the following request and report your findings with specific file paths, line numbers, and relevant code snippets. Do not modify any files.\n\nRequest: ${query}`,
    })
  }

  if (hasPlan) {
    tasks.push({
      description: 'Design implementation plan',
      phase: 'synthesis',
      agentType: 'Plan',
      prompt: `Based on the research findings, design an implementation plan for the following request. Include specific steps, file paths, and code changes needed. Do not modify any files.\n\nRequest: ${query}`,
      dependsOn: hasExplore ? ['Research the codebase'] : undefined,
    })
  }

  if (hasGeneral) {
    tasks.push({
      description: 'Implement the solution',
      phase: 'implementation',
      agentType: 'general-purpose',
      prompt: `Implement the following request. Make the necessary code changes, run tests, and commit your work.\n\nRequest: ${query}`,
      dependsOn: hasPlan ? ['Design implementation plan'] : undefined,
    })
  }

  if (hasVerification) {
    tasks.push({
      description: 'Verify the implementation',
      phase: 'verification',
      agentType: 'verification',
      prompt: `Independently verify the implementation for the following request. Run tests, check edge cases, and produce a PASS/FAIL/PARTIAL verdict. Do not modify any files.\n\nRequest: ${query}`,
      dependsOn: ['Implement the solution'],
    })
  }

  if (tasks.length === 0 && agentDefinitions.length > 0) {
    tasks.push({
      description: 'Complete the task',
      phase: 'implementation',
      agentType: agentDefinitions[0].name,
      prompt: query,
    })
  }

  return {
    id: generatePlanId(),
    query,
    tasks,
    strategy: 'hybrid',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export async function generateDynamicPlan(
  query: string,
  agentDefinitions: AgentDefinition[],
  provider: LLMProvider,
  model?: string,
): Promise<CoordinatorPlan> {
  const resolvedModel = model ?? provider.config.defaultModel ?? 'sonnet'

  const agentList = agentDefinitions.map(a =>
    `- **${a.name}** (${a.subagentType}): ${a.description}${a.isBuiltIn() ? ' [built-in]' : ''}${a.isBackground() ? ' [background]' : ''}`
  ).join('\n')

  const userPrompt = `## User Query
${query}

## Available Agents
${agentList}

Create an execution plan that uses the most appropriate agents for this query. Each step's prompt should be detailed and self-contained.`

  try {
    const resolvedModelId = provider.resolveModel(resolvedModel)
    const modelConfig = provider.getModelConfig(resolvedModel)
    const maxTokens = modelConfig?.defaultMaxTokens ?? 4096

    const response = await provider.createMessage({
      model: resolvedModelId,
      messages: [
        { role: 'user', content: userPrompt },
      ],
      systemPrompt: PLAN_GENERATION_SYSTEM_PROMPT,
      maxTokens,
      temperature: 0.3,
      stream: false,
    })

    const textContent = response.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('')

    let jsonStr = textContent.trim()
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    const parsed = JSON.parse(jsonStr)

    const tasks: CoordinatorTaskStep[] = (parsed.tasks ?? []).map(
      (t: Record<string, unknown>, i: number) => ({
        id: `step-${i + 1}`,
        description: String(t.description ?? `Step ${i + 1}`),
        phase: validatePhase(t.phase),
        agentType: String(t.agentType ?? 'general-purpose'),
        prompt: String(t.prompt ?? query),
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : undefined,
      }),
    )

    if (tasks.length === 0) {
      logger.warn('LLM generated empty plan, falling back to static plan')
      return createCoordinatorPlanFromUserQuery(query, agentDefinitions)
    }

    const strategy = validateStrategy(parsed.strategy)

    return {
      id: generatePlanId(),
      query,
      tasks,
      strategy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  } catch (error) {
    logger.warn(`Dynamic plan generation failed: ${error instanceof Error ? error.message : String(error)}, falling back to static plan`)
    return createCoordinatorPlanFromUserQuery(query, agentDefinitions)
  }
}

function validatePhase(phase: unknown): CoordinatorPhase {
  const valid: CoordinatorPhase[] = ['research', 'synthesis', 'implementation', 'verification']
  if (typeof phase === 'string' && valid.includes(phase as CoordinatorPhase)) {
    return phase as CoordinatorPhase
  }
  return 'implementation'
}

function validateStrategy(strategy: unknown): 'parallel' | 'sequential' | 'hybrid' {
  const valid = ['parallel', 'sequential', 'hybrid']
  if (typeof strategy === 'string' && valid.includes(strategy)) {
    return strategy as 'parallel' | 'sequential' | 'hybrid'
  }
  return 'hybrid'
}

export function listSnapshots(snapshotDir?: string): Array<{ planId: string; query: string; savedAt: number; pendingCount: number; path: string }> {
  const dir = snapshotDir ?? join(process.cwd(), '.sga', 'snapshots')
  if (!existsSync(dir)) return []

  const results: Array<{ planId: string; query: string; savedAt: number; pendingCount: number; path: string }> = []

  try {
    const { readdirSync } = require('fs')
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
