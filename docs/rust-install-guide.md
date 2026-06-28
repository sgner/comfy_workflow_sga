# Rust And Codex Build Guide

Last updated: 2026-06-28

Rust is only needed when you want to build the optional Codex backend yourself. The default SGA backend does not require Rust and remains usable when Codex is disabled, unavailable, building, or failed.

## When You Need Rust

You need Rust only if all of the following are true:

1. You want to switch sessions to the Codex backend.
2. You do not already have a compatible `codex-app-server` binary.
3. You want to build the vendored source under `sga_template/codex-rs/`.

The expected output is:

```text
sga_template/codex-rs/target/release/codex-app-server(.exe)
```

## Install Rust

Recommended path:

```powershell
winget install Rustlang.Rustup
rustup default stable
```

Or use the official installer from <https://rustup.rs/>.

On Windows, you also need Visual Studio Build Tools with the C++ workload:

```powershell
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Verify the toolchain:

```powershell
cargo --version
rustc --version
where.exe link.exe
```

## Build Codex

From the project root:

```powershell
node scripts\build-codex.mjs --app-server
```

Or build directly:

```powershell
cd sga_template\codex-rs
cargo build --release -p codex-app-server
```

First builds can take several minutes and download many Rust crates. Incremental builds are usually much faster.

## Runtime Controls

| Variable | Description |
|---|---|
| `SGA_ENABLE_CODEX=auto` | Default. Detect Codex and report capability state. |
| `SGA_ENABLE_CODEX=true` | Keep Codex enabled, but switching still requires `ready`. |
| `SGA_ENABLE_CODEX=false` | Disable Codex entirely. |
| `CODEX_BINARY=<path>` | Explicit compatible `codex-app-server` binary. |
| `CODEX_SKIP_BUILD=1` | Skip automatic background build attempts. |

## Troubleshooting

### `link.exe not found`

Install Visual Studio Build Tools with the C++ workload, then open a fresh terminal and retry.

### Build is slow

This is expected for a first build. The UI and SGA backend should remain usable while Codex is unavailable or building.

### Codex status is `source-present`

Vendored source exists, but no compatible binary is ready yet. Build with `node scripts\build-codex.mjs --app-server` or place a compatible binary at the expected target path.

### Codex status is `failed`

Check the redacted status from `/api/v1/codex/status` and the local build log under `SGA_HOME`. Do not paste API keys or token-bearing logs into issues.

## License

Vendored Codex Rust source retains its upstream Apache-2.0 license. This project remains MIT licensed where applicable.
