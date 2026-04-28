import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

export class WebFetchTool extends BaseTool<{ url: string; prompt?: string; raw?: boolean }, string> {
  name = 'WebFetch'
  description = 'Fetch content from a URL and optionally extract information using a prompt'
  searchHint = 'fetch url web page content http request'
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
    const url = (input as { url?: string }).url
    if (!url || typeof url !== 'string') return { success: false, error: 'url is required and must be a string' }
    try {
      new URL(url)
    } catch {
      return { success: false, error: 'url must be a valid URL' }
    }
    return { success: true }
  }

  async checkPermissions(input: { url: string }, _context: ToolUseContext): Promise<PermissionResult> {
    const preapprovedHosts = ['github.com', 'npmjs.com', 'docs.python.org', 'developer.mozilla.org', 'stackoverflow.com', 'wikipedia.org']
    try {
      const hostname = new URL(input.url).hostname
      const isPreapproved = preapprovedHosts.some(h => hostname === h || hostname.endsWith('.' + h))
      if (isPreapproved) return { behavior: 'allow' }
      return { behavior: 'ask', message: `Allow fetching content from ${hostname}?` }
    } catch {
      return { behavior: 'deny', message: 'Invalid URL' }
    }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch content from' },
        prompt: { type: 'string', description: 'Optional prompt to apply to the fetched content for extraction' },
        raw: { type: 'boolean', description: 'If true, return raw content without markdown conversion' },
      },
      required: ['url'],
    }
  }

  async call(input: { url: string; prompt?: string; raw?: boolean }, _context: ToolUseContext): Promise<string> {
    try {
      const response = await fetch(input.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CC-Contron/1.0)',
          'Accept': 'text/html,application/json,text/plain,text/markdown,*/*',
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        return `Failed to fetch ${input.url}: HTTP ${response.status} ${response.statusText}`
      }

      const contentType = response.headers.get('content-type') ?? ''
      let content = await response.text()

      if (!input.raw && (contentType.includes('text/html') || input.url.endsWith('.html'))) {
        content = htmlToMarkdown(content)
      }

      const maxLen = 50000
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n\n[Content truncated at 50,000 characters]'
      }

      if (input.prompt) {
        return `Fetched content from ${input.url}:\n\n${content}\n\n---\nApplied prompt: ${input.prompt}`
      }

      return content
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to fetch ${input.url}: ${msg}`
    }
  }
}

function htmlToMarkdown(html: string): string {
  let md = html
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '')
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '')
  md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '')
  md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '')
  md = md.replace(/<header[\s\S]*?<\/header>/gi, '')
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n')
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n')
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n')
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
  md = md.replace(/<br\s*\/?>/gi, '\n')
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n')
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '![$1]')
  md = md.replace(/<[^>]+>/g, '')
  md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  md = md.replace(/\n{3,}/g, '\n\n')
  return md.trim()
}
