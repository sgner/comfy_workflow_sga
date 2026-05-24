import type { Tool, ToolUseContext, ValidationResult, ToolInputSchema, PermissionResult } from '../base.js'
import type { AgentDefinition } from '../../agents/definition.js'
import type { Message, UsageMetrics } from '../../core/types.js'
import { BaseTool } from '../base.js'
import { filterToolsForAgent, findToolByName } from '../base.js'
import { ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS } from '../../agents/definition.js'
import { runAgent, type AgentRunResult } from '../../agents/runner.js'
import { createSubagentContext, FORK_BOILERPLATE, isForkRecursion } from '../../agents/fork.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('agent-tool')

export type AgentSpawnMode = 'sync' | 'async' | 'fork'

export interface AgentToolInput {
  description: string
  prompt: string
  subagent_type?: string
  model?: string
  run_in_background?: boolean
  mode?: AgentSpawnMode
}

export interface AgentToolOutput {
  status: 'completed' | 'failed' | 'running'
  agentType: string
  content: string
  usage?: UsageMetrics
  turnCount?: number
  toolUseCount?: number
  durationMs?: number
  taskId?: string
  error?: string
}

interface RunningAgentTask {
  id: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  abortController: AbortController
  result?: AgentToolOutput
  resolve?: (result: AgentToolOutput) => void
  reject?: (error: Error) => void
}

const runningTasks: Map<string, RunningAgentTask> = new Map()

let taskCounter = 0

function generateTaskId(): string {
  taskCounter++
  return `agent-task-${Date.now()}-${taskCounter}`
}

export class AgentTool extends BaseTool<Record<string, unknown>, unknown> {
  name = 'Agent'
  description = 'Launch a sub-agent to perform a task. Supports synchronous (wait for result), asynchronous (background), and fork (isolated context) modes.'
  searchHint = 'delegate subagent spawn worker'

  private agentDefinitions: AgentDefinition[]

  constructor(agentDefinitions: AgentDefinition[]) {
    super()
    this.agentDefinitions = agentDefinitions
  }

  setAgentDefinitions(definitions: AgentDefinition[]): void {
    this.agentDefinitions = definitions
  }

  isEnabled(): boolean {
    return true
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return false
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' }
    }
    const obj = input as Record<string, unknown>
    if (!obj['prompt'] || typeof obj['prompt'] !== 'string') {
      return { success: false, error: 'prompt is required and must be a string' }
    }
    if (!obj['description'] || typeof obj['description'] !== 'string') {
      return { success: false, error: 'description is required and must be a string' }
    }
    return { success: true }
  }

  async checkPermissions(_input: Record<string, unknown>, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the task' },
        prompt: { type: 'string', description: 'The task for the agent to perform' },
        subagent_type: { type: 'string', description: 'The type of specialized agent to use' },
        model: { type: 'string', description: 'Optional model override (sonnet, opus, haiku)' },
        run_in_background: { type: 'boolean', description: 'Set to true to run in background' },
        mode: { type: 'string', enum: ['sync', 'async', 'fork'], description: 'Spawn mode: sync (wait), async (background), fork (isolated)' },
      },
      required: ['description', 'prompt'],
    }
  }

  async call(input: Record<string, unknown>, context: ToolUseContext): Promise<unknown> {
    const agentInput = input as unknown as AgentToolInput
    const {
      description,
      prompt,
      subagent_type,
      model: modelParam,
      run_in_background,
      mode: modeParam,
    } = agentInput

    const agentDef = this.resolveAgentDefinition(subagent_type)
    if (!agentDef) {
      return {
        status: 'failed',
        agentType: subagent_type ?? 'unknown',
        content: '',
        error: `Unknown agent type: "${subagent_type}". Available agents: ${this.agentDefinitions.map(a => a.name).join(', ')}`,
      }
    }

    if (context.messages && isForkRecursion(context.messages)) {
      return {
        status: 'failed',
        agentType: agentDef.name,
        content: '',
        error: 'Cannot spawn sub-agent from within a forked agent — recursive forking is not allowed',
      }
    }

    const spawnMode = this.resolveSpawnMode(modeParam, run_in_background, agentDef)

    const agentTools = this.resolveAgentTools(agentDef, context.tools)

    const resolvedModel = modelParam ?? this.inferModel(agentDef) ?? 'sonnet'

    const provider = this.getProviderFromContext(context)

    logger.info(`Spawning agent: type=${agentDef.name}, mode=${spawnMode}, model=${resolvedModel}`)

    if (spawnMode === 'async') {
      return this.spawnAsync(agentDef, prompt, agentTools, resolvedModel, provider, context, description)
    }

    if (spawnMode === 'fork') {
      return this.spawnFork(agentDef, prompt, agentTools, resolvedModel, provider, context, description)
    }

    return this.spawnSync(agentDef, prompt, agentTools, resolvedModel, provider, context, description)
  }

  private resolveAgentDefinition(subagentType?: string): AgentDefinition | undefined {
    if (!subagentType) {
      return this.agentDefinitions.find(a => a.name === 'general-purpose') ?? this.agentDefinitions[0]
    }
    return this.agentDefinitions.find(
      a => a.name === subagentType || a.subagentType === subagentType,
    )
  }

  private resolveSpawnMode(
    modeParam?: AgentSpawnMode,
    runInBackground?: boolean,
    agentDef?: AgentDefinition,
  ): AgentSpawnMode {
    if (modeParam) return modeParam
    if (runInBackground === true) return 'async'
    if (agentDef?.isBackground()) return 'async'
    return 'sync'
  }

  private resolveAgentTools(agentDef: AgentDefinition, availableTools: Tool[]): Tool[] {
    const disallowed = [
      ...agentDef.getDisallowedTools(),
      ...ALL_AGENT_DISALLOWED_TOOLS,
      ...CUSTOM_AGENT_DISALLOWED_TOOLS,
    ]
    return filterToolsForAgent(availableTools, agentDef.getAllowedTools(), disallowed, disallowed)
  }

  private inferModel(agentDef: AgentDefinition): string | undefined {
    const model = agentDef.getModel()
    if (model && model !== 'inherit') return model
    return undefined
  }

  private getProviderFromContext(context: ToolUseContext): unknown {
    const appState = context.getAppState()
    return (appState as Record<string, unknown>)['provider'] ?? null
  }

  private async spawnSync(
    agentDef: AgentDefinition,
    prompt: string,
    tools: Tool[],
    model: string,
    provider: unknown,
    context: ToolUseContext,
    description: string,
  ): Promise<AgentToolOutput> {
    const startTime = Date.now()

    try {
      const result = await this.executeAgent(agentDef, prompt, tools, model, provider, context)

      return {
        status: 'completed',
        agentType: agentDef.name,
        content: result.content,
        usage: result.usage,
        turnCount: result.turnCount,
        toolUseCount: result.totalToolUseCount,
        durationMs: Date.now() - startTime,
      }
    } catch (error) {
      logger.error(`Sync agent ${agentDef.name} failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: 'failed',
        agentType: agentDef.name,
        content: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      }
    }
  }

  private spawnAsync(
    agentDef: AgentDefinition,
    prompt: string,
    tools: Tool[],
    model: string,
    provider: unknown,
    context: ToolUseContext,
    description: string,
  ): AgentToolOutput {
    const taskId = generateTaskId()
    const abortController = new AbortController()

    const task: RunningAgentTask = {
      id: taskId,
      agentType: agentDef.name,
      description,
      status: 'running',
      startTime: Date.now(),
      abortController,
    }

    runningTasks.set(taskId, task)

    const agentPromise = this.executeAgent(agentDef, prompt, tools, model, provider, context, abortController.signal)

    agentPromise
      .then(result => {
        task.status = 'completed'
        task.result = {
          status: 'completed',
          agentType: agentDef.name,
          content: result.content,
          usage: result.usage,
          turnCount: result.turnCount,
          toolUseCount: result.totalToolUseCount,
          durationMs: Date.now() - task.startTime,
        }
        task.resolve?.(task.result)
      })
      .catch(error => {
        task.status = 'failed'
        task.result = {
          status: 'failed',
          agentType: agentDef.name,
          content: '',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - task.startTime,
        }
        task.reject?.(error)
      })

    return {
      status: 'running',
      agentType: agentDef.name,
      content: `Agent "${agentDef.name}" started in background. Task ID: ${taskId}`,
      taskId,
    }
  }

  private async spawnFork(
    agentDef: AgentDefinition,
    prompt: string,
    tools: Tool[],
    model: string,
    provider: unknown,
    context: ToolUseContext,
    description: string,
  ): Promise<AgentToolOutput> {
    const startTime = Date.now()

    const forkedSystemPrompt = `${await agentDef.getSystemPrompt({ toolUseContext: context })}\n\n${FORK_BOILERPLATE}`

    const forkedContext = createSubagentContext(context, {
      tools,
      agentId: `fork-${Date.now()}`,
      agentType: agentDef.name,
    })

    try {
      const result = await this.executeAgent(
        agentDef,
        prompt,
        tools,
        model,
        provider,
        forkedContext,
      )

      return {
        status: 'completed',
        agentType: agentDef.name,
        content: result.content,
        usage: result.usage,
        turnCount: result.turnCount,
        toolUseCount: result.totalToolUseCount,
        durationMs: Date.now() - startTime,
      }
    } catch (error) {
      logger.error(`Fork agent ${agentDef.name} failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: 'failed',
        agentType: agentDef.name,
        content: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      }
    }
  }

  private async executeAgent(
    agentDef: AgentDefinition,
    prompt: string,
    tools: Tool[],
    model: string,
    provider: unknown,
    context: ToolUseContext,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    if (provider && typeof provider === 'object' && 'createMessage' in provider) {
      return runAgent({
        agentDefinition: agentDef,
        prompt,
        tools,
        model,
        provider: provider as import('../../providers/types.js').LLMProvider,
        signal,
        parentContext: context,
      })
    }

    throw new Error('No LLM provider available in context. Ensure the provider is set in the app state.')
  }
}

export function getRunningTask(taskId: string): RunningAgentTask | undefined {
  return runningTasks.get(taskId)
}

export function getAllRunningTasks(): RunningAgentTask[] {
  return [...runningTasks.values()]
}

export function killRunningTask(taskId: string): boolean {
  const task = runningTasks.get(taskId)
  if (!task || task.status !== 'running') return false
  task.abortController.abort()
  task.status = 'killed'
  return true
}

export function waitForTask(taskId: string): Promise<AgentToolOutput> {
  const task = runningTasks.get(taskId)
  if (!task) return Promise.reject(new Error(`Task ${taskId} not found`))
  if (task.status === 'completed' && task.result) return Promise.resolve(task.result)
  if (task.status === 'failed' && task.result) return Promise.resolve(task.result)

  return new Promise<AgentToolOutput>((resolve, reject) => {
    task.resolve = resolve
    task.reject = reject
  })
}

export function cleanupCompletedTasks(maxAge: number = 60 * 60 * 1000): void {
  const now = Date.now()
  for (const [id, task] of runningTasks) {
    if (task.status !== 'running' && now - task.startTime > maxAge) {
      runningTasks.delete(id)
    }
  }
}
