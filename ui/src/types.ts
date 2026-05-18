

// ComfyUI Workflow Data Structures

export interface ComfyNodeInput {
    name: string;
    type: string;
    link?: number | null;
}

export interface ComfyNodeOutput {
    name: string;
    type: string;
    links?: number[];
    slot_index?: number;
}

export interface ComfyNode {
    id: number;
    type: string;
    pos: [number, number];
    size: { 0: number; 1: number } | number[];
    flags: Record<string, any>;
    order: number;
    mode: number;
    inputs?: ComfyNodeInput[];
    outputs?: ComfyNodeOutput[];
    properties?: Record<string, any>;
    widgets_values?: any[];
    color?: string;
    bgcolor?: string;
}

// Changed from interface to tuple type for array destructuring support
export type ComfyLink = [number, number, number, number, number, string];

export interface ComfyWorkflow {
    id?: string;
    last_node_id: number;
    last_link_id: number;
    nodes: ComfyNode[];
    links: ComfyLink[];
    groups: any[];
    config: any;
    extra: any;
    version: number;
}

export interface WorkflowCheckpoint {
    id: string;
    timestamp: number;
    name: string;
    data: ComfyWorkflow;
}

// App Logic Types

export enum Sender {
    USER = 'user',
    AI = 'ai',
    SYSTEM = 'system'
}

export interface ChatMessage {
    id: string;
    sender: Sender;
    text: string;
    timestamp: Date;
    metadata?: {
        thinking?: boolean;
        workflowUpdate?: boolean;
        missingNodes?: string[];
        groundingSources?: Array<{ uri: string; title: string }>;
        provider?: string;
        relatedQuestions?: string[];
    };
}

export interface AgentStatus {
    node: string;
    displayText: string;
    status: 'processing' | 'done' | 'error';
    details?: any;
}

export interface GeminiResponseSchema {
    chatResponse: string;
    updatedWorkflow?: ComfyWorkflow | null;
    missingNodes?: string[];
    groundingSources?: Array<{ uri: string; title: string }>;
    issues?: WorkflowIssue[];
    relatedQuestions?: string[];
}

// Settings & Diagnostics

export type AIProvider = 'google' | 'custom';
export type Language = 'en' | 'zh' | 'ja' | 'ko';

export interface CustomConfig {
    endpoint?: string;
    headers?: string; // JSON string
    body?: string; // JSON string
}

export interface AppSettings {
    provider: AIProvider;
    apiKey: string; // For Google or Custom (if needed)
    modelName: string; // e.g., "gemini-2.5-flash" or "llama3"
    baseUrl?: string; // For custom/local (e.g., "http://localhost:11434/v1")
    language: Language;
    customConfig?: CustomConfig;
    activeBackendConfigId?: string;
    // Python Backend Settings
    usePythonBackend: boolean;
    pythonBackendUrl: string;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface WorkflowIssue {
    id: string;
    nodeId: number | null;
    severity: IssueSeverity;
    message: string;
    fixSuggestion?: string;
    nodeType?: string;
    exceptionType?: string;
    traceback?: string;
    currentInputs?: Record<string, unknown>;
    isRuntimeError?: boolean;
}

export type VisualizerTab = 'preview' | 'analysis' | 'json';

export type ProviderType = 'anthropic' | 'openai' | 'deepseek' | 'zhipu' | 'moonshot' | 'qwen' | 'google' | 'custom';

export interface ProviderExtension {
    providerModule?: string;
    requestTransformer?: string;
    responseTransformer?: string;
    streamChunkTransformer?: string;
}

// Backend Configuration Types

export interface BackendConfig {
    id: string;
    provider: ProviderType;
    name: string;
    default_model?: string;
    base_url?: string;
    is_default: boolean;
    created_at: string;
    default_max_tokens?: number;
    default_temperature?: number;
    retries?: number;
    retry_delay?: number;
    headers?: Record<string, string>;
    extension?: ProviderExtension;
    custom_config?: CustomConfig;
}

export interface BackendConfigCreate {
    provider: ProviderType;
    name: string;
    api_key?: string;
    default_model?: string;
    base_url?: string;
    is_default?: boolean;
    default_max_tokens?: number;
    default_temperature?: number;
    retries?: number;
    retry_delay?: number;
    headers?: Record<string, string>;
    extension?: ProviderExtension;
    custom_config?: CustomConfig;
}

export interface GitHubTokenStatus {
    has_token: boolean;
    message?: string;
}

export interface ApprovalRequest {
    id: string;
    type: 'approval_required';
    toolName: string;
    toolInput: Record<string, unknown>;
    message: string;
    suggestions?: string[];
    sessionId: string;
    isDestructive: boolean;
    isReadOnly: boolean;
}

export interface HumanInputRequest {
    id: string;
    type: 'human_input_required';
    message: string;
    context?: string;
    options?: HumanInputOption[];
    sessionId: string;
    allowFreeText: boolean;
    placeholder?: string;
}

export interface HumanInputOption {
    label: string;
    value: string;
    description?: string;
    isDefault?: boolean;
}

export interface ToolCallInfo {
    toolName: string;
    toolUseId?: string;
    status: 'running' | 'completed' | 'error';
}