
import { BackendConfig, BackendConfigCreate, GitHubTokenStatus } from '../types';

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
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/configs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
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
    const res = await fetch(`${getBaseUrl(backendUrl)}/api/user-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
