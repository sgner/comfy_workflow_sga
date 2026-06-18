import type { CoordinatorPlan, CoordinatorTaskStep } from '../agents/coordinator.js'
import type { AgentDefinition } from '../agents/definition.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('coordinator-plans')

type ComfyUITaskType = 'workflow-creation' | 'workflow-debug' | 'workflow-optimize' | 'model-search' | 'general'

interface TaskIntent {
  type: ComfyUITaskType
  confidence: number
  keywords: string[]
}

const INTENT_PATTERNS: Array<{ type: ComfyUITaskType; patterns: RegExp[] }> = [
  {
    type: 'workflow-creation',
    patterns: [
      /创建.*工作流/i, /生成.*工作流/i, /新建.*工作流/i, /build.*workflow/i, /create.*workflow/i,
      /帮我.*做一个/i, /做一个.*图/i, /文生图/i, /图生图/i, /从零开始/i,
    ],
  },
  {
    type: 'workflow-debug',
    patterns: [
      /修复.*错误/i, /报错/i, /运行失败/i, /fix.*error/i, /debug/i, /不工作/i,
      /missing.*model/i, /类型不匹配/i, /连接.*断开/i, /节点.*失败/i,
    ],
  },
  {
    type: 'workflow-optimize',
    patterns: [
      /优化.*工作流/i, /提升.*速度/i, /减少.*显存/i, /optimize/i, /improve.*performance/i,
      /工作流.*太慢/i, /降低.*内存/i,
    ],
  },
  {
    type: 'model-search',
    patterns: [
      /查找.*模型/i, /搜索.*模型/i, /有没有.*模型/i, /find.*model/i, /search.*model/i,
      /模型.*在哪/i, /checkpoints?.*有什么/i, /loras?.*有什么/i,
    ],
  },
]

export function detectTaskIntent(userMessage: string): TaskIntent {
  let bestMatch: TaskIntent = { type: 'general', confidence: 0, keywords: [] }

  for (const { type, patterns } of INTENT_PATTERNS) {
    const matchedKeywords: string[] = []
    for (const pattern of patterns) {
      if (pattern.test(userMessage)) {
        const match = userMessage.match(pattern)
        if (match) matchedKeywords.push(match[0])
      }
    }
    if (matchedKeywords.length > 0) {
      const confidence = Math.min(matchedKeywords.length / 2, 1)
      if (confidence > bestMatch.confidence) {
        bestMatch = { type, confidence, keywords: matchedKeywords }
      }
    }
  }

  return bestMatch
}

export function shouldUseCoordinator(userMessage: string, errorLog?: string): boolean {
  const intent = detectTaskIntent(userMessage)

  if (intent.type === 'general' && intent.confidence === 0) {
    if (userMessage.length < 30) return false
    if (/^(什么|为什么|怎么|如何|解释|explain|what|why|how)/i.test(userMessage.trim())) return false
  }

  if (intent.type === 'workflow-debug' && errorLog) return true
  if (intent.confidence >= 0.5) return true

  if (userMessage.length > 100) return true

  return false
}

export function createComfyUICoordinatorPlan(
  taskType: ComfyUITaskType,
  userMessage: string,
  agentDefinitions: AgentDefinition[],
  sessionId: string,
  errorLog?: string,
): CoordinatorPlan {
  const agentMap = new Map(agentDefinitions.map(a => [a.name, a]))

  const comfyuiAgent = agentMap.get('comfyui-workflow')
  const exploreAgent = agentMap.get('Explore')
  const planAgent = agentMap.get('Plan')
  const verificationAgent = agentMap.get('verification')

  const planId = `comfyui-plan-${Date.now()}`

  switch (taskType) {
    case 'workflow-creation':
      return {
        id: planId,
        query: userMessage,
        strategy: 'hybrid',
        tasks: buildWorkflowCreationSteps(userMessage, comfyuiAgent, exploreAgent, planAgent, verificationAgent, sessionId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

    case 'workflow-debug':
      return {
        id: planId,
        query: userMessage,
        strategy: 'sequential',
        tasks: buildWorkflowDebugSteps(userMessage, comfyuiAgent, exploreAgent, verificationAgent, sessionId, errorLog),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

    case 'workflow-optimize':
      return {
        id: planId,
        query: userMessage,
        strategy: 'hybrid',
        tasks: buildWorkflowOptimizeSteps(userMessage, comfyuiAgent, exploreAgent, planAgent, verificationAgent, sessionId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

    case 'model-search':
      return {
        id: planId,
        query: userMessage,
        strategy: 'parallel',
        tasks: buildModelSearchSteps(userMessage, exploreAgent, comfyuiAgent, sessionId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

    default:
      return {
        id: planId,
        query: userMessage,
        strategy: 'sequential',
        tasks: buildGeneralSteps(userMessage, comfyuiAgent, exploreAgent, sessionId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
  }
}

function buildWorkflowCreationSteps(
  userMessage: string,
  comfyuiAgent: AgentDefinition | undefined,
  exploreAgent: AgentDefinition | undefined,
  planAgent: AgentDefinition | undefined,
  verificationAgent: AgentDefinition | undefined,
  _sessionId: string,
): CoordinatorTaskStep[] {
  const steps: CoordinatorTaskStep[] = []

  if (exploreAgent) {
    steps.push({
      description: 'Research available ComfyUI nodes and models',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Research task for ComfyUI workflow creation. User request: "${userMessage}"

Your job is to find:
1. What ComfyUI node types are available - search custom_nodes and built-in node definitions
2. What models are installed - check the models/ directory structure (checkpoints, loras, vae, controlnet, etc.)
3. Any relevant workflow examples or patterns in the codebase

Use Glob and Grep to search efficiently. Report your findings concisely - do NOT modify any files.`,
    })
  }

  if (planAgent) {
    steps.push({
      description: 'Plan the workflow structure and data flow',
      phase: 'synthesis',
      agentType: 'Plan',
      prompt: `Based on the research findings, design a ComfyUI workflow for: "${userMessage}"

Design the workflow with:
1. Required nodes and their types
2. Data flow connections between nodes
3. Model file references (use actual model names found in research)
4. Parameter settings for key nodes (KSampler steps, cfg, etc.)

Output a structured plan. Do NOT modify any files.`,
      dependsOn: ['Research available ComfyUI nodes and models'],
    })
  }

  if (comfyuiAgent) {
    steps.push({
      description: 'Implement the ComfyUI workflow JSON',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Create a complete ComfyUI workflow JSON for: "${userMessage}"

Based on the research and planning from previous steps, generate a VALID, COMPLETE workflow JSON.

Requirements:
- Output the FULL JSON in a Markdown code block labeled \`json\`
- Ensure valid JSON - NO trailing commas, NO comments
- All node connections must be valid
- Use actual model filenames found during research
- Include all required parameters

If you cannot find a specific model, use a placeholder and note it clearly.`,
      dependsOn: ['Plan the workflow structure and data flow'],
    })
  }

  if (verificationAgent) {
    steps.push({
      description: 'Verify the generated workflow JSON',
      phase: 'verification',
      agentType: 'verification',
      prompt: `Verify the ComfyUI workflow JSON generated for: "${userMessage}"

Check:
1. JSON is valid and parseable
2. All node IDs are unique
3. All link references point to existing nodes
4. Required inputs are connected
5. Data types match between connected nodes
6. Model file references are plausible (check if files exist)

Report VERDICT: PASS or FAIL with specific issues found.`,
      dependsOn: ['Implement the ComfyUI workflow JSON'],
    })
  }

  if (steps.length === 0) {
    steps.push({
      description: 'Handle workflow creation directly',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Create a complete ComfyUI workflow JSON for: "${userMessage}"

Generate a VALID, COMPLETE workflow JSON. Output the FULL JSON in a Markdown code block labeled \`json\`.`,
    })
  }

  return steps
}

function buildWorkflowDebugSteps(
  userMessage: string,
  comfyuiAgent: AgentDefinition | undefined,
  exploreAgent: AgentDefinition | undefined,
  verificationAgent: AgentDefinition | undefined,
  _sessionId: string,
  errorLog?: string,
): CoordinatorTaskStep[] {
  const steps: CoordinatorTaskStep[] = []

  if (exploreAgent) {
    steps.push({
      description: 'Research the error cause and context',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Investigate a ComfyUI workflow error. User report: "${userMessage}"
${errorLog ? `Error log:\n${errorLog}` : ''}

Your job is to:
1. Search for the error message in ComfyUI source code and custom_nodes
2. Check if referenced models exist in the models/ directory
3. Look for known issues with the node types mentioned
4. Check node type definitions for input/output requirements

Report your findings concisely - do NOT modify any files.`,
    })
  }

  if (comfyuiAgent) {
    steps.push({
      description: 'Implement the workflow fix',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Fix the ComfyUI workflow error. User report: "${userMessage}"
${errorLog ? `Error log:\n${errorLog}` : ''}

Based on the research findings:
1. Identify the root cause
2. Generate a FIXED, COMPLETE workflow JSON
3. Output the FULL JSON in a Markdown code block labeled \`json\`
4. Explain what was changed and why`,
      dependsOn: ['Research the error cause and context'],
    })
  }

  if (verificationAgent) {
    steps.push({
      description: 'Verify the fix resolves the error',
      phase: 'verification',
      agentType: 'verification',
      prompt: `Verify that the ComfyUI workflow fix resolves the original error: "${userMessage}"
${errorLog ? `Original error log:\n${errorLog}` : ''}

Check:
1. The specific error condition is addressed
2. The fixed workflow JSON is valid
3. No new issues were introduced
4. All node connections are still valid

Report VERDICT: PASS or FAIL.`,
      dependsOn: ['Implement the workflow fix'],
    })
  }

  if (steps.length === 0) {
    steps.push({
      description: 'Debug workflow directly',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Fix the ComfyUI workflow error: "${userMessage}"
${errorLog ? `Error log:\n${errorLog}` : ''}

Generate a FIXED, COMPLETE workflow JSON. Output the FULL JSON in a Markdown code block labeled \`json\`.`,
    })
  }

  return steps
}

function buildWorkflowOptimizeSteps(
  userMessage: string,
  comfyuiAgent: AgentDefinition | undefined,
  exploreAgent: AgentDefinition | undefined,
  planAgent: AgentDefinition | undefined,
  verificationAgent: AgentDefinition | undefined,
  _sessionId: string,
): CoordinatorTaskStep[] {
  const steps: CoordinatorTaskStep[] = []

  if (exploreAgent) {
    steps.push({
      description: 'Analyze current workflow for bottlenecks',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Analyze the current ComfyUI workflow for optimization opportunities. User request: "${userMessage}"

Look for:
1. Redundant nodes or processing steps
2. Nodes that could be replaced with more efficient alternatives
3. Memory-intensive operations (large latent sizes, multiple model loads)
4. Sequential operations that could be parallelized

Report findings concisely - do NOT modify any files.`,
    })
  }

  if (planAgent) {
    steps.push({
      description: 'Design optimization plan',
      phase: 'synthesis',
      agentType: 'Plan',
      prompt: `Based on the analysis, design an optimization plan for: "${userMessage}"

Include:
1. Specific changes to make (which nodes to replace, reorder, or remove)
2. Expected performance improvements
3. Any trade-offs (quality vs speed, memory vs speed)
4. Risk assessment for each change

Output a structured plan. Do NOT modify any files.`,
      dependsOn: ['Analyze current workflow for bottlenecks'],
    })
  }

  if (comfyuiAgent) {
    steps.push({
      description: 'Implement the optimized workflow',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Apply the optimization to the ComfyUI workflow: "${userMessage}"

Based on the optimization plan:
1. Generate the OPTIMIZED, COMPLETE workflow JSON
2. Output the FULL JSON in a Markdown code block labeled \`json\`
3. Explain each optimization applied`,
      dependsOn: ['Design optimization plan'],
    })
  }

  if (verificationAgent) {
    steps.push({
      description: 'Verify the optimized workflow',
      phase: 'verification',
      agentType: 'verification',
      prompt: `Verify the optimized ComfyUI workflow for: "${userMessage}"

Check:
1. The workflow JSON is valid
2. The optimization did not break any connections
3. Output quality is not significantly degraded
4. The claimed optimizations are actually present

Report VERDICT: PASS or FAIL.`,
      dependsOn: ['Implement the optimized workflow'],
    })
  }

  if (steps.length === 0) {
    steps.push({
      description: 'Optimize workflow directly',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: `Optimize the ComfyUI workflow: "${userMessage}"

Generate an OPTIMIZED, COMPLETE workflow JSON. Output the FULL JSON in a Markdown code block labeled \`json\`.`,
    })
  }

  return steps
}

function buildModelSearchSteps(
  userMessage: string,
  exploreAgent: AgentDefinition | undefined,
  comfyuiAgent: AgentDefinition | undefined,
  _sessionId: string,
): CoordinatorTaskStep[] {
  const steps: CoordinatorTaskStep[] = []

  if (exploreAgent) {
    steps.push({
      description: 'Search for models in all directories',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Search for ComfyUI models. User request: "${userMessage}"

Search in:
1. The main models/ directory and all subdirectories (checkpoints, loras, vae, controlnet, upscale_models, embeddings, etc.)
2. Check extra_model_paths.yaml for additional model directories
3. Check environment variables for custom model paths

Use Glob to find model files (.safetensors, .ckpt, .pt, .bin, .onnx).
Report all found models organized by type. Do NOT modify any files.`,
    })
  }

  if (comfyuiAgent) {
    steps.push({
      description: 'Provide model recommendations',
      phase: 'synthesis',
      agentType: 'comfyui-workflow',
      prompt: `Based on the model search results, help the user with: "${userMessage}"

Provide:
1. A summary of available models by type
2. Recommendations based on the user's needs
3. If a needed model is missing, suggest where to download it
4. Any compatibility notes (which models work together)`,
      dependsOn: ['Search for models in all directories'],
    })
  }

  if (steps.length === 0) {
    steps.push({
      description: 'Search models directly',
      phase: 'research',
      agentType: 'comfyui-workflow',
      prompt: `Search for ComfyUI models: "${userMessage}"

Use Glob and Bash to check the models/ directory. Report what you find.`,
    })
  }

  return steps
}

function buildGeneralSteps(
  userMessage: string,
  comfyuiAgent: AgentDefinition | undefined,
  exploreAgent: AgentDefinition | undefined,
  _sessionId: string,
): CoordinatorTaskStep[] {
  const steps: CoordinatorTaskStep[] = []

  if (exploreAgent) {
    steps.push({
      description: 'Research the question context',
      phase: 'research',
      agentType: 'Explore',
      prompt: `Research context for ComfyUI question: "${userMessage}"

Search for relevant information in the ComfyUI codebase, custom_nodes, and configuration.
Report findings concisely - do NOT modify any files.`,
    })
  }

  if (comfyuiAgent) {
    steps.push({
      description: 'Answer the user question',
      phase: 'synthesis',
      agentType: 'comfyui-workflow',
      prompt: `Answer the user's ComfyUI question: "${userMessage}"

Based on the research findings, provide a comprehensive answer.
If the question involves workflow modification, output the FULL JSON in a Markdown code block labeled \`json\`.`,
      dependsOn: exploreAgent ? ['Research the question context'] : undefined,
    })
  }

  if (steps.length === 0) {
    steps.push({
      description: 'Handle directly',
      phase: 'implementation',
      agentType: 'comfyui-workflow',
      prompt: userMessage,
    })
  }

  return steps
}
