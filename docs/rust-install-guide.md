# Rust + Codex 编译指南

> 最后更新: 2026-06-22
> 适用版本: codex-rs vendored in `sga_template/codex-rs/` (Apache-2.0)

## 1. 为什么需要 Rust

`comfy_workflow_agent` 默认使用 **SGA (Node.js/TypeScript) Agent**，**完全不需要** Rust 工具链。

只有当你**切换到 Codex Agent** 时（v0.6 引入的实验功能），SGA 才会调用 vendored 的 `codex-app-server` 二进制，此时才需要 Rust 来编译这个二进制。

> 💡 **SGA 与 Codex 完全解耦**——没有 codex binary 也能 100% 工作。

## 2. 安装 Rust 工具链

### Windows 11 / 10 (PowerShell)

**方法 A: 用我们准备好的脚本（推荐）**

```powershell
cd "C:\Users\25315\comfyui\ComfyUI-aki(1)\ComFyUI-aki-v3\ComFyUI\custom_nodes\comfy_workflow_agent"
powershell -ExecutionPolicy Bypass -File scripts\install-rust.ps1
```

脚本会:
1. 清理旧的 `.cargo` 和 `.rustup` 目录
2. 下载 rustup-init (~15 MB)
3. 安装 minimal profile（不带 rust-docs 等大文件）
4. 验证 `cargo` / `rustc` 可用

预计耗时: **3-8 分钟**（取决于网络）。

**方法 B: 手动安装**

如果脚本失败（OS Error 32 = 之前的进程还在用 rustup.exe），手动:

```powershell
# 1. 确认没有 rustup 进程
Get-Process -Name rustup,cargo,rustc -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. 手动删除残留
Remove-Item -Recurse -Force "$env:USERPROFILE\.rustup" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.cargo" -ErrorAction SilentlyContinue

# 3. 等待 5 秒, 然后下载
Start-Sleep 5
Invoke-WebRequest 'https://win.rustup.rs/x86_64' -OutFile "$env:TEMP\rustup-init.exe"

# 4. 安装 (用 Start-Process 避免 .cargo\bin\rustup.exe 文件锁问题)
Start-Process "$env:TEMP\rustup-init.exe" -ArgumentList '-y','--default-toolchain','stable','--profile','minimal','--no-modify-path' -Wait -NoNewWindow

# 5. 验证
& "$env:USERPROFILE\.cargo\bin\cargo.exe" --version
```

## 3. 安装 MSVC build tools（首次编译必需）

codex-rs 依赖 `windows-sys` / `winapi` 等 Windows 系统绑定，编译时**必须**有 MSVC 链接器。

### Visual Studio Build Tools (推荐)

```powershell
# 用 winget 安装最小化构建工具 (约 1-3 GB)
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

或者下载 Visual Studio Installer: <https://visualstudio.microsoft.com/visual-cpp-build-tools/>

勾选 **"使用 C++ 的桌面开发"** 工作负载即可。

### 验证

```powershell
# 应该能找到 cl.exe 和 link.exe
where.exe cl.exe
where.exe link.exe
```

## 4. 编译 codex-app-server

### 一键脚本

```powershell
cd "C:\Users\25315\comfyui\ComFyUI-aki(1)\ComFyUI-aki-v3\ComFyUI\custom_nodes\comfy_workflow_agent"
node scripts\build-codex.mjs --app-server
```

### 手动 cargo build

```powershell
cd sga_template\codex-rs
cargo build -p codex-app-server --release
```

预计耗时:
- **首次**: 10-20 分钟（要下载 1,300+ 个 crate 依赖并编译 124 个 workspace 成员）
- **增量**: 30 秒 - 3 分钟

### 产物路径

```
sga_template\codex-rs\target\release\codex-app-server.exe
```

## 5. 让 SGA 探测到 codex

SGA 启动时按 5 级顺序探测（`sga_template/src/agents/codex/detect.ts`）:

1. 环境变量 `CODEX_BINARY` 指向的路径
2. `codex-app-server` 在 PATH 中
3. `codex/bin/codex-app-server(.exe)` (兼容旧版)
4. `codex-rs/target/release/codex-app-server(.exe)` (vendored 路径, 自动命中)
5. `~/.cargo/bin/codex-app-server(.exe)` (cargo build 默认产物)

只要 `cargo build -p codex-app-server --release` 成功，**默认会被自动探测到**（走第 4 级）。

## 6. 故障排查

### 编译错误: `link.exe not found`

安装 Visual Studio Build Tools（步骤 3）。

### 编译错误: `error: linking with `link.exe` failed: exit code: 1125`

通常是磁盘空间不足或防病毒软件拦截。检查:
- `C:\` 至少有 10 GB 可用空间
- 临时禁用 Windows Defender 实时保护

### 编译错误: `could not find native static library` 或 `pkg-config`

安装 `pkg-config` 和 `cmake`:
```powershell
winget install StrawberryPerl.Perl  # 包含 pkg-config
winget install Kitware.CMake
```

### Rust 升级后 `Cargo.lock` 不匹配

```powershell
cd sga_template\codex-rs
cargo update --workspace
```

## 7. 卸载 Rust

```powershell
# 标准卸载
& "$env:USERPROFILE\.cargo\bin\rustup.exe" self uninstall

# 强制清理
Remove-Item -Recurse -Force "$env:USERPROFILE\.rustup"
Remove-Item -Recurse -Force "$env:USERPROFILE\.cargo"
```

## 8. 升级 vendored codex-rs

未来需要同步上游新版本时:

```bash
# 1. 备份当前 vendor
mv sga_template/codex-rs sga_template/codex-rs.old

# 2. 下载最新 tarball
gh release download --repo openai/codex --pattern '*.tar.gz' --dir /tmp
tar -xzf /tmp/codex-*.tar.gz -C /tmp

# 3. 移动新源码
mv /tmp/codex-*/codex-rs sga_template/codex-rs

# 4. 处理 Windows 路径过长问题
# 删除 *.snap 文件 (insta.rs 测试快照)
find sga_template/codex-rs -name "*.snap" -path "*bottom_pane*" -delete

# 5. 编译验证
cargo build -p codex-app-server --release
```

## 9. License 合规

codex-rs 在 `sga_template/codex-rs/LICENSE` 保留原始 Apache-2.0 许可证。
`NOTICE` 文件保存上游归属声明。
任何对 codex-rs 源码的修改应在提交信息中明确标注，并保留原始版权声明。
