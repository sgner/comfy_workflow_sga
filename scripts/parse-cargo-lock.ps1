# Parse Cargo.lock to count and list dependencies.
param([string]$LockPath)

if (-not (Test-Path $LockPath)) { Write-Host "Cargo.lock not found: $LockPath" -ForegroundColor Red; exit 1 }

$lock = Get-Content $LockPath -Raw -Encoding UTF8

Write-Host '=== Codex-RS Dependency Analysis (from Cargo.lock) ===' -ForegroundColor Cyan

# 1. Total packages
$totalPkgs = ([regex]::Matches($lock, '(?m)^\[\[package\]\]\s*$')).Count
Write-Host ("`nTotal packages: {0}" -f $totalPkgs)

# 2. Source breakdown
$cratesIo = ([regex]::Matches($lock, '(?m)^source = "crates\.io"')).Count
$git = ([regex]::Matches($lock, '(?m)^source = "git\+')).Count
$workspace = ([regex]::Matches($lock, '(?m)^source = "workspace"')).Count
$registry = ([regex]::Matches($lock, '(?m)^source = "registry')).Count
Write-Host ("  - From crates.io: {0}" -f $cratesIo)
Write-Host ("  - From git: {0}" -f $git)
Write-Host ("  - Workspace members: {0}" -f $workspace)
Write-Host ("  - Other registry: {0}" -f $registry)

# 3. Top dependencies
Write-Host "`n=== Top 30 most-depended-upon external packages ==="
$allDeps = [regex]::Matches($lock, '(?m)^"([a-z0-9_-]+)"')
$depCount = @{}
foreach ($m in $allDeps) {
    $name = $m.Groups[1].Value
    if ($depCount.ContainsKey($name)) {
        $depCount[$name]++
    } else {
        $depCount[$name] = 1
    }
}
$depCount.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 30 | ForEach-Object {
    Write-Host ("  {0,-30} referenced {1,3}x" -f $_.Key, $_.Value)
}

# 4. codex-* workspace crates
Write-Host "`n=== codex-* workspace crates ==="
$codexCrates = @{}
[regex]::Matches($lock, '(?ms)^\[\[package\]\]\s*name = "codex([^"]*)"') | ForEach-Object {
    $key = "codex$($_.Groups[1].Value)"
    if (-not $codexCrates.ContainsKey($key)) { $codexCrates[$key] = $true }
}
$codexCrates.Keys | Sort-Object | ForEach-Object { Write-Host "  $_" }
Write-Host ("Total codex-* crates: {0}" -f $codexCrates.Count)

# 5. Detect git source crates
Write-Host "`n=== Git source packages ==="
[regex]::Matches($lock, '(?ms)source = "git\+(https?://[^"]+)"') | ForEach-Object {
    $_.Groups[1].Value
} | Sort-Object -Unique | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }

# 6. Categories of top crates (categorize by name)
Write-Host "`n=== Categorized top dependencies ==="
$cats = @{
    'Async runtime' = @('tokio', 'futures', 'async-std', 'mio', 'smol', 'async-trait')
    'Serialization' = @('serde', 'serde_json', 'serde_derive', 'bincode', 'toml', 'toml_edit', 'config')
    'HTTP/Network' = @('reqwest', 'hyper', 'ureq', 'http', 'httparse', 'tower', 'axum', 'actix-web')
    'TLS/Crypto' = @('rustls', 'rustls-pemfile', 'rustls-native-certs', 'webpki', 'openssl', 'native-tls', 'ring', 'aes-gcm', 'chacha20poly1305')
    'CLI' = @('clap', 'clap_derive', 'argh', 'indicatif', 'console', 'dialoguer', 'shell-words', 'shell-escape', 'anyhow', 'thiserror', 'eyre')
    'Logging' = @('tracing', 'tracing-subscriber', 'tracing-appender', 'log', 'env_logger', 'slog')
    'Time' = @('chrono', 'time', 'humantime', 'humantime-serde')
    'Regex/Text' = @('regex', 'regex-syntax', 'once_cell', 'unicode')
    'Encoding' = @('base64', 'url', 'percent-encoding', 'uuid', 'hex', 'rand', 'getrandom', 'sha1', 'sha2', 'md-5', 'digest')
    'MCP' = @('mcp', 'rmcp')
    'Misc' = @('anyhow', 'thiserror', 'eyre', 'bytes', 'parking_lot', 'crossbeam')
}

$found = @{}
foreach ($pkg in $depCount.Keys) {
    foreach ($cat in $cats.Keys) {
        foreach ($kw in $cats[$cat]) {
            if ($pkg -eq $kw -or $pkg.StartsWith("$kw-") -or $pkg.StartsWith("$kw_")) {
                if (-not $found.ContainsKey($cat)) { $found[$cat] = @() }
                $found[$cat] += $pkg
            }
        }
    }
}

foreach ($cat in $found.Keys | Sort-Object) {
    Write-Host ("  [{0}] {1} pkgs" -f $cat, $found[$cat].Count)
    $found[$cat] | Select-Object -First 8 | ForEach-Object { Write-Host ("    - $_") }
    if ($found[$cat].Count -gt 8) { Write-Host ("    ... +$($found[$cat].Count - 8) more") }
}
