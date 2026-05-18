import { ComfyWorkflow } from './types'

// A very basic ComfyUI workflow (Load Image -> Preview) to start with
export const DEFAULT_WORKFLOW: ComfyWorkflow = {
  last_node_id: 2,
  last_link_id: 0,
  nodes: [
    {
      id: 1,
      type: 'LoadImage',
      pos: [100, 100],
      size: { '0': 315, '1': 314 },
      flags: {},
      order: 0,
      mode: 0,
      outputs: [
        { name: 'IMAGE', type: 'IMAGE', links: [] },
        { name: 'MASK', type: 'MASK', links: [] }
      ],
      properties: { 'Node name for S&R': 'LoadImage' },
      widgets_values: ['example.png', 'image']
    }
  ],
  links: [],
  groups: [],
  config: {},
  extra: {},
  version: 0.4
}
