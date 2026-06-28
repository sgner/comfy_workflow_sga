

import {
  AlertTriangle,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Cpu,
  Download,
  Edit2,
  Globe,
  Key,
  Languages,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Server,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Workflow,
  X
} from 'lucide-react'
import React, { useEffect, useState } from 'react'

import { deleteBackendConfig, deleteGitHubToken, fetchBackendConfigs, getGitHubStatus, setBackendDefault, updateBackendConfig, updateGitHubToken, verifyProviderAddress, verifyProviderProtocol, fetchProviderModels, verifyAndAddProvider } from '../services/configService'
import type { ProviderProtocol, RemoteModel, VerifyAddressResult, VerifyProtocolResult } from '../services/configService'
import { AppSettings, BackendConfig, BackendConfigCreate, GitHubTokenStatus, Language } from '../types'
import { t } from '../utils/i18n'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  currentSettings: AppSettings
  onSave: (settings: AppSettings) => void
}

const DEFAULT_CUSTOM_HEADERS = `{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer $apiKey"\n}`;
const DEFAULT_CUSTOM_ENDPOINT = "/v1/chat/completions";

const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  currentSettings,
  onSave
}) => {
  const [settings, setSettings] = useState<AppSettings>(currentSettings)
  const currentLang = settings.language
  
  // Backend State
  const [configs, setConfigs] = useState<BackendConfig[]>([])
  const [githubStatus, setGithubStatus] = useState<GitHubTokenStatus>({ has_token: false })
  const [isLoading, setIsLoading] = useState(false)
  
  // Forms State
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const [newConfig, setNewConfig] = useState<BackendConfigCreate>({
      name: '',
      provider: 'openai',
      api_key: '',
      default_model: '',
      base_url: '',
      default_max_tokens: undefined,
      default_temperature: undefined,
      retries: undefined,
      retry_delay: undefined,
      custom_config: {
          endpoint: DEFAULT_CUSTOM_ENDPOINT,
          headers: DEFAULT_CUSTOM_HEADERS
      },
      model_configs: {}
  })
  
  const [formErrors, setFormErrors] = useState<Record<string, boolean>>({})
  const [githubToken, setGithubToken] = useState('')

  // Top-level Advanced Custom Settings Toggle (Direct Mode for non-Provider settings)
  const [showAdvanced, setShowAdvanced] = useState(false);

  // --- Simplified API config (verify & fetch) ---
  const [verifyProtocolType, setVerifyProtocolType] = useState<ProviderProtocol>('openai')
  const [verifyingAddress, setVerifyingAddress] = useState(false)
  const [verifyingProtocol, setVerifyingProtocol] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [addressVerifyResult, setAddressVerifyResult] = useState<VerifyAddressResult | null>(null)
  const [protocolVerifyResult, setProtocolVerifyResult] = useState<VerifyProtocolResult | null>(null)
  const [fetchedModels, setFetchedModels] = useState<RemoteModel[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customModelsEndpoint, setCustomModelsEndpoint] = useState<string>('')
  const [customChatEndpoint, setCustomChatEndpoint] = useState<string>('')
  const [customHeadersText, setCustomHeadersText] = useState<string>('')

  useEffect(() => {
    setSettings(currentSettings)
  }, [currentSettings, isOpen])

  // Fetch backend data when modal opens or backend URL changes
  useEffect(() => {
      if (isOpen && settings.usePythonBackend && settings.pythonBackendUrl) {
          void refreshBackendData();
      }
  }, [isOpen, settings.usePythonBackend, settings.pythonBackendUrl]);

  const refreshBackendData = async () => {
      if (!settings.pythonBackendUrl) return;
      setIsLoading(true);
      try {
          const [cfgs, gh] = await Promise.all([
              fetchBackendConfigs(settings.pythonBackendUrl),
              getGitHubStatus(settings.pythonBackendUrl)
          ]);
          setConfigs(cfgs);
          setGithubStatus(gh);
          if (!settings.activeBackendConfigId && cfgs.length > 0) {
              // Prefer the one marked as default by backend, otherwise the first one
              const defaultCfg = cfgs.find(c => c.is_default) || cfgs[0];
              setSettings(prev => ({ ...prev, activeBackendConfigId: defaultCfg.id }));
          }
      } catch (e) {
          console.error("Failed to fetch backend data", e);
      } finally {
          setIsLoading(false);
      }
  };

  const handleSaveSettings = () => {
    onSave(settings)
    onClose()
  }

  // --- Backend Config Actions ---
const handleSelectConfig = async (id: string) => {
      setSettings(prev => ({ ...prev, activeBackendConfigId: id }));
      if (settings.usePythonBackend && settings.pythonBackendUrl) {
          try {
              await setBackendDefault(settings.pythonBackendUrl, id);
          } catch (e) {
              console.error('Failed to persist default config on backend:', e);
          }
      }
  }
  const handleEditStart = (config: BackendConfig) => {
      setNewConfig({
          name: config.name,
          provider: config.provider,
          api_key: '',
          default_model: config.default_model || '',
          base_url: config.base_url || '',
          is_default: config.is_default,
          default_max_tokens: config.default_max_tokens,
          default_temperature: config.default_temperature,
          retries: config.retries,
          retry_delay: config.retry_delay,
          headers: config.headers,
          extension: config.extension,
          custom_config: config.provider === 'custom' ? {
              endpoint: config.custom_config?.endpoint || DEFAULT_CUSTOM_ENDPOINT,
              headers: config.custom_config?.headers || DEFAULT_CUSTOM_HEADERS
          } : undefined,
          model_configs: config.model_configs || {}
      });
      setEditingConfigId(config.id);
      setShowAddForm(true);
      setFormErrors({});

      // 已有供应商:把已经保存的 model_configs 直接作为 fetchedModels 渲染
      // 不再触发任何验证 / 拉取
      const existingModels: RemoteModel[] = Object.values(config.model_configs || {}).map(m => ({
          id: m.id,
          displayName: m.displayName || m.id,
          contextWindow: m.contextWindow,
          supportsVision: m.supportsVision,
          supportsToolUse: m.supportsToolUse,
          supportsStreaming: m.supportsStreaming,
          supportsThinking: m.supportsThinking,
      }))
      setFetchedModels(existingModels)
      setSelectedModelId(config.default_model || '')
      // 协议从 provider 推断(只支持这 4 种)
      const prov = (config.provider as string) || 'openai'
      const allowed: ProviderProtocol[] = ['openai', 'async', 'gemini', 'custom']
      setVerifyProtocolType(allowed.includes(prov as ProviderProtocol) ? (prov as ProviderProtocol) : 'custom')
      // 标记为已验证,显示绿色"地址已验证"
      setAddressVerifyResult({ ok: true, message: '已保存的供应商', latencyMs: 0 })
      setProtocolVerifyResult({ ok: true, message: '已保存的协议', latencyMs: 0, protocol: verifyProtocolType })
      setAdvancedOpen(false)
  };

  // --- Simplified API config handlers ---
  const handleVerifyAddress = async () => {
      if (!settings.pythonBackendUrl || !newConfig.base_url) return;
      setVerifyingAddress(true);
      setAddressVerifyResult(null);
      try {
          const result = await verifyProviderAddress(settings.pythonBackendUrl, {
              baseUrl: newConfig.base_url,
              apiKey: newConfig.api_key,
              protocol: verifyProtocolType,
              customModelsEndpoint: customModelsEndpoint || undefined,
          });
          setAddressVerifyResult(result);
          if (!result.ok) {
              setAdvancedOpen(true);
          }
      } catch (err) {
          setAddressVerifyResult({ ok: false, message: err instanceof Error ? err.message : 'Verification failed' });
          setAdvancedOpen(true);
      } finally {
          setVerifyingAddress(false);
      }
  };

  const handleVerifyProtocol = async () => {
      if (!settings.pythonBackendUrl || !newConfig.base_url || !newConfig.api_key) return;
      setVerifyingProtocol(true);
      setProtocolVerifyResult(null);
      try {
          const result = await verifyProviderProtocol(settings.pythonBackendUrl, {
              baseUrl: newConfig.base_url,
              apiKey: newConfig.api_key,
              protocol: verifyProtocolType,
              customChatEndpoint: customChatEndpoint || undefined,
              customModelsEndpoint: customModelsEndpoint || undefined,
              customHeaders: customHeadersText || undefined,
          });
          setProtocolVerifyResult(result);
          if (!result.ok) {
              setAdvancedOpen(true);
          }
      } catch (err) {
          setProtocolVerifyResult({ ok: false, message: err instanceof Error ? err.message : 'Verification failed', protocol: verifyProtocolType });
          setAdvancedOpen(true);
      } finally {
          setVerifyingProtocol(false);
      }
  };

  const handleFetchModels = async () => {
      if (!settings.pythonBackendUrl || !newConfig.base_url) return;
      setFetchingModels(true);
      setFetchedModels([]);
      try {
          const result = await fetchProviderModels(settings.pythonBackendUrl, {
              baseUrl: newConfig.base_url,
              apiKey: newConfig.api_key,
              protocol: verifyProtocolType,
              customModelsEndpoint: customModelsEndpoint || undefined,
          });
          if (result.ok) {
              setFetchedModels(result.models);
              if (result.models.length > 0 && !selectedModelId) {
                  setSelectedModelId(result.models[0].id);
              }
          } else {
              setAdvancedOpen(true);
          }
          setAddressVerifyResult({ ok: result.ok, message: result.message });
      } catch (err) {
          setAddressVerifyResult({ ok: false, message: err instanceof Error ? err.message : 'Fetch failed' });
          setAdvancedOpen(true);
      } finally {
          setFetchingModels(false);
      }
  };

  const handleDeleteConfig = async (id: string) => {
      if (!settings.pythonBackendUrl) return;
      try {
          await deleteBackendConfig(settings.pythonBackendUrl, id);
          if (settings.activeBackendConfigId === id) {
              setSettings(prev => ({ ...prev, activeBackendConfigId: undefined }));
          }
          await refreshBackendData();
      } catch (e) {
          console.error('Failed to delete config', e);
      }
  };

  const handleUpdateGitHub = async () => {
      if (!settings.pythonBackendUrl || !githubToken) return;
      try {
          await updateGitHubToken(settings.pythonBackendUrl, githubToken);
          setGithubStatus({ has_token: true });
          setGithubToken('');
          await getGitHubStatus(settings.pythonBackendUrl).then(setGithubStatus);
      } catch (e) {
          console.error('Failed to update GitHub token', e);
      }
  };

  const handleDeleteGitHub = async () => {
      if (!settings.pythonBackendUrl) return;
      try {
          await deleteGitHubToken(settings.pythonBackendUrl);
          setGithubStatus({ has_token: false });
      } catch (e) {
          console.error('Failed to delete GitHub token', e);
      }
  };

  const resetCustomConfig = () => {
      setSettings(prev => ({
          ...prev,
          customConfig: {
              endpoint: DEFAULT_CUSTOM_ENDPOINT,
              headers: DEFAULT_CUSTOM_HEADERS,
          },
      }));
  };

  const handleSaveWithVerify = async () => {
      if (!settings.pythonBackendUrl) return;
      // 编辑模式下,api_key 留空表示保持原值,不要强制必填
      if (!editingConfigId && (!newConfig.name?.trim() || !newConfig.api_key?.trim() || !newConfig.base_url?.trim())) {
          setFormErrors({ name: !newConfig.name, api_key: !newConfig.api_key, base_url: !newConfig.base_url });
          return;
      }
      if (editingConfigId && (!newConfig.name?.trim() || !newConfig.base_url?.trim())) {
          setFormErrors({ name: !newConfig.name, base_url: !newConfig.base_url });
          return;
      }
      setSavingConfig(true);
      setAddressVerifyResult(null);
      setProtocolVerifyResult(null);
      try {
          if (editingConfigId) {
              // ========== 编辑模式:直接 PUT /api/configs/:id,不验证、不拉取 ==========
              // 把已选模型 / 已有模型列表都打回去
              const modelConfigsPayload: Record<string, unknown> = {}
              for (const m of fetchedModels) {
                  modelConfigsPayload[m.id] = {
                      id: m.id,
                      displayName: m.displayName || m.id,
                      contextWindow: m.contextWindow,
                      supportsVision: m.supportsVision,
                      supportsToolUse: m.supportsToolUse,
                      supportsStreaming: m.supportsStreaming,
                      supportsThinking: m.supportsThinking,
                  }
              }
              const finalDefaultModel = selectedModelId || newConfig.default_model
              const trimmedName = newConfig.name.trim()
              const trimmedBaseUrl = (newConfig.base_url || '').trim()
              const trimmedApiKey = (newConfig.api_key || '').trim()
              await updateBackendConfig(settings.pythonBackendUrl, editingConfigId, {
                  provider: newConfig.provider || 'openai',
                  name: trimmedName,
                  base_url: trimmedBaseUrl,
                  default_model: finalDefaultModel,
                  // 只有用户填了 api_key 才提交(后端「留空保留」)
                  ...(trimmedApiKey ? { api_key: trimmedApiKey } : {}),
                  is_default: newConfig.is_default ?? true,
                  default_max_tokens: newConfig.default_max_tokens,
                  default_temperature: newConfig.default_temperature,
                  retries: newConfig.retries,
                  retry_delay: newConfig.retry_delay,
                  headers: newConfig.headers,
                  custom_config: newConfig.custom_config,
                  model_configs: modelConfigsPayload as any,
              });
              await refreshBackendData();
              handleCancelForm();
              return;
          }

          // ========== 新增模式:verify-and-add 流程 ==========
          const modelConfigsPayload: Record<string, unknown> = {}
          for (const m of fetchedModels) {
              modelConfigsPayload[m.id] = {
                  id: m.id,
                  displayName: m.displayName || m.id,
                  contextWindow: m.contextWindow,
                  supportsVision: m.supportsVision,
                  supportsToolUse: m.supportsToolUse,
                  supportsStreaming: m.supportsStreaming,
                  supportsThinking: m.supportsThinking,
              }
          }
          const result = await verifyAndAddProvider(settings.pythonBackendUrl, {
              name: (newConfig.name || '').trim(),
              baseUrl: (newConfig.base_url || '').trim(),
              apiKey: (newConfig.api_key || '').trim(),
              protocol: verifyProtocolType,
              customChatEndpoint: customChatEndpoint || undefined,
              customModelsEndpoint: customModelsEndpoint || undefined,
              customHeaders: customHeadersText || undefined,
              defaultModel: selectedModelId || newConfig.default_model || undefined,
              modelConfigs: Object.keys(modelConfigsPayload).length > 0 ? modelConfigsPayload : undefined,
              isDefault: true,
          });
          if (result.success) {
              await refreshBackendData();
              handleCancelForm();
          } else {
              setAddressVerifyResult({
                  ok: false,
                  message: result.message || '保存失败',
                  latencyMs: 0,
                  status: 0,
              });
              setAdvancedOpen(true);
          }
      } catch (err) {
          setAddressVerifyResult({
              ok: false,
              message: err instanceof Error ? err.message : '保存失败',
              latencyMs: 0,
              status: 0,
          });
          setAdvancedOpen(true);
      } finally {
          setSavingConfig(false);
      }
  };

  const handleCancelForm = () => {
      setShowAddForm(false);
      setEditingConfigId(null);
      setNewConfig({
          name: '', provider: 'openai', api_key: '', default_model: '', base_url: '',
          default_max_tokens: undefined, default_temperature: undefined,
          retries: undefined, retry_delay: undefined,
          custom_config: { endpoint: DEFAULT_CUSTOM_ENDPOINT, headers: DEFAULT_CUSTOM_HEADERS },
          model_configs: {}
      });
      setFormErrors({});
      // 清理 verify 状态
      setAddressVerifyResult(null);
      setProtocolVerifyResult(null);
      setFetchedModels([]);
      setSelectedModelId('');
      setAdvancedOpen(false);
      setCustomModelsEndpoint('');
      setCustomChatEndpoint('');
      setCustomHeadersText('');
      setVerifyProtocolType('openai');
  };

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-slate-900 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="text-indigo-500" size={20} />
            <h2 className="text-lg font-semibold text-slate-100">
              {t(currentLang, 'settingsTitle')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
          {/* Language Selection */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Languages size={14} />
              {t(currentLang, 'language')}
            </label>
            <select
              value={settings.language}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  language: e.target.value as Language
                })
              }
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
            >
              <option value="en">English</option>
              <option value="zh">中文 (Chinese)</option>
              <option value="ja">日本語 (Japanese)</option>
              <option value="ko">한국어 (Korean)</option>
            </select>
          </div>

          <hr className="border-slate-800" />

          {/* Backend Agent Configuration */}
          <div className="space-y-4">
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-200 font-medium">
                    <Workflow size={18} className="text-emerald-500" />
                    <span>{t(currentLang, 'usePythonBackend')}</span>
                </div>
                <button 
                    onClick={() => setSettings(prev => ({...prev, usePythonBackend: !prev.usePythonBackend}))}
                    className="text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                    {settings.usePythonBackend ? <ToggleRight size={28} className="text-indigo-500"/> : <ToggleLeft size={28} className="text-slate-600"/>}
                </button>
             </div>
             
             {settings.usePythonBackend && (
                <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-200">
                    
                    {/* Backend URL Input */}
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 space-y-3">
                        <p className="text-[11px] text-slate-400">{t(currentLang, 'backendHint')}</p>
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <label className="text-xs font-medium text-slate-300 block">{t(currentLang, 'pythonBackendUrl')}</label>
                                <button onClick={refreshBackendData} className="text-[10px] flex items-center gap-1 text-indigo-400 hover:text-indigo-300"><RefreshCw size={10}/> {t(currentLang, 'refresh')}</button>
                            </div>
                            <input
                                type="text"
                                value={settings.pythonBackendUrl || "http://127.0.0.1:8000"}
                                onChange={(e) => setSettings({...settings, pythonBackendUrl: e.target.value})}
                                placeholder="http://127.0.0.1:8000"
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-slate-200 font-mono focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                    </div>

                    {/* AI Providers Management */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-200">{t(currentLang, 'manageProviders')}</h3>
                            <button 
                                onClick={() => { handleCancelForm(); setShowAddForm(true); }}
                                className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs flex items-center gap-1 transition-colors"
                            >
                                <Plus size={12} /> {t(currentLang, 'addProvider')}
                            </button>
                        </div>

                        {/* Add/Edit Config Form - SIMPLIFIED */}
                        {showAddForm && (
                            <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 space-y-3 animate-in fade-in zoom-in-95 duration-100">
                                <div className="text-xs font-bold text-slate-300 uppercase mb-2">{editingConfigId ? t(currentLang, 'editProvider') : t(currentLang, 'addProvider')}</div>

                                {/* 基本信息 */}
                                <div className="space-y-1">
                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'platformName')}</label>
                                    <input
                                        placeholder="API"
                                        className={`w-full bg-slate-950 border rounded p-2 text-xs text-white ${formErrors.name ? 'border-red-500' : 'border-slate-700'}`}
                                        value={newConfig.name}
                                        onChange={e => setNewConfig({...newConfig, name: e.target.value})}
                                    />
                                    {formErrors.name && <p className="text-[9px] text-red-400">{t(currentLang, 'nameRequired')}</p>}
                                </div>

                                {/* 请求地址 */}
                                <div className="space-y-1">
                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'requestUrl')}</label>
                                    <input
                                        type="text"
                                        placeholder="https://api.example.com/v1"
                                        className={`w-full bg-slate-950 border rounded p-2 text-xs text-slate-200 font-mono ${formErrors.base_url ? 'border-red-500' : 'border-slate-700'}`}
                                        value={newConfig.base_url}
                                        onChange={e => {
                                            setNewConfig({...newConfig, base_url: e.target.value})
                                            setAddressVerifyResult(null)
                                        }}
                                    />
                                    {formErrors.base_url && <p className="text-[9px] text-red-400">{t(currentLang, 'baseUrlRequired')}</p>}
                                </div>

                                {/* API Key */}
                                <div className="space-y-1">
                                    <label className="text-[9px] uppercase font-bold text-slate-500">API Key</label>
                                    <input
                                        type="password"
                                        placeholder={editingConfigId ? t(currentLang, 'leaveEmptyToKeep') : t(currentLang, 'apiKeyEnter')}
                                        className={`w-full bg-slate-950 border rounded p-2 text-xs text-white ${formErrors.api_key ? 'border-red-500' : 'border-slate-700'}`}
                                        value={newConfig.api_key}
                                        onChange={e => setNewConfig({...newConfig, api_key: e.target.value})}
                                    />
                                    {formErrors.api_key && <p className="text-[9px] text-red-400">{t(currentLang, 'apiKeyRequired')}</p>}
                                </div>

                                {/* 协议 + 验证/拉取按钮 */}
                                <div className="space-y-1">
                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'protocol')}</label>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <select
                                            value={verifyProtocolType}
                                            disabled={!!editingConfigId}
                                            onChange={e => {
                                                setVerifyProtocolType(e.target.value as ProviderProtocol)
                                                setProtocolVerifyResult(null)
                                                setAddressVerifyResult(null)
                                            }}
                                            className="flex-1 min-w-[140px] bg-slate-950 border border-slate-700 rounded p-2 text-xs text-white disabled:opacity-60 disabled:cursor-not-allowed"
                                        >
                                            <option value="openai">{t(currentLang, 'protocolOpenai')}</option>
                                            <option value="async">{t(currentLang, 'protocolAsync')}</option>
                                            <option value="gemini">{t(currentLang, 'protocolGemini')}</option>
                                            <option value="custom">{t(currentLang, 'protocolCustom')}</option>
                                        </select>
                                        {!editingConfigId && (
                                            <>
                                                <button
                                                    onClick={handleVerifyAddress}
                                                    disabled={!newConfig.base_url || verifyingAddress}
                                                    className="px-2 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded text-xs flex items-center gap-1 transition-colors"
                                                    title={t(currentLang, 'verifyAddressTooltip')}
                                                >
                                                    {verifyingAddress ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                                                    {t(currentLang, 'verifyAddress')}
                                                </button>
                                                <button
                                                    onClick={handleVerifyProtocol}
                                                    disabled={!newConfig.base_url || !newConfig.api_key || verifyingProtocol}
                                                    className="px-2 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded text-xs flex items-center gap-1 transition-colors"
                                                    title={t(currentLang, 'verifyProtocolTooltip')}
                                                >
                                                    {verifyingProtocol ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                                                    {t(currentLang, 'verifyProtocol')}
                                                </button>
                                            </>
                                        )}
                                        {editingConfigId && (
                                            <span className="px-2 py-2 bg-emerald-950/30 border border-emerald-900/50 text-emerald-300 rounded text-[10px] flex items-center gap-1">
                                                <CheckCircle2 size={12} />
                                                {t(currentLang, 'savedBadge')}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* 验证结果展示 */}
                                {(addressVerifyResult || protocolVerifyResult) && (
                                    <div className="space-y-1">
                                        {addressVerifyResult && (
                                            <div className={`p-2 rounded text-[10px] flex items-start gap-1.5 ${addressVerifyResult.ok ? 'bg-emerald-950/30 text-emerald-300 border border-emerald-900/50' : 'bg-red-950/30 text-red-300 border border-red-900/50'}`}>
                                                {addressVerifyResult.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                                                <div className="flex-1">
                                                    <div className="font-medium">
                                                        {addressVerifyResult.status === 0 && !addressVerifyResult.ok
                                                            ? t(currentLang, 'saveFailed')
                                                            : addressVerifyResult.ok ? t(currentLang, 'addressReachable') : t(currentLang, 'addressUnreachable')}
                                                    </div>
                                                    {addressVerifyResult.message && <div className="text-[9px] opacity-80 mt-0.5 whitespace-pre-wrap break-words">{addressVerifyResult.message}</div>}
                                                </div>
                                            </div>
                                        )}
                                        {protocolVerifyResult && (
                                            <div className={`p-2 rounded text-[10px] flex items-start gap-1.5 ${protocolVerifyResult.ok ? 'bg-emerald-950/30 text-emerald-300 border border-emerald-900/50' : 'bg-red-950/30 text-red-300 border border-red-900/50'}`}>
                                                {protocolVerifyResult.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                                                <div className="flex-1">
                                                    <div className="font-medium">{protocolVerifyResult.ok ? t(currentLang, 'protocolCompatible') : t(currentLang, 'protocolIncompatible')}</div>
                                                    {protocolVerifyResult.message && <div className="text-[9px] opacity-80 mt-0.5">{protocolVerifyResult.message}</div>}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* 模型列表 */}
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelList')}</label>
                                        {!editingConfigId && (
                                            <button
                                                onClick={handleFetchModels}
                                                disabled={!newConfig.base_url || fetchingModels}
                                                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded text-[10px] flex items-center gap-1 transition-colors"
                                            >
                                                {fetchingModels ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                                                {t(currentLang, 'fetchModels')}
                                            </button>
                                        )}
                                    </div>
                                    {fetchedModels.length > 0 ? (
                                        <select
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs text-white"
                                            value={selectedModelId}
                                            onChange={e => {
                                                setSelectedModelId(e.target.value)
                                                setNewConfig({...newConfig, default_model: e.target.value})
                                            }}
                                        >
                                            {fetchedModels.map(m => (
                                                <option key={m.id} value={m.id}>
                                                    {m.displayName || m.id}{m.contextWindow ? ` (${m.contextWindow / 1000}k ctx)` : ''}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        !editingConfigId && (
                                            <div className="p-2 bg-amber-950/20 border border-amber-900/30 text-amber-300 rounded text-[10px]">
                                                {t(currentLang, 'fetchModelsHint')}
                                            </div>
                                        )
                                    )}
                                </div>

                                {/* 高级配置 (复杂场景) */}
                                <div className="border border-slate-700 rounded-lg bg-slate-900/50 overflow-hidden">
                                    <button
                                        onClick={() => setAdvancedOpen(!advancedOpen)}
                                        className="w-full flex items-center justify-between p-2 bg-slate-800/30 hover:bg-slate-800/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-2 text-[10px] font-medium text-slate-300 uppercase tracking-wide">
                                            <Code size={12} className="text-indigo-400" />
                                            {t(currentLang, 'advancedConfig')}
                                        </div>
                                        {advancedOpen ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />}
                                    </button>
                                    {advancedOpen && (
                                        <div className="p-3 space-y-3 animate-in slide-in-from-top-1">
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelsEndpoint')}</label>
                                                    <input
                                                        type="text"
                                                        placeholder="/models"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={customModelsEndpoint}
                                                        onChange={e => setCustomModelsEndpoint(e.target.value)}
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'chatEndpoint')}</label>
                                                    <input
                                                        type="text"
                                                        placeholder="/chat/completions"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={customChatEndpoint}
                                                        onChange={e => setCustomChatEndpoint(e.target.value)}
                                                    />
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'customHeadersLabel')}</label>
                                                <textarea
                                                    placeholder={'{\n  "X-Custom-Header": "value"\n}'}
                                                    className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono h-16 resize-none"
                                                    value={customHeadersText}
                                                    onChange={e => setCustomHeadersText(e.target.value)}
                                                    spellCheck={false}
                                                />
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'maxTokensLabel')}</label>
                                                    <input
                                                        type="number"
                                                        placeholder="4096"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={newConfig.default_max_tokens ?? ''}
                                                        onChange={e => setNewConfig({...newConfig, default_max_tokens: e.target.value ? parseInt(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'temperatureLabel')}</label>
                                                    <input
                                                        type="number"
                                                        step="0.1"
                                                        min="0"
                                                        max="2"
                                                        placeholder="0.7"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={newConfig.default_temperature ?? ''}
                                                        onChange={e => setNewConfig({...newConfig, default_temperature: e.target.value ? parseFloat(e.target.value) : undefined})}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* 操作按钮 */}
                                <div className="flex justify-end gap-2 pt-2">
                                    <button
                                        onClick={handleCancelForm}
                                        disabled={savingConfig}
                                        className="px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-700 rounded disabled:opacity-50"
                                    >
                                        {t(currentLang, 'cancel')}
                                    </button>
                                    <button
                                        onClick={handleSaveWithVerify}
                                        disabled={savingConfig}
                                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-not-allowed text-white rounded text-xs font-medium flex items-center gap-1"
                                    >
                                        {savingConfig ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                        {savingConfig ? t(currentLang, 'saving') : t(currentLang, 'saveButton')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Configs List */}
                        <div className="space-y-2">
                            {isLoading ? <div className="text-center text-xs text-slate-500 py-4">{t(currentLang, 'loading')}</div> : 
                             configs.map(cfg => {
                                const isActive = cfg.id === settings.activeBackendConfigId;
                                return (
                                <div key={cfg.id} className={`p-3 rounded-lg border flex items-center justify-between transition-colors ${isActive ? 'bg-indigo-900/10 border-indigo-500/40' : 'bg-slate-800/30 border-slate-700'}`}>
                                    {deleteConfirmId === cfg.id ? (
                                        <div className="flex items-center justify-between w-full">
                                            <span className="text-xs text-red-300 font-medium">{t(currentLang, 'confirmDelete')}</span>
                                            <div className="flex gap-2">
                                                <button onClick={() => setDeleteConfirmId(null)} className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-slate-200">{t(currentLang, 'no')}</button>
                                                <button onClick={() => handleDeleteConfig(cfg.id)} className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 rounded text-white">{t(currentLang, 'yes')}</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className={`font-semibold text-sm ${isActive ? 'text-white' : 'text-slate-200'}`}>{cfg.name}</span>
                                                    {isActive && (
                                                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-indigo-500/20 text-indigo-300 text-[10px] rounded border border-indigo-500/30 font-medium">
                                                            <CheckCircle size={10} />
                                                            {t(currentLang, 'isDefault')}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] text-slate-400 mt-0.5 flex gap-2">
                                                    <span className="uppercase font-medium tracking-wide">{cfg.provider}</span>
                                                    <span>•</span>
                                                    <span className="font-mono text-slate-500">{cfg.default_model}</span>
                                                    {cfg.model_configs && Object.keys(cfg.model_configs).length > 0 && (
                                                        <>
                                                            <span>•</span>
                                                            <span className="text-indigo-400">{Object.keys(cfg.model_configs).length} {t(currentLang, 'modelConfigs').toLowerCase()}</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                {!isActive && (
                                                    <button onClick={() => handleSelectConfig(cfg.id)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors text-[10px] uppercase font-bold tracking-wider" title={t(currentLang, 'setAsDefault')}>
                                                        {t(currentLang, 'setAsDefault')}
                                                    </button>
                                                )}
                                                <button onClick={() => handleEditStart(cfg)} className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors" title={t(currentLang, 'editProvider')}>
                                                    <Edit2 size={14} />
                                                </button>
                                                <button onClick={() => setDeleteConfirmId(cfg.id)} className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors" title={t(currentLang, 'deleteConfig')}>
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )})}
                            {configs.length === 0 && !isLoading && <p className="text-center text-xs text-slate-500 italic py-2">{t(currentLang, 'noProvidersConfigured')}</p>}
                        </div>
                    </div>

                    <hr className="border-slate-800" />

                    {/* GitHub Integration */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-slate-200">{t(currentLang, 'githubIntegration')}</h3>
                        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-slate-400">{t(currentLang, 'statusLabel')}</span>
                                <div className="flex items-center gap-1.5">
                                    {githubStatus.has_token ? (
                                        <>
                                            <CheckCircle size={12} className="text-emerald-500" />
                                            <span className="text-xs text-emerald-400 font-medium">{t(currentLang, 'githubStatusConfigured')}</span>
                                        </>
                                    ) : (
                                        <>
                                            <AlertTriangle size={12} className="text-amber-500" />
                                            <span className="text-xs text-amber-400 font-medium">{t(currentLang, 'githubStatusNotConfigured')}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                            
                            <div className="flex gap-2">
                                <input 
                                    type="password" 
                                    placeholder={t(currentLang, 'githubTokenPlaceholder')}
                                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white"
                                    value={githubToken}
                                    onChange={e => setGithubToken(e.target.value)}
                                />
                                <button 
                                    onClick={handleUpdateGitHub} 
                                    disabled={!githubToken}
                                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-xs whitespace-nowrap"
                                >
                                    {t(currentLang, 'saveToken')}
                                </button>
                            </div>
                            
                            {githubStatus.has_token && (
                                <div className="flex justify-end">
                                    <button onClick={handleDeleteGitHub} className="text-[10px] text-red-400 hover:text-red-300 hover:underline">
                                        {t(currentLang, 'deleteToken')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                </div>
             )}
          </div>

          {!settings.usePythonBackend && (
            <>
              <hr className="border-slate-800" />

              {/* Provider Selection (Only if Backend Disabled) */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  {t(currentLang, 'provider')}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() =>
                      setSettings({ ...settings, provider: 'google', baseUrl: '' })
                    }
                    className={`p-3 rounded-xl border flex items-center justify-center gap-2 transition-all
                                        ${
                                          settings.provider === 'google'
                                            ? 'bg-indigo-600/20 border-indigo-500 text-indigo-200'
                                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                                        }`}
                  >
                    <span className="font-medium">
                      {t(currentLang, 'googleGemini')}
                    </span>
                  </button>
                  <button
                    onClick={() => setSettings({ ...settings, provider: 'custom' })}
                    className={`p-3 rounded-xl border flex items-center justify-center gap-2 transition-all
                                        ${
                                          settings.provider === 'custom'
                                            ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200'
                                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                                        }`}
                  >
                    <span className="font-medium">
                      {t(currentLang, 'customLocal')}
                    </span>
                  </button>
                </div>
              </div>

              {/* Dynamic Form Fields */}
              <div className="space-y-4">
                {/* API Key only for Custom provider */}
                {settings.provider === 'custom' && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
                      <Key size={14} />
                      {t(currentLang, 'apiKey')}
                    </label>
                    <input
                      type="password"
                      value={settings.apiKey}
                      onChange={(e) =>
                        setSettings({ ...settings, apiKey: e.target.value })
                      }
                      placeholder="sk-..."
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                    />
                    <p className="text-[10px] text-slate-500">
                      {t(currentLang, 'apiKeyOptional')}
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
                    <Cpu size={14} />
                    {t(currentLang, 'modelName')}
                  </label>
                  <input
                    type="text"
                    value={settings.modelName}
                    onChange={(e) =>
                      setSettings({ ...settings, modelName: e.target.value })
                    }
                    placeholder={
                      settings.provider === 'google'
                        ? 'gemini-2.5-flash'
                        : 'llama3:latest'
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                  />
                  <p className="text-[10px] text-slate-500">
                    {settings.provider === 'google'
                      ? t(currentLang, 'modelHintGoogle')
                      : t(currentLang, 'modelHintCustom')}
                  </p>
                </div>

                {settings.provider === 'custom' && (
                  <>
                    <div className="space-y-1">
                      <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
                        <Server size={14} />
                        {t(currentLang, 'baseUrl')}
                      </label>
                      <input
                        type="text"
                        value={settings.baseUrl}
                        onChange={(e) =>
                          setSettings({ ...settings, baseUrl: e.target.value })
                        }
                        placeholder="http://localhost:11434/v1"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 font-mono"
                      />
                      <div className="bg-amber-950/30 border border-amber-900/50 rounded-lg p-3 flex gap-2 mt-2">
                        <AlertTriangle
                          className="text-amber-500 flex-shrink-0"
                          size={14}
                        />
                        <p className="text-[10px] text-amber-200/80 leading-relaxed">
                          {t(currentLang, 'corsWarning')}
                        </p>
                      </div>
                    </div>

                    <div className="border border-slate-800 rounded-xl bg-slate-900/50 overflow-hidden">
                        <button 
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="w-full flex items-center justify-between p-3 bg-slate-800/30 hover:bg-slate-800/50 transition-colors"
                        >
                            <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                                <Code size={14} className="text-indigo-400" />
                                {t(currentLang, 'advancedSettings')}
                            </div>
                            {showAdvanced ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                        </button>
                        
                        {showAdvanced && (
                            <div className="p-4 space-y-4 animate-in slide-in-from-top-2">
                                <p className="text-[10px] text-slate-500">{t(currentLang, 'advancedHint')}</p>
                                
                                <div className="space-y-1">
                                    <label className="text-[10px] uppercase font-bold text-slate-500">{t(currentLang, 'apiEndpoint')}</label>
                                    <input 
                                        type="text" 
                                        value={settings.customConfig?.endpoint || DEFAULT_CUSTOM_ENDPOINT}
                                        onChange={(e) => setSettings({...settings, customConfig: {...settings.customConfig, endpoint: e.target.value}})}
                                        className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs text-slate-300 font-mono"
                                        placeholder="/chat/completions"
                                    />
                                </div>

                                <div className="space-y-1">
                                    <label className="text-[10px] uppercase font-bold text-slate-500">{t(currentLang, 'apiHeaders')}</label>
                                    <textarea 
                                        value={settings.customConfig?.headers || DEFAULT_CUSTOM_HEADERS}
                                        onChange={(e) => setSettings({...settings, customConfig: {...settings.customConfig, headers: e.target.value}})}
                                        className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs text-slate-300 font-mono h-24 resize-none"
                                        spellCheck={false}
                                    />
                                </div>

                                <div className="flex justify-end">
                                    <button onClick={resetCustomConfig} className="text-[10px] text-indigo-400 hover:text-indigo-300 hover:underline">
                                        {t(currentLang, 'resetDefault')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 bg-slate-900 border-t border-slate-800 flex justify-end gap-3 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            {t(currentLang, 'settingsCancel')}
          </button>
          <button
            onClick={handleSaveSettings}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/20 flex items-center gap-2 transition-colors"
          >
            <Save size={16} />
            {t(currentLang, 'settingsSave')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
