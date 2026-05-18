import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

export class LSPTool extends BaseTool<{
  action: 'definitions' | 'references' | 'hover' | 'diagnostics' | 'symbols'
  file_path: string
  line?: number
  column?: number
  query?: string
}, string> {
  name = 'LSP'
  description = 'Access Language Server Protocol features like go-to-definition, find-references, hover info, diagnostics, and symbol search.'
  searchHint = 'lsp language server definition reference hover diagnostic symbol'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const action = (input as { action?: string }).action
    if (!action || !['definitions', 'references', 'hover', 'diagnostics', 'symbols'].includes(action)) {
      return { success: false, error: 'action must be one of: definitions, references, hover, diagnostics, symbols' }
    }
    const filePath = (input as { file_path?: string }).file_path
    if (!filePath || typeof filePath !== 'string') return { success: false, error: 'file_path is required' }
    return { success: true }
  }

  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['definitions', 'references', 'hover', 'diagnostics', 'symbols'], description: 'LSP action to perform' },
        file_path: { type: 'string', description: 'Path to the file' },
        line: { type: 'number', description: 'Line number (1-indexed)' },
        column: { type: 'number', description: 'Column number (1-indexed)' },
        query: { type: 'string', description: 'Search query for symbol search' },
      },
      required: ['action', 'file_path'],
    }
  }

  async call(input: { action: string; file_path: string; line?: number; column?: number; query?: string }, _context: ToolUseContext): Promise<string> {
    const appState = _context.getAppState()
    const lspClient = appState.lspClient as LSPClient | undefined

    if (!lspClient) {
      return `LSP is not configured. To enable LSP features, configure an LSP client in the application state.\n\nAction requested: ${input.action} for ${input.file_path}`
    }

    try {
      switch (input.action) {
        case 'definitions': {
          const result = await lspClient.definitions(input.file_path, input.line ?? 1, input.column ?? 1)
          return formatLocations('Definitions', result)
        }
        case 'references': {
          const result = await lspClient.references(input.file_path, input.line ?? 1, input.column ?? 1)
          return formatLocations('References', result)
        }
        case 'hover': {
          const result = await lspClient.hover(input.file_path, input.line ?? 1, input.column ?? 1)
          return result ?? 'No hover information available'
        }
        case 'diagnostics': {
          const result = await lspClient.diagnostics(input.file_path)
          return formatDiagnostics(result)
        }
        case 'symbols': {
          const result = await lspClient.symbols(input.query ?? '')
          return formatSymbols(result)
        }
        default:
          return `Unknown LSP action: ${input.action}`
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return `LSP error: ${msg}`
    }
  }
}

interface LSPClient {
  definitions(filePath: string, line: number, column: number): Promise<LSPLocation[]>
  references(filePath: string, line: number, column: number): Promise<LSPLocation[]>
  hover(filePath: string, line: number, column: number): Promise<string | null>
  diagnostics(filePath: string): Promise<LSPDiagnostic[]>
  symbols(query: string): Promise<LSPSymbol[]>
}

interface LSPLocation {
  filePath: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  text?: string
}

interface LSPDiagnostic {
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
}

interface LSPSymbol {
  name: string
  kind: string
  filePath: string
  line: number
  column: number
}

function formatLocations(title: string, locations: LSPLocation[]): string {
  if (locations.length === 0) return `No ${title.toLowerCase()} found`
  return `${title}:\n${locations.map(l => `  ${l.filePath}:${l.line}:${l.column}${l.text ? ` - ${l.text}` : ''}`).join('\n')}`
}

function formatDiagnostics(diagnostics: LSPDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics found'
  return `Diagnostics:\n${diagnostics.map(d => `  [${d.severity}] Line ${d.line}: ${d.message}${d.source ? ` (${d.source})` : ''}`).join('\n')}`
}

function formatSymbols(symbols: LSPSymbol[]): string {
  if (symbols.length === 0) return 'No symbols found'
  return `Symbols:\n${symbols.map(s => `  [${s.kind}] ${s.name} at ${s.filePath}:${s.line}`).join('\n')}`
}
