import sys
import os
import subprocess
import shutil
import platform
import urllib.request
import tempfile
import threading

current_dir = os.path.dirname(__file__)
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY", "start_backend_server"]

_backend_process = None
_backend_server = None

_NODE_MSI_DIR = os.path.join(current_dir, ".node-runtime")
_DEFAULT_NODE_VERSION = "20.18.0"
_SGA_ENV_CACHE = None


def _load_env_from_sga():
    global _SGA_ENV_CACHE
    if _SGA_ENV_CACHE is not None:
        return _SGA_ENV_CACHE
    sga_env_path = os.path.join(current_dir, "sga_template", ".env")
    env_vars = {}
    if os.path.isfile(sga_env_path):
        with open(sga_env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip()
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    elif value.startswith("'") and value.endswith("'"):
                        value = value[1:-1]
                    env_vars[key] = value
    _SGA_ENV_CACHE = env_vars
    return env_vars


def _get_sga_server_config():
    env_vars = _load_env_from_sga()
    port = int(env_vars.get("PORT", "8000"))
    host = env_vars.get("HOST", "127.0.0.1")
    return host, port


def _get_node_version():
    env_vars = _load_env_from_sga()
    return env_vars.get("NODE_VERSION", _DEFAULT_NODE_VERSION)


def _find_node():
    """在 PATH 中查找 node，找不到时再在常见安装目录搜索。"""
    n = shutil.which("node") or shutil.which("node.exe")
    if n:
        return n
    # 常见 nvm / 标准安装位置兜底
    candidates = []
    if platform.system() == "Windows":
        # nvm-windows 默认: %APPDATA%\nvm\<version>\node.exe
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            nvm_root = os.path.join(appdata, "nvm")
            if os.path.isdir(nvm_root):
                try:
                    for entry in os.listdir(nvm_root):
                        if entry.startswith("v") and entry[1:].split(".")[0].isdigit():
                            candidates.append(os.path.join(nvm_root, entry, "node.exe"))
                except OSError:
                    pass
        # nvm-windows 非默认位置: %LOCALAPPDATA%\nvm\<version>\node.exe
        localappdata = os.environ.get("LOCALAPPDATA", "")
        if localappdata:
            nvm_root = os.path.join(localappdata, "nvm")
            if os.path.isdir(nvm_root):
                try:
                    for entry in os.listdir(nvm_root):
                        if entry.startswith("v") and entry[1:].split(".")[0].isdigit():
                            candidates.append(os.path.join(nvm_root, entry, "node.exe"))
                except OSError:
                    pass
        # 系统级 Node.js: %ProgramFiles%\nodejs\node.exe
        for pf in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
            if pf:
                candidates.append(os.path.join(pf, "nodejs", "node.exe"))
        # 用户级安装: C:\node 或当前用户目录下
        candidates.append(r"C:\node\node.exe")
    else:
        # nvm (Linux/macOS): ~/.nvm/versions/node/<version>/bin/node
        nvm_dir = os.path.join(os.path.expanduser("~"), ".nvm", "versions", "node")
        if os.path.isdir(nvm_dir):
            for entry in os.listdir(nvm_dir):
                candidates.append(os.path.join(nvm_dir, entry, "bin", "node"))
        # 常见系统路径
        for d in ("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"):
            candidates.append(d)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _find_local_node():
    if platform.system() == "Windows":
        local_node = os.path.join(_NODE_MSI_DIR, "nodejs", "node.exe")
        if os.path.isfile(local_node):
            return local_node
        local_node = os.path.join(_NODE_MSI_DIR, "node.exe")
    else:
        local_node = os.path.join(_NODE_MSI_DIR, "nodejs", "bin", "node")
        if os.path.isfile(local_node):
            return local_node
        local_node = os.path.join(_NODE_MSI_DIR, "bin", "node")
    if os.path.isfile(local_node):
        return local_node
    return None


def _get_node_path():
    system_node = _find_node()
    if system_node:
        # 找到 node 后，把 node 所在目录加入 PATH，
        # 以便同目录的 npm.cmd/npx.cmd 在后续 subprocess 中可被解析
        node_dir = os.path.dirname(system_node)
        if node_dir and node_dir not in os.environ.get("PATH", "").split(os.pathsep):
            os.environ["PATH"] = node_dir + os.pathsep + os.environ.get("PATH", "")
        return system_node
    local_node = _find_local_node()
    if local_node:
        node_dir = os.path.dirname(local_node)
        if node_dir and node_dir not in os.environ.get("PATH", "").split(os.pathsep):
            os.environ["PATH"] = node_dir + os.pathsep + os.environ.get("PATH", "")
        return local_node
    return None


def _find_npm():
    """在 node 所在目录或 PATH 中查找 npm/npm.cmd。
    Windows 上 npm 实际是 npm.cmd，需要显式匹配。"""
    node_path = _get_node_path()
    candidates = []
    if node_path:
        node_dir = os.path.dirname(node_path)
        # Windows: node.exe 同目录的 npm.cmd
        candidates.append(os.path.join(node_dir, "npm.cmd"))
        # nvm 安装时 npm.cmd 在 node.exe 同级
        candidates.append(os.path.join(node_dir, "..", "npm.cmd"))
    # 最后退化到 PATH
    candidates.append(shutil.which("npm") or shutil.which("npm.cmd") or "npm")
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return os.path.abspath(cand)
    return candidates[0] if candidates else "npm"


def _install_nodejs():
    print("=" * 60)
    print("📥 Node.js not found. Installing automatically...")
    print("=" * 60)

    os.makedirs(_NODE_MSI_DIR, exist_ok=True)

    system = platform.system()
    arch = platform.machine()

    if system == "Windows":
        _install_nodejs_windows(arch)
    elif system == "Darwin":
        _install_nodejs_macos(arch)
    else:
        _install_nodejs_linux(arch)

    node_path = _get_node_path()
    if node_path:
        print(f"✅ Node.js installed successfully: {node_path}")
        return node_path

    raise RuntimeError("Node.js installation completed but node binary not found")


def _install_nodejs_windows(arch):
    if arch in ("AMD64", "x86_64", "x64"):
        arch_label = "x64"
    elif arch in ("ARM64", "aarch64"):
        arch_label = "arm64"
    else:
        arch_label = "x64"

    msi_path = os.path.join(_NODE_MSI_DIR, "node-installer.msi")

    if not os.path.isfile(msi_path):
        version = _get_node_version()
        url = f"https://nodejs.org/dist/v{version}/node-v{version}-{arch_label}.msi"
        print(f"⬇️  Downloading Node.js v{version} ({arch_label})...")
        print(f"   URL: {url}")

        try:
            urllib.request.urlretrieve(url, msi_path)
            print("✅ Download completed")
        except Exception as e:
            if os.path.isfile(msi_path):
                os.remove(msi_path)
            raise RuntimeError(f"Failed to download Node.js: {e}")

    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")

    if not os.path.isfile(os.path.join(install_dir, "node.exe")):
        print("� Installing Node.js (MSI silent install)...")
        msiexec_cmd = [
            "msiexec",
            "/i", msi_path,
            f"INSTALLDIR={install_dir}",
            "/qn",
            "/norestart",
        ]

        try:
            result = subprocess.run(
                msiexec_cmd,
                capture_output=True,
                text=True,
                timeout=int(os.environ.get("MSI_INSTALL_TIMEOUT", "300")),
            )
            if result.returncode != 0:
                print(f"⚠️  MSI install returned code {result.returncode}, trying zip method...")
                _install_nodejs_windows_zip(arch_label)
                return
        except subprocess.TimeoutExpired:
            print("⚠️  MSI install timed out, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
            return
        except Exception as e:
            print(f"⚠️  MSI install failed: {e}, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
            return

        if os.path.isfile(os.path.join(install_dir, "node.exe")):
            npm_path = os.path.join(install_dir, "npm.cmd")
            _ensure_npm_cmd(npm_path, install_dir)
            _add_to_path(install_dir)
            print(f"✅ Node.js installed to: {install_dir}")
        else:
            print("⚠️  MSI install did not produce expected files, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
    else:
        print(f"✅ Node.js already installed at: {install_dir}")


def _install_nodejs_windows_zip(arch_label):
    version = _get_node_version()
    zip_name = f"node-v{version}-win-{arch_label}"
    zip_url = f"https://nodejs.org/dist/v{version}/{zip_name}.zip"
    zip_path = os.path.join(_NODE_MSI_DIR, f"{zip_name}.zip")
    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")

    print(f"⬇️  Downloading Node.js v{version} zip ({arch_label})...")
    print(f"   URL: {zip_url}")

    try:
        urllib.request.urlretrieve(zip_url, zip_path)
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download Node.js zip: {e}")

    print("📦 Extracting Node.js...")
    import zipfile
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(_NODE_MSI_DIR)

    extracted_dir = os.path.join(_NODE_MSI_DIR, zip_name)
    if os.path.isdir(extracted_dir) and not os.path.isdir(install_dir):
        shutil.move(extracted_dir, install_dir)
    elif os.path.isdir(extracted_dir):
        shutil.copytree(extracted_dir, install_dir, dirs_exist_ok=True)
        shutil.rmtree(extracted_dir, ignore_errors=True)

    if os.path.isfile(zip_path):
        os.remove(zip_path)

    if os.path.isfile(os.path.join(install_dir, "node.exe")):
        npm_path = os.path.join(install_dir, "npm.cmd")
        _ensure_npm_cmd(npm_path, install_dir)
        _add_to_path(install_dir)
        print(f"✅ Node.js installed to: {install_dir}")
    else:
        raise RuntimeError("Node.js zip extraction did not produce expected files")


def _ensure_npm_cmd(npm_path, install_dir):
    if not os.path.isfile(npm_path):
        npm_script = os.path.join(install_dir, "node_modules", "npm", "bin", "npm-cli.js")
        if os.path.isfile(npm_script):
            with open(npm_path, 'w') as f:
                f.write(f'@"{os.path.join(install_dir, "node.exe")}" "{npm_script}" %*\n')
            print(f"✅ Created npm.cmd at: {npm_path}")


def _add_to_path(install_dir):
    os.environ["PATH"] = install_dir + os.pathsep + os.environ.get("PATH", "")


def _install_nodejs_macos(arch):
    if arch == "arm64":
        pkg_arch = "arm64"
    else:
        pkg_arch = "x64"

    version = _get_node_version()
    tar_name = f"node-v{version}-darwin-{pkg_arch}"
    tar_url = f"https://nodejs.org/dist/v{version}/{tar_name}.tar.gz"
    tar_path = os.path.join(_NODE_MSI_DIR, f"{tar_name}.tar.gz")
    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")

    print(f"⬇️  Downloading Node.js v{version} ({pkg_arch})...")
    print(f"   URL: {tar_url}")

    try:
        urllib.request.urlretrieve(tar_url, tar_path)
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")

    print("📦 Extracting Node.js...")
    import tarfile
    with tarfile.open(tar_path, 'r:gz') as tf:
        tf.extractall(_NODE_MSI_DIR)

    extracted_dir = os.path.join(_NODE_MSI_DIR, tar_name)
    if os.path.isdir(extracted_dir) and not os.path.isdir(install_dir):
        shutil.move(extracted_dir, install_dir)
    elif os.path.isdir(extracted_dir):
        shutil.copytree(extracted_dir, install_dir, dirs_exist_ok=True)
        shutil.rmtree(extracted_dir, ignore_errors=True)

    if os.path.isfile(tar_path):
        os.remove(tar_path)

    bin_dir = os.path.join(install_dir, "bin")
    if os.path.isfile(os.path.join(bin_dir, "node")):
        _add_to_path(bin_dir)
        print(f"✅ Node.js installed to: {install_dir}")
    else:
        raise RuntimeError("Node.js extraction did not produce expected files")


def _install_nodejs_linux(arch):
    if arch == "aarch64":
        pkg_arch = "arm64"
    elif arch == "armv7l":
        pkg_arch = "armv7l"
    else:
        pkg_arch = "x64"

    version = _get_node_version()
    tar_name = f"node-v{version}-linux-{pkg_arch}"
    tar_url = f"https://nodejs.org/dist/v{version}/{tar_name}.tar.xz"
    tar_path = os.path.join(_NODE_MSI_DIR, f"{tar_name}.tar.xz")
    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")

    print(f"⬇️  Downloading Node.js v{version} ({pkg_arch})...")
    print(f"   URL: {tar_url}")

    try:
        urllib.request.urlretrieve(tar_url, tar_path)
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")

    print("📦 Extracting Node.js...")
    import tarfile
    with tarfile.open(tar_path, 'r:xz') as tf:
        tf.extractall(_NODE_MSI_DIR)

    extracted_dir = os.path.join(_NODE_MSI_DIR, tar_name)
    if os.path.isdir(extracted_dir) and not os.path.isdir(install_dir):
        shutil.move(extracted_dir, install_dir)
    elif os.path.isdir(extracted_dir):
        shutil.copytree(extracted_dir, install_dir, dirs_exist_ok=True)
        shutil.rmtree(extracted_dir, ignore_errors=True)

    if os.path.isfile(tar_path):
        os.remove(tar_path)

    bin_dir = os.path.join(install_dir, "bin")
    if os.path.isfile(os.path.join(bin_dir, "node")):
        _add_to_path(bin_dir)
        print(f"✅ Node.js installed to: {install_dir}")
    else:
        raise RuntimeError("Node.js extraction did not produce expected files")


def _run_npm(args, cwd):
    """调用 npm 工具，使用找到的完整路径，实时输出日志。"""
    npm_path = _find_npm()
    if not npm_path or (npm_path == "npm" and not shutil.which("npm") and not shutil.which("npm.cmd")):
        raise FileNotFoundError("npm not found")
    cmd = [npm_path] + list(args)
    return subprocess.run(cmd, cwd=cwd, check=False)


def _ensure_dependencies(sga_dir):
    node_modules = os.path.join(sga_dir, "node_modules")
    if not os.path.exists(node_modules):
        print("📦 Installing dependencies for sga_template (this may take a while)...")
        try:
            result = _run_npm(["install", "--no-audit", "--no-fund"], cwd=sga_dir)
            if result.returncode != 0:
                raise RuntimeError(f"npm install failed with exit code {result.returncode}")
            print("✅ Dependencies installed successfully")
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise
        except Exception as e:
            print(f"❌ Failed to install dependencies: {e}")
            raise


def _build_if_needed(sga_dir):
    dist_dir = os.path.join(sga_dir, "dist")
    if not os.path.exists(dist_dir):
        print("🔨 Building sga_template...")
        try:
            result = _run_npm(["run", "build"], cwd=sga_dir)
            if result.returncode != 0:
                raise RuntimeError(f"npm run build failed with exit code {result.returncode}")
            print("✅ Build completed successfully")
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise
        except Exception as e:
            print(f"❌ Failed to build: {e}")
            raise


def _ensure_ui_dependencies(ui_dir):
    node_modules = os.path.join(ui_dir, "node_modules")
    if not os.path.exists(node_modules):
        print("📦 Installing dependencies for UI (this may take a while)...")
        try:
            result = _run_npm(["install", "--no-audit", "--no-fund"], cwd=ui_dir)
            if result.returncode != 0:
                raise RuntimeError(f"npm install failed with exit code {result.returncode}")
            print("✅ UI dependencies installed successfully")
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise
        except Exception as e:
            print(f"❌ Failed to install UI dependencies: {e}")
            raise


def _build_ui_if_needed(ui_dir):
    web_dir = os.path.join(current_dir, "web")
    if not os.path.exists(web_dir) or not os.listdir(web_dir):
        print("🔨 Building UI (web folder not found or empty)...")
        try:
            _ensure_ui_dependencies(ui_dir)
            result = _run_npm(["run", "build"], cwd=ui_dir)
            if result.returncode != 0:
                raise RuntimeError(f"npm run build failed with exit code {result.returncode}")
            print("✅ UI build completed successfully")
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise
        except Exception as e:
            print(f"❌ Failed to build UI: {e}")
            raise


def _ensure_mcp_config(sga_dir):
    import json
    sga_home = os.environ.get("SGA_HOME", os.path.join(os.path.expanduser("~"), ".sga"))
    os.makedirs(sga_home, exist_ok=True)
    mcp_config_path = os.path.join(sga_home, "mcp-servers.json")

    existing_configs = []
    if os.path.isfile(mcp_config_path):
        try:
            with open(mcp_config_path, "r", encoding="utf-8") as f:
                existing_configs = json.load(f)
        except Exception:
            existing_configs = []

    comfyui_entry = None
    for cfg in existing_configs:
        if cfg.get("name") == "comfyui-api":
            comfyui_entry = cfg
            break

    comfyui_port = os.environ.get("COMFYUI_PORT", "8188")
    comfyui_host = os.environ.get("COMFYUI_HOST", "127.0.0.1")
    comfyui_url = f"http://{comfyui_host}:{comfyui_port}"

    desired_entry = {
        "name": "comfyui-api",
        "transport": "streamable-http",
        "url": f"{comfyui_url}/mcp",
        "disabled": False,
        "alwaysAllow": ["*"],
        "restartOnFailure": True,
        "maxRestartAttempts": 3,
    }

    if comfyui_entry:
        needs_update = (
            comfyui_entry.get("url") != desired_entry["url"]
            or comfyui_entry.get("transport") != desired_entry["transport"]
        )
        if not needs_update:
            return
        comfyui_entry.update(desired_entry)
    else:
        existing_configs.append(desired_entry)

    try:
        with open(mcp_config_path, "w", encoding="utf-8") as f:
            json.dump(existing_configs, f, indent=2, ensure_ascii=False)
        print(f"✅ MCP config updated: {mcp_config_path}")
    except Exception as e:
        print(f"⚠️  Failed to write MCP config: {e}")


# ---- Codex 子模块 (v0.4) ----

def _get_codex_dir():
    """codex/ 子模块目录, 在 current_dir/codex/."""
    return os.path.join(current_dir, "codex")


def _get_codex_binary_path():
    """探测 codex binary 路径 (与 src/agents/codex/detect.ts 同策略).

    探测顺序:
      1. process.env.CODEX_BINARY
      2. <root>/codex/target/{release,debug}/{codex.exe,codex.cmd}
      3. OpenAI Codex 官方自动安装目录:
         - Windows: %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<hash>\\codex.exe
                    %APPDATA%\\OpenAI\\Codex\\bin\\<hash>\\codex.exe
         - macOS:   ~/Library/Application Support/com.openai.codex/bin/<hash>/codex
         - Linux:   ~/.local/share/openai/codex/bin/<hash>/codex
      4. PATH 中 codex / codex.exe / codex.cmd
    """
    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        return explicit

    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        is_windows = platform.system() == "Windows"
        names = ["codex.exe", "codex.cmd"] if is_windows else ["codex"]
        for profile in ("release", "debug"):
            for name in names:
                p = os.path.join(codex_dir, "target", profile, name)
                if os.path.isfile(p):
                    return p
        # 自动下载的 binary
        for name in names:
            p = os.path.join(codex_dir, "bin", name)
            if os.path.isfile(p):
                return p

    # OpenAI Codex 官方自动安装路径
    official = _find_official_codex_binary()
    if official:
        return official

    # PATH 兜底
    for name in (["codex.exe", "codex.cmd"] if platform.system() == "Windows" else ["codex"]):
        hit = shutil.which(name)
        if hit and os.path.isfile(hit):
            return hit
    return None


def _find_official_codex_binary():
    """在 OpenAI Codex 官方自动安装目录中查找 binary.

    选 mtime 最新的子目录里的 codex[.exe].
    """
    is_win = platform.system() == "Windows"
    is_mac = platform.system() == "Darwin"

    if is_win:
        localappdata = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local"
        )
        appdata = os.environ.get("APPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming"
        )
        candidates = [
            os.path.join(localappdata, "OpenAI", "Codex", "bin"),
            os.path.join(appdata, "OpenAI", "Codex", "bin"),
            os.path.join(localappdata, "Programs", "OpenAI", "Codex", "resources"),
            os.path.join(appdata, "Codex", "bin"),
        ]
        names = ("codex.exe", "codex.cmd")
    elif is_mac:
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, "Library", "Application Support", "com.openai.codex", "bin"),
            os.path.join(home, "Library", "Application Support", "OpenAI", "Codex", "bin"),
            "/usr/local/bin/codex",
            "/opt/homebrew/bin/codex",
        ]
        names = ("codex",)
    else:
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, ".local", "share", "openai", "codex", "bin"),
            os.path.join(home, ".local", "share", "OpenAI", "Codex", "bin"),
            "/usr/local/bin/codex",
            "/usr/bin/codex",
        ]
        names = ("codex",)

    best_path = None
    best_mtime = -1.0
    for bin_root in candidates:
        if not os.path.isdir(bin_root):
            continue
        try:
            for sub in os.listdir(bin_root):
                sub_dir = os.path.join(bin_root, sub)
                if not os.path.isdir(sub_dir):
                    continue
                try:
                    mtime = os.path.getmtime(sub_dir)
                except OSError:
                    continue
                if mtime <= best_mtime:
                    continue
                for n in names:
                    cand = os.path.join(sub_dir, n)
                    if os.path.isfile(cand):
                        best_path = cand
                        best_mtime = mtime
                        break
        except OSError:
            continue
    return best_path


def _get_codex_download_url():
    """构造当前平台的 codex 预编译 binary 下载 URL.

    优先级:
      1. CODEX_DOWNLOAD_URL env — 直接指向 binary 的完整 URL
      2. CODEX_RELEASE_URL env — releases 基础 URL, 自动拼接平台文件名
      3. codex/download-url.txt — 仓库内配置文件, 内容为 releases 基础 URL
      4. 默认 GitHub Releases (可被仓库维护者修改)

    平台文件名:
      Windows x64 → codex-windows-x64.exe
      macOS arm64 → codex-darwin-arm64
      macOS x64   → codex-darwin-x64
      Linux x64   → codex-linux-x64
    """
    # 1. 完整 URL
    explicit = os.environ.get("CODEX_DOWNLOAD_URL")
    if explicit:
        return explicit

    # 2. releases 基础 URL from env
    release_base = os.environ.get("CODEX_RELEASE_URL")

    # 3. releases 基础 URL from file
    if not release_base:
        url_file = os.path.join(_get_codex_dir(), "download-url.txt")
        if os.path.isfile(url_file):
            try:
                with open(url_file, "r", encoding="utf-8") as f:
                    release_base = f.read().strip()
            except Exception:
                pass

    # 4. 默认 (仓库维护者可修改此 URL)
    if not release_base:
        release_base = "https://github.com/25315/comfy_workflow_agent/releases/download/codex-v0.1.0"

    # 拼接平台文件名
    system = platform.system()
    machine = platform.machine().lower()

    if system == "Windows":
        filename = "codex-windows-x64.exe"
    elif system == "Darwin":
        if "arm" in machine or "aarch64" in machine:
            filename = "codex-darwin-arm64"
        else:
            filename = "codex-darwin-x64"
    else:
        filename = "codex-linux-x64"

    return f"{release_base.rstrip('/')}/{filename}"


def _download_codex_binary():
    """自动下载预编译 codex binary. 不阻塞 SGA 启动.

    下载到 codex/bin/codex[.exe], 下载后验证 --version.
    失败时返回 None, 成功返回 binary 路径.
    """
    import urllib.request
    import zipfile
    import tempfile

    url = _get_codex_download_url()
    codex_bin_dir = os.path.join(_get_codex_dir(), "bin")
    os.makedirs(codex_bin_dir, exist_ok=True)

    is_windows = platform.system() == "Windows"
    binary_name = "codex.exe" if is_windows else "codex"
    dest_path = os.path.join(codex_bin_dir, binary_name)

    print(f"⬇️  正在下载 Codex binary...")
    print(f"   URL: {url}")
    print(f"   目标: {dest_path}")

    try:
        # 60 秒超时
        req = urllib.request.Request(url, headers={
            "User-Agent": os.environ.get("SGA_USER_AGENT", "ComfyUI-Codex-Agent/1.0"),
        })
        with urllib.request.urlopen(req, timeout=int(os.environ.get("CODEX_DOWNLOAD_TIMEOUT", "60"))) as resp:
            total = resp.getheader("Content-Length")
            total_str = f" ({int(total) / (1024 * 1024):.1f} MB)" if total else ""
            print(f"   响应: {resp.status}{total_str}")

            with open(dest_path, "wb") as f:
                # 分块下载, 显示进度
                downloaded = 0
                chunk_size = 64 * 1024  # 64KB
                last_pct = -1
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = int(downloaded * 100 / int(total))
                        if pct >= last_pct + 10:
                            last_pct = pct
                            print(f"   进度: {pct}% ({downloaded // (1024*1024)} MB)", flush=True)

        # Unix 设置可执行权限
        if not is_windows:
            os.chmod(dest_path, 0o755)

        # 验证 binary
        try:
            result = subprocess.run(
                [dest_path, "--version"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                version = result.stdout.strip()[:100]
                print(f"✅ 下载验证成功: {version}")
            else:
                print(f"⚠️  下载完成但 --version 返回非零 (exit={result.returncode})")
        except Exception as e:
            print(f"⚠️  下载完成但验证失败: {e}")

        return dest_path

    except urllib.error.HTTPError as e:
        print(f"❌ 下载失败: HTTP {e.code} {e.reason}")
        if e.code == 404:
            print(f"   该平台可能暂无预编译版本. 请手动编译:")
            print(f"     .\\scripts\\build-codex.ps1")
        # 清理不完整文件
        if os.path.isfile(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
        return None
    except Exception as e:
        print(f"❌ 下载失败: {e}")
        if os.path.isfile(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
        return None


def _build_codex_with_cargo():
    """用 cargo build 编译 codex binary. 下载失败时的 fallback.

    需要 Rust 工具链 (cargo) + MSVC (Windows).
    编译到 codex/target/release/codex[.exe], 编译后验证.
    成功返回 binary 路径, 失败返回 None.
    """
    codex_dir = _get_codex_dir()
    codex_rs_dir = os.path.join(codex_dir, "codex-rs")
    cargo_toml = os.path.join(codex_rs_dir, "Cargo.toml")

    # 1. 检查源码存在
    if not os.path.isfile(cargo_toml):
        print("❌ codex/codex-rs/Cargo.toml 不存在, 无法编译")
        return None

    # 2. 检查 cargo 可用
    cargo_bin = shutil.which("cargo")
    if not cargo_bin:
        print("❌ 未找到 cargo (Rust 工具链), 无法自动编译")
        print("   安装 Rust: https://rustup.rs/")
        return None

    print(f"🔧 找到 cargo: {cargo_bin}")
    print("   开始编译 (首次可能需要 5-15 分钟)...")
    print()

    # 3. cargo build --release -p codex-app-server
    is_windows = platform.system() == "Windows"
    exe_name = "codex.exe" if is_windows else "codex"
    expected_path = os.path.join(codex_dir, "target", "release", exe_name)

    try:
        result = subprocess.run(
            [cargo_bin, "build", "--release", "-p", "codex-app-server"],
            cwd=codex_rs_dir,
            timeout=int(os.environ.get("CARGO_BUILD_TIMEOUT", "1800")),  # 30 分钟超时
        )
        if result.returncode != 0:
            print(f"❌ cargo build 失败 (exit={result.returncode})")
            return None
    except subprocess.TimeoutExpired:
        print("❌ cargo build 超时 (30 分钟)")
        return None
    except FileNotFoundError:
        print("❌ cargo 命令不可用")
        return None

    # 4. 验证产物
    if not os.path.isfile(expected_path):
        print(f"❌ 编译完成但未找到产物: {expected_path}")
        return None

    size_mb = round(os.path.getsize(expected_path) / (1024 * 1024), 2)

    # 5. 验证 --version
    try:
        ver_result = subprocess.run(
            [expected_path, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if ver_result.returncode == 0:
            version = ver_result.stdout.strip()[:100]
            print(f"✅ 编译验证成功: {version}")
        else:
            print(f"⚠️  编译完成但 --version 返回非零")
    except Exception as e:
        print(f"⚠️  编译完成但验证失败: {e}")

    print(f"✅ Binary (本地编译): {expected_path}  ({size_mb} MB)")
    return expected_path


def _ensure_codex_binary():
    """探测 codex binary, 给用户清晰状态提示. 不阻塞 SGA 启动.

    行为:
    - binary 已存在: 打印 OK + 路径
    - binary 不存在: 自动下载预编译版本 (可跳过: CODEX_SKIP_DOWNLOAD=1)
    - 下载失败: 尝试 cargo build 本地编译
    - 编译也失败: 打印手动指引
    """
    print("=" * 60)
    print("📦 Codex 后端状态 (v0.6)")
    print("=" * 60)

    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        sub_rev_file = os.path.join(codex_dir, ".codex-revision")
        rev = None
        if os.path.isfile(sub_rev_file):
            try:
                with open(sub_rev_file, "r", encoding="utf-8") as f:
                    rev = f.read().strip()[:8]
            except Exception:
                rev = None
        rev_str = f" @ {rev}" if rev else ""
        print(f"📂 子模块: codex/{rev_str}")

    bin_path, source = _get_codex_binary_path_with_source()
    if bin_path:
        size_mb = round(os.path.getsize(bin_path) / (1024 * 1024), 2)
        source_label = {
            "env": "env 覆盖",
            "release": "本地 release 编译",
            "debug": "本地 debug 编译",
            "downloaded": "自动下载",
            "official": "OpenAI 官方预装",
            "path": "PATH 兜底",
        }.get(source, source)
        print(f"✅ Binary ({source_label}): {bin_path}  ({size_mb} MB)")
        print("   Codex 后端: 可用")
    else:
        # Step 1: 尝试自动下载
        skip_download = os.environ.get("CODEX_SKIP_DOWNLOAD", "").lower() in ("1", "true", "yes")
        if skip_download:
            print("⏭️  CODEX_SKIP_DOWNLOAD=1, 跳过自动下载")
        else:
            print("⚠️  Binary 未找到, 尝试自动下载预编译版本...")
            print()
            downloaded = _download_codex_binary()
            if downloaded:
                size_mb = round(os.path.getsize(downloaded) / (1024 * 1024), 2)
                print(f"✅ Binary (自动下载): {downloaded}  ({size_mb} MB)")
                print("   Codex 后端: 可用")
                print("=" * 60)
                return
            else:
                print()
                print("⚠️  自动下载失败")

        # Step 2: 下载失败 → 尝试 cargo build
        skip_build = os.environ.get("CODEX_SKIP_BUILD", "").lower() in ("1", "true", "yes")
        if skip_build:
            print("⏭️  CODEX_SKIP_BUILD=1, 跳过自动编译")
        else:
            print()
            print("🔧 尝试本地编译 (cargo build)...")
            print()
            built = _build_codex_with_cargo()
            if built:
                size_mb = round(os.path.getsize(built) / (1024 * 1024), 2)
                print(f"✅ Binary (本地编译): {built}  ({size_mb} MB)")
                print("   Codex 后端: 可用")
                print("=" * 60)
                return
            else:
                print()
                print("⚠️  本地编译失败")

        # Step 3: 全部失败 → 打印手动指引
        print()
        print("   手动方法 (任选其一):")
        print(f"     1. PowerShell:  .\\scripts\\build-codex.ps1")
        print(f"     2. 手动:  cd codex\\codex-rs && cargo build --release -p codex-app-server")
        print(f"     3. 安装 OpenAI Codex 桌面客户端 (自动探测)")
        print()
        print("   Codex 后端: 不可用 (SGA 后端正常工作, 不受影响)")
    print("=" * 60)


def _get_codex_binary_path_with_source():
    """返回 (path, source). source ∈ {env, release, debug, downloaded, official, path}.
    与 _get_codex_binary_path 同探测顺序, 但额外标注来源.
    """
    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        return explicit, "env"

    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        is_windows = platform.system() == "Windows"
        names = ["codex.exe", "codex.cmd"] if is_windows else ["codex"]
        for profile in ("release", "debug"):
            for name in names:
                p = os.path.join(codex_dir, "target", profile, name)
                if os.path.isfile(p):
                    return p, profile
        # 自动下载的 binary
        for name in names:
            p = os.path.join(codex_dir, "bin", name)
            if os.path.isfile(p):
                return p, "downloaded"

    official = _find_official_codex_binary()
    if official:
        return official, "official"

    for name in (["codex.exe", "codex.cmd"] if platform.system() == "Windows" else ["codex"]):
        hit = shutil.which(name)
        if hit and os.path.isfile(hit):
            return hit, "path"
    return None, None


def start_backend_server(host: str = "127.0.0.1", port: int = 8000):
    global _backend_process, _backend_server

    if _backend_process is not None:
        print("⚠️  Backend server is already running!")
        return _backend_server

    node_path = _get_node_path()

    if not node_path:
        try:
            node_path = _install_nodejs()
        except Exception as e:
            print(f"❌ Failed to install Node.js automatically: {e}")
            print("💡 Please install Node.js manually: https://nodejs.org/")
            return None

    sga_dir = os.path.join(current_dir, "sga_template")
    ui_dir = os.path.join(current_dir, "ui")

    if not os.path.isdir(sga_dir):
        print(f"❌ sga_template directory not found: {sga_dir}")
        return None

    try:
        _ensure_dependencies(sga_dir)
        _build_if_needed(sga_dir)
    except Exception as e:
        print(f"❌ Failed to prepare sga_template: {e}")
        return None

    if os.path.isdir(ui_dir):
        try:
            _build_ui_if_needed(ui_dir)
        except Exception as e:
            print(f"❌ Failed to build UI: {e}")
            print("⚠️  The backend will still start, but the web UI may not be available.")

    _ensure_mcp_config(sga_dir)

    # v0.4: 探测 codex binary 状态, 提示用户编译 (Sprint 2.1)
    _ensure_codex_binary()

    print("=" * 60)
    print("🚀 Starting ComfyUI Workflow Agent Backend Server (SGA)")
    print("=" * 60)
    print(f"📡 Host: {host}")
    print(f"🔌 Port: {port}")
    print(f"📚 API: http://{host}:{port}/api/health")
    print("=" * 60)

    import threading

    def run_server():
        try:
            env = os.environ.copy()
            env["PORT"] = str(port)
            env["HOST"] = host

            comfyui_root = os.path.dirname(os.path.dirname(os.path.dirname(current_dir)))
            if os.path.isfile(os.path.join(comfyui_root, "main.py")):
                env["COMFYUI_BASE_DIR"] = comfyui_root
            else:
                env["COMFYUI_BASE_DIR"] = current_dir

            # v0.4: 告诉 SGA codex 子模块在哪里 (项目根 = current_dir, 即含 codex/ 的目录)
            env["CODEX_PROJECT_ROOT"] = current_dir

            # 强制子进程输出 UTF-8，避免 Windows 上 GBK 解码失败
            env["PYTHONIOENCODING"] = "utf-8"
            env["LC_ALL"] = "C.UTF-8"

            _backend_process = subprocess.Popen(
                [node_path, "dist/server/main.js"],
                cwd=sga_dir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )

            print(f"✅ Backend server is running on http://{host}:{port}")
            print(f"⏰ Started at: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

            # 后台线程中读取并打印子进程输出，使用 errors='replace' 防止单行解码失败拖垮整个线程
            while True:
                line = _backend_process.stdout.readline()
                if not line:
                    break
                print(line, end="")

        except Exception as e:
            print(f"❌ Error starting SGA backend: {e}")
            import traceback
            traceback.print_exc()

    _backend_server = threading.Thread(target=run_server, daemon=True)
    _backend_server.start()

    print(f"🔄 Backend server thread started in background")
    print("=" * 60)

    return _backend_server


_start_backend_server = start_backend_server

import atexit


def _cleanup():
    global _backend_process, _backend_server
    if _backend_process is not None:
        print("🛑 Shutting down SGA backend server...")
        _backend_process.terminate()
        _backend_process = None
    if _backend_server is not None:
        print("🛑 Shutting down backend server...")


def _auto_start_backend():
    try:
        host, port = _get_sga_server_config()
        start_backend_server(host=host, port=port)
    except Exception as e:
        print(f"❌ ComfyUI Workflow Agent auto-start failed: {e}")
        import traceback
        traceback.print_exc()


print("=" * 60)
print("🚀 ComfyUI Workflow Agent - Initializing...")
print("=" * 60)
print(f"📂 Current directory: {current_dir}")
print(f"🌐 Web directory: {WEB_DIRECTORY}")
print("� Extension mode (no nodes)")
print("=" * 60)

_thread = threading.Thread(target=_auto_start_backend, daemon=True)
_thread.start()

atexit.register(_cleanup)
