/**
 * Handoff 子模块入口
 *
 * 提供 AgentBackend 之间的记忆交接能力:
 * - types: 数据类型 (HandoffBundle, KeyFact)
 * - store: 读写 <SGA_HOME>/handoff/<sessionId>.json
 * - blackboard: 读写 <SGA_HOME>/shared/blackboard.json (持续共享热数据)
 * - extractor: 从 SGA memory manager 抽取 keyFacts
 */

export type { HandoffBundle, KeyFact } from '../backend.js'
export { HandoffStore, getHandoffStore, type HandoffStoreOptions } from './store.js'
export { Blackboard, getBlackboard, type BlackboardData } from './blackboard.js'
export { MemoryExtractor, getMemoryExtractor } from './extractor.js'
