

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
  Shield
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ChatMessage, Language, Sender, AgentStatus, AgentActivity, WorkflowIssue, ApprovalRequest, HumanInputRequest, TokenUsage } from '../types'
import { t } from '../utils/i18n'

interface ChatPanelProps {
  messages: ChatMessage[]
  input: string
  setInput: (val: string) => void
  onSend: () => void
  isProcessing: boolean
  currentStatus: AgentStatus | null
  activityTimeline: AgentActivity[]
  onActionClick: (action: string) => void
  language: Language
  pendingApproval: ApprovalRequest | null
  pendingHumanInput: HumanInputRequest | null
  onApprovalResponse: (decision: 'allow' | 'deny') => void
  onHumanInputResponse: (value: string, optionValue?: string) => void
  tokenUsage: TokenUsage | null
}

const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  input,
  setInput,
  onSend,
  isProcessing,
  currentStatus,
  activityTimeline,
  onActionClick,
  language,
  pendingApproval,
  pendingHumanInput,
  onApprovalResponse,
  onHumanInputResponse,
  tokenUsage
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [humanInputValue, setHumanInputValue] = useState('')

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, currentStatus])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700/50 relative min-w-0">
      {/* Header */}
      <div className="p-4 border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-indigo-600 rounded-lg">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-100">
              {t(language, 'appName')}
            </h2>
            <p className="text-xs text-slate-400">
              {t(language, 'appSubtitle')}
            </p>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 min-h-0 custom-scrollbar"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-slate-500 space-y-4">
            <Sparkles className="w-12 h-12 opacity-20" />
            <p className="whitespace-pre-wrap max-w-xs">
              {t(language, 'welcome')}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.sender === Sender.USER ? 'flex-row-reverse' : 'flex-row'}`}
          >
            <div
              className={`
                            w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                            ${msg.sender === Sender.USER ? 'bg-slate-700' : 'bg-indigo-600'}
                        `}
            >
              {msg.sender === Sender.USER ? (
                <User size={16} />
              ) : (
                <Bot size={16} />
              )}
            </div>

            <div
              className={`flex flex-col max-w-[85%] min-w-0 ${msg.sender === Sender.USER ? 'items-end' : 'items-start'}`}
            >
              {msg.text && msg.text.trim() ? (
              <div
                className={`
                                p-2.5 rounded-2xl text-sm leading-normal shadow-sm break-words max-w-full
                                ${
                                  msg.sender === Sender.USER
                                    ? 'bg-slate-700 text-slate-100 rounded-tr-none'
                                    : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700/50'
                                }
                            `}
              >
                    <div className="markdown-content">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
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
                            }}
                        >
                            {msg.text}
                        </ReactMarkdown>
                    </div>
              </div>
              ) : null}

              {/* AI Metadata */}
              {msg.sender === Sender.AI && (
                <div className="mt-2 space-y-2 w-full">
                  {/* Agent Analysis Issues */}
                  {msg.metadata?.agentIssues && msg.metadata.agentIssues.length > 0 && (
                    <AgentIssuesCard issues={msg.metadata.agentIssues} language={language} />
                  )}

                  {/* Grounding / Search Sources */}
                  {msg.metadata?.groundingSources &&
                    msg.metadata.groundingSources.length > 0 && (
                      <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-2">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 uppercase tracking-wider mb-1.5 font-semibold">
                          <Globe className="w-3 h-3" />
                          <span>{t(language, 'groundingSources')}</span>
                        </div>
                        <div className="flex flex-col gap-1">
                          {msg.metadata.groundingSources
                            .slice(0, 3)
                            .map((source, idx) => (
                              <a
                                key={idx}
                                href={source.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline truncate block"
                              >
                                • {source.title}
                              </a>
                            ))}
                        </div>
                      </div>
                    )}

                  {/* Missing Nodes Warning */}
                  {msg.metadata?.missingNodes &&
                    msg.metadata.missingNodes.length > 0 && (
                      <div className="bg-amber-950/30 border border-amber-900/50 rounded-lg p-3 text-xs text-amber-200 flex gap-2 items-start">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold mb-1">
                            {t(language, 'missingNodes')}:
                          </p>
                          <ul className="list-disc list-inside opacity-80">
                            {msg.metadata.missingNodes.map((node, i) => (
                              <li key={i}>{node}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}

                  {/* Related Questions */}
                  {msg.metadata?.relatedQuestions &&
                    msg.metadata.relatedQuestions.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-slate-700/50">
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-2 font-semibold flex items-center gap-1.5">
                            <HelpCircle className="w-3 h-3" />
                            Related Questions
                        </p>
                        <div className="flex flex-col gap-2">
                            {msg.metadata.relatedQuestions.map((q, i) => (
                                <button
                                    key={i}
                                    onClick={() => onActionClick(q)}
                                    className="text-left text-xs text-indigo-300 hover:text-indigo-200 hover:bg-slate-800/50 p-2 rounded transition-colors border border-transparent hover:border-slate-700"
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                      </div>
                    )}

                  {/* Update Indicator */}
                  {msg.metadata?.workflowUpdate && (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400 mt-1 pl-1">
                      <Hammer className="w-3 h-3" />
                      <span>{t(language, 'workflowUpdated')}</span>
                    </div>
                  )}
                </div>
              )}

              <span className="text-[10px] text-slate-500 mt-1 px-1">
                {msg.timestamp.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>
          </div>
        ))}
        
        {/* Agent Activity Timeline */}
        {isProcessing && activityTimeline.length > 0 && (
            <div className="mx-3 my-3 rounded-lg bg-slate-800/60 border border-slate-700/40 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-slate-700/30 flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Agent 活动</span>
              </div>
              <div className="px-3 py-2 space-y-0 max-h-48 overflow-y-auto">
                {activityTimeline.slice(-12).map((activity, idx) => {
                  const isLast = idx === activityTimeline.slice(-12).length - 1
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
                            <span className="text-[9px] text-slate-500 flex-shrink-0">
                              {(activity.duration / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                        {activity.toolInput && Object.keys(activity.toolInput).length > 0 && (
                          <ToolInputPreview input={activity.toolInput} />
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
            <div className="mx-3 my-3 rounded-lg border border-amber-500/30 bg-amber-950/20 overflow-hidden">
              <div className="px-3 py-2 border-b border-amber-500/20 flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-semibold text-amber-300">{t(language, 'approvalRequired')}</span>
              </div>
              <div className="px-3 py-2 space-y-2">
                <p className="text-xs text-slate-300">{pendingApproval.message}</p>
                <p className="text-[10px] text-slate-500">{t(language, 'approvalTool')}: {pendingApproval.toolName}</p>
                {pendingApproval.suggestions && pendingApproval.suggestions.length > 0 && (
                  <div className="text-[10px] text-slate-400">
                    <span className="font-medium">{t(language, 'approvalSuggestions')}:</span>
                    <ul className="mt-0.5 space-y-0.5">
                      {pendingApproval.suggestions.map((s, i) => (
                        <li key={i} className="pl-2 border-l border-slate-700">• {s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => onApprovalResponse('deny')}
                    className="flex-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-lg transition-colors"
                  >
                    {t(language, 'approvalDeny')}
                  </button>
                  <button
                    onClick={() => onApprovalResponse('allow')}
                    className="flex-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors"
                  >
                    {t(language, 'approvalAllow')}
                  </button>
                </div>
              </div>
            </div>
        )}

        {pendingHumanInput && (
            <div className="mx-3 my-3 rounded-lg border border-blue-500/30 bg-blue-950/20 overflow-hidden">
              <div className="px-3 py-2 border-b border-blue-500/20 flex items-center gap-2">
                <MessageCircle className="w-3.5 h-3.5 text-blue-400" />
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
                      <button
                        key={i}
                        onClick={() => onHumanInputResponse(opt.value, opt.value)}
                        className="w-full text-left px-3 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs text-slate-200 transition-colors"
                      >
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && <span className="text-slate-500 ml-2">- {opt.description}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {pendingHumanInput.allowFreeText && (
                  <div className="flex gap-2 pt-1">
                    <input
                      type="text"
                      value={humanInputValue}
                      onChange={e => setHumanInputValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && humanInputValue.trim()) { onHumanInputResponse(humanInputValue.trim()); setHumanInputValue('') } }}
                      placeholder={t(language, 'humanInputPlaceholder')}
                      className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                      autoFocus
                    />
                    <button
                      onClick={() => { if (humanInputValue.trim()) { onHumanInputResponse(humanInputValue.trim()); setHumanInputValue('') } }}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors"
                    >
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

      {/* Input Area */}
      <div className="p-4 bg-slate-900 border-t border-slate-700/50 flex-shrink-0 z-10">
        <div className="relative flex items-end gap-2 bg-slate-800 p-2 rounded-xl border border-slate-700 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(language, 'inputPlaceholder')}
            className="w-full bg-transparent text-slate-200 text-sm placeholder-slate-500 resize-none focus:outline-none py-2 px-2 max-h-32 min-h-[44px] custom-scrollbar"
            rows={1}
            style={{ minHeight: '2.5rem' }}
          />
          <button
            onClick={onSend}
            disabled={!input.trim() || isProcessing}
            className={`
                            p-2 rounded-lg mb-0.5 transition-all flex-shrink-0
                            ${
                              !input.trim() || isProcessing
                                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/20'
                            }
                        `}
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-[10px] text-center text-slate-600 mt-2">
          {t(language, 'aiDisclaimer')}
        </p>
      </div>
    </div>
  )
}

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
    default:
      return <div className={`${size} rounded-full bg-slate-600`} />
  }
}

function ToolInputPreview({ input }: { input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)
  const entries = Object.entries(input).slice(0, 5)
  if (entries.length === 0) return null
  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[9px] text-slate-500 hover:text-slate-400 transition-colors flex items-center gap-0.5"
      >
        {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
        参数
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
    case 'error':
      return <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
    case 'warning':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
    default:
      return <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
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
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-700/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Bug className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">
            {t(language, 'analysisResults') || 'Analysis Results'}
          </span>
          <span className="text-[10px] text-slate-500">
            {summaryParts.join(' · ')}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 overflow-hidden">
          {issues.map((issue, idx) => (
            <div
              key={issue.id || idx}
              className="flex items-start gap-2 p-2 rounded-md bg-slate-900/50 border border-slate-700/30 min-w-0"
            >
              <SeverityIcon severity={issue.severity} />
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center gap-2 flex-wrap">
                  <SeverityBadge severity={issue.severity} />
                  {issue.category && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 font-mono">
                      {issue.category}
                    </span>
                  )}
                  {(issue.nodeId != null || (issue.nodeIds && issue.nodeIds.length > 0)) && (
                    <span className="text-[9px] text-slate-500 font-mono">
                      Node #{issue.nodeIds && issue.nodeIds.length > 1
                        ? issue.nodeIds.join(', #')
                        : (issue.nodeId ?? issue.nodeIds?.[0])}
                    </span>
                  )}
                  {issue.nodeType && (
                    <span className="text-[9px] text-slate-500">
                      {issue.nodeType}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-200 mt-1 break-words overflow-wrap-anywhere">
                  {issue.message}
                </p>
                {issue.impact && (
                  <div className="flex items-start gap-1.5 mt-1.5">
                    <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-300/70 break-words overflow-wrap-anywhere">
                      {issue.impact}
                    </p>
                  </div>
                )}
                {issue.fixSuggestion && (
                  <div className="flex items-start gap-1.5 mt-1.5">
                    <Lightbulb className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-emerald-300/80 break-words overflow-wrap-anywhere">
                      {issue.fixSuggestion}
                    </p>
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
