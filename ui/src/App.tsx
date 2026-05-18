

import { GripHorizontal, Maximize2, Minimize2, RefreshCw, X, Scaling, AlertTriangle, MessageCircle, Undo2, SearchCheck } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import ChatPanel from './components/ChatPanel'
import SettingsModal from './components/SettingsModal'
import WorkflowVisualizer from './components/WorkflowVisualizer'
import { DEFAULT_WORKFLOW } from './constants'
import { sendMessageToComfyAgent, fetchChatHistory } from './services/aiService'
import { submitUserInput, checkBackendHealth, undoAction, analyzeWorkflow, fetchBackendConfigs } from './services/configService'
import { AppSettings, ChatMessage, ComfyNode, ComfyWorkflow, Sender, WorkflowIssue, VisualizerTab, AgentStatus, ApprovalRequest, HumanInputRequest, ToolCallInfo } from './types'
import { t } from './utils/i18n'

interface AppProps {
  displayMode?: 'floating' | 'sidebar'
}

function HumanInputField({ onSubmit, placeholder }: { onSubmit: (value: string) => void; placeholder?: string }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && value.trim()) { onSubmit(value.trim()); setValue('') } }}
        placeholder={placeholder ?? 'Type your response...'}
        className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <button
        onClick={() => { if (value.trim()) { onSubmit(value.trim()); setValue('') } }}
        className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors"
      >
        Send
      </button>
    </div>
  )
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [pendingHumanInput, setPendingHumanInput] = useState<HumanInputRequest | null>(null)
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([])
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null)

  // --- ComfyUI Integration Hooks ---
  const app = (window as any).app;

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
      
      const persistentId = getWorkflowId(graphData);
      if (persistentId) {
          sessionIdRef.current = persistentId;
      }
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
        }))
        setIssues(mappedIssues)
        setVisualizerTab('analysis')
      } else {
        setIssues([])
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
             setActiveToolCalls(prev => [...prev, toolInfo]);
          },
          (toolInfo) => {
             setActiveToolCalls(prev => prev.map(tc => 
               tc.toolUseId === toolInfo.toolName ? { ...tc, status: 'completed' as const } : tc
             ));
          }
        )

        // Final Update after processing
        if (response.updatedWorkflow) {
          setWorkflow(response.updatedWorkflow)
          applyToCanvas(response.updatedWorkflow)
        }

        if (response.issues && response.issues.length > 0) {
            setIssues(response.issues);
            setVisualizerTab('analysis');
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
                    provider: appSettings.usePythonBackend ? 'Python Backend' : appSettings.provider
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
    >
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
                                onActionClick={handleActionClick}
                                language={appSettings.language}
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

                            {pendingApproval && (
                                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4">
                                    <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-sm w-full shadow-2xl">
                                        <div className="flex items-center gap-2 mb-3">
                                            <div className="w-8 h-8 bg-amber-500/20 rounded-lg flex items-center justify-center">
                                                <AlertTriangle className="w-4 h-4 text-amber-400" />
                                            </div>
                                            <h3 className="text-sm font-bold text-amber-200">Approval Required</h3>
                                        </div>
                                        <p className="text-xs text-slate-300 mb-2">{pendingApproval.message}</p>
                                        <p className="text-xs text-slate-500 mb-4">Tool: {pendingApproval.toolName}</p>
                                        {pendingApproval.suggestions && pendingApproval.suggestions.length > 0 && (
                                            <div className="mb-3 text-xs text-slate-400">
                                                <span className="font-medium">Suggestions:</span>
                                                <ul className="mt-1 space-y-1">
                                                    {pendingApproval.suggestions.map((s, i) => (
                                                        <li key={i} className="pl-2 border-l border-slate-700">• {s}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleApprovalResponse('deny')}
                                                className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-lg transition-colors"
                                            >
                                                Deny
                                            </button>
                                            <button
                                                onClick={() => handleApprovalResponse('allow')}
                                                className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors"
                                            >
                                                Allow
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {pendingHumanInput && (
                                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4">
                                    <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-sm w-full shadow-2xl">
                                        <div className="flex items-center gap-2 mb-3">
                                            <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center">
                                                <MessageCircle className="w-4 h-4 text-blue-400" />
                                            </div>
                                            <h3 className="text-sm font-bold text-blue-200">Input Required</h3>
                                        </div>
                                        <p className="text-xs text-slate-300 mb-2">{pendingHumanInput.message}</p>
                                        {pendingHumanInput.context && (
                                            <p className="text-xs text-slate-500 mb-3">{pendingHumanInput.context}</p>
                                        )}
                                        {pendingHumanInput.options && pendingHumanInput.options.length > 0 ? (
                                            <div className="space-y-2 mb-3">
                                                {pendingHumanInput.options.map((opt, i) => (
                                                    <button
                                                        key={i}
                                                        onClick={() => handleHumanInputResponse(opt.value, opt.value)}
                                                        className="w-full text-left px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs text-slate-200 transition-colors"
                                                    >
                                                        <span className="font-medium">{opt.label}</span>
                                                        {opt.description && <span className="text-slate-500 ml-2">- {opt.description}</span>}
                                                    </button>
                                                ))}
                                            </div>
                                        ) : null}
                                        {pendingHumanInput.allowFreeText && (
                                            <HumanInputField onSubmit={handleHumanInputResponse} placeholder={pendingHumanInput.placeholder} />
                                        )}
                                    </div>
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