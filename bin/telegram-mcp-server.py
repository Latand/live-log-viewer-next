#!/usr/bin/env python3
"""Authenticated entrypoint for the packaged Telegram MCP connector."""

import hashlib
import hmac
import json
import os
import re
import signal
import sys


TOKEN = os.environ.get("LLV_TELEGRAM_MCP_TOKEN", "")
VENDOR_DIR = os.environ.get("LLV_TELEGRAM_VENDOR_DIR", "")
if len(TOKEN) < 32 or not VENDOR_DIR:
    raise SystemExit("authenticated Telegram MCP configuration is missing")

sys.path.insert(0, VENDOR_DIR)

from mcp.server.fastmcp import FastMCP  # noqa: E402


# Set once the supervisor asks this process to stop (issue #1087). Between the
# signal and the exit, every MCP request is answered with a distinguishable
# "restarting" error instead of a bare connection reset, so a caller whose call
# was dropped by a connector restart can tell that apart from a network blip.
DRAINING = False
RESTART_HEADER = b"x-llv-telegram-restarting"
MAX_TRACKED_BODY = 64 * 1024
RESTARTING_BODY = json.dumps(
    {
        "jsonrpc": "2.0",
        "id": None,
        "error": {
            "code": -32001,
            "message": (
                "Telegram connector is restarting: the Agent Log Viewer supervisor "
                "stopped this process. In-flight calls were dropped; retry shortly."
            ),
        },
    }
).encode("utf-8")


def _begin_drain(*_args) -> None:
    global DRAINING
    DRAINING = True


def _install_drain_marker() -> None:
    """Mark the drain on SIGTERM/SIGINT without displacing anyone's handler.

    uvicorn installs its own signal handlers when it starts serving, long after
    this module runs, so hooking the flag in has to survive a later
    registration: wrap ``signal.signal`` so every handler registered for these
    two signals sets the flag first and then runs unchanged.
    """
    registered = signal.signal

    def signal_with_drain(signum, handler):
        if signum in (signal.SIGTERM, signal.SIGINT) and callable(handler):
            inner = handler

            def wrapped(sig, frame):
                _begin_drain()
                return inner(sig, frame)

            return registered(signum, wrapped)
        return registered(signum, handler)

    signal.signal = signal_with_drain
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            signal_with_drain(signum, signal.getsignal(signum))
        except (TypeError, ValueError, OSError):
            # A default/ignored disposition has no handler to chain; uvicorn's
            # later registration goes through the wrapper anyway.
            pass


_install_drain_marker()


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
            # Authenticated, but this process is on its way out: answer with
            # the distinguishable restart error rather than letting the caller
            # meet a closed socket (#1087).
            if DRAINING:
                await send({
                    "type": "http.response.start",
                    "status": 503,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"retry-after", b"5"),
                        (RESTART_HEADER, b"1"),
                    ],
                })
                await send({"type": "http.response.body", "body": RESTARTING_BODY})
                return
            await self.serve_with_restart_notice(scope, receive, send)
            return
        await self.app(scope, receive, send)

    async def serve_with_restart_notice(self, scope, receive, send):
        """Run the MCP app, and finish a response the shutdown cut short.

        Stopping the connector cancels the session task that is streaming a
        tool call, and the ASGI app then returns with the response started but
        never completed — the caller sees a stream that just stops, which is
        indistinguishable from a network blip (#1087). Complete it here with a
        JSON-RPC error that names the restart.
        """
        state = {"started": False, "completed": False, "sse": False}
        body = bytearray()

        async def tracking_receive():
            message = await receive()
            if message.get("type") == "http.request" and len(body) < MAX_TRACKED_BODY:
                body.extend(message.get("body", b"")[: MAX_TRACKED_BODY - len(body)])
            return message

        async def tracking_send(message):
            kind = message.get("type")
            if kind == "http.response.start":
                state["started"] = True
                for key, value in message.get("headers", []):
                    if key.lower() == b"content-type" and b"text/event-stream" in value.lower():
                        state["sse"] = True
            elif kind == "http.response.body" and not message.get("more_body", False):
                state["completed"] = True
            await send(message)

        await self.app(scope, tracking_receive, tracking_send)
        if state["started"] and not state["completed"]:
            await send({"type": "http.response.body", "body": restart_notice(bytes(body), state["sse"]), "more_body": False})


def restart_notice(request_body: bytes, as_event_stream: bool) -> bytes:
    """A JSON-RPC error for the request that a restart cut short, addressed to
    the request id when one can still be read out of the body."""
    notice = json.loads(RESTARTING_BODY)
    try:
        parsed = json.loads(request_body or b"{}")
        if isinstance(parsed, dict) and "id" in parsed:
            notice["id"] = parsed["id"]
    except (ValueError, TypeError):
        pass
    payload = json.dumps(notice)
    if as_event_stream:
        return f"event: message\ndata: {payload}\n\n".encode("utf-8")
    return payload.encode("utf-8")


_original_streamable_http_app = FastMCP.streamable_http_app


def _authenticated_streamable_http_app(self):
    return BearerAuthMiddleware(_original_streamable_http_app(self), TOKEN)


FastMCP.streamable_http_app = _authenticated_streamable_http_app

from telegram_mcp.runtime import mcp  # noqa: E402

mcp._mcp_server.name = f"telegram-{hashlib.sha256(TOKEN.encode('utf-8')).hexdigest()}"

from telegram_mcp.runner import main  # noqa: E402


if __name__ == "__main__":
    main()
