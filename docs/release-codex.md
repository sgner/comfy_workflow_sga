# Optional Codex Binary Releases

Last updated: 2026-06-28

This document is for maintainers who publish or install prebuilt `codex-app-server` binaries for the optional Codex backend. Regular SGA usage does not require this.

## Expected Binary

The backend expects a compatible app-server binary named:

- Windows: `codex-app-server.exe`
- Linux/macOS: `codex-app-server`

Recommended install path:

```text
sga_template/codex-rs/target/release/codex-app-server(.exe)
```

You can also set `CODEX_BINARY` to an explicit compatible binary path.

## Release Assets

Suggested asset names:

| Platform | Asset |
|---|---|
| Windows x64 | `codex-app-server-windows-x86_64.zip` |
| Linux x64 | `codex-app-server-linux-x86_64.tar.gz` |
| macOS x64 | `codex-app-server-macos-x86_64.tar.gz` |
| macOS ARM64 | `codex-app-server-macos-aarch64.tar.gz` |

Each release should include `SHA256SUMS`.

## Manual Install On Windows

```powershell
$dest = "C:\path\to\comfy_workflow_agent\sga_template\codex-rs\target\release"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive .\codex-app-server-windows-x86_64.zip -DestinationPath .\codex-app-server -Force
Copy-Item .\codex-app-server\codex-app-server.exe "$dest\codex-app-server.exe" -Force
Get-FileHash "$dest\codex-app-server.exe" -Algorithm SHA256
```

## Manual Install On Linux Or macOS

```bash
DEST="$HOME/path/to/comfy_workflow_agent/sga_template/codex-rs/target/release"
mkdir -p "$DEST"
tar -xzf codex-app-server-linux-x86_64.tar.gz
cp codex-app-server "$DEST/"
chmod +x "$DEST/codex-app-server"
sha256sum "$DEST/codex-app-server"
```

## Verification

Start the backend and check:

```text
GET /api/v1/codex/status
```

Expected successful state:

```json
{
  "state": "ready",
  "canSwitchToCodex": true
}
```

If the state is `source-present`, `building`, `unavailable`, or `failed`, the UI should keep SGA available and explain why Codex cannot be selected yet.

## Security Notes

- Do not publish API keys, GitHub tokens, or local config files in release assets.
- Include checksums for every binary artifact.
- Prefer binaries built from the vendored `sga_template/codex-rs/` source used by this project.
- Do not document the official OpenAI Codex CLI as a drop-in backend replacement; this integration expects `codex-app-server` behavior.

## License

Codex Rust source and derived binaries follow the upstream Apache-2.0 license. Preserve upstream notices in release materials.
