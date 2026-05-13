# 记忆系统

> 📄 相关源文件：`src/memory/manager.ts`（核心管理器）、`src/memory/extractor.ts`（自动提取）、`src/memory/retrieval.ts`（智能检索）、`src/memory/scanner.ts`（扫描）、`src/memory/prompt.ts`（提示词构建）、`src/memory/paths.ts`（路径管理）、`src/memory/types.ts`（类型定义）、`src/memory/storage/`（存储后端抽象层）

## 概述

记忆系统允许 Agent 跨会话保留和检索信息。它通过以下机制形成完整的记忆闭环：

1. **会话启动时** — 自动加载记忆指令和索引到系统提示词
2. **对话过程中** — 根据用户查询智能检索相关记忆并注入上下文
3. **对话结束后** — 后台自动提取新记忆写入存储

### 存储后端

记忆系统支持多种存储后端，用户可以使用数据库代替本地文件系统：

| 后端类型 | 说明 | 适用场景 |
|----------|------|----------|
| `filesystem` | 本地文件系统（默认） | 单机开发、轻量部署 |
| `vector` | 向量数据库 | 语义搜索、大规模记忆 |
| `sql` | 关系数据库（PostgreSQL/MySQL/SQLite） | 持久化存储、多实例共享 |
| `mongodb` | MongoDB 文档数据库 | 灵活 Schema、全文搜索 |
| `custom` | 自定义后端 | 特殊需求扩展 |

## 架构

![记忆系统架构](diagrams/memory-architecture.svg)

## 记忆类型

| 类型 | 标签 | 说明 |
|------|------|------|
| `user` | User | 用户偏好、模式和个人上下文 |
| `feedback` | Feedback | 行为反馈和纠正模式 |
| `project` | Project | 项目特定知识和动态 |
| `reference` | Reference | 外部引用和文档指针 |

## 记忆文件格式

记忆文件是带有 YAML frontmatter 的 Markdown 文件：

```markdown
---
type: project
description: 项目编码规范
created_at: 2025-04-30T10:00:00.000Z
updated_at: 2025-04-30T10:00:00.000Z
tags: typescript, lint, convention
---

# 编码规范

- 使用 TypeScript strict 模式
- 所有函数必须有返回类型注解
- 使用 ESLint + Prettier 进行代码格式化
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | 记忆类型：`user` / `feedback` / `project` / `reference` |
| `description` | `string` | 记忆描述（用于检索和索引） |
| `created_at` | `string` | 创建时间（ISO 8601） |
| `updated_at` | `string` | 更新时间（ISO 8601） |
| `tags` | `string[]` | 标签列表 |

## 记忆文件目录

记忆文件存储在 `~/.sga/projects/{sanitized_path}/memory/` 目录下，其中 `{sanitized_path}` 是项目根目录的安全化路径。

### SGA_HOME 环境变量

可通过环境变量 `SGA_HOME` 自定义主目录（默认 `~/.sga`）：

```bash
# .env 文件
SGA_HOME=/data/sga  # Linux/macOS
SGA_HOME=D:\sga-data  # Windows
```

路径解析优先级：
1. `MemoryPathConfig.overridePath` — 直接覆盖
2. `MemoryPathConfig.settingsPath` — 配置文件指定路径
3. 自动计算 — `$SGA_HOME/projects/{sanitized_cwd}/memory/`（默认 `~/.sga`）

### 与 Claude Code 兼容

框架同时兼容 Claude Code 的记忆路径。如果用户已有 `~/.claude` 目录，框架会自动读取其中的记忆文件，但新创建的记忆文件会保存到 `~/.sga` 目录下。

### 自动迁移

当显式配置 `SGA_HOME` 指向新目录时，框架会自动从旧目录迁移数据：

**迁移触发条件**：
1. 新的 `SGA_HOME` 目录不存在，或仅包含空目录结构（无实际文件）
2. 旧目录（`~/.cc-contron`、`~/.sga` 及历史迁移记录中的目录）存在且有内容

> **注意**：`~/.claude` 目录（Claude Code 的文件）不会被迁移，框架会保持与 Claude Code 的兼容读取，但不会合并其文件到 SGA_HOME。

**迁移行为**：
- 递归复制所有文件和子目录（合并模式，不会覆盖已有文件）
- 保留原始文件结构
- 支持相对路径（如 `SGA_HOME=./data/.sga`，会相对于工作目录解析）
- 迁移完成后，旧目录数据默认保留（可通过 `SGA_MIGRATION_CLEANUP=true` 删除）
- **记录迁移历史**，支持多次迁移

**迁移历史**：
框架会记录每次迁移的详细信息，存储在 `~/.sga_template/.migration_history.json`：

```json
{
  "migrations": [
    {
      "from": "/home/user/.claude",
      "to": "/home/user/.sga",
      "timestamp": "2025-04-30T10:00:00.000Z",
      "itemCount": 42
    },
    {
      "from": "/home/user/.sga",
      "to": "/data/sga",
      "timestamp": "2025-05-01T08:30:00.000Z",
      "itemCount": 58
    }
  ]
}
```

**支持的迁移场景**：
- 从 `~/.claude` → `~/.sga`
- 从 `~/.sga` → `/custom/path`
- 从 `/custom/path` → `/another/path`（支持多次迁移）
- **取消配置后迁回**：删除 `SGA_HOME` 配置 → 自动从之前的自定义路径迁回 `~/.sga`

**迁移后清理**：
默认情况下，迁移完成后旧目录会保留作为备份。如需在迁移后自动删除旧目录，可设置环境变量：

```bash
# .env 文件
SGA_MIGRATION_CLEANUP=true
```

⚠️ **警告**：启用清理后，旧目录将被永久删除，请确保迁移成功后再启用此选项。

**API 接口**：
```typescript
import { migrateIfNeeded, getMigrationHistory, getCurrentDataLocation } from 'SGA-Template'

// 执行迁移（如果满足条件）
migrateIfNeeded()

// 获取迁移历史
const history = getMigrationHistory()
console.log(`Total migrations: ${history.migrations.length}`)
history.migrations.forEach(m => {
  console.log(`${m.timestamp}: ${m.from} → ${m.to} (${m.itemCount} items)`)
})

// 获取当前数据所在位置（根据迁移历史）
const currentLocation = getCurrentDataLocation()
console.log(`Data is currently at: ${currentLocation}`)
```

**服务器自动迁移**：
框架服务器在启动时会自动调用 `migrateIfNeeded()`，无需手动处理。

## MEMORY.md 索引

每个记忆目录下自动维护一个 `MEMORY.md` 索引文件，包含所有记忆的概览：

```markdown
# Memory Index

Last updated: 2025-04-30T10:00:00.000Z

Total memories: 3

- [project] 项目编码规范 (`/path/to/memory/coding-standards.md`)
- [user] 用户偏好 TypeScript (`/path/to/memory/user-prefs.md`)
- [feedback] 不要自动提交代码 (`/path/to/memory/no-auto-commit.md`)
```

索引文件有大小限制（最大 200 行 / 25KB），超出部分会被截断。

## MemoryManager

`MemoryManager` 是记忆系统的核心管理器，负责初始化、缓存、检索和持久化。

### 初始化

```typescript
import { initMemoryManager, getMemoryManager } from 'SGA-Template'

// 在服务器启动时初始化
const manager = await initMemoryManager({
  pathConfig: {
    projectRoot: process.cwd(),
  },
  maxRelevant: 5,
  freshnessThresholdDays: 1,
})

// 设置 LLM Provider 用于智能检索
manager.setProvider(llmProvider, 'haiku')
```

### 核心 API

| 方法 | 说明 |
|------|------|
| `buildSystemPromptSection()` | 构建注入系统提示词的记忆指令（含 MEMORY.md 索引） |
| `getMemoryContextForQuery(query)` | 根据查询检索相关记忆，返回格式化的上下文文本 |
| `findRelevant(query, alreadySurfaced?)` | 检索相关记忆，返回 `MemoryRetrievalResult` |
| `saveMemoryFile(filename, type, description, content)` | 保存记忆文件并更新索引 |
| `updateEntrypoint()` | 更新 MEMORY.md 索引文件 |
| `buildExtractionPrompt(summary)` | 构建记忆提取提示词 |
| `setProvider(provider, model?)` | 设置 LLM Provider 用于智能检索 |

### 缓存机制

- 记忆文件扫描结果缓存在内存中
- 缓存有效期 30 秒，过期后自动重新扫描
- 保存新记忆后立即刷新缓存

## 智能检索

### 双重检索策略

1. **LLM 智能选择**（需要 Provider）— 将候选记忆列表发送给 LLM，由 LLM 选择最相关的条目
2. **关键词匹配**（兜底方案）— 基于查询词在描述和内容中的匹配度评分

### 关键词评分规则

| 匹配位置 | 加分 |
|----------|------|
| 描述中包含查询词 | +3 |
| 内容中包含查询词 | +1 |
| 描述与查询整体匹配 | +5 |
| 1天内更新 | +2 |
| 7天内更新 | +1 |

### 新鲜度警告

记忆超过 `freshnessThresholdDays`（默认 1 天）后，检索结果会附带陈旧警告：

> ⚠️ This memory is X days old. Verify against current code before asserting as fact.

### 配置检索

```typescript
import { setRetrievalProvider } from 'SGA-Template'

// 设置检索用的 LLM Provider
setRetrievalProvider(provider, 'haiku')

// 自定义检索配置
const result = await manager.findRelevant(query, alreadySurfaced, {
  maxRelevant: 5,
  freshnessThresholdDays: 1,
  useSemanticSearch: true,
})
```

## 自动记忆提取

`MemoryExtractor` 在 Agent 完成对话后后台提取新记忆，不阻塞响应返回。

### 提取流程

![自动记忆提取流程](diagrams/memory-extraction.svg)

### 提取配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用自动提取 |
| `maxTurnsBetweenExtractions` | `3` | 每隔多少轮对话触发一次提取 |
| `maxConversationChars` | `20000` | 对话摘要最大字符数 |

### 使用方式

```typescript
import { MemoryExtractor } from 'SGA-Template'

const extractor = new MemoryExtractor(memoryManager, {
  enabled: true,
  maxTurnsBetweenExtractions: 3,
  maxConversationChars: 20000,
})

extractor.setProvider(provider, 'haiku')

if (extractor.shouldExtract(messageCount)) {
  await extractor.extractMemories(messages)
}
```

### 防重入机制

- `extracting` 标志防止并发提取
- `lastExtractMessageCount` 跟踪上次提取时的消息数
- 提取失败不影响主流程

## 低级 API

### 扫描记忆文件

```typescript
import { scanMemoryFiles } from 'SGA-Template'

const memories = await scanMemoryFiles('/path/to/memory')
// memories: MemoryFile[] — 按 mtimeMs 降序排列，最多 200 个
```

### 检索相关记忆

```typescript
import { findRelevantMemories } from 'SGA-Template'

const { memories, freshnessWarnings } = await findRelevantMemories(
  '用户偏好 TypeScript',
  allMemories,
  alreadySurfaced,
  { maxRelevant: 5, freshnessThresholdDays: 1, useSemanticSearch: true },
)
```

### 构建记忆提示词

```typescript
import { buildMemoryPrompt } from 'SGA-Template'

const memoryPrompt = buildMemoryPrompt(memoryDir, entrypointContent)
```

## 存储后端详解

### 架构设计

存储后端通过 `MemoryStorageBackend` 接口实现抽象，`MemoryManager` 通过该接口与底层存储交互，无需关心具体实现：

```
MemoryManager
    │
    ├── MemoryStorageBackend (接口)
    │       │
    │       ├── FileSystemBackend  ← 默认
    │       ├── VectorBackend
    │       ├── SQLBackend
    │       ├── MongoDBBackend
    │       └── CustomBackend (用户自定义)
    │
    └── StorageRegistry (后端注册/工厂)
```

### MemoryStorageBackend 接口

所有存储后端必须实现以下接口：

```typescript
interface MemoryStorageBackend {
  readonly type: StorageBackendType

  initialize(): Promise<void>
  close(): Promise<void>
  list(options?: StorageQueryOptions): Promise<MemoryFile[]>
  get(id: string): Promise<MemoryFile | null>
  save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile>
  update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null>
  delete(id: string): Promise<boolean>
  search(options: StorageSearchOptions): Promise<StorageSearchResult[]>
  getStats(): Promise<StorageStats>
  exists(id: string): Promise<boolean>
  count(options?: StorageQueryOptions): Promise<number>
  clear(): Promise<void>
}
```

### 配置存储后端

通过 `MemoryManagerConfig` 配置存储后端：

```typescript
import { initMemoryManager } from 'SGA-Template'

// 方式 1：使用配置对象（通过注册表自动创建后端）
const manager = await initMemoryManager({
  storage: {
    type: 'sql',
    connectionString: 'postgresql://user:pass@localhost:5432/memories',
    tableName: 'agent_memories',
    dialect: 'postgres',
  },
})

// 方式 2：直接传入后端实例
import { MongoDBBackend } from 'SGA-Template'
const backend = new MongoDBBackend({
  type: 'mongodb',
  connectionString: 'mongodb://localhost:27017',
  databaseName: 'sga',
  collectionName: 'memories',
})
const manager = await initMemoryManager({ backend })

// 方式 3：默认文件系统（无需配置）
const manager = await initMemoryManager()
```

### FileSystemBackend（默认）

基于本地文件系统的存储后端，将记忆保存为 Markdown 文件：

```typescript
import { FileSystemBackend } from 'SGA-Template'

const backend = new FileSystemBackend({
  type: 'filesystem',
  memoryDir: '/path/to/memory',
  scanIntervalMs: 30_000,  // 缓存刷新间隔
})
```

特性：
- 记忆文件为 Markdown + YAML frontmatter 格式
- 自动维护 MEMORY.md 索引文件
- 支持缓存刷新机制
- 与 Claude Code 记忆文件兼容

### VectorBackend

向量数据库存储后端，支持语义搜索：

```typescript
import { VectorBackend } from 'SGA-Template'

const backend = new VectorBackend({
  type: 'vector',
  connectionString: 'http://localhost:6333',  // 如 Qdrant/Pinecone
  collectionName: 'memories',
  embeddingDimension: 1536,
  embeddingModel: 'text-embedding-3-small',
  apiKey: 'your-api-key',
})

// 设置嵌入函数（用于将文本转为向量）
backend.setEmbeddingFunction(async (text: string) => {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return response.data[0].embedding
})
```

特性：
- 支持语义搜索（余弦相似度）
- 支持关键词搜索（降级方案）
- 可自定义嵌入函数
- 无嵌入函数时自动降级为关键词搜索

### SQLBackend

关系数据库存储后端，支持 PostgreSQL、MySQL、SQLite：

```typescript
import { SQLBackend } from 'SGA-Template'

const backend = new SQLBackend({
  type: 'sql',
  connectionString: 'postgresql://user:pass@localhost:5432/sga',
  tableName: 'memories',
  dialect: 'postgres',  // 'postgres' | 'mysql' | 'sqlite'
})

// 设置查询和执行函数（对接实际数据库驱动）
backend.setQueryFunction(async (sql: string, params?: unknown[]) => {
  const result = await pool.query(sql, params)
  return result.rows
})

backend.setExecuteFunction(async (sql: string, params?: unknown[]) => {
  await pool.execute(sql, params)
})
```

特性：
- 支持 PostgreSQL 全文搜索（`to_tsvector`/`to_tsquery`）
- 支持 MySQL 全文搜索（`MATCH ... AGAINST`）
- 支持 SQLite 基础 LIKE 搜索
- 自动建表（设置 `executeFn` 后）
- UPSERT 语义（插入或更新）
- 无数据库连接时使用内存 Map 作为降级

### MongoDBBackend

MongoDB 文档数据库存储后端：

```typescript
import { MongoDBBackend } from 'SGA-Template'

const backend = new MongoDBBackend({
  type: 'mongodb',
  connectionString: 'mongodb://localhost:27017',
  databaseName: 'sga',
  collectionName: 'memories',
})

// 设置集合实例（对接实际 MongoDB 驱动）
import { MongoClient } from 'mongodb'
const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('sga')
const collection = db.collection('memories')

backend.setCollection(collection)
```

特性：
- 支持 MongoDB 全文搜索（`$text` + `$search`）
- 使用 `$set` 操作符实现部分更新
- 支持标签过滤（`$in` 操作符）
- 全文搜索失败时自动降级为关键词搜索
- 无集合实例时使用内存 Map 作为降级

### 自定义存储后端

用户可以实现 `MemoryStorageBackend` 接口创建自定义后端：

```typescript
import type { MemoryStorageBackend, StorageBackendType } from 'SGA-Template'

class RedisBackend implements MemoryStorageBackend {
  readonly type: StorageBackendType = 'custom'

  // 实现所有接口方法...
  async initialize(): Promise<void> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
  async list(options?) { /* ... */ }
  async get(id) { /* ... */ }
  async save(memory) { /* ... */ }
  async update(id, updates) { /* ... */ }
  async delete(id) { /* ... */ }
  async search(options) { /* ... */ }
  async getStats() { /* ... */ }
  async exists(id) { /* ... */ }
  async count(options?) { /* ... */ }
  async clear() { /* ... */ }
}
```

### 注册自定义后端

通过 `registerBackend` 将自定义后端注册到工厂：

```typescript
import { registerBackend, initMemoryManager } from 'SGA-Template'
import type { StorageBackendConfig, MemoryStorageBackend } from 'SGA-Template'

registerBackend('redis', (config: StorageBackendConfig) => {
  return new RedisBackend(config as RedisBackendConfig)
})

// 然后就可以通过配置使用
const manager = await initMemoryManager({
  storage: {
    type: 'redis',
    host: 'localhost',
    port: 6379,
  },
})
```

### 查询选项

所有后端共享统一的查询接口：

```typescript
interface StorageQueryOptions {
  limit?: number       // 返回数量限制
  offset?: number      // 偏移量（分页）
  types?: MemoryType[] // 按类型过滤
  tags?: string[]      // 按标签过滤
  since?: number       // 起始时间戳（ms）
  until?: number       // 截止时间戳（ms）
}

interface StorageSearchOptions {
  query: string        // 搜索查询
  limit?: number       // 返回数量限制
  threshold?: number   // 最低相似度阈值（0-1）
  useSemantic?: boolean // 是否使用语义搜索
}
```

### 存储统计

```typescript
const stats = await manager.getBackend().getStats()
// {
//   totalMemories: 42,
//   totalSizeBytes: 128000,
//   byType: { project: 20, user: 15, feedback: 5, reference: 2 },
//   oldestAt: 1714454400000,
//   newestAt: 1714540800000,
// }
```

## 完整工作流

```typescript
import { initMemoryManager, MemoryExtractor } from 'SGA-Template'

// 1. 初始化记忆管理器
const manager = await initMemoryManager({
  pathConfig: { projectRoot: process.cwd() },
})
manager.setProvider(llmProvider, 'haiku')

// 2. 在 Agent 运行时，记忆自动注入系统提示词
//    （runner.ts 中自动调用 buildSystemPromptSection + getMemoryContextForQuery）

// 3. 对话结束后，后台提取新记忆
const extractor = new MemoryExtractor(manager)
extractor.setProvider(llmProvider, 'haiku')
if (extractor.shouldExtract(messages.length)) {
  extractor.extractMemories(messages).catch(console.error)
}
```

## 与 cc-haha-main 的差异

| 功能 | cc-haha-main | sga_template | 状态 |
|------|-------------|-------------|------|
| 路径解析 | 三级优先级 + settings.json | 基础路径计算 + 安全校验 | ✅ |
| 记忆扫描 | 递归扫描 + readHeadAndTail 优化 | 递归扫描 + frontmatter 解析 | ✅ |
| 智能检索 | Sonnet 模型选择 | LLM 选择 + 关键词兜底 | ✅ |
| 提示词注入 | loadMemoryPrompt() | buildSystemPromptSection() | ✅ |
| 自动提取 | 分叉代理 + 互斥 + 合并 | 后台 LLM 提取 + 防重入 | ✅ |
| MEMORY.md 索引 | 始终加载到上下文 | 自动维护 + 注入提示词 | ✅ |
| 新鲜度管理 | 独立模块 | 集成在检索中 | ✅ |
| AutoDream | 五重门控 + 四阶段整合 | ❌ 暂无 | 🔜 |
| SessionMemory | 当前会话 markdown 笔记 | ❌ 暂无 | 🔜 |
| 代理记忆 | 三级作用域 user/project/local | ❌ 暂无 | 🔜 |
| 团队同步 | Pull/Push API + delta 上传 | ❌ 暂无 | 🔜 |
| 存储后端抽象 | 仅文件系统 | 文件系统/向量/SQL/MongoDB/自定义 | ✅ |
| 数据库语义搜索 | ❌ | 向量余弦相似度/全文搜索 | ✅ |

## 相关文档

- [自定义系统提示词](custom-prompt.md)
- [技能系统](skills.md)
- [上下文压缩](context-compression.md)
- [项目架构](architecture.md)
