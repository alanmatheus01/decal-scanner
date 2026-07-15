#!/usr/bin/env python3
"""
Minimal, dependency-free HTTP server for robots.json.

Serves exactly one file (nothing else -- not a directory listing) with a
CORS header so the PWA, hosted on a different origin (GitHub Pages), is
allowed to fetch it. Binds to 127.0.0.1 only; `tailscale serve` is what
actually exposes this over HTTPS to your tailnet -- see README.md.

Configuration is via environment variables (see env.example), loaded from
~/.config/decal-scanner/env the same way sync_jira.py does. ROBOTS_JSON_PATH
must point at the same file sync_jira.py writes to.
"""
from __future__ import annotations

import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path.home() / ".config" / "decal-scanner" / "env")
except ImportError:
    pass

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("serve_robots")

ROBOTS_JSON_PATH = Path(
    os.environ.get("ROBOTS_JSON_PATH", str(Path.home() / "decal-scanner-data" / "robots.json"))
).expanduser()
SERVE_HOST = os.environ.get("SERVE_HOST", "127.0.0.1")
SERVE_PORT = int(os.environ.get("SERVE_PORT", "8787"))
SERVE_ALLOWED_ORIGIN = os.environ.get("SERVE_ALLOWED_ORIGIN", "https://alanmatheus01.github.io")


class RobotsJsonHandler(BaseHTTPRequestHandler):
    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", SERVE_ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_HEAD(self) -> None:
        self._respond(include_body=False)

    def do_GET(self) -> None:
        self._respond(include_body=True)

    def _respond(self, include_body: bool) -> None:
        if self.path not in ("/", "/robots.json"):
            self.send_response(404)
            self._cors_headers()
            self.end_headers()
            return

        try:
            data = ROBOTS_JSON_PATH.read_bytes()
        except FileNotFoundError:
            self.send_response(404)
            self._cors_headers()
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            if include_body:
                self.wfile.write(b"robots.json not found -- has sync_jira.py run yet?")
            return
        except OSError as err:
            log.error("Failed to read %s: %s", ROBOTS_JSON_PATH, err)
            self.send_response(500)
            self._cors_headers()
            self.end_headers()
            return

        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        # Freshness is handled by the app's own network-first fetch; don't
        # let any intermediate cache serve a stale copy.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)


def main() -> None:
    server = ThreadingHTTPServer((SERVE_HOST, SERVE_PORT), RobotsJsonHandler)
    log.info(
        "Serving %s on http://%s:%d (allowed origin: %s)",
        ROBOTS_JSON_PATH,
        SERVE_HOST,
        SERVE_PORT,
        SERVE_ALLOWED_ORIGIN,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
