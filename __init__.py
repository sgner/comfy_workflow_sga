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
    return shutil.which("node") or shutil.which("node.exe")


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
        return system_node
    local_node = _find_local_node()
    if local_node:
        return local_node
    return None


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
                timeout=300,
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


def _ensure_dependencies(sga_dir):
    node_modules = os.path.join(sga_dir, "node_modules")
    if not os.path.exists(node_modules):
        print("📦 Installing dependencies for sga_template...")
        try:
            subprocess.run(
                ["npm", "install"],
                cwd=sga_dir,
                check=True,
                capture_output=True,
                text=True,
            )
            print("✅ Dependencies installed successfully")
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to install dependencies: {e.stderr}")
            raise
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise


def _build_if_needed(sga_dir):
    dist_dir = os.path.join(sga_dir, "dist")
    if not os.path.exists(dist_dir):
        print("🔨 Building sga_template...")
        try:
            subprocess.run(
                ["npm", "run", "build"],
                cwd=sga_dir,
                check=True,
                capture_output=True,
                text=True,
            )
            print("✅ Build completed successfully")
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to build: {e.stderr}")
            raise
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise


def _ensure_ui_dependencies(ui_dir):
    node_modules = os.path.join(ui_dir, "node_modules")
    if not os.path.exists(node_modules):
        print("📦 Installing dependencies for UI...")
        try:
            subprocess.run(
                ["npm", "install"],
                cwd=ui_dir,
                check=True,
                capture_output=True,
                text=True,
            )
            print("✅ UI dependencies installed successfully")
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to install UI dependencies: {e.stderr}")
            raise
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
            raise


def _build_ui_if_needed(ui_dir):
    web_dir = os.path.join(current_dir, "web")
    if not os.path.exists(web_dir) or not os.listdir(web_dir):
        print("🔨 Building UI (web folder not found or empty)...")
        try:
            _ensure_ui_dependencies(ui_dir)
            subprocess.run(
                ["npm", "run", "build"],
                cwd=ui_dir,
                check=True,
                capture_output=True,
                text=True,
            )
            print("✅ UI build completed successfully")
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to build UI: {e.stderr}")
            raise
        except FileNotFoundError:
            print("❌ npm not found. Please install Node.js first.")
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

            _backend_process = subprocess.Popen(
                [node_path, "dist/server/main.js"],
                cwd=sga_dir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            print(f"✅ Backend server is running on http://{host}:{port}")
            print(f"⏰ Started at: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

            for line in _backend_process.stdout:
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
    host, port = _get_sga_server_config()
    start_backend_server(host=host, port=port)


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
