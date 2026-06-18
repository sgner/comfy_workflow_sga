

import { GoogleGenAI } from "@google/genai";
import { ComfyWorkflow, GeminiResponseSchema, AppSettings, WorkflowIssue, AgentStatus, AgentActivity, ChatMessage, Sender, ApprovalRequest, HumanInputRequest, ToolCallInfo, TokenUsage } from '../types';
import { t } from '../utils/i18n';
import { collectWorkflowContext, collectWorkflowContextAsync, formatWorkflowContextForPrompt } from './workflowContextCollector';

const BASE_SYSTEM_INSTRUCTION = `
You are "Comfy Workflow Agent", an expert AI assistant and Workflow Architect specialized in ComfyUI.

## CORE MISSION
1. **SOLVE ERRORS**: Identify, explain, and fix execution errors, missing connections, and incompatible types.
2. **EXPLAIN LOGIC**: Deconstruct complex workflows into clear, step-by-step explanations of how data flows (e.g., Load Image -> VAE Encode -> KSampler -> Decode).

## CAPABILITIES
1. **Analyze Workflows**: Understand the structure, data flow, and logic of the provided JSON.
2. **Modify Workflows**: Generate a VALID, COMPLETE JSON representation of the workflow when requested.
3. **Active Inquiry**: If a user's request is ambiguous, ASK for clarification.

## RESPONSE FORMAT
1. **For Explanations**: Use natural language with bold key terms. Break down the flow logically (e.g., "Step 1: Input", "Step 2: Processing").
2. **For Workflow Updates**:
   - Output the **FULL JSON** in a Markdown code block labeled \`json\`.
   - Example: \`\`\`json { ... } \`\`\`
   - **CRITICAL**: Ensure valid JSON. NO trailing commas. NO comments inside the JSON block.
3. **For Diagnostics / Issues**:
   - If you find specific problems, output them in a JSON array block labeled \`ISSUES_JSON\`.
   - Format: \`ISSUES_JSON: [{"nodeId": 10, "severity": "error", "message": "...", "fixSuggestion": "..."}]\`
4. **For Missing Nodes**:
   - Use a section: "SUGGESTED_ACTIONS: [Action1, Action2]".

## RULES
- **Always** validate connections.
- **Never** break JSON structure.
- When explaining, focus on **data flow** and **functionality**, not just node names.
- **Node Reference Format**: When referring to a node, ALWAYS use the full format "Node #<id> <NodeType>" (e.g., "Node #56 LoraLoaderModelOnly"), NEVER use just "Node 56", "Node 12", or "Node #56" alone. The node type name in parentheses from the context (e.g., Node #56 (LoraLoaderModelOnly)) should be included without parentheses as part of the reference.

## FINAL OUTPUT
At the end of your response, please provide 3 short "Related Questions" that the user might want to ask you next to help them deeper understand the workflow or resolve issues. These should be questions the USER would ask the agent, NOT questions the agent asks the user. Do NOT phrase them as offers or suggestions from the agent (e.g. avoid "Do you want me to..."); instead phrase them as what the user might want to know or request.
Format them as a JSON array labeled \`RELATED_QUESTIONS\`.
Example: \`RELATED_QUESTIONS: ["How do I fix the missing model error?", "What does the KSampler node do?"]\`
`;

// --- Helper: Resolves Template Variables ---
function resolveTemplate(
    templateStr: string,
    vars: { [key: string]: any }
): string {
    let result = templateStr;
    
    Object.keys(vars).forEach(key => {
        const val = vars[key];
        const placeholder = `$${key}`;
        
        if (typeof val === 'object') {
            const jsonVal = JSON.stringify(val);
            result = result.replace(newRP(`"${placeholder}"`), jsonVal);
            result = result.replace(newRP(`'${placeholder}'`), jsonVal);
            result = result.replace(newRP(placeholder), jsonVal);
        } else {
            result = result.replace(newRP(placeholder), String(val));
        }
    });
    
    return result;
}

function newRP(str: string) {
    return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

// --- Helper for Custom OpenAI-Compatible Calls (Streaming) ---
async function callCustomLLM(
    settings: AppSettings, 
    prompt: string, 
    systemInstruction: string,
    onStream?: (chunk: string) => void
): Promise<string> {
    if (!settings.baseUrl) throw new Error("Base URL required for custom provider");

    const defaultConfig = {
        endpoint: "/chat/completions",
        headers: JSON.stringify({
            "Content-Type": "application/json",
            "Authorization": "Bearer $apiKey"
        })
    };

    const custom = settings.customConfig || {};
    const endpointTpl = custom.endpoint || defaultConfig.endpoint;
    const headersTpl = custom.headers || defaultConfig.headers;

    let url = "";
    if (endpointTpl.startsWith("http")) {
        url = endpointTpl;
    } else {
        const base = settings.baseUrl.replace(/\/$/, '');
        const path = endpointTpl.startsWith('/') ? endpointTpl : `/${endpointTpl}`;
        url = `${base}${path}`;
    }

    const variables = {
        model: settings.modelName,
        apiKey: settings.apiKey || "",
        prompt: systemInstruction + "\n\n" + prompt,
        system: systemInstruction,
        user_prompt: prompt,
        messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
        ]
    };

    let headers: Record<string, string> = {};
    try {
        const headersStr = resolveTemplate(headersTpl, variables);
        headers = JSON.parse(headersStr);
    } catch (e) {
        console.error("Failed to parse headers template", e);
        throw new Error("Invalid Headers Configuration");
    }

    const bodyObj: Record<string, unknown> = {
        model: settings.modelName,
        messages: variables.messages,
        stream: true
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyObj)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Custom API Error: ${url} returned ${response.status} - ${errorText}`);
    }

    if (!response.body) {
        const data = await response.json();
        let text = "";
        if (data.choices && data.choices[0]) {
            if (data.choices[0].message) {
                text = data.choices[0].message.content;
            } else if (data.choices[0].text) {
                text = data.choices[0].text;
            }
        } else if (data.content) {
            text = data.content;
        } else if (data.response) {
            text = data.response;
        }
        if (!text) text = JSON.stringify(data);
        if (onStream) onStream(text);
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;

            try {
                const data = JSON.parse(jsonStr);
                let chunk = "";

                if (data.choices && data.choices[0]) {
                    const choice = data.choices[0];
                    if (choice.delta && choice.delta.content) {
                        chunk = choice.delta.content;
                    } else if (choice.text) {
                        chunk = choice.text;
                    }
                } else if (data.content) {
                    chunk = typeof data.content === 'string' ? data.content : '';
                } else if (data.response) {
                    chunk = typeof data.response === 'string' ? data.response : '';
                }

                if (chunk) {
                    fullText += chunk;
                    if (onStream) onStream(chunk);
                }
            } catch {
                // skip unparseable chunks
            }
        }
    }

    if (!fullText) {
        fullText = "[No content received from streaming response]";
    }

    return fullText;
}

// --- Helper for Google Gemini Calls (Streaming) ---
async function callGoogleGemini(
    settings: AppSettings, 
    prompt: string, 
    systemInstruction: string,
    onStream?: (chunk: string) => void
): Promise<{text: string, sources: Array<{uri:string, title:string}>}> {
    // Correctly use the API key from settings or env
    const apiKey = settings.apiKey || process.env.API_KEY;
    if (!apiKey) {
        throw new Error("API Key is missing. Please set it in settings.");
    }
    
    const ai = new GoogleGenAI({ apiKey });
    
    const streamResult = await ai.models.generateContentStream({
        model: settings.modelName || 'gemini-2.5-flash',
        contents: prompt,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ googleSearch: {} }], 
            temperature: 0.5, 
        }
    });

    let fullText = "";
    const allSources: Array<{ uri: string; title: string }> = [];

    for await (const chunk of streamResult) {
        const chunkText = chunk.text;
        if (chunkText) {
            fullText += chunkText;
            if (onStream) {
                onStream(chunkText);
            }
        }

        const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (groundingChunks) {
            groundingChunks.forEach(gc => {
                if (gc.web?.uri && gc.web?.title) {
                    allSources.push({ uri: gc.web.uri, title: gc.web.title });
                }
            });
        }
    }

    const uniqueSources = Array.from(new Map(allSources.map(item => [item.uri, item])).values());

    return { text: fullText, sources: uniqueSources };
}

// --- Helper for Python Backend Calls (SSE Streaming) ---
async function callPythonBackendStream(
    settings: AppSettings,
    prompt: string,
    workflow: ComfyWorkflow,
    workflowId: string,
    errorLog: string | null,
    abortSignal?: AbortSignal,
    onStream?: (chunk: string) => void,
    onStatus?: (status: AgentStatus) => void,
    onApprovalRequired?: (request: ApprovalRequest) => void,
    onHumanInputRequired?: (request: HumanInputRequest) => void,
    onToolUseStart?: (info: ToolCallInfo) => void,
    onToolUseResult?: (info: ToolCallInfo) => void,
    onActivity?: (activity: AgentActivity) => void,
    onUsage?: (usage: TokenUsage) => void,
    onWorkflowUpdate?: (workflowJson: string, actionType: string) => void
): Promise<{
    text: string;
    sources: Array<{uri:string, title:string}>;
    structuredResult?: {
        chatResponse: string;
        updatedWorkflow: Record<string, unknown> | null;
        issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>;
        relatedQuestions: string[];
        missingNodes: string[];
        groundingSources: Array<{ uri: string; title: string }>;
    };
}> {
    
    if (!settings.pythonBackendUrl) throw new Error("Python Backend URL is missing.");

    const baseUrl = settings.pythonBackendUrl.replace(/\/$/, '');
    const configId = settings.activeBackendConfigId || undefined;

    const effectiveSessionId = workflowId;

    const workflowContext = await collectWorkflowContextAsync().catch(() => collectWorkflowContext());
    const workflowContextText = formatWorkflowContextForPrompt(workflowContext);

    const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        signal: abortSignal,
        body: JSON.stringify({
            message: prompt,
            workflow,
            session_id: effectiveSessionId,
            error_log: errorLog || undefined,
            language: settings.language || 'en',
            config_id: configId || undefined,
            workflow_context_text: workflowContextText || undefined,
        })
    });

    if (!response.ok) {
        throw new Error(`Backend Error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) throw new Error("No response body from backend");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    let currentEvent = "";
    let structuredResult: {
        chatResponse: string;
        updatedWorkflow: Record<string, unknown> | null;
        issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>;
        relatedQuestions: string[];
        missingNodes: string[];
        groundingSources: Array<{ uri: string; title: string }>;
    } | undefined = undefined;

    const TOOL_DISPLAY_NAMES: Record<string, string> = {
        WebSearch: '搜索网络',
        WebFetch: '获取网页内容',
        github_search: '搜索 GitHub 和知识库',
        workflow_analyzer: '分析工作流结构',
        workflow_action: '执行工作流操作',
        ask_user: '等待用户输入',
        Bash: '执行命令',
        FileRead: '读取文件',
        FileEdit: '编辑文件',
        FileWrite: '写入文件',
        Grep: '搜索文件内容',
        Glob: '搜索文件名',
        TodoWrite: '更新任务列表',
        AskUserQuestion: '询问用户',
        HuggingFaceDownload: '下载模型',
        ComfyUINodeSearch: '搜索节点',
        ComfyUIAPI: '查询 ComfyUI API',
        ComfyUIModelList: '查询模型列表',
        Plan: '制定计划',
    }

    function getToolDisplayName(name: string | undefined): string {
        if (!name) return '调用工具'
        return TOOL_DISPLAY_NAMES[name] || `调用工具: ${name}`
    }

    function formatToolInputBrief(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
        if (!input) return ''
        if (toolName === 'WebSearch' && input.query) return String(input.query)
        if (toolName === 'WebFetch' && input.url) return String(input.url)
        if (toolName === 'Bash' && input.command) return String(input.command).slice(0, 60)
        if (toolName === 'FileRead' && input.path) return String(input.path)
        if (toolName === 'FileEdit' && input.path) return String(input.path)
        if (toolName === 'FileWrite' && input.path) return String(input.path)
        if (toolName === 'Grep' && input.pattern) return String(input.pattern)
        if (toolName === 'Glob' && input.pattern) return String(input.pattern)
        if (toolName === 'HuggingFaceDownload' && input.model_id) return String(input.model_id)
        const values = Object.values(input).filter(v => typeof v === 'string' && v.length > 0)
        if (values.length > 0) return String(values[0]).slice(0, 60)
        return ''
    }

    function formatToolResultBrief(toolName: string | undefined, result: { content?: string; isError?: boolean } | undefined): string {
        if (!result || !result.content) return ''
        if (result.isError) return `错误: ${result.content.slice(0, 80)}`
        const content = result.content
        // 尝试解析 JSON 结果提取关键信息
        try {
            const parsed = JSON.parse(content)
            if (toolName === 'ComfyUINodeSearch' && Array.isArray(parsed)) {
                const names = parsed.slice(0, 3).map((n: any) => n.name || n.category || String(n)).join(', ')
                return parsed.length > 3 ? `${names} 等${parsed.length}个结果` : names
            }
            if (toolName === 'ComfyUIAPI' && parsed.nodes) {
                return `${Array.isArray(parsed.nodes) ? parsed.nodes.length : '?'} 个节点`
            }
            if (toolName === 'ComfyUIModelList' && parsed.models) {
                return `${Array.isArray(parsed.models) ? parsed.models.length : '?'} 个模型`
            }
            if (toolName === 'workflow_action' && parsed.nodes) {
                return `工作流已更新 (${Array.isArray(parsed.nodes) ? parsed.nodes.length : '?'} 个节点)`
            }
            if (typeof parsed === 'string') return parsed.slice(0, 80)
            if (Array.isArray(parsed)) return `${parsed.length} 个结果`
            if (typeof parsed === 'object') return Object.keys(parsed).slice(0, 3).join(', ')
        } catch {
            // 非 JSON 结果
        }
        return content.slice(0, 80)
    }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
            } else if (line.trim().startsWith('data: ')) {
                const jsonStr = line.replace('data: ', '').trim();
                if (jsonStr === '[DONE]') { currentEvent = ""; continue; }
                
                try {
                    const data = JSON.parse(jsonStr);
                    const eventType = currentEvent || (data.type as string) || '';
                    
                    switch (eventType) {
                        case 'session_start':
                            if (onActivity) {
                                onActivity({
                                    id: `act-start-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: 'Agent 启动，准备处理...',
                                    status: 'processing',
                                });
                            }
                            if (onStatus) {
                                onStatus({
                                    node: 'agent_start',
                                    displayText: 'Agent 启动中...',
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'thinking_delta':
                            if (onActivity) {
                                onActivity({
                                    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                    type: 'thinking',
                                    timestamp: Date.now(),
                                    label: data.text ? (data.text.length > 80 ? data.text.slice(0, 80) + '...' : data.text) : '思考中...',
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'status_update':
                            if (onStatus) {
                                onStatus({
                                    node: data.metadata?.node,
                                    displayText: data.metadata?.display_text || 'Processing...',
                                    status: data.metadata?.status || 'processing'
                                });
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: data.metadata?.display_text || 'Processing...',
                                    node: data.metadata?.node,
                                    status: data.metadata?.status || 'processing',
                                });
                            }
                            break;
                        case 'stream_delta':
                            const streamText = data.text || '';
                            fullText += streamText;
                            if (onStream) onStream(streamText);
                            break;
                        case 'tool_use_start':
                            if (onToolUseStart) {
                                onToolUseStart({
                                    toolName: data.toolName,
                                    toolUseId: data.toolUseId,
                                    status: 'running',
                                    startTime: Date.now(),
                                });
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-tool-${data.toolUseId || Date.now()}`,
                                    type: 'tool_start',
                                    timestamp: Date.now(),
                                    label: getToolDisplayName(data.toolName),
                                    toolName: data.toolName,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'tool_use_input_complete':
                            if (onToolUseStart) {
                                onToolUseStart({
                                    toolName: data.data?.toolName,
                                    toolUseId: data.data?.toolUseId,
                                    status: 'running',
                                    toolInput: data.data?.toolInput,
                                    startTime: Date.now(),
                                });
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-tool-input-${data.data?.toolUseId || Date.now()}`,
                                    type: 'tool_start',
                                    timestamp: Date.now(),
                                    label: `${getToolDisplayName(data.data?.toolName)}: ${formatToolInputBrief(data.data?.toolName, data.data?.toolInput)}`,
                                    toolName: data.data?.toolName,
                                    toolInput: data.data?.toolInput,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'tool_use_result':
                            if (onToolUseResult) {
                                onToolUseResult({
                                    toolName: data.toolName,
                                    toolUseId: data.result?.toolUseId,
                                    status: data.result?.isError ? 'error' : 'completed',
                                    endTime: Date.now(),
                                    toolOutput: data.result?.content?.slice(0, 200),
                                });
                            }
                            if (onActivity) {
                                const resultBrief = formatToolResultBrief(data.toolName, data.result);
                                onActivity({
                                    id: `act-tool-result-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                    type: 'tool_result',
                                    timestamp: Date.now(),
                                    label: resultBrief
                                        ? `${getToolDisplayName(data.toolName)}: ${resultBrief}`
                                        : `${getToolDisplayName(data.toolName)} 完成`,
                                    toolName: data.toolName,
                                    toolOutput: data.result?.content?.slice(0, 200),
                                    status: data.result?.isError ? 'error' : 'done',
                                });
                            }
                            break;
                        case 'approval_required':
                            if (onApprovalRequired) {
                                onApprovalRequired({
                                    id: data.actionId,
                                    type: 'approval_required',
                                    toolName: data.toolName,
                                    toolInput: data.toolInput,
                                    message: data.message,
                                    suggestions: data.suggestions,
                                    sessionId: effectiveSessionId,
                                    isDestructive: true,
                                    isReadOnly: false,
                                } as ApprovalRequest);
                            }
                            break;
                        case 'human_input_required':
                            if (onHumanInputRequired) {
                                onHumanInputRequired({
                                    id: data.actionId,
                                    type: 'human_input_required',
                                    message: data.message,
                                    context: data.context,
                                    options: data.options,
                                    sessionId: effectiveSessionId,
                                    allowFreeText: true,
                                } as HumanInputRequest);
                            }
                            break;
                        case 'turn_end':
                            if (onUsage && data.usage) {
                                onUsage(data.usage as TokenUsage);
                            }
                            // 不再显示"第N轮结束"，轮次结束由后续的工具/流式事件自然体现
                            break;
                        case 'result':
                            if (data.data) {
                                structuredResult = data.data as typeof structuredResult;
                            }
                            break;
                        case 'done':
                            if (data.data?.usage && onUsage) {
                                onUsage(data.data.usage as TokenUsage);
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-done-${Date.now()}`,
                                    type: 'done',
                                    timestamp: Date.now(),
                                    label: '完成',
                                    status: 'done',
                                });
                            }
                            break;
                        case 'error':
                            if (onActivity) {
                                onActivity({
                                    id: `act-err-${Date.now()}`,
                                    type: 'error',
                                    timestamp: Date.now(),
                                    label: data.data || '发生错误',
                                    status: 'error',
                                });
                            }
                            if (!fullText && onStream) {
                                const errText = data.data || '发生错误';
                                fullText += errText;
                                onStream(errText);
                            }
                            break;
                        case 'turn_start':
                            if (onActivity) {
                                onActivity({
                                    id: `act-turn-${Date.now()}`,
                                    type: 'thinking',
                                    timestamp: Date.now(),
                                    label: `思考中...`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'api_call_start':
                            if (onActivity) {
                                onActivity({
                                    id: `act-api-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: '调用 LLM API...',
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'tool_progress':
                            if (onActivity) {
                                onActivity({
                                    id: `act-prog-${data.toolUseId || Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `${getToolDisplayName(data.toolName)}: ${data.data?.text || '处理中...'}`,
                                    toolName: data.toolName,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'tool_use_end':
                            if (onToolUseResult) {
                                onToolUseResult({
                                    toolName: data.toolName,
                                    toolUseId: data.toolUseId,
                                    status: data.isError ? 'error' : 'completed',
                                    endTime: Date.now(),
                                });
                            }
                            break;
                        case 'compact_start':
                            if (onActivity) {
                                onActivity({
                                    id: `act-compact-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `压缩上下文: ${data.reason || ''}`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'compact_end':
                            if (onActivity) {
                                onActivity({
                                    id: `act-compact-end-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `上下文压缩完成，移除 ${data.messagesRemoved ?? 0} 条消息`,
                                    status: 'done',
                                });
                            }
                            break;
                        case 'task_started':
                            if (onActivity) {
                                onActivity({
                                    id: `act-task-${data.taskId || Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `任务开始: ${data.description || ''}`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'task_progress':
                            if (onActivity) {
                                onActivity({
                                    id: `act-task-prog-${data.taskId || Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: data.summary || data.description || '任务进行中...',
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'task_notification':
                            if (onActivity) {
                                onActivity({
                                    id: `act-task-notif-${data.taskId || Date.now()}`,
                                    type: data.status === 'failed' ? 'error' : 'status',
                                    timestamp: Date.now(),
                                    label: `任务${data.status === 'completed' ? '完成' : data.status === 'failed' ? '失败' : '停止'}: ${data.summary || ''}`,
                                    status: data.status === 'completed' ? 'done' : data.status === 'failed' ? 'error' : 'done',
                                });
                            }
                            break;
                        case 'recovery':
                            if (onActivity) {
                                onActivity({
                                    id: `act-recovery-${Date.now()}`,
                                    type: 'error',
                                    timestamp: Date.now(),
                                    label: `恢复中 (第 ${data.attempt ?? 0} 次尝试): ${data.error?.message || '未知错误'}`,
                                    status: 'error',
                                });
                            }
                            break;
                        case 'workflow_updated':
                            if (onWorkflowUpdate && data.workflowJson) {
                                onWorkflowUpdate(data.workflowJson, data.actionType || 'unknown');
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-wf-update-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `工作流已更新: ${data.actionType || 'unknown'}`,
                                    status: 'done',
                                });
                            }
                            break;
                        case 'stop':
                            if (onActivity) {
                                onActivity({
                                    id: `act-stop-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `Agent 停止: ${data.reason || '未知原因'}`,
                                    status: 'done',
                                });
                            }
                            break;
                        case 'coordinator_start':
                            if (onActivity) {
                                onActivity({
                                    id: `act-coord-start-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `多Agent编排启动 (${data.phaseCount || 0} 阶段, 策略: ${data.strategy || 'sequential'})`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'coordinator_phase_change':
                            if (onActivity) {
                                const phaseLabels: Record<string, string> = {
                                    research: '研究',
                                    synthesis: '规划',
                                    implementation: '实现',
                                    verification: '验证',
                                };
                                onActivity({
                                    id: `act-coord-phase-${data.taskId || Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `[${phaseLabels[data.phase] || data.phase}] ${data.description || ''}`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'coordinator_task_complete':
                            if (onActivity) {
                                onActivity({
                                    id: `act-coord-done-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `阶段完成: ${data.description || ''}`,
                                    status: 'done',
                                });
                            }
                            break;
                        case 'coordinator_task_failed':
                            if (onActivity) {
                                onActivity({
                                    id: `act-coord-fail-${Date.now()}`,
                                    type: 'error',
                                    timestamp: Date.now(),
                                    label: `阶段失败: ${data.description || ''} - ${data.error || '未知错误'}`,
                                    status: 'error',
                                });
                            }
                            break;
                        case 'coordinator_complete':
                            if (data.synthesis) {
                                fullText += data.synthesis;
                                if (onStream) onStream(data.synthesis);
                            }
                            if (onActivity) {
                                onActivity({
                                    id: `act-coord-complete-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `多Agent编排完成 (${data.totalDurationMs ? Math.round(data.totalDurationMs / 1000) + 's' : ''})`,
                                    status: 'done',
                                });
                            }
                            break;
                        case 'verification_result':
                            if (onActivity) {
                                const verdict = data.verdict || 'UNKNOWN';
                                const verdictLabels: Record<string, string> = {
                                    PASS: '验证通过',
                                    FAIL: '验证失败',
                                    PARTIAL: '部分通过',
                                };
                                const verdictStatus: Record<string, 'done' | 'error' | 'processing'> = {
                                    PASS: 'done',
                                    FAIL: 'error',
                                    PARTIAL: 'processing',
                                };
                                onActivity({
                                    id: `act-verify-${Date.now()}`,
                                    type: verdict === 'FAIL' ? 'error' : 'status',
                                    timestamp: Date.now(),
                                    label: `工作流验证: ${verdictLabels[verdict] || verdict}${data.summary ? ' - ' + data.summary.split('\n')[0] : ''}`,
                                    status: verdictStatus[verdict] || 'processing',
                                });
                            }
                            break;
                        case 'task_created':
                            if (onActivity) {
                                onActivity({
                                    id: `act-task-created-${Date.now()}`,
                                    type: 'status',
                                    timestamp: Date.now(),
                                    label: `任务创建: ${data.name || data.taskId || ''}`,
                                    status: 'processing',
                                });
                            }
                            break;
                        case 'task_status_update':
                            if (onActivity) {
                                const taskStatusLabels: Record<string, string> = {
                                    running: '运行中',
                                    completed: '已完成',
                                    failed: '失败',
                                    killed: '已终止',
                                    pending: '等待中',
                                };
                                const taskStatusMap: Record<string, 'processing' | 'done' | 'error'> = {
                                    running: 'processing',
                                    completed: 'done',
                                    failed: 'error',
                                    killed: 'error',
                                    pending: 'processing',
                                };
                                onActivity({
                                    id: `act-task-status-${data.taskId || Date.now()}`,
                                    type: taskStatusMap[data.status] === 'error' ? 'error' : 'status',
                                    timestamp: Date.now(),
                                    label: `任务${taskStatusLabels[data.status] || data.status}${data.summary ? ': ' + data.summary : ''}${data.usage ? ` (${data.usage.totalTokens} tokens, $${data.usage.totalCostUsd?.toFixed(4)})` : ''}`,
                                    status: taskStatusMap[data.status] || 'processing',
                                });
                            }
                            break;
                        case 'plan_update':
                            if (onActivity) {
                                const planEvent = data;
                                const phaseLabels: Record<string, string> = {
                                    research: '研究',
                                    synthesis: '规划',
                                    implementation: '实现',
                                    verification: '验证',
                                };
                                const statusLabels: Record<string, string> = {
                                    pending: '等待',
                                    running: '执行中',
                                    completed: '完成',
                                    failed: '失败',
                                    skipped: '跳过',
                                };
                                const statusMap: Record<string, 'processing' | 'done' | 'error'> = {
                                    pending: 'processing',
                                    running: 'processing',
                                    completed: 'done',
                                    failed: 'error',
                                    skipped: 'done',
                                };

                                if (planEvent.type === 'plan_created' && planEvent.tasks) {
                                    const taskSummary = planEvent.tasks.map((t: { phase: string; description: string }) => `${phaseLabels[t.phase] || t.phase}: ${t.description}`).join(', ');
                                    onActivity({
                                        id: `act-plan-${planEvent.planId}`,
                                        type: 'status',
                                        timestamp: Date.now(),
                                        label: `计划创建 (${planEvent.tasks.length} 个任务): ${taskSummary}`,
                                        status: 'processing',
                                    });
                                } else if (planEvent.type === 'task_updated') {
                                    const phase = phaseLabels[planEvent.taskPhase || ''] || planEvent.taskPhase || '';
                                    const status = statusLabels[planEvent.taskStatus || ''] || planEvent.taskStatus || '';
                                    const progress = planEvent.progress;
                                    onActivity({
                                        id: `act-plan-task-${planEvent.taskId || Date.now()}`,
                                        type: statusMap[planEvent.taskStatus || ''] === 'error' ? 'error' : 'status',
                                        timestamp: Date.now(),
                                        label: `[${phase}] ${planEvent.taskDescription || ''} - ${status}${progress ? ` (${progress.completed}/${progress.total})` : ''}`,
                                        status: statusMap[planEvent.taskStatus || ''] || 'processing',
                                    });
                                } else if (planEvent.type === 'task_added') {
                                    const phase = phaseLabels[planEvent.taskPhase || ''] || planEvent.taskPhase || '';
                                    onActivity({
                                        id: `act-plan-add-${planEvent.taskId || Date.now()}`,
                                        type: 'status',
                                        timestamp: Date.now(),
                                        label: `新增任务: [${phase}] ${planEvent.taskDescription || ''}`,
                                        status: 'processing',
                                    });
                                }
                            }
                            break;
                    }
                    
                } catch (e) {
                    console.warn("Failed to parse backend SSE chunk", e);
                }
                currentEvent = "";
            } else if (line.trim() === '') {
                currentEvent = "";
            }
        }
    }

    return { text: fullText, sources: [], structuredResult };
}

function cleanHistoryText(text: string, isAssistant: boolean): string {
    if (isAssistant) {
        text = text
            .replace(/=== TASK PLANNING GUIDANCE ===[\s\S]*?(=== END TASK PLANNING ===|\n\n[A-Z])/g, '')
            .replace(/=== TASK PLANNING GUIDANCE ===[\s\S]*$/,'')
            .replace(/\[CURRENT WORKFLOW STATE\][\s\S]*?(?=\n\n[A-Z]|\n\n$|$)/g, '')
            .replace(/\[WORKFLOW CONTEXT\][\s\S]*?(?=\n\n[A-Z]|\n\n$|$)/g, '')
            .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/g, '')
            .replace(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/g, '')
        const issuesJsonInHist = findJsonArrayAfterMarker(text, 'ISSUES_JSON:');
        if (issuesJsonInHist) {
            const markerIdx = text.indexOf('ISSUES_JSON:');
            const endIdx = markerIdx + 'ISSUES_JSON:'.length + text.slice(markerIdx + 'ISSUES_JSON:'.length).indexOf(issuesJsonInHist) + issuesJsonInHist.length;
            text = (text.slice(0, markerIdx) + text.slice(endIdx));
        }
    } else {
        text = text
            .replace(/\[FULL WORKFLOW JSON\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/\[WORKFLOW PANEL CONTEXT[^\]]*\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/\[RUNTIME ERRORS\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/\[CURRENT WORKFLOW STATE\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/\[Current Workflow Context\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/IMPORTANT: You MUST respond in the following language code: "[^"]*"\.[^\n]*\n?/g, '')
            .replace(/\[WORKFLOW CONTEXT\][\s\S]*?(?=\n\[|\n\n[^\[]|$)/g, '')
            .replace(/\[USER REQUEST\]\s*"?/g, '')
    }
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

export const fetchChatHistory = async (
    settings: AppSettings,
    workflowId: string
): Promise<{ messages: ChatMessage[]; isActive: boolean }> => {
    if (!settings.usePythonBackend || !settings.pythonBackendUrl) return { messages: [], isActive: false };

    const sgaSessionId = workflowId;

    try {
        const response = await fetch(`${settings.pythonBackendUrl.replace(/\/$/, '')}/api/v1/sessions/${sgaSessionId}/messages`);
        if (!response.ok) return { messages: [], isActive: false };

        const rawResult = await response.json();
        const isActive = rawResult.isActive === true;
        const rawHistory = Array.isArray(rawResult.messages) ? rawResult.messages : (Array.isArray(rawResult) ? rawResult : []);
        if (!Array.isArray(rawHistory)) return { messages: [], isActive };

        const messages = rawHistory.map((msg: any, idx: number) => {
            const isAi = msg.role === 'assistant';
            let text = '';
            if (Array.isArray(msg.content)) {
                text = msg.content.filter((c: any) => c.type === 'text' && c.text).map((c: any) => c.text).join('\n');
            } else {
                text = msg.text || msg.content || '';
            }
            const agentIssues = isAi ? parseIssuesFromText(text) : undefined;

            text = cleanHistoryText(text, isAi);

            return {
                id: `hist-${idx}-${Date.now()}`,
                sender: isAi ? Sender.AI : Sender.USER,
                text,
                timestamp: new Date(msg.timestamp || Date.now()),
                metadata: isAi ? {
                    provider: 'History',
                    agentIssues: agentIssues && agentIssues.length > 0 ? agentIssues : undefined,
                } : undefined
            };
        });
        return { messages, isActive };
    } catch (e) {
        console.error("Failed to fetch chat history:", e);
        return { messages: [], isActive: false };
    }
};

export const abortBackendAgent = async (
    settings: AppSettings,
    sessionId: string
): Promise<boolean> => {
    if (!settings.usePythonBackend || !settings.pythonBackendUrl) return false;

    try {
        const response = await fetch(
            `${settings.pythonBackendUrl.replace(/\/$/, '')}/api/chat/abort/${sessionId}`,
            { method: 'POST' }
        );
        if (!response.ok) return false;
        const result = await response.json();
        return result.success === true;
    } catch (e) {
        console.error("Failed to abort backend agent:", e);
        return false;
    }
};

export const analyzeWorkflowWithBackend = async (
    settings: AppSettings,
    workflow: ComfyWorkflow,
    workflowId: string
): Promise<WorkflowIssue[]> => {
    if (!settings.pythonBackendUrl) return [];

    const sgaSessionId = workflowId;

    try {
        const response = await fetch(`${settings.pythonBackendUrl.replace(/\/$/, '')}/api/workflow/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflow: workflow,
                session_id: sgaSessionId,
                language: settings.language
            })
        });

        if (!response.ok) return [];
        
        const data = await response.json();
        const rawIssues = data.issues || data; 
        
        if (Array.isArray(rawIssues)) {
             return rawIssues.map((issue: any) => ({
                id: `backend-${Date.now()}-${Math.random()}`,
                nodeId: issue.node_id || issue.nodeId || null,
                severity: (issue.severity || 'warning') as any,
                message: issue.message || issue.issue || issue.details || 'Issue detected',
                fixSuggestion: issue.fix_suggestion || issue.fixSuggestion
            }));
        }
        return [];
    } catch (e) {
        console.error("Backend analysis failed", e);
        return [];
    }
};

function cleanJsonString(jsonStr: string): string {
    let clean = jsonStr.replace(/\/\/.*$/gm, "");
    clean = clean.replace(/\/\*[\s\S]*?\*\//g, "");
    clean = clean.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return clean;
}

function extractBalancedJsonArray(text: string, startIndex: number): string | null {
    if (text[startIndex] !== '[') return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) return text.slice(startIndex, i + 1); }
    }
    return null;
}

function findJsonArrayAfterMarker(text: string, marker: string): string | null {
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) return null;
    const afterMarker = text.slice(markerIdx + marker.length);
    const skipMatch = afterMarker.match(/^\s*(?:```(?:json)?\s*)?/);
    const arrayStart = skipMatch ? skipMatch[0].length : 0;
    if (afterMarker[arrayStart] !== '[') return null;
    return extractBalancedJsonArray(afterMarker, arrayStart);
}

function parseIssuesFromText(text: string): WorkflowIssue[] {
    let issuesJson: string | null = null;

    issuesJson = findJsonArrayAfterMarker(text, 'ISSUES_JSON:');
    if (!issuesJson) {
        const bareJsonMatch = text.match(/```json\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/);
        if (bareJsonMatch?.[1]) {
            try {
                const parsed = JSON.parse(cleanJsonString(bareJsonMatch[1]));
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].severity !== undefined && (parsed[0].issue !== undefined || parsed[0].message !== undefined)) {
                    issuesJson = bareJsonMatch[1];
                }
            } catch { /* not a valid issues array */ }
        }
    }

    if (!issuesJson) return [];

    try {
        const parsedIssues = JSON.parse(cleanJsonString(issuesJson));
        if (!Array.isArray(parsedIssues)) return [];

        return parsedIssues.map((issue: any, idx: number) => {
            const nodeIds = issue.node_ids ?? issue.nodeIds ?? null;
            const primaryNodeId = issue.nodeId ?? issue.node_id ?? (Array.isArray(nodeIds) && nodeIds.length > 0 ? nodeIds[0] : null);

            return {
                id: `ai-issue-${Date.now()}-${idx}`,
                nodeId: typeof primaryNodeId === 'number' ? primaryNodeId : (typeof primaryNodeId === 'string' ? parseInt(primaryNodeId, 10) || null : null),
                nodeIds: Array.isArray(nodeIds) ? nodeIds.map((id: any) => typeof id === 'number' ? id : parseInt(String(id), 10) || null).filter((n: number | null): n is number => n !== null) : undefined,
                severity: issue.severity || 'warning',
                category: issue.category ?? undefined,
                message: issue.message ?? issue.issue ?? issue.details ?? 'Unknown issue',
                impact: issue.impact ?? undefined,
                fixSuggestion: issue.fixSuggestion ?? issue.fix_suggestion ?? issue.recommendation ?? (issue.details && issue.issue ? issue.details : undefined),
                nodeType: issue.nodeType ?? issue.node_type ?? undefined,
                source: 'agent' as const,
            };
        });
    } catch (e) {
        console.error('Failed to parse ISSUES_JSON from text:', e);
        return [];
    }
}

export const sendMessageToComfyAgent = async (
    currentWorkflow: ComfyWorkflow,
    userPrompt: string,
    settings: AppSettings,
    _history: string[] = [],
    workflowId: string = "default",
    errorLog: string | null,
    workflowContextPrompt: string | null = null,
    abortSignal?: AbortSignal,
    onStream?: (chunk: string) => void,
    onStatus?: (status: AgentStatus) => void,
    onApprovalRequired?: (request: ApprovalRequest) => void,
    onHumanInputRequired?: (request: HumanInputRequest) => void,
    onToolUseStart?: (info: ToolCallInfo) => void,
    onToolUseResult?: (info: ToolCallInfo) => void,
    onActivity?: (activity: AgentActivity) => void,
    onUsage?: (usage: TokenUsage) => void,
    onWorkflowUpdate?: (workflowJson: string, actionType: string) => void
): Promise<GeminiResponseSchema> => {
    
    const lang = settings.language;

    try {
        let textResponse = "";
        let sources: Array<{ uri: string; title: string }> = [];

        if (settings.usePythonBackend) {
             const res = await callPythonBackendStream(settings, userPrompt, currentWorkflow, workflowId, errorLog, abortSignal, onStream, onStatus, onApprovalRequired, onHumanInputRequired, onToolUseStart, onToolUseResult, onActivity, onUsage, onWorkflowUpdate);
             textResponse = res.text;
             sources = res.sources;
        } else {
            const languageInstruction = `\nIMPORTANT: You MUST respond in the following language code: "${settings.language}". Translate your advice and interface text accordingly.`;
            const fullSystemInstruction = BASE_SYSTEM_INSTRUCTION + languageInstruction;

            let prompt = `
            [CURRENT WORKFLOW STATE]
            Node Count: ${currentWorkflow?.nodes?.length || 0}
            Nodes Summary: ${JSON.stringify(currentWorkflow?.nodes?.map(n => ({id: n.id, type: n.type, title: n.properties?.['Node name for S&R']})) || [])}
            
            [FULL WORKFLOW JSON]
            ${JSON.stringify(currentWorkflow)}
            `;

            if (workflowContextPrompt) {
                prompt += `\n[WORKFLOW CONTEXT]\n${workflowContextPrompt}\n`;
            }

            if (errorLog) {
                prompt += `\n[RUNTIME ERRORS]\nThe user encountered the following errors during execution:\n${errorLog}\n`;
            }

            prompt += `
            [USER REQUEST]
            "${userPrompt}"

            [INSTRUCTIONS]
            - If the user wants to change the workflow, output the NEW JSON in a \`\`\`json block.
            - If the user asks to DIAGNOSE, ANALYZE, or CHECK the workflow, output the issues in \`ISSUES_JSON: [...] \`.
            - If the user asks to EXPLAIN, provide a detailed summary of the logic and data flow.
            - Suggest 2-3 short follow-up actions if applicable in the format "SUGGESTED_ACTIONS: [Action 1, Action 2]".
            - Provide 3 Related Questions in the format \`RELATED_QUESTIONS: ["Q1", "Q2"]\`. These must be questions the USER would ask the agent, NOT questions the agent asks the user. Do NOT phrase them as offers or suggestions from the agent (e.g. avoid "Do you want me to..."); instead phrase them as what the user might want to know or request next.
            `;

            if (settings.provider === 'google') {
                const res = await callGoogleGemini(settings, prompt, fullSystemInstruction, onStream);
                textResponse = res.text;
                sources = res.sources;
            } else {
                textResponse = await callCustomLLM(settings, prompt, fullSystemInstruction, onStream);
            }
        }
        
        // --- Parsing Logic ---

        let updatedWorkflow: ComfyWorkflow | null = null;
        const allJsonMatches = textResponse.matchAll(/```json\s*([\s\S]*?)\s*```/g);
        for (const jsonMatch of allJsonMatches) {
            if (jsonMatch[1]) {
                try {
                    const rawJson = jsonMatch[1];
                    const cleanedJson = cleanJsonString(rawJson);
                    const parsed = JSON.parse(cleanedJson);
                    if (parsed && parsed.nodes && parsed.links && !Array.isArray(parsed)) {
                        updatedWorkflow = parsed;
                        break;
                    }
                } catch (e) {
                    console.error("Failed to parse generated workflow JSON:", e);
                }
            }
        }

        let issues: WorkflowIssue[] = parseIssuesFromText(textResponse);

        let relatedQuestions: string[] = [];
        const relatedJsonStr = findJsonArrayAfterMarker(textResponse, 'RELATED_QUESTIONS:');
        if (relatedJsonStr) {
            try {
                relatedQuestions = JSON.parse(cleanJsonString(relatedJsonStr));
            } catch (e) {
                console.error("Failed to parse related questions:", e);
            }
        }

        let cleanText = textResponse;

        const workflowJsonMatch = cleanText.match(/```json\s*([\s\S]*?)\s*```/);
        if (workflowJsonMatch) {
            try {
                const rawJson = cleanJsonString(workflowJsonMatch[1]);
                const parsed = JSON.parse(rawJson);
                if (parsed && parsed.nodes && parsed.links && !Array.isArray(parsed)) {
                    cleanText = cleanText.replace(/```json\s*[\s\S]*?\s*```/, t(lang, 'updateMessage'));
                }
            } catch { /* not valid JSON, leave as is */ }
        }

        const issuesJsonInText = findJsonArrayAfterMarker(cleanText, 'ISSUES_JSON:');
        if (issuesJsonInText) {
            const markerIdx = cleanText.indexOf('ISSUES_JSON:');
            const endIdx = markerIdx + 'ISSUES_JSON:'.length + cleanText.slice(markerIdx + 'ISSUES_JSON:'.length).indexOf(issuesJsonInText) + issuesJsonInText.length;
            cleanText = cleanText.slice(0, markerIdx) + cleanText.slice(endIdx);
        }

        const relatedJsonInText = findJsonArrayAfterMarker(cleanText, 'RELATED_QUESTIONS:');
        if (relatedJsonInText) {
            const markerIdx = cleanText.indexOf('RELATED_QUESTIONS:');
            const endIdx = markerIdx + 'RELATED_QUESTIONS:'.length + cleanText.slice(markerIdx + 'RELATED_QUESTIONS:'.length).indexOf(relatedJsonInText) + relatedJsonInText.length;
            cleanText = cleanText.slice(0, markerIdx) + cleanText.slice(endIdx);
        }

        cleanText = cleanText
            .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
            .trim();

        return {
            chatResponse: cleanText,
            updatedWorkflow: updatedWorkflow,
            missingNodes: [], 
            issues: issues,
            relatedQuestions: relatedQuestions,
            groundingSources: sources
        };

    } catch (error: any) {
        console.error("AI Agent Error:", error);
        return {
            chatResponse: `${t(lang, 'errorPrefix')} ${error.message || 'Unknown error'}`,
            updatedWorkflow: null,
            groundingSources: []
        };
    }
};
