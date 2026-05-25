import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { HookDefinition } from '../hooks/types.js'
import { addHookToConfig } from '../hooks/config.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('comfyui-hooks')

const COMFYUI_HOOKS_DIR = join(process.cwd(), '.sga', 'hooks')

function getHookScriptPath(name: string): string {
  return join(COMFYUI_HOOKS_DIR, name)
}

function ensureHooksDir(): void {
  if (!existsSync(COMFYUI_HOOKS_DIR)) {
    mkdirSync(COMFYUI_HOOKS_DIR, { recursive: true })
  }
}

function writeBashHookScript(name: string, script: string): string {
  ensureHooksDir()
  const scriptPath = getHookScriptPath(name)
  writeFileSync(scriptPath, script, { encoding: 'utf-8' })
  return scriptPath
}

function writePowerShellHookScript(name: string, script: string): string {
  ensureHooksDir()
  const scriptPath = getHookScriptPath(name)
  writeFileSync(scriptPath, script, { encoding: 'utf-8' })
  return scriptPath
}

const BASH_FAILURE_HOOK = `#!/bin/bash
# ComfyUI Bash failure hook - suggests PowerShell alternatives on Windows
TOOL_NAME="$SGA_TOOL_NAME"
TOOL_ERROR="$SGA_TOOL_ERROR"

if [[ "$TOOL_ERROR" == *"not recognized"* ]] || [[ "$TOOL_ERROR" == *"command not found"* ]] || [[ "$TOOL_ERROR" == *"is not recognized as an internal or external command"* ]]; then
  echo '{"additionalContext":"The command failed. On Windows, try using PowerShell equivalents: ls -> Get-ChildItem, cat -> Get-Content, grep -> Select-String, find -> Get-ChildItem -Filter. Use Bash tool which auto-detects the shell."}'
elif [[ "$TOOL_ERROR" == *"permission denied"* ]] || [[ "$TOOL_ERROR" == *"Access is denied"* ]]; then
  echo '{"additionalContext":"Permission denied. Try running with elevated permissions or check file/directory access rights."}'
else
  echo '{"additionalContext":"Bash command failed. Consider: 1) Check if the command exists on this platform, 2) Try alternative commands, 3) Verify the path is correct."}'
fi
`

const GLOB_FAILURE_HOOK = `#!/bin/bash
# ComfyUI Glob failure hook - suggests alternative search strategies
TOOL_ERROR="$SGA_TOOL_ERROR"

if [[ -z "$TOOL_ERROR" ]] || [[ "$TOOL_ERROR" == *"0 files"* ]] || [[ "$TOOL_ERROR" == *"No files matched"* ]]; then
  echo '{"additionalContext":"Glob search returned no results. Try: 1) Use a broader pattern (e.g., **/*.safetensors instead of specific path), 2) Check if the directory exists with Bash (dir on Windows, ls on Linux), 3) Look for extra_model_paths.yaml for alternative model directories, 4) Search parent directories."}'
else
  echo '{"additionalContext":"Glob search failed. Consider using Bash to list directory contents directly, or try a different search pattern."}'
fi
`

const GREP_FAILURE_HOOK = `#!/bin/bash
# ComfyUI Grep failure hook - suggests alternative search strategies
TOOL_ERROR="$SGA_TOOL_ERROR"

if [[ -z "$TOOL_ERROR" ]] || [[ "$TOOL_ERROR" == *"0 matches"* ]] || [[ "$TOOL_ERROR" == *"No matches found"* ]]; then
  echo '{"additionalContext":"Grep search returned no matches. Try: 1) Use a broader/less specific regex pattern, 2) Remove or relax the file type filter, 3) Search in different directories, 4) Use Glob first to find relevant files then Read them."}'
else
  echo '{"additionalContext":"Grep search failed. Consider using Bash with Select-String (Windows) or grep directly, or try reading files and searching manually."}'
fi
`

const PS1_BASH_FAILURE_HOOK = `
$toolName = $env:SGA_TOOL_NAME
$toolError = $env:SGA_TOOL_ERROR

if ($toolError -match "not recognized|command not found|is not recognized") {
    '{"additionalContext":"The command failed. On Windows, try PowerShell equivalents: ls -> Get-ChildItem, cat -> Get-Content, grep -> Select-String. The Bash tool auto-detects the shell."}'
} elseif ($toolError -match "permission denied|Access is denied") {
    '{"additionalContext":"Permission denied. Try running with elevated permissions or check file/directory access rights."}'
} else {
    '{"additionalContext":"Bash command failed. Consider: 1) Check if the command exists on this platform, 2) Try alternative commands, 3) Verify the path is correct."}'
}
`

const PS1_GLOB_FAILURE_HOOK = `
$toolError = $env:SGA_TOOL_ERROR

if ([string]::IsNullOrEmpty($toolError) -or $toolError -match "0 files|No files matched") {
    '{"additionalContext":"Glob search returned no results. Try: 1) Use a broader pattern, 2) Check if the directory exists with Bash (dir/Get-ChildItem), 3) Look for extra_model_paths.yaml, 4) Search parent directories."}'
} else {
    '{"additionalContext":"Glob search failed. Consider using Bash to list directory contents directly."}'
}
`

const PS1_GREP_FAILURE_HOOK = `
$toolError = $env:SGA_TOOL_ERROR

if ([string]::IsNullOrEmpty($toolError) -or $toolError -match "0 matches|No matches found") {
    '{"additionalContext":"Grep search returned no matches. Try: 1) Use a broader regex, 2) Relax the file type filter, 3) Search different directories, 4) Use Glob first then Read."}'
} else {
    '{"additionalContext":"Grep search failed. Consider using Bash with Select-String or reading files directly."}'
}
`

const SESSION_START_HOOK_BASH = `#!/bin/bash
echo '{"additionalContext":"ComfyUI session started. Remember to use tools (Glob, Bash, Read) to explore the environment before making assumptions. Check models/ directory structure, custom_nodes/, and extra_model_paths.yaml for model locations."}'
`

const SESSION_START_HOOK_PS1 = `
echo '{"additionalContext":"ComfyUI session started. Remember to use tools (Glob, Bash, Read) to explore the environment before making assumptions. Check models/ directory structure, custom_nodes/, and extra_model_paths.yaml for model locations."}'
`

export function registerComfyUIHooks(): void {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'powershell' : 'bash'
  const ext = isWindows ? '.ps1' : '.sh'

  const bashScriptPath = isWindows
    ? writePowerShellHookScript(`comfyui-bash-failure${ext}`, PS1_BASH_FAILURE_HOOK)
    : writeBashHookScript(`comfyui-bash-failure${ext}`, BASH_FAILURE_HOOK)

  const globScriptPath = isWindows
    ? writePowerShellHookScript(`comfyui-glob-failure${ext}`, PS1_GLOB_FAILURE_HOOK)
    : writeBashHookScript(`comfyui-glob-failure${ext}`, GLOB_FAILURE_HOOK)

  const grepScriptPath = isWindows
    ? writePowerShellHookScript(`comfyui-grep-failure${ext}`, PS1_GREP_FAILURE_HOOK)
    : writeBashHookScript(`comfyui-grep-failure${ext}`, GREP_FAILURE_HOOK)

  const sessionStartScriptPath = isWindows
    ? writePowerShellHookScript(`comfyui-session-start${ext}`, SESSION_START_HOOK_PS1)
    : writeBashHookScript(`comfyui-session-start${ext}`, SESSION_START_HOOK_BASH)

  const command = isWindows ? `powershell -ExecutionPolicy Bypass -File` : `bash`

  const hooks: HookDefinition[] = [
    {
      event: 'PostToolUseFailure',
      matcher: 'Bash',
      command: `${command} "${bashScriptPath}"`,
      timeout: 10000,
    },
    {
      event: 'PostToolUseFailure',
      matcher: 'Glob',
      command: `${command} "${globScriptPath}"`,
      timeout: 10000,
    },
    {
      event: 'PostToolUseFailure',
      matcher: 'Grep',
      command: `${command} "${grepScriptPath}"`,
      timeout: 10000,
    },
    {
      event: 'SessionStart',
      command: `${command} "${sessionStartScriptPath}"`,
      once: true,
      timeout: 10000,
    },
  ]

  for (const hook of hooks) {
    try {
      addHookToConfig(hook)
      logger.info(`Registered ComfyUI hook: ${hook.event} -> ${hook.matcher ?? '*'}`)
    } catch (err) {
      logger.warn(`Failed to register hook ${hook.event}/${hook.matcher}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
