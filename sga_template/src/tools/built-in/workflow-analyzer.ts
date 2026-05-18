import { BaseTool, type ToolInputSchema, type ValidationResult, type ToolUseContext } from '../../tools/base.js'

interface WorkflowNode {
  id: number
  type: string
  inputs?: Array<{ name: string; link?: number | null }>
  outputs?: Array<{ name: string; links?: number[] | null }>
  widgets_values?: unknown[]
}

interface WorkflowLink {
  id: number
  origin_id: number
  origin_slot: number
  target_id: number
  target_slot: number
  type: string
}

interface WorkflowIssue {
  id: string
  node_id: number | null
  severity: 'error' | 'warning' | 'info'
  message: string
  fix_suggestion?: string
}

interface WorkflowAnalysis {
  summary: string
  data_flow: string[]
  key_nodes: Array<{ id: string; type: string; category: string; description: string }>
  issues: WorkflowIssue[]
  suggestions: string[]
}

const NODE_CATEGORIES: Record<string, { types: string[]; category: string; description: string }> = {
  loaders: { types: ['LoadImage', 'LoadCheckpoint', 'LoadText', 'LoadAudio', 'LoadVideo'], category: 'loader', description: 'Loads input data (images, models, etc.)' },
  samplers: { types: ['KSampler', 'KSamplerAdvanced'], category: 'sampler', description: 'Generates images using the diffusion model' },
  encoders: { types: ['VAEEncode', 'CLIPTextEncode'], category: 'encoder', description: 'Encodes data for processing' },
  decoders: { types: ['VAEDecode'], category: 'decoder', description: 'Decodes latent to images' },
  outputs: { types: ['SaveImage', 'PreviewImage', 'SaveAnimatedWEBP'], category: 'output', description: 'Saves or previews the generated images' },
}

export class WorkflowAnalyzerTool extends BaseTool {
  name = 'workflow_analyzer'
  description = 'Analyze a ComfyUI workflow JSON to detect issues, trace data flow, and identify key nodes'

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        workflow_json: {
          type: 'string',
          description: 'JSON string of the ComfyUI workflow to analyze',
        },
        language: {
          type: 'string',
          description: 'Language for analysis results (en, zh, ja, ko)',
          default: 'en',
        },
      },
      required: ['workflow_json'],
    }
  }

  validateInput(input: unknown): ValidationResult {
    const data = input as Record<string, unknown>
    if (!data.workflow_json || typeof data.workflow_json !== 'string') {
      return { success: false, error: 'workflow_json is required and must be a string' }
    }
    try {
      JSON.parse(data.workflow_json)
    } catch {
      return { success: false, error: 'workflow_json must be valid JSON' }
    }
    return { success: true }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<string> {
    const workflow = JSON.parse(input.workflow_json as string)
    const language = (input.language as string) ?? 'en'

    const nodes: WorkflowNode[] = workflow.nodes ?? []
    const rawLinks: unknown[] = workflow.links ?? []

    const links = this.parseLinks(rawLinks)
    const issues = this.detectIssues(nodes, links)
    const dataFlow = this.analyzeDataFlow(nodes, links)
    const keyNodes = this.identifyKeyNodes(nodes)
    const summary = this.generateSummary(nodes, dataFlow, keyNodes, language)
    const suggestions = this.generateSuggestions(issues, nodes, language)

    const analysis: WorkflowAnalysis = {
      summary,
      data_flow: dataFlow,
      key_nodes: keyNodes,
      issues,
      suggestions,
    }

    return JSON.stringify(analysis, null, 2)
  }

  private parseLinks(rawLinks: unknown[]): WorkflowLink[] {
    return rawLinks.map(link => {
      if (Array.isArray(link) && link.length >= 6) {
        return {
          id: Number(link[0]),
          origin_id: Number(link[1]),
          origin_slot: Number(link[2]),
          target_id: Number(link[3]),
          target_slot: Number(link[4]),
          type: String(link[5]),
        }
      }
      if (typeof link === 'object' && link !== null) {
        const l = link as Record<string, unknown>
        return {
          id: Number(l.id ?? 0),
          origin_id: Number(l.origin_id ?? 0),
          origin_slot: Number(l.origin_slot ?? 0),
          target_id: Number(l.target_id ?? 0),
          target_slot: Number(l.target_slot ?? 0),
          type: String(l.type ?? ''),
        }
      }
      return { id: 0, origin_id: 0, origin_slot: 0, target_id: 0, target_slot: 0, type: '' }
    })
  }

  private detectIssues(nodes: WorkflowNode[], links: WorkflowLink[]): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []

    for (const node of nodes) {
      const inputs = node.inputs ?? []
      for (let idx = 0; idx < inputs.length; idx++) {
        const input = inputs[idx]
        if (input.link === null || input.link === undefined) {
          const inputName = input.name ?? ''
          if (!['seed', 'width', 'height', 'batch_size', 'clip'].includes(inputName)) {
            issues.push({
              id: `missing_input_${node.id}_${idx}`,
              node_id: node.id,
              severity: 'warning',
              message: `Node ${node.type} has missing input: ${inputName}`,
              fix_suggestion: `Connect a node to the ${inputName} input or provide a value`,
            })
          }
        }
      }
    }

    const nodeTypes = nodes.map(n => n.type)
    if (nodeTypes.includes('KSampler') && !nodeTypes.includes('VAEDecode')) {
      issues.push({
        id: 'missing_vae_decode',
        node_id: null,
        severity: 'warning',
        message: 'Workflow has KSampler but no VAE Decode node',
        fix_suggestion: 'Add a VAE Decode node to convert latent images to visible images',
      })
    }

    if (nodeTypes.includes('KSampler') && !nodeTypes.includes('SaveImage') && !nodeTypes.includes('PreviewImage')) {
      issues.push({
        id: 'missing_output',
        node_id: null,
        severity: 'info',
        message: 'Workflow has no output node (SaveImage or PreviewImage)',
        fix_suggestion: 'Add a SaveImage or PreviewImage node to see the results',
      })
    }

    return issues
  }

  private analyzeDataFlow(nodes: WorkflowNode[], links: WorkflowLink[]): string[] {
    const dataFlow: string[] = []
    const linkMap = new Map<number, WorkflowLink>()
    for (const link of links) {
      linkMap.set(link.id, link)
    }

    const nodeDict = new Map<string, WorkflowNode>()
    for (const node of nodes) {
      nodeDict.set(String(node.id), node)
    }

    for (const node of nodes) {
      const outputs = node.outputs ?? []
      for (const output of outputs) {
        const nodeLinks = output.links
        if (nodeLinks) {
          for (const linkId of nodeLinks) {
            const link = linkMap.get(linkId)
            if (link) {
              const targetNode = nodeDict.get(String(link.target_id))
              if (targetNode) {
                dataFlow.push(`${node.type} (Node ${node.id}) -> ${targetNode.type} (Node ${link.target_id})`)
              }
            }
          }
        }
      }
    }

    return dataFlow.slice(0, 10)
  }

  private identifyKeyNodes(nodes: WorkflowNode[]): Array<{ id: string; type: string; category: string; description: string }> {
    const keyNodes: Array<{ id: string; type: string; category: string; description: string }> = []

    for (const node of nodes) {
      for (const cat of Object.values(NODE_CATEGORIES)) {
        if (cat.types.some(t => node.type.includes(t))) {
          keyNodes.push({
            id: String(node.id),
            type: node.type,
            category: cat.category,
            description: cat.description,
          })
          break
        }
      }
    }

    return keyNodes
  }

  private generateSummary(
    nodes: WorkflowNode[],
    dataFlow: string[],
    keyNodes: Array<{ id: string; type: string; category: string; description: string }>,
    language: string,
  ): string {
    const nodeCount = nodes.length
    const summaries: Record<string, string> = {
      en: `This workflow contains ${nodeCount} nodes. Key components include ${keyNodes.length} important nodes. The workflow processes data through ${dataFlow.length} connections.`,
      zh: `此工作流包含 ${nodeCount} 个节点。关键组件包括 ${keyNodes.length} 个重要节点。工作流通过 ${dataFlow.length} 个连接处理数据。`,
      ja: `このワークフローには ${nodeCount} 個のノードが含まれています。主要コンポーネントには ${keyNodes.length} 個の重要なノードがあります。`,
      ko: `이 워크플로우에는 ${nodeCount} 개의 노드가 포함되어 있습니다. 주요 구성 요소에는 ${keyNodes.length} 개의 중요한 노드가 있습니다.`,
    }
    return summaries[language] ?? summaries.en
  }

  private generateSuggestions(issues: WorkflowIssue[], nodes: WorkflowNode[], language: string): string[] {
    const suggestionsMap: Record<string, string[]> = {
      en: [
        'Review the workflow connections for any missing links',
        'Consider adding a preview node to see intermediate results',
        'Check if all required custom nodes are installed',
      ],
      zh: [
        '检查工作流连接是否有缺失的链接',
        '考虑添加预览节点以查看中间结果',
        '检查是否已安装所有必需的自定义节点',
      ],
      ja: [
        '欠けているリンクがないかワークフロー接続を確認してください',
        '中間結果を確認するためにプレビューノードを追加することを検討してください',
        '必要なカスタムノードがすべてインストールされているか確認してください',
      ],
      ko: [
        '누락된 연결이 없는지 워크플로우 연결을 검토하세요',
        '중간 결과를 보기 위해 미리보기 노드를 추가하는 것을 고려하세요',
        '필요한 사용자 정의 노드가 모두 설치되어 있는지 확인하세요',
      ],
    }

    const suggestions = [...(suggestionsMap[language] ?? suggestionsMap.en)]

    if (issues.length > 0) {
      const errorCount = issues.filter(i => i.severity === 'error').length
      const warningCount = issues.filter(i => i.severity === 'warning').length
      if (errorCount > 0 || warningCount > 0) {
        const prefixMap: Record<string, string> = { en: 'Fix', zh: '修复', ja: '修正', ko: '수정' }
        const msgMap: Record<string, string> = {
          en: `${errorCount} error(s) and ${warningCount} warning(s)`,
          zh: `${errorCount} 个错误和 ${warningCount} 个警告`,
          ja: `${errorCount} 個のエラーと ${warningCount} 個の警告`,
          ko: `${errorCount} 개의 오류와 ${warningCount} 개의 경고`,
        }
        suggestions.unshift(`${prefixMap[language] ?? 'Fix'} ${msgMap[language] ?? msgMap.en}`)
      }
    }

    return suggestions
  }
}
