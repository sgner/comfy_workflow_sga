import {
  AlertTriangle,
  Bot,
  Globe,
  Hammer,
  Loader2,
  Send,
  Sparkles,
  User,
  HelpCircle,
  Bug,
  Info,
  AlertCircle,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  Brain,
  Wrench,
  CheckCircle2,
  XCircle,
  Clock,
  MessageCircle,
  Shield,
  Terminal,
  Eye,
  Zap
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ChatMessage, Language, Sender, AgentStatus, AgentActivity, WorkflowIssue, ApprovalRequest, HumanInputRequest, TokenUsage } from '../types'
import { t } from '../utils/i18n'
import { ComputerUseToggle } from './ComputerUseToggle'
import { AutopilotStepFlow } from './AutopilotStepFlow'
import { useComputerUseRunEvents } from '../hooks/useComputerUseRunEvents'
import { stopComputerUse } from '../services/configService'

const markdownComponents = {
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match && !className?.includes('language-')
    if (isInline) {
      return <code className={className} {...props}>{children}</code>
    }
    const codeString = String(children).replace(/\n$/, '')
    const lines = codeString.split('\n')
    return (
      <div className="code-block-wrapper">
        <div className="code-block-header">
          <span className="code-lang">{match ? match[1] : 'text'}</span>
        </div>
        <div className="code-block-body">
          <div className="line-numbers">
            {lines.map((_, i) => (
              <span key={i} className="line-number">{i + 1}</span>
            ))}
          </div>
          <pre className="code-pre"><code className={className} {...props}>{children}</code></pre>
        </div>
      </div>
    )
  }
}

interface ChatMessageItemProps {
  msg: ChatMessage
  isStreamingAi: boolean
  streamingText: string
  language: Language
  onActionClick: (action: string) => void
}

const ChatMessageItem = React.memo(function ChatMessageItem({
  msg,
  isStreamingAi,
  streamingText,
  language,
  onActionClick
}: ChatMessageItemProps) {
  const displayText = isStreamingAi ? streamingText : msg.text

  return (
    <div className={`flex gap-3 ${msg.sender === Sender.USER ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
          ${msg.sender === Sender.USER ? 'bg-slate-700' : 'bg-indigo-600'}`}
      >
        {msg.sender === Sender.USER ? <User size={16} /> : <Bot size={16} />}
      </div>

      <div className={`flex flex-col max-w-[85%] min-w-0 ${msg.sender === Sender.USER ? 'items-end' : 'items-start'}`}>
        {displayText && displayText.trim() ? (
          <div
            className={`p-2.5 rounded-2xl text-sm leading-normal shadow-sm break-words max-w-full
              ${msg.sender === Sender.USER
                ? 'bg-slate-700 text-slate-100 rounded-tr-none'
                : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700/50'}`}
          >
            {isStreamingAi ? (
              <pre className="whitespace-pre-wrap font-sans m-0 p-0 bg-transparent text-inherit text-sm leading-normal">{displayText}</pre>
            ) : (
              <div className="markdown-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {displayText}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : null}

        {msg.sender === Sender.AI && (
          <div className="mt-2 space-y-2 w-full">
            {msg.metadata?.interrupted && (
              <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-900/20 border border-amber-700/30 rounded-lg px-2.5 py-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{t(language, 'sessionSwitched')}</span>
              </div>
            )}
            {msg.metadata?.agentIssues && msg.metadata.agentIssues.length > 0 && (
              <AgentIssuesCard issues={msg.metadata.agentIssues} language={language} />
            )}
            {msg.metadata?.groundingSources && msg.metadata.groundingSources.length > 0 && (
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-2">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-400 uppercase tracking-wider mb-1.5 font-semibold">
                  <Globe className="w-3 h-3" />
                  <span>{t(language, 'groundingSources')}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {msg.metadata.groundingSources.slice(0, 3).map((source, idx) => (
                    <a key={idx} href={source.uri} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline truncate block">
                      • {source.title}
                    </a>
                  ))}
                </div>
              </div>
            )}
            {msg.metadata?.missingNodes && msg.metadata.missingNodes.length > 0 && (
              <div className="bg-amber-950/30 border border-amber-900/50 rounded-lg p-3 text-xs text-amber-200 flex gap-2 items-start">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold mb-1">{t(language, 'missingNodes')}:</p>
                  <ul className="list-disc list-inside opacity-80">
                    {msg.metadata.missingNodes.map((node, i) => <li key={i}>{node}</li>)}
                  </ul>
                </div>
              </div>
            )}
            {msg.metadata?.relatedQuestions && msg.metadata.relatedQuestions.length > 0 && (
              <div className="mt-3 pt-2 border-t border-slate-700/50">
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-2 font-semibold flex items-center gap-1.5">
                  <HelpCircle className="w-3 h-3" />
                  {t(language, 'relatedQuestions')}
                </p>
                <div className="flex flex-col gap-2">
                  {msg.metadata.relatedQuestions.map((q, i) => (
                    <button key={i} onClick={() => onActionClick(q)}
                      className="text-left text-xs text-indigo-300 hover:text-indigo-200 hover:bg-slate-800/50 p-2 rounded transition-colors border border-transparent hover:border-slate-700">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msg.metadata?.workflowUpdate && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 mt-1 pl-1">
                <Hammer className="w-3 h-3" />
                <span>{t(language, 'workflowUpdated')}</span>
              </div>
            )}
          </div>
        )}

        <span className="text-[10px] text-slate-500 mt-1 px-1">
          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}, (prev, next) => {
  if (prev.msg.id !== next.msg.id) return false
  if (prev.isStreamingAi !== next.isStreamingAi) return false
  if (prev.isStreamingAi && prev.streamingText !== next.streamingText) return false
  if (prev.msg.text !== next.msg.text) return false
  if (prev.msg.metadata !== next.msg.metadata) return false
  if (prev.msg.sender !== next.msg.sender) return false
  if (prev.language !== next.language) return false
  return true
})

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string) => void
  isProcessing: boolean
  streamingText: string
  currentStatus: AgentStatus | null
  activityTimeline: AgentActivity[]
  onActionClick: (action: string) => void
  language: Language
  pendingApproval: ApprovalRequest | null
  pendingHumanInput: HumanInputRequest | null
  onApprovalResponse: (decision: 'allow' | 'deny') => void
  onHumanInputResponse: (value: string, optionValue?: string) => void
  tokenUsage: TokenUsage | null
  activeAgent?: 'sga' | 'codex'
  onAgentSwitch?: (target: 'sga' | 'codex') => void
  codexSwitchDisabled?: boolean
  codexSwitchReason?: string
  backendUrl?: string
}

const ChatPanel: React.FC<ChatPanelProps> = React.memo(({
  messages,
  onSend,
  isProcessing,
  streamingText,
  currentStatus,
  activityTimeline,
  onActionClick,
  language,
  pendingApproval,
  pendingHumanInput,
  onApprovalResponse,
  onHumanInputResponse,
  tokenUsage,
  activeAgent = 'sga',
  onAgentSwitch,
  codexSwitchDisabled = false,
  codexSwitchReason,
  backendUrl
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [humanInputValue, setHumanInputValue] = useState('')

  const autopilot = useComputerUseRunEvents(backendUrl ?? '')

  useEffect(() => {
    if (backendUrl) {
      autopilot.connect()
    }
  }, [backendUrl])

  const isAutoScrollRef = useRef(true)
  const scrollRafRef = useRef<number>(0)

  const scheduleScrollToBottom = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      if (scrollRef.current && isAutoScrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [])

  useEffect(() => {
    scheduleScrollToBottom()
  }, [messages.length, streamingText, currentStatus, scheduleScrollToBottom])

  useEffect(() => {
    if (pendingApproval && approvalRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        approvalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  }, [pendingApproval])

  useEffect(() => {
    if (pendingHumanInput && approvalRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        approvalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  }, [pendingHumanInput])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      isAutoScrollRef.current = atBottom
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }, [input, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const lastAiMsgIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender === Sender.AI) return i
    }
    return -1
  }, [messages])

  const isLastAiStreaming = isProcessing && streamingText.length > 0 && lastAiMsgIdx >= 0

  const memoizedActivityTimeline = useMemo(() => activityTimeline.slice(-12), [activityTimeline])

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700/50 relative min-w-0">
      <div className="p-4 border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-100">{t(language, 'appName')}</h2>
              <p className="text-xs text-slate-400">{t(language, 'appSubtitle')}</p>
            </div>
          </div>
          {onAgentSwitch && (
            <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5 border border-slate-700/50">
              <button
                onClick={() => onAgentSwitch('sga')}
                disabled={isProcessing}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  activeAgent === 'sga'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={t(language, 'useSgaBackend')}
              >
                SGA
              </button>
              <button
                onClick={() => onAgentSwitch('codex')}
                disabled={isProcessing || codexSwitchDisabled}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  activeAgent === 'codex'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={codexSwitchDisabled ? codexSwitchReason : t(language, 'useCodexBackend')}
              >
                Codex
              </button>
            </div>
          )}
          {backendUrl && (
            <ComputerUseToggle backendUrl={backendUrl} />
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 min-h-0 custom-scrollbar">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-slate-500 space-y-4">
            <Sparkles className="w-12 h-12 opacity-20" />
            <p className="whitespace-pre-wrap max-w-xs">{t(language, 'welcome')}</p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <ChatMessageItem
            key={msg.id}
            msg={msg}
            isStreamingAi={isLastAiStreaming && idx === lastAiMsgIdx && msg.sender === Sender.AI}
            streamingText={streamingText}
            language={language}
            onActionClick={onActionClick}
          />
        ))}

        {(autopilot.steps.length > 0 || autopilot.isActive) && (
          <AutopilotStepFlow
            steps={autopilot.steps}
            isActive={autopilot.isActive}
            onStop={async () => {
              try {
                await stopComputerUse(backendUrl ?? '')
                autopilot.disconnect()
              } catch (e) {
                console.error('Stop failed:', e)
              }
            }}
          />
        )}

        {isProcessing && memoizedActivityTimeline.length > 0 && (
          <div className="mx-3 my-3 rounded-lg bg-slate-800/60 border border-slate-700/40 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-slate-700/30 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{t(language, 'agentActivity')}</span>
            </div>
            <div className="px-3 py-2 space-y-0 max-h-48 overflow-y-auto">
              {memoizedActivityTimeline.map((activity, idx) => {
                const isLast = idx === memoizedActivityTimeline.length - 1
                return (
                  <div key={activity.id} className="flex items-start gap-2 py-0.5">
                    <div className="flex flex-col items-center flex-shrink-0 mt-0.5">
                      <ActivityIcon type={activity.type} status={activity.status} />
                      {!isLast && <div className="w-px h-3 bg-slate-700/50 mt-0.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[11px] ${activity.status === 'error' ? 'text-red-300' : activity.status === 'done' ? 'text-slate-400' : 'text-slate-200'} truncate`}>
                          {activity.label}
                        </span>
                        {activity.duration != null && (
                          <span className="text-[9px] text-slate-500 flex-shrink-0">{(activity.duration / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                      {activity.toolInput && Object.keys(activity.toolInput).length > 0 && (
                        <ToolInputPreview input={activity.toolInput} language={language} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {isProcessing && !activityTimeline.length && currentStatus && (
          <div className="flex justify-center w-full my-4 animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-slate-800/80 backdrop-blur-md border border-indigo-500/30 rounded-full px-5 py-2 flex items-center gap-3 shadow-lg max-w-[90%]">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 flex-shrink-0" />
              <span className="text-xs font-medium text-indigo-100 truncate">{currentStatus.displayText}</span>
            </div>
          </div>
        )}

        {pendingApproval && (
          <div ref={approvalRef} className="mx-3 my-3 rounded-lg border overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-lg shadow-amber-900/20"
            style={{ borderColor: pendingApproval.isDestructive ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.3)', backgroundColor: pendingApproval.isDestructive ? 'rgba(127,29,29,0.2)' : 'rgba(120,53,15,0.15)' }}>
            <div className="px-3 py-2 border-b flex items-center justify-between"
              style={{ borderColor: pendingApproval.isDestructive ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)' }}>
              <div className="flex items-center gap-2">
                {pendingApproval.isDestructive ? (
                  <Zap className="w-3.5 h-3.5 text-red-400 animate-pulse" />
                ) : pendingApproval.isReadOnly ? (
                  <Eye className="w-3.5 h-3.5 text-blue-400" />
                ) : (
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span className="text-[11px] font-semibold"
                  style={{ color: pendingApproval.isDestructive ? '#f87171' : pendingApproval.isReadOnly ? '#60a5fa' : '#fbbf24' }}>
                  {pendingApproval.isDestructive
                    ? t(language, 'approvalRequired') + ' ⚠️'
                    : t(language, 'approvalRequired')}
                </span>
              </div>
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                pendingApproval.isDestructive
                  ? 'bg-red-500/20 text-red-300 border-red-500/30'
                  : pendingApproval.isReadOnly
                  ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
              }`}>
                {pendingApproval.isDestructive ? t(language, 'destructiveBadge') : pendingApproval.isReadOnly ? t(language, 'readOnly') : t(language, 'reviewBadge')}
              </span>
            </div>
            <div className="px-3 py-2 space-y-2.5">
              <p className="text-xs text-slate-300 leading-relaxed">{pendingApproval.message}</p>
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3 h-3 text-slate-500 flex-shrink-0" />
                <span className="text-[10px] text-slate-500">{t(language, 'approvalTool')}:</span>
                <span className="text-[10px] font-mono font-semibold text-slate-300">{pendingApproval.toolName}</span>
              </div>
              {pendingApproval.toolInput && Object.keys(pendingApproval.toolInput).length > 0 && (
                <ApprovalToolInput toolName={pendingApproval.toolName} toolInput={pendingApproval.toolInput} language={language} />
              )}
              {pendingApproval.suggestions && pendingApproval.suggestions.length > 0 && (
                <div className="text-[10px] text-slate-400">
                  <span className="font-medium">{t(language, 'approvalSuggestions')}:</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {pendingApproval.suggestions.map((s, i) => (
                      <span key={i} className="px-2 py-0.5 bg-slate-800/80 border border-slate-700/50 rounded text-[9px] text-slate-300">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button onClick={() => onApprovalResponse('deny')}
                  className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5" />
                  {t(language, 'approvalDeny')}
                </button>
                <button onClick={() => onApprovalResponse('allow')}
                  className={`flex-1 px-3 py-2 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                    pendingApproval.isDestructive
                      ? 'bg-red-600 hover:bg-red-500'
                      : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t(language, 'approvalAllow')}
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingHumanInput && (
          <div ref={pendingApproval ? undefined : approvalRef} className="mx-3 my-3 rounded-lg border border-blue-500/30 bg-blue-950/20 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-lg shadow-blue-900/20">
            <div className="px-3 py-2 border-b border-blue-500/20 flex items-center gap-2">
              <MessageCircle className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
              <span className="text-[11px] font-semibold text-blue-300">{t(language, 'inputRequired')}</span>
            </div>
            <div className="px-3 py-2 space-y-2">
              <p className="text-xs text-slate-300">{pendingHumanInput.message}</p>
              {pendingHumanInput.context && (
                <p className="text-[10px] text-slate-500">{pendingHumanInput.context}</p>
              )}
              {pendingHumanInput.options && pendingHumanInput.options.length > 0 && (
                <div className="space-y-1.5">
                  {pendingHumanInput.options.map((opt, i) => (
                    <button key={i} onClick={() => onHumanInputResponse(opt.value, opt.value)}
                      className="w-full text-left px-3 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs text-slate-200 transition-colors">
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && <span className="text-slate-500 ml-2">- {opt.description}</span>}
                    </button>
                  ))}
                </div>
              )}
              {pendingHumanInput.allowFreeText && (
                <div className="flex gap-2 pt-1">
                  <input type="text" value={humanInputValue}
                    onChange={e => setHumanInputValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && humanInputValue.trim()) { onHumanInputResponse(humanInputValue.trim()); setHumanInputValue('') } }}
                    placeholder={t(language, 'humanInputPlaceholder')}
                    className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    autoFocus />
                  <button onClick={() => { if (humanInputValue.trim()) { onHumanInputResponse(humanInputValue.trim()); setHumanInputValue('') } }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors">
                    {t(language, 'inputSend')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {tokenUsage && (tokenUsage.totalTokens > 0 || tokenUsage.totalCostUsd > 0) && (
        <div className="px-4 py-1.5 bg-slate-900/80 border-t border-slate-800/50 flex items-center justify-between text-[10px] text-slate-500">
          <div className="flex items-center gap-3">
            <span>{t(language, 'usageInput')}: {tokenUsage.inputTokens.toLocaleString()}</span>
            <span>{t(language, 'usageOutput')}: {tokenUsage.outputTokens.toLocaleString()}</span>
            {tokenUsage.cacheReadInputTokens > 0 && <span>{t(language, 'usageCacheRead')}: {tokenUsage.cacheReadInputTokens.toLocaleString()}</span>}
            {tokenUsage.cacheCreationInputTokens > 0 && <span>{t(language, 'usageCacheWrite')}: {tokenUsage.cacheCreationInputTokens.toLocaleString()}</span>}
          </div>
          <div className="flex items-center gap-3">
            <span>{t(language, 'usageTotal')}: {tokenUsage.totalTokens.toLocaleString()}</span>
            {tokenUsage.totalCostUsd > 0 && <span className="text-emerald-500/70">${tokenUsage.totalCostUsd.toFixed(4)}</span>}
          </div>
        </div>
      )}

      <div className="p-4 bg-slate-900 border-t border-slate-700/50 flex-shrink-0 z-10">
        <div className="relative flex items-end gap-2 bg-slate-800 p-2 rounded-xl border border-slate-700 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={t(language, 'inputPlaceholder')}
            className="w-full bg-transparent text-slate-200 text-sm placeholder-slate-500 resize-none focus:outline-none py-2 px-2 max-h-32 min-h-[44px] custom-scrollbar"
            rows={1} style={{ minHeight: '2.5rem' }} />
          <button onClick={handleSend} disabled={!input.trim() || isProcessing}
            className={`p-2 rounded-lg mb-0.5 transition-all flex-shrink-0
              ${!input.trim() || isProcessing
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/20'}`}>
            <Send size={18} />
          </button>
        </div>
        <p className="text-[10px] text-center text-slate-600 mt-2">{t(language, 'aiDisclaimer')}</p>
      </div>
    </div>
  )
})

function ActivityIcon({ type, status }: { type: AgentActivity['type']; status?: AgentActivity['status'] }) {
  const size = 'w-3 h-3'
  if (status === 'error') return <XCircle className={`${size} text-red-400`} />
  switch (type) {
    case 'thinking':
      return status === 'processing' ? <Brain className={`${size} text-purple-400 animate-pulse`} /> : <Brain className={`${size} text-purple-400/60`} />
    case 'status':
      return status === 'processing' ? <Clock className={`${size} text-indigo-400 animate-pulse`} /> : <CheckCircle2 className={`${size} text-emerald-400/60`} />
    case 'tool_start':
      return status === 'processing' ? <Wrench className={`${size} text-amber-400 animate-pulse`} /> : <CheckCircle2 className={`${size} text-emerald-400/60`} />
    case 'tool_result':
      return <CheckCircle2 className={`${size} text-emerald-400/60`} />
    case 'content':
      return <Sparkles className={`${size} text-sky-400/60`} />
    case 'error':
      return <XCircle className={`${size} text-red-400`} />
    case 'done':
      return <CheckCircle2 className={`${size} text-emerald-400`} />
    case 'turn_end':
      return <CheckCircle2 className={`${size} text-emerald-400/60`} />
    default:
      return <div className={`${size} rounded-full bg-slate-600`} />
  }
}

function ApprovalToolInput({ toolName, toolInput, language }: { toolName: string; toolInput: Record<string, unknown>; language: Language }) {
  const [expanded, setExpanded] = useState(true)
  const entries = Object.entries(toolInput)
  if (entries.length === 0) return null

  const isBashTool = toolName === 'Bash'
  const commandValue = isBashTool ? (toolInput.command as string || toolInput.script as string || null) : null

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-900/60 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-slate-800/50 transition-colors">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3 h-3 text-slate-500" />
          <span className="text-[10px] text-slate-400 font-medium">{t(language, 'toolInput')}</span>
          <span className="text-[9px] text-slate-600">({entries.length} {entries.length === 1 ? 'param' : 'params'})</span>
        </div>
        {expanded ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
      </button>
      {expanded && (
        <div className="border-t border-slate-700/30">
          {commandValue && (
            <div className="px-2.5 py-1.5 border-b border-slate-700/20">
              <div className="text-[9px] text-slate-500 mb-1 font-medium">{t(language, 'commandLabel')}</div>
              <pre className="text-[11px] text-green-300/90 bg-black/30 rounded px-2 py-1.5 font-mono whitespace-pre-wrap break-all leading-relaxed overflow-x-auto max-h-40 overflow-y-auto">
                {commandValue}
              </pre>
            </div>
          )}
          {entries
            .filter(([k]) => !(isBashTool && (k === 'command' || k === 'script')))
            .map(([k, v]) => (
              <div key={k} className="px-2.5 py-1.5 border-b border-slate-700/20 last:border-b-0">
                <div className="text-[9px] text-slate-500 mb-0.5 font-medium">{k}</div>
                <div className="text-[10px] text-slate-300 font-mono break-all">
                  {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function ToolInputPreview({ input, language }: { input: Record<string, unknown>; language: Language }) {
  const [expanded, setExpanded] = useState(false)
  const entries = Object.entries(input).slice(0, 5)
  if (entries.length === 0) return null
  return (
    <div className="mt-0.5">
      <button onClick={() => setExpanded(!expanded)}
        className="text-[9px] text-slate-500 hover:text-slate-400 transition-colors flex items-center gap-0.5">
        {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
        {t(language, 'parametersLabel')}
      </button>
      {expanded && (
        <div className="mt-0.5 text-[9px] text-slate-500 bg-slate-900/50 rounded px-1.5 py-0.5 font-mono overflow-x-auto max-w-full">
          {entries.map(([k, v]) => (
            <div key={k} className="truncate">
              <span className="text-slate-400">{k}</span>: {typeof v === 'string' ? v : JSON.stringify(v)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case 'error': return <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
    case 'warning': return <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
    default: return <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
  }
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    error: 'bg-red-500/20 text-red-300 border-red-500/30',
    warning: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    info: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${colors[severity] || colors.info}`}>
      {severity}
    </span>
  )
}

function AgentIssuesCard({ issues, language }: { issues: WorkflowIssue[]; language: Language }) {
  const [expanded, setExpanded] = useState(true)

  const errorCount = issues.filter(i => i.severity === 'error').length
  const warningCount = issues.filter(i => i.severity === 'warning').length
  const infoCount = issues.filter(i => i.severity === 'info').length

  const summaryParts: string[] = []
  if (errorCount > 0) summaryParts.push(`${errorCount} ${t(language, 'errors') || 'errors'}`)
  if (warningCount > 0) summaryParts.push(`${warningCount} ${t(language, 'warnings') || 'warnings'}`)
  if (infoCount > 0) summaryParts.push(`${infoCount} ${t(language, 'info') || 'info'}`)

  return (
    <div className="bg-slate-800/70 border border-slate-600/50 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-700/50 transition-colors">
        <div className="flex items-center gap-2">
          <Bug className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">
            {t(language, 'analysisResults') || 'Analysis Results'}
          </span>
          <span className="text-[10px] text-slate-500">{summaryParts.join(' · ')}</span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5">
          {issues.map((issue, idx) => (
            <div key={idx} className="flex items-start gap-2 p-1.5 rounded bg-slate-900/40">
              <SeverityIcon severity={issue.severity} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <SeverityBadge severity={issue.severity} />
                  {issue.nodeId != null && (
                    <span className="text-[9px] text-slate-500">Node {issue.nodeId}</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-300 mt-0.5">{issue.message}</p>
                {issue.fixSuggestion && (
                  <div className="flex items-start gap-1 mt-1">
                    <Lightbulb className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-[10px] text-amber-300/80">{issue.fixSuggestion}</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default ChatPanel
