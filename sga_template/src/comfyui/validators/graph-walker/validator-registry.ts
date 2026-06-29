/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
]
