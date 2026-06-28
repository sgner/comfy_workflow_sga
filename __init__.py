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
from datetime import datetime, timezone

current_dir = os.path.dirname(__file__)
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY", "start_backend_server"]

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_backend_process = None
_backend_server = None
_shutdown_requested = False
_start_lock = threading.Lock()
_SGA_ENV_CACHE = None

# SGA home directory for install lock and MCP config.
_SGA_HOME = os.environ.get("SGA_HOME") or os.path.join(os.path.expanduser("~"), ".sga")
_INSTALL_LOCK_PATH = os.path.join(_SGA_HOME, "install.lock")

# Node.js runtime path.
_NODE_MSI_DIR = os.path.join(current_dir, ".node-runtime")
_DEFAULT_NODE_VERSION = "20.18.0"

# Vendored Codex backend path.
_CODEX_RS_DIR = os.path.join(current_dir, "sga_template", "codex-rs")
_CODEX_BIN_NAME_WIN = "codex-app-server.exe"
_CODEX_BIN_NAME_UNIX = "codex-app-server"


# ---------------------------------------------------------------------------
# Cross-process install lock.
# ---------------------------------------------------------------------------
class _InstallLock:
    """Cross-process file lock using O_EXCL with stale lock cleanup.

    Prevent multiple ComfyUI processes from running npm install or cargo build at the same time.
    Defaults: timeout=1800s, stale_age=600s.
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
                # Check whether a previous process left a stale lock.
                try:
                    mtime = os.path.getmtime(self.path)
                    age = time.time() - mtime
                    if age > self.stale_age:
                        print(f"   鈿狅笍  Stale install lock ({int(age)}s old), removing...")
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
# Network retry helper with exponential backoff.
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
                print(f"   鈿狅笍  {label} attempt {i+1}/{attempts} failed: {e}")
                print(f"   鈴?retrying in {delay:.1f}s...")
                time.sleep(delay)
                delay *= backoff
    print(f"   鉂?{label} final failure: {last_err}")
    raise last_err


# ---------------------------------------------------------------------------
# Health check helpers.
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
    print(f"   鈿狅笍  {label} did not become healthy in {timeout}s (last error: {last_err})")
    return False


# ---------------------------------------------------------------------------
# .env 鍔犺浇
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
            print(f"   鈿狅笍  Failed to read .env: {e}")
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
# Node.js discovery and installation.
# ---------------------------------------------------------------------------
def _find_node():
    """Find node in PATH or common install directories."""
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
    """Find npm next to node or in PATH."""
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
    print("Node.js not found. Installing automatically...")
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
        print(f"鉁?Node.js installed successfully: {node_path}")
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
        print(f"猬囷笍  Downloading Node.js v{version} ({arch_label})...")
        print(f"   URL: {url}")
        try:
            _retry_with_backoff(
                lambda: urllib.request.urlretrieve(url, msi_path),
                attempts=3, base_delay=1.0, backoff=2.0,
                label="Node.js MSI download"
            )
            print("鉁?Download completed")
        except Exception as e:
            if os.path.isfile(msi_path):
                os.remove(msi_path)
            raise RuntimeError(f"Failed to download Node.js: {e}")

    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")
    if not os.path.isfile(os.path.join(install_dir, "node.exe")):
        print("馃摝 Installing Node.js (MSI silent install)...")
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
                print(f"鈿狅笍  MSI install returned code {result.returncode}, trying zip method...")
                _install_nodejs_windows_zip(arch_label)
                return
        except subprocess.TimeoutExpired:
            print("鈿狅笍  MSI install timed out, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
            return
        except Exception as e:
            print(f"鈿狅笍  MSI install failed: {e}, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
            return
        if os.path.isfile(os.path.join(install_dir, "node.exe")):
            npm_path = os.path.join(install_dir, "npm.cmd")
            _ensure_npm_cmd(npm_path, install_dir)
            _add_to_path(install_dir)
            print(f"鉁?Node.js installed to: {install_dir}")
        else:
            print("鈿狅笍  MSI install did not produce expected files, trying zip method...")
            _install_nodejs_windows_zip(arch_label)
    else:
        print(f"鉁?Node.js already installed at: {install_dir}")


def _install_nodejs_windows_zip(arch_label):
    version = _get_node_version()
    zip_name = f"node-v{version}-win-{arch_label}"
    zip_url = f"https://nodejs.org/dist/v{version}/{zip_name}.zip"
    zip_path = os.path.join(_NODE_MSI_DIR, f"{zip_name}.zip")
    install_dir = os.path.join(_NODE_MSI_DIR, "nodejs")
    print(f"猬囷笍  Downloading Node.js v{version} zip ({arch_label})...")
    print(f"   URL: {zip_url}")
    try:
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(zip_url, zip_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js zip download"
        )
        print("鉁?Download completed")
    except Exception as e:
        if os.path.isfile(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download Node.js zip: {e}")
    print("馃摝 Extracting Node.js...")
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
        print(f"鉁?Node.js installed to: {install_dir}")
    else:
        raise RuntimeError("Node.js zip extraction did not produce expected files")


def _ensure_npm_cmd(npm_path, install_dir):
    if not os.path.isfile(npm_path):
        npm_script = os.path.join(install_dir, "node_modules", "npm", "bin", "npm-cli.js")
        if os.path.isfile(npm_script):
            with open(npm_path, 'w') as f:
                f.write(f'@"{os.path.join(install_dir, "node.exe")}" "{npm_script}" %*\n')
            print(f"鉁?Created npm.cmd at: {npm_path}")


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
    print(f"猬囷笍  Downloading Node.js v{version} ({pkg_arch})...")
    print(f"   URL: {tar_url}")
    try:
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(tar_url, tar_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js download"
        )
        print("鉁?Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")
    print("馃摝 Extracting Node.js...")
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
        print(f"鉁?Node.js installed to: {install_dir}")
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
    print(f"猬囷笍  Downloading Node.js v{version} ({pkg_arch})...")
    print(f"   URL: {tar_url}")
    try:
        _retry_with_backoff(
            lambda: urllib.request.urlretrieve(tar_url, tar_path),
            attempts=3, base_delay=1.0, backoff=2.0,
            label="Node.js download"
        )
        print("鉁?Download completed")
    except Exception as e:
        if os.path.isfile(tar_path):
            os.remove(tar_path)
        raise RuntimeError(f"Failed to download Node.js: {e}")
    print("馃摝 Extracting Node.js...")
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
        print(f"鉁?Node.js installed to: {install_dir}")
    else:
        raise RuntimeError("Node.js extraction did not produce expected files")


# ---------------------------------------------------------------------------
# npm, UI install, and build helpers.
# ---------------------------------------------------------------------------
def _run_npm(args, cwd):
    """Run npm with the discovered executable path."""
    npm_path = _find_npm()
    if not npm_path or (npm_path == "npm" and not shutil.which("npm") and not shutil.which("npm.cmd")):
        raise FileNotFoundError("npm not found")
    cmd = [npm_path] + list(args)
    return subprocess.run(cmd, cwd=cwd, check=False)


def _ensure_dependencies(sga_dir):
    node_modules = os.path.join(sga_dir, "node_modules")
    if os.path.exists(node_modules):
        return
    print("馃摝 Installing dependencies for sga_template (this may take a while)...")
    try:
        result = _run_npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], cwd=sga_dir)
        if result.returncode != 0:
            raise RuntimeError(f"npm install failed with exit code {result.returncode}")
        print("鉁?Dependencies installed successfully")
    except FileNotFoundError:
        print("鉂?npm not found. Please install Node.js first.")
        raise
    except Exception as e:
        print(f"鉂?Failed to install dependencies: {e}")
        raise


def _build_if_needed(sga_dir):
    dist_dir = os.path.join(sga_dir, "dist")
    if os.path.exists(dist_dir):
        return
    print("馃敤 Building sga_template...")
    try:
        result = _run_npm(["run", "build"], cwd=sga_dir)
        if result.returncode != 0:
            raise RuntimeError(f"npm run build failed with exit code {result.returncode}")
        print("鉁?Build completed successfully")
    except FileNotFoundError:
        print("鉂?npm not found. Please install Node.js first.")
        raise
    except Exception as e:
        print(f"鉂?Failed to build: {e}")
        raise


def _ensure_ui_dependencies(ui_dir):
    node_modules = os.path.join(ui_dir, "node_modules")
    if os.path.exists(node_modules):
        return
    print("馃摝 Installing dependencies for UI (this may take a while)...")
    try:
        result = _run_npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], cwd=ui_dir)
        if result.returncode != 0:
            raise RuntimeError(f"npm install failed with exit code {result.returncode}")
        print("UI dependencies installed successfully")
    except FileNotFoundError:
        print("npm not found. Please install Node.js first.")
        raise
    except Exception as e:
        print(f"Failed to install UI dependencies: {e}")
        raise


def _build_ui_if_needed(ui_dir):
    web_dir = os.path.join(current_dir, "web")
    if os.path.exists(web_dir) and os.listdir(web_dir):
        return
    print("Building UI because the web folder is missing or empty...")
    try:
        _ensure_ui_dependencies(ui_dir)
        result = _run_npm(["run", "build"], cwd=ui_dir)
        if result.returncode != 0:
            raise RuntimeError(f"npm run build failed with exit code {result.returncode}")
        print("UI build completed successfully")
    except FileNotFoundError:
        print("npm not found. Please install Node.js first.")
        raise
    except Exception as e:
        print(f"Failed to build UI: {e}")
        raise


def _ensure_mcp_config(sga_dir):
    """Create or update mcp-servers.json with the ComfyUI MCP server."""
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
        print(f"MCP config updated: {mcp_config_path}")
    except Exception as e:
        print(f"Failed to write MCP config: {e}")


# ---------------------------------------------------------------------------
# Codex detection and build helpers.
# ---------------------------------------------------------------------------
def _get_codex_dir():
    """Return the vendored codex-rs directory."""
    return _CODEX_RS_DIR


def _is_windows():
    return platform.system() == "Windows"


def _get_codex_binary_names():
    """Return binary names to probe, ordered by preference."""
    is_win = _is_windows()
    return [_CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX,
            "codex.exe" if is_win else "codex"]


def _get_codex_binary_path_with_source():
    """Return (path, source) for the detected Codex backend binary."""
    # 1. Explicit CODEX_BINARY environment variable.
    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        return explicit, "env"

    # 2. Vendored build artifacts.
    codex_dir = _get_codex_dir()
    if os.path.isdir(codex_dir):
        for profile in ("release", "debug"):
            for bin_name in _get_codex_binary_names():
                p = os.path.join(codex_dir, "target", profile, bin_name)
                if os.path.isfile(p):
                    return p, profile

    # 3. OpenAI automatic install directories.
    official = _find_official_codex_binary()
    if official:
        return official, "official"

    # 4. PATH fallback.
    for bin_name in _get_codex_binary_names():
        hit = shutil.which(bin_name)
        if hit and os.path.isfile(hit):
            return hit, "path"
    return None, None


def _get_codex_binary_path():
    """Return the Codex backend binary path without source metadata."""
    p, _ = _get_codex_binary_path_with_source()
    return p


def _find_official_codex_binary():
    """Find a Codex backend binary in official OpenAI install directories."""
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
    """Synchronously build codex-app-server; normally use the background builder."""
    codex_rs_dir = _get_codex_dir()
    cargo_toml = os.path.join(codex_rs_dir, "Cargo.toml")
    if not os.path.isfile(cargo_toml):
        print(f"鉂?Vendored codex-rs not found: {cargo_toml}")
        print(f"   Please ensure sga_template/codex-rs/ is vendored")
        return None
    cargo_bin = shutil.which("cargo")
    if not cargo_bin:
        print("鉂?cargo not found (Rust toolchain required for auto-build)")
        print("   Install Rust: https://rustup.rs/")
        print("   Or run:  node scripts/build-codex.mjs --app-server")
        return None
    print(f"馃敡 Found cargo: {cargo_bin}")
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
            print(f"鉂?cargo build failed (exit={result.returncode})")
            return None
    except subprocess.TimeoutExpired:
        print(f"鉂?cargo build timed out ({timeout_sec}s)")
        return None
    except FileNotFoundError:
        print("鉂?cargo command unavailable")
        return None
    if not os.path.isfile(expected_path):
        print(f"鉂?Build completed but binary not found: {expected_path}")
        return None
    size_mb = round(os.path.getsize(expected_path) / (1024 * 1024), 2)
    try:
        ver_result = subprocess.run(
            [expected_path, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if ver_result.returncode == 0:
            version = ver_result.stdout.strip()[:100]
            print(f"鉁?Build verification: {version}")
        else:
            print("鈿狅笍  Build completed but --version returned non-zero")
    except Exception as e:
        print(f"鈿狅笍  Build completed but verification failed: {e}")
    print(f"鉁?Binary (local build): {expected_path}  ({size_mb} MB)")
    return expected_path


# Codex backend build status files for SGA and UI.
_CODEX_BUILD_STATUS_FILE = os.path.join(_SGA_HOME, "codex-build.json")
_CODEX_BUILD_LOG_FILE = os.path.join(_SGA_HOME, "codex-build.log")


def _read_codex_build_status():
    """Read Codex build status JSON; return None when unavailable."""
    try:
        if not os.path.isfile(_CODEX_BUILD_STATUS_FILE):
            return None
        with open(_CODEX_BUILD_STATUS_FILE, "r", encoding="utf-8") as f:
            return json.loads(f.read())
    except Exception:
        return None


def _is_codex_build_alive():
    """Return True when a Codex cargo build appears to be running.
    A build is considered active when status is building or pending and the PID is alive.
    """
    st = _read_codex_build_status()
    if not st:
        return False
    if st.get("status") not in ("building", "pending"):
        return False
    pid = st.get("pid")
    if not pid:
        return False
    # Cross-platform liveness probe.
    try:
        if _is_windows():
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            h = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
            )
            if not h:
                return False
            try:
                code = ctypes.c_ulong()
                ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
                return code.value == STILL_ACTIVE
            finally:
                ctypes.windll.kernel32.CloseHandle(h)
        else:
            os.kill(int(pid), 0)
            return True
    except Exception:
        return False


def _start_codex_build_background():
    """Start cargo build in a detached background process without blocking ComfyUI.

    Progress is written to:
      - <SGA_HOME>/codex-build.json for status reads.
      - <SGA_HOME>/codex-build.log for cargo output.
    Process behavior:
      - CREATE_NEW_PROCESS_GROUP detaches from the current console.
      - DETACHED_PROCESS disconnects stdin/stdout on Windows.
    """
    codex_rs_dir = _get_codex_dir()
    cargo_toml = os.path.join(codex_rs_dir, "Cargo.toml")
    cargo_bin = shutil.which("cargo")
    if not cargo_toml or not os.path.isfile(cargo_toml):
        print("Vendored codex-rs not found; skipping background build")
        return None
    if not cargo_bin:
        print("cargo not found; skipping background build")
        print("   Install Rust: https://rustup.rs/")
        return None

    # Do not start a duplicate build when one is already running.
    if _is_codex_build_alive():
        print("Codex build already in progress; skipping restart")
        print(f"   Status: {_CODEX_BUILD_STATUS_FILE}")
        return None

    # Ensure SGA_HOME exists.
    os.makedirs(_SGA_HOME, exist_ok=True)

    worker_script = os.path.join(current_dir, "scripts", "build_codex_worker.py")
    if not os.path.isfile(worker_script):
        print(f"Worker script not found: {worker_script}")
        return None

    # Prepare worker environment.
    env = os.environ.copy()
    env["BUILD_STATUS_FILE"] = _CODEX_BUILD_STATUS_FILE
    env["BUILD_LOG_FILE"] = _CODEX_BUILD_LOG_FILE
    env["CODEX_RS_DIR"] = codex_rs_dir
    env["CARGO_BIN"] = cargo_bin
    if "CARGO_BUILD_TIMEOUT" not in env:
        env["CARGO_BUILD_TIMEOUT"] = "1800"

    # Clear stale status file; the worker writes a fresh one.
    try:
        if os.path.isfile(_CODEX_BUILD_STATUS_FILE):
            os.remove(_CODEX_BUILD_STATUS_FILE)
    except Exception:
        pass

    # Spawn the background worker.
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "env": env,
        "close_fds": True,
    }
    if _is_windows():
        # Detach from the console so Ctrl+C does not stop the worker.
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen([sys.executable, worker_script], **kwargs)
    except Exception as e:
        print(f"Failed to start background build: {e}")
        return None

    # Write initial status so UI can show progress before the worker starts.
    initial_status = {
        "status": "pending",
        "pid": proc.pid,
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "finished_at": None,
        "progress": {"current": 0, "total": 0, "current_crate": "starting...", "percent": 0.0},
        "log_file": _CODEX_BUILD_LOG_FILE,
        "codex_dir": codex_rs_dir,
        "error": None,
    }
    try:
        with open(_CODEX_BUILD_STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(initial_status, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

    print(f"馃敡 Background build started (pid={proc.pid})")
    print(f"   Status: {_CODEX_BUILD_STATUS_FILE}")
    print(f"   Log:    {_CODEX_BUILD_LOG_FILE}")
    print(f"   Use:    GET /api/codex/build-status  to poll progress")
    print(f"   Or in UI: progress card will appear automatically")
    return proc.pid


def _ensure_codex_binary():
    """Detect Codex backend availability without blocking ComfyUI startup.

    If vendored source is present but no binary exists, start cargo build in the background.
    ComfyUI startup continues while the UI can poll build status.


    Detection priority:
      1. CODEX_BINARY environment override.
      2. Vendored build artifacts.
      3. Official OpenAI install directories.
      4. PATH fallback.
    """
    print("=" * 60)
    print("Codex backend status: vendored optional backend")
    print("=" * 60)
    codex_dir = _get_codex_dir()
    has_vendored_source = False
    if os.path.isdir(codex_dir):
        cargo_toml = os.path.join(codex_dir, "Cargo.toml")
        if os.path.isfile(cargo_toml):
            has_vendored_source = True
            print(f"Vendored Codex source: {os.path.relpath(codex_dir, current_dir)}")

    # 1. Explicit environment override.
    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        size_mb = round(os.path.getsize(explicit) / (1024 * 1024), 2)
        print(f"Binary (env override): {explicit}  ({size_mb} MB)")
        print("   Codex backend: available")
        print("=" * 60)
        return

    # 2. Vendored build artifacts.
    vendored_bin = None
    vendored_profile = None
    if has_vendored_source:
        is_win = _is_windows()
        for profile in ("release", "debug"):
            for bin_name in (_CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX,
                             "codex.exe" if is_win else "codex"):
                p = os.path.join(codex_dir, "target", profile, bin_name)
                if os.path.isfile(p):
                    vendored_bin = p
                    vendored_profile = profile
                    break
            if vendored_bin:
                break

    if vendored_bin:
        size_mb = round(os.path.getsize(vendored_bin) / (1024 * 1024), 2)
        print(f"Binary (local {vendored_profile} build): {vendored_bin}  ({size_mb} MB)")
        print("   Codex backend: available")
        print("=" * 60)
        return

    # Start background cargo build when vendored source exists but no binary is built.
    skip_build = os.environ.get("CODEX_SKIP_BUILD", "").lower() in ("1", "true", "yes")
    if has_vendored_source and not skip_build:
        print("Vendored source present, but local binary is not built yet")
        print("Starting background build; ComfyUI startup continues")
        print()
        build_pid = _start_codex_build_background()
        if build_pid:
            print()
            print(f"   Background build started (pid={build_pid})")
            print("   UI will show progress automatically")
            print(f"   Status file: {_CODEX_BUILD_STATUS_FILE}")
            print(f"   Log file:    {_CODEX_BUILD_LOG_FILE}")
            print()
            print("   Codex backend: building in background (5-20 min first time)")
            print("   SGA backend is still starting up; you can use SGA agent now.")
            print("   Switch to Codex in UI when build completes.")
        else:
            print("   Failed to start background build; falling back to other sources...")
        print("=" * 60)
        return

    # 3. Official OpenAI install directories.
    official = _find_official_codex_binary()
    if official:
        size_mb = round(os.path.getsize(official) / (1024 * 1024), 2)
        print(f"鉁?Binary (OpenAI official install): {official}  ({size_mb} MB)")
        print("   Codex backend: available (using official binary)")
        if has_vendored_source:
            print("   Tip: build local vendored for full feature support:")
            print("        node scripts\\build-codex.mjs --app-server")
        print("=" * 60)
        return

    # 4. PATH 鍏滃簳
    is_win = _is_windows()
    for bin_name in (_CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX,
                     "codex.exe" if is_win else "codex"):
        hit = shutil.which(bin_name)
        if hit and os.path.isfile(hit):
            size_mb = round(os.path.getsize(hit) / (1024 * 1024), 2)
            print(f"鉁?Binary (PATH): {hit}  ({size_mb} MB)")
            print("   Codex backend: available")
            print("=" * 60)
            return

    # 鍏ㄩ儴閮芥病鏈?
    print("鉂?Codex binary not found")
    print()
    if has_vendored_source and skip_build:
        print("   Vendored source present, CODEX_SKIP_BUILD=1 set.")
        print("   Unset CODEX_SKIP_BUILD or build manually:")
    elif has_vendored_source:
        print("   Vendored source found, but build failed.")
        print("   Try manually:")
    else:
        print("   Vendored source NOT found.")
        print("   Options:")
    print("     1. Node script:  node scripts\\build-codex.mjs --app-server")
    print("     2. PowerShell:  .\\scripts\\build-codex.ps1")
    print("     3. Manual:  cd sga_template\\codex-rs && cargo build --release -p codex-app-server")
    print("     4. Install OpenAI Codex desktop client (auto-detected)")
    print()
    print("   Codex backend: unavailable (SGA backend still works normally)")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Backend startup, monitoring, and restart.
# ---------------------------------------------------------------------------
def _build_backend_env(host, port):
    """Build environment variables for the SGA backend process."""
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

    - Maximum SGA_MAX_RESTARTS restarts within five minutes; default is 3.
    - Restart delay increases as 2s, 4s, 6s.
    - 娴佸紡杞?彂 stdout/stderr (UTF-8 + errors='replace')
    - Exit gracefully after atexit sets _shutdown_requested=True.
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
            print(f"鉁?Backend started (PID {proc.pid}) at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                print(line, end="", flush=True)
            exit_code = proc.wait()
            print(f"鈿狅笍  Backend exited (code={exit_code}) at {datetime.now().strftime('%H:%M:%S')}")
        except Exception as e:
            print(f"鉂?Error in backend monitor: {e}")
            traceback.print_exc()
        if _shutdown_requested:
            break
        now = time.time()
        restart_times = [t for t in restart_times if now - t < restart_window]
        if len(restart_times) >= max_restarts:
            print(f"鉂?Backend crashed {max_restarts} times in {restart_window}s, giving up")
            break
        restart_times.append(now)
        delay = 2 * len(restart_times)
        print(f"馃攧 Restarting backend in {delay}s ({len(restart_times)}/{max_restarts})...")
        time.sleep(delay)
    _backend_process = None


def start_backend_server(host: str = "127.0.0.1", port: int = 8000):
    """(P0/P1) 鍚?姩 SGA 鍚庣?.

    鏀硅繘:
    - (P1) 闃叉?澶?ComfyUI 杩涚▼骞跺彂瀹夎? (file lock)
    - (P1) 鍚?姩鍚庣瓑寰?/api/health 閫氳繃鎵嶈繑鍥?
    - (P1) SGA 宕╂簝鍚庤嚜鍔ㄩ噸鍚?(5 鍒嗛挓鍐呮渶澶?3 娆?
    - (P0) Codex 璺?緞宸蹭慨姝ｄ负 vendored sga_template/codex-rs/
    """
    global _backend_server
    with _start_lock:
        if _backend_server is not None and _backend_server.is_alive():
            print("鈿狅笍  Backend server is already running!")
            return _backend_server

        # 1. Node.js
        node_path = _get_node_path()
        if not node_path:
            try:
                node_path = _install_nodejs()
            except Exception as e:
                print(f"鉂?Failed to install Node.js automatically: {e}")
                print("馃挕 Please install Node.js manually: https://nodejs.org/")
                return None

        sga_dir = os.path.join(current_dir, "sga_template")
        ui_dir = os.path.join(current_dir, "ui")
        if not os.path.isdir(sga_dir):
            print(f"鉂?sga_template directory not found: {sga_dir}")
            return None

        # 2. (P1) 鍏ㄩ儴瀹夎?姝ラ?鐢?install lock 鍖呰９
        try:
            with _acquire_install_lock():
                try:
                    _ensure_dependencies(sga_dir)
                    _build_if_needed(sga_dir)
                except Exception as e:
                    print(f"鉂?Failed to prepare sga_template: {e}")
                    return None
                if os.path.isdir(ui_dir):
                    try:
                        _build_ui_if_needed(ui_dir)
                    except Exception as e:
                        print(f"鉂?Failed to build UI: {e}")
                        print("鈿狅笍  The backend will still start, but the web UI may not be available.")
        except TimeoutError as e:
            print(f"鉂?{e}")
            print("   Another ComfyUI process may be installing dependencies, please retry")
            return None

        _ensure_mcp_config(sga_dir)
        _ensure_codex_binary()

        print("=" * 60)
        print("馃殌 Starting ComfyUI Workflow Agent Backend Server (SGA)")
        print("=" * 60)
        print(f"馃摗 Host: {host}")
        print(f"馃攲 Port: {port}")
        print(f"馃摎 API: http://{host}:{port}/api/health")
        print("=" * 60)

        env = _build_backend_env(host, port)
        _backend_server = threading.Thread(
            target=_monitor_backend,
            args=(node_path, sga_dir, host, port, env),
            daemon=True,
        )
        _backend_server.start()

        # 3. Wait until the backend is healthy.
        print("Waiting for backend to be healthy...")
        if _wait_for_health(host, port, timeout=30, label="SGA backend"):
            print(f"SGA backend is READY at http://{host}:{port}")
        else:
            print("鈿狅笍  SGA backend did not become ready in 30s, but process is running")
            print("   Please check the logs above")
        print("=" * 60)
        return _backend_server


_start_backend_server = start_backend_server


# ---------------------------------------------------------------------------
# 杩涚▼娓呯悊
# ---------------------------------------------------------------------------
def _cleanup():
    global _backend_process, _backend_server, _shutdown_requested
    _shutdown_requested = True
    if _backend_process is not None:
        print("馃洃 Shutting down SGA backend server...")
        try:
            _backend_process.terminate()
            try:
                _backend_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _backend_process.kill()
        except Exception as e:
            print(f"   鈿狅笍  termination failed: {e}")
        _backend_process = None
    if _backend_server is not None:
        # daemon thread will exit on its own
        _backend_server = None


# ---------------------------------------------------------------------------
# 妯″潡鍔犺浇鏃惰嚜鍔ㄥ惎鍔?
# ---------------------------------------------------------------------------
def _auto_start_backend():
    try:
        host, port = _get_sga_server_config()
        start_backend_server(host=host, port=port)
    except Exception as e:
        print(f"鉂?ComfyUI Workflow Agent auto-start failed: {e}")
        traceback.print_exc()



def _ensure_codex_binary():
    """Report optional Codex capability without blocking SGA startup."""
    print("=" * 60)
    print("Codex backend status (optional capability)")
    print("=" * 60)

    enable_codex = os.environ.get("SGA_ENABLE_CODEX", "auto").strip().lower() or "auto"
    if enable_codex == "false":
        print("Codex backend: disabled by SGA_ENABLE_CODEX=false")
        print("SGA backend will start normally.")
        print("=" * 60)
        return

    codex_dir = _get_codex_dir()
    cargo_toml = os.path.join(codex_dir, "Cargo.toml")
    has_vendored_source = os.path.isfile(cargo_toml)
    if has_vendored_source:
        print(f"Vendored source: {os.path.relpath(codex_dir, current_dir)}")
    else:
        print("Vendored source: not found")

    explicit = os.environ.get("CODEX_BINARY")
    if explicit and os.path.isfile(explicit):
        print("Codex binary: found via CODEX_BINARY")
        print("Codex backend: ready")
        print("=" * 60)
        return

    is_win = _is_windows()
    binary_name = _CODEX_BIN_NAME_WIN if is_win else _CODEX_BIN_NAME_UNIX
    for profile in ("release", "debug"):
        vendored_bin = os.path.join(codex_dir, "target", profile, binary_name)
        if os.path.isfile(vendored_bin):
            size_mb = round(os.path.getsize(vendored_bin) / (1024 * 1024), 2)
            print(f"Codex binary: found local {profile} build ({size_mb} MB)")
            print("Codex backend: ready")
            print("=" * 60)
            return

    skip_build = os.environ.get("CODEX_SKIP_BUILD", "").strip().lower() in ("1", "true", "yes")
    if has_vendored_source and not skip_build:
        if _is_codex_build_alive():
            print("Codex backend: building")
            print("A background build is already running.")
        else:
            print("Codex backend: source-present")
            print("Starting background build. SGA startup will not wait for it.")
            build_pid = _start_codex_build_background()
            if build_pid:
                print(f"Background build started (pid={build_pid}).")
            else:
                print("Background build could not be started.")
        print("SGA backend will start normally; switch to Codex after it is ready.")
        print("=" * 60)
        return

    if has_vendored_source and skip_build:
        print("Codex backend: source-present")
        print("CODEX_SKIP_BUILD=1 is set, so no background build was started.")
    else:
        print("Codex backend: unavailable")
        print("No compatible vendored codex-app-server binary was found.")
    print("SGA backend will start normally.")
    print("To enable Codex later, build with: node scripts\\build-codex.mjs --app-server")
    print("=" * 60)


def _monitor_backend(node_path, sga_dir, host, port, env):
    """Run backend with auto-restart and readable logs."""
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
            print(f"[OK] Backend started (PID {proc.pid}) at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                print(line, end="", flush=True)
            exit_code = proc.wait()
            print(f"[WARN] Backend exited (code={exit_code}) at {datetime.now().strftime('%H:%M:%S')}")
        except Exception as e:
            print(f"[ERROR] Backend monitor failed: {e}")
            traceback.print_exc()
        if _shutdown_requested:
            break
        now = time.time()
        restart_times = [t for t in restart_times if now - t < restart_window]
        if len(restart_times) >= max_restarts:
            print(f"[ERROR] Backend crashed {max_restarts} times in {restart_window}s; giving up")
            break
        restart_times.append(now)
        delay = 2 * len(restart_times)
        print(f"[INFO] Restarting backend in {delay}s ({len(restart_times)}/{max_restarts})...")
        time.sleep(delay)
    _backend_process = None


def start_backend_server(host: str = "127.0.0.1", port: int = 8000):
    """Start the SGA backend. Codex readiness is optional and non-blocking."""
    global _backend_server
    with _start_lock:
        if _backend_server is not None and _backend_server.is_alive():
            print("[WARN] Backend server is already running.")
            return _backend_server

        node_path = _get_node_path()
        if not node_path:
            try:
                node_path = _install_nodejs()
            except Exception as e:
                print(f"[ERROR] Failed to install Node.js automatically: {e}")
                print("Please install Node.js manually: https://nodejs.org/")
                return None

        sga_dir = os.path.join(current_dir, "sga_template")
        ui_dir = os.path.join(current_dir, "ui")
        if not os.path.isdir(sga_dir):
            print(f"[ERROR] sga_template directory not found: {sga_dir}")
            return None

        try:
            with _acquire_install_lock():
                try:
                    _ensure_dependencies(sga_dir)
                    _build_if_needed(sga_dir)
                except Exception as e:
                    print(f"[ERROR] Failed to prepare sga_template: {e}")
                    return None
                if os.path.isdir(ui_dir):
                    try:
                        _build_ui_if_needed(ui_dir)
                    except Exception as e:
                        print(f"[WARN] Failed to build UI: {e}")
                        print("The backend will still start, but the web UI may be unavailable.")
        except TimeoutError as e:
            print(f"[ERROR] {e}")
            print("Another ComfyUI process may be installing dependencies; please retry later.")
            return None

        _ensure_mcp_config(sga_dir)
        _ensure_codex_binary()

        print("=" * 60)
        print("Starting ComfyUI Workflow Agent Backend Server (SGA)")
        print("=" * 60)
        print(f"Host: {host}")
        print(f"Port: {port}")
        print(f"Health API: http://{host}:{port}/api/health")
        print("=" * 60)

        env = _build_backend_env(host, port)
        _backend_server = threading.Thread(
            target=_monitor_backend,
            args=(node_path, sga_dir, host, port, env),
            daemon=True,
        )
        _backend_server.start()

        print("Waiting for backend health check...")
        if _wait_for_health(host, port, timeout=30, label="SGA backend"):
            print(f"[OK] SGA backend is ready at http://{host}:{port}")
        else:
            print("[WARN] SGA backend did not become ready in 30s, but the process is running.")
            print("Check the logs above for details.")
        print("=" * 60)
        return _backend_server


_start_backend_server = start_backend_server


def _cleanup():
    global _backend_process, _backend_server, _shutdown_requested
    _shutdown_requested = True
    if _backend_process is not None:
        print("Shutting down SGA backend server...")
        try:
            _backend_process.terminate()
            try:
                _backend_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _backend_process.kill()
        except Exception as e:
            print(f"   [WARN] Termination failed: {e}")
        _backend_process = None
    if _backend_server is not None:
        _backend_server = None


def _auto_start_backend():
    try:
        host, port = _get_sga_server_config()
        start_backend_server(host=host, port=port)
    except Exception as e:
        print(f"[ERROR] ComfyUI Workflow Agent auto-start failed: {e}")
        traceback.print_exc()


print("=" * 60)
print("ComfyUI Workflow Agent - Initializing...")
print("=" * 60)
print(f"Current directory: {current_dir}")
print(f"Web directory: {WEB_DIRECTORY}")
print("Extension mode: no custom ComfyUI nodes are registered")
print("=" * 60)

_thread = threading.Thread(target=_auto_start_backend, daemon=True)
_thread.start()

atexit.register(_cleanup)
