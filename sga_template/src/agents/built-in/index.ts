import { BaseAgentDefinition } from '../definition.js'

export class GeneralPurposeAgent extends BaseAgentDefinition {
  constructor() {
    super({
      name: 'general-purpose',
      description: 'A versatile agent for complex multi-step tasks requiring full tool access',
      subagentType: 'general-purpose',
      systemPrompt: `You are a general-purpose agent with access to all available tools.
Complete the task assigned to you thoroughly and accurately.
Use any tool at your disposal to accomplish the task.
Report your findings clearly and concisely when done.`,
      allowedTools: ['*'],
      disallowedTools: [],
    })
  }
}

export class ExploreAgent extends BaseAgentDefinition {
  constructor() {
    super({
      name: 'Explore',
      description: 'A read-only agent for quickly searching files and answering codebase questions',
      subagentType: 'Explore',
      systemPrompt: `You are an exploration agent focused on searching and reading code.
Your job is to quickly find relevant files, search for patterns, and answer questions about the codebase.
You MUST NOT modify any files. Only use read-only tools.
Be concise and focused in your responses.`,
      allowedTools: ['Glob', 'Grep', 'Read', 'Bash'],
      model: 'haiku',
    })
  }

  isReadOnly(): boolean {
    return true
  }
}

export class PlanAgent extends BaseAgentDefinition {
  constructor() {
    super({
      name: 'Plan',
      description: 'An agent for designing implementation plans and analyzing architecture',
      subagentType: 'Plan',
      systemPrompt: `You are a planning agent focused on designing implementation strategies.
Analyze the codebase, identify key files and dependencies, and produce structured plans.
You MUST NOT modify any files. Only use read-only tools.
Output structured plans with clear steps, key files, and dependency analysis.`,
      allowedTools: ['Glob', 'Grep', 'Read', 'Bash'],
    })
  }

  isReadOnly(): boolean {
    return true
  }
}

export class VerificationAgent extends BaseAgentDefinition {
  constructor() {
    super({
      name: 'verification',
      description: 'An agent for independently verifying implementations and running tests',
      subagentType: 'verification',
      systemPrompt: `You are a verification agent. Your job is to independently verify whether an implementation is correct.
Run tests, check edge cases, and produce a PASS/FAIL/PARTIAL verdict.
You MUST NOT modify any files. Only use read-only tools.
Your final output must include a clear verdict: PASS, FAIL, or PARTIAL.`,
      allowedTools: ['Glob', 'Grep', 'Read', 'Bash'],
      background: true,
    })
  }

  isReadOnly(): boolean {
    return true
  }
}
