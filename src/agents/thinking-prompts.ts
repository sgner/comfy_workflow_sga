import type { ThinkingEffort } from '../core/types.js'
import { getSgaConfig } from '../config.js'

export const THINKING_EFFORT_PROMPTS: Record<ThinkingEffort, string> = {
  low: `Respond concisely and directly. Skip unnecessary explanations. Prioritize speed over thoroughness.`,

  medium: `Think carefully before responding. Briefly consider the key aspects of the question, then provide a well-structured answer. Balance brevity with completeness.`,

  high: `Before responding, engage in thorough analysis:
1. Deconstruct the problem into its core components
2. Consider multiple possible approaches
3. Evaluate the trade-offs of each approach
4. Select the best approach and explain your reasoning
Show your analytical process in your response.`,

  max: `Before responding, conduct exhaustive deep analysis:
1. Deconstruct the problem into all its dimensions and sub-problems
2. Generate multiple hypotheses and potential solutions
3. For each hypothesis, gather supporting and contradicting evidence
4. Perform step-by-step logical deduction, checking for fallacies
5. Consider edge cases, boundary conditions, and potential failure modes
6. Reflect on your reasoning process itself — identify any gaps or biases
7. Synthesize all analysis into a comprehensive, well-reasoned conclusion
Document your complete reasoning chain in detail. Do not skip any steps.`,
}

export const THINKING_EFFORT_COT_PROMPTS: Record<ThinkingEffort, string> = {
  low: '',

  medium: `Before answering, briefly think through the key points:
<thinking>
Briefly analyze the core question and key considerations
</thinking>`,

  high: `Before answering, analyze systematically:
<thinking>
1. Problem understanding: What is the core question?
2. Knowledge retrieval: What relevant knowledge is needed?
3. Solution generation: What are the possible approaches?
4. Evaluation: Which approach is optimal and why?
5. Verification: Is the answer reasonable and complete?
</thinking>`,

  max: `Before answering, perform deep analysis:
<thinking>
1. Problem deconstruction: Break the problem into sub-problems
2. Hypothesis generation: Propose multiple hypotheses
3. Evidence collection: Find supporting and contradicting evidence for each
4. Reasoning: Step-by-step causal deduction
5. Self-reflection: Check reasoning for gaps or biases
6. Synthesis: Integrate all analysis into a final conclusion
</thinking>
Show your complete reasoning process.`,
}

export function getEffortPrompt(
  effort: ThinkingEffort,
  useChainOfThought: boolean = false,
): string {
  if (useChainOfThought) {
    return THINKING_EFFORT_COT_PROMPTS[effort]
  }
  return THINKING_EFFORT_PROMPTS[effort]
}

export function getThinkingBudgetMap(): Record<ThinkingEffort, number> {
  const cfg = getSgaConfig().thinkingEffort
  return {
    low: cfg.budgetLow,
    medium: cfg.budgetMedium,
    high: cfg.budgetHigh,
    max: cfg.budgetMax,
  }
}

export const OPENAI_REASONING_EFFORT_MAP: Record<ThinkingEffort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
}

export function resolveThinkingStrategy(
  effort: ThinkingEffort | undefined,
  supportsNativeThinking: boolean,
  supportsReasoningEffort: boolean,
): {
  nativeThinking: boolean
  nativeReasoningEffort: boolean
  promptInjection: boolean
  thinkingBudget: number | undefined
  reasoningEffort: 'low' | 'medium' | 'high' | undefined
  promptSuffix: string
} {
  const cfg = getSgaConfig().thinkingEffort
  const resolvedEffort = effort ?? cfg.defaultEffort
  const budgetMap = getThinkingBudgetMap()

  if (supportsNativeThinking) {
    return {
      nativeThinking: true,
      nativeReasoningEffort: false,
      promptInjection: false,
      thinkingBudget: budgetMap[resolvedEffort],
      reasoningEffort: undefined,
      promptSuffix: '',
    }
  }

  if (supportsReasoningEffort) {
    return {
      nativeThinking: false,
      nativeReasoningEffort: true,
      promptInjection: false,
      thinkingBudget: undefined,
      reasoningEffort: OPENAI_REASONING_EFFORT_MAP[resolvedEffort],
      promptSuffix: '',
    }
  }

  if (!cfg.promptInjectionEnabled) {
    return {
      nativeThinking: false,
      nativeReasoningEffort: false,
      promptInjection: false,
      thinkingBudget: undefined,
      reasoningEffort: undefined,
      promptSuffix: '',
    }
  }

  const useCot = cfg.chainOfThoughtEnabled && (resolvedEffort === 'high' || resolvedEffort === 'max')

  return {
    nativeThinking: false,
    nativeReasoningEffort: false,
    promptInjection: true,
    thinkingBudget: undefined,
    reasoningEffort: undefined,
    promptSuffix: getEffortPrompt(resolvedEffort, useCot),
  }
}
