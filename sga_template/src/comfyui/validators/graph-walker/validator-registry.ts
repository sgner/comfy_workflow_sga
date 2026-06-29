/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 * Starts empty; later tasks append rules as they are implemented.
 */
import type { ValidationRule } from './rule.js'

export const RULES: ValidationRule[] = []
