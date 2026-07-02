import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { MEDIA_LOADER_TYPES } from '../../../model-categories.js'
import { getMediaFile } from '../../../model-index.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  widgets_values?: unknown[]
}

export const missingMediaRule: ValidationRule = {
  id: 'missingMedia',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (widgets.length === 0) continue

      if (!MEDIA_LOADER_TYPES.has(node.type)) continue

      const mediaName = widgets[0]
      if (typeof mediaName !== 'string' || mediaName.length === 0) continue

      const entry = await getMediaFile(mediaName)
      if (!entry) {
        issues.push({
          id: `missing_media:${node.id}`,
          nodeId: typeof node.id === 'number' ? node.id : null,
          severity: 'warning',
          category: 'missing_media',
          message: `Media file '${mediaName}' not found in input/`,
          impact: 'ComfyUI will fail to load this image/video when the workflow is queued.',
          fixSuggestion: `Check that the file exists under input/ or upload it via ComfyUI's input directory.`,
          nodeType: node.type,
          source: 'native',
        })
      }
    }
    return issues
  },
}
