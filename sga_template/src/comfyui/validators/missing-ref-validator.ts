/**
 * Missing-Reference Validator — checks model-loader and media-loader nodes
 * against the ModelIndex to detect references to files not present on disk.
 *
 * Emits WorkflowIssue[] with category 'missing_model' or 'missing_media'.
 */
import type { WorkflowIssue } from '../issue-types.js'
import { MODEL_LOADER_MAPPING, MEDIA_LOADER_TYPES } from '../model-categories.js'
import { getModelFile, getMediaFile } from '../model-index.js'

interface GraphNode {
  id: number | string
  type: string
  widgets_values?: unknown[]
}

/** @deprecated Use graph-walker/rules/missing-model.ts and graph-walker/rules/missing-media.ts instead. Will be removed after the next release. */
export async function validateMissingReferences(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? [])
    .filter(n => n && typeof n.id !== 'undefined')
  const issues: WorkflowIssue[] = []

  for (const node of nodes) {
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
    if (widgets.length === 0) continue

    // Check model loaders
    const loaderMapping = MODEL_LOADER_MAPPING[node.type]
    if (loaderMapping) {
      const widgetIndex = findWidgetIndex(node, loaderMapping.widget)
      const modelName = widgetIndex !== -1 ? widgets[widgetIndex] : undefined
      if (typeof modelName === 'string' && modelName.length > 0) {
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
      continue
    }

    // Check media loaders
    if (MEDIA_LOADER_TYPES.has(node.type)) {
      const mediaName = widgets[0]
      if (typeof mediaName === 'string' && mediaName.length > 0) {
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
    }
  }

  return issues
}

/**
 * Find the index of a widget by name in the node's inputs.
 * ComfyUI stores widget values positionally, but the widget name comes from
 * the node definition. For the graph format, widgets_values aligns with
 * the order of input.required in /object_info. We use a simple heuristic:
 * if the widget name matches a known position (e.g. ckpt_name is always
 * index 0 for CheckpointLoaderSimple), return that index.
 *
 * For v1, we assume the widget is at index 0 for most loaders (which is
 * true for all entries in MODEL_LOADER_MAPPING). This is a known limitation.
 */
function findWidgetIndex(_node: GraphNode, widgetName: string): number {
  // All current MODEL_LOADER_MAPPING entries have the model name as the
  // first widget (index 0). This matches ComfyUI's /object_info ordering
  // where required inputs come first and model names precede numeric params.
  void widgetName  // acknowledged — not used in v1 heuristic
  return 0
}
