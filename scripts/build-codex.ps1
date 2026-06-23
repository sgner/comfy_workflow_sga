# build-codex.ps1
# Codex 子模块一键编译脚本 (Windows)
#
# 用途: 生成 <项目根>/codex/target/release/codex.exe, 供 SGA CodexBackend 探测
# 兼容: Windows 10/11, PowerShell 5.1+
#
# 用法:
#   .\scripts\build-codex.ps1           # 默认 release
#   .\scripts\build-codex.ps1 -Debug    # 编译 debug 版本
#   .\scripts\build-codex.ps1 -Clean    # 先 cargo clean 再编译
#   .\scripts\build-codex.ps1 -SkipTest # 跳过 cargo test (默认跳过)
#
# 依赖:
#   - Rust toolchain (rustup): https://rustup.rs/
#   - Visual Studio Build Tools 2022 (含 C++ workload)

[CmdletBinding()]
param(
    [switch]$Debug,
    [switch]$Clean,
    [switch]$SkipTest = $true,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
    @"
用法: .\scripts\build-codex.ps1 [-Debug] [-Clean] [-SkipTest]

选项:
  -Debug       编译 debug 版本 (更快, 体积大, 性能差)
  -Clean       先 cargo clean 再编译 (彻底重建)
  -SkipTest    跳过 cargo test (默认跳过, 节省时间)
  -Help        显示本帮助

前置依赖:
  - Rust toolchain:  https://rustup.rs/
  - MSVC build tools: Visual Studio 2022 Build Tools (含 "C++ build tools" workload)

输出:
  <项目根>\codex\target\release\codex.exe  (默认)
  <项目根>\codex\target\debug\codex.exe    (Debug 模式)
"@
}

if ($Help) { Show-Usage; exit 0 }

# ---- 定位项目根 (本脚本位于 <root>/scripts/) ----
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$CodexDir = Join-Path $ProjectRoot "codex"
$CodexRsDir = Join-Path $CodexDir "codex-rs"

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  Codex 一键编译脚本 (v0.4)" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "项目根: $ProjectRoot"
Write-Host "Codex 子模块: $CodexDir"
Write-Host ""

# ---- 1. 校验子模块存在 ----
if (-not (Test-Path $CodexDir)) {
    Write-Host "[X] 错误: 未找到 codex/ 子模块目录" -ForegroundColor Red
    Write-Host "    路径: $CodexDir" -ForegroundColor Red
    Write-Host ""
    Write-Host "    子模块未初始化. 请执行:" -ForegroundColor Yellow
    Write-Host "      git submodule update --init --recursive" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path (Join-Path $CodexRsDir "Cargo.toml"))) {
    Write-Host "[X] 错误: codex/codex-rs/Cargo.toml 不存在" -ForegroundColor Red
    Write-Host "    codex/ 目录可能不是完整的子模块" -ForegroundColor Red
    exit 1
}

# ---- 2. 校验 Rust 工具链 ----
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    Write-Host "[!] 警告: 未找到 cargo (Rust toolchain)" -ForegroundColor Yellow

    # 看是否已经有可用的 codex binary (本地编译 / 官方预装 / PATH)
    $existing = & powershell -NoProfile -ExecutionPolicy Bypass -File - <<'PS_EOF'
$ErrorActionPreference = 'SilentlyContinue'
function Get-CodexBinary {
    $env:CODEX_BINARY
    if ($env:CODEX_BINARY -and (Test-Path $env:CODEX_BINARY)) { return $env:CODEX_BINARY }
    $candidates = @(
        (Join-Path $PSScriptRoot "..\codex\target\release\codex.exe"),
        (Join-Path $PSScriptRoot "..\codex\target\debug\codex.exe")
    )
    foreach ($c in $candidates) {
        $abs = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\codex\target\release\codex.exe"))
        if (Test-Path $abs) { return $abs }
    }
    $local = "$env:LOCALAPPDATA\OpenAI\Codex\bin"
    if (Test-Path $local) {
        $best = $null
        $bestMt = -1
        Get-ChildItem $local -Directory | ForEach-Object {
            $c = Join-Path $_.FullName "codex.exe"
            if (Test-Path $c) {
                $mt = $_.LastWriteTimeUtc.Ticks
                if ($mt -gt $bestMt) { $best = $c; $bestMt = $mt }
            }
        }
        return $best
    }
    $which = Get-Command codex -ErrorAction SilentlyContinue
    if ($which) { return $which.Source }
    return $null
}
Get-CodexBinary
PS_EOF

    if ($existing) {
        Write-Host "[OK] 已发现可用 codex binary, 跳过 cargo 编译" -ForegroundColor Green
        Write-Host "     路径: $existing" -ForegroundColor Green
        Write-Host ""
        Write-Host "  下次启动 ComfyUI 时, SGA 会自动探测并启用 Codex 后端." -ForegroundColor Cyan
        Write-Host "  如需自编译 (使用最新源码), 请先安装 Rust:" -ForegroundColor Gray
        Write-Host "    https://rustup.rs/" -ForegroundColor Gray
        exit 0
    } else {
        Write-Host "[X] 错误: 未找到 cargo, 且无可用 codex binary" -ForegroundColor Red
        Write-Host "" -ForegroundColor Red
        Write-Host "  方案 1: 安装 Rust 工具链后重跑本脚本" -ForegroundColor Yellow
        Write-Host "    https://rustup.rs/" -ForegroundColor Yellow
        Write-Host "  方案 2: 安装 OpenAI Codex 桌面客户端" -ForegroundColor Yellow
        Write-Host "    https://openai.com/codex  (会自动把 codex.exe 装到 %LOCALAPPDATA%\OpenAI\Codex\bin\)" -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "[OK] cargo: $($cargo.Source)"

$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if ($rustc) {
    Write-Host "[OK] rustc: $($rustc.Source)"
}

# ---- 3. 校验 MSVC (Windows) ----
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) {
    Write-Host "[!] 警告: 未找到 cl.exe (MSVC)" -ForegroundColor Yellow
    Write-Host "    Rust 编译可能失败. 请安装 Visual Studio 2022 Build Tools:" -ForegroundColor Yellow
    Write-Host "    https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "    是否继续? (y/N)"
    if ($continue -ne 'y' -and $continue -ne 'Y') {
        exit 1
    }
} else {
    Write-Host "[OK] cl.exe: $($cl.Source)"
}

# ---- 4. 可选 clean ----
if ($Clean) {
    Write-Host ""
    Write-Host "[>] 清理: cargo clean" -ForegroundColor Cyan
    Push-Location $CodexRsDir
    try {
        & cargo clean
        if ($LASTEXITCODE -ne 0) { throw "cargo clean failed" }
    } finally {
        Pop-Location
    }
}

# ---- 5. 编译 ----
$profile = if ($Debug) { "debug" } else { "release" }
Write-Host ""
Write-Host "[>] 编译: cargo build --profile=$profile -p codex-app-server" -ForegroundColor Cyan
Write-Host "    (首次编译可能需要 5-15 分钟, 取决于机器性能)" -ForegroundColor Gray
Write-Host ""

$buildArgs = @("build", "--profile=$profile", "-p", "codex-app-server")
if ($SkipTest) {
    # cargo 默认就不跑 test, 这里显式跳过任何 build.rs 中的测试
    $buildArgs += "--tests=false"
}

Push-Location $CodexRsDir
try {
    & cargo @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed (exit=$LASTEXITCODE)"
    }
} finally {
    Pop-Location
}

# ---- 6. 验证产物 ----
$exeName = if ($IsWindows -or $env:OS -eq "Windows_NT") { "codex.exe" } else { "codex" }
$binPath = Join-Path $CodexDir "target\$profile\$exeName"

Write-Host ""
if (Test-Path $binPath) {
    $size = (Get-Item $binPath).Length
    $sizeMb = [math]::Round($size / 1MB, 2)
    Write-Host "===============================================" -ForegroundColor Green
    Write-Host "  [OK] 编译成功" -ForegroundColor Green
    Write-Host "===============================================" -ForegroundColor Green
    Write-Host "  产物: $binPath" -ForegroundColor Green
    Write-Host "  大小: $sizeMb MB" -ForegroundColor Green
    Write-Host ""

    # 写 .codex-revision (git rev 前 8 位)
    Push-Location $CodexDir
    try {
        $rev = (& git rev-parse HEAD 2>$null)
        if ($rev) {
            $revFile = Join-Path $CodexDir ".codex-revision"
            $rev.Substring(0, [Math]::Min(8, $rev.Length)) | Out-File -FilePath $revFile -Encoding utf8 -NoNewline
            Write-Host "  版本: $($rev.Substring(0, 8))" -ForegroundColor Green
        }
    } catch {
        # git 不可用, 跳过
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "下一步:" -ForegroundColor Cyan
    Write-Host "  1. 重启 ComfyUI 让 SGA 重新探测 codex binary" -ForegroundColor Gray
    Write-Host "  2. 或在 SGA 设置中点 '重新探测'" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "[X] 错误: 编译未产出预期二进制" -ForegroundColor Red
    Write-Host "    期望路径: $binPath" -ForegroundColor Red
    exit 1
}
