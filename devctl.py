"""
devctl.py — Claude Chat Development Controller
Manages both the Python chat server (port 8090)
and the LiteLLM proxy server (port 5000).

Usage:
    python devctl.py start   [chat|proxy|all]
    python devctl.py stop    [chat|proxy|all]
    python devctl.py restart [chat|proxy|all]
    python devctl.py status
    python devctl.py logs    [chat|proxy|all] [-g TERM] [--level LEVEL]
    python devctl.py clean
    python devctl.py help

Default target is "all" if omitted.
"""

import os
import sys
import time
import signal
import socket
import subprocess
import shutil
from pathlib import Path
from datetime import datetime, timedelta

# ─── Configuration ─────────────────────────────────
CHAT_DIR = Path(__file__).parent.resolve()
CHAT_PORT = int(os.environ.get("CHAT_PORT", 8090))
CHAT_SCRIPT = CHAT_DIR / "server.py"
CHAT_LOG = CHAT_DIR / "data" / "chat-server.log"

PROXY_DIR = Path(os.environ.get("LITELLM_PROXY_DIR", ""))
if not PROXY_DIR.name:
    # Auto-detect: check common proxy directory names
    for _name in (".litellm-proxy", ".mai-llmproxy"):
        _candidate = Path.home() / _name
        if _candidate.exists():
            PROXY_DIR = _candidate
            break
    else:
        PROXY_DIR = Path.home() / ".litellm-proxy"  # default for new setups
PROXY_VENV = PROXY_DIR / "venv"
PROXY_PORT = int(os.environ.get("LITELLM_PROXY_PORT", 5000))
PROXY_CONFIG = PROXY_DIR / "litellm_config.yaml"
PROXY_LOG = PROXY_DIR / "litellm.log"

# Python executables
SYSTEM_PYTHON = sys.executable  # python running this script
if os.name == "nt":
    PROXY_PYTHON = PROXY_VENV / "Scripts" / "python.exe"
else:
    PROXY_PYTHON = PROXY_VENV / "bin" / "python"

# ─── ANSI Colors ───────────────────────────────────
class C:
    GREEN  = "\033[92m"
    RED    = "\033[91m"
    YELLOW = "\033[93m"
    CYAN   = "\033[96m"
    DIM    = "\033[90m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"

    @staticmethod
    def enabled():
        """Enable ANSI on Windows 10+ and fix UTF-8 output."""
        if os.name == "nt":
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            except Exception:
                pass
            # Force UTF-8 output on Windows to support Unicode chars
            try:
                sys.stdout.reconfigure(encoding="utf-8", errors="replace")
                sys.stderr.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

C.enabled()


# ─── Utility Functions ─────────────────────────────

def find_pid_on_port(port):
    """Find the PID of a process listening on the given port. Returns PID or None."""
    try:
        result = subprocess.run(
            ["netstat", "-aon"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 5 and "LISTENING" in parts:
                # Check if this line has our port
                for part in parts:
                    if part.endswith(f":{port}"):
                        pid = parts[-1]
                        if pid.isdigit() and int(pid) > 0:
                            return int(pid)
    except Exception:
        pass
    return None


def is_port_open(port, host="127.0.0.1"):
    """Quick TCP check if a port is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def kill_pid(pid, graceful_timeout=3):
    """Kill a process by PID. Try graceful first, then force."""
    if os.name == "nt":
        # Try taskkill without /T first (faster, avoids tree-walk hangs),
        # then fall back to /T, then os.kill as last resort.
        for args in [
            ["taskkill", "/PID", str(pid), "/F"],
            ["taskkill", "/PID", str(pid), "/T", "/F"],
        ]:
            try:
                result = subprocess.run(args, capture_output=True, timeout=10)
                if result.returncode == 0:
                    return
            except subprocess.TimeoutExpired:
                continue
        # All taskkill attempts failed — direct kill
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
    else:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(graceful_timeout)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def human_size(size_bytes):
    """Format bytes as human-readable size."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size_bytes) < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def fmt_elapsed(seconds):
    """Format elapsed time as a human-readable string."""
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    elif seconds < 60:
        return f"{seconds:.1f}s"
    else:
        m, s = divmod(seconds, 60)
        return f"{int(m)}m {s:.1f}s"


def wait_for_port(port, timeout=10, interval=0.5):
    """Wait until a port is open or timeout."""
    elapsed = 0
    while elapsed < timeout:
        if is_port_open(port):
            return True
        time.sleep(interval)
        elapsed += interval
    return False


def wait_for_port_closed(port, timeout=15, interval=0.5):
    """Wait until a port is no longer open or timeout."""
    elapsed = 0
    while elapsed < timeout:
        if not is_port_open(port):
            return True
        time.sleep(interval)
        elapsed += interval
    return False


# ─── Log Rotation & Retention ─────────────────────

MAX_LOG_SIZE = 5 * 1024 * 1024    # 5 MB — rotate when file exceeds this
LOG_KEEP_COUNT = 3                 # Keep .1, .2, .3 rotated copies
LOG_RETENTION_DAYS = 7             # Delete rotated files older than 7 days


def rotate_log_file(log_path):
    """
    Rotate a log file if it exceeds MAX_LOG_SIZE.
    Uses numbered rotation: litellm.log → litellm.log.1, .1 → .2, .2 → .3
    The oldest file beyond LOG_KEEP_COUNT is deleted.
    Returns True if rotation happened.
    """
    path = Path(log_path)
    if not path.exists():
        return False
    if path.stat().st_size < MAX_LOG_SIZE:
        return False

    # Shift existing rotated files: .3 → delete, .2 → .3, .1 → .2
    for i in range(LOG_KEEP_COUNT, 0, -1):
        src = path.parent / f"{path.name}.{i}"
        if i == LOG_KEEP_COUNT:
            if src.exists():
                src.unlink()
        else:
            dst = path.parent / f"{path.name}.{i + 1}"
            if src.exists():
                src.rename(dst)

    # Move current log to .1
    rotated = path.parent / f"{path.name}.1"
    path.rename(rotated)

    # Create a fresh empty log file
    path.write_text("", encoding="utf-8")

    return True


def cleanup_old_logs(log_path):
    """
    Delete rotated log files (*.1, *.2, etc.) older than LOG_RETENTION_DAYS.
    Also cleans up chat server rotated files in the same directory.
    """
    path = Path(log_path)
    cutoff = datetime.now() - timedelta(days=LOG_RETENTION_DAYS)
    count = 0

    # Check all rotated variants: .1, .2, .3, ...
    for i in range(1, LOG_KEEP_COUNT + 5):  # check a few extra just in case
        rotated = path.parent / f"{path.name}.{i}"
        if rotated.exists():
            mtime = datetime.fromtimestamp(rotated.stat().st_mtime)
            if mtime < cutoff:
                rotated.unlink()
                count += 1

    return count


def maintain_logs():
    """Run log rotation and retention cleanup for both services."""
    rotated = 0
    cleaned = 0

    # Rotate proxy log (LiteLLM writes directly to file, no built-in rotation)
    if rotate_log_file(PROXY_LOG):
        rotated += 1

    # Chat server uses Python's RotatingFileHandler internally,
    # but we still clean up old rotated files for retention
    # (RotatingFileHandler creates .1, .2, .3 automatically)

    # Cleanup old rotated files for both services
    cleaned += cleanup_old_logs(PROXY_LOG)
    cleaned += cleanup_old_logs(CHAT_LOG)

    if rotated or cleaned:
        actions = []
        if rotated:
            actions.append(f"rotated {rotated} log(s)")
        if cleaned:
            actions.append(f"cleaned {cleaned} old file(s)")
        print(f"  {C.DIM}[logs]  {', '.join(actions)}{C.RESET}")


# ─── Start Functions ───────────────────────────────

def start_chat():
    """Start the Python chat server."""
    pid = find_pid_on_port(CHAT_PORT)
    if pid:
        print(f"  {C.YELLOW}[chat]{C.RESET}  Already running on port {CHAT_PORT} {C.DIM}(PID: {pid}){C.RESET}")
        return True

    if not CHAT_SCRIPT.exists():
        print(f"  {C.RED}[chat]{C.RESET}  server.py not found at {CHAT_SCRIPT}")
        return False

    t0 = time.time()
    print(f"  {C.GREEN}[chat]{C.RESET}  Starting chat server on port {CHAT_PORT}...")

    # Ensure data dir exists for logs
    (CHAT_DIR / "data").mkdir(parents=True, exist_ok=True)

    # Start detached process — server.py writes its own log to data/chat-server.log
    if os.name == "nt":
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        subprocess.Popen(
            [SYSTEM_PYTHON, str(CHAT_SCRIPT)],
            cwd=str(CHAT_DIR),
            creationflags=CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        subprocess.Popen(
            [SYSTEM_PYTHON, str(CHAT_SCRIPT)],
            cwd=str(CHAT_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    if wait_for_port(CHAT_PORT, timeout=5):
        elapsed = time.time() - t0
        pid = find_pid_on_port(CHAT_PORT)
        print(f"  {C.GREEN}[chat]{C.RESET}  Started {C.DIM}(PID: {pid}) [{fmt_elapsed(elapsed)}]{C.RESET}")
        print(f"         {C.DIM}http://localhost:{CHAT_PORT}{C.RESET}")
        return True
    else:
        elapsed = time.time() - t0
        print(f"  {C.RED}[chat]{C.RESET}  Failed to start — check for errors {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return False


def start_proxy():
    """Start the LiteLLM proxy server."""
    pid = find_pid_on_port(PROXY_PORT)
    if pid:
        print(f"  {C.YELLOW}[proxy]{C.RESET} Already running on port {PROXY_PORT} {C.DIM}(PID: {pid}){C.RESET}")
        return True

    # Verify prerequisites
    if not PROXY_PYTHON.exists():
        print(f"  {C.RED}[proxy]{C.RESET} Python venv not found: {PROXY_PYTHON}")
        print(f"         Run: python -m venv \"{PROXY_VENV}\"")
        return False

    if not PROXY_CONFIG.exists():
        print(f"  {C.RED}[proxy]{C.RESET} Config not found: {PROXY_CONFIG}")
        return False

    # Rotate proxy log before starting if it's too large
    maintain_logs()

    t0 = time.time()
    print(f"  {C.GREEN}[proxy]{C.RESET} Starting LiteLLM proxy on port {PROXY_PORT}...")

    # Build the command using the venv's python to run litellm module
    cmd = [
        str(PROXY_PYTHON), "-m", "litellm.proxy.proxy_cli",
        "--config", str(PROXY_CONFIG),
        "--port", str(PROXY_PORT),
    ]

    # Build environment — replicate what the LiteLLM proxy extension sets
    proxy_env = os.environ.copy()
    proxy_env["PYTHONPATH"] = str(PROXY_DIR)
    proxy_env["PYTHONIOENCODING"] = "utf-8"
    # GitHub Copilot auth tokens — managed by the LiteLLM proxy extension
    copilot_token_dir = Path.home() / ".config" / "litellm" / "github_copilot"
    if copilot_token_dir.exists():
        proxy_env["GITHUB_COPILOT_TOKEN_DIR"] = str(copilot_token_dir)
    else:
        print(f"  {C.YELLOW}[proxy]{C.RESET} Warning: GitHub Copilot token dir not found")
        print(f"         {C.DIM}{copilot_token_dir}{C.RESET}")
        print(f"         {C.DIM}Start the LiteLLM proxy via VS Code or CLI first to authenticate{C.RESET}")

    # Open log file for output
    log_handle = open(PROXY_LOG, "a", encoding="utf-8")

    if os.name == "nt":
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        subprocess.Popen(
            cmd,
            cwd=str(PROXY_DIR),
            env=proxy_env,
            creationflags=CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            stdout=log_handle,
            stderr=log_handle,
        )
    else:
        subprocess.Popen(
            cmd,
            cwd=str(PROXY_DIR),
            env=proxy_env,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )

    print(f"         {C.DIM}Waiting for proxy to initialize...{C.RESET}")
    if wait_for_port(PROXY_PORT, timeout=30):
        elapsed = time.time() - t0
        pid = find_pid_on_port(PROXY_PORT)
        print(f"  {C.GREEN}[proxy]{C.RESET} Started {C.DIM}(PID: {pid}) [{fmt_elapsed(elapsed)}]{C.RESET}")
        print(f"         {C.DIM}http://localhost:{PROXY_PORT}{C.RESET}")
        return True
    else:
        elapsed = time.time() - t0
        print(f"  {C.YELLOW}[proxy]{C.RESET} Still initializing... use {C.BOLD}devctl status{C.RESET} to check {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return False


# ─── Stop Functions ────────────────────────────────

def stop_chat():
    """Stop the chat server."""
    pid = find_pid_on_port(CHAT_PORT)
    if not pid:
        print(f"  {C.DIM}[chat]{C.RESET}  Not running")
        return True

    t0 = time.time()
    print(f"  {C.RED}[chat]{C.RESET}  Stopping {C.DIM}(PID: {pid}){C.RESET}...")
    kill_pid(pid)

    if wait_for_port_closed(CHAT_PORT):
        elapsed = time.time() - t0
        print(f"  {C.GREEN}[chat]{C.RESET}  Stopped {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return True
    else:
        elapsed = time.time() - t0
        print(f"  {C.RED}[chat]{C.RESET}  Failed to stop — try: taskkill /PID {pid} /F {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return False


def stop_proxy():
    """Stop the LiteLLM proxy."""
    pid = find_pid_on_port(PROXY_PORT)
    if not pid:
        print(f"  {C.DIM}[proxy]{C.RESET} Not running")
        return True

    t0 = time.time()
    print(f"  {C.RED}[proxy]{C.RESET} Stopping {C.DIM}(PID: {pid}){C.RESET}...")
    kill_pid(pid)

    if wait_for_port_closed(PROXY_PORT):
        elapsed = time.time() - t0
        print(f"  {C.GREEN}[proxy]{C.RESET} Stopped {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return True

    # First kill didn't work — force kill current PID on port (may differ from original)
    retry_pid = find_pid_on_port(PROXY_PORT)
    if retry_pid:
        print(f"  {C.YELLOW}[proxy]{C.RESET} Still alive (PID: {retry_pid}), force killing...")
        try:
            subprocess.run(["taskkill", "/PID", str(retry_pid), "/T", "/F"], capture_output=True, timeout=10)
        except Exception:
            pass
        # Also kill any child processes on that port
        try:
            subprocess.run(["taskkill", "/F", "/FI", f"PID eq {retry_pid}"], capture_output=True, timeout=5)
        except Exception:
            pass

    if wait_for_port_closed(PROXY_PORT, timeout=5):
        elapsed = time.time() - t0
        print(f"  {C.GREEN}[proxy]{C.RESET} Stopped (forced) {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return True
    else:
        elapsed = time.time() - t0
        print(f"  {C.RED}[proxy]{C.RESET} Failed to stop — try: taskkill /PID {retry_pid or pid} /F {C.DIM}[{fmt_elapsed(elapsed)}]{C.RESET}")
        return False


# ─── Status ────────────────────────────────────────

def show_status():
    """Show status of both services."""
    print()
    print(f"  {C.BOLD}{C.CYAN}Service Status{C.RESET}")
    print(f"  {C.DIM}{'─' * 50}{C.RESET}")

    # Chat server
    chat_pid = find_pid_on_port(CHAT_PORT)
    if chat_pid:
        print(f"  {C.GREEN}●{C.RESET} Chat Server      {C.GREEN}running{C.RESET}   port {CHAT_PORT}  PID {chat_pid}")
    else:
        print(f"  {C.RED}○{C.RESET} Chat Server      {C.RED}stopped{C.RESET}   port {CHAT_PORT}")

    # LiteLLM proxy
    proxy_pid = find_pid_on_port(PROXY_PORT)
    if proxy_pid:
        print(f"  {C.GREEN}●{C.RESET} LiteLLM Proxy    {C.GREEN}running{C.RESET}   port {PROXY_PORT}  PID {proxy_pid}")
    else:
        print(f"  {C.RED}○{C.RESET} LiteLLM Proxy    {C.RED}stopped{C.RESET}   port {PROXY_PORT}")

    print(f"  {C.DIM}{'─' * 50}{C.RESET}")

    # Health check if proxy is running — try curl first (reliable on Windows),
    # fall back to Python socket
    if proxy_pid:
        try:
            curl_path = shutil.which("curl")
            if curl_path:
                start = time.time()
                result = subprocess.run(
                    [curl_path, "-s", "-o", os.devnull, "-w", "%{http_code}",
                     f"http://127.0.0.1:{PROXY_PORT}/health"],
                    capture_output=True, text=True, timeout=5
                )
                elapsed = time.time() - start
                code = result.stdout.strip()
                if code and code != "000":
                    print(f"  {C.DIM}Proxy health: {code} ({elapsed:.2f}s){C.RESET}")
                else:
                    raise Exception("no response")
            else:
                raise FileNotFoundError("curl not found")
        except Exception:
            # Fallback: raw socket
            try:
                start = time.time()
                sock = socket.create_connection(("127.0.0.1", PROXY_PORT), timeout=2)
                sock.sendall(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                resp = sock.recv(1024).decode("utf-8", errors="replace")
                elapsed = time.time() - start
                sock.close()
                status_code = resp.split(" ", 2)[1] if " " in resp else "?"
                print(f"  {C.DIM}Proxy health: {status_code} ({elapsed:.2f}s){C.RESET}")
            except Exception as e:
                print(f"  {C.DIM}Proxy health: port open (PID confirmed){C.RESET}")

    # Log file info
    log_files = [
        ("Proxy log", PROXY_LOG),
        ("Chat log ", CHAT_LOG),
    ]
    for label, lf in log_files:
        if lf.exists():
            size = lf.stat().st_size
            # Count rotated files
            rotated_count = sum(1 for i in range(1, LOG_KEEP_COUNT + 1)
                              if (lf.parent / f"{lf.name}.{i}").exists())
            rot_info = f"  +{rotated_count} rotated" if rotated_count else ""
            print(f"  {C.DIM}{label}: {lf}  ({human_size(size)}{rot_info}){C.RESET}")
        else:
            print(f"  {C.DIM}{label}: {lf}  (not found){C.RESET}")

    print()


# ─── Logs ──────────────────────────────────────────

def _tail_single(log_file, label, tail_lines=50, grep_term=None, level_filter=None):
    """Tail a single log file (blocking), with optional grep and level filter."""
    path = Path(log_file)
    if not path.exists():
        print(f"  {C.RED}Log file not found:{C.RESET} {path}")
        return

    filter_desc = ""
    if grep_term:
        filter_desc += f" | grep '{grep_term}'"
    if level_filter:
        filter_desc += f" | level={level_filter}"

    print(f"  {C.CYAN}Tailing{C.RESET} [{label}] {path}{C.DIM}{filter_desc}{C.RESET}")
    print(f"  {C.DIM}Press Ctrl+C to stop{C.RESET}")
    print()

    try:
        if grep_term or level_filter:
            # Use Python-based tailing with filtering
            _python_tail(path, label, tail_lines, grep_term, level_filter)
        else:
            # Use native tailing (faster, no filtering)
            if os.name == "nt":
                subprocess.run([
                    "powershell", "-NoProfile", "-Command",
                    f"Get-Content '{path}' -Tail {tail_lines} -Wait -Encoding UTF8"
                ])
            else:
                subprocess.run(["tail", "-f", "-n", str(tail_lines), str(path)])
    except KeyboardInterrupt:
        print(f"\n  {C.DIM}Stopped tailing.{C.RESET}")


def _detect_level(line):
    """Detect log level from a line of text."""
    lower = line.lower()
    if any(k in lower for k in ('error', 'exception', 'traceback', 'critical', 'fatal')):
        return 'error'
    if any(k in lower for k in ('warning', 'warn')):
        return 'warn'
    if any(k in lower for k in ('debug', 'trace')):
        return 'debug'
    return 'info'


def _matches_filter(line, grep_term=None, level_filter=None):
    """Check if a log line matches the grep term and level filter."""
    if grep_term and grep_term.lower() not in line.lower():
        return False
    if level_filter:
        line_level = _detect_level(line)
        if level_filter == 'error' and line_level != 'error':
            return False
        elif level_filter == 'warn' and line_level not in ('error', 'warn'):
            return False
        elif level_filter == 'debug':
            pass  # show everything
    return True


def _colorize_line(line, label=None):
    """Add color to a log line based on its level."""
    level = _detect_level(line)
    prefix = f"[{label}] " if label else ""
    if level == 'error':
        return f"  {C.RED}{prefix}{line}{C.RESET}"
    elif level == 'warn':
        return f"  {C.YELLOW}{prefix}{line}{C.RESET}"
    else:
        if label:
            color = C.GREEN if label == "chat" else C.CYAN
            return f"  {color}[{label}]{C.RESET} {line}"
        return f"  {line}"


def _python_tail(path, label, tail_lines, grep_term=None, level_filter=None):
    """
    Python-based file tail with grep and level filtering.
    Reads last N matching lines, then follows new lines.
    """
    import re as _re

    # Read last lines that match
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            all_lines = f.readlines()
    except Exception as e:
        print(f"  {C.RED}Error reading {path}: {e}{C.RESET}")
        return

    # Strip ANSI from lines for matching
    ansi_re = _re.compile(r'\x1b\[[0-9;]*m')

    # Filter existing lines
    matching = []
    for raw in all_lines:
        clean = ansi_re.sub('', raw.rstrip('\n'))
        if not clean.strip():
            continue
        if _matches_filter(clean, grep_term, level_filter):
            matching.append(clean)

    # Print last N matching lines
    for line in matching[-tail_lines:]:
        print(_colorize_line(line, label))

    # Now follow new lines
    last_pos = path.stat().st_size
    while True:
        time.sleep(0.3)
        try:
            current_size = path.stat().st_size
            if current_size < last_pos:
                # File was truncated/rotated — start from beginning
                last_pos = 0
            if current_size > last_pos:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    f.seek(last_pos)
                    new_lines = f.readlines()
                    last_pos = f.tell()

                for raw in new_lines:
                    clean = ansi_re.sub('', raw.rstrip('\n'))
                    if not clean.strip():
                        continue
                    if _matches_filter(clean, grep_term, level_filter):
                        print(_colorize_line(clean, label))
        except FileNotFoundError:
            # File was deleted (rotation?) — wait for it to reappear
            time.sleep(1)
            if path.exists():
                last_pos = 0


def _tail_combined(tail_lines=30, grep_term=None, level_filter=None):
    """Tail both log files interleaved with colored prefixes."""
    files = []
    if PROXY_LOG.exists():
        files.append(("proxy", PROXY_LOG))
    if CHAT_LOG.exists():
        files.append(("chat", CHAT_LOG))

    if not files:
        print(f"  {C.RED}No log files found{C.RESET}")
        print(f"  {C.DIM}Proxy: {PROXY_LOG}{C.RESET}")
        print(f"  {C.DIM}Chat:  {CHAT_LOG}{C.RESET}")
        return

    filter_desc = ""
    if grep_term:
        filter_desc += f" | grep '{grep_term}'"
    if level_filter:
        filter_desc += f" | level={level_filter}"

    labels = ", ".join(f"[{name}] {path}" for name, path in files)
    print(f"  {C.CYAN}Tailing{C.RESET} {labels}{C.DIM}{filter_desc}{C.RESET}")
    print(f"  {C.DIM}Press Ctrl+C to stop{C.RESET}")
    print()

    if grep_term or level_filter:
        # Use Python-based combined tailing with filtering
        _python_tail_combined(files, tail_lines, grep_term, level_filter)
    else:
        # Use native tailing (faster, no filtering)
        try:
            if os.name == "nt":
                # PowerShell: read last N from each, then poll both with interleaved output
                ps_parts = []
                for name, path in files:
                    color = "Green" if name == "chat" else "Cyan"
                    ps_parts.append(
                        f"Get-Content '{path}' -Tail {tail_lines} -Wait -Encoding UTF8 "
                        f"| ForEach-Object {{ Write-Host '[{name}]' -ForegroundColor {color} -NoNewline; Write-Host \" $_\" }}"
                    )
                # Run them as parallel jobs so both streams interleave
                if len(files) == 1:
                    subprocess.run(["powershell", "-NoProfile", "-Command", ps_parts[0]])
                else:
                    # Use Start-Job for true parallel tailing
                    ps_script = f"""
$job1 = Start-Job -ScriptBlock {{ {ps_parts[0]} }}
$job2 = Start-Job -ScriptBlock {{ {ps_parts[1]} }}
try {{
    while ($true) {{
        Receive-Job $job1 -ErrorAction SilentlyContinue
        Receive-Job $job2 -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 200
    }}
}} finally {{
    Stop-Job $job1,$job2 -ErrorAction SilentlyContinue
    Remove-Job $job1,$job2 -Force -ErrorAction SilentlyContinue
}}
"""
                    subprocess.run(["powershell", "-NoProfile", "-Command", ps_script])
            else:
                # Unix: tail -f both files
                paths = [str(p) for _, p in files]
                subprocess.run(["tail", "-f", "-n", str(tail_lines)] + paths)
        except KeyboardInterrupt:
            print(f"\n  {C.DIM}Stopped tailing.{C.RESET}")


def _python_tail_combined(files, tail_lines, grep_term=None, level_filter=None):
    """Python-based combined tailing with filtering for multiple log files."""
    import re as _re
    ansi_re = _re.compile(r'\x1b\[[0-9;]*m')

    # Read and filter existing lines from all files, with timestamps for interleaving
    all_matching = []
    file_positions = {}

    for label, path in files:
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                lines = f.readlines()
            file_positions[str(path)] = path.stat().st_size
        except Exception:
            file_positions[str(path)] = 0
            continue

        for raw in lines:
            clean = ansi_re.sub('', raw.rstrip('\n'))
            if not clean.strip():
                continue
            if _matches_filter(clean, grep_term, level_filter):
                all_matching.append((label, clean))

    # Print last N matching lines
    for label, line in all_matching[-tail_lines:]:
        print(_colorize_line(line, label))

    # Follow new lines from all files
    try:
        while True:
            time.sleep(0.3)
            for label, path in files:
                key = str(path)
                try:
                    current_size = path.stat().st_size
                    last_pos = file_positions.get(key, 0)

                    if current_size < last_pos:
                        last_pos = 0
                    if current_size > last_pos:
                        with open(path, 'r', encoding='utf-8', errors='replace') as f:
                            f.seek(last_pos)
                            new_lines = f.readlines()
                            file_positions[key] = f.tell()

                        for raw in new_lines:
                            clean = ansi_re.sub('', raw.rstrip('\n'))
                            if not clean.strip():
                                continue
                            if _matches_filter(clean, grep_term, level_filter):
                                print(_colorize_line(clean, label))
                except FileNotFoundError:
                    file_positions[key] = 0
    except KeyboardInterrupt:
        print(f"\n  {C.DIM}Stopped tailing.{C.RESET}")


def tail_logs(target="all", grep_term=None, level_filter=None):
    """Tail logs for the given target with optional grep and level filter."""
    if target == "proxy":
        _tail_single(PROXY_LOG, "proxy", grep_term=grep_term, level_filter=level_filter)
    elif target == "chat":
        _tail_single(CHAT_LOG, "chat", grep_term=grep_term, level_filter=level_filter)
    else:
        _tail_combined(grep_term=grep_term, level_filter=level_filter)


# ─── Help ──────────────────────────────────────────

def show_help():
    """Show usage information."""
    print(f"""
  {C.BOLD}{C.CYAN}devctl{C.RESET} — Claude Chat Development Controller

  {C.BOLD}Usage:{C.RESET}
    python devctl.py {C.GREEN}start{C.RESET}   [chat|proxy|all]    Start services
    python devctl.py {C.RED}stop{C.RESET}    [chat|proxy|all]    Stop services
    python devctl.py {C.YELLOW}restart{C.RESET} [chat|proxy|all]    Restart services
    python devctl.py {C.CYAN}status{C.RESET}                       Show running status
    python devctl.py {C.DIM}logs{C.RESET}    [chat|proxy|all]    Tail log files
    python devctl.py {C.DIM}logs{C.RESET}    [target] -g TERM    Tail with grep filter
    python devctl.py {C.DIM}logs{C.RESET}    [target] --level L  Filter by level (error/warn/info)
    python devctl.py {C.DIM}clean{C.RESET}                        Rotate & cleanup old logs
    python devctl.py help                          Show this help

  {C.BOLD}Targets:{C.RESET}
    chat / server    Python chat server {C.DIM}(port {CHAT_PORT}){C.RESET}
    proxy / llm      LiteLLM proxy server {C.DIM}(port {PROXY_PORT}){C.RESET}
    all              Both services {C.DIM}(default){C.RESET}

  {C.BOLD}Log Rotation:{C.RESET}
    Logs are automatically rotated when they exceed {C.DIM}5 MB{C.RESET}.
    Rotated files older than {C.DIM}7 days{C.RESET} are cleaned up on start/restart.
    Run {C.BOLD}devctl clean{C.RESET} to manually trigger rotation & cleanup.

  {C.BOLD}Examples:{C.RESET}
    python devctl.py start              Start both servers
    python devctl.py restart proxy      Restart only the LiteLLM proxy
    python devctl.py restart llm        Same as above (alias)
    python devctl.py stop chat          Stop only the chat server
    python devctl.py stop server        Same as above (alias)
    python devctl.py status             Check what's running
    python devctl.py logs               Tail both logs (interleaved)
    python devctl.py logs proxy         Tail only the LiteLLM proxy log
    python devctl.py logs chat -g error Tail chat log, filtering for "error"
    python devctl.py clean              Rotate large logs & cleanup old files
""")


# ─── Main Dispatcher ───────────────────────────────

def resolve_target(raw):
    """Normalize target aliases to canonical names."""
    aliases = {
        "chat": "chat", "server": "chat",
        "proxy": "proxy", "llm": "proxy",
        "all": "all",
    }
    return aliases.get(raw)


def main():
    args = sys.argv[1:]
    action = args[0].lower() if args else "help"
    raw_target = args[1].lower() if len(args) > 1 else "all"

    if action in ("help", "-h", "--help"):
        show_help()
        return

    if action == "status":
        show_status()
        return

    if action == "clean":
        print()
        print(f"  {C.BOLD}{C.CYAN}Log Maintenance{C.RESET}")
        maintain_logs()
        print(f"  {C.GREEN}Done{C.RESET}")
        print()
        return

    if action == "logs":
        # Parse extra flags: -g/--grep TERM, --level LEVEL
        log_target = "all"
        grep_term = None
        level_filter = None

        # Parse remaining args after "logs"
        rest = args[1:]
        i = 0
        while i < len(rest):
            arg = rest[i]
            if arg in ("-g", "--grep") and i + 1 < len(rest):
                grep_term = rest[i + 1]
                i += 2
            elif arg == "--level" and i + 1 < len(rest):
                level_filter = rest[i + 1].lower()
                if level_filter not in ('error', 'warn', 'info', 'debug'):
                    print(f"  {C.RED}Invalid level:{C.RESET} {level_filter}")
                    print(f"  Valid levels: error, warn, info, debug")
                    return
                i += 1
                i += 1
            elif arg.startswith("-"):
                print(f"  {C.RED}Unknown flag:{C.RESET} {arg}")
                print(f"  Use: logs [target] [-g TERM] [--level LEVEL]")
                return
            else:
                # It's the target
                resolved = resolve_target(arg.lower())
                if resolved:
                    log_target = resolved
                else:
                    print(f"  {C.RED}Unknown target:{C.RESET} {arg}")
                    return
                i += 1

        tail_logs(log_target, grep_term=grep_term, level_filter=level_filter)
        return

    target = resolve_target(raw_target)
    if not target:
        print(f"  {C.RED}Unknown target:{C.RESET} {raw_target}")
        print(f"  Valid targets: chat (server), proxy (llm), all")
        return

    print()

    t_total = time.time()

    if action == "start":
        if target in ("proxy", "all"):
            start_proxy()
        if target in ("chat", "all"):
            start_chat()

    elif action == "stop":
        if target in ("chat", "all"):
            stop_chat()
        if target in ("proxy", "all"):
            stop_proxy()

    elif action == "restart":
        # Stop if running
        if target in ("chat", "all"):
            if find_pid_on_port(CHAT_PORT):
                stop_chat()
            else:
                print(f"  {C.DIM}[chat]{C.RESET}  Not running — skip stop")
        if target in ("proxy", "all"):
            if find_pid_on_port(PROXY_PORT):
                stop_proxy()
            else:
                print(f"  {C.DIM}[proxy]{C.RESET} Not running — skip stop")

        # Force-kill anything still holding the ports
        for label, port in [("proxy", PROXY_PORT), ("chat", CHAT_PORT)]:
            if target not in (label, "all"):
                continue
            stubborn_pid = find_pid_on_port(port)
            if stubborn_pid:
                print(f"  {C.YELLOW}[{label}]{C.RESET} Port {port} still held by PID {stubborn_pid} — force killing...")
                try:
                    subprocess.run(["taskkill", "/PID", str(stubborn_pid), "/T", "/F"], capture_output=True, timeout=10)
                except Exception:
                    pass
                time.sleep(1)

        print()
        # Then start
        if target in ("proxy", "all"):
            start_proxy()
        if target in ("chat", "all"):
            start_chat()

    else:
        print(f"  {C.RED}Unknown action:{C.RESET} {action}")
        show_help()
        return

    total_elapsed = time.time() - t_total
    print(f"  {C.DIM}Total: {fmt_elapsed(total_elapsed)}{C.RESET}")
    print()


if __name__ == "__main__":
    main()
