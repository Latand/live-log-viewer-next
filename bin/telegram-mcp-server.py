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

# Issue #1087: fork the crash monitor BEFORE anything heavy is imported, so the
# process that outlives this one stays a few kilobytes of standard library. It
# returns only here, in the child that goes on to be the server; the parent
# never comes back from `supervise`. Without a state dir (a bare invocation, a
# test driving the app object directly) the server simply runs unmonitored.
_STATE_DIR = os.environ.get("LLV_TELEGRAM_STATE_DIR", "")
if _STATE_DIR:
    _BIN_DIR = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, _BIN_DIR)
    try:
        from telegram_connector_monitor import supervise  # noqa: E402
    finally:
        if sys.path and sys.path[0] == _BIN_DIR:
            sys.path.pop(0)
    supervise(_STATE_DIR)

sys.path.insert(0, VENDOR_DIR)

from mcp.server.fastmcp import FastMCP  # noqa: E402


# Issue #1087: a call dropped because the supervisor is stopping this process
# must fail with an error that names the restart, not with a stream that simply
# stops (which the caller cannot tell from a network blip).
#
# The supervisor asks BEFORE it signals: an authenticated POST to DRAIN_PATH
# sets the event below, and every request already in flight is finished right
# then with a JSON-RPC error addressed to its own request id. That ordering is
# what makes the guarantee hold — it does not depend on the shutdown reaching
# any particular code path, so the supervisor's SIGKILL escalation can no
# longer be the first thing a caller meets.
DRAIN_PATH = "/llv-telegram-drain"
RESTART_HEADER = b"x-llv-telegram-restarting"
RESTART_CODE = -32001
RESTART_MESSAGE = (
    "Telegram connector is restarting: the Agent Log Viewer supervisor "
    "stopped this process. In-flight calls were dropped; retry shortly."
)
# A response the connector began and did not finish for any other reason is
# also completed, with its own code — never mislabelled as a restart.
INCOMPLETE_CODE = -32603
INCOMPLETE_MESSAGE = (
    "Telegram connector ended this response without completing it."
)
# The JSON-RPC id is echoed so the caller's pending call is the one that
# fails; reading it back needs the request body, capped here.
MAX_TRACKED_BODY = 64 * 1024

_DRAINING = False
_DRAIN_EVENT = None
_DRAIN_LOOP = None


def _drain_event():
    """The event in-flight requests wait on, bound to the serving loop.

    ``asyncio.Event`` refuses to be awaited from a loop other than the one it
    first attached to, and this module is imported long before the server's
    loop exists — so the event is created on first use, from inside the loop,
    and re-created if it is ever reached from a different one.
    """
    global _DRAIN_EVENT, _DRAIN_LOOP
    loop = asyncio.get_running_loop()
    if _DRAIN_EVENT is None or _DRAIN_LOOP is not loop:
        _DRAIN_EVENT = asyncio.Event()
        _DRAIN_LOOP = loop
        if _DRAINING:
            _DRAIN_EVENT.set()
    return _DRAIN_EVENT


def _begin_drain():
    """Latch the drain and wake everything already waiting on it."""
    global _DRAINING
    _DRAINING = True
    _drain_event().set()


def jsonrpc_error(request_body: bytes, code: int, message: str, as_event_stream: bool) -> bytes:
    """A JSON-RPC error frame addressed to the request that was cut short."""
    notice = {"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}
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


class BearerAuthMiddleware:
    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
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
        # Authenticated. The supervisor's own pre-stop call comes through the
        # same bearer check, so nothing unauthenticated can trip the drain.
        if scope.get("path") == DRAIN_PATH and scope.get("method") == "POST":
            _begin_drain()
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json"), (RESTART_HEADER, b"1")],
            })
            await send({"type": "http.response.body", "body": b'{"draining": true}'})
            return
        if _DRAINING:
            # On the way out: answer with the named reason rather than letting
            # the caller meet a closed socket.
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", b"5"),
                    (RESTART_HEADER, b"1"),
                ],
            })
            await send({"type": "http.response.body", "body": jsonrpc_error(b"", RESTART_CODE, RESTART_MESSAGE, False)})
            return
        await self.serve(scope, receive, send)

    async def serve(self, scope, receive, send):
        """Run the MCP app, racing it against the drain.

        A tool call can sit inside the app for as long as Telegram takes. When
        the drain fires first the call is abandoned deliberately and answered
        here, while this process is still alive and its loop still runs — the
        caller gets a named error instead of a truncated stream. A response the
        app started and left unfinished for any other reason is completed too,
        under its own error code.
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

        inner = asyncio.ensure_future(self.app(scope, tracking_receive, tracking_send))
        drained = asyncio.ensure_future(_drain_event().wait())
        try:
            await asyncio.wait({inner, drained}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            drained.cancel()
        if not inner.done():
            inner.cancel()
            try:
                await inner
            except BaseException:  # noqa: BLE001 - the call was abandoned on purpose
                # Whatever the cancelled app raises on its way out (a bare
                # CancelledError, or the exception group an anyio task group
                # unwinds into) is discarded: the caller is about to be told
                # what actually happened, by this handler.
                pass
        if state["completed"]:
            return
        draining = _DRAINING
        if not state["started"] and not draining:
            # Nothing was sent and this is not a shutdown: let the failure
            # surface the way it always did.
            inner.result()
            return
        code, message = (RESTART_CODE, RESTART_MESSAGE) if draining else (INCOMPLETE_CODE, INCOMPLETE_MESSAGE)
        frame = jsonrpc_error(bytes(body), code, message, state["sse"])
        if not state["started"]:
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", b"5"),
                    (RESTART_HEADER, b"1"),
                ],
            })
        await send({"type": "http.response.body", "body": frame, "more_body": False})


_original_streamable_http_app = FastMCP.streamable_http_app


def _authenticated_streamable_http_app(self):
    return BearerAuthMiddleware(_original_streamable_http_app(self), TOKEN)


FastMCP.streamable_http_app = _authenticated_streamable_http_app

from telegram_mcp.runtime import mcp  # noqa: E402

mcp._mcp_server.name = f"telegram-{hashlib.sha256(TOKEN.encode('utf-8')).hexdigest()}"

from telegram_mcp.runner import main  # noqa: E402


if __name__ == "__main__":
    main()
