#!/usr/bin/env python3
"""Authenticated entrypoint for the packaged Telegram MCP connector."""

import hashlib
import hmac
import os
import re
import sys


TOKEN = os.environ.get("LLV_TELEGRAM_MCP_TOKEN", "")
VENDOR_DIR = os.environ.get("LLV_TELEGRAM_VENDOR_DIR", "")
if len(TOKEN) < 32 or not VENDOR_DIR:
    raise SystemExit("authenticated Telegram MCP configuration is missing")

sys.path.insert(0, VENDOR_DIR)

from mcp.server.fastmcp import FastMCP  # noqa: E402


class BearerAuthMiddleware:
    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            headers = {key.lower(): value for key, value in scope.get("headers", [])}
            if scope.get("path") == "/llv-telegram-proof" and scope.get("method") == "GET":
                nonce = headers.get(b"x-llv-telegram-nonce", b"")
                if not re.fullmatch(rb"[A-Za-z0-9_-]{43}", nonce):
                    await send({"type": "http.response.start", "status": 400, "headers": []})
                    await send({"type": "http.response.body", "body": b"Invalid nonce"})
                    return
                proof = hmac.new(TOKEN.encode("utf-8"), nonce, hashlib.sha256).hexdigest().encode("ascii")
                await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": proof})
                return
            supplied = headers.get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self.expected):
                await send({
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"text/plain; charset=utf-8"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                })
                await send({"type": "http.response.body", "body": b"Unauthorized"})
                return
        await self.app(scope, receive, send)


_original_streamable_http_app = FastMCP.streamable_http_app


def _authenticated_streamable_http_app(self):
    return BearerAuthMiddleware(_original_streamable_http_app(self), TOKEN)


FastMCP.streamable_http_app = _authenticated_streamable_http_app

from telegram_mcp.runtime import mcp  # noqa: E402

mcp._mcp_server.name = f"telegram-{hashlib.sha256(TOKEN.encode('utf-8')).hexdigest()}"

from telegram_mcp.runner import main  # noqa: E402


if __name__ == "__main__":
    main()
