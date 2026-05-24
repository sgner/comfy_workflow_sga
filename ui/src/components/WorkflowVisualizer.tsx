

import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  Edit3,
  ExternalLink,
  FileJson,
  History,
  Maximize,
  Move,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Wrench,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'

import {
  ComfyNode,
  ComfyWorkflow,
  Language,
  WorkflowCheckpoint,
  WorkflowIssue,
  VisualizerTab,
  WorkflowContextData,
  MCPServerInfo,
  SkillInfo
} from '../types'

function getModelSearchKeyword(issue: WorkflowIssue): string {
  let name = ''
  if (issue.modelName) {
    name = issue.modelName
  } else {
    const match = issue.message.match(/Missing model:\s*(.+?)(?:\s+in\s+|$)/i)
    if (match) name = match[1].trim()
    else {
      const match2 = issue.message.match(/model[\s:]*(.+?)(?:\s+in\s+|$)/i)
      if (match2) name = match2[1].trim()
    }
  }
  if (!name) name = issue.message
  return name.replace(/\.(safetensors|ckpt|pt|bin|pth|onnx|gguf|fp16|bf16)$/i, '').replace(/[_-]?(fp16|bf16)$/, '')
}
import { t } from '../utils/i18n'
import { collectWorkflowContext, collectWorkflowContextAsync, formatWorkflowContextForPrompt } from '../services/workflowContextCollector'
import { fetchMCPServers, fetchSkills, connectMCPServer, disconnectMCPServer, deleteMCPServer, deleteSkill, addMCPServer, addSkill } from '../services/configService'

interface WorkflowVisualizerProps {
  workflow: ComfyWorkflow
  language: Language
  onOpenSettings: () => void
  isConfigured: boolean
  onUpdateWorkflow: (workflow: ComfyWorkflow) => void
  onAskAi: (prompt: string) => void
  issues?: WorkflowIssue[]
  resolveWidgetNames?: (node: ComfyNode) => string[]
  activeTab: VisualizerTab
  onTabChange: (tab: VisualizerTab) => void
  onSendErrorsToAi?: (selectedIssues: WorkflowIssue[]) => void
  onResolveIssue?: (issue: WorkflowIssue) => void
  onDownloadModel?: (modelName: string, modelFolder?: string) => void
  backendUrl?: string
}

// Constants for Node Rendering
const NODE_HEADER_HEIGHT = 30
const SLOT_HEIGHT = 20
const WIDGET_HEIGHT = 24
const NODE_WIDTH_DEFAULT = 210 
const CANVAS_DOT_COLOR = '#1e293b'

const WorkflowVisualizer: React.FC<WorkflowVisualizerProps> = ({
  workflow,
  language,
  onOpenSettings,
  isConfigured,
  onUpdateWorkflow,
  onAskAi,
  issues = [],
  resolveWidgetNames,
  activeTab,
  onTabChange,
  onSendErrorsToAi,
  onResolveIssue,
  onDownloadModel,
  backendUrl
}) => {
  const [copied, setCopied] = useState(false)
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())

  // MCP & Skills State
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [showAddMcpForm, setShowAddMcpForm] = useState(false)
  const [showAddSkillForm, setShowAddSkillForm] = useState(false)
  const [mcpForm, setMcpForm] = useState({ name: '', transport: 'stdio', command: '', url: '', args: '' })
  const [skillForm, setSkillForm] = useState({ name: '', description: '', whenToUse: '', userInvocable: true })

  // Graph View State
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  // JSON Edit State
  const [isEditing, setIsEditing] = useState(false)
  const [jsonString, setJsonString] = useState('')
  const [showEditWarning, setShowEditWarning] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<WorkflowCheckpoint[]>([])

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(workflow, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: 'application/json'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `workflow_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // --- Helper: Calculate Node Dimensions ---
  const getNodeDimensions = (node: ComfyNode) => {
    let w = NODE_WIDTH_DEFAULT;
    // Handle ComfyUI size formats [w, h] or {0: w, 1: h}
    if (Array.isArray(node.size) && node.size.length >= 1) {
        w = Number(node.size[0]);
    } else if (node.size && typeof node.size === 'object') {
        // @ts-ignore
        if ('0' in node.size) w = Number(node.size[0]);
    }
    if (w < NODE_WIDTH_DEFAULT) w = NODE_WIDTH_DEFAULT;

    const inputs = node.inputs?.length || 0;
    const outputs = node.outputs?.length || 0;
    const widgets = node.widgets_values?.length || 0;
    
    const slotsHeight = Math.max(inputs, outputs) * SLOT_HEIGHT;
    const widgetsHeight = widgets * (WIDGET_HEIGHT + 4);
    const contentHeight = NODE_HEADER_HEIGHT + slotsHeight + widgetsHeight + 20; // + padding
    
    let h = contentHeight;
    if (Array.isArray(node.size) && node.size.length >= 2) {
        h = Math.max(h, Number(node.size[1]));
    } else if (node.size && typeof node.size === 'object') {
        // @ts-ignore
        if ('1' in node.size) h = Math.max(h, Number(node.size[1]));
    }
    
    return { w, h };
  }

  // --- Auto Layout / Fix Overlaps Logic ---
  
  const handleFixOverlaps = () => {
    if (!workflow || !workflow.nodes || workflow.nodes.length === 0) return

    // Deep copy to avoid mutating state directly during calculation
    const newWorkflow = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow
    const nodes = newWorkflow.nodes

    if (nodes.length === 0) return;

    // 1. Calculate Bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
        if (!n.pos) return;
        minX = Math.min(minX, n.pos[0]);
        maxX = Math.max(maxX, n.pos[0]);
        minY = Math.min(minY, n.pos[1]);
        maxY = Math.max(maxY, n.pos[1]);
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // 2. Expansion: Move nodes away from center
    const EXPANSION = 1.1; 
    nodes.forEach(n => {
        if (!n.pos) return;
        n.pos[0] = centerX + (n.pos[0] - centerX) * EXPANSION;
        n.pos[1] = centerY + (n.pos[1] - centerY) * EXPANSION;
    });

    // 3. Iterative Solver to fix overlaps
    const ITERATIONS = 100;
    const PADDING = 50; // Generous padding to ensure visual separation

    // Cache dimensions to improve performance inside loop
    const dimensions = new Map<number, { w: number, h: number }>();
    nodes.forEach(n => {
        dimensions.set(n.id, getNodeDimensions(n));
    });

    for (let iter = 0; iter < ITERATIONS; iter++) {
        let moved = false;
        
        for (let i = 0; i < nodes.length; i++) {
            const nA = nodes[i];
            const dimA = dimensions.get(nA.id)!;
            
            // Calculate dynamic center A (position changes each iteration)
            const cAx = nA.pos[0] + dimA.w / 2;
            const cAy = nA.pos[1] + dimA.h / 2;

            for (let j = i + 1; j < nodes.length; j++) {
                const nB = nodes[j];
                const dimB = dimensions.get(nB.id)!;

                // Calculate dynamic center B
                const cBx = nB.pos[0] + dimB.w / 2;
                const cBy = nB.pos[1] + dimB.h / 2;

                let dx = cAx - cBx;
                let dy = cAy - cBy;

                // Handle exact overlap (jitter)
                if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
                    dx = (Math.random() - 0.5);
                    dy = (Math.random() - 0.5);
                }

                const minDistX = (dimA.w / 2) + (dimB.w / 2) + PADDING;
                const minDistY = (dimA.h / 2) + (dimB.h / 2) + PADDING;

                const absDx = Math.abs(dx);
                const absDy = Math.abs(dy);

                // Check Overlap
                if (absDx < minDistX && absDy < minDistY) {
                    moved = true;
                    
                    // Penetration depth
                    const penX = minDistX - absDx;
                    const penY = minDistY - absDy;

                    // Resolve along shortest axis (Minimum Translation Vector)
                    if (penX < penY) {
                        const sign = dx > 0 ? 1 : -1;
                        const shift = penX / 2;
                        nA.pos[0] += sign * shift;
                        nB.pos[0] -= sign * shift;
                    } else {
                        const sign = dy > 0 ? 1 : -1;
                        const shift = penY / 2;
                        nA.pos[1] += sign * shift;
                        nB.pos[1] -= sign * shift;
                    }
                }
            }
        }
        if (!moved) break; // Optimization: Stop if no overlaps found
    }

    // 4. Final Integer Rounding for cleaner JSON
    nodes.forEach(n => {
        if(n.pos) {
            n.pos[0] = Math.round(n.pos[0]);
            n.pos[1] = Math.round(n.pos[1]);
        }
    });

    onUpdateWorkflow(newWorkflow)
  }

  // --- JSON Edit Logic ---

  const handleStartEdit = () => {
    setShowEditWarning(true)
  }

  const confirmEditMode = () => {
    setShowEditWarning(false)
    setJsonString(JSON.stringify(workflow, null, 2))
    setIsEditing(true)
  }

  const handleSaveJson = () => {
    try {
      const parsed = JSON.parse(jsonString)

      // Create Checkpoint before saving
      const newCheckpoint: WorkflowCheckpoint = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        name: `${t(language, 'version')} ${checkpoints.length + 1}`,
        data: workflow // Save the OLD workflow state
      }
      setCheckpoints((prev) => [newCheckpoint, ...prev])

      // Update App Workflow
      onUpdateWorkflow(parsed)
      setIsEditing(false)
      setJsonError(null)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  const handleRestoreCheckpoint = (cp: WorkflowCheckpoint) => {
    if (window.confirm(t(language, 'restoreConfirm'))) {
      onUpdateWorkflow(cp.data)
      setJsonString(JSON.stringify(cp.data, null, 2))
    }
  }

  const handleAskAiFix = () => {
    const prompt = `I am trying to edit the workflow JSON manually but I got this error: "${jsonError}". \n\nHere is the broken JSON I wrote:\n\`\`\`json\n${jsonString}\n\`\`\`\n\nPlease fix it and return the valid JSON.`
    onAskAi(prompt)
    setJsonError(null)
  }

  // --- Analysis Logic ---
  const analysis = useMemo(() => {
    const allIssues: WorkflowIssue[] = [...issues.filter(i => i.source !== 'agent')]

    if (!workflow || !Array.isArray(workflow.nodes)) {
        allIssues.push({
            id: 'critical-structure',
            nodeId: null,
            severity: 'error',
            message: t(language, 'invalidJsonText'),
            fixSuggestion: t(language, 'askAiFix')
        });
        return { issues: allIssues, nodeCount: 0, linkCount: 0, nodeTypes: {} }
    }

    const nodeCount = workflow.nodes.length
    const linkCount = Array.isArray(workflow.links) ? workflow.links.length : 0

    const nodeTypes = workflow.nodes.reduce(
      (acc, node) => {
        if (node && node.type) {
          acc[node.type] = (acc[node.type] || 0) + 1
        }
        return acc
      },
      {} as Record<string, number>
    )

    return { issues: allIssues, nodeCount, linkCount, nodeTypes }
  }, [workflow, language, issues])

  // --- Canvas Interaction ---

  const handleWheel = (e: React.WheelEvent) => {
    if (activeTab !== 'preview') return
    const zoomSensitivity = 0.001
    const newZoom = Math.min(
      Math.max(0.1, transform.k - e.deltaY * zoomSensitivity),
      5
    )
    setTransform((prev) => ({ ...prev, k: newZoom }))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTab !== 'preview') return
    if (e.button === 0 || e.button === 1) {
      setIsDragging(true)
      setLastMousePos({ x: e.clientX, y: e.clientY })
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || activeTab !== 'preview') return
    const dx = e.clientX - lastMousePos.x
    const dy = e.clientY - lastMousePos.y
    setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
    setLastMousePos({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleFitToScreen = () => {
    if (!workflow?.nodes?.length) return

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    workflow.nodes.forEach((n) => {
      if (!n.pos || !Array.isArray(n.pos)) return
      const { w, h } = getNodeDimensions(n)
      const x = n.pos[0]
      const y = n.pos[1]
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    })

    if (minX === Infinity) return 

    const padding = 50
    const width = maxX - minX + padding * 2
    const height = maxY - minY + padding * 2

    const containerW = containerRef.current?.clientWidth || 800
    const containerH = containerRef.current?.clientHeight || 600

    const scaleX = containerW / width
    const scaleY = containerH / height
    const scale = Math.min(scaleX, scaleY, 1)

    setTransform({
      x: -minX * scale + (containerW - width * scale) / 2 + padding * scale,
      y: -minY * scale + (containerH - height * scale) / 2 + padding * scale,
      k: scale
    })
  }

  useEffect(() => {
    if (workflow && activeTab === 'preview') {
      setTimeout(handleFitToScreen, 100)
    }
  }, [workflow, activeTab])

  useEffect(() => {
    if (activeTab === 'mcp' && backendUrl) {
      setMcpLoading(true)
      fetchMCPServers(backendUrl).then(setMcpServers).catch(() => setMcpServers([])).finally(() => setMcpLoading(false))
    }
  }, [activeTab, backendUrl])

  useEffect(() => {
    if (activeTab === 'skills' && backendUrl) {
      setSkillsLoading(true)
      fetchSkills(backendUrl).then(setSkills).catch(() => setSkills([])).finally(() => setSkillsLoading(false))
    }
  }, [activeTab, backendUrl])

  // --- Helpers ---

  // Calculates the EXACT center of the connection dot visually
  const getSlotPosition = (
    node: ComfyNode,
    slotIndex: number,
    isInput: boolean
  ) => {
    if (!node || !node.pos || !Array.isArray(node.pos)) return { x: 0, y: 0 }

    const { w } = getNodeDimensions(node)
    
    const x = isInput ? node.pos[0] - 4 : node.pos[0] + w + 4

    // Y Calculation Logic:
    // Node Header = 30px.
    // Slots start at 31px from top.
    // Slot Height = 20px.
    // Dot Center = 31px + (index * 20px) + 10px (half slot) = 41 + (index * 20).
    
    const y =
      node.pos[1] +
      41 + 
      slotIndex * SLOT_HEIGHT
      
    return { x, y }
  }

  const nodeMap = useMemo(() => {
    const map = new Map<number, ComfyNode>()
    if (workflow && Array.isArray(workflow.nodes)) {
      workflow.nodes.forEach((n) => map.set(Number(n.id), n))
    }
    return map
  }, [workflow])

  // --- Renderers ---

  const renderGraph = () => {
    if (
      !workflow ||
      !Array.isArray(workflow.nodes) ||
      workflow.nodes.length === 0
    ) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
          <Activity size={32} className="opacity-20" />
          <p>{t(language, 'emptyWorkflow')}</p>
        </div>
      )
    }

    return (
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden relative bg-slate-950 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{
          backgroundImage: `radial-gradient(${CANVAS_DOT_COLOR} 1px, transparent 1px)`,
          backgroundSize: `${20 * transform.k}px ${20 * transform.k}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`
        }}
      >
        <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-20">
          <button onClick={handleFixOverlaps} className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded shadow border border-slate-700" title="Fix Overlaps & Expand">
            <Move size={16} />
          </button>
          <button onClick={handleFitToScreen} className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded shadow border border-slate-700" title="Fit to Screen">
            <Maximize size={16} />
          </button>
          <button onClick={() => setTransform((t) => ({ ...t, k: Math.min(t.k + 0.1, 5) }))} className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded shadow border border-slate-700">
            <ZoomIn size={16} />
          </button>
          <button onClick={() => setTransform((t) => ({ ...t, k: Math.max(t.k - 0.1, 0.1) }))} className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded shadow border border-slate-700">
            <ZoomOut size={16} />
          </button>
        </div>

        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`
          }}
        >
          {/* Links Layer */}
          <svg className="overflow-visible pointer-events-none absolute top-0 left-0 z-0" style={{ width: '1px', height: '1px', maxWidth: 'none' }}>
            {Array.isArray(workflow.links) && workflow.links.map((link) => {
                const originNode = nodeMap.get(Number(link[1]))
                const targetNode = nodeMap.get(Number(link[3]))
                if (!originNode || !targetNode) return null

                const startPos = getSlotPosition(originNode, link[2], false)
                const endPos = getSlotPosition(targetNode, link[4], true)

                if (isNaN(startPos.x) || isNaN(startPos.y) || isNaN(endPos.x) || isNaN(endPos.y)) return null

                const dist = Math.abs(endPos.x - startPos.x) * 0.5
                const cp1x = startPos.x + Math.max(dist, 30)
                const cp1y = startPos.y
                const cp2x = endPos.x - Math.max(dist, 30)
                const cp2y = endPos.y
                const qc = `M ${startPos.x} ${startPos.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endPos.x} ${endPos.y}`

                const type = link[5]
                const colors = ['#a8a29e', '#f87171', '#60a5fa', '#4ade80', '#facc15', '#c084fc']
                let color = '#94a3b8'
                if (typeof type === 'string' && type.length > 0) {
                  color = colors[type.charCodeAt(0) % colors.length]
                } else if (typeof type === 'number') {
                  color = colors[type % colors.length]
                }

                return (
                  <g key={link[0]}>
                    <path d={qc} stroke={color} strokeWidth="2.5" fill="none" className="opacity-80" />
                  </g>
                )
              })}
          </svg>

          {/* Nodes Layer */}
          {workflow.nodes.map((node) => {
            const inputs = Array.isArray(node.inputs) ? node.inputs : [];
            const outputs = Array.isArray(node.outputs) ? node.outputs : [];
            const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
            
            // Resolve Widget Names
            const widgetNames = resolveWidgetNames ? resolveWidgetNames(node) : [];

            const { w: width, h: renderHeight } = getNodeDimensions(node)
            const slotsHeight = Math.max(inputs.length, outputs.length) * SLOT_HEIGHT;

            const hasError = analysis.issues.some((i) => i.nodeId === node.id && i.severity === 'error')
            
            if (!node.pos || !Array.isArray(node.pos)) return null

            return (
              <div
                key={node.id}
                className={`absolute rounded-lg shadow-lg flex flex-col overflow-visible border transition-shadow
                                    ${hasError ? 'border-red-500 shadow-red-900/20' : 'border-slate-600 shadow-black/40'}
                                `}
                style={{
                  transform: `translate(${node.pos[0]}px, ${node.pos[1]}px)`,
                  width: `${width}px`,
                  height: `${renderHeight}px`,
                  backgroundColor: node.bgcolor || '#222',
                  zIndex: 10
                }}
              >
                {/* Node Header */}
                <div className="h-[30px] px-3 bg-[#333] border-b border-black/50 rounded-t-lg flex items-center justify-between flex-shrink-0">
                  <span className="text-xs font-bold text-slate-200 truncate" title={node.type}>
                    {node.properties?.['Node name for S&R'] || node.type}
                  </span>
                  <span className="text-[9px] text-slate-500 font-mono opacity-70">#{node.id}</span>
                </div>

                <div className="flex-1 relative">
                  
                  {/* Inputs/Outputs Area */}
                  <div className="relative w-full" style={{ height: `${slotsHeight}px` }}>
                    {/* Inputs - Left Column */}
                    <div className="absolute left-0 top-0 w-full flex flex-col pointer-events-none">
                        {inputs.map((input, i) => {
                            const isConnected = input.link !== null && input.link !== undefined;
                            return (
                                <div key={i} className="h-[20px] relative flex items-center">
                                    <div className={`absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full border border-slate-900 z-20 shrink-0
                                            ${isConnected ? 'bg-[#b0fb5d]' : 'bg-[#2a2a2a] border-[#666]'}
                                        `} 
                                    />
                                    <span className="ml-3 text-[10px] text-[#aaa] truncate font-medium leading-none">{input.name}</span>
                                </div>
                            )
                        })}
                    </div>

                    {/* Outputs - Right Column */}
                    <div className="absolute right-0 top-0 w-full flex flex-col pointer-events-none">
                        {outputs.map((output, i) => {
                            const hasLinks = output.links && output.links.length > 0;
                            return (
                                <div key={i} className="h-[20px] relative flex items-center justify-end">
                                    <span className="mr-3 text-[10px] text-[#aaa] truncate font-medium leading-none">{output.name}</span>
                                    <div className={`absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full border border-slate-900 z-20 shrink-0
                                            ${hasLinks ? 'bg-[#a95dfb]' : 'bg-[#2a2a2a] border-[#666]'}
                                        `} 
                                    />
                                </div>
                            )
                        })}
                    </div>
                  </div>

                  {/* Widgets - Below Slots */}
                  {widgets.length > 0 && (
                      <div className="flex flex-col gap-1 mt-2 border-t border-slate-700/30 pt-2 px-2 pb-2">
                          {widgets.map((val, i) => {
                              const displayVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
                              const widgetName = widgetNames[i];
                              return (
                                  <div key={i} className="flex items-center justify-between w-full h-[24px] px-2 bg-[#1a1a1a] rounded border border-[#333] overflow-hidden">
                                      {widgetName ? (
                                          <div className="flex items-center gap-1 overflow-hidden flex-1 mr-2 border-r border-slate-800/50 pr-1">
                                            <span className="text-[9px] text-slate-400 whitespace-nowrap shrink-0 select-none">{widgetName}</span>
                                          </div>
                                      ) : null}
                                      <div className={`flex items-center ${widgetName ? 'justify-end max-w-[60%]' : 'justify-start w-full'}`}>
                                          <span className="text-[9px] text-slate-200 font-mono truncate" title={displayVal}>
                                            {displayVal}
                                          </span>
                                      </div>
                                  </div>
                              )
                          })}
                      </div>
                  )}
                  
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const toggleIssueSelection = (issueId: string) => {
    setSelectedIssueIds(prev => {
      const next = new Set(prev)
      if (next.has(issueId)) {
        next.delete(issueId)
      } else {
        next.add(issueId)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIssueIds.size === analysis.issues.length) {
      setSelectedIssueIds(new Set())
    } else {
      setSelectedIssueIds(new Set(analysis.issues.map(i => i.id)))
    }
  }

  const handleSendSelectedErrors = () => {
    if (!onSendErrorsToAi || selectedIssueIds.size === 0) return
    const selected = analysis.issues.filter(i => selectedIssueIds.has(i.id))
    onSendErrorsToAi(selected)
    setSelectedIssueIds(new Set())
  }

  const renderAnalysis = () => {
    const runtimeErrors = analysis.issues.filter(i => i.isRuntimeError)
    const hasSelected = selectedIssueIds.size > 0

    return (
    <div className="space-y-4 p-4 bg-slate-950 h-full overflow-y-auto custom-scrollbar">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 text-center">
          <div className="text-lg font-bold text-white">{analysis.nodeCount}</div>
          <div className="text-[10px] text-slate-500 uppercase">{t(language, 'statNodes')}</div>
        </div>
        <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 text-center">
          <div className="text-lg font-bold text-white">{analysis.linkCount}</div>
          <div className="text-[10px] text-slate-500 uppercase">{t(language, 'statLinks')}</div>
        </div>
        <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 text-center">
          <div className={`text-lg font-bold ${analysis.issues.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {analysis.issues.length}
          </div>
          <div className="text-[10px] text-slate-500 uppercase">{t(language, 'statIssues')}</div>
        </div>
      </div>

      {runtimeErrors.length > 0 && (
        <div className="bg-red-950/30 border border-red-900/40 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} className="text-red-400" />
              <span className="text-xs font-bold text-red-300 uppercase tracking-wider">
                Runtime Errors ({runtimeErrors.length})
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                <input
                  type="checkbox"
                  checked={selectedIssueIds.size === analysis.issues.length && analysis.issues.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                />
                {t(language, 'selectAll') || 'Select All'}
              </label>
              <button
                onClick={handleSendSelectedErrors}
                disabled={!hasSelected}
                className={`text-xs flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
                  hasSelected
                    ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/20'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Bot size={12} />
                Send to AI
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {runtimeErrors.map((issue) => {
              const isMissingModel = issue.category === 'missing_model' || issue.modelName || /missing\s+model/i.test(issue.message)
              const isMissingNode = issue.category === 'missing_node' || /missing\s+node/i.test(issue.message)
              return (
              <div
                key={issue.id}
                className={`p-2.5 rounded-lg border flex gap-2.5 items-start transition-colors ${
                  selectedIssueIds.has(issue.id)
                    ? 'bg-red-950/40 border-red-500/50 ring-1 ring-red-500/30'
                    : 'bg-red-950/20 border-red-900/30'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIssueIds.has(issue.id)}
                  onChange={() => toggleIssueSelection(issue.id)}
                  className="mt-0.5 rounded border-slate-600 bg-slate-800 text-red-500 focus:ring-red-500 focus:ring-offset-0"
                />
                <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-200">{issue.message}</p>
                  {issue.nodeType && (
                    <p className="text-xs text-slate-400 mt-0.5">
                      Node: {issue.nodeType}{issue.nodeId != null ? ` (#${issue.nodeId})` : ''}
                    </p>
                  )}
                  {issue.traceback && (
                    <details className="mt-1.5">
                      <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300">
                        Traceback
                      </summary>
                      <pre className="mt-1 text-[10px] font-mono text-red-300/70 bg-slate-950/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                        {issue.traceback}
                      </pre>
                    </details>
                  )}
                  {issue.fixSuggestion && (
                    <p className="text-xs text-slate-400 mt-1">
                      <span className="font-semibold">{t(language, 'tip')}:</span> {issue.fixSuggestion}
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {isMissingModel && onDownloadModel && (
                      <button
                        onClick={() => onDownloadModel(getModelSearchKeyword(issue), issue.modelFolder)}
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
                      >
                        <Download size={10} />
                        {t(language, 'downloadModel') || 'Download Model'}
                      </button>
                    )}
                    {isMissingModel && (
                      <a
                        href={`https://hf-mirror.com/models?search=${encodeURIComponent(getModelSearchKeyword(issue))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        HF Mirror
                      </a>
                    )}
                    {isMissingModel && (
                      <a
                        href={`https://huggingface.co/models?search=${encodeURIComponent(getModelSearchKeyword(issue))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        HuggingFace
                      </a>
                    )}
                    {isMissingNode && (
                      <a
                        href={`https://github.com/search?q=${encodeURIComponent(`comfyui ${issue.nodeType} node`)}&type=repositories`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        GitHub
                      </a>
                    )}
                    {!isMissingModel && !isMissingNode && (
                      <a
                        href={`https://github.com/comfyanonymous/ComfyUI/issues?q=${encodeURIComponent(issue.message)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        GitHub Issues
                      </a>
                    )}
                    <button
                      onClick={() => onResolveIssue ? onResolveIssue(issue) : onAskAi(`Please fix this error: ${issue.message}${issue.nodeType ? ` (node type: ${issue.nodeType})` : ''}${issue.traceback ? `\nTraceback:\n${issue.traceback}` : ''}`)}
                      className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
                    >
                      <Wrench size={10} />
                      {t(language, 'resolveIssue') || 'Resolve'}
                    </button>
                  </div>
                </div>
              </div>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Activity size={16} className="text-indigo-400" />
            {t(language, 'workflowHealth')}
            </h4>
            <div className="flex gap-2">
                <button onClick={() => onAskAi(t(language, 'explainPrompt'))} className="text-xs flex items-center gap-1.5 px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded transition-colors">
                    <BookOpen size={12} />
                    {t(language, 'explainWorkflow')}
                </button>
                <button onClick={() => onAskAi(t(language, 'diagnosePrompt'))} className="text-xs flex items-center gap-1.5 px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors">
                    <Bot size={12} />
                    {t(language, 'diagnoseWithAi')}
                </button>
            </div>
        </div>
        {analysis.issues.length === 0 ? (
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 text-center">
            <Check size={24} className="text-emerald-500 mx-auto mb-2" />
            <p className="text-sm text-emerald-300">{t(language, 'noIssues')}</p>
          </div>
        ) : runtimeErrors.length === 0 ? (
          <div className="space-y-2">
            {analysis.issues.map((issue) => {
              const isMissingModel = issue.category === 'missing_model' || issue.modelName || /missing\s+model/i.test(issue.message)
              const isMissingNode = issue.category === 'missing_node' || /missing\s+node/i.test(issue.message)
              return (
              <div key={issue.id} className={`p-3 rounded-lg border flex gap-3 items-start ${issue.severity === 'warning' ? 'bg-amber-950/20 border-amber-900/30' : 'bg-red-950/20 border-red-900/30'}`}>
                <AlertTriangle size={16} className={issue.severity === 'warning' ? 'text-amber-500' : 'text-red-500'} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${issue.severity === 'warning' ? 'text-amber-200' : 'text-red-200'}`}>{issue.message}</p>
                  {issue.fixSuggestion && <p className="text-xs text-slate-400 mt-1"><span className="font-semibold">{t(language, 'tip')}:</span> {issue.fixSuggestion}</p>}
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {isMissingModel && onDownloadModel && (
                      <button
                        onClick={() => onDownloadModel(getModelSearchKeyword(issue), issue.modelFolder)}
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
                      >
                        <Download size={10} />
                        {t(language, 'downloadModel') || 'Download Model'}
                      </button>
                    )}
                    {isMissingModel && (
                      <a
                        href={`https://hf-mirror.com/models?search=${encodeURIComponent(getModelSearchKeyword(issue))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        HF Mirror
                      </a>
                    )}
                    {isMissingModel && (
                      <a
                        href={`https://huggingface.co/models?search=${encodeURIComponent(getModelSearchKeyword(issue))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        HuggingFace
                      </a>
                    )}
                    {isMissingNode && (
                      <a
                        href={`https://github.com/search?q=${encodeURIComponent(`comfyui ${issue.nodeType} node`)}&type=repositories`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        GitHub
                      </a>
                    )}
                    {!isMissingModel && !isMissingNode && (
                      <a
                        href={`https://github.com/comfyanonymous/ComfyUI/issues?q=${encodeURIComponent(issue.message)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                      >
                        <ExternalLink size={10} />
                        GitHub Issues
                      </a>
                    )}
                    <button
                      onClick={() => onResolveIssue ? onResolveIssue(issue) : onAskAi(`Please fix this issue: ${issue.message}${issue.nodeType ? ` (node type: ${issue.nodeType})` : ''}`)}
                      className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
                    >
                      <Wrench size={10} />
                      {t(language, 'resolveIssue') || 'Resolve'}
                    </button>
                  </div>
                </div>
              </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
    )
  }

  const [contextData, setContextData] = useState<WorkflowContextData | null>(null)
  const [contextFormatted, setContextFormatted] = useState<string>('')
  const [contextExpandedSections, setContextExpandedSections] = useState<Set<string>>(new Set(['errors', 'parameters', 'nodes', 'executionStatus', 'systemInfo', 'nodeDefs']))
  const [contextLoading, setContextLoading] = useState(false)

  const handleRefreshContext = async () => {
    setContextLoading(true)
    try {
      const ctx = await collectWorkflowContextAsync()
      setContextData(ctx)
      setContextFormatted(formatWorkflowContextForPrompt(ctx))
    } catch {
      const ctx = collectWorkflowContext()
      setContextData(ctx)
      setContextFormatted(formatWorkflowContextForPrompt(ctx))
    } finally {
      setContextLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'context' && !contextData) {
      handleRefreshContext()
    }
  }, [activeTab])

  const toggleContextSection = (section: string) => {
    setContextExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const renderContextSection = (title: string, sectionKey: string, count: number | undefined, content: React.ReactNode) => (
    <div className="border border-slate-700/50 rounded-lg overflow-hidden">
      <button
        onClick={() => toggleContextSection(sectionKey)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">{title}</span>
          {count !== undefined && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">{count}</span>
          )}
        </div>
        {contextExpandedSections.has(sectionKey) ? (
          <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        )}
      </button>
      {contextExpandedSections.has(sectionKey) && (
        <div className="px-3 py-2 bg-slate-900/30">{content}</div>
      )}
    </div>
  )

  const renderContext = () => (
    <div className="flex flex-col h-full bg-slate-950 min-w-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-2 text-slate-400">
          <Database size={14} />
          <span className="text-xs font-mono">{t(language, 'contextPanelTitle') || 'Workflow Context'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefreshContext}
            disabled={contextLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} className={contextLoading ? 'animate-spin' : ''} />
            {contextLoading ? (t(language, 'loading') || 'Loading...') : (t(language, 'refresh') || 'Refresh')}
          </button>
          <button
            onClick={() => {
              if (contextFormatted) {
                navigator.clipboard.writeText(contextFormatted)
              }
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors"
          >
            <Copy size={12} />
            {t(language, 'copyPrompt') || 'Copy Prompt'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {!contextData ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
            <Database size={32} className="opacity-20" />
            <p className="text-xs">{t(language, 'clickRefreshToCollect') || 'Click Refresh to collect context'}</p>
          </div>
        ) : (
          <>
            {renderContextSection('Errors', 'errors',
              (contextData.errors.executionErrors.length + contextData.errors.nodeValidationErrors.length + contextData.errors.missingNodeTypes.length + contextData.errors.missingModels.length + contextData.errors.missingMedia.length) || undefined,
              contextData.errors.executionErrors.length === 0 &&
              contextData.errors.nodeValidationErrors.length === 0 &&
              contextData.errors.missingNodeTypes.length === 0 &&
              contextData.errors.missingModels.length === 0 &&
              contextData.errors.missingMedia.length === 0 &&
              contextData.errors.promptError === null ? (
                <p className="text-xs text-emerald-400">{t(language, 'noErrors') || 'No errors detected'}</p>
              ) : (
                <div className="space-y-1.5">
                  {contextData.errors.executionErrors.map((e, i) => (
                    <div key={`exec-${i}`} className="text-[11px] text-red-300 bg-red-950/20 rounded px-2 py-1">
                      <span className="font-mono text-red-400">Node #{e.nodeId}</span> ({e.nodeType}): {e.exceptionType}: {e.exceptionMessage}
                    </div>
                  ))}
                  {contextData.errors.nodeValidationErrors.map((ne, i) => (
                    <div key={`valid-${i}`} className="space-y-0.5">
                      {ne.errors.map((e, j) => (
                        <div key={`valid-${i}-${j}`} className="text-[11px] text-amber-300 bg-amber-950/20 rounded px-2 py-1">
                          <span className="font-mono text-amber-400">Node #{ne.nodeId}</span> ({ne.classType}): [{e.type}] {e.message}{e.inputName ? ` (input: ${e.inputName})` : ''}
                        </div>
                      ))}
                    </div>
                  ))}
                  {contextData.errors.promptError && (
                    <div className="text-[11px] text-red-300 bg-red-950/20 rounded px-2 py-1">
                      Prompt Error: [{contextData.errors.promptError.type}] {contextData.errors.promptError.message}
                    </div>
                  )}
                  {contextData.errors.missingNodeTypes.map((mn, i) => (
                    <div key={`mn-${i}`} className="text-[11px] text-amber-300 bg-amber-950/20 rounded px-2 py-1">
                      Missing Node: {mn.type}{mn.nodeId ? ` (node ${mn.nodeId})` : ''}{mn.isReplaceable ? ' [replaceable]' : ''}
                    </div>
                  ))}
                  {contextData.errors.missingModels.map((mm, i) => (
                    <div key={`mm-${i}`} className="text-[11px] text-amber-300 bg-amber-950/20 rounded px-2 py-1">
                      Missing Model: {mm.nodeName}/{mm.widgetName} in {mm.directory}
                    </div>
                  ))}
                  {contextData.errors.missingMedia.map((mm, i) => (
                    <div key={`media-${i}`} className="text-[11px] text-amber-300 bg-amber-950/20 rounded px-2 py-1">
                      Missing Media: [{mm.mediaType}] {mm.name} (node {mm.nodeId}, widget: {mm.widgetName})
                    </div>
                  ))}
                </div>
              )
            )}

            {renderContextSection('Parameters', 'parameters', contextData.parameters.length,
              contextData.parameters.length === 0 ? (
                <p className="text-xs text-slate-500">{t(language, 'noParameters') || 'No parameters collected'}</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {contextData.parameters.map((p, i) => (
                    <div key={i} className="text-[11px] bg-slate-800/50 rounded px-2 py-1">
                      <span className="font-mono text-indigo-400">Node #{p.nodeId}</span> <span className="text-slate-300">({p.nodeType})</span> <span className="text-slate-400">"{p.nodeTitle}"</span>
                      {p.widgets.length > 0 && (
                        <div className="ml-3 text-slate-400">
                          Widgets: {p.widgets.map(w => `${w.name}=${JSON.stringify(w.value)}`).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {renderContextSection('Nodes', 'nodes', contextData.nodes.length,
              <div className="text-[11px] text-slate-300 flex flex-wrap gap-1">
                {contextData.nodes.map((n, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400 font-mono">{n.nodeType}#{n.nodeId}</span>
                ))}
              </div>
            )}

            {renderContextSection('Execution Status', 'executionStatus', undefined,
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="bg-slate-800/50 rounded px-2 py-1">
                  <span className="text-slate-500">Status:</span> <span className={contextData.executionStatus.isIdle ? 'text-emerald-400' : 'text-amber-400'}>{contextData.executionStatus.isIdle ? 'Idle' : 'Running'}</span>
                </div>
                <div className="bg-slate-800/50 rounded px-2 py-1">
                  <span className="text-slate-500">Job:</span> <span className="text-slate-300 font-mono">{contextData.executionStatus.activeJobId ?? 'None'}</span>
                </div>
                <div className="bg-slate-800/50 rounded px-2 py-1">
                  <span className="text-slate-500">Progress:</span> <span className="text-slate-300">{contextData.executionStatus.nodesExecuted}/{contextData.executionStatus.totalNodesToExecute} ({Math.round(contextData.executionStatus.executionProgress * 100)}%)</span>
                </div>
                <div className="bg-slate-800/50 rounded px-2 py-1">
                  <span className="text-slate-500">Executing:</span> <span className="text-slate-300 font-mono">{contextData.executionStatus.executingNodeIds.join(', ') || 'None'}</span>
                </div>
              </div>
            )}

            {renderContextSection('System Info', 'systemInfo', undefined,
              <div className="space-y-1 text-[11px]">
                {contextData.systemInfo.os && <div className="bg-slate-800/50 rounded px-2 py-1"><span className="text-slate-500">OS:</span> <span className="text-slate-300">{contextData.systemInfo.os}</span></div>}
                {contextData.systemInfo.pythonVersion && <div className="bg-slate-800/50 rounded px-2 py-1"><span className="text-slate-500">Python:</span> <span className="text-slate-300">{contextData.systemInfo.pythonVersion}</span></div>}
                {contextData.systemInfo.pytorchVersion && <div className="bg-slate-800/50 rounded px-2 py-1"><span className="text-slate-500">PyTorch:</span> <span className="text-slate-300">{contextData.systemInfo.pytorchVersion}</span></div>}
                {contextData.systemInfo.devices?.map((d, i) => (
                  <div key={i} className="bg-slate-800/50 rounded px-2 py-1">
                    <span className="text-slate-500">Device:</span> <span className="text-slate-300">{d.name} ({d.type})</span>
                    {d.vram && <span className="text-slate-400 ml-1">{Math.round(d.vram / 1024 / 1024)}MB VRAM</span>}
                  </div>
                ))}
                {!contextData.systemInfo.os && !contextData.systemInfo.devices?.length && (
                  <p className="text-slate-500">{t(language, 'noSystemInfo') || 'No system info available'}</p>
                )}
              </div>
            )}

            {renderContextSection('Node Definitions', 'nodeDefs', contextData.nodeDefs.length,
              contextData.nodeDefs.length === 0 ? (
                <p className="text-xs text-slate-500">{t(language, 'noNodeDefs') || 'No node definitions collected'}</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {contextData.nodeDefs.map((d, i) => (
                    <div key={i} className="text-[11px] bg-slate-800/50 rounded px-2 py-1">
                      <span className="text-indigo-400">{d.name}</span> <span className="text-slate-500">[{d.category}]</span>
                      {d.deprecated && <span className="text-red-400 ml-1">[DEPRECATED]</span>}
                      {d.experimental && <span className="text-amber-400 ml-1">[EXPERIMENTAL]</span>}
                      {d.inputs && d.inputs.length > 0 && (
                        <div className="ml-3 text-slate-400">Inputs: {d.inputs.map(inp => `${inp.name}${inp.required ? '*' : '?'}`).join(', ')}</div>
                      )}
                      {d.outputs && d.outputs.length > 0 && (
                        <div className="ml-3 text-slate-400">Outputs: {d.outputs.map(o => o.name).join(', ')}</div>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {contextData.selectedNodeIds.length > 0 && (
              <div className="border border-slate-700/50 rounded-lg px-3 py-2 bg-slate-800/30">
                <span className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">Selected Nodes: </span>
                <span className="text-[11px] text-indigo-400 font-mono">{contextData.selectedNodeIds.join(', ')}</span>
              </div>
            )}

            {contextData.settings.settings.length > 0 && (
              <div className="border border-slate-700/50 rounded-lg px-3 py-2 bg-slate-800/30">
                <span className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">Settings: </span>
                <span className="text-[11px] text-slate-400">{contextData.settings.settings.map(s => `${s.key}=${JSON.stringify(s.value)}`).join(', ')}</span>
              </div>
            )}
          </>
        )}
      </div>
      {contextFormatted && (
        <div className="border-t border-slate-800 px-3 py-2 bg-slate-900/30">
          <details>
            <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300 uppercase tracking-wider font-semibold">
              {t(language, 'formattedPromptPreview') || 'Formatted Prompt Preview'}
            </summary>
            <pre className="mt-2 text-[10px] font-mono text-slate-400 bg-slate-950/50 rounded p-2 max-h-[600px] overflow-auto whitespace-pre-wrap">{contextFormatted}</pre>
          </details>
        </div>
      )}
    </div>
  )

  const renderMCP = () => (
    <div className="flex flex-col h-full bg-slate-950 min-w-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-2 text-slate-400">
          <Wrench size={14} />
          <span className="text-xs font-mono">{t(language, 'mcpServers')}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddMcpForm(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs transition-colors"
          >
            + {t(language, 'mcpServerAdd')}
          </button>
          <button
            onClick={() => {
              if (backendUrl) {
                setMcpLoading(true)
                fetchMCPServers(backendUrl).then(setMcpServers).catch(() => setMcpServers([])).finally(() => setMcpLoading(false))
              }
            }}
            disabled={mcpLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={mcpLoading ? 'animate-spin' : ''} />
            {t(language, 'refresh') || 'Refresh'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {showAddMcpForm && (
          <div className="border border-indigo-700/50 rounded-lg p-3 bg-slate-800/50 space-y-2">
            <div className="text-xs font-semibold text-indigo-300">{t(language, 'addMcpServerTitle')}</div>
            <div className="space-y-1.5">
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'mcpServerNameLabel')} *</label>
                <input value={mcpForm.name} onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'mcpTransportType')}</label>
                <select value={mcpForm.transport} onChange={e => setMcpForm(f => ({ ...f, transport: e.target.value }))} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none">
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="streamable-http">streamable-http</option>
                </select>
              </div>
              {mcpForm.transport === 'stdio' ? (
                <div>
                  <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'mcpCommand')} *</label>
                  <input value={mcpForm.command} onChange={e => setMcpForm(f => ({ ...f, command: e.target.value }))} placeholder="npx -y @modelcontextprotocol/server-xxx" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
                </div>
              ) : (
                <div>
                  <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'mcpUrl')} *</label>
                  <input value={mcpForm.url} onChange={e => setMcpForm(f => ({ ...f, url: e.target.value }))} placeholder="http://localhost:3000/sse" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
                </div>
              )}
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'mcpArgs')}</label>
                <input value={mcpForm.args} onChange={e => setMcpForm(f => ({ ...f, args: e.target.value }))} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => { setShowAddMcpForm(false); setMcpForm({ name: '', transport: 'stdio', command: '', url: '', args: '' }) }} className="px-3 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">{t(language, 'cancel')}</button>
              <button onClick={() => {
                if (!backendUrl || !mcpForm.name) return
                const args = mcpForm.args ? mcpForm.args.split(',').map(a => a.trim()).filter(Boolean) : undefined
                addMCPServer(backendUrl, { name: mcpForm.name, transport: mcpForm.transport, command: mcpForm.command || undefined, url: mcpForm.url || undefined, args }).then(() => {
                  setShowAddMcpForm(false)
                  setMcpForm({ name: '', transport: 'stdio', command: '', url: '', args: '' })
                  setMcpLoading(true)
                  fetchMCPServers(backendUrl).then(setMcpServers).catch(() => setMcpServers([])).finally(() => setMcpLoading(false))
                })
              }} disabled={!mcpForm.name || (mcpForm.transport === 'stdio' && !mcpForm.command) || (mcpForm.transport !== 'stdio' && !mcpForm.url)} className="px-3 py-1 rounded text-xs bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">{t(language, 'confirm')}</button>
            </div>
          </div>
        )}
        {mcpLoading && mcpServers.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-xs">{t(language, 'loading') || 'Loading...'}</div>
        ) : mcpServers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
            <Wrench size={32} className="opacity-20" />
            <p className="text-xs">{t(language, 'mcpNoServers')}</p>
          </div>
        ) : (
          mcpServers.map((server) => (
            <div key={server.name} className="border border-slate-700/50 rounded-lg px-3 py-2.5 bg-slate-800/30 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${server.status === 'connected' ? 'bg-emerald-400' : server.status === 'error' ? 'bg-red-400' : 'bg-slate-500'}`} />
                  <span className="text-xs font-mono text-slate-200">{server.name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {server.status === 'connected' ? (
                    <button
                      onClick={() => {
                        if (backendUrl) {
                          disconnectMCPServer(backendUrl, server.name).then(() => {
                            setMcpServers(prev => prev.map(s => s.name === server.name ? { ...s, status: 'disconnected' } : s))
                          })
                        }
                      }}
                      className="px-2 py-0.5 rounded text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                    >
                      {t(language, 'mcpServerDisconnect')}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (backendUrl) {
                          connectMCPServer(backendUrl, server.name).then(() => {
                            setMcpServers(prev => prev.map(s => s.name === server.name ? { ...s, status: 'connected' } : s))
                          }).catch(() => {
                            setMcpServers(prev => prev.map(s => s.name === server.name ? { ...s, status: 'error' } : s))
                          })
                        }
                      }}
                      className="px-2 py-0.5 rounded text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                    >
                      {t(language, 'mcpServerConnect')}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (backendUrl) {
                        deleteMCPServer(backendUrl, server.name).then(() => {
                          setMcpServers(prev => prev.filter(s => s.name !== server.name))
                        })
                      }
                    }}
                    className="px-2 py-0.5 rounded text-[10px] bg-red-900/50 hover:bg-red-800/50 text-red-300 transition-colors"
                  >
                    {t(language, 'mcpServerDelete')}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <div>
                  <span className="text-slate-500">{t(language, 'mcpServerStatus')}:</span>{' '}
                  <span className={server.status === 'connected' ? 'text-emerald-400' : server.status === 'error' ? 'text-red-400' : 'text-slate-400'}>
                    {server.status === 'connected' ? t(language, 'mcpServerConnected') : server.status === 'error' ? t(language, 'mcpServerError') : t(language, 'mcpServerDisconnected')}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">{t(language, 'mcpServerTransport')}:</span>{' '}
                  <span className="text-slate-300">{server.transport}</span>
                </div>
                <div>
                  <span className="text-slate-500">{t(language, 'mcpServerTools')}:</span>{' '}
                  <span className="text-indigo-400">{server.toolCount}</span>
                </div>
                {server.command && (
                  <div className="col-span-2">
                    <span className="text-slate-500">Command:</span>{' '}
                    <span className="text-slate-300 font-mono text-[10px]">{server.command}</span>
                  </div>
                )}
                {server.url && (
                  <div className="col-span-2">
                    <span className="text-slate-500">URL:</span>{' '}
                    <span className="text-slate-300 font-mono text-[10px]">{server.url}</span>
                  </div>
                )}
                {server.error && (
                  <div className="col-span-2 text-red-400 text-[10px]">{server.error}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )

  const renderSkills = () => (
    <div className="flex flex-col h-full bg-slate-950 min-w-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-2 text-slate-400">
          <Bot size={14} />
          <span className="text-xs font-mono">{t(language, 'tabSkills')}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddSkillForm(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs transition-colors"
          >
            + {t(language, 'addSkillTitle')}
          </button>
          <button
            onClick={() => {
              if (backendUrl) {
                setSkillsLoading(true)
                fetchSkills(backendUrl).then(setSkills).catch(() => setSkills([])).finally(() => setSkillsLoading(false))
              }
            }}
            disabled={skillsLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={skillsLoading ? 'animate-spin' : ''} />
            {t(language, 'refresh') || 'Refresh'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {showAddSkillForm && (
          <div className="border border-indigo-700/50 rounded-lg p-3 bg-slate-800/50 space-y-2">
            <div className="text-xs font-semibold text-indigo-300">{t(language, 'addSkillTitle')}</div>
            <div className="space-y-1.5">
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'skillNameLabel')} *</label>
                <input value={skillForm.name} onChange={e => setSkillForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'skillDescriptionLabel')} *</label>
                <textarea value={skillForm.description} onChange={e => setSkillForm(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none resize-none" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t(language, 'skillWhenToUse')}</label>
                <input value={skillForm.whenToUse} onChange={e => setSkillForm(f => ({ ...f, whenToUse: e.target.value }))} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={skillForm.userInvocable} onChange={e => setSkillForm(f => ({ ...f, userInvocable: e.target.checked }))} className="rounded border-slate-700" />
                <label className="text-[10px] text-slate-400">{t(language, 'skillUserInvocable')}</label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => { setShowAddSkillForm(false); setSkillForm({ name: '', description: '', whenToUse: '', userInvocable: true }) }} className="px-3 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">{t(language, 'cancel')}</button>
              <button onClick={() => {
                if (!backendUrl || !skillForm.name || !skillForm.description) return
                addSkill(backendUrl, { name: skillForm.name, description: skillForm.description, whenToUse: skillForm.whenToUse || undefined, userInvocable: skillForm.userInvocable }).then(() => {
                  setShowAddSkillForm(false)
                  setSkillForm({ name: '', description: '', whenToUse: '', userInvocable: true })
                  setSkillsLoading(true)
                  fetchSkills(backendUrl).then(setSkills).catch(() => setSkills([])).finally(() => setSkillsLoading(false))
                })
              }} disabled={!skillForm.name || !skillForm.description} className="px-3 py-1 rounded text-xs bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">{t(language, 'confirm')}</button>
            </div>
          </div>
        )}
        {skillsLoading && skills.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-xs">{t(language, 'loading') || 'Loading...'}</div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
            <Bot size={32} className="opacity-20" />
            <p className="text-xs">{t(language, 'skillNoSkills')}</p>
          </div>
        ) : (
          skills.map((skill) => (
            <div key={skill.name} className="border border-slate-700/50 rounded-lg px-3 py-2.5 bg-slate-800/30 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-200">{skill.name}</span>
                  {skill.userInvocable && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-indigo-900/50 text-indigo-300 border border-indigo-700/30">
                      {t(language, 'skillUserInvocable')}
                    </span>
                  )}
                </div>
                {skill.source !== 'bundled' && (
                  <button
                    onClick={() => {
                      if (backendUrl) {
                        deleteSkill(backendUrl, skill.name).then(() => {
                          setSkills(prev => prev.filter(s => s.name !== skill.name))
                        })
                      }
                    }}
                    className="px-2 py-0.5 rounded text-[10px] bg-red-900/50 hover:bg-red-800/50 text-red-300 transition-colors"
                  >
                    {t(language, 'mcpServerDelete')}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-400">{skill.description}</p>
              {skill.whenToUse && (
                <p className="text-[10px] text-slate-500 italic">{skill.whenToUse}</p>
              )}
              {skill.source && (
                <div className="text-[10px] text-slate-600">
                  {t(language, 'skillSource')}: <span className="text-slate-400">{skill.source}</span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )

  const renderJson = () => (
    <div className="flex flex-col h-full bg-slate-950 min-w-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-2 text-slate-400">
          <FileJson size={14} />
          <span className="text-xs font-mono">{t(language, isEditing ? 'editMode' : 'readOnly')}</span>
        </div>
        <div className="flex items-center gap-2">
          {!isEditing ? (
            <button onClick={handleStartEdit} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors">
              <Edit3 size={14} />
              {t(language, 'editJson')}
            </button>
          ) : (
            <>
              <button onClick={() => setIsEditing(false)} className="px-3 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-xs transition-colors">{t(language, 'cancelEdit')}</button>
              <button onClick={handleSaveJson} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-lg shadow-emerald-900/20">
                <Save size={14} />
                {t(language, 'saveChanges')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative h-full border-r border-slate-800 min-w-0">
          {isEditing ? (
            <textarea value={jsonString} onChange={(e) => setJsonString(e.target.value)} className="w-full h-full bg-slate-950 p-4 text-xs font-mono text-amber-100 resize-none focus:outline-none leading-relaxed custom-scrollbar" spellCheck={false} />
          ) : (
            <pre className="w-full h-full text-xs font-mono text-slate-300 bg-slate-950 p-4 overflow-auto custom-scrollbar leading-relaxed">{JSON.stringify(workflow, null, 2)}</pre>
          )}
        </div>
        <div className="w-64 bg-slate-900/20 flex flex-col border-l border-slate-800 flex-shrink-0">
          <div className="p-3 border-b border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300 uppercase tracking-wider"><History size={14} />{t(language, 'checkpoints')}</div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
            {checkpoints.map((cp) => (
              <div key={cp.id} className="group flex flex-col gap-2 p-3 rounded-lg border border-slate-800 bg-slate-900/50 hover:border-indigo-500/50 hover:bg-slate-800 transition-all">
                <div className="flex items-center justify-between"><span className="text-xs font-bold text-indigo-300 font-mono">{cp.name}</span><span className="text-[9px] text-slate-500">{new Date(cp.timestamp).toLocaleTimeString()}</span></div>
                <div className="flex items-center gap-2 mt-1"><button onClick={() => handleRestoreCheckpoint(cp)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded bg-slate-950 border border-slate-800 hover:bg-indigo-600/10 hover:border-indigo-500/30 text-slate-400 hover:text-indigo-300 text-[10px] transition-all"><RotateCcw size={12} />{t(language, 'restore')}</button></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )

  const WarningModal = () => !showEditWarning ? null : (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
        <div className="bg-slate-900 border border-amber-500/30 w-full max-w-sm rounded-xl p-6 shadow-2xl">
          <h3 className="text-lg font-bold text-amber-100 mb-4">{t(language, 'editWarningTitle')}</h3>
          <p className="text-sm text-slate-300 mb-6">{t(language, 'editWarningText')}</p>
          <div className="flex justify-end gap-3"><button onClick={() => setShowEditWarning(false)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white">{t(language, 'cancelEdit')}</button><button onClick={confirmEditMode} className="px-4 py-2 rounded-lg text-sm bg-amber-600 hover:bg-amber-500 text-white font-medium">{t(language, 'confirmEdit')}</button></div>
        </div>
      </div>
  )

  const ErrorModal = () => !jsonError ? null : (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
        <div className="bg-slate-900 border border-red-500/30 w-full max-w-sm rounded-xl p-6 shadow-2xl">
          <h3 className="text-lg font-bold text-red-100 mb-4">{t(language, 'invalidJsonTitle')}</h3>
          <p className="text-sm text-slate-300 mb-2">{t(language, 'invalidJsonText')}</p>
          <div className="bg-black/30 p-3 rounded text-[10px] font-mono text-red-300 mb-6 max-h-24 overflow-auto">{jsonError}</div>
          <div className="flex justify-end gap-3"><button onClick={() => setJsonError(null)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white">{t(language, 'cancelEdit')}</button><button onClick={handleAskAiFix} className="px-4 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-2"><Bot size={14} />{t(language, 'askAiFix')}</button></div>
        </div>
      </div>
  )

  return (
    <div className="h-full flex flex-col bg-slate-950 overflow-hidden relative">
      <div className="border-b border-slate-800 bg-slate-900/50 flex flex-col z-10 shadow-sm backdrop-blur-md flex-shrink-0">
        <div className="h-14 flex items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5"><div className="p-1.5 bg-indigo-500/10 rounded-md border border-indigo-500/20 flex-shrink-0"><Box className="text-indigo-400" size={14} /></div><h3 className="text-xs font-bold text-slate-100 tracking-widest uppercase font-mono truncate">{t(language, 'managerTitle')}</h3></div>
          <div className="flex items-center gap-2">
            {!isConfigured && <button onClick={onOpenSettings} className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded text-[10px] font-medium hover:bg-red-500/20 transition-colors"><AlertCircle size={12} /><span className="hidden sm:inline">{t(language, 'setupRequired')}</span></button>}
            <button onClick={handleCopyJson} className="p-2 text-slate-400 hover:text-indigo-100 hover:bg-slate-800 rounded border border-slate-700 hover:border-indigo-500 transition-all relative group" title={t(language, 'copyJson')}>{copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}</button>
            <button onClick={handleExportJson} className="p-2 text-slate-400 hover:text-indigo-100 hover:bg-slate-800 rounded border border-slate-700 hover:border-indigo-500 transition-all" title={t(language, 'exportJson')}><Download size={14} /></button>
            <div className="w-px h-4 bg-slate-700 mx-1"></div>
            <button onClick={onOpenSettings} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded border border-slate-700 hover:border-indigo-500 transition-all" title={t(language, 'settingsTitle')}><Settings size={14} /></button>
          </div>
        </div>
        <div className="flex px-4 gap-6">
          <button onClick={() => onTabChange('preview')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'preview' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabOverview')}</button>
          <button onClick={() => onTabChange('analysis')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'analysis' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabDiagnostics')}</button>
          <button onClick={() => onTabChange('json')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'json' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabJson')}</button>
          <button onClick={() => onTabChange('context')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'context' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabContext') || 'Context'}</button>
          <button onClick={() => onTabChange('mcp')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'mcp' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabMCP')}</button>
          <button onClick={() => onTabChange('skills')} className={`pb-3 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${activeTab === 'skills' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t(language, 'tabSkills')}</button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'preview' && renderGraph()}
        {activeTab === 'analysis' && renderAnalysis()}
        {activeTab === 'json' && renderJson()}
        {activeTab === 'context' && renderContext()}
        {activeTab === 'mcp' && renderMCP()}
        {activeTab === 'skills' && renderSkills()}
      </div>
      <WarningModal />
      <ErrorModal />
    </div>
  )
}

export default WorkflowVisualizer
