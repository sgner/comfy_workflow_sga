import type {
  WorkflowContextData,
  ErrorContextData,
  ExecutionErrorInfo,
  NodeValidationErrorInfo,
  PromptErrorInfo,
  MissingNodeTypeInfo,
  MissingModelInfo,
  MissingMediaInfo,
  NodeParameterData,
  NodeWidgetInfo,
  NodeListData,
  SettingsContextData,
  GlobalSettingInfo,
  ExecutionStatusInfo,
  SystemInfo,
  NodeDefInfo,
} from '../types'

function getComfyApp(): any {
  return (window as any).app
}

let _piniaInstance: any = null

function getPiniaInstance(): any {
  if (_piniaInstance) return _piniaInstance

  try {
    const w = window as any
    if (w.__pinia) {
      _piniaInstance = w.__pinia
      return _piniaInstance
    }

    const vueEl = document.getElementById('vue-app')
    if (vueEl) {
      const vueApp = (vueEl as any).__vue_app__
      if (vueApp) {
        const pinia = vueApp.config?.globalProperties?.$pinia
        if (pinia) {
          _piniaInstance = pinia
          return _piniaInstance
        }
      }
    }

    if (w.app?._context?.config?.globalProperties?.$pinia) {
      _piniaInstance = w.app._context.config.globalProperties.$pinia
      return _piniaInstance
    }
  } catch {
    /* ignore */
  }

  return null
}

function getPiniaStore(storeName: string): any {
  try {
    const pinia = getPiniaInstance()
    if (!pinia) return null
    const store = pinia._s?.get(storeName)
    if (store) return store

    if (pinia._s && typeof pinia._s.forEach === 'function') {
      let found: any = null
      pinia._s.forEach((v: any, k: string) => {
        if (k === storeName) found = v
      })
      if (found) return found
    }

    if (pinia.state?.value && pinia.state.value[storeName]) {
      return { $state: pinia.state.value[storeName] }
    }
  } catch {
    /* ignore */
  }
  return null
}

function getSettingStore(): any {
  return getPiniaStore('setting') || getPiniaStore('settings')
}

function getExecutionErrorStore(): any {
  return getPiniaStore('executionError')
}

function getMissingNodesErrorStore(): any {
  return getPiniaStore('missingNodesError')
}

function getMissingModelStore(): any {
  return getPiniaStore('missingModel')
}

function getMissingMediaStore(): any {
  return getPiniaStore('missingMedia')
}

function getExecutionStore(): any {
  return getPiniaStore('execution')
}

function getSystemStatsStore(): any {
  return getPiniaStore('systemStats')
}

function getNodeDefStore(): any {
  return getPiniaStore('nodeDef')
}

function unwrapVueRef(val: any): any {
  if (val && typeof val === 'object' && '__v_isRef' in val) {
    return val.value
  }
  return val
}

function collectErrorData(): ErrorContextData {
  const executionErrors: ExecutionErrorInfo[] = []
  const nodeValidationErrors: NodeValidationErrorInfo[] = []
  let promptError: PromptErrorInfo | null = null
  const missingNodeTypes: MissingNodeTypeInfo[] = []
  const missingModels: MissingModelInfo[] = []
  const missingMedia: MissingMediaInfo[] = []

  const app = getComfyApp()

  const executionErrorStore = getExecutionErrorStore()
  if (executionErrorStore) {
    const lastExecErr = unwrapVueRef(executionErrorStore.lastExecutionError)
    if (lastExecErr) {
      const e = lastExecErr
      if (!executionErrors.some(ee => ee.nodeId === String(e.node_id ?? e.nodeId))) {
        executionErrors.push({
          nodeId: String(e.node_id ?? e.nodeId ?? null),
          nodeType: e.node_type ?? e.nodeType ?? null,
          exceptionType: e.exception_type ?? e.exceptionType ?? null,
          exceptionMessage: e.exception_message ?? e.exceptionMessage ?? e.message ?? null,
          traceback: Array.isArray(e.traceback) ? e.traceback : null,
        })
      }
    }

    const lastNodeErrs = unwrapVueRef(executionErrorStore.lastNodeErrors)
    if (lastNodeErrs) {
      for (const [nodeId, nodeError] of Object.entries(lastNodeErrs)) {
        const ne = nodeError as any
        nodeValidationErrors.push({
          nodeId,
          classType: ne.class_type ?? ne.classType ?? 'Unknown',
          errors: (ne.errors ?? []).map((e: any) => ({
            type: e.type ?? 'unknown',
            message: e.message ?? '',
            inputName: e.extra_info?.input_name ?? e.input_name,
          })),
        })
      }
    }

    const lastPromptErr = unwrapVueRef(executionErrorStore.lastPromptError)
    if (lastPromptErr) {
      const pe = lastPromptErr
      promptError = {
        type: pe.type ?? 'unknown',
        message: pe.message ?? String(pe),
        details: pe.details ?? undefined,
      }
    }
  }

  if (app?.lastExecutionError && executionErrors.length === 0) {
    const e = app.lastExecutionError
    executionErrors.push({
      nodeId: String(e.node_id ?? e.nodeId ?? null),
      nodeType: e.node_type ?? e.nodeType ?? null,
      exceptionType: e.exception_type ?? e.exceptionType ?? null,
      exceptionMessage: e.exception_message ?? e.exceptionMessage ?? e.message ?? null,
      traceback: Array.isArray(e.traceback) ? e.traceback : null,
    })
  }

  if (app?.lastNodeErrors && nodeValidationErrors.length === 0) {
    const nodeErrors = app.lastNodeErrors
    for (const [nodeId, nodeError] of Object.entries(nodeErrors)) {
      const ne = nodeError as any
      nodeValidationErrors.push({
        nodeId,
        classType: ne.class_type ?? ne.classType ?? 'Unknown',
        errors: (ne.errors ?? []).map((e: any) => ({
          type: e.type ?? 'unknown',
          message: e.message ?? '',
          inputName: e.extra_info?.input_name ?? e.input_name,
        })),
      })
    }
  }

  const missingNodesErrorStore = getMissingNodesErrorStore()
  if (missingNodesErrorStore) {
    const missingNodesError = unwrapVueRef(missingNodesErrorStore.missingNodesError)
    if (missingNodesError) {
      const nodeTypes = missingNodesError.nodeTypes ?? []
      for (const nt of nodeTypes) {
        if (typeof nt === 'string') {
          if (!missingNodeTypes.some(m => m.type === nt)) {
            missingNodeTypes.push({
              type: nt,
              nodeId: null,
              isReplaceable: false,
            })
          }
        } else if (typeof nt === 'object') {
          const type = nt.type ?? 'Unknown'
          if (!missingNodeTypes.some(m => m.type === type && m.nodeId === (nt.nodeId ?? null))) {
            missingNodeTypes.push({
              type,
              nodeId: nt.nodeId ?? nt.node_id ?? null,
              isReplaceable: nt.isReplaceable ?? false,
              replacement: nt.replacement ? { new_node_id: nt.replacement.new_node_id } : undefined,
            })
          }
        }
      }
    }
  }

  const missingModelStore = getMissingModelStore()
  if (missingModelStore) {
    const candidates = unwrapVueRef(missingModelStore.missingModelCandidates)
    if (Array.isArray(candidates)) {
      for (const mc of candidates) {
        const name = mc.name ?? ''
        const widgetName = mc.widgetName ?? ''
        const directory = mc.directory ?? ''
        if (!missingModels.some(m => m.nodeName === name && m.widgetName === widgetName)) {
          missingModels.push({
            nodeName: name,
            widgetName,
            directory,
            modelPaths: [],
            nodeType: mc.nodeType ?? undefined,
            isAssetSupported: mc.isAssetSupported ?? undefined,
            isMissing: mc.isMissing ?? undefined,
          })
        }
      }
    }
  }

  const missingMediaStore = getMissingMediaStore()
  if (missingMediaStore) {
    const candidates = unwrapVueRef(missingMediaStore.missingMediaCandidates)
    if (Array.isArray(candidates)) {
      for (const mc of candidates) {
        missingMedia.push({
          name: mc.name ?? '',
          mediaType: mc.mediaType ?? 'image',
          nodeId: String(mc.nodeId ?? ''),
          nodeType: mc.nodeType ?? '',
          widgetName: mc.widgetName ?? '',
          isMissing: mc.isMissing ?? undefined,
        })
      }
    }
  }

  if (app?.graph) {
    const nodes = app.graph.nodes ?? []
    for (const node of nodes) {
      if (node.type === 'UnknownNode' || node.type === 'UNKNOWN' || node.isUnknown) {
        const existing = missingNodeTypes.find(m => m.nodeId === node.id)
        if (!existing) {
          missingNodeTypes.push({
            type: node.originalType ?? node.properties?.['originalType'] ?? 'Unknown',
            nodeId: typeof node.id === 'number' ? node.id : (typeof node.id === 'string' ? parseInt(node.id, 10) || null : null),
            isReplaceable: false,
          })
        }
      }
    }
  }

  return {
    executionErrors,
    nodeValidationErrors,
    promptError,
    missingNodeTypes,
    missingModels,
    missingMedia,
  }
}

function collectParameterData(selectedNodeIds?: number[]): NodeParameterData[] {
  const app = getComfyApp()
  if (!app?.graph) return []

  const graph = app.graph
  const nodes = graph.nodes ?? []
  const links = graph.links ?? []
  const linkMap = new Map<number, any>()
  for (const link of links) {
    linkMap.set(link.id || link[0], link)
  }

  const nodeMap = new Map<number, any>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  const targetNodes = selectedNodeIds?.length
    ? nodes.filter((n: any) => selectedNodeIds.includes(n.id))
    : nodes

  return targetNodes.map((node: any) => {
    const widgets: NodeWidgetInfo[] = []
    if (node.widgets) {
      for (const w of node.widgets) {
        widgets.push({
          name: w.name ?? '',
          type: w.type ?? '',
          value: w.value,
          label: w.label ?? w.name,
          options: w.options,
          advanced: w.options?.advanced ?? false,
        })
      }
    }

    const inputLinks: NodeParameterData['inputLinks'] = []
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link != null) {
          const link = linkMap.get(input.link)
          if (link) {
            const originId = link.origin_id ?? link[1]
            const originSlot = link.origin_slot ?? link[2]
            const sourceNode = nodeMap.get(originId)
            const sourceOutput = sourceNode?.outputs?.[originSlot]
            inputLinks.push({
              inputName: input.name ?? '',
              inputType: input.type ?? '',
              sourceNodeId: originId,
              sourceNodeType: sourceNode?.type ?? 'Unknown',
              sourceOutputName: sourceOutput?.name ?? '',
            })
          }
        }
      }
    }

    const outputLinks: NodeParameterData['outputLinks'] = []
    if (node.outputs) {
      for (const output of node.outputs) {
        if (output.links) {
          for (const linkId of output.links) {
            const link = linkMap.get(linkId)
            if (link) {
              const targetId = link.target_id ?? link[3]
              const targetSlot = link.target_slot ?? link[4]
              const targetNode = nodeMap.get(targetId)
              const targetInput = targetNode?.inputs?.[targetSlot]
              outputLinks.push({
                outputName: output.name ?? '',
                outputType: output.type ?? '',
                targetNodeId: targetId,
                targetNodeType: targetNode?.type ?? 'Unknown',
                targetInputName: targetInput?.name ?? '',
              })
            }
          }
        }
      }
    }

    return {
      nodeId: node.id,
      nodeType: node.type,
      nodeTitle: node.title ?? node.properties?.['Node name for S&R'] ?? node.type,
      widgets,
      inputLinks,
      outputLinks,
    }
  })
}

function collectNodeListData(): NodeListData[] {
  const app = getComfyApp()
  if (!app?.graph) return []

  const nodes = app.graph.nodes ?? []
  return nodes.map((node: any) => ({
    nodeId: node.id,
    nodeType: node.type,
    nodeTitle: node.title ?? node.properties?.['Node name for S&R'] ?? node.type,
    mode: node.mode ?? 0,
    widgetCount: node.widgets?.length ?? 0,
    inputCount: node.inputs?.length ?? 0,
    outputCount: node.outputs?.length ?? 0,
  }))
}

function collectSettingsData(): SettingsContextData {
  const settings: GlobalSettingInfo[] = []
  const settingStore = getSettingStore()

  const knownSettings: Array<{ key: string; category: string; type: 'boolean' | 'number' | 'string' }> = [
    { key: 'Comfy.Node.AlwaysShowAdvancedWidgets', category: 'Nodes', type: 'boolean' },
    { key: 'Comfy.Canvas.SelectionToolbox', category: 'Canvas', type: 'boolean' },
    { key: 'Comfy.VueNodes.Enabled', category: 'Nodes', type: 'boolean' },
    { key: 'Comfy.SnapToGrid.GridSize', category: 'Canvas', type: 'number' },
    { key: 'pysssss.SnapToGrid', category: 'Canvas', type: 'boolean' },
    { key: 'Comfy.Graph.LinkMarkers', category: 'Links', type: 'string' },
    { key: 'Comfy.LinkRenderMode', category: 'Links', type: 'number' },
    { key: 'Comfy.Sidebar.Location', category: 'UI', type: 'string' },
    { key: 'Comfy.RightSidePanel.ShowErrorsTab', category: 'UI', type: 'boolean' },
    { key: 'Comfy.RightSidePanel.IsOpen', category: 'UI', type: 'boolean' },
  ]

  let showAdvancedWidgets = false
  let snapToGrid = false
  let gridSize = 1
  let linkRenderMode = 1
  let linkMarkers = 'None'

  if (settingStore) {
    for (const s of knownSettings) {
      try {
        const val = settingStore.get(s.key)
        if (val !== undefined && val !== null) {
          settings.push({
            key: s.key,
            value: val,
            type: s.type,
            category: s.category,
          })
        }
      } catch { /* ignore */ }
    }

    try { showAdvancedWidgets = !!settingStore.get('Comfy.Node.AlwaysShowAdvancedWidgets') } catch { /* ignore */ }
    try { snapToGrid = !!settingStore.get('pysssss.SnapToGrid') } catch { /* ignore */ }
    try { gridSize = Number(settingStore.get('Comfy.SnapToGrid.GridSize')) || 1 } catch { /* ignore */ }
    try { linkRenderMode = Number(settingStore.get('Comfy.LinkRenderMode')) ?? 1 } catch { /* ignore */ }
    try { linkMarkers = String(settingStore.get('Comfy.Graph.LinkMarkers') ?? 'None') } catch { /* ignore */ }
  }

  return {
    settings,
    showAdvancedWidgets,
    snapToGrid,
    gridSize,
    linkRenderMode,
    linkMarkers,
  }
}

function getSelectedNodeIds(): number[] {
  const app = getComfyApp()
  if (!app?.canvas) return []

  const selected = app.canvas.selected_nodes ?? app.canvas.getSelectedNodes?.()
  if (Array.isArray(selected)) {
    return selected.map((n: any) => n.id)
  }

  const selectedItems = app.canvas.selectedItems
  if (Array.isArray(selectedItems)) {
    return selectedItems
      .filter((item: any) => item?.id != null && item.type !== 'LGraphGroup')
      .map((item: any) => item.id)
  }

  return []
}

function collectExecutionStatus(): ExecutionStatusInfo {
  const executionStore = getExecutionStore()
  if (!executionStore) {
    return {
      isIdle: true,
      activeJobId: null,
      executingNodeIds: [],
      executionProgress: 0,
      totalNodesToExecute: 0,
      nodesExecuted: 0,
    }
  }

  const isIdle = unwrapVueRef(executionStore.isIdle)
  const activeJobId = unwrapVueRef(executionStore.activeJobId)
  const executingNodeIds = unwrapVueRef(executionStore.executingNodeIds)
  const executionProgress = unwrapVueRef(executionStore.executionProgress)
  const totalNodesToExecute = unwrapVueRef(executionStore.totalNodesToExecute)
  const nodesExecuted = unwrapVueRef(executionStore.nodesExecuted)

  return {
    isIdle: isIdle ?? true,
    activeJobId: activeJobId ?? null,
    executingNodeIds: executingNodeIds ?? [],
    executionProgress: executionProgress ?? 0,
    totalNodesToExecute: totalNodesToExecute ?? 0,
    nodesExecuted: nodesExecuted ?? 0,
  }
}

let _cachedSystemInfo: SystemInfo | null = null
let _systemInfoFetchPromise: Promise<SystemInfo> | null = null

async function fetchSystemInfoFromApi(): Promise<SystemInfo> {
  const app = getComfyApp()
  if (!app?.api?.getSystemStats) return {}

  try {
    const stats = await app.api.getSystemStats()
    if (!stats) return {}

    const system = stats.system ?? {}
    const devices = stats.devices ?? {}

    const deviceList: SystemInfo['devices'] = []
    if (typeof devices === 'object') {
      for (const [name, info] of Object.entries(devices)) {
        const d = info as any
        deviceList.push({
          name,
          type: d.type ?? d.name ?? 'unknown',
          vram: d.vram_total ?? d.vram ?? undefined,
        })
      }
    }

    return {
      os: system.os ?? undefined,
      pythonVersion: system.python_version ?? undefined,
      pytorchVersion: system.pytorch_version ?? undefined,
      devices: deviceList.length > 0 ? deviceList : undefined,
    }
  } catch {
    return {}
  }
}

async function getSystemInfoAsync(): Promise<SystemInfo> {
  if (_cachedSystemInfo && Object.keys(_cachedSystemInfo).length > 0) {
    return _cachedSystemInfo
  }

  if (_systemInfoFetchPromise) {
    return _systemInfoFetchPromise
  }

  _systemInfoFetchPromise = fetchSystemInfoFromApi().then(info => {
    if (Object.keys(info).length > 0) {
      _cachedSystemInfo = info
    }
    _systemInfoFetchPromise = null
    return info
  })

  return _systemInfoFetchPromise
}

function collectSystemInfo(): SystemInfo {
  const systemStatsStore = getSystemStatsStore()
  if (systemStatsStore) {
    const stats = unwrapVueRef(systemStatsStore.systemStats)
    if (stats) {
      const system = stats.system ?? {}
      const devices = stats.devices ?? {}

      const deviceList: SystemInfo['devices'] = []
      if (typeof devices === 'object') {
        for (const [name, info] of Object.entries(devices)) {
          const d = info as any
          deviceList.push({
            name,
            type: d.type ?? d.name ?? 'unknown',
            vram: d.vram_total ?? d.vram ?? undefined,
          })
        }
      }

      const result: SystemInfo = {
        os: system.os ?? undefined,
        pythonVersion: system.python_version ?? undefined,
        pytorchVersion: system.pytorch_version ?? undefined,
        devices: deviceList.length > 0 ? deviceList : undefined,
      }
      if (Object.keys(result).length > 0) {
        _cachedSystemInfo = result
        return result
      }
    }
  }

  if (_cachedSystemInfo && Object.keys(_cachedSystemInfo).length > 0) {
    return _cachedSystemInfo
  }

  getSystemInfoAsync()
  return {}
}

function collectNodeDefs(): NodeDefInfo[] {
  const app = getComfyApp()
  const nodeTypes = new Set<string>()
  if (app?.graph?.nodes) {
    for (const node of app.graph.nodes) {
      if (node.type) nodeTypes.add(node.type)
    }
  }

  if (nodeTypes.size === 0) return []

  const nodeDefStore = getNodeDefStore()
  if (nodeDefStore) {
    const allDefs = unwrapVueRef(nodeDefStore.nodeDefsByName)
    if (allDefs && typeof allDefs === 'object') {
      const defs: NodeDefInfo[] = []
      for (const [name, def] of Object.entries(allDefs)) {
        if (!nodeTypes.has(name)) continue
        const d = def as any
        const inputs: NodeDefInfo['inputs'] = []
        if (d.input?.required && typeof d.input.required === 'object') {
          for (const [inputName] of Object.entries(d.input.required)) {
            inputs.push({ name: inputName, type: 'required', required: true })
          }
        }
        if (d.input?.optional && typeof d.input.optional === 'object') {
          for (const [inputName] of Object.entries(d.input.optional)) {
            inputs.push({ name: inputName, type: 'optional', required: false })
          }
        }
        if (d.inputs && Array.isArray(d.inputs)) {
          for (const inp of d.inputs) {
            if (!inputs.some(i => i.name === (inp.name ?? inp.label))) {
              inputs.push({
                name: inp.name ?? inp.label ?? '',
                type: inp.type ?? 'unknown',
                required: inp.required ?? false,
              })
            }
          }
        }
        const outputs: NodeDefInfo['outputs'] = []
        if (d.outputs && Array.isArray(d.outputs)) {
          for (const out of d.outputs) {
            outputs.push({
              name: out.name ?? out.label ?? '',
              type: out.type ?? 'unknown',
            })
          }
        }
        defs.push({
          name: d.name ?? name,
          category: d.category ?? '',
          description: d.description ?? undefined,
          inputs: inputs.length > 0 ? inputs : undefined,
          outputs: outputs.length > 0 ? outputs : undefined,
          deprecated: d.deprecated ?? undefined,
          experimental: d.experimental ?? undefined,
        })
      }
      if (defs.length > 0) return defs
    }
  }

  const defs: NodeDefInfo[] = []
  if (app?.graph?.nodes) {
    for (const node of app.graph.nodes) {
      if (!node.type || !nodeTypes.has(node.type)) continue
      const nodeData = node.constructor?.nodeData
      if (!nodeData) continue

      const existing = defs.find(d => d.name === node.type)
      if (existing) continue

      const inputs: NodeDefInfo['inputs'] = []
      if (nodeData.input?.required && typeof nodeData.input.required === 'object') {
        for (const [inputName] of Object.entries(nodeData.input.required)) {
          inputs.push({ name: inputName, type: 'required', required: true })
        }
      }
      if (nodeData.input?.optional && typeof nodeData.input.optional === 'object') {
        for (const [inputName] of Object.entries(nodeData.input.optional)) {
          inputs.push({ name: inputName, type: 'optional', required: false })
        }
      }

      const outputs: NodeDefInfo['outputs'] = []
      if (nodeData.output && Array.isArray(nodeData.output)) {
        for (const out of nodeData.output) {
          outputs.push({
            name: typeof out === 'string' ? out : out?.name ?? '',
            type: typeof out === 'string' ? out : out?.type ?? 'unknown',
          })
        }
      }
      if (nodeData.output_name && Array.isArray(nodeData.output_name)) {
        for (let i = 0; i < nodeData.output_name.length; i++) {
          const name = nodeData.output_name[i]
          const type = nodeData.output?.[i] ?? 'unknown'
          if (!outputs.some(o => o.name === name)) {
            outputs.push({ name, type: typeof type === 'string' ? type : 'unknown' })
          }
        }
      }

      defs.push({
        name: node.type,
        category: nodeData.category ?? '',
        description: nodeData.description ?? undefined,
        inputs: inputs.length > 0 ? inputs : undefined,
        outputs: outputs.length > 0 ? outputs : undefined,
        deprecated: nodeData.deprecated ?? undefined,
        experimental: nodeData.experimental ?? undefined,
      })
    }
  }

  return defs
}

export function collectWorkflowContext(selectedOnly?: boolean): WorkflowContextData {
  const selectedNodeIds = getSelectedNodeIds()
  const errorData = collectErrorData()
  const parameterData = collectParameterData(selectedOnly ? selectedNodeIds : undefined)
  const nodeListData = collectNodeListData()
  const settingsData = collectSettingsData()
  const executionStatus = collectExecutionStatus()
  const systemInfo = collectSystemInfo()
  const nodeDefs = collectNodeDefs()

  return {
    errors: errorData,
    parameters: parameterData,
    nodes: nodeListData,
    settings: settingsData,
    selectedNodeIds,
    executionStatus,
    systemInfo,
    nodeDefs,
  }
}

export async function collectWorkflowContextAsync(selectedOnly?: boolean): Promise<WorkflowContextData> {
  const [, systemInfo] = await Promise.all([
    Promise.resolve(_piniaInstance === null ? getPiniaInstance() : null),
    getSystemInfoAsync(),
  ])

  const selectedNodeIds = getSelectedNodeIds()
  const errorData = collectErrorData()
  const parameterData = collectParameterData(selectedOnly ? selectedNodeIds : undefined)
  const nodeListData = collectNodeListData()
  const settingsData = collectSettingsData()
  const executionStatus = collectExecutionStatus()
  const nodeDefs = collectNodeDefs()

  return {
    errors: errorData,
    parameters: parameterData,
    nodes: nodeListData,
    settings: settingsData,
    selectedNodeIds,
    executionStatus,
    systemInfo,
    nodeDefs,
  }
}

export function resetPiniaCache(): void {
  _piniaInstance = null
}

export function formatWorkflowContextForPrompt(context: WorkflowContextData): string {
  const sections: string[] = []

  const { errors } = context
  const hasErrors =
    errors.executionErrors.length > 0 ||
    errors.nodeValidationErrors.length > 0 ||
    errors.promptError !== null ||
    errors.missingNodeTypes.length > 0 ||
    errors.missingModels.length > 0 ||
    errors.missingMedia.length > 0

  if (hasErrors) {
    sections.push('[WORKFLOW ERRORS]')
    if (errors.executionErrors.length > 0) {
      sections.push('  Execution Errors:')
      for (const e of errors.executionErrors) {
        sections.push(`    - Node ${e.nodeId} (${e.nodeType}): ${e.exceptionType}: ${e.exceptionMessage}`)
        if (e.traceback?.length) {
          sections.push(`      Traceback: ${e.traceback.slice(-3).join(' | ')}`)
        }
      }
    }
    if (errors.nodeValidationErrors.length > 0) {
      sections.push('  Node Validation Errors:')
      for (const ne of errors.nodeValidationErrors) {
        for (const e of ne.errors) {
          sections.push(`    - Node ${ne.nodeId} (${ne.classType}): [${e.type}] ${e.message}${e.inputName ? ` (input: ${e.inputName})` : ''}`)
        }
      }
    }
    if (errors.promptError) {
      sections.push(`  Prompt Error: [${errors.promptError.type}] ${errors.promptError.message}`)
    }
    if (errors.missingNodeTypes.length > 0) {
      sections.push('  Missing Node Types:')
      for (const mn of errors.missingNodeTypes) {
        sections.push(`    - ${mn.type}${mn.nodeId ? ` (node ${mn.nodeId})` : ''}${mn.isReplaceable ? ' [replaceable]' : ''}`)
      }
    }
    if (errors.missingModels.length > 0) {
      sections.push('  Missing Models:')
      for (const mm of errors.missingModels) {
        sections.push(`    - ${mm.nodeName}/${mm.widgetName}: ${mm.directory} (${mm.modelPaths.join(', ')})`)
      }
    }
    if (errors.missingMedia.length > 0) {
      sections.push('  Missing Media:')
      for (const mm of errors.missingMedia) {
        sections.push(`    - [${mm.mediaType}] ${mm.name} (node ${mm.nodeId}/${mm.nodeType}, widget: ${mm.widgetName})`)
      }
    }
  }

  if (context.parameters.length > 0) {
    sections.push('[NODE PARAMETERS]')
    const maxNodes = Math.min(context.parameters.length, 20)
    for (let i = 0; i < maxNodes; i++) {
      const p = context.parameters[i]
      sections.push(`  Node ${p.nodeId} (${p.nodeType}) "${p.nodeTitle}":`)
      if (p.widgets.length > 0) {
        const widgetStrs = p.widgets.map(w => {
          const val = w.value !== undefined ? `=${JSON.stringify(w.value)}` : ''
          return `${w.name}${val}`
        })
        sections.push(`    Widgets: ${widgetStrs.join(', ')}`)
      }
      if (p.inputLinks.length > 0) {
        const inputStrs = p.inputLinks.map(l => `${l.inputName} <- ${l.sourceNodeType}(${l.sourceNodeId}).${l.sourceOutputName}`)
        sections.push(`    Inputs: ${inputStrs.join('; ')}`)
      }
      if (p.outputLinks.length > 0) {
        const outputStrs = p.outputLinks.map(l => `${l.outputName} -> ${l.targetNodeType}(${l.targetNodeId}).${l.targetInputName}`)
        sections.push(`    Outputs: ${outputStrs.join('; ')}`)
      }
    }
    if (context.parameters.length > maxNodes) {
      sections.push(`  ... and ${context.parameters.length - maxNodes} more nodes`)
    }
  }

  if (context.nodes.length > 0) {
    sections.push('[NODE LIST]')
    const nodeSummaries = context.nodes.map(n => `${n.nodeType}#${n.nodeId}`)
    sections.push(`  ${nodeSummaries.join(', ')}`)
  }

  if (context.selectedNodeIds.length > 0) {
    sections.push(`[SELECTED NODES: ${context.selectedNodeIds.join(', ')}]`)
  }

  if (context.settings.settings.length > 0) {
    sections.push('[RELEVANT SETTINGS]')
    for (const s of context.settings.settings) {
      sections.push(`  ${s.key} = ${JSON.stringify(s.value)}`)
    }
  }

  const { executionStatus } = context
  if (!executionStatus.isIdle) {
    sections.push('[EXECUTION STATUS]')
    sections.push(`  Active Job: ${executionStatus.activeJobId}`)
    sections.push(`  Progress: ${executionStatus.nodesExecuted}/${executionStatus.totalNodesToExecute} (${Math.round(executionStatus.executionProgress * 100)}%)`)
    if (executionStatus.executingNodeIds.length > 0) {
      sections.push(`  Executing Nodes: ${executionStatus.executingNodeIds.join(', ')}`)
    }
  }

  const { systemInfo } = context
  if (systemInfo.os || systemInfo.devices?.length) {
    sections.push('[SYSTEM INFO]')
    if (systemInfo.os) sections.push(`  OS: ${systemInfo.os}`)
    if (systemInfo.pythonVersion) sections.push(`  Python: ${systemInfo.pythonVersion}`)
    if (systemInfo.pytorchVersion) sections.push(`  PyTorch: ${systemInfo.pytorchVersion}`)
    if (systemInfo.devices?.length) {
      for (const d of systemInfo.devices) {
        const vramStr = d.vram ? ` (${Math.round(d.vram / 1024 / 1024)}MB VRAM)` : ''
        sections.push(`  Device: ${d.name} - ${d.type}${vramStr}`)
      }
    }
  }

  if (context.nodeDefs.length > 0) {
    sections.push('[NODE DEFINITIONS (used in workflow)]')
    const maxDefs = Math.min(context.nodeDefs.length, 15)
    for (let i = 0; i < maxDefs; i++) {
      const d = context.nodeDefs[i]
      let defStr = `  ${d.name} [${d.category}]`
      if (d.deprecated) defStr += ' [DEPRECATED]'
      if (d.experimental) defStr += ' [EXPERIMENTAL]'
      if (d.description) defStr += `: ${d.description.slice(0, 100)}`
      sections.push(defStr)
      if (d.inputs?.length) {
        sections.push(`    Inputs: ${d.inputs.map(i => `${i.name}${i.required ? '*' : '?'}`).join(', ')}`)
      }
      if (d.outputs?.length) {
        sections.push(`    Outputs: ${d.outputs.map(o => o.name).join(', ')}`)
      }
    }
    if (context.nodeDefs.length > maxDefs) {
      sections.push(`  ... and ${context.nodeDefs.length - maxDefs} more definitions`)
    }
  }

  return sections.join('\n')
}

export function contextErrorsToIssues(context: WorkflowContextData): Array<{
  id: string
  nodeId: number | null
  severity: 'error' | 'warning' | 'info'
  message: string
  fixSuggestion?: string
  nodeType?: string
  exceptionType?: string
  traceback?: string
  isRuntimeError?: boolean
}> {
  const issues: Array<{
    id: string
    nodeId: number | null
    severity: 'error' | 'warning' | 'info'
    message: string
    fixSuggestion?: string
    nodeType?: string
    exceptionType?: string
    traceback?: string
    isRuntimeError?: boolean
  }> = []

  const { errors } = context

  for (const e of errors.executionErrors) {
    issues.push({
      id: `ctx-exec-${Date.now()}-${issues.length}`,
      nodeId: e.nodeId ? parseInt(e.nodeId) || null : null,
      severity: 'error',
      message: `${e.exceptionType || 'ExecutionError'}: ${e.exceptionMessage}`,
      nodeType: e.nodeType ?? undefined,
      exceptionType: e.exceptionType ?? undefined,
      traceback: e.traceback ? (Array.isArray(e.traceback) ? e.traceback.join('\n') : String(e.traceback)) : undefined,
      isRuntimeError: true,
    })
  }

  for (const ne of errors.nodeValidationErrors) {
    for (const e of ne.errors) {
      issues.push({
        id: `ctx-val-${Date.now()}-${issues.length}`,
        nodeId: parseInt(ne.nodeId) || null,
        severity: e.type === 'exception' ? 'error' : 'warning',
        message: `[${e.type}] ${e.message}${e.inputName ? ` (input: ${e.inputName})` : ''}`,
        nodeType: ne.classType,
        fixSuggestion: e.type === 'missing_input' ? 'Check that all required inputs are connected' : undefined,
      })
    }
  }

  if (errors.promptError) {
    issues.push({
      id: `ctx-prompt-${Date.now()}`,
      nodeId: null,
      severity: 'error',
      message: `Prompt Error: ${errors.promptError.message}`,
      exceptionType: errors.promptError.type,
    })
  }

  for (const mn of errors.missingNodeTypes) {
    issues.push({
      id: `ctx-missing-node-${Date.now()}-${issues.length}`,
      nodeId: mn.nodeId ? (typeof mn.nodeId === 'number' ? mn.nodeId : parseInt(String(mn.nodeId)) || null) : null,
      severity: 'error',
      message: `Missing node type: ${mn.type}`,
      fixSuggestion: mn.isReplaceable ? 'This node type has a replacement available' : 'Install the custom node that provides this type',
    })
  }

  for (const mm of errors.missingModels) {
    issues.push({
      id: `ctx-missing-model-${Date.now()}-${issues.length}`,
      nodeId: null,
      severity: 'warning',
      message: `Missing model: ${mm.nodeName}/${mm.widgetName} in ${mm.directory}`,
      fixSuggestion: `Place model file in: ${mm.modelPaths.join(' or ')}`,
    })
  }

  for (const mm of errors.missingMedia) {
    issues.push({
      id: `ctx-missing-media-${Date.now()}-${issues.length}`,
      nodeId: parseInt(mm.nodeId) || null,
      severity: 'warning',
      message: `Missing ${mm.mediaType}: ${mm.name} (widget: ${mm.widgetName})`,
      fixSuggestion: `Provide the ${mm.mediaType} file that node ${mm.nodeId} (${mm.nodeType}) expects`,
    })
  }

  return issues
}
