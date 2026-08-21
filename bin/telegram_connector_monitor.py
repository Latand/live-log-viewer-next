"""Durable crash monitor for the packaged Telegram connector (issue #1087).

Two things the Viewer cannot do for itself live here.

**The exit status of a connector it did not parent.** The shared connector
outlives the Viewer: after a Viewer restart every connector the operator has is
*adopted* through the pid file, and an adopted process has no exit event — the
kernel hands its status to its own parent and nowhere else. So the parent is
made to be something that survives: this module forks once, the child becomes
the server, and the parent stays as a monitor whose only job is to `waitpid`
and write the result down. A connector killed by the OOM killer — the exact
death a fan-out of large reads invites — is then recorded as `SIGKILL` instead
of as an unexplained disappearance.

**Redaction before persistence.** The connector's stderr is the only evidence
of why it died, but it is not innocent: the vendored error helper logs the
failing call's arguments verbatim (`Error in get_messages (chat_id=…)`) and
tracebacks carry absolute paths under the operator's home. The monitor owns the
child's stderr, so every line is redacted *on the way to disk* rather than
after the fact — nothing raw is ever persisted.

The monitor is deliberately tiny and imports nothing beyond the standard
library: it is forked before the vendored server is imported, and it has to
outlive whatever the server does to itself.

`redact_stderr_line` mirrors `redactConnectorStderrLine` in
`src/lib/telegram/connector.ts`; `packaging.test.ts` runs both over the same
samples so the two cannot drift.
"""

import json
import os
import re
import signal
import sys
import time

EXIT_FILE = "connector-exit.json"
MAX_LINE_CHARS = 400
READ_CHUNK = 65536
# A stderr "line" with no newline in sight is flushed anyway at this width, so
# a server printing a single unbounded blob can never grow the monitor's heap.
MAX_PENDING_BYTES = 8192

_SECRET_ENV_KEYS = (
    "LLV_TELEGRAM_MCP_TOKEN",
    "TELEGRAM_SESSION_STRING",
    "TELEGRAM_API_HASH",
)
# Forwarded to the server child so the supervisor's SIGTERM reaches the process
# that actually serves, and the monitor still lives to record what came of it.
_FORWARDED_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)

_CONTEXT_KEY = re.compile(
    r"\b([A-Za-z_]*(?:chat|user|peer|phone|contact|title|name|query|text|message|entity|alias|folder)[A-Za-z_]*)\s*=\s*[^,)]*",
    re.IGNORECASE,
)
_FOREIGN_HOME = re.compile(r"/(home|Users)/[^/\s:'\"]+")
_HANDLE = re.compile(r"@[A-Za-z0-9_]{4,}")
_LONG_NUMBER = re.compile(r"[+-]?\b\d{5,}\b")
_OPAQUE_BLOB = re.compile(
    r"\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b"
)


def redact_stderr_line(line, secrets=()):
    """One connector stderr line, safe to persist.

    Says what died, never who was being read. Error codes and exception types
    survive; identifiers, handles, paths, and known credential values do not.
    """
    out = line
    for secret in secrets:
        if secret and len(secret) >= 8:
            out = out.replace(secret, "<redacted>")
    home = os.path.expanduser("~")
    if home and len(home) > 1:
        out = out.replace(home, "~")
    out = _FOREIGN_HOME.sub(r"/\1/<user>", out)
    out = _CONTEXT_KEY.sub(r"\1=<redacted>", out)
    out = _HANDLE.sub("@<user>", out)
    out = _LONG_NUMBER.sub("<id>", out)
    out = _OPAQUE_BLOB.sub("<redacted>", out)
    if len(out) > MAX_LINE_CHARS:
        return out[:MAX_LINE_CHARS] + "…"
    return out


def _known_secrets(env=None):
    source = os.environ if env is None else env
    return [source.get(key, "") for key in _SECRET_ENV_KEYS]


def _write_owner_only(path, contents):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, contents.encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _exit_record(child_pid, status):
    """The kernel's verdict on the server child, in the shape the supervisor
    reads: an exit code, or the signal that killed it."""
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            name = signal.Signals(number).name
        except ValueError:
            name = "SIG%d" % number
        exit_code, signal_name = None, name
    else:
        exit_code, signal_name = os.WEXITSTATUS(status), None
    return {
        "version": 1,
        "monitorPid": os.getpid(),
        "pid": child_pid,
        "exitCode": exit_code,
        "signal": signal_name,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
    }


def _die_with_parent():
    """The server must not outlive its monitor.

    A monitor killed outright (the supervisor's SIGKILL escalation) would
    otherwise leave the server holding the loopback port, and the replacement
    could never bind it. `PR_SET_PDEATHSIG` handles this immediately on Linux
    and survives the fork; elsewhere the parent's death is noticed by polling.
    """
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_PDEATHSIG = 1
        if libc.prctl(1, int(signal.SIGKILL), 0, 0, 0) == 0:
            return
    except (OSError, AttributeError, ValueError):
        pass
    import threading

    original = os.getppid()

    def watch():
        while os.getppid() == original:
            time.sleep(1)
        os._exit(1)

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()


def _monitor(child_pid, read_fd, state_dir, secrets):
    """Redact the child's stderr onto our own (the Viewer-owned sink), then
    record how the child went. Never returns."""
    exit_path = os.path.join(state_dir, EXIT_FILE)
    try:
        os.unlink(exit_path)
    except OSError:
        pass

    def forward(number, _frame):
        try:
            os.kill(child_pid, number)
        except OSError:
            pass

    for number in _FORWARDED_SIGNALS:
        try:
            signal.signal(number, forward)
        except (OSError, ValueError):
            pass

    def emit(chunk):
        try:
            os.write(2, (redact_stderr_line(chunk.decode("utf-8", "replace"), secrets) + "\n").encode("utf-8"))
        except OSError:
            pass

    pending = b""
    while True:
        try:
            data = os.read(read_fd, READ_CHUNK)
        except InterruptedError:
            continue
        except OSError:
            break
        if not data:
            break
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            emit(line)
        if len(pending) >= MAX_PENDING_BYTES:
            emit(pending)
            pending = b""
    if pending:
        emit(pending)

    status = 0
    while True:
        try:
            _, status = os.waitpid(child_pid, 0)
            break
        except InterruptedError:
            continue
        except ChildProcessError:
            break
    record = _exit_record(child_pid, status)
    _write_owner_only(exit_path, json.dumps(record))
    # Mirror the child's fate so a Viewer that IS still listening reads the
    # same verdict from the kernel that the record carries.
    if record["signal"] is not None:
        os._exit(128 + os.WTERMSIG(status))
    os._exit(record["exitCode"] or 0)


def supervise(state_dir, secrets=None):
    """Fork the monitor. Returns only in the child, which is the server.

    A platform or a moment that cannot fork runs unmonitored — the connector
    starting matters more than the bookkeeping around it.
    """
    if not state_dir or not os.path.isdir(state_dir):
        return
    known = list(secrets) if secrets is not None else _known_secrets()
    try:
        read_fd, write_fd = os.pipe()
    except OSError:
        return
    try:
        child = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        return
    if child == 0:
        os.close(read_fd)
        try:
            sys.stderr.flush()
        except (OSError, ValueError):
            pass
        os.dup2(write_fd, 2)
        os.close(write_fd)
        _die_with_parent()
        return
    os.close(write_fd)
    _monitor(child, read_fd, state_dir, known)
