#!/usr/bin/env python3
"""Authenticated entrypoint for the packaged Telegram MCP connector."""

import hashlib
import hmac
import os
import re
import sys


TOKEN = os.environ.get("LLV_TELEGRAM_MCP_TOKEN", "")
VENDOR_DIR = os.environ.get("LLV_TELEGRAM_VENDOR_DIR", "")
EXCLUDED_TOOLS = [
    name.strip()
    for name in os.environ.get("LLV_TELEGRAM_EXCLUDED_TOOLS", "").split(",")
    if name.strip()
]
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


def _withhold_excluded_tools():
    """Remove the tools this connector must not expose (issue #1091).

    The Viewer runs this connector with the incoming event feed on, and the
    feed CONSUMES settled bursts. A blocking wait tool that consumes the same
    bursts would race it — whichever scans first takes one — so the Viewer
    names those tools in LLV_TELEGRAM_EXCLUDED_TOOLS and they are dropped here,
    leaving the feed the only consumer.

    This lives in the Viewer's own entrypoint because upstream's
    TELEGRAM_EXPOSED_TOOLS can only WIDEN a read-only surface with named write
    tools, never narrow it, and the vendored tree stays byte-identical to the
    pinned release. Importing the runner above already registered every tool,
    so the surface is complete by the time it is pruned. An unknown name fails
    the launch: after a vendor bump that renamed a consumer, silently exposing
    it would be exactly the race this prevents.
    """
    if not EXCLUDED_TOOLS:
        return
    registered = {tool.name for tool in mcp._tool_manager.list_tools()}
    unknown = sorted(set(EXCLUDED_TOOLS) - registered)
    if unknown:
        raise SystemExit(
            f"cannot withhold unknown Telegram tool(s): {', '.join(unknown)}"
        )
    for name in EXCLUDED_TOOLS:
        mcp._tool_manager.remove_tool(name)


if __name__ == "__main__":
    _withhold_excluded_tools()
    main()
