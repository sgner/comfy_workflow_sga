import { BaseTool, type ToolInputSchema, type ValidationResult, type ToolUseContext, type PermissionResult } from '../base.js'

interface GitHubIssue {
  title: string
  url: string
  body: string
  state: string
  comments: number
  created_at: string
  updated_at: string
}

export class GitHubSearchTool extends BaseTool {
  name = 'github_search'
  description = 'Search GitHub for ComfyUI related issues and solutions'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for the issue or error',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
      },
      required: ['query'],
    }
  }

  validateInput(input: unknown): ValidationResult {
    const data = input as Record<string, unknown>
    if (!data.query || typeof data.query !== 'string') {
      return { success: false, error: 'query is required and must be a string' }
    }
    return { success: true }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<string> {
    const query = input.query as string
    const limit = (input.limit as number) ?? 10

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
      }

      const githubToken = process.env.GITHUB_TOKEN
      if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`
      }

      const searchQuery = `${query} comfyui error issue`
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=updated&order=desc`

      const response = await fetch(url, { headers })

      if (!response.ok) {
        return JSON.stringify({ error: `GitHub API returned ${response.status}` })
      }

      const data = await response.json() as { items: Array<Record<string, unknown>> }
      const results: GitHubIssue[] = (data.items ?? []).map(item => ({
        title: String(item.title ?? ''),
        url: String(item.html_url ?? ''),
        body: String(item.body ?? '').slice(0, 500),
        state: String(item.state ?? ''),
        comments: Number(item.comments ?? 0),
        created_at: String(item.created_at ?? ''),
        updated_at: String(item.updated_at ?? ''),
      }))

      return JSON.stringify(results, null, 2)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
