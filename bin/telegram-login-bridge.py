#!/usr/bin/env python3
"""Viewer-owned Telegram enrollment bridge (issue #1059).

Runs from the same Telethon environment as the vendored connector
(vendor/telegram-mcp) and speaks a small sanitized NDJSON protocol:

  stdout events (one JSON object per line, nothing else ever printed here):
    {"event": "qr", "url": "tg://login?token=...", "expiresAt": iso}
    {"event": "password_required"}
    {"event": "password_invalid"}
    {"event": "verifying"}
    {"event": "authorized", "session": "<string session>", "identity": {...}}
    {"event": "health", "status": "connected"|"expired"|"error", ...}
    {"event": "logout", "ok": bool, "code": str|None}
    {"event": "failed", "code": "<sanitized code>"}

  stdin control lines:
    enroll:  {"password": "..."}          (only after password_required)
    health:  {"session": "..."}           (first line)
    logout:  {"session": "..."}           (first line)

The session string crosses ONLY these pipes: it is never an argument, never an
environment variable of this process, and never part of an error event. Every
failure is reduced to a sanitized code — raw exception text stays off stdout.
Telegram API credentials arrive as TELEGRAM_API_ID / TELEGRAM_API_HASH in the
environment, exactly as the vendored connector expects.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import os
import sys

from telethon import TelegramClient
from telethon.errors import (
    AuthKeyDuplicatedError,
    AuthKeyUnregisteredError,
    PasswordHashInvalidError,
    SessionPasswordNeededError,
    SessionRevokedError,
)
from telethon.sessions import StringSession
from telegram_mcp.singleton import SessionLock, session_identity

# The whole enrollment self-terminates even if the supervisor dies: an orphaned
# bridge holding a half-done QR login must not linger with a live connection.
ENROLL_DEADLINE_S = 15 * 60
CONNECT_TIMEOUT_S = 30

DEVICE_MODEL = "Agent Log Viewer"
SESSION_LOCK_GRACE_S = 20.0


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def fail(code: str) -> None:
    emit({"event": "failed", "code": code})


def api_credentials() -> tuple[int, str]:
    return int(os.environ["TELEGRAM_API_ID"]), os.environ["TELEGRAM_API_HASH"]


def make_client(session: str | None) -> TelegramClient:
    api_id, api_hash = api_credentials()
    return TelegramClient(
        StringSession(session),
        api_id,
        api_hash,
        device_model=DEVICE_MODEL,
        app_version="1.0",
    )


async def acquire_session_lock(client: TelegramClient) -> SessionLock:
    """Share the connector's exact per-session exclusion boundary."""
    lock = SessionLock("default", session_identity(client))
    await asyncio.to_thread(lock.acquire, grace_seconds=SESSION_LOCK_GRACE_S)
    return lock


def identity_of(user) -> dict:
    name = " ".join(part for part in [user.first_name, user.last_name] if part) or "Telegram account"
    # The numeric account id (issue #1091): names and handles are the operator's
    # to change at any moment, so the id is what "the same account" means to the
    # report-run verifier. A string, because a Telegram id is a 64-bit integer.
    # Read defensively: an authorization that produced an entity without an id
    # is still an authorization, and losing the login over a grouping field
    # would be a far worse failure than reporting no id.
    account_id = getattr(user, "id", None)
    return {
        "name": name,
        "username": user.username or None,
        "id": str(account_id) if isinstance(account_id, int) else None,
    }


async def read_stdin_line() -> dict | None:
    loop = asyncio.get_running_loop()
    line = await loop.run_in_executor(None, sys.stdin.readline)
    if not line:
        return None
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def sign_in_with_password(client: TelegramClient) -> object | None:
    """2FA loop: each invalid password is reported and another one awaited."""
    emit({"event": "password_required"})
    while True:
        control = await read_stdin_line()
        if control is None:
            return None
        entered = control.get("password")
        if not isinstance(entered, str) or not entered:
            continue
        try:
            return await client.sign_in(password=entered)
        except PasswordHashInvalidError:
            emit({"event": "password_invalid"})


async def enroll() -> None:
    client = make_client(None)
    lock = None
    await client.connect()
    try:
        qr = await client.qr_login()
        user = None
        while user is None:
            expires_in = max(5.0, (qr.expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
            emit({"event": "qr", "url": qr.url, "expiresAt": qr.expires.isoformat()})
            try:
                user = await qr.wait(timeout=expires_in)
            except asyncio.TimeoutError:
                # Expired token: mint a fresh one and re-announce it.
                await qr.recreate()
            except SessionPasswordNeededError:
                user = await sign_in_with_password(client)
                if user is None:
                    fail("canceled")
                    return
        emit({"event": "verifying"})
        me = await client.get_me()
        lock = await acquire_session_lock(client)
        emit({
            "event": "authorized",
            "session": client.session.save(),
            "identity": identity_of(me if me is not None else user),
        })
    finally:
        await client.disconnect()
        if lock is not None:
            lock.release()


async def health() -> None:
    control = await read_stdin_line()
    session = control.get("session") if control else None
    if not isinstance(session, str) or not session:
        emit({"event": "health", "status": "error", "code": "bridge_failed"})
        return
    client = make_client(session)
    lock = None
    try:
        lock = await acquire_session_lock(client)
        await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT_S)
        try:
            if not await client.is_user_authorized():
                emit({"event": "health", "status": "expired"})
                return
            me = await client.get_me()
            if me is None:
                emit({"event": "health", "status": "expired"})
                return
            emit({"event": "health", "status": "connected", "identity": identity_of(me)})
        finally:
            await client.disconnect()
    except (AuthKeyUnregisteredError, AuthKeyDuplicatedError, SessionRevokedError):
        emit({"event": "health", "status": "expired"})
    except (asyncio.TimeoutError, ConnectionError, OSError):
        emit({"event": "health", "status": "error", "code": "network_failed"})
    except Exception:
        emit({"event": "health", "status": "error", "code": "bridge_failed"})
    finally:
        if lock is not None:
            lock.release()


async def logout() -> None:
    control = await read_stdin_line()
    session = control.get("session") if control else None
    if not isinstance(session, str) or not session:
        emit({"event": "logout", "ok": False, "code": "bridge_failed"})
        return
    client = make_client(session)
    lock = None
    try:
        lock = await acquire_session_lock(client)
        await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT_S)
        ok = bool(await client.log_out())
        emit({"event": "logout", "ok": ok, "code": None if ok else "logout_failed"})
    except (AuthKeyUnregisteredError, AuthKeyDuplicatedError, SessionRevokedError):
        # Telegram already considers the authorization gone: remote logout is done.
        emit({"event": "logout", "ok": True, "code": None})
    except (asyncio.TimeoutError, ConnectionError, OSError):
        emit({"event": "logout", "ok": False, "code": "network_failed"})
    except Exception:
        emit({"event": "logout", "ok": False, "code": "bridge_failed"})
    finally:
        try:
            await client.disconnect()
        finally:
            if lock is not None:
                lock.release()


async def run(command: str) -> None:
    if command == "enroll":
        try:
            await asyncio.wait_for(enroll(), timeout=ENROLL_DEADLINE_S)
        except asyncio.TimeoutError:
            fail("timed_out")
        except (ConnectionError, OSError):
            fail("network_failed")
        except Exception:
            fail("bridge_failed")
    elif command == "health":
        await health()
    elif command == "logout":
        await logout()
    else:
        fail("bridge_failed")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if "TELEGRAM_API_ID" not in os.environ or "TELEGRAM_API_HASH" not in os.environ:
        fail("credentials_missing")
        sys.exit(1)
    asyncio.run(run(command))


if __name__ == "__main__":
    main()
