#!/usr/bin/env python3
"""
parse-cargo-lock.py — 解析 Cargo.lock 并输出 codex-rs 的依赖统计
无需运行 cargo, 纯文本分析。
"""
import sys
import re
from collections import Counter, defaultdict

if len(sys.argv) < 2:
    print("Usage: python parse-cargo-lock.py <Cargo.lock>")
    sys.exit(1)

lock_path = sys.argv[1]
with open(lock_path, "r", encoding="utf-8") as f:
    text = f.read()

# Parse [[package]] blocks via regex (no need for full TOML parser)
# Format:
# [[package]]
# name = "foo"
# version = "1.0"
# source = "registry+https://github.com/rust-lang/crates.io-index"
# dependencies = [ "bar 0.2", "baz 1.0 (registry+https://github.com/rust-lang/crates.io-index)" ]

pkg_re = re.compile(
    r"\[\[package\]\]\s*\n"
    r"name = \"([^\"]+)\"\s*\n"
    r"version = \"([^\"]+)\""
    r"(?:\s*\nsource = \"([^\"]+)\")?"
    r"(?:\s*\nchecksum = \"[a-f0-9]+\")?"
    r"((?:\s*\ndependencies = \[[^\]]*\])?)",
    re.MULTILINE,
)

packages = []
for m in pkg_re.finditer(text):
    name, version, source, deps_block = m.groups()
    deps = []
    if deps_block and "dependencies" in deps_block:
        # Extract quoted dep names
        dep_names = re.findall(r'"([a-zA-Z0-9_-]+)\s', deps_block)
        deps = dep_names
    packages.append({
        "name": name,
        "version": version,
        "source": source or "workspace/member",
        "deps": deps,
    })

# Stats
total = len(packages)
deps_count = Counter()
src_count = Counter()
git_pkgs = []
codex_pkgs = []
external_pkgs = []
workspace_pkgs = []

for p in packages:
    src_count[p["source"]] += 1
    for d in p["deps"]:
        deps_count[d] += 1
    if "git+" in p["source"]:
        git_pkgs.append(p)
    if p["name"].startswith("codex-") or p["name"] in ("codex", "codex_app_server"):
        codex_pkgs.append(p)
    elif p["source"] == "workspace/member":
        workspace_pkgs.append(p)
    else:
        external_pkgs.append(p)

print("=" * 70)
print(" Codex-RS 依赖分析 (from Cargo.lock)")
print("=" * 70)
print(f"\n文件: {lock_path}")
print(f"文件大小: {len(text):,} bytes")
print(f"\n总包数: {total}")
print(f"  - 外部 (crates.io 等): {len(external_pkgs)}")
print(f"  - Workspace 成员 (codex-*): {len(codex_pkgs)}")
print(f"  - 从 git: {len(git_pkgs)}")
print(f"  - 其他: {total - len(external_pkgs) - len(codex_pkgs) - len(git_pkgs)}")

# Group sources
print("\n--- Source 分布 (top 10) ---")
for src, n in src_count.most_common(10):
    short = src.replace("registry+https://github.com/rust-lang/crates.io-index", "crates.io")
    short = short.replace("git+https://", "git:")
    short = short[:80]
    print(f"  {n:5d}  {short}")

# Top depended-upon
print("\n--- Top 30 引用最多的包 (popular dependencies) ---")
for name, n in deps_count.most_common(30):
    pkg = next((p for p in packages if p["name"] == name), None)
    ver = pkg["version"] if pkg else "?"
    print(f"  {n:4d}×  {name:<30} v{ver}")

# Categorize
print("\n--- 按功能分类 (top crates) ---")
cats = {
    "异步运行时": ["tokio", "futures", "async-std", "mio", "smol", "async-trait", "futures-lite", "waker-fn"],
    "序列化/配置": ["serde", "serde_json", "serde_derive", "bincode", "toml", "toml_edit", "config", "yaml-rust"],
    "HTTP/网络": ["reqwest", "hyper", "ureq", "http", "httparse", "tower", "axum", "actix-web", "h2"],
    "TLS/加密": ["rustls", "rustls-pemfile", "rustls-native-certs", "webpki", "openssl", "openssl-sys", "native-tls", "ring", "aes-gcm", "chacha20poly1305", "rsa", "ssh2", "ed25519-dalek"],
    "CLI/UI": ["clap", "clap_derive", "argh", "indicatif", "console", "dialoguer", "shell-words", "shell-escape", "comfy-table", "crossterm", "ratatui"],
    "日志/追踪": ["tracing", "tracing-subscriber", "tracing-appender", "log", "env_logger", "slog", "opentelemetry"],
    "时间/日期": ["chrono", "time", "humantime", "humantime-serde"],
    "正则/文本": ["regex", "regex-syntax", "once_cell", "oncecell"],
    "编码/哈希": ["base64", "url", "percent-encoding", "uuid", "hex", "rand", "getrandom", "sha1", "sha2", "md-5", "digest", "hmac", "argon2", "bcrypt", "blake3"],
    "错误处理": ["anyhow", "thiserror", "eyre", "color-eyre"],
    "MCP/协议": ["mcp", "rmcp", "livekit", "webrtc", "serde_json"],
    "存储/数据库": ["rusqlite", "sqlx", "diesel", "sled", "lmdb-rs", "redb"],
    "文件/IO": ["tokio-util", "tokio-stream", "async-channel", "crossbeam", "parking_lot", "notify", "globset", "walkdir", "fs2", "tempfile"],
    "JSON 工具": ["serde", "serde_json", "json-patch", "jsonwebtoken"],
    "MIME/Media": ["mime", "infer", "image", "png", "jpeg-decoder", "gif"],
    "Mac/Linux 平台": ["nix", "libc", "winapi", "windows", "winreg"],
}

cat_hits = defaultdict(list)
for name, _n in deps_count.most_common(200):
    for cat, kws in cats.items():
        if any(name == kw or name.startswith(kw + "-") or name.startswith(kw + "_") for kw in kws):
            cat_hits[cat].append(name)
            break

for cat in sorted(cat_hits.keys()):
    items = cat_hits[cat]
    print(f"\n  [{cat}] {len(items)} packages")
    for n in items[:8]:
        print(f"    - {n}")
    if len(items) > 8:
        print(f"    ... +{len(items) - 8} more")

# Git deps
print("\n--- Git 依赖详情 ---")
seen = set()
for p in git_pkgs:
    if p["source"] in seen:
        continue
    seen.add(p["source"])
    short = p["source"].replace("git+https://", "git:")[:70]
    print(f"  {short}")
print(f"  总计 {len(seen)} 个不同 git 源")

# codex workspace
print(f"\n--- Codex 工作区成员 ({len(codex_pkgs)} 个) ---")
for p in codex_pkgs[:30]:
    print(f"  {p['name']:<45} v{p['version']}")
if len(codex_pkgs) > 30:
    print(f"  ... +{len(codex_pkgs) - 30} more")

# Build target deps
print("\n--- build.rs / 系统依赖提示 ---")
build_reqs = set()
for p in external_pkgs:
    if "windows" in p["name"] or "winapi" in p["name"] or "msvc" in p["name"]:
        build_reqs.add("Windows: " + p["name"])
    if "linux" in p["name"] or "libc" in p["name"] or "nix" in p["name"]:
        build_reqs.add("Linux: " + p["name"])
    if "macos" in p["name"] or "core-foundation" in p["name"] or "cocoa" in p["name"]:
        build_reqs.add("macOS: " + p["name"])
print("  平台相关 crate (首次构建需安装系统依赖):")
for r in sorted(build_reqs)[:15]:
    print(f"    - {r}")

print("\n" + "=" * 70)
print(f" 解析完成: {total} packages, {len(deps_count)} unique dependencies")
print("=" * 70)
