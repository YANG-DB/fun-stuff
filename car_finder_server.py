"""
Local web server for the car-deal dashboard.
Serves car-deals/ as static files AND exposes endpoints that let the in-browser
"Re-scrape" button trigger the Python scraper and stream live progress.

Run from the project root:
    python3 car_finder_server.py

Then open http://localhost:9876 (or your chosen port).
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_DIR   = PROJECT_ROOT / "car-deals"
SCRAPE_CMD   = ["python3", "-u", str(PROJECT_ROOT / "car_deal_finder.py")]
PORT         = int(os.environ.get("PORT", "9876"))

# ── Scrape coordination state ─────────────────────────────────────────────────
_state_lock = threading.Lock()
_scrape_thread: threading.Thread | None = None
_scrape_proc: subprocess.Popen | None = None
_scrape_log: list[dict] = []
_scrape_clients: list[queue.Queue] = []
_scrape_started_at: float | None = None
_scrape_finished_at: float | None = None
_scrape_returncode: int | None = None


def _emit(event: dict) -> None:
    """Append to log + broadcast to all SSE clients."""
    with _state_lock:
        _scrape_log.append(event)
        clients = list(_scrape_clients)
    for q in clients:
        try:
            q.put_nowait(event)
        except queue.Full:
            pass


def _run_scrape() -> None:
    global _scrape_proc, _scrape_started_at, _scrape_finished_at, _scrape_returncode
    _scrape_started_at = time.time()
    _scrape_finished_at = None
    _scrape_returncode = None
    _emit({"type": "start", "at": _scrape_started_at})
    try:
        _scrape_proc = subprocess.Popen(
            SCRAPE_CMD,
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert _scrape_proc.stdout is not None
        for line in _scrape_proc.stdout:
            _emit({"type": "log", "text": line.rstrip()})
        _scrape_proc.wait()
        _scrape_returncode = _scrape_proc.returncode
    except Exception as e:
        _scrape_returncode = -1
        _emit({"type": "log", "text": f"[server error] {e}"})
    finally:
        _scrape_proc = None
        _scrape_finished_at = time.time()
        _emit({"type": "done", "code": _scrape_returncode, "at": _scrape_finished_at})


def _scrape_running() -> bool:
    return _scrape_thread is not None and _scrape_thread.is_alive()


# ── HTTP handler ──────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    """Serves static files from car-deals/ and exposes /api/scrape*."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args) -> None:  # quieter
        if "/api/" in (args[0] if args else ""):
            print(f"  {self.address_string()} - {fmt % args}")

    # ── Routes ────────────────────────────────────────────────────────────
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/scrape-status":
            return self._serve_status()
        if path == "/api/scrape-stream":
            return self._serve_stream()
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/scrape":
            return self._trigger_scrape()
        self.send_error(404)

    # ── Endpoints ─────────────────────────────────────────────────────────
    def _trigger_scrape(self) -> None:
        global _scrape_thread
        if _scrape_running():
            self._send_json(409, {"error": "scrape already running"})
            return
        with _state_lock:
            _scrape_log.clear()
        _scrape_thread = threading.Thread(target=_run_scrape, daemon=True)
        _scrape_thread.start()
        self._send_json(202, {"status": "started"})

    def _serve_status(self) -> None:
        with _state_lock:
            body = {
                "running":    _scrape_running(),
                "log":        list(_scrape_log),
                "started_at": _scrape_started_at,
                "finished_at": _scrape_finished_at,
                "returncode": _scrape_returncode,
            }
        self._send_json(200, body)

    def _serve_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q: queue.Queue = queue.Queue(maxsize=10_000)
        # backfill with anything already accumulated
        with _state_lock:
            _scrape_clients.append(q)
            for event in _scrape_log:
                try: q.put_nowait(event)
                except queue.Full: pass

        try:
            while True:
                try:
                    event = q.get(timeout=20)
                    payload = json.dumps(event)
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
                except queue.Empty:
                    # heartbeat keeps the connection open through proxies
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _state_lock:
                if q in _scrape_clients:
                    _scrape_clients.remove(q)

    # ── Helpers ───────────────────────────────────────────────────────────
    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    if not STATIC_DIR.exists():
        print(f"❌ {STATIC_DIR} does not exist. Run the scraper at least once first.")
        sys.exit(1)
    print(f"📡 Serving {STATIC_DIR}/ at http://localhost:{PORT}")
    print(f"   Scrape endpoint:   POST  /api/scrape")
    print(f"   Status endpoint:   GET   /api/scrape-status")
    print(f"   Progress stream:   GET   /api/scrape-stream  (Server-Sent Events)")
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
