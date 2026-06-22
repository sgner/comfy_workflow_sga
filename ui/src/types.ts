

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
        interrupted?: boolean;
        workflowUpdate?: boolean;
        missingNodes?: string[];
        groundingSources?: Array<{ uri: string; title: string }>;
        provider?: string;
        relatedQuestions?: string[];
        agentIssues?: WorkflowIssue[];
    };
}

export interface AgentStatus {
    node: string;
    displayText: string;
    status: 'processing' | 'done' | 'error';
    details?: any;
}

export interface AgentActivity {
    id: string;
    type: 'thinking' | 'status' | 'tool_start' | 'tool_result' | 'content' | 'error' | 'done' | 'turn_end';
    timestamp: number;
    label: string;
    node?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: string;
    status?: 'processing' | 'done' | 'error';
    duration?: number;
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
    headers?: string;
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
    /** Active agent backend: 'sga' (default) or 'codex' */
    activeAgent?: 'sga' | 'codex';
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueSource = 'native' | 'agent';

export interface WorkflowIssue {
    id: string;
    nodeId: number | null;
    nodeIds?: number[];
    severity: IssueSeverity;
    category?: string;
    message: string;
    impact?: string;
    fixSuggestion?: string;
    nodeType?: string;
    exceptionType?: string;
    traceback?: string;
    currentInputs?: Record<string, unknown>;
    isRuntimeError?: boolean;
    source?: IssueSource;
    modelName?: string;
    modelFolder?: string;
}

export type VisualizerTab = 'preview' | 'analysis' | 'json' | 'context' | 'mcp' | 'skills';

export type ProviderType = 'anthropic' | 'openai' | 'deepseek' | 'zhipu' | 'moonshot' | 'qwen' | 'google' | 'custom';

export interface ProviderExtension {
    providerModule?: string;
    requestTransformer?: string;
    responseTransformer?: string;
    streamChunkTransformer?: string;
}

export interface ModelConfig {
    id: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputPricePerMToken?: number;
    outputPricePerMToken?: number;
    /** Price unit: 'M' = per million tokens (default), 'K' = per thousand tokens */
    priceUnit?: 'M' | 'K';
    supportsVision?: boolean;
    supportsToolUse?: boolean;
    supportsStreaming?: boolean;
    supportsThinking?: boolean;
    supportsReasoningEffort?: boolean;
    defaultMaxTokens?: number;
    defaultTemperature?: number;
    maxTemperature?: number;
    thinkingBudget?: number;
    baseUrl?: string;
    streamingBaseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    extra?: Record<string, unknown>;
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
  model_configs?: Record<string, ModelConfig>;
  has_api_key?: boolean;
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
    model_configs?: Record<string, ModelConfig>;
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
    toolInput?: Record<string, unknown>;
    toolOutput?: string;
    startTime?: number;
    endTime?: number;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
}

export interface MCPServerInfo {
    name: string;
    status: string;
    transport: string;
    command?: string;
    url?: string;
    toolCount: number;
    error?: string;
    connectedAt?: string;
}

export interface SkillInfo {
    name: string;
    description: string;
    whenToUse?: string;
    userInvocable?: boolean;
    source?: string;
    argumentHint?: string;
}

export interface FeatureGateInfo {
    name: string;
    description: string;
    enabled: boolean;
    source: string;
}

export interface TelemetryStatus {
    enabled: boolean;
    sessionId: string;
}

export interface CircuitBreakerStats {
    state: string;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    totalFailures: number;
    totalSuccesses: number;
    timeUntilCooldown: number;
}

export interface CostTrackerInfo {
    sessionId: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    isOverBudget: boolean;
    isNearBudget: boolean;
    remainingBudget: number | undefined;
}

export interface MemoryInfo {
    path: string;
    type: string;
    scope: string;
    description: string;
    mtimeMs: number;
    sizeBytes: number;
}

// Workflow Context Data (from ComfyUI frontend, mirroring RightSidePanel data sources)

export interface ExecutionErrorInfo {
    nodeId: string | null;
    nodeType: string | null;
    exceptionType: string | null;
    exceptionMessage: string | null;
    traceback: string[] | null;
}

export interface NodeValidationErrorInfo {
    nodeId: string;
    classType: string;
    errors: Array<{
        type: string;
        message: string;
        inputName?: string;
    }>;
}

export interface PromptErrorInfo {
    type: string;
    message: string;
    details?: string;
}

export interface MissingNodeTypeInfo {
    type: string;
    nodeId: number | null;
    isReplaceable: boolean;
    replacement?: { new_node_id: string };
}

export interface MissingModelInfo {
    nodeName: string;
    widgetName: string;
    directory: string;
    modelPaths: string[];
    nodeType?: string;
    isAssetSupported?: boolean;
    isMissing?: boolean;
}

export interface MissingMediaInfo {
    name: string;
    mediaType: 'image' | 'video' | 'audio';
    nodeId: string;
    nodeType: string;
    widgetName: string;
    isMissing?: boolean;
}

export interface ErrorContextData {
    executionErrors: ExecutionErrorInfo[];
    nodeValidationErrors: NodeValidationErrorInfo[];
    promptError: PromptErrorInfo | null;
    missingNodeTypes: MissingNodeTypeInfo[];
    missingModels: MissingModelInfo[];
    missingMedia: MissingMediaInfo[];
}

export interface NodeWidgetInfo {
    name: string;
    type: string;
    value: unknown;
    label?: string;
    options?: unknown;
    advanced?: boolean;
}

export interface NodeParameterData {
    nodeId: number;
    nodeType: string;
    nodeTitle: string;
    widgets: NodeWidgetInfo[];
    inputLinks: Array<{
        inputName: string;
        inputType: string;
        sourceNodeId: number;
        sourceNodeType: string;
        sourceOutputName: string;
    }>;
    outputLinks: Array<{
        outputName: string;
        outputType: string;
        targetNodeId: number;
        targetNodeType: string;
        targetInputName: string;
    }>;
}

export interface NodeListData {
    nodeId: number;
    nodeType: string;
    nodeTitle: string;
    mode: number;
    widgetCount: number;
    inputCount: number;
    outputCount: number;
}

export interface GlobalSettingInfo {
    key: string;
    value: unknown;
    type: 'boolean' | 'number' | 'string';
    category: string;
}

export interface SettingsContextData {
    settings: GlobalSettingInfo[];
    showAdvancedWidgets: boolean;
    snapToGrid: boolean;
    gridSize: number;
    linkRenderMode: number;
    linkMarkers: string;
}

export interface ExecutionStatusInfo {
    isIdle: boolean;
    activeJobId: string | null;
    executingNodeIds: string[];
    executionProgress: number;
    totalNodesToExecute: number;
    nodesExecuted: number;
}

export interface SystemInfo {
    os?: string;
    pythonVersion?: string;
    pytorchVersion?: string;
    devices?: Array<{
        name: string;
        type: string;
        vram?: number;
    }>;
}

export interface NodeDefInfo {
    name: string;
    category: string;
    description?: string;
    inputs?: Array<{
        name: string;
        type: string;
        required?: boolean;
    }>;
    outputs?: Array<{
        name: string;
        type: string;
    }>;
    deprecated?: boolean;
    experimental?: boolean;
}

export interface WorkflowContextData {
    errors: ErrorContextData;
    parameters: NodeParameterData[];
    nodes: NodeListData[];
    settings: SettingsContextData;
    selectedNodeIds: number[];
    executionStatus: ExecutionStatusInfo;
    systemInfo: SystemInfo;
    nodeDefs: NodeDefInfo[];
}