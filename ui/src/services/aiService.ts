

import { GoogleGenAI } from "@google/genai";
import { ComfyWorkflow, GeminiResponseSchema, AppSettings, WorkflowIssue, AgentStatus, ChatMessage, Sender, ApprovalRequest, HumanInputRequest, ToolCallInfo } from '../types';
import { t } from '../utils/i18n';

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

## FINAL OUTPUT
At the end of your response, please provide 3 short "Related Questions" that user might want to ask next to help them deeper understand the workflow or resolve issues.
Format them as a JSON array labeled \`RELATED_QUESTIONS\`.
Example: \`RELATED_QUESTIONS: ["Question 1?", "Question 2?"]\`
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

// --- Helper for Custom OpenAI-Compatible Calls (Non-Streaming Fallback) ---
async function callCustomLLM(
    settings: AppSettings, 
    prompt: string, 
    systemInstruction: string,
    onStream?: (chunk: string) => void
): Promise<string> {
    if (!settings.baseUrl) throw new Error("Base URL required for custom provider");

    // Default Configuration
    const defaultConfig = {
        endpoint: "/chat/completions",
        headers: JSON.stringify({
            "Content-Type": "application/json",
            "Authorization": "Bearer $apiKey"
        }),
        body: JSON.stringify({
            "model": "$model",
            "messages": "$messages",
            "temperature": 0.5,
            "stream": false
        })
    };

    // Merge/Use Custom Config
    const custom = settings.customConfig || {};
    const endpointTpl = custom.endpoint || defaultConfig.endpoint;
    const headersTpl = custom.headers || defaultConfig.headers;
    const bodyTpl = custom.body || defaultConfig.body;

    // Resolve URL
    let url = "";
    if (endpointTpl.startsWith("http")) {
        url = endpointTpl;
    } else {
        const base = settings.baseUrl.replace(/\/$/, '');
        const path = endpointTpl.startsWith('/') ? endpointTpl : `/${endpointTpl}`;
        url = `${base}${path}`;
    }

    // Variables for Template
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

    // Resolve Headers
    let headers = {};
    try {
        const headersStr = resolveTemplate(headersTpl, variables);
        headers = JSON.parse(headersStr);
    } catch (e) {
        console.error("Failed to parse headers template", e);
        throw new Error("Invalid Headers Configuration");
    }

    // Resolve Body
    let bodyStr = "";
    try {
        bodyStr = resolveTemplate(bodyTpl, variables);
        JSON.parse(bodyStr); 
    } catch (e) {
        console.error("Failed to parse body template", e);
        throw new Error("Invalid Body Template JSON");
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: bodyStr
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Custom API Error: ${url} returned ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    let text = "";
    if (data.choices && data.choices[0]) {
        if (data.choices[0].message) {
            text = data.choices[0].message.content;
        } else if (data.choices[0].text) {
            text = data.choices[0].text;
        }
    } else if (data.content) {
        text = data.content; // Anthropic-ish
    } else if (data.response) {
        text = data.response; // Ollama generate
    }

    if (!text) {
        text = JSON.stringify(data);
    }
    
    if (onStream) onStream(text);
    
    return text;
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
    sessionId: string,
    errorLog: string | null,
    onStream?: (chunk: string) => void,
    onStatus?: (status: AgentStatus) => void,
    onApprovalRequired?: (request: ApprovalRequest) => void,
    onHumanInputRequired?: (request: HumanInputRequest) => void,
    onToolUseStart?: (info: ToolCallInfo) => void,
    onToolUseResult?: (info: ToolCallInfo) => void
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

   const payload = {
        message: prompt,
        workflow: workflow,
        session_id: sessionId,
        error_log: errorLog,
        language: settings.language,
        config_id: settings.activeBackendConfigId || undefined
    };
    
    const response = await fetch(`${settings.pythonBackendUrl.replace(/\/$/, '')}/api/chat/stream`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Backend Error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) throw new Error("No response body from backend");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    let structuredResult: {
        chatResponse: string;
        updatedWorkflow: Record<string, unknown> | null;
        issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>;
        relatedQuestions: string[];
        missingNodes: string[];
        groundingSources: Array<{ uri: string; title: string }>;
    } | undefined = undefined;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
                const jsonStr = line.replace('data: ', '').trim();
                if (jsonStr === '[DONE]') continue;
                
                try {
                    const data = JSON.parse(jsonStr);
                    
                    if (data.type === 'status_update' && onStatus) {
                        onStatus({
                            node: data.metadata?.node,
                            displayText: data.metadata?.display_text || 'Processing...',
                            status: data.metadata?.status || 'processing'
                        });
                    } else if (data.type === 'meta_update' && onStatus) {
                         onStatus({
                            node: data.metadata?.node,
                            displayText: 'Processing found data...', 
                            status: 'processing',
                            details: data.metadata?.step_data
                        });
                    } else if (data.type === 'content' || data.chunk) {
                        const text = data.chunk || '';
                        fullText += text;
                        if (onStream) onStream(text);
                    } else if (data.type === 'tool_use_start' && data.data) {
                        if (onToolUseStart) {
                            onToolUseStart({
                                toolName: data.data.toolName,
                                toolUseId: data.data.toolUseId,
                                status: 'running'
                            });
                        }
                    } else if (data.type === 'tool_use_result' && data.data) {
                        if (onToolUseResult) {
                            onToolUseResult({
                                toolName: data.data.toolName,
                                status: 'completed'
                            });
                        }
                    } else if (data.type === 'approval_required' && data.data) {
                        const approvalReq = data.data as ApprovalRequest;
                        if (onApprovalRequired) {
                            onApprovalRequired(approvalReq);
                        }
                    } else if (data.type === 'human_input_required' && data.data) {
                        const inputReq = data.data as HumanInputRequest;
                        if (onHumanInputRequired) {
                            onHumanInputRequired(inputReq);
                        }
                    } else if (data.type === 'result' && data.data) {
                        structuredResult = data.data as typeof structuredResult;
                    }
                    
                } catch (e) {
                    console.warn("Failed to parse backend SSE chunk", e);
                }
            }
        }
    }

    return { text: fullText, sources: [], structuredResult };
}

export const fetchChatHistory = async (
    settings: AppSettings,
    sessionId: string
): Promise<ChatMessage[]> => {
    if (!settings.usePythonBackend || !settings.pythonBackendUrl) return [];

    try {
        const response = await fetch(`${settings.pythonBackendUrl.replace(/\/$/, '')}/api/chat/history/${sessionId}`);
        if (!response.ok) return [];

        const rawHistory = await response.json();
        if (!Array.isArray(rawHistory)) return [];

        return rawHistory.map((msg: any, idx: number) => ({
            id: `hist-${idx}-${Date.now()}`,
            sender: msg.sender === 'user' ? Sender.USER : Sender.AI,
            text: msg.text || '',
            timestamp: new Date(msg.timestamp || Date.now()),
            metadata: msg.sender === 'ai' ? {
                provider: 'History'
            } : undefined
        }));
    } catch (e) {
        console.error("Failed to fetch chat history:", e);
        return [];
    }
};

export const analyzeWorkflowWithBackend = async (
    settings: AppSettings,
    workflow: ComfyWorkflow,
    sessionId: string
): Promise<WorkflowIssue[]> => {
    if (!settings.pythonBackendUrl) return [];

    try {
        const response = await fetch(`${settings.pythonBackendUrl.replace(/\/$/, '')}/api/workflow/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflow: workflow,
                session_id: sessionId,
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

export const sendMessageToComfyAgent = async (
    currentWorkflow: ComfyWorkflow,
    userPrompt: string,
    settings: AppSettings,
    _history: string[] = [],
    sessionId: string = "default",
    errorLog: string | null,
    onStream?: (chunk: string) => void,
    onStatus?: (status: AgentStatus) => void,
    onApprovalRequired?: (request: ApprovalRequest) => void,
    onHumanInputRequired?: (request: HumanInputRequest) => void,
    onToolUseStart?: (info: ToolCallInfo) => void,
    onToolUseResult?: (info: ToolCallInfo) => void
): Promise<GeminiResponseSchema> => {
    
    const lang = settings.language;

    try {
        const languageInstruction = `\nIMPORTANT: You MUST respond in the following language code: "${settings.language}". Translate your advice and interface text accordingly.`;
        const fullSystemInstruction = BASE_SYSTEM_INSTRUCTION + languageInstruction;

        let textResponse = "";
        let sources: Array<{ uri: string; title: string }> = [];
        let prompt = `
            [CURRENT WORKFLOW STATE]
            Node Count: ${currentWorkflow?.nodes?.length || 0}
            Nodes Summary: ${JSON.stringify(currentWorkflow?.nodes?.map(n => ({id: n.id, type: n.type, title: n.properties?.['Node name for S&R']})) || [])}
            
            [FULL WORKFLOW JSON]
            ${JSON.stringify(currentWorkflow)}
            `;

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
            - Provide 3 Related Questions in the format \`RELATED_QUESTIONS: ["Q1", "Q2"]\`.
            `;
        
        let structuredFromBackend: {
            chatResponse: string;
            updatedWorkflow: Record<string, unknown> | null;
            issues: Array<{ nodeId: string | null; severity: string; message: string; fixSuggestion?: string }>;
            relatedQuestions: string[];
            missingNodes: string[];
            groundingSources: Array<{ uri: string; title: string }>;
        } | undefined = undefined;

        if (settings.usePythonBackend) {
             const res = await callPythonBackendStream(settings, userPrompt, currentWorkflow, sessionId, errorLog, onStream, onStatus, onApprovalRequired, onHumanInputRequired, onToolUseStart, onToolUseResult);
             textResponse = res.text;
             sources = res.sources;
             structuredFromBackend = res.structuredResult;
        } else if (settings.provider === 'google') {
            const res = await callGoogleGemini(settings, prompt, fullSystemInstruction, onStream);
            textResponse = res.text;
            sources = res.sources;
        } else {
            textResponse = await callCustomLLM(settings, prompt, fullSystemInstruction, onStream);
        }
        
        // --- Parsing Logic ---

        if (structuredFromBackend) {
            return {
                chatResponse: structuredFromBackend.chatResponse || textResponse,
                updatedWorkflow: structuredFromBackend.updatedWorkflow as ComfyWorkflow | null,
                missingNodes: structuredFromBackend.missingNodes ?? [],
                issues: (structuredFromBackend.issues ?? []).map((issue: { nodeId: string | null; severity: string; message: string; fixSuggestion?: string }, idx: number) => ({
                    id: `ai-issue-${Date.now()}-${idx}`,
                    nodeId: issue.nodeId ? Number(issue.nodeId) || null : null,
                    severity: issue.severity as 'error' | 'warning' | 'info',
                    message: issue.message,
                    fixSuggestion: issue.fixSuggestion,
                })),
                relatedQuestions: structuredFromBackend.relatedQuestions ?? [],
                groundingSources: structuredFromBackend.groundingSources ?? sources,
            };
        }

        let updatedWorkflow: ComfyWorkflow | null = null;
        const jsonMatch = textResponse.match(/```json\s*([\s\S]*?)\s*```/);
        
        if (jsonMatch && jsonMatch[1]) {
            try {
                const rawJson = jsonMatch[1];
                const cleanedJson = cleanJsonString(rawJson);
                updatedWorkflow = JSON.parse(cleanedJson);
            } catch (e) {
                console.error("Failed to parse generated workflow JSON:", e);
            }
        }

        let issues: WorkflowIssue[] = [];
        const issuesMatch = textResponse.match(/ISSUES_JSON:\s*(?:```(?:json)?\s*)?(\[[\s\S]*?\])(?:\s*```)?/);
        if (issuesMatch && issuesMatch[1]) {
            try {
                const rawIssues = issuesMatch[1];
                const parsedIssues = JSON.parse(cleanJsonString(rawIssues));
                if (Array.isArray(parsedIssues)) {
                    issues = parsedIssues.map((issue: any, idx: number) => ({
                        id: `ai-issue-${Date.now()}-${idx}`,
                        nodeId: issue.nodeId || null,
                        severity: issue.severity || 'warning',
                        message: issue.message || 'Unknown issue',
                        fixSuggestion: issue.fixSuggestion
                    }));
                }
            } catch (e) {
                console.error('Failed to parse issues JSON:', e);
            }
        }

        let relatedQuestions: string[] = [];
        const relatedMatch = textResponse.match(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?(\[[\s\S]*?\])(?:\s*```)?/);
        if (relatedMatch && relatedMatch[1]) {
            try {
                relatedQuestions = JSON.parse(cleanJsonString(relatedMatch[1]));
            } catch (e) {
                console.error("Failed to parse related questions:", e);
            }
        }

        const cleanText = textResponse
            .replace(/```json\s*[\s\S]*?\s*```/, t(lang, 'updateMessage'))
            .replace(/ISSUES_JSON:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
            .replace(/SUGGESTED_ACTIONS:\s*\[.*?\]/, '')
            .replace(/RELATED_QUESTIONS:\s*(?:```(?:json)?\s*)?\[[\s\S]*?\](?:\s*```)?/, '')
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
