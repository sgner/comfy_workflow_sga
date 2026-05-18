import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

export class WebSearchTool extends BaseTool<{ query: string; allowed_domains?: string[]; blocked_domains?: string[] }, string> {
  name = 'WebSearch'
  description = 'Search the web for current information using a search query'
  searchHint = 'search web internet find information online'
  maxResultSizeChars = 100_000
  shouldDefer = true

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const query = (input as { query?: string }).query
    if (!query || typeof query !== 'string') return { success: false, error: 'query is required and must be a string' }
    if (query.length < 2) return { success: false, error: 'query must be at least 2 characters' }
    return { success: true }
  }

  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to use' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include search results from these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include search results from these domains' },
      },
      required: ['query'],
    }
  }

  async call(input: { query: string; allowed_domains?: string[]; blocked_domains?: string[] }, _context: ToolUseContext): Promise<string> {
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search')
    searchUrl.searchParams.set('q', input.query)
    searchUrl.searchParams.set('count', '10')

    const apiKey = process.env.BRAVE_SEARCH_API_KEY ?? process.env.WEB_SEARCH_API_KEY

    if (apiKey) {
      try {
        const response = await fetch(searchUrl.toString(), {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
        })
        if (response.ok) {
          const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
          const results = data.web?.results ?? []
          if (results.length === 0) return `No search results found for: ${input.query}`
          return results.map((r, i) =>
            `[${i + 1}] ${r.title ?? 'No title'}\n    URL: ${r.url ?? ''}\n    ${r.description ?? ''}`
          ).join('\n\n')
        }
      } catch {
        // fall through to alternative
      }
    }

    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`
      const response = await fetch(ddgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CC-Contron/1.0)' },
      })
      if (response.ok) {
        const html = await response.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []
        const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
        let match
        while ((match = resultRegex.exec(html)) !== null && results.length < 10) {
          results.push({
            url: match[1] ?? '',
            title: match[2]?.replace(/<[^>]+>/g, '').trim() ?? '',
            snippet: match[3]?.replace(/<[^>]+>/g, '').trim() ?? '',
          })
        }
        if (results.length === 0) return `No search results found for: ${input.query}`
        return results.map((r, i) =>
          `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
        ).join('\n\n')
      }
    } catch {
      // fall through
    }

    return `Web search for "${input.query}" could not be completed. Configure BRAVE_SEARCH_API_KEY or WEB_SEARCH_API_KEY environment variable for reliable web search, or ensure network access is available.`
  }
}
