# 记忆系统

> 📄 相关源文件：`src/memory/manager.ts`（核心管理器）、`src/memory/extractor.ts`（自动提取）、`src/memory/retrieval.ts`（智能检索）、`src/memory/scanner.ts`（扫描）、`src/memory/prompt.ts`（提示词构建）、`src/memory/paths.ts`（路径管理）、`src/memory/types.ts`（类型定义）、`src/memory/storage/`（存储后端抽象层）、`src/memory/context-budget.ts`（上下文预算管理）、`src/memory/working-set.ts`（工作集/锚点）、`src/memory/dedup.ts`（记忆去重与压缩）、`src/memory/context-builder.ts`（上下文构建器）

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

| 类型 | 标签 | 说明 | 默认作用域 |
|------|------|------|-----------|
| `user` | User | 用户偏好、模式和个人上下文 | `global` |
| `feedback` | Feedback | 行为反馈和纠正模式 | `project` |
| `project` | Project | 项目特定知识和动态 | `project` |
| `reference` | Reference | 外部引用和文档指针 | `project` |
| `session` | Session | 会话特定临时上下文和工作笔记 | `session` |

## 记忆作用域（Memory Scope）

记忆系统支持三级作用域，实现会话级隔离：

### 作用域层级

| 作用域 | 说明 | 可见性 |
|--------|------|--------|
| `global` | 全局记忆 | 跨项目共享，所有项目、所有会话可见 |
| `project` | 项目记忆 | 同一项目内所有会话共享 |
| `session` | 会话记忆 | 仅当前会话可见，会话结束后可清理 |

### 作用域继承规则

查询记忆时，低层级自动继承高层级：

- **查询 `global` 作用域** → 只返回 `global` 记忆
- **查询 `project` 作用域** → 返回 `global` + `project` 记忆
- **查询 `session` 作用域** → 返回 `global` + `project` + 当前 `session` 记忆

### Session ID

每个 `MemoryManager` 实例自动生成唯一的 Session ID（格式：`sess_{timestamp}_{random}`），用于标识和隔离会话级记忆：

```typescript
const sessionId = manager.getSessionId()  // 'sess_m5abc3_x9k2f'

// 也可手动设置（如恢复会话时）
manager.setSessionId('sess_m5abc3_x9k2f')
```

### 作用域自动推断

保存记忆时，系统根据记忆类型自动推断作用域：

- `user` 类型 → `global`
- `feedback` / `project` / `reference` 类型 → `project`
- `session` 类型 → `session`

也可在保存时显式指定：

```typescript
await manager.saveMemoryFile(
  'temp-notes.md',
  'session',
  '临时调试笔记',
  '当前正在调试用户认证模块...',
  'session',  // 显式指定作用域
)
```

### 会话记忆清理

会话结束后，可清理该会话的临时记忆：

```typescript
const deleted = await manager.deleteSessionMemories()
console.log(`Cleaned up ${deleted} session memories`)
```

### 按作用域查询

```typescript
// 查询各作用域记忆
const globalMemories = await manager.listGlobalMemories()
const projectMemories = await manager.listProjectMemories()
const sessionMemories = await manager.listSessionMemories()

// 通用查询
const memories = await manager.listMemoriesByScope('project', {
  types: ['project', 'reference'],
  limit: 10,
})
```

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
| `type` | `string` | 记忆类型：`user` / `feedback` / `project` / `reference` / `session` |
| `description` | `string` | 记忆描述（用于检索和索引） |
| `scope` | `string` | 作用域：`global` / `project` / `session`（默认按类型推断） |
| `sessionId` | `string` | 会话 ID（仅 `session` 作用域时设置） |
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
| `saveMemoryFile(filename, type, description, content, scope?)` | 保存记忆文件并更新索引，可选指定作用域 |
| `updateEntrypoint()` | 更新 MEMORY.md 索引文件 |
| `buildExtractionPrompt(summary)` | 构建记忆提取提示词 |
| `setProvider(provider, model?)` | 设置 LLM Provider 用于智能检索 |
| `getSessionId()` | 获取当前会话 ID |
| `setSessionId(sessionId)` | 设置会话 ID（用于恢复会话） |
| `listGlobalMemories(options?)` | 列出全局作用域记忆 |
| `listProjectMemories(options?)` | 列出项目作用域记忆 |
| `listSessionMemories(options?)` | 列出当前会话记忆 |
| `listMemoriesByScope(scope, options?)` | 按作用域列出记忆 |
| `deleteSessionMemories()` | 清理当前会话的临时记忆 |
| `inferScope(type)` | 根据记忆类型推断默认作用域 |

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
  scope?: MemoryScope  // 按作用域过滤（global/project/session）
  sessionId?: string   // 按会话 ID 过滤（配合 scope='session' 使用）
}

interface StorageSearchOptions {
  query: string        // 搜索查询
  limit?: number       // 返回数量限制
  threshold?: number   // 最低相似度阈值（0-1）
  useSemantic?: boolean // 是否使用语义搜索
  scope?: MemoryScope  // 按作用域过滤
  sessionId?: string   // 按会话 ID 过滤
}
```

### 存储统计

```typescript
const stats = await manager.getBackend().getStats()
// {
//   totalMemories: 42,
//   totalSizeBytes: 128000,
//   byType: { project: 20, user: 15, feedback: 5, reference: 2 },
//   byScope: { global: 15, project: 20, session: 7 },
//   oldestAt: 1714454400000,
//   newestAt: 1714540800000,
// }
```

## 完整工作流

```typescript
import { initMemoryManager, MemoryExtractor, initWorkingSet, buildContext } from 'SGA-Template'

// 1. 初始化记忆管理器和工作集
const manager = await initMemoryManager({
  pathConfig: { projectRoot: process.cwd() },
})
manager.setProvider(llmProvider, 'haiku')

const workingSet = initWorkingSet()

// 2. 在 Agent 运行时，使用上下文构建器智能注入记忆
//    （runner.ts 中自动调用 buildContext）
const contextResult = await buildContext(manager, workingSet, {
  userQuery: '分析这个工作流 JSON',
})

// 3. 对话结束后，后台提取新记忆（自动去重）
const extractor = new MemoryExtractor(manager)
extractor.setProvider(llmProvider, 'haiku')
if (extractor.shouldExtract(messages.length)) {
  extractor.extractMemories(messages).catch(console.error)
}
```

## 上下文预算管理

### 问题背景

当用户在对话中持续操作某个大对象（如工作流 JSON、大型代码文件）时，该内容可能被反复提取到记忆中，导致：

1. **记忆重复** — 同一内容多次存储，浪费空间
2. **上下文溢出** — 长期运行后记忆越积越多，超出上下文窗口
3. **无法切换** — 用户话题转变后，旧的大对象仍占据上下文空间

### 解决方案架构

```
用户消息
  │
  ├── 工作集 (WorkingSet) ─── 自动检测并锚定大对象
  │     ├── Active Anchors ── 当前聚焦的内容（高优先级）
  │     ├── Fading Anchors ── 超时未访问的内容（摘要替换）
  │     └── Expired Anchors ── 完全过期的内容（自动清除）
  │
  ├── 记忆去重 (Dedup) ──── 防止重复内容写入记忆
  │     ├── 内容哈希匹配
  │     ├── 描述完全匹配
  │     └── 内容前缀匹配
  │
  ├── 注意力聚焦 (Focus) ── 根据查询模式调整上下文分配
  │     ├── deep_focus ──── 工作集 30%，记忆 15%
  │     ├── balanced ────── 工作集 15%，记忆 25%
  │     └── exploratory ─── 工作集 10%，记忆 35%
  │
  └── 上下文预算 (Budget) ── Token 预算分配与溢出控制
        ├── 系统指令预留
        ├── 对话历史预留
        ├── 工具输出预留
        └── 记忆/工作集共享预算
```

### 工作集（WorkingSet）

工作集管理当前对话中需要持续关注的"锚点"内容，解决大对象反复出现的问题：

#### 锚点生命周期

| 状态 | 说明 | 上下文中的表现 |
|------|------|---------------|
| `active` | 最近被访问（默认 5 分钟内） | 完整内容注入上下文 |
| `fading` | 超时未访问（5-15 分钟） | 替换为摘要 + 引用 |
| `expired` | 长时间未访问（>15 分钟） | 自动从工作集移除 |

#### 自动检测锚点

系统会自动从用户消息中检测可锚定的大对象：

- **JSON 块** — 超过 500 tokens 的 JSON 内容（自动识别工作流、API Spec 等）
- **代码块** — 超过 800 tokens 的代码片段
- **数据表格** — 超过 500 tokens 的 Markdown 表格

```typescript
import { WorkingSet, initWorkingSet } from 'SGA-Template'

const ws = initWorkingSet()

// 手动锚定内容
ws.pin('workflow-1', '工作流定义', workflowJson, 'user-message', 'high')

// 自动从消息中检测并锚定
ws.detectAndPinFromContent(userMessage, 'user-message')

// 标记仍在使用（延长生命周期）
ws.touch('workflow-1')

// 手动取消锚定
ws.unpin('workflow-1')
```

#### 锚点淡出与摘要

当锚点进入 `fading` 状态时，系统会自动生成摘要替代完整内容：

```
## 📌 工作流定义
[Summary of "工作流定义"]
这是一个包含 12 个节点和 8 条边的自动化工作流，主要处理用户注册流程...

[Full content available but faded from focus. Reference: user-message]
```

### 记忆去重

在记忆提取时自动检测并跳过重复内容：

| 去重策略 | 说明 |
|----------|------|
| 内容哈希匹配 | 完全相同的内容（hash 一致） |
| 描述完全匹配 | description 字段完全相同 |
| 内容前缀匹配 | 前 200 字符完全相同 |
| 标签 Jaccard 相似度 | 标签重叠度 > 80% 且描述部分匹配 |

```typescript
import { shouldDedupBeforeSave, findDuplicates } from 'SGA-Template'

// 保存前检查是否重复
const check = shouldDedupBeforeSave(
  { type: 'project', description: '工作流结构', content: '...' },
  existingMemories,
)
if (check.isDuplicate) {
  console.log(`Duplicate: ${check.reason}, existing: ${check.existingPath}`)
}

// 批量查找重复
const result = findDuplicates(allMemories)
for (const dup of result.duplicates) {
  console.log(`Keep: ${dup.kept}, Remove: ${dup.removed.join(', ')}, Reason: ${dup.reason}`)
}
```

### 注意力聚焦模式

系统根据用户查询自动检测当前对话的注意力模式，动态调整上下文预算分配：

| 模式 | 触发条件 | 工作集预算 | 记忆预算 | 记忆条目上限 |
|------|----------|-----------|---------|------------|
| `deep_focus` | 分析/调试/修复特定对象 | 30% | 15% | 3 条 |
| `balanced` | 一般性问答 | 15% | 25% | 5 条 |
| `exploratory` | 列举/比较/概述 | 10% | 35% | 8 条 |

**检测关键词**：
- `deep_focus`：analyze this, debug this, fix this, 分析这个, 调试这个...
- `exploratory`：what are, list all, compare, 哪些, 列出, 比较...

### 上下文预算分配

```typescript
import { ContextBudgetConfig, computeBudgetAllocation } from 'SGA-Template'

const config: ContextBudgetConfig = {
  maxContextTokens: 200_000,    // 总上下文窗口
  reservedForSystem: 4_000,     // 系统指令预留
  reservedForConversation: 50_000, // 对话历史预留
  reservedForTools: 10_000,     // 工具输出预留
  memoryBudgetRatio: 0.25,      // 记忆占比
  workingSetBudgetRatio: 0.15,  // 工作集占比
  compressionThreshold: 0.85,   // 压缩触发阈值
}

const allocation = computeBudgetAllocation(config)
// {
//   total: 200_000,
//   systemInstruction: 4_000,
//   workingSet: 20_250,     // (200K - 64K) * 0.15
//   memory: 33_750,         // (200K - 64K) * 0.25
//   conversation: 50_000,
//   tools: 10_000,
// }
```

### 上下文构建流程

1. **检测焦点模式** — 根据当前查询和最近消息判断 deep_focus / balanced / exploratory
2. **更新工作集** — 淡出过期锚点，检测新锚点
3. **收集记忆** — 按作用域分层收集，限制条目数
4. **去重过滤** — 移除重复记忆条目
5. **预算分配** — 根据焦点模式分配 token 预算
6. **优先级排序** — critical > high > medium > low
7. **预算裁剪** — 超出预算的低优先级条目被驱逐
8. **压缩降级** — 仍超预算时压缩可压缩条目
9. **构建输出** — 生成最终的系统提示词

### 上下文切换

当用户突然转换话题时，系统自动处理：

1. **旧锚点自然淡出** — 5 分钟未访问进入 fading，15 分钟后过期
2. **焦点模式自动切换** — 新查询触发不同的焦点模式
3. **预算重新分配** — 旧工作集内容被降级，新话题的记忆获得更多预算
4. **手动清理** — 可随时清除工作集

```typescript
import { getWorkingSet } from 'SGA-Template'

// 手动清除所有锚定内容（强制上下文切换）
const ws = getWorkingSet()
ws?.clear()

// 手动取消特定锚点
ws?.unpin('old-workflow-id')
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
| AutoDream | 五重门控 + 四阶段整合 | 三重门控 + LLM 整合 + 环境变量配置 | ✅ |
| SessionMemory | 当前会话 markdown 笔记 | 三级作用域隔离 + 自动推断 | ✅ |
| 代理记忆 | 三级作用域 user/project/local | global/project/session 作用域 | ✅ |
| 团队同步 | Pull/Push API + delta 上传 | 自动同步 + 冲突解决 + 环境变量配置 | ✅ |
| 存储后端抽象 | 仅文件系统 | 文件系统/向量/SQL/MongoDB/自定义 | ✅ |
| 数据库语义搜索 | ❌ | 向量余弦相似度/全文搜索 | ✅ |
| 会话隔离 | ❌ | Session ID + 作用域过滤 | ✅ |
| 作用域自动推断 | ❌ | 基于类型 + 内容关键词推断 | ✅ |
| 上下文预算管理 | ❌ | Token 预算分配 + 溢出控制 | ✅ |
| 工作集/锚点 | ❌ | 自动检测大对象 + 淡出/摘要 | ✅ |
| 记忆去重 | ❌ | 哈希/描述/前缀/Jaccard 去重 | ✅ |
| 注意力聚焦 | ❌ | deep_focus/balanced/exploratory | ✅ |
| 上下文切换 | ❌ | 锚点淡出 + 焦点模式切换 | ✅ |

## 记忆整合（AutoDream）

> 📄 相关源文件：`src/memory/consolidation/auto-dream.ts`（整合调度）、`src/memory/consolidation/consolidation-lock.ts`（分布式锁）、`src/memory/consolidation/consolidation-prompt.ts`（整合提示词）

记忆整合在后台自动将碎片化的会话记忆合并为结构化长期记忆，避免记忆膨胀和冗余。

### 三重门控

整合操作需要同时满足三个条件才会触发：

1. **时间门控** — 距上次整合至少 `SGA_CONSOLIDATION_MIN_HOURS` 小时（默认 24 小时）
2. **会话门控** — 至少有 `SGA_CONSOLIDATION_MIN_SESSIONS` 个新会话（默认 5 个）
3. **锁门控** — 成功获取整合锁（防止并发整合）

### 整合流程

```
shouldConsolidate()
    │
    ├── 1. 检查是否启用
    ├── 2. 检查时间门控
    ├── 3. 检查扫描间隔节流
    ├── 4. 扫描新会话
    ├── 5. 检查会话门控
    └── 6. 获取整合锁
            │
            ▼
executeAutoDream()
    │
    ├── 1. 读取所有记忆
    ├── 2. 构建整合提示词
    ├── 3. 调用 LLM 生成整合摘要
    ├── 4. 写入整合后的记忆
    ├── 5. 记录整合完成
    └── 6. 释放整合锁
```

### 分布式锁

整合锁使用文件系统实现，支持：
- **互斥访问** — 同一时刻只有一个整合操作运行
- **过期检测** — 锁持有超过 `SGA_CONSOLIDATION_LOCK_STALE_MS`（默认 1 小时）自动释放
- **进程检测** — 检查锁持有者进程是否存活

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_CONSOLIDATION_ENABLED` | `true` | 是否启用记忆整合 |
| `SGA_CONSOLIDATION_MIN_HOURS` | `24` | 距上次整合至少多少小时 |
| `SGA_CONSOLIDATION_MIN_SESSIONS` | `5` | 至少有多少新会话才触发 |
| `SGA_CONSOLIDATION_MAX_OUTPUT_TOKENS` | `16000` | 整合 LLM 最大输出 token 数 |
| `SGA_CONSOLIDATION_MODEL` | `haiku` | 整合使用的模型 |
| `SGA_CONSOLIDATION_LOCK_STALE_MS` | `3600000` | 整合锁过期时间（毫秒） |
| `SGA_CONSOLIDATION_SCAN_INTERVAL_MS` | `600000` | 整合扫描间隔（毫秒） |

### API

```typescript
import { shouldConsolidate, executeAutoDream, getAutoDreamConfig } from 'SGA-Template'

if (await shouldConsolidate(memoryManager)) {
  const result = await executeAutoDream(memoryManager, provider, 'haiku')
  console.log(result.consolidated)       // true
  console.log(result.hoursSinceLast)     // 48
  console.log(result.sessionsReviewed)   // 12
  console.log(result.summary)            // '整合了用户偏好和项目知识...'
}
```

## 团队记忆同步

> 📄 相关源文件：`src/memory/team-memory-sync.ts`

多 Agent 之间的记忆自动同步与冲突解决，确保团队成员共享关键知识。

### 同步机制

```
Agent A 写入记忆
    │
    ▼
TeamMemorySync 检测变更
    │
    ├── Pull：从共享存储拉取其他 Agent 的记忆
    ├── Push：将本地新记忆推送到共享存储
    └── 冲突解决：根据策略处理同步冲突
```

### 冲突解决策略

| 策略 | 说明 |
|------|------|
| `last_write_wins` | 最后写入者胜出（默认） |
| `merge` | 自动合并内容 |
| `manual` | 标记冲突，等待人工处理 |

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_TEAM_SYNC_ENABLED` | `true` | 是否启用团队记忆同步 |
| `SGA_TEAM_SYNC_INTERVAL_MS` | `30000` | 同步间隔（毫秒） |
| `SGA_TEAM_SYNC_MAX_ENTRIES` | `50` | 每次同步最大条目数 |
| `SGA_TEAM_SYNC_CONFLICT_RESOLUTION` | `last_write_wins` | 冲突解决策略 |

## 统一配置模块

> 📄 相关源文件：`src/config.ts`

所有运行时可配置参数统一通过 `src/config.ts` 从环境变量加载，消除硬编码。

### 设计原则

- **环境变量优先** — 所有 `SGA_` 前缀的环境变量从 `.env` 文件或系统环境变量读取
- **代码内 fallback** — `DEFAULT_*` 常量保留作为无 `.env` 时的默认值
- **单例模式** — `getSgaConfig()` 首次调用时加载，后续复用
- **可重置** — `resetSgaConfig()` 用于测试场景

### 配置分类

| 分类 | 环境变量前缀 | 说明 |
|------|-------------|------|
| 微压缩 | `SGA_COMPACT_MICRO_*` | 工具输出清理配置 |
| 会话记忆压缩 | `SGA_COMPACT_SM_*` | 会话记忆摘要配置 |
| 全量压缩 | `SGA_COMPACT_FULL_*` | LLM 摘要生成配置 |
| 压缩通用 | `SGA_MODEL_MAX_TOKENS`, `SGA_COMPACT_PREFER_SESSION_MEMORY` | 模型窗口和策略选择 |
| 记忆整合 | `SGA_CONSOLIDATION_*` | AutoDream 整合配置 |
| 上下文预算 | `SGA_BUDGET_*` | Token 分配和阈值 |
| 工作集 | `SGA_WORKING_SET_*` | 锚点管理配置 |
| 压缩恢复 | `SGA_POST_COMPACT_*` | 状态恢复配置 |
| 熔断器 | `SGA_CB_*` | 故障保护配置 |
| 工具摘要 | `SGA_TOOL_SUMMARY_*` | 工具调用摘要配置 |
| 团队同步 | `SGA_TEAM_SYNC_*` | 多 Agent 同步配置 |

### API

```typescript
import { getSgaConfig, resetSgaConfig } from 'SGA-Template'

// 获取完整配置
const config = getSgaConfig()
console.log(config.budget.maxContextTokens)     // 200000 或 .env 中设置的值
console.log(config.compact.modelMaxTokens)      // 200000 或 .env 中设置的值
console.log(config.consolidation.enabled)        // true 或 .env 中设置的值

// 重置配置（测试用）
resetSgaConfig()
```

## 相关文档

- [自定义系统提示词](custom-prompt.md)
- [技能系统](skills.md)
- [上下文压缩](context-compression.md)
- [环境变量配置](environment-variables.md) — 所有可配置参数的完整列表
- [项目架构](architecture.md)

## 记忆管理 API

记忆系统提供 RESTful API 端点，允许外部系统查询、搜索和管理记忆文件。

### 列出所有记忆

```
GET /api/v1/memories
```

返回所有作用域的记忆文件列表，按 global/project/session 分组统计：

```json
{
  "count": 12,
  "global": 3,
  "project": 7,
  "session": 2,
  "memories": [
    {
      "path": "/path/to/memory.md",
      "type": "preference",
      "scope": "global",
      "description": "User prefers TypeScript",
      "mtimeMs": 1700000000000,
      "sizeBytes": 256
    }
  ]
}
```

### 获取指定记忆详情

```
GET /api/v1/memories/:name
```

返回记忆文件的完整内容（含 frontmatter 和正文）：

```json
{
  "path": "/path/to/user-preferences.md",
  "type": "preference",
  "scope": "global",
  "description": "User prefers TypeScript",
  "content": "---\ntype: preference\nscope: global\n---\n# User Preferences\n...",
  "frontmatter": {
    "type": "preference",
    "scope": "global"
  },
  "mtimeMs": 1700000000000,
  "sizeBytes": 256
}
```

### 语义搜索记忆

```
POST /api/v1/memories/search
```

使用 LLM 智能检索或关键词匹配搜索记忆：

```bash
curl -X POST http://localhost:3000/api/v1/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query": "项目使用的技术栈"}'
```

```json
{
  "query": "项目使用的技术栈",
  "count": 3,
  "memories": [
    {
      "path": "/path/to/tech-stack.md",
      "type": "project",
      "scope": "project",
      "description": "Project tech stack",
      "content": "...",
      "freshnessWarning": null
    }
  ]
}
```

### 删除会话记忆

```
DELETE /api/v1/memories/session
```

清理当前会话的临时记忆文件：

```json
{
  "success": true,
  "deleted": 3,
  "scope": "session"
}
```

### 手动触发记忆提取

```
POST /api/v1/memories/extract
```

手动触发从对话中提取记忆（通常由 Agent Loop 自动触发）：

```bash
curl -X POST http://localhost:3000/api/v1/memories/extract \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sess-xxx"}'
```

```json
{
  "success": true,
  "messageCount": 15
}
```
