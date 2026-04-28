# 上下文压缩

> 📄 相关源文件：`src/context/compression.ts`（压缩函数）

## 概述

在与 LLM 的多轮对话中，消息历史会不断增长，最终可能超出模型的上下文窗口限制。上下文压缩机制通过智能地压缩历史消息，确保对话可以持续进行而不会丢失关键信息。

## 压缩触发条件

当满足以下条件时，压缩机制会被触发：

- 消息总 Token 数接近模型上下文窗口的限制
- 当前轮次的输入 Token 数超过阈值

## 压缩策略

### 1. 保留关键消息

- 始终保留系统提示词
- 始终保留最新的用户消息
- 始终保留最新的助手回复
- 保留最近 N 轮的完整对话

### 2. 压缩历史消息

对于较早的消息，采用摘要压缩策略：

```typescript
// 压缩前
[
  { role: 'user', content: '请列出当前目录的文件' },
  { role: 'assistant', content: '当前目录包含以下文件：\n1. src/main.ts\n2. package.json\n3. README.md' },
  { role: 'user', content: '请读取 package.json' },
  { role: 'assistant', content: 'package.json 的内容如下：\n{\n  "name": "my-project",\n  ...\n}' },
]

// 压缩后
[
  { role: 'user', content: '[上下文摘要] 用户查看了当前目录文件列表，并读取了 package.json 的内容。项目名称为 my-project。' },
]
```

### 3. 工具调用结果压缩

工具调用结果通常很长，压缩时会：

- 截断过长的输出
- 保留关键信息
- 添加省略标记

## 压缩 API

```typescript
import { compressMessages, estimateTokenCount } from 'SGA-Template'

// 估算 Token 数
const tokenCount = estimateTokenCount(messages)

// 压缩消息
const compressed = await compressMessages(messages, {
  maxTokens: 100000,
  model: 'sonnet',
  preserveRecentTurns: 5,
})
```

### CompressOptions

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxTokens` | `number` | 模型上下文窗口大小 | 最大 Token 数 |
| `model` | `string` | 当前模型 | 模型名称（用于确定上下文窗口） |
| `preserveRecentTurns` | `number` | `5` | 保留最近几轮完整对话 |
| `compressionModel` | `string` | 当前模型 | 用于生成摘要的模型 |

## 压缩流程

```
1. 估算当前消息的 Token 数
2. 如果未超过阈值，直接返回原始消息
3. 如果超过阈值：
   a. 分离系统提示词和最近 N 轮对话
   b. 对剩余消息进行摘要压缩
   c. 将摘要 + 保留的消息合并
   d. 重新估算 Token 数
   e. 如果仍超过阈值，增加压缩力度
4. 返回压缩后的消息
```

## 相关文档

- [自定义系统提示词](custom-prompt.md)
- [记忆系统](memory.md)
- [多供应商 LLM 接入](multi-provider.md)
