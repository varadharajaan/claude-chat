"""
Claude Chat — Local Server
Serves the chat UI + provides API endpoints for:
  - /api/logs          — LiteLLM proxy log viewer
  - /api/logs/clear    — Clear the LiteLLM log
  - /api/conversations — Server-side chat history (CRUD)

Run:  python server.py
Opens: http://localhost:8090
"""

import http.server
import json
import logging
import logging.handlers
import os
import re
import shutil
import sys
import threading
import time
import webbrowser
import urllib.parse
from pathlib import Path
from datetime import datetime

PORT = int(os.environ.get("CHAT_PORT", 8090))
DATA_DIR = Path(__file__).parent / "data"
CHAT_LOG_FILE = DATA_DIR / "chat-server.log"

# LiteLLM proxy log — override with LITELLM_LOG env var if your proxy lives elsewhere
_PROXY_DIR_OVERRIDE = os.environ.get("LITELLM_LOG")
if _PROXY_DIR_OVERRIDE:
    LITELLM_LOG_FILE = Path(_PROXY_DIR_OVERRIDE)
else:
    # Auto-detect: check common proxy directory names
    _DEFAULT_PROXY_DIR = Path.home() / ".litellm-proxy"
    for _name in (".litellm-proxy", ".mai-llmproxy"):
        _candidate = Path.home() / _name
        if _candidate.exists():
            _DEFAULT_PROXY_DIR = _candidate
            break
    LITELLM_LOG_FILE = _DEFAULT_PROXY_DIR / "litellm.log"
HISTORY_DIR = DATA_DIR / "conversations"
BACKUP_DIR = DATA_DIR / "backups"

# ─── Backup Configuration ─────────────────────────
BACKUP_INTERVAL_SECS = 15 * 60    # 15 minutes
BACKUP_MAX_SLOTS = 4              # Keep up to 4 backups (1 hour)


# ─── Logging setup ─────────────────────────────────
MAX_LOG_BYTES = 5 * 1024 * 1024  # 5 MB per log file
LOG_BACKUP_COUNT = 3             # Keep 3 rotated files (.1, .2, .3)

def setup_logging():
    """Configure rolling file log + console."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("chat-server")
    logger.setLevel(logging.INFO)
    # Rolling file handler — rotates at 5MB, keeps 3 backups
    fh = logging.handlers.RotatingFileHandler(
        CHAT_LOG_FILE, maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    fh.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    ))
    logger.addHandler(fh)
    # Console handler
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"
    ))
    logger.addHandler(ch)
    return logger

log = setup_logging()


# ─── Chat History (file-backed) ────────────────────
class ChatHistory:
    """
    Server-side conversation storage using JSON files.
    Each conversation is stored as data/conversations/{id}.json
    This ensures chats survive browser cache clears, different browsers, etc.
    """

    def __init__(self, directory):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, conv_id):
        # Sanitize ID to prevent path traversal
        safe_id = re.sub(r'[^a-zA-Z0-9_\-]', '', conv_id)
        return self.dir / f"{safe_id}.json"

    def list_all(self):
        """Return list of conversation summaries (id, title, updatedAt, messageCount)."""
        summaries = []
        for f in self.dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                summaries.append({
                    "id": data.get("id", f.stem),
                    "title": data.get("title", "Untitled"),
                    "createdAt": data.get("createdAt", 0),
                    "updatedAt": data.get("updatedAt", 0),
                    "messageCount": len(data.get("messages", [])),
                })
            except Exception as e:
                log.warning(f"Skipping corrupt conversation file {f.name}: {e}")
        # Sort by updatedAt descending (most recent first)
        summaries.sort(key=lambda x: x["updatedAt"], reverse=True)
        return summaries

    def get(self, conv_id):
        """Return full conversation data or None."""
        path = self._path(conv_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            log.error(f"Failed to read conversation {conv_id}: {e}")
            return None

    def save(self, conv_data):
        """Save a conversation (create or update). Returns True on success."""
        conv_id = conv_data.get("id")
        if not conv_id:
            return False
        path = self._path(conv_id)
        try:
            with self._lock:
                path.write_text(json.dumps(conv_data, ensure_ascii=False), encoding="utf-8")
            return True
        except Exception as e:
            log.error(f"Failed to save conversation {conv_id}: {e}")
            return False

    def delete(self, conv_id):
        """Delete a conversation. Returns True if deleted."""
        path = self._path(conv_id)
        with self._lock:
            if path.exists():
                path.unlink()
                return True
        return False

    def import_bulk(self, conversations_dict):
        """Import multiple conversations from a dict (localStorage migration)."""
        count = 0
        for conv_id, conv_data in conversations_dict.items():
            conv_data["id"] = conv_id  # Ensure ID is set
            if self.save(conv_data):
                count += 1
        return count


history = ChatHistory(HISTORY_DIR)


# ─── Conversation Backups ─────────────────────────
class ConversationBackup:
    """
    Rolling checkpoint backups of all conversations.
    Keeps up to BACKUP_MAX_SLOTS (4) snapshot files.
    A new backup is only committed if it succeeds — if it fails,
    the previous backup is preserved.
    """

    def __init__(self, backup_dir, history_instance):
        self.dir = Path(backup_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.history = history_instance
        self._timer = None

    def _snapshot_path(self, slot):
        return self.dir / f"snapshot_{slot}.json"

    def take_snapshot(self):
        """Create a new snapshot, rotating old ones."""
        try:
            # Gather all conversations
            all_convs = {}
            for f in self.history.dir.glob("*.json"):
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    cid = data.get("id", f.stem)
                    all_convs[cid] = data
                except Exception:
                    continue

            if not all_convs:
                log.info("Backup: no conversations to snapshot")
                return False

            # Write to a temp file first (atomic-ish)
            temp_path = self.dir / "snapshot_new.tmp"
            snapshot_data = {
                "timestamp": datetime.now().isoformat(),
                "count": len(all_convs),
                "conversations": all_convs,
            }
            temp_path.write_text(
                json.dumps(snapshot_data, ensure_ascii=False),
                encoding="utf-8"
            )

            # Only rotate after temp file is successfully written
            # Shift old snapshots: slot 4 → delete, 3 → 4, 2 → 3, 1 → 2
            for i in range(BACKUP_MAX_SLOTS, 1, -1):
                src = self._snapshot_path(i - 1)
                dst = self._snapshot_path(i)
                if i == BACKUP_MAX_SLOTS and dst.exists():
                    dst.unlink()
                if src.exists():
                    src.rename(dst)

            # Move temp to slot 1
            final_path = self._snapshot_path(1)
            temp_path.rename(final_path)

            log.info(f"Backup: snapshot saved ({len(all_convs)} conversations) → {final_path.name}")
            return True

        except Exception as e:
            log.error(f"Backup: snapshot failed — {e}")
            # Clean up temp file if it exists
            temp = self.dir / "snapshot_new.tmp"
            if temp.exists():
                temp.unlink()
            return False

    def list_snapshots(self):
        """Return list of available snapshots with metadata."""
        snapshots = []
        for i in range(1, BACKUP_MAX_SLOTS + 1):
            path = self._snapshot_path(i)
            if path.exists():
                try:
                    # Read just the metadata, not full conversations
                    data = json.loads(path.read_text(encoding="utf-8"))
                    snapshots.append({
                        "slot": i,
                        "timestamp": data.get("timestamp", "unknown"),
                        "count": data.get("count", 0),
                        "size": path.stat().st_size,
                    })
                except Exception:
                    snapshots.append({
                        "slot": i,
                        "timestamp": "corrupt",
                        "count": 0,
                        "size": path.stat().st_size,
                    })
        return snapshots

    def restore_snapshot(self, slot):
        """Restore conversations from a snapshot slot. Returns count restored."""
        path = self._snapshot_path(slot)
        if not path.exists():
            return -1
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            convs = data.get("conversations", {})
            count = 0
            for conv_id, conv_data in convs.items():
                conv_data["id"] = conv_id
                if self.history.save(conv_data):
                    count += 1
            log.info(f"Backup: restored {count} conversations from slot {slot}")
            return count
        except Exception as e:
            log.error(f"Backup: restore from slot {slot} failed — {e}")
            return -1

    def start_timer(self):
        """Start the periodic backup timer."""
        def _run():
            while True:
                time.sleep(BACKUP_INTERVAL_SECS)
                self.take_snapshot()

        self._timer = threading.Thread(target=_run, daemon=True)
        self._timer.start()
        log.info(f"Backup: timer started (every {BACKUP_INTERVAL_SECS // 60} min, {BACKUP_MAX_SLOTS} slots)")


backup = ConversationBackup(BACKUP_DIR, history)


# ─── HTTP Handler ──────────────────────────────────
class ChatHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files and provides /api/* endpoints."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Log API
        if path == '/api/logs':
            self.handle_logs(parsed)
        elif path == '/api/logs/clear':
            self.handle_logs_clear()
        # Backup API
        elif path == '/api/backups':
            self.handle_list_backups()
        # Conversation API
        elif path == '/api/conversations':
            self.handle_list_conversations()
        elif path.startswith('/api/conversations/'):
            conv_id = path.split('/api/conversations/', 1)[1].rstrip('/')
            if conv_id:
                self.handle_get_conversation(conv_id)
            else:
                self.handle_list_conversations()
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/conversations':
            self.handle_save_conversation()
        elif path == '/api/conversations/import':
            self.handle_import_conversations()
        elif path == '/api/backups/snapshot':
            self.handle_take_snapshot()
        elif path == '/api/backups/restore':
            self.handle_restore_snapshot()
        else:
            self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/conversations/'):
            conv_id = path.split('/api/conversations/', 1)[1].rstrip('/')
            if conv_id:
                self.handle_delete_conversation(conv_id)
            else:
                self.send_error(400)
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # ─── Conversation endpoints ─────────────────────

    def handle_list_conversations(self):
        """GET /api/conversations — list all conversation summaries."""
        summaries = history.list_all()
        self.send_json({'ok': True, 'conversations': summaries})
        log.info(f"Listed {len(summaries)} conversations")

    def handle_get_conversation(self, conv_id):
        """GET /api/conversations/:id — get full conversation."""
        data = history.get(conv_id)
        if data:
            self.send_json({'ok': True, 'conversation': data})
        else:
            self.send_json({'ok': False, 'error': 'Conversation not found'})

    def handle_save_conversation(self):
        """POST /api/conversations — save/update a conversation."""
        body = self._read_body()
        if not body:
            self.send_json({'ok': False, 'error': 'Empty body'})
            return
        try:
            conv_data = json.loads(body)
        except json.JSONDecodeError as e:
            self.send_json({'ok': False, 'error': f'Invalid JSON: {e}'})
            return

        if history.save(conv_data):
            conv_id = conv_data.get("id", "?")
            msg_count = len(conv_data.get("messages", []))
            log.info(f"Saved conversation {conv_id} ({msg_count} messages)")
            self.send_json({'ok': True})
        else:
            self.send_json({'ok': False, 'error': 'Failed to save'})

    def handle_delete_conversation(self, conv_id):
        """DELETE /api/conversations/:id — delete a conversation."""
        if history.delete(conv_id):
            log.info(f"Deleted conversation {conv_id}")
            self.send_json({'ok': True})
        else:
            self.send_json({'ok': False, 'error': 'Not found'})

    def handle_import_conversations(self):
        """POST /api/conversations/import — bulk import from localStorage."""
        body = self._read_body()
        if not body:
            self.send_json({'ok': False, 'error': 'Empty body'})
            return
        try:
            data = json.loads(body)
            conversations = data.get("conversations", {})
        except json.JSONDecodeError as e:
            self.send_json({'ok': False, 'error': f'Invalid JSON: {e}'})
            return

        count = history.import_bulk(conversations)
        log.info(f"Imported {count} conversations from client")
        self.send_json({'ok': True, 'imported': count})

    # ─── Backup endpoints ─────────────────────────────

    def handle_list_backups(self):
        """GET /api/backups — list available backup snapshots."""
        snapshots = backup.list_snapshots()
        self.send_json({'ok': True, 'snapshots': snapshots})

    def handle_take_snapshot(self):
        """POST /api/backups/snapshot — manually trigger a backup."""
        success = backup.take_snapshot()
        if success:
            self.send_json({'ok': True})
        else:
            self.send_json({'ok': False, 'error': 'Snapshot failed or no conversations'})

    def handle_restore_snapshot(self):
        """POST /api/backups/restore — restore from a backup slot. Body: {"slot": 1}"""
        body = self._read_body()
        if not body:
            self.send_json({'ok': False, 'error': 'Empty body'})
            return
        try:
            data = json.loads(body)
            slot = int(data.get("slot", 0))
        except (json.JSONDecodeError, ValueError) as e:
            self.send_json({'ok': False, 'error': f'Invalid request: {e}'})
            return

        if slot < 1 or slot > BACKUP_MAX_SLOTS:
            self.send_json({'ok': False, 'error': f'Invalid slot (1-{BACKUP_MAX_SLOTS})'})
            return

        count = backup.restore_snapshot(slot)
        if count >= 0:
            self.send_json({'ok': True, 'restored': count})
        else:
            self.send_json({'ok': False, 'error': 'Restore failed'})

    # ─── Log endpoints ─────────────────────────────────

    def handle_logs(self, parsed):
        """Return last N lines of a log file. Use ?source=proxy|chat (default: proxy)."""
        params = urllib.parse.parse_qs(parsed.query)
        lines_count = int(params.get('lines', ['200'])[0])
        filter_text = params.get('filter', [''])[0].lower()
        level = params.get('level', ['all'])[0].lower()
        source = params.get('source', ['proxy'])[0].lower()

        # Select log file based on source
        if source == 'chat':
            log_file = CHAT_LOG_FILE
        else:
            log_file = LITELLM_LOG_FILE

        try:
            if not log_file.exists():
                self.send_json({
                    'ok': False,
                    'error': f'Log file not found: {log_file}',
                    'lines': [],
                    'file': str(log_file),
                    'source': source,
                })
                return

            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                all_lines = f.readlines()

            log_entries = []
            for raw in all_lines:
                line = raw.rstrip('\n')
                clean = self._strip_ansi(line)
                if not clean.strip():
                    continue

                line_level = 'info'
                lower = clean.lower()
                if 'error' in lower or 'exception' in lower or 'traceback' in lower:
                    line_level = 'error'
                elif 'warning' in lower or 'warn' in lower:
                    line_level = 'warn'
                elif '200 ok' in lower:
                    line_level = 'success'

                if level != 'all':
                    if level == 'error' and line_level not in ('error',):
                        continue
                    elif level == 'warn' and line_level not in ('error', 'warn'):
                        continue

                if filter_text and filter_text not in lower:
                    continue

                log_entries.append({'text': clean, 'level': line_level})

            entries = log_entries[-lines_count:]
            self.send_json({
                'ok': True,
                'lines': entries,
                'total': len(all_lines),
                'filtered': len(log_entries),
                'file': str(log_file),
                'source': source,
            })

        except Exception as e:
            self.send_json({
                'ok': False, 'error': str(e),
                'lines': [], 'file': str(log_file),
                'source': source,
            })

    def handle_logs_clear(self):
        """Clear a log file. Use ?source=proxy|chat (default: proxy)."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        source = params.get('source', ['proxy'])[0].lower()
        log_file = CHAT_LOG_FILE if source == 'chat' else LITELLM_LOG_FILE
        try:
            if log_file.exists():
                with open(log_file, 'w') as f:
                    f.write('')
            self.send_json({'ok': True, 'source': source})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)})

    # ─── Helpers ────────────────────────────────────

    def _read_body(self):
        """Read the request body."""
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return None
        return self.rfile.read(length).decode('utf-8')

    def send_json(self, data):
        """Send a JSON response with CORS headers."""
        body = json.dumps(data).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _strip_ansi(self, text):
        """Remove ANSI escape sequences from text."""
        return re.sub(r'\x1b\[[0-9;]*m', '', text)

    def log_message(self, format, *args):
        """Route HTTP access logs to our logger instead of stderr."""
        msg = format % args if args else format
        if '404' in msg or 'error' in msg.lower():
            log.warning(msg)
        else:
            log.debug(msg)  # suppress normal access logs


# ─── Main ──────────────────────────────────────────
def main():
    os.chdir(Path(__file__).parent)

    # Ensure data directories exist
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # Take an initial snapshot on startup, then start the periodic timer
    backup.take_snapshot()
    backup.start_timer()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), ChatHandler)
    url = f'http://localhost:{PORT}'
    log.info(f"Claude Chat server running at {url}")
    log.info(f"Chat log: {CHAT_LOG_FILE}")
    log.info(f"LiteLLM log: {LITELLM_LOG_FILE}")
    log.info(f"Chat history: {HISTORY_DIR}")
    log.info(f"Backups: {BACKUP_DIR}")
    print(f'\nClaude Chat server running at {url}')
    print(f'Press Ctrl+C to stop\n')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down...")
        print('\nShutting down...')
        server.shutdown()


if __name__ == '__main__':
    main()
