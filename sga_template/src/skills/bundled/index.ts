import { registerSkillifySkill } from './skillify.js'
import { registerRememberSkill } from './remember.js'
import { registerSimplifySkill } from './simplify.js'
import { registerDebugSkill } from './debug.js'
import { registerBatchSkill } from './batch.js'
import { registerVerifySkill } from './verify.js'
import { registerUpdateConfigSkill } from './update-config.js'
import { registerStuckSkill } from './stuck.js'
import { registerLoremIpsumSkill } from './lorem-ipsum.js'
import { registerClaudeApiSkill } from './claude-api.js'
import { registerMCPGeneratorSkill } from './mcp-generator.js'

export function initBundledSkills(): void {
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  registerDebugSkill()
  registerBatchSkill()
  registerVerifySkill()
  registerUpdateConfigSkill()
  registerStuckSkill()
  registerLoremIpsumSkill()
  registerClaudeApiSkill()
  registerMCPGeneratorSkill()
}
