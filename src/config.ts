function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase()
  if (!raw) return fallback
  return raw === 'true' || raw === '1'
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export interface CompactEnvConfig {
  microEnabled: boolean
  microGapThresholdMinutes: number
  microKeepRecent: number
  microMaxToolResultTokens: number

  smMinTokens: number
  smMinTextBlockMessages: number
  smMaxTokens: number
  smMaxSessionMemoryTokens: number

  fullEnabled: boolean
  fullMaxOutputTokens: number
  fullMaxPTLRetries: number
  fullBufferTokens: number
  fullWarningThresholdTokens: number
  fullMaxConsecutiveFailures: number

  modelMaxTokens: number
  preferSessionMemory: boolean
}

export interface ConsolidationEnvConfig {
  enabled: boolean
  minHours: number
  minSessions: number
  maxOutputTokens: number
  model: string
  lockStaleMs: number
  scanIntervalMs: number
}

export interface BudgetEnvConfig {
  maxContextTokens: number
  reservedForSystem: number
  reservedForConversation: number
  reservedForTools: number
  memoryBudgetRatio: number
  workingSetBudgetRatio: number
  compressionThreshold: number
}

export interface WorkingSetEnvConfig {
  maxAnchors: number
  anchorFadeMs: number
  anchorExpireMs: number
  maxAnchorTokens: number
  autoPinThreshold: number
  summaryOnFade: boolean
}

export interface PostCompactEnvConfig {
  maxFilesToRestore: number
  tokenBudget: number
  maxTokensPerFile: number
  maxTokensPerSkill: number
  skillsTokenBudget: number
}

export interface CircuitBreakerEnvConfig {
  compactMaxFailures: number
  compactCooldownMs: number
  compactHalfOpenAttempts: number
  consolidationMaxFailures: number
  consolidationCooldownMs: number
  consolidationHalfOpenAttempts: number
}

export interface ToolSummaryEnvConfig {
  enabled: boolean
  model: string
  maxInputLength: number
  maxOutputLength: number
  maxSummaryLength: number
}

export interface TeamSyncEnvConfig {
  enabled: boolean
  syncIntervalMs: number
  maxEntriesPerSync: number
  conflictResolution: 'last_write_wins' | 'merge' | 'manual'
}

export interface ThinkingEffortEnvConfig {
  defaultEffort: 'low' | 'medium' | 'high' | 'max'
  budgetLow: number
  budgetMedium: number
  budgetHigh: number
  budgetMax: number
  promptInjectionEnabled: boolean
  chainOfThoughtEnabled: boolean
}

export interface SgaEnvConfig {
  compact: CompactEnvConfig
  consolidation: ConsolidationEnvConfig
  budget: BudgetEnvConfig
  workingSet: WorkingSetEnvConfig
  postCompact: PostCompactEnvConfig
  circuitBreaker: CircuitBreakerEnvConfig
  toolSummary: ToolSummaryEnvConfig
  teamSync: TeamSyncEnvConfig
  thinkingEffort: ThinkingEffortEnvConfig
}

export function loadSgaConfig(): SgaEnvConfig {
  return {
    compact: {
      microEnabled: envBool('SGA_COMPACT_MICRO_ENABLED', true),
      microGapThresholdMinutes: envInt('SGA_COMPACT_MICRO_GAP_MINUTES', 10),
      microKeepRecent: envInt('SGA_COMPACT_MICRO_KEEP_RECENT', 3),
      microMaxToolResultTokens: envInt('SGA_COMPACT_MICRO_MAX_TOOL_RESULT_TOKENS', 50_000),

      smMinTokens: envInt('SGA_COMPACT_SM_MIN_TOKENS', 10_000),
      smMinTextBlockMessages: envInt('SGA_COMPACT_SM_MIN_TEXT_BLOCK_MESSAGES', 5),
      smMaxTokens: envInt('SGA_COMPACT_SM_MAX_TOKENS', 40_000),
      smMaxSessionMemoryTokens: envInt('SGA_COMPACT_SM_MAX_SESSION_MEMORY_TOKENS', 30_000),

      fullEnabled: envBool('SGA_COMPACT_FULL_ENABLED', true),
      fullMaxOutputTokens: envInt('SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS', 20_000),
      fullMaxPTLRetries: envInt('SGA_COMPACT_FULL_MAX_PTL_RETRIES', 3),
      fullBufferTokens: envInt('SGA_COMPACT_FULL_BUFFER_TOKENS', 13_000),
      fullWarningThresholdTokens: envInt('SGA_COMPACT_FULL_WARNING_THRESHOLD_TOKENS', 20_000),
      fullMaxConsecutiveFailures: envInt('SGA_COMPACT_FULL_MAX_CONSECUTIVE_FAILURES', 3),

      modelMaxTokens: envInt('SGA_MODEL_MAX_TOKENS', 200_000),
      preferSessionMemory: envBool('SGA_COMPACT_PREFER_SESSION_MEMORY', true),
    },

    consolidation: {
      enabled: envBool('SGA_CONSOLIDATION_ENABLED', true),
      minHours: envInt('SGA_CONSOLIDATION_MIN_HOURS', 24),
      minSessions: envInt('SGA_CONSOLIDATION_MIN_SESSIONS', 5),
      maxOutputTokens: envInt('SGA_CONSOLIDATION_MAX_OUTPUT_TOKENS', 16_000),
      model: envStr('SGA_CONSOLIDATION_MODEL', 'haiku'),
      lockStaleMs: envInt('SGA_CONSOLIDATION_LOCK_STALE_MS', 60 * 60 * 1000),
      scanIntervalMs: envInt('SGA_CONSOLIDATION_SCAN_INTERVAL_MS', 10 * 60 * 1000),
    },

    budget: {
      maxContextTokens: envInt('SGA_BUDGET_MAX_CONTEXT_TOKENS', 200_000),
      reservedForSystem: envInt('SGA_BUDGET_RESERVED_SYSTEM_TOKENS', 4_000),
      reservedForConversation: envInt('SGA_BUDGET_RESERVED_CONVERSATION_TOKENS', 50_000),
      reservedForTools: envInt('SGA_BUDGET_RESERVED_TOOLS_TOKENS', 10_000),
      memoryBudgetRatio: envFloat('SGA_BUDGET_MEMORY_RATIO', 0.25),
      workingSetBudgetRatio: envFloat('SGA_BUDGET_WORKING_SET_RATIO', 0.15),
      compressionThreshold: envFloat('SGA_BUDGET_COMPRESSION_THRESHOLD', 0.85),
    },

    workingSet: {
      maxAnchors: envInt('SGA_WORKING_SET_MAX_ANCHORS', 5),
      anchorFadeMs: envInt('SGA_WORKING_SET_ANCHOR_FADE_MS', 5 * 60 * 1000),
      anchorExpireMs: envInt('SGA_WORKING_SET_ANCHOR_EXPIRE_MS', 15 * 60 * 1000),
      maxAnchorTokens: envInt('SGA_WORKING_SET_MAX_ANCHOR_TOKENS', 8_000),
      autoPinThreshold: envInt('SGA_WORKING_SET_AUTO_PIN_THRESHOLD', 3),
      summaryOnFade: envBool('SGA_WORKING_SET_SUMMARY_ON_FADE', true),
    },

    postCompact: {
      maxFilesToRestore: envInt('SGA_POST_COMPACT_MAX_FILES', 5),
      tokenBudget: envInt('SGA_POST_COMPACT_TOKEN_BUDGET', 50_000),
      maxTokensPerFile: envInt('SGA_POST_COMPACT_MAX_TOKENS_PER_FILE', 5_000),
      maxTokensPerSkill: envInt('SGA_POST_COMPACT_MAX_TOKENS_PER_SKILL', 5_000),
      skillsTokenBudget: envInt('SGA_POST_COMPACT_SKILLS_TOKEN_BUDGET', 25_000),
    },

    circuitBreaker: {
      compactMaxFailures: envInt('SGA_CB_COMPACT_MAX_FAILURES', 3),
      compactCooldownMs: envInt('SGA_CB_COMPACT_COOLDOWN_MS', 5 * 60 * 1000),
      compactHalfOpenAttempts: envInt('SGA_CB_COMPACT_HALF_OPEN_ATTEMPTS', 1),
      consolidationMaxFailures: envInt('SGA_CB_CONSOLIDATION_MAX_FAILURES', 2),
      consolidationCooldownMs: envInt('SGA_CB_CONSOLIDATION_COOLDOWN_MS', 30 * 60 * 1000),
      consolidationHalfOpenAttempts: envInt('SGA_CB_CONSOLIDATION_HALF_OPEN_ATTEMPTS', 1),
    },

    toolSummary: {
      enabled: envBool('SGA_TOOL_SUMMARY_ENABLED', true),
      model: envStr('SGA_TOOL_SUMMARY_MODEL', 'haiku'),
      maxInputLength: envInt('SGA_TOOL_SUMMARY_MAX_INPUT_LENGTH', 300),
      maxOutputLength: envInt('SGA_TOOL_SUMMARY_MAX_OUTPUT_LENGTH', 300),
      maxSummaryLength: envInt('SGA_TOOL_SUMMARY_MAX_SUMMARY_LENGTH', 60),
    },

    teamSync: {
      enabled: envBool('SGA_TEAM_SYNC_ENABLED', true),
      syncIntervalMs: envInt('SGA_TEAM_SYNC_INTERVAL_MS', 30_000),
      maxEntriesPerSync: envInt('SGA_TEAM_SYNC_MAX_ENTRIES', 50),
      conflictResolution: envStr('SGA_TEAM_SYNC_CONFLICT_RESOLUTION', 'last_write_wins') as 'last_write_wins' | 'merge' | 'manual',
    },

    thinkingEffort: {
      defaultEffort: envStr('SGA_THINKING_EFFORT_DEFAULT', 'medium') as 'low' | 'medium' | 'high' | 'max',
      budgetLow: envInt('SGA_THINKING_EFFORT_BUDGET_LOW', 2_000),
      budgetMedium: envInt('SGA_THINKING_EFFORT_BUDGET_MEDIUM', 10_000),
      budgetHigh: envInt('SGA_THINKING_EFFORT_BUDGET_HIGH', 20_000),
      budgetMax: envInt('SGA_THINKING_EFFORT_BUDGET_MAX', 32_000),
      promptInjectionEnabled: envBool('SGA_THINKING_EFFORT_PROMPT_INJECTION', true),
      chainOfThoughtEnabled: envBool('SGA_THINKING_EFFORT_COT', true),
    },
  }
}

let _config: SgaEnvConfig | null = null

export function getSgaConfig(): SgaEnvConfig {
  if (!_config) {
    _config = loadSgaConfig()
  }
  return _config
}

export function resetSgaConfig(): void {
  _config = null
}
