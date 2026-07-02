/**
 * Rule registry — all 11 validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'
import { rerouteUnconnectedRule } from './rules/reroute-unconnected.js'
import { orphanedAuxRule } from './rules/orphaned-aux.js'
import { deepRerouteChainRule } from './rules/deep-reroute-chain.js'
import { missingModelRule } from './rules/missing-model.js'
import { missingMediaRule } from './rules/missing-media.js'
import { portTypeRule } from './rules/port-type.js'
import { primitiveMultiTypeRule } from './rules/primitive-multi-type.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
  missingModelRule,
  missingMediaRule,
  portTypeRule,
  primitiveMultiTypeRule,
]
