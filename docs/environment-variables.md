# 环境变量

> 📄 相关源文件：`src/server/main.ts`（启动入口读取环境变量）、`src/providers/provider-store.ts`（多供应商存储与管理）、`src/providers/registry.ts`（供应商注册）、`src/config.ts`（SGA 运行时配置统一加载）

## 概述

SGA-Template 通过环境变量进行配置，支持灵活的供应商切换和运行时行为调整。支持 `.env` 文件，且 `.env` 文件中的值**优先于**系统环境变量。

## .env 文件

SGA-Template 内置了 dotenv 支持，在项目根目录（即运行 `npm run dev` 的目录）创建 `.env` 文件即可自动加载。

### 快速开始

1. 复制示例文件：

```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，填写你的配置：

```bash
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-xxx
```

3. 启动服务：

```bash
npm run dev
```

### .env 文件优先级

> **`.env` 文件中的值会覆盖同名的系统环境变量。**

这意味着：

- 如果系统环境变量设置了 `LLM_API_KEY=sk-system`，但 `.env` 文件中设置了 `LLM_API_KEY=sk-dotenv`，最终使用 `sk-dotenv`
- 这让你可以在 `.env` 文件中统一管理配置，而不必担心系统环境变量的干扰

### .env 文件加载规则

- 文件路径：项目根目录下的 `.env` 文件（即 `process.cwd()/.env`）
- 加载时机：服务启动时自动加载（在读取任何环境变量之前）
- 覆盖模式：`override: true`（.env 文件中的值覆盖系统环境变量）
- 文件不存在时：静默忽略，不会报错

### 安全提示

- **不要**将 `.env` 文件提交到版本控制系统
- 确保 `.gitignore` 包含 `.env`
- 项目已提供 `.env.example` 作为配置模板

## 完整环境变量列表

### LLM 供应商配置（默认供应商）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `LLM_PROVIDER` | 否 | `anthropic` | LLM 供应商名称（`anthropic` / `openai` / `deepseek` / `zhipu` / `moonshot` / `qwen`） |
| `LLM_API_KEY` | 否 | 无 | LLM API 密钥 |
| `LLM_BASE_URL` | 否 | 供应商默认 URL | LLM API 基础 URL |
| `LLM_MODEL` | 否 | 供应商默认模型 | 默认模型名称 |
| `LLM_MAX_TOKENS` | 否 | 无 | 最大生成 Token 数 |
| `LLM_TEMPERATURE` | 否 | 无 | 温度参数（0.0 - 1.0） |
| `LLM_RETRIES` | 否 | `2` | 请求重试次数 |
| `LLM_RETRY_DELAY` | 否 | `1000` | 重试延迟（毫秒） |
| `LLM_EXTRA_HEADERS` | 否 | 无 | 额外请求头（JSON 格式） |

### Anthropic 专用

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 否 | 无 | Anthropic API 密钥 |

> 当 `LLM_PROVIDER=anthropic` 时，API 密钥的读取顺序为：`LLM_API_KEY` → `ANTHROPIC_API_KEY` → 空字符串。

### 多供应商配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_PROVIDERS` | 否 | 无 | 额外供应商配置（JSON 数组格式） |

`SGA_PROVIDERS` 示例：

```bash
SGA_PROVIDERS=[{"name":"deepseek","apiKey":"sk-xxx","defaultModel":"deepseek-chat"},{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o"}]
```

`SGA_PROVIDERS` 支持完整的供应商配置，包括模型配置和扩展：

```bash
# 带模型配置
SGA_PROVIDERS=[{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o","modelConfigs":{"gpt-4o":{"id":"gpt-4o","contextWindow":128000,"maxOutputTokens":16384,"supportsVision":true,"supportsToolUse":true}}}]

# 带转换器扩展（中转供应商）
SGA_PROVIDERS=[{"name":"my-relay","apiKey":"sk-relay-xxx","baseUrl":"https://relay.example.com/v1","defaultModel":"gpt-4o","extension":{"requestTransformer":"./transformers/my-relay-request.js","responseTransformer":"./transformers/my-relay-response.js"}}]
```

> 由于环境变量中 JSON 格式较难维护，推荐使用配置文件（`sga-providers.json`）来配置复杂的供应商设置。详见 [多供应商 LLM 接入](multi-provider.md)。

### 服务配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `3000` | HTTP 服务端口 |
| `HOST` | 否 | `0.0.0.0` | HTTP 服务绑定地址 |
| `CORS_ORIGIN` | 否 | `*` | CORS 允许的来源 |
| `SGA_API_KEY` | 否 | 无 | API 认证密钥（设置后请求需携带 `Authorization: Bearer <key>`） |
| `BASE_PATH` | 否 | `/api/v1` | API 基础路径 |
| `SGA_HOME` | 否 | `~/.sga` | 框架数据主目录（记忆文件、供应商配置、MCP 配置、Skills 等） |

### Web 搜索工具

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `BRAVE_SEARCH_API_KEY` | 否 | 无 | Brave Search API 密钥 |
| `WEB_SEARCH_API_KEY` | 否 | 无 | 通用 Web 搜索 API 密钥（备用） |

### 上下文压缩 — MicroCompact（微压缩）

> 📄 相关源文件：`src/memory/compact/micro-compact.ts`

微压缩无需 LLM，仅清除旧的工具输出结果以节省 token。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_COMPACT_MICRO_ENABLED` | 否 | `true` | 是否启用微压缩 |
| `SGA_COMPACT_MICRO_GAP_MINUTES` | 否 | `10` | 距上次助手消息超过多少分钟触发 |
| `SGA_COMPACT_MICRO_KEEP_RECENT` | 否 | `3` | 保留最近 N 条工具结果 |
| `SGA_COMPACT_MICRO_MAX_TOOL_RESULT_TOKENS` | 否 | `50000` | 单条工具结果最大 token 数 |

### 上下文压缩 — SessionMemoryCompact（会话记忆压缩）

> 📄 相关源文件：`src/memory/compact/session-memory-compact.ts`

用会话记忆摘要替代旧消息，比全量压缩更轻量。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_COMPACT_SM_MIN_TOKENS` | 否 | `10000` | 触发压缩的最小 token 数 |
| `SGA_COMPACT_SM_MIN_TEXT_BLOCK_MESSAGES` | 否 | `5` | 触发压缩的最小文本块消息数 |
| `SGA_COMPACT_SM_MAX_TOKENS` | 否 | `40000` | 压缩的最大 token 数 |
| `SGA_COMPACT_SM_MAX_SESSION_MEMORY_TOKENS` | 否 | `30000` | 会话记忆摘要最大 token 数 |

### 上下文压缩 — FullCompact（全量压缩）

> 📄 相关源文件：`src/memory/compact/full-compact.ts`

使用 LLM 生成结构化摘要，是最彻底的压缩方式。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_COMPACT_FULL_ENABLED` | 否 | `true` | 是否启用全量压缩 |
| `SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS` | 否 | `20000` | LLM 摘要最大输出 token 数 |
| `SGA_COMPACT_FULL_MAX_PTL_RETRIES` | 否 | `3` | Prompt Too Long 重试次数 |
| `SGA_COMPACT_FULL_BUFFER_TOKENS` | 否 | `13000` | 压缩前保留的缓冲 token 数 |
| `SGA_COMPACT_FULL_WARNING_THRESHOLD_TOKENS` | 否 | `20000` | token 警告阈值 |
| `SGA_COMPACT_FULL_MAX_CONSECUTIVE_FAILURES` | 否 | `3` | 连续失败最大次数 |

### 上下文压缩 — 通用

> 📄 相关源文件：`src/memory/compact/index.ts`

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_MODEL_MAX_TOKENS` | 否 | `200000` | 模型上下文窗口最大 token 数（根据使用的模型调整，如 GPT-4o 设为 128000） |
| `SGA_COMPACT_PREFER_SESSION_MEMORY` | 否 | `true` | 是否优先使用会话记忆压缩（比全量压缩更轻量） |

### 记忆整合（AutoDream）

> 📄 相关源文件：`src/memory/consolidation/auto-dream.ts`

记忆整合在后台自动将碎片化的会话记忆合并为结构化长期记忆。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_CONSOLIDATION_ENABLED` | 否 | `true` | 是否启用记忆整合 |
| `SGA_CONSOLIDATION_MIN_HOURS` | 否 | `24` | 距上次整合至少多少小时 |
| `SGA_CONSOLIDATION_MIN_SESSIONS` | 否 | `5` | 至少有多少新会话才触发整合 |
| `SGA_CONSOLIDATION_MAX_OUTPUT_TOKENS` | 否 | `16000` | 整合 LLM 最大输出 token 数 |
| `SGA_CONSOLIDATION_MODEL` | 否 | `haiku` | 整合使用的模型别名 |
| `SGA_CONSOLIDATION_LOCK_STALE_MS` | 否 | `3600000` | 整合锁过期时间（毫秒，默认 1 小时） |
| `SGA_CONSOLIDATION_SCAN_INTERVAL_MS` | 否 | `600000` | 整合扫描间隔（毫秒，默认 10 分钟） |

### 上下文预算

> 📄 相关源文件：`src/memory/context-budget.ts`

上下文预算管理器控制 token 分配，防止上下文窗口溢出。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_BUDGET_MAX_CONTEXT_TOKENS` | 否 | `200000` | 上下文窗口最大 token 数（应与 `SGA_MODEL_MAX_TOKENS` 保持一致） |
| `SGA_BUDGET_RESERVED_SYSTEM_TOKENS` | 否 | `4000` | 系统指令预留 token 数 |
| `SGA_BUDGET_RESERVED_CONVERSATION_TOKENS` | 否 | `50000` | 对话预留 token 数 |
| `SGA_BUDGET_RESERVED_TOOLS_TOKENS` | 否 | `10000` | 工具预留 token 数 |
| `SGA_BUDGET_MEMORY_RATIO` | 否 | `0.25` | 记忆预算占比 |
| `SGA_BUDGET_WORKING_SET_RATIO` | 否 | `0.15` | 工作集预算占比 |
| `SGA_BUDGET_COMPRESSION_THRESHOLD` | 否 | `0.85` | 压缩触发阈值（使用 85% 时触发） |

### 工作集（WorkingSet）

> 📄 相关源文件：`src/memory/working-set.ts`

工作集用于锚定重要的长内容（如工作流 JSON），自动管理其生命周期。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_WORKING_SET_MAX_ANCHORS` | 否 | `5` | 最大锚点数量 |
| `SGA_WORKING_SET_ANCHOR_FADE_MS` | 否 | `300000` | 锚点淡出时间（毫秒，默认 5 分钟） |
| `SGA_WORKING_SET_ANCHOR_EXPIRE_MS` | 否 | `900000` | 锚点过期时间（毫秒，默认 15 分钟） |
| `SGA_WORKING_SET_MAX_ANCHOR_TOKENS` | 否 | `8000` | 单个锚点最大 token 数 |
| `SGA_WORKING_SET_AUTO_PIN_THRESHOLD` | 否 | `3` | 自动固定阈值（访问次数达到此值时自动固定） |
| `SGA_WORKING_SET_SUMMARY_ON_FADE` | 否 | `true` | 淡出时是否生成摘要 |

### 压缩后状态恢复

> 📄 相关源文件：`src/memory/compact/post-compact-restore.ts`

压缩后自动恢复关键上下文（已读文件、活跃计划、技能状态等）。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_POST_COMPACT_MAX_FILES` | 否 | `5` | 恢复的最大文件数 |
| `SGA_POST_COMPACT_TOKEN_BUDGET` | 否 | `50000` | 恢复的总 token 预算 |
| `SGA_POST_COMPACT_MAX_TOKENS_PER_FILE` | 否 | `5000` | 单文件最大恢复 token 数 |
| `SGA_POST_COMPACT_MAX_TOKENS_PER_SKILL` | 否 | `5000` | 单技能最大恢复 token 数 |
| `SGA_POST_COMPACT_SKILLS_TOKEN_BUDGET` | 否 | `25000` | 技能恢复总 token 预算 |

### 熔断器

> 📄 相关源文件：`src/utils/circuit-breaker.ts`

熔断器防止压缩/整合操作在连续失败时反复重试，保护系统稳定性。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_CB_COMPACT_MAX_FAILURES` | 否 | `3` | 压缩熔断器：连续失败次数 |
| `SGA_CB_COMPACT_COOLDOWN_MS` | 否 | `300000` | 压缩熔断器：冷却时间（毫秒，默认 5 分钟） |
| `SGA_CB_COMPACT_HALF_OPEN_ATTEMPTS` | 否 | `1` | 压缩熔断器：半开状态最大尝试次数 |
| `SGA_CB_CONSOLIDATION_MAX_FAILURES` | 否 | `2` | 整合熔断器：连续失败次数 |
| `SGA_CB_CONSOLIDATION_COOLDOWN_MS` | 否 | `1800000` | 整合熔断器：冷却时间（毫秒，默认 30 分钟） |
| `SGA_CB_CONSOLIDATION_HALF_OPEN_ATTEMPTS` | 否 | `1` | 整合熔断器：半开状态最大尝试次数 |

### 工具调用摘要

> 📄 相关源文件：`src/memory/compact/tool-summary.ts`

使用轻量 LLM 对工具调用输入/输出生成摘要，减少 token 占用。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_TOOL_SUMMARY_ENABLED` | 否 | `true` | 是否启用工具调用摘要 |
| `SGA_TOOL_SUMMARY_MODEL` | 否 | `haiku` | 生成摘要使用的模型 |
| `SGA_TOOL_SUMMARY_MAX_INPUT_LENGTH` | 否 | `300` | 工具输入最大长度 |
| `SGA_TOOL_SUMMARY_MAX_OUTPUT_LENGTH` | 否 | `300` | 工具输出最大长度 |
| `SGA_TOOL_SUMMARY_MAX_SUMMARY_LENGTH` | 否 | `60` | 摘要最大长度 |

### 团队记忆同步

> 📄 相关源文件：`src/memory/team-memory-sync.ts`

多 Agent 之间的记忆自动同步与冲突解决。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_TEAM_SYNC_ENABLED` | 否 | `true` | 是否启用团队记忆同步 |
| `SGA_TEAM_SYNC_INTERVAL_MS` | 否 | `30000` | 同步间隔（毫秒，默认 30 秒） |
| `SGA_TEAM_SYNC_MAX_ENTRIES` | 否 | `50` | 每次同步最大条目数 |
| `SGA_TEAM_SYNC_CONFLICT_RESOLUTION` | 否 | `last_write_wins` | 冲突解决策略（`last_write_wins` / `merge` / `manual`） |

### 思考力度（Thinking Effort）

> 📄 相关源文件：`src/agents/thinking-prompts.ts`（策略解析与提示词模板）、`src/agents/runner.ts`（运行时注入）、`src/config.ts`（环境变量加载）

控制 Agent 的思考深度。支持三种策略自动适配：

| 策略 | 适用模型 | 实现方式 |
|------|---------|---------|
| 原生思考（Native Thinking） | Claude Sonnet 4、Claude Opus 4 | `thinking: { type: 'enabled', budget_tokens: n }` |
| 原生推理力度（Reasoning Effort） | OpenAI o1、o1-mini、o3-mini | `reasoning_effort: 'low' \| 'medium' \| 'high'` |
| 提示词注入（Prompt Injection） | GPT-4o、DeepSeek、其他所有模型 | 系统提示词追加思考引导 / Chain-of-Thought |

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_THINKING_EFFORT_DEFAULT` | 否 | `medium` | 默认思考力度（`low` / `medium` / `high` / `max`） |
| `SGA_THINKING_EFFORT_BUDGET_LOW` | 否 | `2000` | `low` 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_MEDIUM` | 否 | `10000` | `medium` 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_HIGH` | 否 | `20000` | `high` 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_MAX` | 否 | `32000` | `max` 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_PROMPT_INJECTION` | 否 | `true` | 是否对不支持原生思考的模型启用提示词注入模拟 |
| `SGA_THINKING_EFFORT_COT` | 否 | `true` | 是否在提示词注入中使用 Chain-of-Thought 格式（仅 `high`/`max` 生效） |

### Feature Gate 特性开关

> 📄 相关源文件：`src/feature-gate/index.ts`

Feature Gate 控制各项高级能力的启用/禁用。所有环境变量以 `SGA_FEATURE_` 为前缀。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_FEATURE_ADVERSARIAL_VERIFICATION` | 否 | `true` | 对抗性验证 Agent |
| `SGA_FEATURE_ADVISOR_AGENT` | 否 | `true` | Advisor 顾问反思 Agent |
| `SGA_FEATURE_TOOL_RETRY` | 否 | `true` | 工具执行重试（指数退避） |
| `SGA_FEATURE_CONSECUTIVE_FAILURE_PIVOT` | 否 | `true` | 连续失败自动转向 |
| `SGA_FEATURE_PARALLEL_SEARCH` | 否 | `true` | 并行搜索策略 |
| `SGA_FEATURE_CACHE_OPTIMIZATION` | 否 | `true` | API 层缓存优化 |
| `SGA_FEATURE_TELEMETRY` | 否 | `false` | 遥测数据收集 |
| `SGA_FEATURE_HOOK_FAILURE_HANDLING` | 否 | `true` | Hook 失败处理 |
| `SGA_FEATURE_BASH_COMMAND_CLASSIFICATION` | 否 | `true` | Bash 命令细粒度分类 |
| `SGA_FEATURE_DYNAMIC_PROMPT_ASSEMBLY` | 否 | `true` | 动态系统提示词拼装 |
| `SGA_FEATURE_BEHAVIOR_RULES_INJECTION` | 否 | `true` | 行为规则注入 |
| `SGA_FEATURE_MCP_INSTRUCTIONS_IN_PROMPT` | 否 | `true` | MCP 指令注入提示词 |
| `SGA_FEATURE_SKILL_LIST_IN_PROMPT` | 否 | `true` | Skill 列表注入提示词 |

> 详见 [Feature Gate 特性开关](feature-gate.md)。

### 遥测配置

> 📄 相关源文件：`src/telemetry/index.ts`

遥测默认关闭，需通过 `SGA_FEATURE_TELEMETRY=true` 启用。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_TELEMETRY_FLUSH_INTERVAL_MS` | 否 | `30000` | 事件队列自动刷新间隔（毫秒） |

> 详见 [遥测框架](telemetry.md)。

## 配置示例

### 使用 Anthropic

```bash
# .env 文件
ANTHROPIC_API_KEY=sk-ant-api03-xxx
```

或：

```bash
export LLM_PROVIDER=anthropic
export LLM_API_KEY=sk-ant-api03-xxx
```

### 使用 DeepSeek

```bash
# .env 文件
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

> 当 `LLM_PROVIDER` 设置为 `deepseek` 时，`LLM_BASE_URL` 和 `LLM_MODEL` 会自动使用默认值，无需手动指定。

### 使用通义千问

```bash
# .env 文件
LLM_PROVIDER=qwen
LLM_API_KEY=sk-xxx
```

### 配置多个供应商

```bash
# .env 文件 — 默认供应商
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx

# .env 文件 — 额外供应商
SGA_PROVIDERS=[{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o"},{"name":"anthropic","apiKey":"sk-ant-zzz","defaultModel":"sonnet"}]
```

或者使用配置文件 `sga-providers.json`：

```json
{
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "apiKey": "sk-xxx",
      "defaultModel": "deepseek-chat"
    },
    {
      "name": "openai",
      "apiKey": "sk-yyy",
      "defaultModel": "gpt-4o",
      "modelConfigs": {
        "gpt-4o": {
          "id": "gpt-4o",
          "displayName": "GPT-4o",
          "contextWindow": 128000,
          "maxOutputTokens": 16384,
          "supportsVision": true,
          "supportsToolUse": true
        }
      }
    },
    {
      "name": "anthropic",
      "apiKey": "sk-ant-zzz",
      "defaultModel": "sonnet"
    }
  ]
}
```

### 配置中转供应商（带扩展）

```json
{
  "defaultProvider": "my-relay",
  "providers": [
    {
      "name": "my-relay",
      "apiKey": "sk-relay-xxx",
      "baseUrl": "https://relay.example.com/v1",
      "defaultModel": "gpt-4o",
      "extension": {
        "requestTransformer": "./transformers/my-relay-request.js",
        "responseTransformer": "./transformers/my-relay-response.js",
        "streamChunkTransformer": "./transformers/my-relay-stream.js"
      }
    },
    {
      "name": "my-custom-provider",
      "apiKey": "sk-custom-xxx",
      "baseUrl": "https://custom.example.com/api",
      "defaultModel": "custom-model",
      "extension": {
        "providerModule": "./providers/my-custom-provider.js"
      }
    }
  ]
}
```

> 关于模型配置和扩展机制的详细说明，请参阅 [多供应商 LLM 接入](multi-provider.md)。

### 使用本地 Ollama

```bash
# .env 文件
LLM_PROVIDER=openai
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3
```

### 自定义端口

```bash
# .env 文件
PORT=8080
ANTHROPIC_API_KEY=sk-ant-xxx
```

### 自定义数据目录

```bash
# .env 文件
SGA_HOME=/data/sga  # Linux/macOS
SGA_HOME=D:\sga-data  # Windows
```

> 设置 `SGA_HOME` 后，框架会将记忆文件、供应商配置、MCP 配置、Skills 等数据存储到指定目录，而不是默认的 `~/.sga`。

### 调整上下文窗口大小

当使用不同模型时，需要调整上下文窗口大小：

```bash
# 使用 GPT-4o（128k 上下文）
SGA_MODEL_MAX_TOKENS=128000
SGA_BUDGET_MAX_CONTEXT_TOKENS=128000

# 使用 Claude Haiku（200k 上下文，默认）
SGA_MODEL_MAX_TOKENS=200000
SGA_BUDGET_MAX_CONTEXT_TOKENS=200000

# 使用 DeepSeek（64k 上下文）
SGA_MODEL_MAX_TOKENS=64000
SGA_BUDGET_MAX_CONTEXT_TOKENS=64000
SGA_BUDGET_RESERVED_CONVERSATION_TOKENS=20000
```

### 调整压缩策略

```bash
# 更激进的压缩（适合小上下文窗口模型）
SGA_BUDGET_COMPRESSION_THRESHOLD=0.70
SGA_COMPACT_MICRO_KEEP_RECENT=2
SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS=10000

# 更保守的压缩（适合大上下文窗口模型）
SGA_BUDGET_COMPRESSION_THRESHOLD=0.90
SGA_COMPACT_MICRO_KEEP_RECENT=5
SGA_COMPACT_FULL_MAX_OUTPUT_TOKENS=30000
```

### 禁用特定功能

```bash
# 禁用记忆整合
SGA_CONSOLIDATION_ENABLED=false

# 禁用工具调用摘要
SGA_TOOL_SUMMARY_ENABLED=false

# 禁用团队记忆同步
SGA_TEAM_SYNC_ENABLED=false
```

## 优先级

配置的优先级从高到低：

1. **API 动态添加的供应商**（运行时通过 `POST /providers` 添加）
2. **配置文件**（`sga-providers.json` 或 `~/.sga/providers.json`）
3. **`.env` 文件中的值**（覆盖系统环境变量）
4. **系统环境变量**（`LLM_*` / `ANTHROPIC_*` 等）
5. **代码中的默认值**

> 注意：创建会话时指定的 `providerName` 不是优先级覆盖，而是选择已配置的供应商。如果指定的供应商名称不存在，会返回 400 错误。

## 相关文档

- [多供应商 LLM 接入](multi-provider.md)
- [快速开始](quick-start.md)
- [API 参考](api-reference.md)
