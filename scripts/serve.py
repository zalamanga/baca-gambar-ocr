"""Serve the built app on loopback without exposing the project directory."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUILD_ROOT = PROJECT_ROOT / "dist"


class BuildHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".gz": "application/gzip",
        ".traineddata": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        try:
            decoded = unquote(urlsplit(self.path).path, errors="strict")
            parts = decoded.split("/")
            if "\\" in decoded or "\x00" in decoded or ":" in decoded:
                raise ValueError("Invalid path")
            if any(part.startswith(".") for part in parts if part):
                raise ValueError("Hidden paths are unavailable")
            target = BUILD_ROOT.joinpath(*(part for part in parts if part)).resolve()
            if not target.is_relative_to(BUILD_ROOT.resolve()):
                raise ValueError("Path outside build")
            if target.is_dir():
                target = target / "index.html"
            if not target.is_file() or not target.resolve().is_relative_to(BUILD_ROOT.resolve()):
                raise ValueError("File unavailable")
            source = target.open("rb")
        except (OSError, UnicodeError, ValueError):
            self.send_error(404, "File not found")
            return None

        try:
            stat = target.stat()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(target)))
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.end_headers()
            return source
        except BaseException:
            source.close()
            raise

    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    def reject_method(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.close_connection = True

    do_POST = reject_method
    do_PUT = reject_method
    do_PATCH = reject_method
    do_DELETE = reject_method
    do_OPTIONS = reject_method
    do_TRACE = reject_method
    do_CONNECT = reject_method


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8124)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")
    if BUILD_ROOT.is_symlink() or not (BUILD_ROOT / "index.html").is_file():
        parser.error("Build output is missing. Run npm run build first.")

    handler = partial(BuildHandler, directory=str(BUILD_ROOT))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Baca Gambar: http://127.0.0.1:{args.port} (Ctrl+C untuk berhenti)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
