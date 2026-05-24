import { createLogger } from '../utils/logger.js'

const logger = createLogger('feature-gate')

export interface FeatureGateConfig {
  name: string
  description: string
  defaultEnabled: boolean
  envVar?: string
  configPath?: string
}

const BUILTIN_GATES: FeatureGateConfig[] = [
  {
    name: 'adversarial_verification',
    description: 'Enable adversarial verification agent for post-implementation checks',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_ADVERSARIAL_VERIFICATION',
  },
  {
    name: 'advisor_agent',
    description: 'Enable advisor agent for reflective guidance during task execution',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_ADVISOR_AGENT',
  },
  {
    name: 'tool_retry',
    description: 'Enable automatic retry mechanism for failed tool calls',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_TOOL_RETRY',
  },
  {
    name: 'consecutive_failure_pivot',
    description: 'Enable automatic strategy pivot after consecutive failures',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_CONSECUTIVE_FAILURE_PIVOT',
  },
  {
    name: 'bash_fine_grained_permissions',
    description: 'Enable fine-grained Bash command classification for permissions',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_BASH_FINE_GRAINED',
  },
  {
    name: 'cache_breakpoints',
    description: 'Enable prompt cache breakpoints for Anthropic API calls',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_CACHE_BREAKPOINTS',
  },
  {
    name: 'telemetry',
    description: 'Enable telemetry event tracking',
    defaultEnabled: false,
    envVar: 'SGA_FEATURE_TELEMETRY',
  },
  {
    name: 'post_tool_use_failure_hooks',
    description: 'Enable PostToolUseFailure hook event type',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_POST_TOOL_FAILURE_HOOKS',
  },
  {
    name: 'error_classification',
    description: 'Enable error classification for better retry and reporting decisions',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_ERROR_CLASSIFICATION',
  },
  {
    name: 'parallel_explore',
    description: 'Enable parallel search strategy in Explore agent',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_PARALLEL_EXPLORE',
  },
  {
    name: 'plan_exit_mode',
    description: 'Enable PLAN_COMPLETE signal for transitioning from plan to implementation',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_PLAN_EXIT_MODE',
  },
  {
    name: 'mcp_instructions_in_prompt',
    description: 'Include MCP server instructions in system prompt',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_MCP_INSTRUCTIONS',
  },
  {
    name: 'skill_list_in_prompt',
    description: 'Include available skills list in system prompt',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_SKILL_LIST',
  },
  {
    name: 'auto_compact',
    description: 'Enable automatic context compaction when token usage approaches limits',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_AUTO_COMPACT',
  },
  {
    name: 'task_planning',
    description: 'Enable automatic task planning and decomposition for complex tasks',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_TASK_PLANNING',
  },
  {
    name: 'tool_batch_summary',
    description: 'Enable tool batch summary injection when multiple tools are called in one turn',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_TOOL_BATCH_SUMMARY',
  },
  {
    name: 'memory_extraction',
    description: 'Enable automatic memory extraction from conversation during agent loop',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_MEMORY_EXTRACTION',
  },
  {
    name: 'context_budget',
    description: 'Enable context budget allocation and enforcement for system prompt size',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_CONTEXT_BUDGET',
  },
  {
    name: 'provider_circuit_breaker',
    description: 'Enable circuit breaker pattern for provider API calls to handle consecutive failures',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_PROVIDER_CIRCUIT_BREAKER',
  },
  {
    name: 'cost_tracking',
    description: 'Enable cost tracking and budget enforcement during agent execution',
    defaultEnabled: true,
    envVar: 'SGA_FEATURE_COST_TRACKING',
  },
]

export class FeatureGateManager {
  private static instance: FeatureGateManager | null = null
  private gates: Map<string, FeatureGateConfig> = new Map()
  private overrides: Map<string, boolean> = new Map()

  private constructor() {
    for (const gate of BUILTIN_GATES) {
      this.gates.set(gate.name, gate)
    }
  }

  static getInstance(): FeatureGateManager {
    if (!FeatureGateManager.instance) {
      FeatureGateManager.instance = new FeatureGateManager()
    }
    return FeatureGateManager.instance
  }

  registerGate(config: FeatureGateConfig): void {
    this.gates.set(config.name, config)
  }

  isEnabled(gateName: string): boolean {
    if (this.overrides.has(gateName)) {
      return this.overrides.get(gateName)!
    }

    const gate = this.gates.get(gateName)
    if (!gate) {
      logger.warn(`Unknown feature gate: ${gateName}`)
      return false
    }

    if (gate.envVar) {
      const envValue = process.env[gate.envVar]
      if (envValue !== undefined) {
        return envValue === 'true' || envValue === '1'
      }
    }

    return gate.defaultEnabled
  }

  override(gateName: string, enabled: boolean): void {
    if (!this.gates.has(gateName)) {
      logger.warn(`Overriding unknown feature gate: ${gateName}`)
    }
    this.overrides.set(gateName, enabled)
  }

  clearOverride(gateName: string): void {
    this.overrides.delete(gateName)
  }

  clearAllOverrides(): void {
    this.overrides.clear()
  }

  listGates(): Array<{ name: string; description: string; enabled: boolean; source: string }> {
    const result: Array<{ name: string; description: string; enabled: boolean; source: string }> = []

    for (const [name, gate] of this.gates) {
      let source = 'default'
      if (this.overrides.has(name)) {
        source = 'override'
      } else if (gate.envVar && process.env[gate.envVar] !== undefined) {
        source = 'env'
      }

      result.push({
        name,
        description: gate.description,
        enabled: this.isEnabled(name),
        source,
      })
    }

    return result
  }

  static reset(): void {
    FeatureGateManager.instance = null
  }
}

export function isFeatureEnabled(gateName: string): boolean {
  return FeatureGateManager.getInstance().isEnabled(gateName)
}
