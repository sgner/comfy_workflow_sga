import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult, type ToolProgressCallback } from '../base.js'
import type { BashProgressData } from '../../core/types.js'
import { spawn } from 'child_process'

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/, reason: 'Destructive rm command detected' },
  { pattern: /\brm\s+-rf\s+\//, reason: 'Recursive force delete from root' },
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: 'Direct device write detected' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format command detected' },
  { pattern: /\bformat\s+[A-Z]:/i, reason: 'Disk format command detected' },
  { pattern: />\s*\/dev\/(sda|hda|nvme|vd)/, reason: 'Direct write to block device' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: 'Piping remote content to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: 'Piping remote content to shell' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: 'Setting world-writable permissions on root path' },
  { pattern: /\bchown\s+(-R\s+)?\w+\s+\//, reason: 'Changing ownership of root path' },
  { pattern: /\biptables\b/, reason: 'Firewall modification detected' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s/, reason: 'System service modification detected' },
  { pattern: /\bservice\s+\w+\s+stop/, reason: 'System service stop detected' },
  { pattern: /\bkill\s+(-9\s+)?1\b/, reason: 'Killing init process' },
  { pattern: /\bshutdown\b/, reason: 'System shutdown detected' },
  { pattern: /\breboot\b/, reason: 'System reboot detected' },
  { pattern: /\binit\s+[06]/, reason: 'Changing runlevel detected' },
  { pattern: /\bRemove-Item\s+.*-Recurse\s+-Force/, reason: 'PowerShell recursive force delete detected' },
  { pattern: /\bStop-Computer\b/, reason: 'PowerShell stop computer detected' },
  { pattern: /\bRestart-Computer\b/, reason: 'PowerShell restart computer detected' },
  { pattern: /\bSet-ExecutionPolicy\b/, reason: 'PowerShell execution policy change detected' },
  { pattern: /\bnet\s+(user|localgroup)\s+.*\b(add|delete)\b/i, reason: 'Windows user/group modification detected' },
  { pattern: /\breg\s+(add|delete)\s/i, reason: 'Windows registry modification detected' },
  { pattern: /\bdiskpart\b/i, reason: 'Windows disk partition tool detected' },
  { pattern: /\bsfc\s+/i, reason: 'Windows system file checker detected' },
  { pattern: /\bbcdedit\b/i, reason: 'Windows boot configuration edit detected' },
]

const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/etc\/(passwd|shadow|sudoers|ssh\/)/, reason: 'Writing to system authentication files' },
  { pattern: /\/\.git\//, reason: 'Writing to .git directory' },
  { pattern: /\/\.claude\//, reason: 'Writing to .claude directory' },
  { pattern: /\/\.vscode\//, reason: 'Writing to .vscode directory' },
  { pattern: /\/\.(bashrc|zshrc|profile|bash_profile)\b/, reason: 'Writing to shell configuration files' },
  { pattern: /\/\.ssh\//, reason: 'Writing to SSH configuration' },
  { pattern: /\/\.env\b/, reason: 'Writing to environment file' },
  { pattern: /[\/\\]Windows[\/\\]System32[\/\\]config/i, reason: 'Writing to Windows system configuration (SAM/SYSTEM)' },
  { pattern: /[\/\\]NTUSER\.DAT/i, reason: 'Writing to Windows user registry hive' },
  { pattern: /[\/\\]pagefile\.sys/i, reason: 'Writing to Windows page file' },
  { pattern: /[\/\\]hiberfil\.sys/i, reason: 'Writing to Windows hibernation file' },
  { pattern: /[\/\\]ProgramData[\/\\]/i, reason: 'Writing to Windows ProgramData directory' },
  { pattern: /[\/\\]AppData[\/\\]Local[\/\\]GroupPolicy/i, reason: 'Writing to Windows Group Policy' },
  { pattern: /[\/\\]boot\.ini/i, reason: 'Writing to Windows boot configuration' },
]

const READ_COMMAND_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'echo', 'which', 'type',
  'stat', 'wc', 'sort', 'uniq', 'diff', 'git status', 'git log', 'git diff',
  'git branch', 'git show', 'git remote', 'env', 'printenv', 'whoami', 'id',
  'uname', 'hostname', 'date', 'cal', 'df', 'du', 'free', 'top', 'ps', 'netstat',
  'ss', 'lsof', 'tree', 'file', 'less', 'more', 'tee', 'xargs', 'awk', 'sed',
  'cut', 'tr', 'rev', 'basename', 'dirname', 'realpath', 'readlink',
  'Get-Content', 'Get-ChildItem', 'Get-Process', 'Get-Service', 'Get-Location',
  'Select-String', 'Get-Item', 'Get-ItemProperty', 'Get-Date', 'Get-Host',
  'dir', 'type', 'where.exe', 'where', 'whoami.exe', 'hostname.exe',
  'systeminfo', 'tasklist', 'ipconfig', 'netstat.exe', 'ping', 'tracert',
  'doskey', 'fc', 'find', 'findstr',
]

const WRITE_COMMAND_PREFIXES = [
  'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln',
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'go install', 'dotnet',
  'docker', 'kubectl', 'git push', 'git commit', 'git add', 'git merge',
  'git rebase', 'git reset', 'git checkout', 'git stash',
  'Remove-Item', 'Copy-Item', 'Move-Item', 'New-Item', 'Set-Content',
  'Add-Content', 'Set-ItemProperty', 'New-ItemProperty', 'Remove-ItemProperty',
  'del', 'copy', 'move', 'mkdir', 'rmdir', 'ren', 'erase',
  'icacls', 'takeown', 'attrib',
]

export class BashTool extends BaseTool<{ command: string; timeout?: number }, string> {
  name = 'Bash'
  description = 'Execute a bash command and return its output'
  searchHint = 'shell command execute run'

  isReadOnly(input: { command: string }): boolean {
    const trimmed = input.command.trim()
    return READ_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix))
  }

  isConcurrencySafe(input: { command: string }): boolean {
    return this.isReadOnly(input)
  }

  isDestructive(input: { command: string }): boolean {
    const trimmed = input.command.trim()
    if (WRITE_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
      return true
    }
    for (const { pattern } of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) return true
    }
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const cmd = (input as { command?: string }).command
    if (!cmd || typeof cmd !== 'string') return { success: false, error: 'command is required and must be a string' }
    return { success: true }
  }

  async checkPermissions(input: { command: string }, context: ToolUseContext): Promise<PermissionResult> {
    const command = input.command.trim()

    if (!command) {
      return { behavior: 'allow', decisionReason: 'Empty command' }
    }

    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { behavior: 'deny', message: reason, decisionReason: 'dangerous_command' }
      }
    }

    if (this.writesToSensitivePath(command)) {
      return {
        behavior: 'ask',
        message: `Command may modify sensitive files or directories. Please confirm: ${command}`,
        suggestions: ['Allow once', 'Deny'],
      }
    }

    if (this.isReadOnly(input)) {
      return { behavior: 'allow', decisionReason: 'Read-only command' }
    }

    const subcommands = this.splitCompoundCommand(command)
    for (const sub of subcommands) {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(sub)) {
          return { behavior: 'deny', message: `Sub-command blocked: ${reason}`, decisionReason: 'dangerous_subcommand' }
        }
      }
    }

    return {
      behavior: 'ask',
      message: `Command requires approval: ${command}`,
      suggestions: ['Allow once', 'Always allow this command', 'Deny'],
    }
  }

  private writesToSensitivePath(command: string): boolean {
    for (const { pattern } of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(command)) return true
    }

    const writeRedirectMatch = command.match(/>>?\s*([^\s;|&]+)/)
    if (writeRedirectMatch) {
      const targetPath = writeRedirectMatch[1].replace(/^['"]|['"]$/g, '')
      for (const { pattern } of SENSITIVE_PATH_PATTERNS) {
        if (pattern.test(targetPath)) return true
      }
    }

    return false
  }

  private splitCompoundCommand(command: string): string[] {
    const parts = command.split(/\s*(?:&&|\|\||;|`|\$\(|\|)\s*/)
    return parts.filter(p => p.trim().length > 0)
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
      },
      required: ['command'],
    }
  }

  async call(input: { command: string; timeout?: number }, _context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<string> {
    const timeout = input.timeout ?? parseInt(process.env.BASH_TIMEOUT ?? '120000', 10)
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

    if (!onProgress) {
      return this.execSync(input.command, timeout, shell)
    }

    return this.execStreaming(input.command, timeout, shell, onProgress as (data: BashProgressData) => void)
  }

  private execSync(command: string, timeout: number, shell: string): string {
    const { execSync } = require('child_process') as typeof import('child_process')
    try {
      const result = execSync(command, {
        timeout,
        maxBuffer: parseInt(process.env.BASH_MAX_BUFFER ?? String(10 * 1024 * 1024), 10),
        encoding: 'utf-8',
        shell,
      })
      return result
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string }
      const output = (e.stdout ?? '') + (e.stderr ?? '')
      if (output) return output
      throw error
    }
  }

  private execStreaming(command: string, timeout: number, shell: string, onProgress: (data: BashProgressData) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const startTime = Date.now()
      const child = spawn(command, [], {
        shell,
        timeout,
        env: { ...process.env },
        windowsHide: true,
      }) as import('child_process').ChildProcess

      let stdout = ''
      let stderr = ''
      let totalLines = 0
      let totalBytes = 0
      let lastProgressEmit = 0
      const PROGRESS_THROTTLE_MS = 1000

      const emitBashProgress = () => {
        const now = Date.now()
        if (now - lastProgressEmit < PROGRESS_THROTTLE_MS) return
        lastProgressEmit = now

        onProgress({
          type: 'bash_progress',
          output: stdout.slice(-500),
          fullOutput: stdout,
          elapsedTimeSeconds: (now - startTime) / 1000,
          totalLines,
          totalBytes,
          timeoutMs: timeout,
        })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stdout += text
        totalBytes += chunk.length
        totalLines += text.split('\n').length - 1
        onProgress({ type: 'stdout', text })
        emitBashProgress()
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stderr += text
        totalBytes += chunk.length
        totalLines += text.split('\n').length - 1
        onProgress({ type: 'stderr', text })
        emitBashProgress()
      })

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${timeout}ms`))
      }, timeout)

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0 || code === null) {
          resolve(stdout + stderr)
        } else {
          const output = stdout + stderr
          if (output) {
            resolve(output)
          } else {
            reject(new Error(`Command exited with code ${code}`))
          }
        }
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
