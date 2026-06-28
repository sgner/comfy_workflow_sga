# SGA Template — ComfyUI Workflow Agent 后端

> ⚠️ 这不是独立项目。本目录是 ComfyUI 自定义节点 [comfy_workflow_agent](../README.md) 的内嵌 SGA 后端，被 `__init__.py` 自动启动。

SGA（Self-contained General Agent）是一个基于 Node.js 20 + TypeScript 5.7 + Express 4.21 的 Agent 框架，为 ComfyUI Workflow Agent 提供：

- 多 LLM 供应商适配（OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容 API）
- 30+ 内置工具（工作流分析、ComfyUI API、Bash / File / Glob / Grep / WebFetch / WebSearch / GitHub / HuggingFace / Civitai …）
- Skills 系统（bundled + 用户自定义，API / 文件 / Agent 自动生成）
- MCP 集成（streamable-http / sse / stdio 三种 transport）
- 多层记忆系统（global / project / session + AutoDream 整合）
- 团队协作（多 Agent mailbox）
- Coordinator 编排（research → synthesis → implementation → verification）
- 对抗性验证（10 种策略，PASS/FAIL 判定）
- 工具失败重试 + Advisor 顾问反思
- 13 个 feature gate 特性开关
- 可选的 Codex Rust 子进程后端（见 [../docs/codex-agent-integration.md](../docs/codex-agent-integration.md)）

## 目录结构

```
sga_template/
├── src/
│   ├── server/                 # Express HTTP 服务
│   │   ├── app.ts              # 路由装配（84 个 /api/v1/* + 22 个 /api/*）
│   │   ├── routes.ts           # 主要 handler
│   │   ├── skills-mcp-routes.ts# Skills + MCP handler
│   │   ├── main.ts             # 进程入口
│   │   ├── session-store.ts    # 文件系统会话存储（proper-lockfile）
│   │   ├── interaction.ts      # 审批 / 用户输入桥
│   │   ├── codex-status.ts     # Codex 能力状态探测
│   │   └── diagnostics.ts      # 系统诊断聚合
│   ├── agents/                 # Agent 后端与多 Agent 调度
│   │   ├── backend.ts          # AgentBackend 抽象接口
│   │   ├── sga-backend.ts      # SGA in-process 后端
│   │   ├── codex-backend.ts    # Codex subprocess 后端
│   │   ├── registry.ts         # BackendRegistry 单例
│   │   ├── runner.ts           # runAgent() 核心循环
│   │   ├── built-in/           # 内置 Agent 定义（含 comfyui-agent.ts）
│   │   ├── codex/             # Codex 集成层（process/jsonrpc/event-bridge/provider-proxy/detect/context/config）
│   │   ├── handoff/           # 切换时的 store/blackboard/extractor
│   │   ├── coordinator.ts     # 多 Agent 协调
│   │   ├── fork.ts            # 子 Agent 分叉
│   │   └── plan-manager.ts    # 结构化计划管理
│   ├── providers/              # LLM Provider 适配
│   ├── tools/built-in/         # 30+ 内置工具
│   ├── mcp/                    # MCP 协议客户端
│   ├── memory/                 # 多层记忆 + 压缩 + 整合
│   ├── skills/                 # 技能系统
│   ├── comfyui/                # ComfyUI 专用扩展（live-context / hooks / mcp-server）
│   ├── context/                # 上下文构建 + 压缩
│   ├── core/                   # Agent 类型与状态机
│   ├── permissions/             # 权限检查
│   ├── hooks/                  # 钩子系统
│   ├── tasks/                  # 后台任务
│   ├── teams/                  # 团队协作
│   ├── telemetry/              # 埋点
│   ├── feature-gate/           # 功能开关
│   └── utils/                  # logger / circuit-breaker / cost-tracker
├── codex-rs/                   # vendored Rust codex-rs 源码（Apache-2.0）
├── package.json
├── tsconfig.json               # ESNext + ES2022 + strict
└── .env.example                # 70+ 环境变量样例
```

## 开发

```bash
npm install
npm run dev          # tsx watch src/server/main.ts
npm run typecheck
npm test             # vitest run
npm run build       # tsc → dist/
npm start           # node dist/server/main.js
```

构建产物在 `dist/`，由 `__init__.py` Popen 启动。

## 文档

完整文档在项目根：

- [../README.md](../README.md) — 项目总览
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — 架构与运行时边界
- [../DEVELOPMENT.md](../DEVELOPMENT.md) — 开发工作流与扩展指南
- [../DEVLOG.md](../DEVLOG.md) — 开发日志
- [../docs/tech-stack.md](../docs/tech-stack.md) — 技术栈总览
- [../docs/codex-agent-integration.md](../docs/codex-agent-integration.md) — Codex 集成
- [.env.example](.env.example) — 环境变量参考

## License

MIT。vendored Codex Rust 源码（[codex-rs/](codex-rs/)）保留上游 Apache-2.0 协议。
