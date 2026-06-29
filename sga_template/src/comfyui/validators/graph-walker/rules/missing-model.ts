import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { MODEL_LOADER_MAPPING } from '../../../model-categories.js'
import { getModelFile } from '../../../model-index.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  widgets_values?: unknown[]
}

export const missingModelRule: ValidationRule = {
  id: 'missingModel',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (widgets.length === 0) continue

      const loaderMapping = MODEL_LOADER_MAPPING[node.type]
      if (!loaderMapping) continue

      // v1 heuristic: model name is always at widget index 0 (parity with Approach A)
      const modelName = widgets[0]
      if (typeof modelName !== 'string' || modelName.length === 0) continue

      const entry = await getModelFile(loaderMapping.category, modelName)
      if (!entry) {
        issues.push({
          id: `missing_model:${node.id}`,
          nodeId: typeof node.id === 'number' ? node.id : null,
          severity: 'warning',
          category: 'missing_model',
          message: `Model file '${modelName}' not found in ${loaderMapping.category}/`,
          impact: 'ComfyUI will fail to load this node when the workflow is queued.',
          fixSuggestion: `Check that the file exists under models/${loaderMapping.category}/ or restart ComfyUI to re-index.`,
          nodeType: node.type,
          modelName,
          modelFolder: loaderMapping.category,
          source: 'native',
        })
      }
    }
    return issues
  },
}
