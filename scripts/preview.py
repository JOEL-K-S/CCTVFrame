"""Serve CCTV Viewer locally for testing on PC browser."""
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'app'
PORT = 4800

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f"CCTV Viewer PC Preview: http://127.0.0.1:{PORT}/")
    httpd.serve_forever()

