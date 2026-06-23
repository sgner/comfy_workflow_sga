# 完整的 Rust toolchain 重装脚本
$ErrorActionPreference = 'Stop'

Write-Host '=== 1. 清理旧文件 ===' -ForegroundColor Cyan
Get-Process -Name rustup,cargo,rustc -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  Killing PID $($_.Id) $($_.ProcessName)" -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep 2
foreach ($p in @("$env:USERPROFILE\.rustup", "$env:USERPROFILE\.cargo")) {
    if (Test-Path $p) {
        Write-Host "  Deleting $p ..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep 1
Write-Host '  Cleanup done' -ForegroundColor Green

Write-Host ''
Write-Host '=== 2. 下载 rustup-init ===' -ForegroundColor Cyan
$inst = "$env:TEMP\rustup-init-clean.exe"
if (-not (Test-Path $inst)) {
    Invoke-WebRequest 'https://win.rustup.rs/x86_64' -OutFile $inst -UseBasicParsing
}
$size = (Get-Item $inst).Length
Write-Host "  Downloaded: $size bytes" -ForegroundColor Green

Write-Host ''
Write-Host '=== 3. 安装 Rust (minimal profile) ===' -ForegroundColor Cyan
Write-Host '  预计 3-8 分钟, 请耐心等待...' -ForegroundColor Yellow
$proc = Start-Process -FilePath $inst -ArgumentList '-y','--default-toolchain','stable','--profile','minimal','--no-modify-path' -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\rust-install-stdout.log" -RedirectStandardError "$env:TEMP\rust-install-stderr.log"
Write-Host "  Install exit code: $($proc.ExitCode)" -ForegroundColor $(if ($proc.ExitCode -eq 0) { 'Green' } else { 'Red' })

Write-Host ''
Write-Host '=== 4. 验证 ===' -ForegroundColor Cyan
foreach ($tool in @('cargo', 'rustup', 'rustc')) {
    $p = "$env:USERPROFILE\.cargo\bin\$tool.exe"
    if (Test-Path $p) {
        $ver = & $p --version 2>&1
        Write-Host "  $tool : $ver" -ForegroundColor Green
    } else {
        Write-Host "  $tool : NOT FOUND" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '=== 5. Stderr tail (if any errors) ===' -ForegroundColor Cyan
if (Test-Path "$env:TEMP\rust-install-stderr.log") {
    Get-Content "$env:TEMP\rust-install-stderr.log" -Tail 10
}
