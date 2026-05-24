
import { BackendConfig, BackendConfigCreate, GitHubTokenStatus, MCPServerInfo, SkillInfo, FeatureGateInfo, TelemetryStatus, CircuitBreakerStats, CostTrackerInfo, MemoryInfo } from '../types';

const getBaseUrl = (url: string) => url.replace(/\/$/, '');

// --- Provider Configuration Endpoints ---

export const fetchBackendConfigs = async (backendUrl: string): Promise<BackendConfig[]> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs`);
    if (!res.ok) throw new Error('Failed to fetch configs');
    const data = await res.json();
    return data.configs || [];
};

export const createBackendConfig = async (backendUrl: string, config: BackendConfigCreate): Promise<BackendConfig> => {
    if(config.provider !== 'custom'){
        delete config.custom_config
    }
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error('Failed to create config');
    return res.json();
};

export const updateBackendConfig = async (backendUrl: string, id: string, config: Partial<BackendConfigCreate>): Promise<BackendConfig> => {
    const payload = { ...config };
    if (payload.provider && payload.provider !== 'custom') {
        delete payload.custom_config;
    }
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to update config');
    return res.json();
};

export const deleteBackendConfig = async (backendUrl: string, id: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs/${id}`, {
        method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete config');
};

export const setBackendDefault = async (backendUrl: string, id: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs/set-default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_id: id })
    });
    if (!res.ok) throw new Error('Failed to set default config');
};

// --- GitHub Token Endpoints ---

export const getGitHubStatus = async (backendUrl: string): Promise<GitHubTokenStatus> => {
    try {
        const res = await fetch(`${getBaseUrl(backendUrl)}/api/github-token`);
        if (!res.ok) return { has_token: false };
        return res.json();
    } catch {
        return { has_token: false };
    }
};

export const updateGitHubToken = async (backendUrl: string, token: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/github-token`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
    if (!res.ok) throw new Error('Failed to update GitHub token');
};

export const deleteGitHubToken = async (backendUrl: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/github-token`, {
        method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete GitHub token');
};

// --- Action Endpoints ---

export const executeAction = async (backendUrl: string, actionType: string, actionData: Record<string, unknown>): Promise<{ success: boolean; message: string; data?: unknown; can_undo?: boolean }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/actions/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_type: actionType, action_data: actionData })
    });
    if (!res.ok) throw new Error('Failed to execute action');
    return res.json();
};

export const undoAction = async (backendUrl: string): Promise<{ success: boolean; message: string; restored_state?: unknown }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/actions/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Failed to undo action');
    return res.json();
};

// --- User Input Endpoint (for approval/human_input) ---

export const submitUserInput = async (backendUrl: string, payload: {
    session_id: string;
    action_id: string;
    decision?: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    reason?: string;
    value?: string;
    optionValue?: string;
}): Promise<{ success: boolean; message: string }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/sessions/${payload.session_id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            actionId: payload.action_id,
            decision: payload.decision,
            updatedInput: payload.updatedInput,
            reason: payload.reason,
            value: payload.value,
            optionValue: payload.optionValue,
        })
    });
    if (!res.ok) throw new Error('Failed to submit user input');
    return res.json();
};

// --- Health Check ---

export const checkBackendHealth = async (backendUrl: string): Promise<{ status: string; service: string; version: string } | null> => {
    try {
        const res = await fetch(`${getBaseUrl(backendUrl)}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
};

export const analyzeWorkflow = async (backendUrl: string, workflow: Record<string, unknown>, language: string): Promise<{
    issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>;
    analysis?: Record<string, unknown>;
}> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/workflow/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow, language })
    });
    if (!res.ok) throw new Error('Failed to analyze workflow');
    return res.json();
};

// --- MCP Server Endpoints ---

export const fetchMCPServers = async (backendUrl: string): Promise<MCPServerInfo[]> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers`);
    if (!res.ok) throw new Error('Failed to fetch MCP servers');
    const data = await res.json();
    return data.servers || data;
};

export const fetchMCPServer = async (backendUrl: string, name: string): Promise<MCPServerInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('Failed to fetch MCP server');
    return res.json();
};

export const addMCPServer = async (backendUrl: string, config: { name: string; transport: string; command?: string; url?: string; args?: string[]; env?: Record<string, string> }): Promise<MCPServerInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error('Failed to add MCP server');
    return res.json();
};

export const deleteMCPServer = async (backendUrl: string, name: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete MCP server');
};

export const connectMCPServer = async (backendUrl: string, name: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers/${encodeURIComponent(name)}/connect`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to connect MCP server');
};

export const disconnectMCPServer = async (backendUrl: string, name: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/servers/${encodeURIComponent(name)}/disconnect`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to disconnect MCP server');
};

export const fetchMCPTools = async (backendUrl: string): Promise<Array<{ name: string; description: string; serverName: string }>> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/mcp/tools`);
    if (!res.ok) throw new Error('Failed to fetch MCP tools');
    const data = await res.json();
    return data.tools || data;
};

// --- Skills Endpoints ---

export const fetchSkills = async (backendUrl: string): Promise<SkillInfo[]> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/skills`);
    if (!res.ok) throw new Error('Failed to fetch skills');
    const data = await res.json();
    return data.skills || data;
};

export const fetchSkill = async (backendUrl: string, name: string): Promise<SkillInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/skills/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('Failed to fetch skill');
    return res.json();
};

export const addSkill = async (backendUrl: string, config: { name: string; description: string; whenToUse?: string; userInvocable?: boolean; source?: string }): Promise<SkillInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error('Failed to add skill');
    return res.json();
};

export const deleteSkill = async (backendUrl: string, name: string): Promise<void> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete skill');
};

// --- Feature Gate Endpoints ---

export const fetchFeatureGates = async (backendUrl: string): Promise<FeatureGateInfo[]> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/feature-gates`);
    if (!res.ok) throw new Error('Failed to fetch feature gates');
    const data = await res.json();
    return data.gates || [];
};

export const fetchFeatureGate = async (backendUrl: string, name: string): Promise<FeatureGateInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/feature-gates/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('Failed to fetch feature gate');
    const data = await res.json();
    return data.gate;
};

export const overrideFeatureGate = async (backendUrl: string, name: string, enabled: boolean): Promise<FeatureGateInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/feature-gates/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled })
    });
    if (!res.ok) throw new Error('Failed to override feature gate');
    const data = await res.json();
    return data.gate;
};

export const resetFeatureGate = async (backendUrl: string, name: string): Promise<FeatureGateInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/feature-gates/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error('Failed to reset feature gate');
    const data = await res.json();
    return data.gate;
};

export const resetAllFeatureGates = async (backendUrl: string): Promise<FeatureGateInfo[]> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/feature-gates/reset-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Failed to reset all feature gates');
    const data = await res.json();
    return data.gates || [];
};

// --- Telemetry Endpoints ---

export const fetchTelemetryStatus = async (backendUrl: string): Promise<TelemetryStatus> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/telemetry/status`);
    if (!res.ok) throw new Error('Failed to fetch telemetry status');
    return res.json();
};

export const toggleTelemetry = async (backendUrl: string, enabled: boolean): Promise<{ enabled: boolean }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/telemetry/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error('Failed to toggle telemetry');
    return res.json();
};

export const flushTelemetry = async (backendUrl: string): Promise<{ success: boolean }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/telemetry/flush`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Failed to flush telemetry');
    return res.json();
};

// --- Circuit Breaker Endpoints ---

export const fetchCircuitBreakerStatus = async (backendUrl: string): Promise<{ compact: CircuitBreakerStats; consolidation: CircuitBreakerStats }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/circuit-breaker`);
    if (!res.ok) throw new Error('Failed to fetch circuit breaker status');
    return res.json();
};

export const resetCircuitBreaker = async (backendUrl: string, type?: 'compact' | 'consolidation' | 'all'): Promise<{ success: boolean }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/circuit-breaker/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type || 'all' })
    });
    if (!res.ok) throw new Error('Failed to reset circuit breaker');
    return res.json();
};

// --- Cost Tracker Endpoints ---

export const fetchCostTracker = async (backendUrl: string, sessionId: string): Promise<CostTrackerInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/cost`);
    if (!res.ok) throw new Error('Failed to fetch cost tracker');
    return res.json();
};

export const setBudget = async (backendUrl: string, sessionId: string, maxBudgetUsd: number): Promise<CostTrackerInfo> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/budget`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxBudgetUsd })
    });
    if (!res.ok) throw new Error('Failed to set budget');
    return res.json();
};

// --- Memory Endpoints ---

export const fetchMemories = async (backendUrl: string): Promise<{ count: number; global: number; project: number; session: number; memories: MemoryInfo[] }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/memories`);
    if (!res.ok) throw new Error('Failed to fetch memories');
    return res.json();
};

export const searchMemories = async (backendUrl: string, query: string): Promise<{ query: string; count: number; memories: MemoryInfo[] }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/memories/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error('Failed to search memories');
    return res.json();
};

export const deleteSessionMemories = async (backendUrl: string): Promise<{ success: boolean; deleted: number }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/memories/session`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete session memories');
    return res.json();
};

export const extractMemories = async (backendUrl: string, sessionId?: string): Promise<{ success: boolean; messageCount: number }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/memories/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionId ? { sessionId } : {})
    });
    if (!res.ok) throw new Error('Failed to extract memories');
    return res.json();
};

// --- Context Budget Endpoint ---

export const fetchContextBudget = async (backendUrl: string): Promise<{ config: Record<string, unknown>; allocation: Record<string, unknown> }> => {
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/v1/context-budget`);
    if (!res.ok) throw new Error('Failed to fetch context budget');
    return res.json();
};
