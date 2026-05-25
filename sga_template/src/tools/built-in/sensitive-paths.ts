import { resolve, sep } from 'path'

export interface SensitivePathResult {
  reason: string
  category: 'version_control' | 'secrets' | 'system' | 'config' | 'ide' | 'framework'
}

const SENSITIVE_PATTERNS: Array<{
  pattern: RegExp
  reason: string
  category: SensitivePathResult['category']
}> = [
  { pattern: /[/\\]\.git[/\\]/, reason: 'Git version control directory', category: 'version_control' },
  { pattern: /[/\\]\.gitignore$/, reason: 'Git ignore configuration', category: 'version_control' },
  { pattern: /[/\\]\.gitmodules$/, reason: 'Git submodule configuration', category: 'version_control' },
  { pattern: /[/\\]\.gitattributes$/, reason: 'Git attributes configuration', category: 'version_control' },
  { pattern: /[/\\]\.svn[/\\]/, reason: 'SVN version control directory', category: 'version_control' },
  { pattern: /[/\\]\.hg[/\\]/, reason: 'Mercurial version control directory', category: 'version_control' },
  { pattern: /[/\\]\.ssh[/\\]/, reason: 'SSH configuration directory', category: 'secrets' },
  { pattern: /[/\\]id_rsa$/, reason: 'SSH private key', category: 'secrets' },
  { pattern: /[/\\]id_ed25519$/, reason: 'SSH private key', category: 'secrets' },
  { pattern: /[/\\]id_ecdsa$/, reason: 'SSH private key', category: 'secrets' },
  { pattern: /[/\\]\.env$/, reason: 'Environment variables file', category: 'secrets' },
  { pattern: /[/\\]\.env\./, reason: 'Environment variables file', category: 'secrets' },
  { pattern: /[/\\]\.pem$/, reason: 'PEM certificate/key file', category: 'secrets' },
  { pattern: /[/\\]\.key$/, reason: 'Private key file', category: 'secrets' },
  { pattern: /[/\\]\.keystore$/, reason: 'Java keystore file', category: 'secrets' },
  { pattern: /[/\\]credentials\.json$/, reason: 'Credentials file', category: 'secrets' },
  { pattern: /[/\\]service-account.*\.json$/, reason: 'Service account credentials', category: 'secrets' },
  { pattern: /[/\\]\.aws[/\\]/, reason: 'AWS configuration directory', category: 'secrets' },
  { pattern: /[/\\]\.gcp[/\\]/, reason: 'GCP configuration directory', category: 'secrets' },
  { pattern: /[/\\]\.kube[/\\]/, reason: 'Kubernetes configuration directory', category: 'secrets' },
  { pattern: /[/\\]etc[/\\]passwd$/, reason: 'System password file', category: 'system' },
  { pattern: /[/\\]etc[/\\]shadow$/, reason: 'System shadow password file', category: 'system' },
  { pattern: /[/\\]etc[/\\]sudoers/, reason: 'Sudo configuration', category: 'system' },
  { pattern: /[/\\]etc[/\\]ssh[/\\]/, reason: 'SSH server configuration', category: 'system' },
  { pattern: /[/\\]Windows[/\\]System32[/\\]/i, reason: 'Windows system directory', category: 'system' },
  { pattern: /[/\\]Windows[/\\]System32[/\\]config[/\\]/i, reason: 'Windows system configuration', category: 'system' },
  { pattern: /[/\\]ProgramData[/\\]/i, reason: 'Windows ProgramData directory', category: 'system' },
  { pattern: /[/\\]bootmgr/i, reason: 'Windows boot manager', category: 'system' },
  { pattern: /[/\\]Boot[/\\]BCD/i, reason: 'Windows Boot Configuration Data', category: 'system' },
  { pattern: /[/\\]\.claude[/\\]/, reason: 'Claude configuration directory', category: 'config' },
  { pattern: /[/\\]\.sga[/\\]/, reason: 'SGA configuration directory', category: 'config' },
  { pattern: /[/\\]\.bashrc$/, reason: 'Bash configuration', category: 'config' },
  { pattern: /[/\\]\.zshrc$/, reason: 'Zsh configuration', category: 'config' },
  { pattern: /[/\\]\.profile$/, reason: 'Shell profile', category: 'config' },
  { pattern: /[/\\]\.bash_profile$/, reason: 'Bash profile', category: 'config' },
  { pattern: /[/\\]\.npmrc$/, reason: 'NPM configuration', category: 'config' },
  { pattern: /[/\\]\.pypirc$/, reason: 'Python package configuration', category: 'config' },
  { pattern: /[/\\]\.vscode[/\\]/, reason: 'VS Code configuration directory', category: 'ide' },
  { pattern: /[/\\]\.idea[/\\]/, reason: 'IntelliJ IDEA configuration directory', category: 'ide' },
  { pattern: /[/\\]node_modules[/\\]/, reason: 'Node.js dependencies directory', category: 'framework' },
  { pattern: /[/\\]__pycache__[/\\]/, reason: 'Python cache directory', category: 'framework' },
  { pattern: /[/\\]\.next[/\\]/, reason: 'Next.js build directory', category: 'framework' },
  { pattern: /[/\\]\.nuxt[/\\]/, reason: 'Nuxt.js build directory', category: 'framework' },
  { pattern: /[/\\]dist[/\\]/, reason: 'Build output directory', category: 'framework' },
  { pattern: /[/\\]build[/\\]/, reason: 'Build output directory', category: 'framework' },
]

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
])

const SENSITIVE_FILENAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.env.staging', '.env.preview',
  'credentials.json', 'service-account.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.npmrc', '.pypirc', '.netrc',
  '.gitconfig', '.hgrc',
])

export function isSensitivePath(filePath: string): SensitivePathResult | null {
  const normalized = filePath.replace(/[/\\]+/g, sep)

  for (const { pattern, reason, category } of SENSITIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { reason, category }
    }
  }

  const basename = normalized.split(sep).pop() ?? ''
  const lowerBasename = basename.toLowerCase()

  if (SENSITIVE_FILENAMES.has(lowerBasename)) {
    return { reason: `Sensitive file: ${basename}`, category: 'secrets' }
  }

  const ext = lowerBasename.substring(lowerBasename.lastIndexOf('.'))
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return { reason: `Sensitive file extension: ${ext}`, category: 'secrets' }
  }

  return null
}

export function isPathOutsideProject(filePath: string, projectRoot?: string): boolean {
  const root = projectRoot ?? process.cwd()
  const resolvedPath = resolve(filePath)
  const resolvedRoot = resolve(root)
  return !resolvedPath.startsWith(resolvedRoot)
}

export function categorizePathRisk(filePath: string, projectRoot?: string): {
  level: 'low' | 'medium' | 'high' | 'critical'
  reasons: string[]
} {
  const reasons: string[] = []
  let level: 'low' | 'medium' | 'high' | 'critical' = 'low'

  const sensitive = isSensitivePath(filePath)
  if (sensitive) {
    reasons.push(sensitive.reason)

    if (sensitive.category === 'secrets') {
      level = 'critical'
    } else if (sensitive.category === 'system' || sensitive.category === 'version_control') {
      level = 'high'
    } else if (sensitive.category === 'config') {
      level = 'high'
    } else {
      level = 'medium'
    }
  }

  if (isPathOutsideProject(filePath, projectRoot)) {
    reasons.push('Path is outside the project directory')
    if (level === 'low') level = 'medium'
  }

  return { level, reasons }
}
