#!/usr/bin/env python3
"""
build_codex_worker.py - 后台编译 worker, 由 __init__.py 派生

职责:
  1. 跑 cargo build --release -p codex-app-server
  2. 解析 stdout/stderr 的 "Compiling X (N of M)" 进度
  3. 周期性把状态写到 BUILD_STATUS_FILE (JSON)
  4. 编译完成后把最终状态写入, 然后退出

环境变量 (由 __init__.py 传入):
  BUILD_STATUS_FILE: 状态 JSON 路径 (默认 <SGA_HOME>/codex-build.json)
  BUILD_LOG_FILE:    cargo 输出日志 (默认 <SGA_HOME>/codex-build.log)
  CODEX_RS_DIR:      codex-rs 源码路径
  CARGO_BIN:         cargo 可执行文件路径
  CARGO_BUILD_TIMEOUT: 超时秒数 (默认 1800)

退出码:
  0  - 成功
  1  - 失败 (cargo build 失败)
  2  - 异常 (环境错误, 无法启动 cargo 等)
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

# ---- 读环境变量 ----
STATUS_FILE = os.environ.get("BUILD_STATUS_FILE", "").strip()
LOG_FILE = os.environ.get("BUILD_LOG_FILE", "").strip()
CODEX_RS_DIR = os.environ.get("CODEX_RS_DIR", "").strip()
CARGO_BIN = os.environ.get("CARGO_BIN", "cargo").strip()
TIMEOUT_SEC = int(os.environ.get("CARGO_BUILD_TIMEOUT", "1800"))

# ---- 状态对象 ----
def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def write_status(state: dict) -> None:
    """原子写状态: 先写 .tmp, 再 rename 替换, 避免读到半截文件."""
    if not STATUS_FILE:
        return
    try:
        os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, STATUS_FILE)
    except Exception as e:
        # 写状态失败不影响 build 本身
        sys.stderr.write(f"[codex-worker] write_status failed: {e}\n")
        sys.stderr.flush()

def emit(state: dict) -> None:
    """同时写状态 + 打印到 stderr (供主进程日志看)."""
    write_status(state)
    msg = f"[codex-worker] status={state.get('status')}"
    if state.get("progress"):
        p = state["progress"]
        msg += f" progress={p.get('current')}/{p.get('total')} ({p.get('percent', 0):.1f}%) crate={p.get('current_crate')}"
    if state.get("error"):
        msg += f" error={state['error']}"
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()

# ---- 进度解析 ----
# cargo 的输出形如:
#    Compiling serde v1.0.123 (123 of 456)
#    Compiling tokio v1.0.0 (124 of 456)
# 我们从 "(N of M)" 提取 N / M, 从 "Compiling X" 提取 X
RE_COMPILING = re.compile(r"^\s*Compiling\s+([A-Za-z0-9_\-]+)(?:\s+v[0-9][^()]*)?\s*\((\d+)\s+of\s+(\d+)\)")

def parse_line(line: str):
    """匹配 cargo 进度行. 返回 (crate_name, current, total) 或 None."""
    m = RE_COMPILING.match(line)
    if m:
        return m.group(1), int(m.group(2)), int(m.group(3))
    return None

# ---- 主流程 ----
def main():
    if not STATUS_FILE or not CODEX_RS_DIR or not LOG_FILE:
        print("[codex-worker] missing required env vars", file=sys.stderr)
        sys.exit(2)

    # 初始化状态
    state = {
        "status": "building",
        "pid": os.getpid(),
        "started_at": now_iso(),
        "finished_at": None,
        "progress": {
            "current": 0,
            "total": 0,
            "current_crate": "",
            "percent": 0.0,
        },
        "log_file": LOG_FILE,
        "codex_dir": CODEX_RS_DIR,
        "error": None,
    }
    emit(state)

    if not os.path.isfile(os.path.join(CODEX_RS_DIR, "Cargo.toml")):
        state["status"] = "failed"
        state["error"] = f"codex-rs source not found: {CODEX_RS_DIR}"
        state["finished_at"] = now_iso()
        emit(state)
        sys.exit(2)

    # 打开日志文件 (用于 tail / UI 展开查看)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    except Exception:
        pass

    start_ts = time.time()
    last_update_ts = 0.0
    UPDATE_INTERVAL = 0.5  # 状态文件写盘间隔 (秒)

    try:
        with open(LOG_FILE, "ab", buffering=0) as logf:
            logf.write(f"\n=== codex build started at {now_iso()} (pid={os.getpid()}) ===\n".encode("utf-8"))

            proc = subprocess.Popen(
                [CARGO_BIN, "build", "--release", "-p", "codex-app-server"],
                cwd=CODEX_RS_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
                env={**os.environ, "CARGO_TERM_COLOR": "never"},
            )
            assert proc.stdout is not None

            for raw_line in proc.stdout:
                try:
                    line = raw_line.decode("utf-8", errors="replace")
                except Exception:
                    line = raw_line.decode("latin-1", errors="replace")

                # 写日志
                try:
                    logf.write(raw_line)
                except Exception:
                    pass

                # 解析进度
                m = parse_line(line)
                if m:
                    crate, cur, total = m
                    state["progress"]["current"] = cur
                    state["progress"]["total"] = total
                    state["progress"]["current_crate"] = crate
                    if total > 0:
                        state["progress"]["percent"] = round(100.0 * cur / total, 2)

                # 节流写状态
                now = time.time()
                if now - last_update_ts >= UPDATE_INTERVAL:
                    last_update_ts = now
                    emit(state)

            # 等待 cargo 结束
            try:
                rc = proc.wait(timeout=max(1, TIMEOUT_SEC - (time.time() - start_ts)))
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = -1
                state["error"] = f"cargo build timed out after {TIMEOUT_SEC}s"

            elapsed = round(time.time() - start_ts, 1)
            logf.write(f"\n=== codex build finished at {now_iso()} rc={rc} elapsed={elapsed}s ===\n".encode("utf-8"))

        if rc == 0 and state.get("error") is None:
            state["status"] = "success"
            state["progress"]["percent"] = 100.0
            state["progress"]["current_crate"] = "done"
        else:
            state["status"] = "failed"
            if not state.get("error"):
                state["error"] = f"cargo build exited with code {rc}"
        state["finished_at"] = now_iso()
        emit(state)
        sys.exit(0 if state["status"] == "success" else 1)

    except FileNotFoundError:
        state["status"] = "failed"
        state["error"] = f"cargo not found: {CARGO_BIN}"
        state["finished_at"] = now_iso()
        emit(state)
        sys.exit(2)
    except Exception as e:
        state["status"] = "failed"
        state["error"] = f"{type(e).__name__}: {e}"
        state["finished_at"] = now_iso()
        emit(state)
        sys.exit(2)


if __name__ == "__main__":
    main()
