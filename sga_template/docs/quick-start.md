# 快速开始

> 📄 相关源文件：`package.json`（脚本定义）、`src/server/main.ts`（启动入口）

## 安装

```bash
cd cc_contron && npm install
```

## 启动方式

### 开发模式（带热重载）

```bash
npm run dev
```

### 编译并启动

```bash
npm run build && npm run start:dist
```

### 类型检查

```bash
npm run typecheck
```

## 验证服务

启动后访问 `http://localhost:3000/api/v1/health` 验证服务是否正常运行。

```bash
curl http://localhost:3000/api/v1/health
```

如果返回 `{"status":"ok"}`，说明服务已成功启动。

## 配置 LLM 供应商

SGA-Template 支持多种 LLM 供应商，你可以通过 `.env` 文件或配置文件来配置供应商。

### 使用 .env 文件（推荐快速配置）

```bash
# 复制示例文件
cp .env.example .env
```

编辑 `.env` 文件：

```bash
# 使用 Anthropic（默认）
ANTHROPIC_API_KEY=sk-ant-xxx

# 或使用 DeepSeek
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
```

### 使用配置文件（推荐多供应商配置）

在项目根目录创建 `sga-providers.json`：

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
      "defaultModel": "gpt-4o"
    }
  ]
}
```

> 更多供应商配置方式（包括模型配置、中转供应商扩展等），详见 [多供应商 LLM 接入](multi-provider.md)。

## 第一次对话

```bash
# 1. 创建会话
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"model": "sonnet", "maxTurns": 50, "permissionMode": "bypassPermissions"}'

# 2. 发送消息（将 {sessionId} 替换为上一步返回的 ID）
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "你好，请介绍一下你自己"}'
```

## 下一步

- [项目架构](architecture.md) — 了解整体代码结构
- [作为后端服务使用](backend-service.md) — 完整的 API 接口文档
- [作为库使用](library-usage.md) — 在代码中直接调用
- [二次开发指南](custom-tools.md) — 自定义工具、Agent、供应商等
