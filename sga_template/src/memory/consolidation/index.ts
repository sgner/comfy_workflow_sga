export { executeAutoDream, shouldConsolidate, DEFAULT_AUTO_DREAM_CONFIG } from './auto-dream.js'
export type { AutoDreamConfig, ConsolidationResult } from './auto-dream.js'
export { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock, recordConsolidation } from './consolidation-lock.js'
export { buildConsolidationPrompt, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from './consolidation-prompt.js'
