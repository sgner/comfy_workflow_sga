# Pre-built codex-app-server binaries (ComfyUI-aki vendored)

This GitHub release page hosts **pre-compiled** `codex-app-server` binaries
for the [ComfyUI-aki](https://github.com/YOUR_USER/comfyui-aki) custom node.

The vendored build includes the `comfyui_agent` modifications that turn Codex
into a ComfyUI workflow specialist (the same behavior as the SGA native
agent). **You don't need Rust / cargo to use it.**

## Why a pre-built binary?

Building `codex-app-server` from source takes ~9 minutes on a clean machine
and pulls ~1.5 GB of dependencies (including the 37 MB V8 precompiled lib
from `denoland/rusty_v8`). Most users just want to run the SGA Codex
backend — they shouldn't have to compile it themselves.

## Download

Pick the file that matches your OS:

| OS        | File                                         | Size  |
|-----------|----------------------------------------------|-------|
| Windows   | `codex-app-server-windows-x86_64.zip`        | ~258 MB |
| Linux     | `codex-app-server-linux-x86_64.tar.gz`       | ~250 MB |
| macOS x86 | `codex-app-server-macos-x86_64.tar.gz`       | ~250 MB |
| macOS ARM | `codex-app-server-macos-aarch64.tar.gz`      | ~250 MB |

## Install

### Windows (PowerShell)

```powershell
# 1. Download
$Tag = "v0.1.0"   # <-- replace with the version you want
Invoke-WebRequest -Uri "https://github.com/YOUR_USER/comfyui-aki/releases/download/$Tag/codex-app-server-windows-x86_64.zip" -OutFile "$env:TEMP\codex-app-server.zip"

# 2. Extract
Expand-Archive "$env:TEMP\codex-app-server.zip" -DestinationPath "$env:TEMP\codex-app-server" -Force

# 3. Copy into the vendored path SGA auto-detects
$dest = "C:\path\to\comfy_workflow_agent\sga_template\codex-rs\target\release"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$env:TEMP\codex-app-server\codex-app-server.exe" "$dest\codex-app-server.exe" -Force

# 4. Verify SHA256
cd "$env:TEMP\codex-app-server"
$expected = (Get-Content SHA256SUMS).Split()[0]
$actual   = (Get-FileHash "codex-app-server.exe" -Algorithm SHA256).Hash
if ($expected -eq $actual) { Write-Host "✓ SHA256 verified" } else { Write-Error "✗ SHA256 mismatch!" }
```

### Linux / macOS

```bash
TAG="v0.1.0"   # <-- replace
DEST="$HOME/path/to/comfy_workflow_agent/sga_template/codex-rs/target/release"

# Linux
curl -L -o codex-app-server.tar.gz "https://github.com/YOUR_USER/comfyui-aki/releases/download/$TAG/codex-app-server-linux-x86_64.tar.gz"
# macOS (pick the right arch)
# curl -L -o codex-app-server.tar.gz "https://github.com/YOUR_USER/comfyui-aki/releases/download/$TAG/codex-app-server-macos-x86_64.tar.gz"
# curl -L -o codex-app-server.tar.gz "https://github.com/YOUR_USER/comfyui-aki/releases/download/$TAG/codex-app-server-macos-aarch64.tar.gz"

tar -xzf codex-app-server.tar.gz
mkdir -p "$DEST"
cp codex-app-server "$DEST/"
chmod +x "$DEST/codex-app-server"
sha256sum -c SHA256SUMS
```

## What SGA does with it

SGA's `src/agents/codex/detect.ts` probes for the codex binary in this
priority order:

1. `CODEX_BINARY` env var (manual override)
2. **`sga_template/codex-rs/target/release/codex-app-server(.exe)` ← here**
3. `sga_template/codex-rs/target/debug/codex-app-server(.exe)`
4. OpenAI official install at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` — **explicitly rejected** by this build to enforce the Comfy Workflow Agent identity
5. `PATH`

So just dropping the binary into the right path is enough — no config
required.

## What does the vendored build do differently?

It overrides the default Codex CLI identity. The model sees this system
prompt (compressed for readability):

```markdown
## IDENTITY OVERRIDE (HIGHEST PRIORITY)
You are "Comfy Workflow Agent", an expert AI assistant specialized in ComfyUI
... [full CORE MISSION / CAPABILITIES / RESPONSE FORMAT / RULES / WORKSPACE
/ ADVANCED CAPABILITIES / FINAL OUTPUT (Related Questions) blocks]
```

Concretely:
- ❌ Default: "What do you want changed or investigated in this workspace? I
  can inspect code, review it, trace a bug, or propose a fix..."
- ✅ Vendored: "我是 Comfy Workflow Agent，一个专门处理 ComfyUI 工作流的 AI
  助手. 我能帮你: 看懂工作流 / 排查报错 / 修改工作流 JSON / 检查环境."

Plus it auto-injects:
- The current ComfyUI workflow JSON (or a file-path reference if too big)
- The current ComfyUI environment context (COMFYUI_BASE_DIR, SGA.md)
- The SGA shared blackboard (current task, key facts, recent actions)

## Building it yourself

If you want to build from source (e.g. to modify the prompt):

```bash
cd sga_template/codex-rs
cargo build --release -p codex-app-server
```

The resulting binary lives at `target/release/codex-app-server(.exe)` and
SGA will pick it up automatically.

## License

Apache-2.0 (inherited from the vendored OpenAI Codex source).
