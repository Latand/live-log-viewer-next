#!/usr/bin/python3
"""Independent local worker: HTTP stays live until the harness closes stdin."""
import http.server
import os
import sys
import threading


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(str(os.getpid()).encode())

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(server.server_port, flush=True)
sys.stdin.readline()
server.shutdown()
