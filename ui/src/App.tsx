

import { GripHorizontal, Maximize2, Minimize2, RefreshCw, X, Scaling, Undo2, SearchCheck, FileJson } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import ChatPanel from './components/ChatPanel'
import SettingsModal from './components/SettingsModal'
import WorkflowVisualizer from './components/WorkflowVisualizer'
import { DEFAULT_WORKFLOW } from './constants'
import { sendMessageToComfyAgent, fetchChatHistory } from './services/aiService'
import { submitUserInput, checkBackendHealth, undoAction, analyzeWorkflow, fetchBackendConfigs } from './services/configService'
import { AppSettings, ChatMessage, ComfyNode, ComfyWorkflow, Sender, WorkflowIssue, VisualizerTab, AgentStatus, AgentActivity, ApprovalRequest, HumanInputRequest, ToolCallInfo, TokenUsage } from './types'
import { t } from './utils/i18n'
import { collectWorkflowContext, collectWorkflowContextAsync, contextErrorsToIssues, formatWorkflowContextForPrompt } from './services/workflowContextCollector'

interface AppProps {
  displayMode?: 'floating' | 'sidebar'
}

const App: React.FC<AppProps> = () => {
  // --- UI State ---
  const [isVisible, setIsVisible] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [visualizerTab, setVisualizerTab] = useState<VisualizerTab>('preview')

  // Window Management State
  const [windowPos, setWindowPos] = useState({ x: 100, y: 50 })
  // Initialize size from local storage or default
  const [windowSize, setWindowSize] = useState(() => {
      const saved = localStorage.getItem('comfy_copilot_size');
      if (saved) {
          try { return JSON.parse(saved); } catch (e) { console.error(e); }
      }
      return { width: 950, height: 700 };
  });

  const windowRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number, startY: number, startLeft: number, startTop: number } | null>(null)
  const resizeRef = useRef<{ startX: number, startY: number, startWidth: number, startHeight: number } | null>(null)
  
  // Session ID for Backend Persistence
  // We start with a random one, but try to resolve a persistent one from the workflow
  const sessionIdRef = useRef<string>(`session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);
  const lastLoadedSessionId = useRef<string | null>(null);
  

  // --- Application State ---
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('comfy_copilot_settings')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return { 
            ...parsed, 
            language: parsed.language || 'en',
            usePythonBackend: parsed.usePythonBackend || false,
            pythonBackendUrl: parsed.pythonBackendUrl || "http://127.0.0.1:8000"
        }
      } catch (e) {
        console.error(e)
      }
    }
    return {
      provider: 'google',
      apiKey: (typeof process !== 'undefined' && process.env?.API_KEY) || '',
      modelName: 'gemini-2.5-flash',
      baseUrl: '',
      language: 'en',
      usePythonBackend: false,
      pythonBackendUrl: "http://127.0.0.1:8000"
    }
  })

  const [workflow, setWorkflow] = useState<ComfyWorkflow>(DEFAULT_WORKFLOW)
  const [_workflowContext, setWorkflowContext] = useState<any>(null)
  const [issues, setIssues] = useState<WorkflowIssue[]>([]) // Stores AI and System detected issues
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      sender: Sender.AI,
      text: t(appSettings.language, 'welcome'),
      timestamp: new Date(),
      metadata: {
        relatedQuestions: [t(appSettings.language, 'initActionExplain'), t(appSettings.language, 'initActionCheck')]
      }
    }
  ])
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentStatus, setCurrentStatus] = useState<AgentStatus | null>(null)
  const [activityTimeline, setActivityTimeline] = useState<AgentActivity[]>([])
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [pendingHumanInput, setPendingHumanInput] = useState<HumanInputRequest | null>(null)
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([])
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)

  // --- ComfyUI Integration Hooks ---
  const app = (window as any).app;

  // --- Drag & Drop State ---
  const [isDragOver, setIsDragOver] = useState(false)
  const [dragError, setDragError] = useState<string | null>(null)
  const dragCounterRef = useRef(0)

  const isValidComfyWorkflow = (data: any): boolean => {
    if (!data || typeof data !== 'object') return false
    if (data.nodes && Array.isArray(data.nodes)) return true
    if (data.workflow && data.workflow.nodes && Array.isArray(data.workflow.nodes)) return true
    if (data.prompt && typeof data.prompt === 'object') return true
    return false
  }

  const normalizeWorkflowData = (data: any): any => {
    if (data.workflow && data.workflow.nodes) return data.workflow
    if (data.prompt) {
      const nodes: any[] = []
      const prompt = data.prompt
      for (const [id, nodeData] of Object.entries(prompt)) {
        const nd = nodeData as any
        nodes.push({
          id: parseInt(id, 10) || id,
          type: nd.class_type ?? nd.type ?? 'Unknown',
          pos: nd.pos ?? [nodes.length * 200, 0],
          widgets_values: nd.inputs ? Object.values(nd.inputs) : [],
        })
      }
      return { ...data, nodes, links: [] }
    }
    return data
  }

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
      setDragError(null)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    const files = e.dataTransfer.files
    if (!files || files.length === 0) return

    const file = files[0]
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      setDragError(t(appSettings.language, 'dragDropInvalidFile'))
      setTimeout(() => setDragError(null), 3000)
      return
    }

    try {
      const text = await file.text()
      let data = JSON.parse(text)

      if (!isValidComfyWorkflow(data)) {
        setDragError(t(appSettings.language, 'dragDropInvalidFormat'))
        setTimeout(() => setDragError(null), 3000)
        return
      }

      data = normalizeWorkflowData(data)

      if (app) {
        app.loadGraphData(data)
        if (app.canvas && data.nodes && data.nodes.length > 0) {
          const node = app.graph.getNodeById
            ? app.graph.getNodeById(Number(data.nodes[0].id))
            : null
          if (node) app.canvas.centerOnNode(node)
        }
        const graphData = app.graph.serialize()
        setWorkflow(graphData as unknown as ComfyWorkflow)
        const ctx = collectWorkflowContext()
        setWorkflowContext(ctx)
        collectWorkflowContextAsync().then(asyncCtx => {
          setWorkflowContext(asyncCtx)
        }).catch(() => {})
      } else {
        setWorkflow(data as unknown as ComfyWorkflow)
      }

      const sysMsg: ChatMessage = {
        id: Date.now().toString(),
        sender: Sender.SYSTEM,
        text: t(appSettings.language, 'dragDropSuccess').replace('{name}', file.name),
        timestamp: new Date()
      }
      setMessages(prev => [...prev, sysMsg])
    } catch (err) {
      setDragError(t(appSettings.language, 'dragDropParseError'))
      setTimeout(() => setDragError(null), 3000)
    }
  }, [app, appSettings.language])

  // Helper to extract ID
  const getWorkflowId = useCallback((wf: any): string | null => {
      if (!wf) return null;
      if (wf.id) return wf.id;
      if (wf.extra) {
          if (wf.extra.workspace_info && wf.extra.workspace_info.id) {
              return wf.extra.workspace_info.id;
          }
          if (wf.extra.id) {
              return wf.extra.id;
          }
      }
      return null;
  }, []);

  const syncFromCanvas = useCallback(() => {
    if (app && app.graph) {
      const graphData = app.graph.serialize()
      setWorkflow(graphData as unknown as ComfyWorkflow)
      const ctx = collectWorkflowContext()
      setWorkflowContext(ctx)

      const ctxIssues = contextErrorsToIssues(ctx).map(i => ({ ...i, source: 'native' as const }))
      if (ctxIssues.length > 0) {
        setIssues(prev => {
          const nativeIds = new Set(prev.filter(i => i.source === 'native').map(i => i.id))
          const newIssues = ctxIssues.filter(i => !nativeIds.has(i.id))
          const agentIssues = prev.filter(i => i.source === 'agent')
          return [...newIssues, ...agentIssues]
        })
        setVisualizerTab('analysis')
      } else {
        setIssues(prev => prev.filter(i => i.source !== 'native'))
      }
      
      const persistentId = getWorkflowId(graphData);
      if (persistentId) {
          sessionIdRef.current = persistentId;
      }

      collectWorkflowContextAsync().then(asyncCtx => {
        setWorkflowContext(asyncCtx)
        const asyncIssues = contextErrorsToIssues(asyncCtx).map(i => ({ ...i, source: 'native' as const }))
        if (asyncIssues.length > 0) {
          setIssues(prev => {
            const nativeIds = new Set(prev.filter(i => i.source === 'native').map(i => i.id))
            const newIssues = asyncIssues.filter(i => !nativeIds.has(i.id))
            const agentIssues = prev.filter(i => i.source === 'agent')
            return [...newIssues, ...agentIssues]
          })
        }
      }).catch(() => {})
    }
  }, [app, getWorkflowId])

  useEffect(() => {
    if (appSettings.usePythonBackend && appSettings.pythonBackendUrl && isVisible) {
      checkBackendHealth(appSettings.pythonBackendUrl).then(result => {
        setBackendOnline(result !== null)
      })
      if (!appSettings.activeBackendConfigId) {
        fetchBackendConfigs(appSettings.pythonBackendUrl).then(cfgs => {
          if (cfgs.length > 0) {
            const defaultCfg = cfgs.find(c => c.is_default) || cfgs[0]
            setAppSettings(prev => ({ ...prev, activeBackendConfigId: defaultCfg.id }))
          }
        }).catch(() => {})
      }
    } else {
      setBackendOnline(null)
    }
  }, [appSettings.usePythonBackend, appSettings.pythonBackendUrl, isVisible])

  const handleApprovalResponse = useCallback(async (decision: 'allow' | 'deny', reason?: string) => {
    if (!pendingApproval || !appSettings.pythonBackendUrl) return
    try {
      await submitUserInput(appSettings.pythonBackendUrl, {
        session_id: pendingApproval.sessionId,
        action_id: pendingApproval.id,
        decision,
        reason
      })
    } catch (e) {
      console.error('Failed to submit approval response:', e)
    }
    setPendingApproval(null)
  }, [pendingApproval, appSettings.pythonBackendUrl])

  const handleHumanInputResponse = useCallback(async (value: string, optionValue?: string) => {
    if (!pendingHumanInput || !appSettings.pythonBackendUrl) return
    try {
      await submitUserInput(appSettings.pythonBackendUrl, {
        session_id: pendingHumanInput.sessionId,
        action_id: pendingHumanInput.id,
        value,
        optionValue
      })
    } catch (e) {
      console.error('Failed to submit human input response:', e)
    }
    setPendingHumanInput(null)
  }, [pendingHumanInput, appSettings.pythonBackendUrl])

  const handleUndoAction = useCallback(async () => {
    if (!appSettings.pythonBackendUrl) return
    try {
      const result = await undoAction(appSettings.pythonBackendUrl)
      if (result.success && result.restored_state) {
        applyToCanvas(result.restored_state)
      }
    } catch (e) {
      console.error('Failed to undo action:', e)
    }
  }, [appSettings.pythonBackendUrl])

  const [isAnalyzing, setIsAnalyzing] = useState(false)

  const handleAnalyzeWorkflow = useCallback(async () => {
    if (!appSettings.pythonBackendUrl || !workflow) return
    setIsAnalyzing(true)
    try {
      const result = await analyzeWorkflow(appSettings.pythonBackendUrl, workflow as unknown as Record<string, unknown>, appSettings.language)
      if (result.issues && result.issues.length > 0) {
        const mappedIssues: WorkflowIssue[] = result.issues.map((issue, idx) => ({
          id: `analyze-${Date.now()}-${idx}`,
          nodeId: issue.nodeId ? Number(issue.nodeId) || null : null,
          severity: issue.severity as 'error' | 'warning' | 'info',
          message: issue.message,
          fixSuggestion: issue.fixSuggestion,
          source: 'agent' as const,
        }))
        setIssues(prev => [...prev.filter(i => i.source !== 'agent'), ...mappedIssues])
      } else {
        setIssues(prev => prev.filter(i => i.source !== 'agent'))
        setMessages(prev => [...prev, {
          id: `analyze-${Date.now()}`,
          sender: 'ai' as Sender,
          text: t(appSettings.language, 'noIssuesFound') || 'No issues found in the current workflow.',
          timestamp: new Date(),
          metadata: { thinking: false }
        }])
      }
    } catch (e) {
      console.error('Failed to analyze workflow:', e)
    } finally {
      setIsAnalyzing(false)
    }
  }, [appSettings.pythonBackendUrl, appSettings.language, workflow])

  useEffect(() => {
    if (isVisible) {
        syncFromCanvas();
    }
  }, [isVisible, syncFromCanvas])

  // Compute the stable active session ID.
  const activeSessionId = useMemo(() => {
     const persistentId = getWorkflowId(workflow);
     return persistentId || sessionIdRef.current;
  }, [workflow, getWorkflowId]);

  // --- Load Chat History when backend enabled ---
  useEffect(() => {
    if (appSettings.usePythonBackend && appSettings.pythonBackendUrl && isVisible) {
        if (activeSessionId === lastLoadedSessionId.current || isProcessing) {
            return;
        }
        sessionIdRef.current = activeSessionId;

        const loadHistory = async () => {
            const hist = await fetchChatHistory(appSettings, activeSessionId);
            if (hist && hist.length > 0) {
                setMessages(prev => {
                     if (prev.length === 1 && prev[0].id === 'init-1') {
                         return hist;
                     }
                     const existingSignatures = new Set(prev.map(m => `${m.sender}:${m.text.trim()}`));
                     const newMsgs = hist.filter(h => {
                         const sig = `${h.sender}:${h.text.trim()}`;
                         return !existingSignatures.has(sig);
                     });
                     if (newMsgs.length === 0) return prev;
                     return [...prev, ...newMsgs].sort((a,b) => a.timestamp.getTime() - b.timestamp.getTime());
                });
            }
            lastLoadedSessionId.current = activeSessionId;
        };
        loadHistory();
    }
  }, [isVisible, appSettings.usePythonBackend, appSettings.pythonBackendUrl, activeSessionId, isProcessing]);

  // --- Effect: Update Initial Message when Language Changes ---
  useEffect(() => {
    setMessages((prev) => {
        if (prev.length === 1 && prev[0].id === 'init-1') {
            return [{
                ...prev[0],
                text: t(appSettings.language, 'welcome'),
                metadata: {
                    ...prev[0].metadata,
                    relatedQuestions: [
                        t(appSettings.language, 'initActionExplain'),
                        t(appSettings.language, 'initActionCheck')
                    ]
                }
            }];
        }
        return prev;
    });
  }, [appSettings.language]);

  // --- Widget Name Resolution ---
  const resolveWidgetNames = useCallback((node: ComfyNode): string[] => {
    if (typeof window === 'undefined') return [];
    const lg = (window as any).LiteGraph;
    if (!lg || !lg.registered_node_types) return [];
    
    const def = lg.registered_node_types[node.type];
    if (!def || !def.nodeData || !def.nodeData.input) return [];
    
    const inputs = def.nodeData.input;
    const required = inputs.required || {};
    const optional = inputs.optional || {};
    
    const slotNames = new Set((node.inputs || []).map(i => i.name));
    const widgetNames: string[] = [];
    
    Object.keys(required).forEach(name => {
        if (!slotNames.has(name)) widgetNames.push(name);
    });
    
    Object.keys(optional).forEach(name => {
        if (!slotNames.has(name)) widgetNames.push(name);
    });
    
    return widgetNames;
  }, []);

  // --- Event Listener for Runtime Exceptions ---
  useEffect(() => {
    const handleToggle = () => setIsVisible(prev => !prev)
    window.addEventListener("comfy-workflow-agent-toggle", handleToggle)

    let apiInstance: any = null;

    const handleExecutionError = (event: any) => {
        if (event.detail) {
            const { node_id, node_type, exception_message, exception_type, traceback, current_inputs } = event.detail;

            const newIssue: WorkflowIssue = {
                id: `exec-err-${Date.now()}`,
                nodeId: node_id ? parseInt(node_id) : null,
                severity: 'error',
                message: `${exception_type || 'Error'}: ${exception_message}`,
                fixSuggestion: t(appSettings.language, 'defaultFix'),
                nodeType: node_type,
                exceptionType: exception_type,
                traceback: traceback ? (Array.isArray(traceback) ? traceback.join('') : String(traceback)) : undefined,
                currentInputs: current_inputs,
                isRuntimeError: true,
                source: 'native',
            };
            setIssues(prev => [newIssue, ...prev]);
            
            setIsVisible(true);
            setVisualizerTab('analysis'); 
        }
    }

    const setupApiListener = async () => {
        try {
             // Try dynamic import for ComfyUI environment
             // @ts-ignore
             const module = await import("/scripts/api.js");
             apiInstance = module.api;
        } catch (e) {
             // Fallback for dev mode or if dynamic import fails
             if (app && app.api) {
                 apiInstance = app.api;
             } else if ((window as any).app && (window as any).app.api) {
                 apiInstance = (window as any).app.api;
             }
        }
        
        if (apiInstance) {
            apiInstance.addEventListener('execution_error', handleExecutionError);
        }
    };
    
    setupApiListener();

    return () => {
        window.removeEventListener("comfy-workflow-agent-toggle", handleToggle)
        if (apiInstance) {
            apiInstance.removeEventListener('execution_error', handleExecutionError);
        }
    }
  }, [app, appSettings.language]); 

  useEffect(() => {
     if (window.innerWidth > 1200) {
         setWindowPos({ x: window.innerWidth - 1000, y: 80 })
     }
  }, [])


  const applyToCanvas = (newWorkflow: any) => {
    if (app) {
      app.loadGraphData(newWorkflow)
      if (
        app.canvas &&
        newWorkflow.nodes &&
        newWorkflow.nodes.length > 0
      ) {
        const nodeId = newWorkflow.nodes[0].id
        const node = app.graph.getNodeById
          ? app.graph.getNodeById(Number(nodeId))
          : null
        if (node) {
          app.canvas.centerOnNode(node)
        }
      }
    }
  }

  const saveSettings = (newSettings: AppSettings) => {
    setAppSettings(newSettings)
    localStorage.setItem('comfy_copilot_settings', JSON.stringify(newSettings))
  }

  const handleManualUpdateWorkflow = (newWorkflow: ComfyWorkflow) => {
    setWorkflow(newWorkflow)
    applyToCanvas(newWorkflow)
  }

  // --- Window Drag Logic ---
  const handleMouseMove = useCallback((e: MouseEvent) => {
      if (!dragRef.current || !windowRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      
      windowRef.current.style.left = `${dragRef.current.startLeft + dx}px`;
      windowRef.current.style.top = `${dragRef.current.startTop + dy}px`;
  }, []);

  const handleMouseUp = useCallback((e: MouseEvent) => {
      if (dragRef.current) {
          const dx = e.clientX - dragRef.current.startX;
          const dy = e.clientY - dragRef.current.startY;
          setWindowPos({
              x: dragRef.current.startLeft + dx,
              y: dragRef.current.startTop + dy
          });
          dragRef.current = null;
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startLeft: windowPos.x,
          startTop: windowPos.y
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      e.preventDefault();
  };

  // --- Resize Logic ---
  const handleResizeMouseMove = useCallback((e: MouseEvent) => {
      if (!resizeRef.current || !windowRef.current) return;
      const dx = e.clientX - resizeRef.current.startX;
      const dy = e.clientY - resizeRef.current.startY;

      const newWidth = Math.max(600, resizeRef.current.startWidth + dx);
      const newHeight = Math.max(400, resizeRef.current.startHeight + dy);
      
      windowRef.current.style.width = `${newWidth}px`;
      windowRef.current.style.height = `${newHeight}px`;
  }, []);

  const handleResizeMouseUp = useCallback((e: MouseEvent) => {
      if (resizeRef.current) {
          const dx = e.clientX - resizeRef.current.startX;
          const dy = e.clientY - resizeRef.current.startY;
          const newWidth = Math.max(600, resizeRef.current.startWidth + dx);
          const newHeight = Math.max(400, resizeRef.current.startHeight + dy);

          const newSize = { width: newWidth, height: newHeight };
          setWindowSize(newSize);
          localStorage.setItem('comfy_copilot_size', JSON.stringify(newSize));
      }
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleResizeMouseMove);
      document.removeEventListener('mouseup', handleResizeMouseUp);
  }, [handleResizeMouseMove]);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      resizeRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startWidth: windowSize.width,
          startHeight: windowSize.height
      };
      document.addEventListener('mousemove', handleResizeMouseMove);
      document.addEventListener('mouseup', handleResizeMouseUp);
  };

  // --- Chat Logic ---
  const handleSendMessage = useCallback(
    async (overrideText?: string, overrideErrorLog?: string) => {
      const textToSend = overrideText || input
      if (!textToSend.trim() || isProcessing) return

      if (!appSettings.usePythonBackend && !appSettings.apiKey && appSettings.provider === 'custom') {
        setIsSettingsOpen(true)
        return
      }

      let currentWorkflow = workflow;
      if (app && app.graph) {
        const currentGraph = app.graph.serialize()
        currentWorkflow = currentGraph as unknown as ComfyWorkflow
        setWorkflow(currentWorkflow)
        let ctx = collectWorkflowContext()
        try {
          ctx = await collectWorkflowContextAsync()
        } catch { /* use sync fallback */ }
        setWorkflowContext(ctx)

        const ctxIssues = contextErrorsToIssues(ctx).map(i => ({ ...i, source: 'native' as const }))
        if (ctxIssues.length > 0) {
          setIssues(prev => {
            const nativeIds = new Set(prev.filter(i => i.source === 'native').map(i => i.id))
            const newIssues = ctxIssues.filter(i => !nativeIds.has(i.id))
            const agentIssues = prev.filter(i => i.source === 'agent')
            return [...newIssues, ...agentIssues]
          })
        } else {
          setIssues(prev => prev.filter(i => i.source !== 'native'))
        }
      }

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        sender: Sender.USER,
        text: textToSend,
        timestamp: new Date()
      }

      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setIsProcessing(true)
      setCurrentStatus(null)
      setActivityTimeline([])

      // Create placeholder AI message
      const aiMsgId = (Date.now() + 1).toString()
      const initialAiMsg: ChatMessage = {
          id: aiMsgId,
          sender: Sender.AI,
          text: '',
          timestamp: new Date(),
          metadata: { thinking: true }
      }
      setMessages((prev) => [...prev, initialAiMsg])
      
      let errorLog = overrideErrorLog;
      if (!errorLog) {
          const activeErrors = issues
            .filter(i => i.severity === 'error')
            .map(i => `Node ${i.nodeId}: ${i.message}`)
            .join('\n');
          errorLog = activeErrors.length > 0 ? activeErrors : "";
      }
      
      const persistentId = getWorkflowId(currentWorkflow);
      let effectiveSessionId = sessionIdRef.current;
      
      if (persistentId) {
          effectiveSessionId = persistentId;
          sessionIdRef.current = persistentId;
          if (lastLoadedSessionId.current !== persistentId) {
              lastLoadedSessionId.current = persistentId;
          }
      }

      let accumulatedText = "";

      try {
        const historyText = messages
          .slice(-5)
          .map((m) => `${m.sender}: ${m.text}`)

        const response = await sendMessageToComfyAgent(
          currentWorkflow,
          textToSend,
          appSettings,
          historyText,
          effectiveSessionId,
          errorLog,
          _workflowContext ? formatWorkflowContextForPrompt(_workflowContext) : null,
          (chunk) => {
              accumulatedText += chunk;
              setMessages((prev) => prev.map((m) => 
                  m.id === aiMsgId 
                  ? { ...m, text: accumulatedText, metadata: { ...m.metadata, thinking: false } }
                  : m
              ));
          },
          (status) => {
             setCurrentStatus(status);
          },
          (approvalReq) => {
             setPendingApproval(approvalReq);
          },
          (inputReq) => {
             setPendingHumanInput(inputReq);
          },
          (toolInfo) => {
             setActiveToolCalls(prev => {
                 const existing = prev.findIndex(tc => tc.toolUseId === toolInfo.toolUseId)
                 if (existing !== -1) {
                     const updated = [...prev]
                     updated[existing] = { ...updated[existing], ...toolInfo }
                     return updated
                 }
                 return [...prev, toolInfo]
             });
          },
          (toolInfo) => {
             setActiveToolCalls(prev => prev.map(tc => 
               tc.toolUseId === toolInfo.toolUseId ? { ...tc, status: 'completed' as const } : tc
             ));
          },
          (activity) => {
             setActivityTimeline(prev => {
                 const updated = [...prev]

                 if (activity.type === 'tool_start') {
                     const existingIdx = updated.findIndex(a => a.type === 'tool_start' && a.toolName === activity.toolName && a.status === 'processing')
                     if (existingIdx !== -1) {
                         return updated
                     }
                     const prevProcessing = updated.findIndex(a => a.status === 'processing' && (a.type === 'status' || a.type === 'thinking'))
                     if (prevProcessing !== -1) {
                         updated[prevProcessing] = { ...updated[prevProcessing], status: 'done', duration: activity.timestamp - updated[prevProcessing].timestamp }
                     }
                 }

                 if (activity.type === 'tool_result') {
                     const startIdx = updated.findIndex(a => a.type === 'tool_start' && a.toolName === activity.toolName && a.status === 'processing')
                     if (startIdx !== -1) {
                         updated[startIdx] = { ...updated[startIdx], status: 'done', duration: activity.timestamp - updated[startIdx].timestamp }
                     }
                 }

                 return [...updated, activity]
             })
          },
          (usage) => {
             setTokenUsage(usage)
          }
        )

        // Final Update after processing
        if (response.updatedWorkflow) {
          setWorkflow(response.updatedWorkflow)
          applyToCanvas(response.updatedWorkflow)
        }

        const currentAgentIssues = (response.issues && response.issues.length > 0)
            ? response.issues.map(i => ({ ...i, source: 'agent' as const }))
            : [];

        if (currentAgentIssues.length > 0) {
            setIssues(prev => [...prev.filter(i => i.source !== 'agent'), ...currentAgentIssues]);
        } else {
            setIssues(prev => prev.filter(i => i.source !== 'agent'));
        }

        setMessages((prev) => prev.map((m) => 
            m.id === aiMsgId 
            ? {
                ...m,
                text: response.chatResponse, 
                metadata: {
                    workflowUpdate: !!response.updatedWorkflow,
                    missingNodes: response.missingNodes,
                    relatedQuestions: response.relatedQuestions,
                    groundingSources: response.groundingSources,
                    provider: appSettings.usePythonBackend ? 'Python Backend' : appSettings.provider,
                    agentIssues: currentAgentIssues.length > 0 ? currentAgentIssues : undefined
                }
            }
            : m
        ))

      } catch (error) {
        console.error(error)
        const errorMsg: ChatMessage = {
          id: (Date.now() + 2).toString(),
          sender: Sender.SYSTEM,
          text: 'Error: ' + (error as Error).message,
          timestamp: new Date()
        }
        setMessages((prev) => [...prev, errorMsg])
        setMessages((prev) => prev.filter(m => m.id !== aiMsgId || m.text.length > 0))
      } finally {
        setIsProcessing(false)
        setCurrentStatus(null)
        setActiveToolCalls([])
      }
    },
    [
      input,
      isProcessing,
      messages,
      workflow,
      appSettings,
      app,
      issues,
      getWorkflowId
    ]
  )

  const handleActionClick = (action: string) => handleSendMessage(action)
  
  const handleSendErrorsToAi = (selectedIssues: WorkflowIssue[]) => {
      const errorDetails = selectedIssues.map(issue => {
          let detail = `- Error: ${issue.message}`
          if (issue.nodeType) detail += `\n  Node Type: ${issue.nodeType}`
          if (issue.nodeId != null) detail += `\n  Node ID: ${issue.nodeId}`
          if (issue.exceptionType) detail += `\n  Exception Type: ${issue.exceptionType}`
          if (issue.traceback) detail += `\n  Traceback:\n${issue.traceback}`
          if (issue.currentInputs) detail += `\n  Current Inputs: ${JSON.stringify(issue.currentInputs, null, 2)}`
          return detail
      }).join('\n\n')

      const prompt = `Please fix the following runtime error(s):\n\n${errorDetails}`
      handleSendMessage(prompt, errorDetails)
  }

  const handleResolveIssue = (issue: WorkflowIssue) => {
      let prompt = `Please fix this issue: ${issue.message}`
      if (issue.nodeType) prompt += `\nNode Type: ${issue.nodeType}`
      if (issue.nodeId != null) prompt += `\nNode ID: ${issue.nodeId}`
      if (issue.exceptionType) prompt += `\nException Type: ${issue.exceptionType}`
      if (issue.traceback) prompt += `\nTraceback:\n${issue.traceback}`
      if (issue.currentInputs) prompt += `\nCurrent Inputs: ${JSON.stringify(issue.currentInputs, null, 2)}`
      if (issue.fixSuggestion) prompt += `\nSuggested Fix: ${issue.fixSuggestion}`
      handleSendMessage(prompt)
  }

  const handleDownloadModel = (modelName: string, modelFolder?: string) => {
      let prompt = `The model "${modelName}" is missing. Please help me download it.`
      if (modelFolder) {
          prompt += ` It should be placed in the "${modelFolder}" folder.`
      }
      prompt += ` Try using huggingface-cli or wget from https://hf-mirror.com/ to download it to the correct ComfyUI models directory.`
      handleSendMessage(prompt)
  }
  
  const isConfigured = appSettings.usePythonBackend 
    ? !!appSettings.pythonBackendUrl && !!appSettings.activeBackendConfigId
    : (appSettings.provider === 'google' || !!appSettings.apiKey);

  if (!isVisible) return null;

  return (
    <div
        id="comfy-workflow-agent-window"
        ref={windowRef}
        className="flex flex-col overflow-hidden bg-slate-950 border border-slate-700 shadow-2xl rounded-xl transition-opacity duration-75"
        style={{
            position: 'fixed',
            left: windowPos.x,
            top: windowPos.y,
            width: isMinimized ? '300px' : `${windowSize.width}px`,
            height: isMinimized ? 'auto' : `${windowSize.height}px`,
            zIndex: 10001,
            pointerEvents: 'auto'
        }}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
    >
        {isDragOver && (
            <div className="absolute inset-0 z-[60] bg-indigo-500/20 backdrop-blur-sm border-2 border-dashed border-indigo-400 rounded-xl flex flex-col items-center justify-center gap-3 pointer-events-none">
                <div className="w-16 h-16 bg-indigo-500/30 rounded-2xl flex items-center justify-center">
                    <FileJson size={32} className="text-indigo-300" />
                </div>
                <div className="text-indigo-200 font-bold text-sm">{t(appSettings.language, 'dragDropHint')}</div>
                <div className="text-indigo-400/70 text-xs">{t(appSettings.language, 'dragDropHintSub')}</div>
            </div>
        )}
        {dragError && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 bg-red-500/90 text-white text-xs font-medium rounded-lg shadow-lg">
                {dragError}
            </div>
        )}
        {/* Window Header */}
        <div
            onMouseDown={handleMouseDown}
            className="bg-slate-900 border-b border-slate-800 p-3 flex items-center justify-between cursor-move select-none group flex-shrink-0"
        >
            <div className="flex items-center gap-3">
                <div className="text-slate-500 group-hover:text-slate-300 transition-colors">
                    <GripHorizontal size={18} />
                </div>
                <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full animate-pulse ${
                      appSettings.usePythonBackend
                        ? backendOnline === false ? 'bg-red-500' : backendOnline === true ? 'bg-emerald-500' : 'bg-yellow-500'
                        : 'bg-indigo-500'
                    }`}></div>
                    <span className="font-bold text-slate-200 text-sm">{t(appSettings.language, 'appName')}</span>
                </div>
            </div>
            <div className="flex items-center gap-2 text-slate-400">
                {!isMinimized && (
                    <>
                        {appSettings.usePythonBackend && (
                            <>
                                <button
                                    onClick={handleAnalyzeWorkflow}
                                    className={`p-1 hover:text-cyan-400 transition-colors ${isAnalyzing ? 'animate-pulse text-cyan-400' : ''}`}
                                    title="Analyze Workflow"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    disabled={isAnalyzing}
                                >
                                    <SearchCheck size={14} />
                                </button>
                                <button
                                    onClick={handleUndoAction}
                                    className="p-1 hover:text-amber-400 transition-colors"
                                    title="Undo Last Action"
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <Undo2 size={14} />
                                </button>
                            </>
                        )}
                        <button
                            onClick={syncFromCanvas}
                            className="p-1 hover:text-indigo-400 transition-colors"
                            title="Sync from Canvas"
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <RefreshCw size={14} />
                        </button>
                    </>
                )}
                <button
                    onClick={() => setIsMinimized(!isMinimized)}
                    className="p-1 hover:text-white transition-colors"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    {isMinimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
                </button>
                <button
                    onClick={() => setIsVisible(false)}
                    className="p-1 hover:text-red-400 transition-colors"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <X size={14} />
                </button>
            </div>
        </div>

        {!isMinimized && (
            <>
                <div className="flex-1 flex flex-col overflow-hidden relative">
                    <SettingsModal
                        isOpen={isSettingsOpen}
                        onClose={() => setIsSettingsOpen(false)}
                        currentSettings={appSettings}
                        onSave={saveSettings}
                    />

                    <div className="flex-1 overflow-hidden relative flex flex-row">
                        {/* Left: Chat Panel (35%) */}
                        <div className="w-[35%] min-w-[300px] border-r border-slate-800 flex flex-col bg-slate-950">
                            <ChatPanel
                                messages={messages}
                                input={input}
                                setInput={setInput}
                                onSend={() => handleSendMessage()}
                                isProcessing={isProcessing}
                                currentStatus={currentStatus}
                                activityTimeline={activityTimeline}
                                onActionClick={handleActionClick}
                                language={appSettings.language}
                                pendingApproval={pendingApproval}
                                pendingHumanInput={pendingHumanInput}
                                onApprovalResponse={handleApprovalResponse}
                                onHumanInputResponse={handleHumanInputResponse}
                                tokenUsage={tokenUsage}
                            />

                            {activeToolCalls.length > 0 && (
                                <div className="px-3 py-2 border-t border-slate-800 bg-slate-900/50">
                                    {activeToolCalls.map((tc, i) => (
                                        <div key={tc.toolUseId ?? i} className="flex items-center gap-2 text-xs text-slate-400 py-0.5">
                                            <div className={`w-1.5 h-1.5 rounded-full ${tc.status === 'running' ? 'bg-yellow-400 animate-pulse' : tc.status === 'completed' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                                            <span>{tc.toolName}</span>
                                            <span className="text-slate-600">{tc.status === 'running' ? '...' : '✓'}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Right: Visualizer (Remaining space) */}
                        <div className="flex-1 flex flex-col bg-slate-900 relative min-w-0">
                            <WorkflowVisualizer
                                workflow={workflow}
                                language={appSettings.language}
                                onOpenSettings={() => setIsSettingsOpen(true)}
                                isConfigured={isConfigured}
                                onUpdateWorkflow={handleManualUpdateWorkflow}
                                onAskAi={handleSendMessage}
                                issues={issues}
                                resolveWidgetNames={resolveWidgetNames}
                                activeTab={visualizerTab}
                                onTabChange={setVisualizerTab}
                                onSendErrorsToAi={handleSendErrorsToAi}
                                onResolveIssue={handleResolveIssue}
                                onDownloadModel={handleDownloadModel}
                                backendUrl={appSettings.pythonBackendUrl}
                            />
                        </div>
                    </div>
                </div>

                {/* Resize Handle */}
                <div
                    onMouseDown={handleResizeMouseDown}
                    className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize z-50 flex items-center justify-center text-slate-600 hover:text-indigo-400 transition-colors"
                >
                    <Scaling size={12} className="transform rotate-90" />
                </div>
            </>
        )}
    </div>
  )
}

export default App