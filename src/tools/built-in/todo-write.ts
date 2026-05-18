import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

const sessionTodos: Map<string, TodoItem[]> = new Map()

export function getSessionTodos(sessionId?: string): TodoItem[] {
  if (sessionId) return sessionTodos.get(sessionId) ?? []
  return []
}

export function setSessionTodos(sessionId: string, todos: TodoItem[]): void {
  sessionTodos.set(sessionId, todos)
}

export class TodoWriteTool extends BaseTool<{ todos: TodoItem[] }, string> {
  name = 'TodoWrite'
  description = 'Update the task list for the current session. Use this to track progress on complex multi-step tasks.'
  searchHint = 'todo task list track progress plan'

  isReadOnly(): boolean {
    return false
  }

  isConcurrencySafe(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const todos = (input as { todos?: unknown[] }).todos
    if (!Array.isArray(todos)) return { success: false, error: 'todos must be an array' }
    for (const todo of todos) {
      if (!todo || typeof todo !== 'object') return { success: false, error: 'Each todo must be an object' }
      const t = todo as Record<string, unknown>
      if (!t.content || typeof t.content !== 'string') return { success: false, error: 'Each todo must have a content string' }
      if (t.status && !['pending', 'in_progress', 'completed'].includes(t.status as string)) {
        return { success: false, error: 'status must be pending, in_progress, or completed' }
      }
      if (t.priority && !['high', 'medium', 'low'].includes(t.priority as string)) {
        return { success: false, error: 'priority must be high, medium, or low' }
      }
    }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for the todo item' },
              content: { type: 'string', description: 'Description of the task' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status of the task' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
            },
            required: ['content', 'status'],
          },
          description: 'The updated todo list',
        },
      },
      required: ['todos'],
    }
  }

  async call(input: { todos: TodoItem[] }, context: ToolUseContext): Promise<string> {
    const sessionId = (context.getAppState().sessionId as string) ?? 'default'
    const todos = input.todos.map((t, i) => ({
      id: t.id ?? `todo-${i + 1}`,
      content: t.content,
      status: t.status ?? 'pending',
      priority: t.priority ?? 'medium',
    }))
    setSessionTodos(sessionId, todos)

    const pending = todos.filter(t => t.status === 'pending')
    const inProgress = todos.filter(t => t.status === 'in_progress')
    const completed = todos.filter(t => t.status === 'completed')

    let result = `Todo list updated (${todos.length} items):\n`
    if (inProgress.length > 0) result += `\nIn Progress:\n${inProgress.map(t => `  ▶ [${t.priority}] ${t.content}`).join('\n')}\n`
    if (pending.length > 0) result += `\nPending:\n${pending.map(t => `  ○ [${t.priority}] ${t.content}`).join('\n')}\n`
    if (completed.length > 0) result += `\nCompleted:\n${completed.map(t => `  ✓ [${t.priority}] ${t.content}`).join('\n')}\n`

    return result
  }
}
