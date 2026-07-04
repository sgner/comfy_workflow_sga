import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cog,
  Hammer,
  Loader2,
  Terminal,
  XCircle
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { CodexBuildStatus, fetchCodexBuildStatus } from '../services/configService'
import { Language } from '../types'
import { t } from '../utils/i18n'

interface CodexBuildProgressCardProps {
  backendUrl: string
  language: Language
  /** 当 build 成功完成, 用户点 "Switch to Codex" 时触发 (可选) */
  onSwitchToCodex?: () => void
  /** 轮询间隔 (ms), 默认 1500 */
  pollIntervalMs?: number
  /** 用户手动关闭卡片 (只在 failed/idle 时持久隐藏, 编译中不允许关闭) */
  onDismiss?: () => void
  /** 受控模式: 父组件控制是否渲染 (默认自动根据 status 决定) */
  forceShow?: boolean
}

const CodexBuildProgressCard: React.FC<CodexBuildProgressCardProps> = ({
  backendUrl,
  language,
  onSwitchToCodex,
  pollIntervalMs = 1500,
  onDismiss,
  forceShow = false
}) => {
  const [status, setStatus] = useState<CodexBuildStatus | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [logContent, setLogContent] = useState<string>('')
  const [dismissed, setDismissed] = useState(false)
  const [autoSwitched, setAutoSwitched] = useState(false)
  const inflightRef = useRef(false)
  // 用 ref 持有 dismiss 状态, 避免 polling 闭包陈旧
  const dismissedRef = useRef(false)
  const autoSwitchedRef = useRef(false)

  useEffect(() => { dismissedRef.current = dismissed }, [dismissed])
  useEffect(() => { autoSwitchedRef.current = autoSwitched }, [autoSwitched])

  const loadLog = useCallback(async () => {
    if (!status?.log_file || showLog) return
    // 后端没有直接 serve log file, 我们用 fetch 拿 build-status 本身就够了
    // 日志可后续扩展: 通过新接口 /api/v1/codex/build-log?tail=N
    setLogContent('')
  }, [status?.log_file, showLog])

  const tick = useCallback(async () => {
    if (inflightRef.current) return
    if (!backendUrl) return
    inflightRef.current = true
    try {
      const s = await fetchCodexBuildStatus(backendUrl)
      if (!s) return
      setStatus(s)

      // build 成功后不自动收起, 需要用户手动重启 ComfyUI 才能使用 Codex
      if (s.status === 'success' && !autoSwitchedRef.current) {
        if (onSwitchToCodex) {
          setAutoSwitched(true)
        }
      }
    } catch {
      // 静默, 下轮重试
    } finally {
      inflightRef.current = false
    }
  }, [backendUrl, onSwitchToCodex])

  useEffect(() => {
    void tick()
    const timer = setInterval(tick, pollIntervalMs)
    return () => clearInterval(timer)
  }, [tick, pollIntervalMs])

  useEffect(() => { void loadLog() }, [loadLog])

  // 决定是否显示
  const isTerminal = status?.status === 'success' || status?.status === 'failed' || status?.status === 'error'
  if (!status) return null
  if (status.status === 'idle') return null
  if (dismissed && !forceShow) return null
  if (autoSwitched && status.status === 'success' && !forceShow) return null

  const s = status
  const isBuilding = s.status === 'building' || s.status === 'pending'
  const isSuccess = s.status === 'success'
  const isFailed = s.status === 'failed' || s.status === 'error'

  const percent = Math.max(0, Math.min(100, s.progress?.percent ?? 0))
  const current = s.progress?.current ?? 0
  const total = s.progress?.total ?? 0
  const currentCrate = s.progress?.current_crate ?? ''

  // 颜色主题
  const theme = isBuilding
    ? {
        border: 'border-indigo-500/30',
        bg: 'bg-indigo-950/30',
        icon: <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />,
        accent: 'bg-indigo-500',
        text: 'text-indigo-200',
        label: t(language, 'codexBuildInProgress')
      }
    : isSuccess
    ? {
        border: 'border-emerald-500/40',
        bg: 'bg-emerald-950/30',
        icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
        accent: 'bg-emerald-500',
        text: 'text-emerald-200',
        label: t(language, 'codexBuildDone')
      }
    : {
        border: 'border-red-500/40',
        bg: 'bg-red-950/30',
        icon: <XCircle className="w-4 h-4 text-red-400" />,
        accent: 'bg-red-500',
        text: 'text-red-200',
        label: t(language, 'codexBuildFailed')
      }

  const handleDismiss = () => {
    if (isBuilding) return
    setDismissed(true)
    onDismiss?.()
  }

  return (
    <div className={`mx-3 my-2 rounded-lg border ${theme.border} ${theme.bg} overflow-hidden animate-in fade-in slide-in-from-top-2 duration-300`}>
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="flex-shrink-0">
          {isBuilding ? <Hammer className="w-3.5 h-3.5 text-indigo-400" /> : theme.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-semibold ${theme.text} truncate`}>
              {theme.label}
            </span>
            {isBuilding && total > 0 && (
              <span className="text-[10px] text-slate-400 font-mono flex-shrink-0">
                {current}/{total} ({percent.toFixed(1)}%)
              </span>
            )}
          </div>

          {/* 进度条 */}
          {isBuilding && (
            <div className="mt-1.5 h-1.5 w-full bg-slate-800/80 rounded-full overflow-hidden">
              <div
                className={`h-full ${theme.accent} transition-all duration-500 ease-out`}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {/* 当前 crate 名字 */}
          {isBuilding && currentCrate && (
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500 font-mono truncate">
              <Cog className="w-2.5 h-2.5 flex-shrink-0 opacity-60" />
              <span className="truncate">{currentCrate}</span>
            </div>
          )}

          {/* 错误信息 */}
          {isFailed && s.error && (
            <div className="mt-1 text-[10px] text-red-300/80 break-all">
              {s.error}
            </div>
          )}

          {isFailed && (
            <div className="mt-1 text-[10px] text-slate-500">
              {t(language, 'codexBuildErrorHint')}
            </div>
          )}
        </div>

        {/* 关闭按钮 (仅在终态可关闭) */}
        {isTerminal && (
          <button
            onClick={handleDismiss}
            className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
            title={t(language, 'codexBuildHide')}
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 展开/收起 日志 */}
      {s.log_file && (
        <div className="border-t border-slate-700/30">
          <button
            onClick={() => setShowLog(v => !v)}
            className="w-full px-3 py-1.5 flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200 hover:bg-slate-800/30 transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Terminal className="w-3 h-3" />
              <span>{s.log_file}</span>
            </div>
            {showLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showLog && (
            <div className="px-3 py-2 bg-black/30 max-h-32 overflow-y-auto text-[10px] font-mono text-slate-400 break-all whitespace-pre-wrap">
              {logContent || (s.status === 'pending' ? 'Worker starting...' : `status: ${s.status}\ncurrent: ${current}/${total}\ncrate: ${currentCrate}\npercent: ${percent}%\npid: ${s.pid ?? 'n/a'}`)}
            </div>
          )}
        </div>
      )}

      {/* 成功时: 提示用户重启 ComfyUI, 并提供 "切换到 Codex" 按钮 */}
      {isSuccess && (
        <div className="px-3 py-2 border-t border-emerald-700/30 bg-emerald-900/20">
          {/* 醒目的重启提示 */}
          <div className="mb-2 px-2 py-1.5 rounded-md border border-amber-500/40 bg-amber-950/40 flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
            <span className="text-[10px] text-amber-200 leading-relaxed">
              {t(language, 'codexBuildRestartHint')}
            </span>
          </div>
          {onSwitchToCodex && (
            <button
              onClick={() => {
                setAutoSwitched(true)
                onSwitchToCodex()
              }}
              disabled={autoSwitched}
              className="w-full px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-bold rounded-md transition-colors flex items-center justify-center gap-1.5"
            >
              {autoSwitched ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Hammer className="w-3.5 h-3.5" />}
              {t(language, 'codexBuildSwitchNow')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default CodexBuildProgressCard
