

import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Code,
  Cpu,
  Edit2,
  Key,
  Languages,
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

import { createBackendConfig, deleteBackendConfig, deleteGitHubToken, fetchBackendConfigs, getGitHubStatus, setBackendDefault, updateBackendConfig, updateGitHubToken } from '../services/configService'
import { AppSettings, BackendConfig, BackendConfigCreate, GitHubTokenStatus, Language, ModelConfig, ProviderType } from '../types'
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
  const [showBackendAdvanced, setShowBackendAdvanced] = useState(false) // Toggle for Backend Form
  
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

  // Model Config State
  const [showModelForm, setShowModelForm] = useState(false)
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null)
  const [showModelAdvanced, setShowModelAdvanced] = useState(false)
  const [deleteModelConfirmKey, setDeleteModelConfirmKey] = useState<string | null>(null)
  const [currentModel, setCurrentModel] = useState<ModelConfig>({
      id: ''
  })

  // Advanced Custom Settings Toggle (Direct Mode)
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setSettings(currentSettings)
  }, [currentSettings, isOpen])

  // Fetch backend data when modal opens or backend URL changes
  useEffect(() => {
      if (isOpen && settings.usePythonBackend && settings.pythonBackendUrl) {
          refreshBackendData();
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
      setShowBackendAdvanced(false);
      setShowModelForm(false);
      setEditingModelKey(null);
      setShowModelAdvanced(false);
      setDeleteModelConfirmKey(null);
      setFormErrors({});
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
      setShowBackendAdvanced(false);
      setShowModelForm(false);
      setEditingModelKey(null);
      setShowModelAdvanced(false);
      setDeleteModelConfirmKey(null);
      setCurrentModel({ id: '' });
  };

  const validateForm = () => {
      const errors: Record<string, boolean> = {};
      if (!newConfig.name?.trim()) errors.name = true;
      if (!newConfig.model_configs || Object.keys(newConfig.model_configs).length === 0) errors.default_model = true;
      
      if (!editingConfigId && !newConfig.api_key?.trim()) {
        errors.api_key = true;
      }
      if (editingConfigId && !newConfig.api_key?.trim()) {
        const editingConfig = configs.find(c => c.id === editingConfigId);
        if (!editingConfig?.has_api_key) {
          errors.api_key = true;
        }
      }
      
      setFormErrors(errors);
      return Object.keys(errors).length === 0;
  };

  const handleSaveConfig = async () => {
      if (!settings.pythonBackendUrl) return;
      if (!validateForm()) return;

      try {
          // Validate JSON fields if custom
          if (newConfig.provider === 'custom' && newConfig.custom_config) {
              try { JSON.parse(newConfig.custom_config.headers || '{}'); } catch { alert('Invalid JSON in Headers'); return; }
          }

          const modelKeys = Object.keys(newConfig.model_configs || {});
          let resolvedDefaultModel = newConfig.default_model;
          if (!resolvedDefaultModel && modelKeys.length > 0) {
              resolvedDefaultModel = newConfig.model_configs![modelKeys[0]].id;
          }

          console.log('[DEBUG] handleSaveConfig - model_configs:', JSON.stringify(newConfig.model_configs));
          console.log('[DEBUG] handleSaveConfig - resolvedDefaultModel:', resolvedDefaultModel);

          if (editingConfigId) {
              const updatePayload = { ...newConfig, default_model: resolvedDefaultModel };
              if (!updatePayload.api_key) {
                  delete updatePayload.api_key;
              }
              console.log('[DEBUG] updatePayload - model_configs:', JSON.stringify(updatePayload.model_configs));
              await updateBackendConfig(settings.pythonBackendUrl, editingConfigId, updatePayload);
          } else {
              const isFirstConfig = configs.length === 0;
              const configToCreate = { ...newConfig, default_model: resolvedDefaultModel, is_default: isFirstConfig || newConfig.is_default };
              const created = await createBackendConfig(settings.pythonBackendUrl, configToCreate);
              if (configToCreate.is_default) {
                  setSettings(prev => ({ ...prev, activeBackendConfigId: created.id }));
              }
          }
          handleCancelForm();
          refreshBackendData();
      } catch (e) {
          console.error(e);
          alert('Failed to save config');
      }
  };

  const handleDeleteConfig = async (id: string) => {
      if (!settings.pythonBackendUrl) return;
      try {
          await deleteBackendConfig(settings.pythonBackendUrl, id);
          setDeleteConfirmId(null);
          refreshBackendData();
      if (settings.activeBackendConfigId === id) {
              setSettings(prev => ({ ...prev, activeBackendConfigId: undefined }));
          }
      } catch (e) {
          console.error(e);
      }
  };

  const handleUpdateGitHub = async () => {
      if (!settings.pythonBackendUrl) return;
      try {
          await updateGitHubToken(settings.pythonBackendUrl, githubToken);
          setGithubToken('');
          refreshBackendData();
      } catch (e) {
          console.error(e);
          alert('Failed to update GitHub token');
      }
  };

  const handleDeleteGitHub = async () => {
      if (!settings.pythonBackendUrl || !window.confirm(t(currentLang, 'confirmDelete'))) return;
      try {
          await deleteGitHubToken(settings.pythonBackendUrl);
          refreshBackendData();
      } catch (e) {
          console.error(e);
      }
  };

  const resetCustomConfig = () => {
      setSettings(prev => ({
          ...prev,
          customConfig: {
              endpoint: DEFAULT_CUSTOM_ENDPOINT,
              headers: DEFAULT_CUSTOM_HEADERS
          }
      }));
  };

  const resetBackendCustomConfig = () => {
      setNewConfig(prev => ({
          ...prev,
          custom_config: {
              endpoint: DEFAULT_CUSTOM_ENDPOINT,
              headers: DEFAULT_CUSTOM_HEADERS
          }
      }));
  };

  // --- Model Config Actions ---
  const handleAddModel = () => {
      setCurrentModel({ id: '' });
      setEditingModelKey(null);
      setShowModelForm(true);
      setShowModelAdvanced(false);
  };

  const handleEditModel = (key: string) => {
      const modelConfigs = newConfig.model_configs || {};
      const model = modelConfigs[key];
      if (model) {
          setCurrentModel({ ...model });
          setEditingModelKey(key);
          setShowModelForm(true);
          setShowModelAdvanced(false);
      }
  };

  const handleSaveModel = () => {
      if (!currentModel.id.trim()) {
          setFormErrors(prev => ({ ...prev, model_id: true }));
          return;
      }
      setFormErrors(prev => {
          const next = { ...prev };
          delete next.model_id;
          return next;
      });

      const modelConfigs = { ...(newConfig.model_configs || {}) };
      const key = editingModelKey || currentModel.id;
      modelConfigs[key] = { ...currentModel };

      if (editingModelKey && editingModelKey !== currentModel.id) {
          delete modelConfigs[editingModelKey];
      }

      const isFirstModel = Object.keys(modelConfigs).length > 0 && !newConfig.default_model;
      const defaultModel = isFirstModel ? currentModel.id : newConfig.default_model;

      setNewConfig(prev => ({ ...prev, model_configs: modelConfigs, default_model: defaultModel }));
      setShowModelForm(false);
      setEditingModelKey(null);
      setCurrentModel({ id: '' });
      setShowModelAdvanced(false);
  };

  const handleDeleteModel = (key: string) => {
      const modelConfigs = { ...(newConfig.model_configs || {}) };
      delete modelConfigs[key];
      let defaultModel = newConfig.default_model;
      if (defaultModel === key) {
          const remainingKeys = Object.keys(modelConfigs);
          defaultModel = remainingKeys.length > 0 ? modelConfigs[remainingKeys[0]].id : '';
      }
      setNewConfig(prev => ({ ...prev, model_configs: modelConfigs, default_model: defaultModel }));
      setDeleteModelConfirmKey(null);
  };

  const handleCancelModel = () => {
      setShowModelForm(false);
      setEditingModelKey(null);
      setCurrentModel({ id: '' });
      setShowModelAdvanced(false);
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
                                <button onClick={refreshBackendData} className="text-[10px] flex items-center gap-1 text-indigo-400 hover:text-indigo-300"><RefreshCw size={10}/> Refresh</button>
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

                        {/* Add/Edit Config Form */}
                        {showAddForm && (
                            <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 space-y-3 animate-in fade-in zoom-in-95 duration-100">
                                <div className="text-xs font-bold text-slate-300 uppercase mb-2">{editingConfigId ? t(currentLang, 'editProvider') : t(currentLang, 'addProvider')}</div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <input 
                                            placeholder={t(currentLang, 'providerName')} 
                                            className={`w-full bg-slate-950 border rounded p-2 text-xs text-white ${formErrors.name ? 'border-red-500' : 'border-slate-700'}`} 
                                            value={newConfig.name} 
                                            onChange={e => setNewConfig({...newConfig, name: e.target.value})} 
                                        />
                                        {formErrors.name && <p className="text-[9px] text-red-400">{t(currentLang, 'requiredField')}</p>}
                                    </div>
                                    <select className="bg-slate-950 border border-slate-700 rounded p-2 text-xs text-white" value={newConfig.provider} onChange={e => setNewConfig({...newConfig, provider: e.target.value as ProviderType})}>
                                        <option value="anthropic">Anthropic Claude</option>
                                        <option value="openai">OpenAI</option>
                                        <option value="deepseek">DeepSeek</option>
                                        <option value="zhipu">Zhipu (智谱)</option>
                                        <option value="moonshot">Moonshot (月之暗面)</option>
                                        <option value="qwen">Qwen (通义千问)</option>
                                        <option value="google">Google Gemini</option>
                                        <option value="custom">Custom / Local</option>
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <input 
                                        type="password" 
                                        placeholder={editingConfigId ? `${t(currentLang, 'apiKey')} (${t(currentLang, 'leaveEmptyToKeep') || 'Leave empty to keep current'})` : t(currentLang, 'apiKey')} 
                                        className={`w-full bg-slate-950 border rounded p-2 text-xs text-white ${formErrors.api_key ? 'border-red-500' : 'border-slate-700'}`} 
                                        value={newConfig.api_key} 
                                        onChange={e => setNewConfig({...newConfig, api_key: e.target.value})} 
                                    />
                                    {formErrors.api_key && <p className="text-[9px] text-red-400">{t(currentLang, 'requiredField')}</p>}
                                </div>
                                {newConfig.model_configs && Object.keys(newConfig.model_configs).length > 0 ? (
                                    <div className="space-y-1">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'selectModel')}</label>
                                        <select
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs text-white"
                                            value={newConfig.default_model || ''}
                                            onChange={e => setNewConfig({...newConfig, default_model: e.target.value})}
                                        >
                                            {Object.entries(newConfig.model_configs).map(([key, model]) => (
                                                <option key={key} value={model.id}>{model.displayName || model.id}</option>
                                            ))}
                                        </select>
                                    </div>
                                ) : (
                                    <div className={`p-2 border rounded text-[10px] ${formErrors.default_model ? 'bg-red-950/20 border-red-900/50 text-red-300' : 'bg-amber-950/20 border-amber-900/30 text-amber-300'}`}>
                                        {formErrors.default_model ? t(currentLang, 'modelIdRequired') : `${t(currentLang, 'noModelsConfigured')} — ${t(currentLang, 'addModel').toLowerCase()}`}
                                    </div>
                                )}
                                {newConfig.provider === 'custom' && (
                                    <>
                                        <input placeholder={t(currentLang, 'baseUrl')} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs text-white" value={newConfig.base_url} onChange={e => setNewConfig({...newConfig, base_url: e.target.value})} />
                                        
                                        {/* Backend Advanced Custom Config */}
                                        <div className="border border-slate-700 rounded-lg bg-slate-900/50 overflow-hidden">
                                            <button 
                                                onClick={() => setShowBackendAdvanced(!showBackendAdvanced)}
                                                className="w-full flex items-center justify-between p-2 bg-slate-800/30 hover:bg-slate-800/50 transition-colors"
                                            >
                                                <div className="flex items-center gap-2 text-[10px] font-medium text-slate-300 uppercase tracking-wide">
                                                    <Code size={12} className="text-indigo-400" />
                                                    {t(currentLang, 'advancedSettings')}
                                                </div>
                                                {showBackendAdvanced ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />}
                                            </button>
                                            
                                            {showBackendAdvanced && (
                                                <div className="p-3 space-y-3 animate-in slide-in-from-top-1">
                                                    <div className="space-y-1">
                                                        <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'apiEndpoint')}</label>
                                                        <input 
                                                            type="text" 
                                                            value={newConfig.custom_config?.endpoint || DEFAULT_CUSTOM_ENDPOINT}
                                                            onChange={(e) => setNewConfig({...newConfig, custom_config: {...newConfig.custom_config, endpoint: e.target.value}})}
                                                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                            placeholder="/chat/completions"
                                                        />
                                                    </div>

                                                    <div className="space-y-1">
                                                        <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'apiHeaders')}</label>
                                                        <textarea 
                                                            value={newConfig.custom_config?.headers || DEFAULT_CUSTOM_HEADERS}
                                                            onChange={(e) => setNewConfig({...newConfig, custom_config: {...newConfig.custom_config, headers: e.target.value}})}
                                                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono h-16 resize-none"
                                                            spellCheck={false}
                                                        />
                                                    </div>

                                                    <div className="flex justify-end">
                                                        <button onClick={resetBackendCustomConfig} className="text-[9px] text-indigo-400 hover:text-indigo-300 hover:underline">
                                                            {t(currentLang, 'resetDefault')}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">Max Tokens</label>
                                        <input 
                                            type="number"
                                            placeholder="4096"
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                            value={newConfig.default_max_tokens ?? ''}
                                            onChange={e => setNewConfig({...newConfig, default_max_tokens: e.target.value ? parseInt(e.target.value) : undefined})}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">Temperature</label>
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
                                    <div className="space-y-1">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">Retries</label>
                                        <input 
                                            type="number"
                                            placeholder="2"
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                            value={newConfig.retries ?? ''}
                                            onChange={e => setNewConfig({...newConfig, retries: e.target.value ? parseInt(e.target.value) : undefined})}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[9px] uppercase font-bold text-slate-500">Retry Delay (ms)</label>
                                        <input 
                                            type="number"
                                            placeholder="1000"
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                            value={newConfig.retry_delay ?? ''}
                                            onChange={e => setNewConfig({...newConfig, retry_delay: e.target.value ? parseInt(e.target.value) : undefined})}
                                        />
                                    </div>
                                </div>

                                {/* Model Configurations */}
                                <div className="border border-slate-700 rounded-lg bg-slate-900/50 overflow-hidden">
                                    <div className="flex items-center justify-between p-2 bg-slate-800/30">
                                        <div className="text-[10px] font-medium text-slate-300 uppercase tracking-wide">
                                            {t(currentLang, 'modelConfigs')}
                                        </div>
                                        <button 
                                            onClick={handleAddModel}
                                            className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[10px] flex items-center gap-1 transition-colors"
                                        >
                                            <Plus size={10} /> {t(currentLang, 'addModel')}
                                        </button>
                                    </div>

                                    {/* Model Form */}
                                    {showModelForm && (
                                        <div className="p-3 border-t border-slate-700/50 space-y-2 bg-slate-800/20">
                                            <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">{editingModelKey ? t(currentLang, 'editModel') : t(currentLang, 'addModel')}</div>
                                            
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelId')} *</label>
                                                    <input 
                                                        placeholder="gpt-4o"
                                                        className={`w-full bg-slate-950 border rounded p-1.5 text-[10px] text-white ${formErrors.model_id ? 'border-red-500' : 'border-slate-700'}`}
                                                        value={currentModel.id}
                                                        onChange={e => setCurrentModel({...currentModel, id: e.target.value})}
                                                    />
                                                    {formErrors.model_id && <p className="text-[8px] text-red-400">{t(currentLang, 'modelIdRequired')}</p>}
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelDisplayName')}</label>
                                                    <input 
                                                        placeholder="GPT-4o"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-white"
                                                        value={currentModel.displayName || ''}
                                                        onChange={e => setCurrentModel({...currentModel, displayName: e.target.value})}
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-3 gap-2">
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'contextWindow')}</label>
                                                    <input 
                                                        type="number"
                                                        placeholder="128000"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.contextWindow ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, contextWindow: e.target.value ? parseInt(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'maxOutputTokens')}</label>
                                                    <input 
                                                        type="number"
                                                        placeholder="16384"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.maxOutputTokens ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, maxOutputTokens: e.target.value ? parseInt(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'defaultMaxTokens')}</label>
                                                    <input 
                                                        type="number"
                                                        placeholder="4096"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.defaultMaxTokens ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, defaultMaxTokens: e.target.value ? parseInt(e.target.value) : undefined})}
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-3 gap-2">
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'inputPrice')}</label>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        placeholder="2.5"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.inputPricePerMToken ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, inputPricePerMToken: e.target.value ? parseFloat(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'outputPrice')}</label>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        placeholder="10.0"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.outputPricePerMToken ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, outputPricePerMToken: e.target.value ? parseFloat(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'priceUnitLabel')}</label>
                                                    <select
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.priceUnit ?? 'M'}
                                                        onChange={e => setCurrentModel({...currentModel, priceUnit: e.target.value as 'M' | 'K'})}
                                                    >
                                                        <option value="M">$/M tokens</option>
                                                        <option value="K">$/K tokens</option>
                                                    </select>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'defaultTemperature')}</label>
                                                    <input 
                                                        type="number"
                                                        step="0.1"
                                                        min="0"
                                                        max="2"
                                                        placeholder="0.7"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.defaultTemperature ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, defaultTemperature: e.target.value ? parseFloat(e.target.value) : undefined})}
                                                    />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'maxTemperature')}</label>
                                                    <input 
                                                        type="number"
                                                        step="0.1"
                                                        placeholder="2.0"
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                        value={currentModel.maxTemperature ?? ''}
                                                        onChange={e => setCurrentModel({...currentModel, maxTemperature: e.target.value ? parseFloat(e.target.value) : undefined})}
                                                    />
                                                </div>
                                            </div>

                                            {/* Capability Toggles */}
                                            <div className="flex flex-wrap gap-2">
                                                {([
                                                    ['supportsVision', t(currentLang, 'supportsVision')],
                                                    ['supportsToolUse', t(currentLang, 'supportsToolUse')],
                                                    ['supportsStreaming', t(currentLang, 'supportsStreaming')],
                                                    ['supportsThinking', t(currentLang, 'supportsThinking')],
                                                    ['supportsReasoningEffort', t(currentLang, 'supportsReasoningEffort')],
                                                ] as [keyof ModelConfig, string][]).map(([key, label]) => (
                                                    <button
                                                        key={key}
                                                        onClick={() => setCurrentModel(prev => ({...prev, [key]: !prev[key]}))}
                                                        className={`px-2 py-1 rounded text-[9px] font-medium border transition-colors ${
                                                            currentModel[key]
                                                                ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                                                                : 'bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-600'
                                                        }`}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>

                                            {/* Advanced Model Settings */}
                                            <div className="border border-slate-700/50 rounded bg-slate-900/30 overflow-hidden">
                                                <button 
                                                    onClick={() => setShowModelAdvanced(!showModelAdvanced)}
                                                    className="w-full flex items-center justify-between p-1.5 bg-slate-800/20 hover:bg-slate-800/40 transition-colors"
                                                >
                                                    <div className="flex items-center gap-1.5 text-[9px] font-medium text-slate-400 uppercase tracking-wide">
                                                        <Code size={10} className="text-indigo-400" />
                                                        {t(currentLang, 'modelAdvanced')}
                                                    </div>
                                                    {showModelAdvanced ? <ChevronDown size={10} className="text-slate-500" /> : <ChevronRight size={10} className="text-slate-500" />}
                                                </button>
                                                
                                                {showModelAdvanced && (
                                                    <div className="p-2 space-y-2">
                                                        <div className="space-y-0.5">
                                                            <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'thinkingBudget')}</label>
                                                            <input 
                                                                type="number"
                                                                placeholder="10000"
                                                                className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                                value={currentModel.thinkingBudget ?? ''}
                                                                onChange={e => setCurrentModel({...currentModel, thinkingBudget: e.target.value ? parseInt(e.target.value) : undefined})}
                                                            />
                                                        </div>
                                                        <div className="space-y-0.5">
                                                            <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelBaseUrl')}</label>
                                                            <input 
                                                                placeholder="https://api.example.com/v1"
                                                                className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                                value={currentModel.baseUrl || ''}
                                                                onChange={e => setCurrentModel({...currentModel, baseUrl: e.target.value || undefined})}
                                                            />
                                                        </div>
                                                        <div className="space-y-0.5">
                                                            <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelStreamingUrl')}</label>
                                                            <input 
                                                                placeholder="https://stream.example.com/v1"
                                                                className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                                value={currentModel.streamingBaseUrl || ''}
                                                                onChange={e => setCurrentModel({...currentModel, streamingBaseUrl: e.target.value || undefined})}
                                                            />
                                                        </div>
                                                        <div className="space-y-0.5">
                                                            <label className="text-[9px] uppercase font-bold text-slate-500">{t(currentLang, 'modelApiKey')}</label>
                                                            <input 
                                                                type="password"
                                                                placeholder="sk-..."
                                                                className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 font-mono"
                                                                value={currentModel.apiKey || ''}
                                                                onChange={e => setCurrentModel({...currentModel, apiKey: e.target.value || undefined})}
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex justify-end gap-2 pt-1">
                                                <button onClick={handleCancelModel} className="px-2 py-1 text-[10px] text-slate-400 hover:text-white border border-transparent hover:border-slate-700 rounded">{t(currentLang, 'settingsCancel')}</button>
                                                <button onClick={handleSaveModel} className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-medium">
                                                    {editingModelKey ? t(currentLang, 'update') : t(currentLang, 'addModel')}
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Model List */}
                                    {Object.keys(newConfig.model_configs || {}).length > 0 ? (
                                        <div className="divide-y divide-slate-700/30">
                                            {Object.entries(newConfig.model_configs || {}).map(([key, model]) => (
                                                <div key={key} className="px-3 py-2 flex items-center justify-between hover:bg-slate-800/20 transition-colors">
                                                    {deleteModelConfirmKey === key ? (
                                                        <div className="flex items-center justify-between w-full">
                                                            <span className="text-[10px] text-red-300">{t(currentLang, 'confirmDeleteModel')}</span>
                                                            <div className="flex gap-1">
                                                                <button onClick={() => setDeleteModelConfirmKey(null)} className="px-1.5 py-0.5 text-[9px] bg-slate-700 hover:bg-slate-600 rounded text-slate-200">{t(currentLang, 'no')}</button>
                                                                <button onClick={() => handleDeleteModel(key)} className="px-1.5 py-0.5 text-[9px] bg-red-600 hover:bg-red-500 rounded text-white">{t(currentLang, 'yes')}</button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <div className="min-w-0 flex-1">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="text-[11px] font-medium text-slate-200 truncate">{model.displayName || model.id}</span>
                                                                    <span className="text-[9px] text-slate-500 font-mono truncate">{model.id}</span>
                                                                    {newConfig.default_model === model.id && (
                                                                        <span className="px-1 py-0.5 bg-indigo-500/20 text-indigo-300 text-[8px] rounded border border-indigo-500/30 font-medium">
                                                                            {t(currentLang, 'isDefault')}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="flex items-center gap-2 mt-0.5 text-[9px] text-slate-500">
                                                                    {model.contextWindow && <span>{(model.contextWindow / 1000).toFixed(0)}K {t(currentLang, 'tokens')}</span>}
                                                                    {model.inputPricePerMToken !== undefined && <span>${model.inputPricePerMToken}/{model.priceUnit === 'K' ? 'K' : 'M'}</span>}
                                                                    {model.outputPricePerMToken !== undefined && <span>→ ${model.outputPricePerMToken}</span>}
                                                                    <div className="flex gap-1">
                                                                        {model.supportsVision && <span className="px-1 bg-indigo-500/10 text-indigo-400 rounded">👁</span>}
                                                                        {model.supportsToolUse && <span className="px-1 bg-emerald-500/10 text-emerald-400 rounded">🔧</span>}
                                                                        {model.supportsThinking && <span className="px-1 bg-amber-500/10 text-amber-400 rounded">🧠</span>}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-0.5 ml-2">
                                                                {newConfig.default_model !== model.id && (
                                                                    <button onClick={() => setNewConfig(prev => ({...prev, default_model: model.id}))} className="p-1 text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors text-[9px] uppercase font-bold tracking-wider" title={t(currentLang, 'setAsDefault')}>
                                                                        {t(currentLang, 'setAsDefault')}
                                                                    </button>
                                                                )}
                                                                <button onClick={() => handleEditModel(key)} className="p-1 text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors" title={t(currentLang, 'editModel')}>
                                                                    <Edit2 size={11} />
                                                                </button>
                                                                <button onClick={() => setDeleteModelConfirmKey(key)} className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors" title={t(currentLang, 'deleteModel')}>
                                                                    <Trash2 size={11} />
                                                                </button>
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-3 text-center text-[10px] text-slate-500 italic">
                                            {t(currentLang, 'noModelsConfigured')}
                                        </div>
                                    )}
                                </div>

                                <div className="flex justify-end gap-2 pt-2">
                                    <button onClick={handleCancelForm} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-700 rounded">{t(currentLang, 'settingsCancel')}</button>
                                    <button onClick={handleSaveConfig} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium">
                                        {editingConfigId ? t(currentLang, 'update') : t(currentLang, 'settingsSave')}
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
                            {configs.length === 0 && !isLoading && <p className="text-center text-xs text-slate-500 italic py-2">No providers configured</p>}
                        </div>
                    </div>

                    <hr className="border-slate-800" />

                    {/* GitHub Integration */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-slate-200">{t(currentLang, 'githubIntegration')}</h3>
                        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-slate-400">Status</span>
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