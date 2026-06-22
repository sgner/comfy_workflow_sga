import sys
import os
import subprocess
import shutil
import platform
import urllib.request
import tempfile
import threading
import time
import json
import tarfile
import zipfile
import traceback
import atexit
from datetime import datetime

current_dir = os.path.dirname(__file__)
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY", "start_backend_server"]

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
_backend_process = None
_backend_server = None
_shutdown_requested = False
_start_lock = threading.Lock()
_SGA_ENV_CACHE = None

# SGA 主目录 (用于 install lock, MCP config 等)
_SGA_HOME = os.environ.get("SGA_HOME") or os.path.join(os.path.expanduser("~"), ".sga")
_INSTALL_LOCK_PATH = os.path.join(_SGA_HOME, "install.lock")

# Node.js 路径
_NODE_MSI_DIR = os.path.join(current_dir, ".node-runtime")
_DEFAULT_NODE_VERSION = "20.18.0"

# (P0) Codex vendored 路径
_CODEX_RS_DIR = os.path.join(current_dir, "sga_template", "codex-rs")
_CODEX_BIN_NAME_WIN = "codex-app-server.exe"
_CODEX_BIN_NAME_UNIX = "codex-app-server"


# ---------------------------------------------------------------------------
# (P1) 工具: 跨进程文件锁
# ---------------------------------------------------------------------------
class _InstallLock:
    """跨进程文件锁, 用 O_EXCL 原子创建 + stale 检测.

    防止多个 ComfyUI 进程同时跑 npm install / cargo build.
    默认 timeout=1800s, stale_age=600s.
    """

    def __init__(self, path, timeout=1800, stale_age=600):
        self.path = path
        self.timeout = timeout
        self.stale_age = stale_age
        self.held = False

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        deadline = time.time() + self.timeout
        while True:
            try:
                content = f"pid={os.getpid()}\nstart={int(time.time())}\n".encode()
                fd = os.open(self.path, os.O_EXCL | os.O_CREAT | os.O_WRONLY, 0o644)
                try:
                    os.write(fd, content)
                finally:
                    os.close(fd)
                self.held = True
                return self
            except FileExistsError:
                # 检查是否 stale (前次进程崩溃)
                try:
                    mtime = os.path.getmtime(self.path)
                    age = time.time() - mtime
                    if age > self.stale_age:
                        print(f"   ⚠️  Stale install lock ({int(age)}s old), removing...")
                        try:
                            os.remove(self.path)
                        except OSError:
                            pass
                        continue
                except OSError:
                    pass
                if time.time() > deadline:
                    raise TimeoutError(f"install lock not acquired in {self.timeout}s")
                time.sleep(0.5)

    def __exit__(self, *args):
        if self.held:
            try:
                os.remove(self.path)
            except OSError:
                pass
            self.held = False


def _acquire_install_lock():
    return _InstallLock(_INSTALL_LOCK_PATH)


# ---------------------------------------------------------------------------
# (P1) 工具: 网络操作重试 + 指数退避
# ---------------------------------------------------------------------------
def _retry_with_backoff(fn, *, attempts=3, base_delay=1.0, backoff=2.0, label="operation"):
    """Call fn() with retry and exponential backoff. fn should be a 0-arg callable."""
    delay = base_delay
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if i < attempts - 1:
                print(f"   ⚠️  {label} attempt {i+1}/{attempts} failed: {e}")
                print(f"   ⏳ retrying in {delay:.1f}s...")
                time.sleep(delay)
                delay *= backoff
    print(f"   ❌ {label} final failure: {last_err}")
    raise last_err


# ---------------------------------------------------------------------------
# (P1) 工具: 健康检查
# ---------------------------------------------------------------------------
def _wait_for_health(host, port, *, timeout=30, interval=0.5, label="Backend"):
    """Poll http://host:port/api/health until 200 or timeout."""
    url = f"http://{host}:{port}/api/health"
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except Exception as e:
            last_err = e
        time.sleep(interval)
    print(f"   ⚠️  {label} did not become healthy in {timeout}s (last error: {last_err})")
    return False


# ---------------------------------------------------------------------------
# .env 加载
# ---------------------------------------------------------------------------
def _load_env_from_sga():
    global _SGA_ENV_CACHE
    if _SGA_ENV_CACHE is not None:
        return _SGA_ENV_CACHE
    sga_env_path = os.path.join(current_dir, "sga_template", ".env")
    env_vars = {}
    if os.path.isfile(sga_env_path):
        try:
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
        except Exception as e:
            print(f"   ⚠️  Failed to read .env: {e}")
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


# ---------------------------------------------------------------------------
# Node.js 查找 + 安装
# ---------------------------------------------------------------------------
def _find_node():
    """在 PATH 中查找 node，找不到时再在常见安装目录搜索。"""
    n = shutil.which("node") or shutil.which("node.exe")
    if n:
        return n
    candidates = []
    if platform.system() == "Windows":
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
        for pf in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
            if pf:
                candidates.append(os.path.join(pf, "nodejs", "node.exe"))
        candidates.append(r"C:\node\node.exe")
    else:
        nvm_dir = os.path.join(os.path.expanduser("~"), ".nvm", "versions", "node")
        if os.path.isdir(nvm_dir):
            for entry in os.listdir(nvm_dir):
                candidates.append(os.path.join(nvm_dir, entry, "bin", "node"))
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
    """在 node 所在目录或 PATH 中查找 npm/npm.cmd。"""
    node_path = _get_node_path()
    candidates = []
    if node_path:
        node_dir = os.path.dirname(node_path)
        candidates.append(os.path.join(node_dir, "npm.cmd"))
        candidates.append(os.path.join(node_dir, "..", "npm.cmd"))
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
            _retry_with_backoff(
                lambda: urllib.request.urlretrieve(url, msi_path),
                attempts=3, base_delay=1.0, backoff=2.0,
                label="Node.js MSI download"
            )
            print("✅ Download completed")
        except Exception as e:
            if os.path.isfile(msi_path):
                os.remove(msi_path)
            raise RuntimeError(f"Failed to download Node.js: {e}")

    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")
    if not os.path.isfile(os.path.join(install_dir, "node.exe")):
        print("📦 Installing Node.js (MSI silent install)...")
        msiexec_cmd = [
            "msiexec", "/i", msi_path,
            f"INSTALLDIR={install_dir}", "/qn", "/norestart",
        ]
        try:
            result = subprocess.run(
                msiexec_cmd, capture_output=True, text=True,
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
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(zip_url, zip_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js zip download"
        )
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download Node.js zip: {e}")
    print("📦 Extracting Node.js...")
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
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(tar_url, tar_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js download"
        )
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")
    print("📦 Extracting Node.js...")
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
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(tar_url, tar_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js download"
        )
        print("✅ Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")
    print("📦 Extracting Node.js...")
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


# ---------------------------------------------------------------------------
# npm / 依赖安装 / 构建
# ---------------------------------------------------------------------------
def _run_npm(args, cwd):
    """调用 npm 工具，使用找到的完整路径。"""
    npm_path = _find_npm()
    if not npm_path or (npm_path == "npm" and not shutil.which("npm") and not shutil.which("npm.cmd")):
        raise FileNotFoundError("npm not found")
    cmd = [npm_path] + list(args)
    return subprocess.run(cmd, cwd=cwd, check=False)


def _ensure_dependencies(sga_dir):
    node_modules = os.path.join(sga_dir, "node_modules")
    if os.path.exists(node_modules):
        return
    print("📦 Installing dependencies for sga_template (this may take a while)...")
    try:
        result = _run_npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], cwd=sga_dir)
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
    if os.path.exists(dist_dir):
        return
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
    if os.path.exists(node_modules):
        return
    print("📦 Installing dependencies for UI (this may take a while)...")
    try:
        result = _run_npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], cwd=ui_dir)
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
    if os.path.exists(web_dir) and os.listdir(web_dir):
        return
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
    """生成/更新 mcp-servers.json, 把 ComfyUI 自身作为 MCP server."""
    os.makedirs(_SGA_HOME, exist_ok=True)
    mcp_config_path = os.path.join(_SGA_HOME, "mcp-servers.json")
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


# ---------------------------------------------------------------------------
# (P0) Codex 探测 + 编译
# ---------------------------------------------------------------------------
def _get_codex_dir():
    """(P0) 返回 vendored codex-rs 目录: sga_template/codex-rs/"""
    return _CODEX_RS_DIR


def _is_windows():
    return platform.system() == "Windows"


def _get_codex_binary_names():
    """返回要探测的 binary 名字列表 (按优先级)."""
    is_win = _is_windows()
    return [_CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX,
            "codex.exe" if is_win else "codex"]


def _get_codex_binary_path_with_source():
    """(P0) 返回 (path, source). source ∈ {env, release, debug, official, path}."""
    # 1. 环境变量 CODEX_BINARY
    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        return explicit, "env"

    # 2. (P0) vendored 编译产物
    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        for profile in ("release", "debug"):
            for bin_name in _get_codex_binary_names():
                p = os.path.join(codex_dir, "target", profile, bin_name)
                if os.path.isfile(p):
                    return p, profile

    # 3. OpenAI 官方自动安装目录
    official = _find_official_codex_binary()
    if official:
        return official, "official"

    # 4. PATH 兜底
    for bin_name in _get_codex_binary_names():
        hit = shutil.which(bin_name)
        if hit and os.path.isfile(hit):
            return hit, "path"
    return None, None


def _get_codex_binary_path():
    """与 _get_codex_binary_path_with_source 同探测顺序, 不返回 source."""
    p, _ = _get_codex_binary_path_with_source()
    return p


def _find_official_codex_binary():
    """在 OpenAI Codex 官方自动安装目录中查找 binary."""
    is_win = _is_windows()
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
        names = (_CODEX_BIN_NAME_WIN, "codex.exe", "codex.cmd")
    elif is_mac:
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, "Library", "Application Support", "com.openai.codex", "bin"),
            os.path.join(home, "Library", "Application Support", "OpenAI", "Codex", "bin"),
            "/usr/local/bin/codex",
            "/opt/homebrew/bin/codex",
        ]
        names = (_CODEX_BIN_NAME_UNIX, "codex")
    else:
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, ".local", "share", "openai", "codex", "bin"),
            os.path.join(home, ".local", "share", "OpenAI", "Codex", "bin"),
            "/usr/local/bin/codex",
            "/usr/bin/codex",
        ]
        names = (_CODEX_BIN_NAME_UNIX, "codex")
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


def _build_codex_with_cargo():
    """(P0) 用 cargo build 编译 codex-app-server binary (从 vendored source).

    需要 Rust 工具链 (cargo) + MSVC (Windows).
    成功返回 binary 路径, 失败返回 None.
    """
    codex_rs_dir = _get_codex_dir()
    cargo_toml = os.path.join(codex_rs_dir, "Cargo.toml")
    if not os.path.isfile(cargo_toml):
        print(f"❌ Vendored codex-rs not found: {cargo_toml}")
        print(f"   Please ensure sga_template/codex-rs/ is vendored")
        return None
    cargo_bin = shutil.which("cargo")
    if not cargo_bin:
        print("❌ cargo not found (Rust toolchain required for auto-build)")
        print("   Install Rust: https://rustup.rs/")
        print("   Or run:  node scripts/build-codex.mjs --app-server")
        return None
    print(f"🔧 Found cargo: {cargo_bin}")
    print(f"   Source: {os.path.relpath(codex_rs_dir, current_dir)}")
    print("   Building (first time 5-20 min, incremental 30s-3min)...")
    print()
    is_win = _is_windows()
    expected_path = os.path.join(
        codex_rs_dir, "target", "release",
        _CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX
    )
    timeout_sec = int(os.environ.get("CARGO_BUILD_TIMEOUT", "1800"))
    try:
        result = subprocess.run(
            [cargo_bin, "build", "--release", "-p", "codex-app-server"],
            cwd=codex_rs_dir,
            timeout=timeout_sec,
        )
        if result.returncode != 0:
            print(f"❌ cargo build failed (exit={result.returncode})")
            return None
    except subprocess.TimeoutExpired:
        print(f"❌ cargo build timed out ({timeout_sec}s)")
        return None
    except FileNotFoundError:
        print("❌ cargo command unavailable")
        return None
    if not os.path.isfile(expected_path):
        print(f"❌ Build completed but binary not found: {expected_path}")
        return None
    size_mb = round(os.path.getsize(expected_path) / (1024 * 1024), 2)
    try:
        ver_result = subprocess.run(
            [expected_path, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if ver_result.returncode == 0:
            version = ver_result.stdout.strip()[:100]
            print(f"✅ Build verification: {version}")
        else:
            print("⚠️  Build completed but --version returned non-zero")
    except Exception as e:
        print(f"⚠️  Build completed but verification failed: {e}")
    print(f"✅ Binary (local build): {expected_path}  ({size_mb} MB)")
    return expected_path


def _ensure_codex_binary():
    """(P0) 探测 codex binary, 给用户清晰状态提示. 不阻塞 SGA 启动.

    vendor 后流程: 探测 → cargo build (无下载步骤, 有源码直接编译)
    """
    print("=" * 60)
    print("📦 Codex backend status (P0: vendored)")
    print("=" * 60)
    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        cargo_toml = os.path.join(codex_dir, "Cargo.toml")
        if os.path.isfile(cargo_toml):
            print(f"📂 Vendored: {os.path.relpath(codex_dir, current_dir)}")
    bin_path, source = _get_codex_binary_path_with_source()
    if bin_path:
        size_mb = round(os.path.getsize(bin_path) / (1024 * 1024), 2)
        source_label = {
            "env": "env override",
            "release": "local release build",
            "debug": "local debug build",
            "official": "OpenAI official install",
            "path": "PATH fallback",
        }.get(source, source)
        print(f"✅ Binary ({source_label}): {bin_path}  ({size_mb} MB)")
        print("   Codex backend: available")
    else:
        skip_build = os.environ.get("CODEX_SKIP_BUILD", "").lower() in ("1", "true", "yes")
        if skip_build:
            print("⏭️  CODEX_SKIP_BUILD=1, skipping auto-build")
        else:
            print("⚠️  Binary not found, attempting local build (cargo build)...")
            print()
            built = _build_codex_with_cargo()
            if built:
                size_mb = round(os.path.getsize(built) / (1024 * 1024), 2)
                print(f"✅ Binary (local build): {built}  ({size_mb} MB)")
                print("   Codex backend: available")
                print("=" * 60)
                return
            else:
                print()
                print("⚠️  Local build failed")
        print()
        print("   Manual options:")
        print("     1. Node script:  node scripts\\build-codex.mjs --app-server")
        print("     2. PowerShell:  .\\scripts\\build-codex.ps1")
        print("     3. Manual:  cd sga_template\\codex-rs && cargo build --release -p codex-app-server")
        print("     4. Install OpenAI Codex desktop client (auto-detected)")
        print()
        print("   Codex backend: unavailable (SGA backend still works normally)")
    print("=" * 60)


# ---------------------------------------------------------------------------
# (P1) Backend 启动 + 监控 + 自动重启
# ---------------------------------------------------------------------------
def _build_backend_env(host, port):
    """构造 SGA backend 进程的环境变量."""
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["HOST"] = host
    comfyui_root = os.path.dirname(os.path.dirname(os.path.dirname(current_dir)))
    if os.path.isfile(os.path.join(comfyui_root, "main.py")):
        env["COMFYUI_BASE_DIR"] = comfyui_root
    else:
        env["COMFYUI_BASE_DIR"] = current_dir
    env["CODEX_PROJECT_ROOT"] = current_dir
    env["PYTHONIOENCODING"] = "utf-8"
    env["LC_ALL"] = "C.UTF-8"
    return env


def _monitor_backend(node_path, sga_dir, host, port, env):
    """(P1) Run backend with auto-restart.

    - 5 分钟内最多 SGA_MAX_RESTARTS (默认 3) 次重启
    - 重启间隔递增: 2s, 4s, 6s
    - 流式转发 stdout/stderr (UTF-8 + errors='replace')
    - atexit 时 _shutdown_requested=True 后优雅退出
    """
    global _backend_process
    max_restarts = int(os.environ.get("SGA_MAX_RESTARTS", "3"))
    restart_window = int(os.environ.get("SGA_RESTART_WINDOW", "300"))
    restart_times = []
    while not _shutdown_requested:
        env_full = env.copy()
        env_full["PORT"] = str(port)
        env_full["HOST"] = host
        try:
            proc = subprocess.Popen(
                [node_path, "dist/server/main.js"],
                cwd=sga_dir, env=env_full,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
            )
            _backend_process = proc
            print(f"✅ Backend started (PID {proc.pid}) at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                print(line, end="", flush=True)
            exit_code = proc.wait()
            print(f"⚠️  Backend exited (code={exit_code}) at {datetime.now().strftime('%H:%M:%S')}")
        except Exception as e:
            print(f"❌ Error in backend monitor: {e}")
            traceback.print_exc()
        if _shutdown_requested:
            break
        now = time.time()
        restart_times = [t for t in restart_times if now - t < restart_window]
        if len(restart_times) >= max_restarts:
            print(f"❌ Backend crashed {max_restarts} times in {restart_window}s, giving up")
            break
        restart_times.append(now)
        delay = 2 * len(restart_times)
        print(f"🔄 Restarting backend in {delay}s ({len(restart_times)}/{max_restarts})...")
        time.sleep(delay)
    _backend_process = None


def start_backend_server(host: str = "127.0.0.1", port: int = 8000):
    """(P0/P1) 启动 SGA 后端.

    改进:
    - (P1) 防止多 ComfyUI 进程并发安装 (file lock)
    - (P1) 启动后等待 /api/health 通过才返回
    - (P1) SGA 崩溃后自动重启 (5 分钟内最多 3 次)
    - (P0) Codex 路径已修正为 vendored sga_template/codex-rs/
    """
    global _backend_server
    with _start_lock:
        if _backend_server is not None and _backend_server.is_alive():
            print("⚠️  Backend server is already running!")
            return _backend_server

        # 1. Node.js
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

        # 2. (P1) 全部安装步骤用 install lock 包裹
        try:
            with _acquire_install_lock():
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
        except TimeoutError as e:
            print(f"❌ {e}")
            print("   Another ComfyUI process may be installing dependencies, please retry")
            return None

        _ensure_mcp_config(sga_dir)
        _ensure_codex_binary()

        print("=" * 60)
        print("🚀 Starting ComfyUI Workflow Agent Backend Server (SGA)")
        print("=" * 60)
        print(f"📡 Host: {host}")
        print(f"🔌 Port: {port}")
        print(f"📚 API: http://{host}:{port}/api/health")
        print("=" * 60)

        env = _build_backend_env(host, port)
        _backend_server = threading.Thread(
            target=_monitor_backend,
            args=(node_path, sga_dir, host, port, env),
            daemon=True,
        )
        _backend_server.start()

        # 3. (P1) 健康检查: 等待 backend 真正就绪
        print("⏳ Waiting for backend to be healthy...")
        if _wait_for_health(host, port, timeout=30, label="SGA backend"):
            print(f"✅ SGA backend is READY at http://{host}:{port}")
        else:
            print("⚠️  SGA backend did not become ready in 30s, but process is running")
            print("   Please check the logs above")
        print("=" * 60)
        return _backend_server


_start_backend_server = start_backend_server


# ---------------------------------------------------------------------------
# 进程清理
# ---------------------------------------------------------------------------
def _cleanup():
    global _backend_process, _backend_server, _shutdown_requested
    _shutdown_requested = True
    if _backend_process is not None:
        print("🛑 Shutting down SGA backend server...")
        try:
            _backend_process.terminate()
            try:
                _backend_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _backend_process.kill()
        except Exception as e:
            print(f"   ⚠️  termination failed: {e}")
        _backend_process = None
    if _backend_server is not None:
        # daemon thread will exit on its own
        _backend_server = None


# ---------------------------------------------------------------------------
# 模块加载时自动启动
# ---------------------------------------------------------------------------
def _auto_start_backend():
    try:
        host, port = _get_sga_server_config()
        start_backend_server(host=host, port=port)
    except Exception as e:
        print(f"❌ ComfyUI Workflow Agent auto-start failed: {e}")
        traceback.print_exc()


print("=" * 60)
print("🚀 ComfyUI Workflow Agent - Initializing...")
print("=" * 60)
print(f"📂 Current directory: {current_dir}")
print(f"🌐 Web directory: {WEB_DIRECTORY}")
print("📦 Extension mode (no nodes)")
print("=" * 60)

_thread = threading.Thread(target=_auto_start_backend, daemon=True)
_thread.start()

atexit.register(_cleanup)
