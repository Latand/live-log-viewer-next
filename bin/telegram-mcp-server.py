#!/usr/bin/env python3
"""Authenticated entrypoint for the packaged Telegram MCP connector."""

import asyncio
import hashlib
import hmac
import json
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


# Issue #1087: three concurrent get_messages pages took the whole connector
# down for ~20 s, and every agent session shares this one process. Agents call
# the loopback port directly, so this wrapper — the Viewer-owned ASGI seam the
# vendored app already runs behind — is the only chokepoint on their path.
# Tool calls beyond the cap queue instead of piling onto the account client;
# a request that waits out the bound is refused, never dropped silently.
GATE_LIMIT = 2
GATE_WAIT_SECONDS = 30.0


def _is_tool_call(body: bytes) -> bool:
    """Only tools/call is gated: the handshake, tools/list and the session
    stream must stay free or the Viewer's own readiness probe would queue
    behind agent reads and be read as a dead connector."""
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return False
    if isinstance(payload, list):
        return any(isinstance(item, dict) and item.get("method") == "tools/call" for item in payload)
    return isinstance(payload, dict) and payload.get("method") == "tools/call"


async def _buffer_request(receive):
    """Reads the request body so the method can be inspected, and returns a
    receive callable that replays it to the wrapped app unchanged."""
    messages = []
    body = b""
    while True:
        message = await receive()
        messages.append(message)
        if message.get("type") != "http.request":
            break
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break
    index = 0

    async def replay():
        nonlocal index
        if index < len(messages):
            message = messages[index]
            index += 1
            return message
        return await receive()

    return body, replay


def _release_late(slots):
    """Gives back a slot granted after its waiter already gave up."""
    def release(task):
        if not task.cancelled() and task.exception() is None:
            slots.release()
    return release


class ToolCallGate:
    def __init__(self, app, limit: int = GATE_LIMIT, wait_seconds: float = GATE_WAIT_SECONDS):
        self.app = app
        self.limit = limit
        self.wait_seconds = wait_seconds
        self._semaphore = None

    def _slots(self):
        # Created on first use so it binds to the loop the server runs on.
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self.limit)
        return self._semaphore

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        body, replay = await _buffer_request(receive)
        if not _is_tool_call(body):
            await self.app(scope, replay, send)
            return
        slots = self._slots()
        waiter = asyncio.ensure_future(slots.acquire())
        try:
            # The WAIT times out; the acquire itself is never cancelled, so a
            # slot handed over at that exact moment cannot be lost — a lost
            # slot would shrink the cap permanently.
            await asyncio.wait_for(asyncio.shield(waiter), self.wait_seconds)
        except asyncio.TimeoutError:
            waiter.add_done_callback(_release_late(slots))
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"retry-after", b"1"),
                ],
            })
            await send({"type": "http.response.body", "body": b"Telegram connector is busy"})
            return
        try:
            await self.app(scope, replay, send)
        finally:
            slots.release()


_original_streamable_http_app = FastMCP.streamable_http_app


def _authenticated_streamable_http_app(self):
    """Auth outermost: an unauthorized request must not consume a gate slot."""
    return BearerAuthMiddleware(ToolCallGate(_original_streamable_http_app(self)), TOKEN)


FastMCP.streamable_http_app = _authenticated_streamable_http_app

from telegram_mcp.runtime import mcp  # noqa: E402

mcp._mcp_server.name = f"telegram-{hashlib.sha256(TOKEN.encode('utf-8')).hexdigest()}"

from telegram_mcp.runner import main  # noqa: E402


if __name__ == "__main__":
    main()
