

import {
  AlertTriangle,
  Bot,
  Globe,
  Hammer,
  Loader2,
  Send,
  Sparkles,
  User,
  HelpCircle
} from 'lucide-react'
import React, { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ChatMessage, Language, Sender, AgentStatus } from '../types'
import { t } from '../utils/i18n'

interface ChatPanelProps {
  messages: ChatMessage[]
  input: string
  setInput: (val: string) => void
  onSend: () => void
  isProcessing: boolean
  currentStatus: AgentStatus | null
  onActionClick: (action: string) => void
  language: Language
}

const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  input,
  setInput,
  onSend,
  isProcessing,
  currentStatus,
  onActionClick,
  language
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)

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
                {msg.sender === Sender.AI && msg.metadata?.thinking && !msg.text ? (
                  <div className="flex items-center gap-2 text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t(language, 'thinking')}</span>
                  </div>
                ) : (
                    <div className="markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                )}
              </div>

              {/* AI Metadata */}
              {msg.sender === Sender.AI && (
                <div className="mt-2 space-y-2 w-full">
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
        
        {/* Real-time Status Indicator (Centered Pill) */}
        {isProcessing && currentStatus && (
            <div className="flex justify-center w-full my-4 animate-in fade-in zoom-in-95 duration-300">
                 <div className="bg-slate-800/80 backdrop-blur-md border border-indigo-500/30 rounded-full px-5 py-2 flex items-center gap-3 shadow-lg max-w-[90%]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 flex-shrink-0" />
                    <div className="flex flex-col items-start min-w-0">
                        <span className="text-xs font-medium text-indigo-100 truncate w-full">{currentStatus.displayText}</span>
                        {currentStatus.node && (
                            <span className="text-[9px] text-indigo-300/70 uppercase tracking-widest truncate w-full">
                                {currentStatus.node.replace(/_/g, ' ')}
                            </span>
                        )}
                    </div>
                 </div>
            </div>
        )}
      </div>

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

export default ChatPanel
