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
MAX_LINE_CHARS = 120
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

REDACTED = "<redacted>"

# A traceback frame is the one line whose whole value is a file path: it is
# kept structurally (path, line number, function) instead of being summarized,
# because a code location is exactly what a crash report is for.
_FRAME = re.compile(r'^\s*File "(.*)", line (\d+)(?:, in (.*))?$')
# The fixed scaffolding Python prints around a traceback: no free text in it.
_SCAFFOLD = (
    "Traceback (most recent call last):",
    "During handling of the above exception, another exception occurred:",
    "The above exception was the direct cause of the following exception:",
)
_FRAME_NAME = re.compile(r"^[A-Za-z0-9_.<>]+$")

# Shapes that are diagnostic by construction and carry no account data: this
# redactor's own markers, log timestamps, errno/signal names, qualified
# exception types, the modules a connector traceback can name, the connector's
# own read-tool names, protocol error constants, and the loopback address.
_SAFE_SHAPE = (
    r"<[a-z]+>"
    r"|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?"
    r"|\[Errno \d{1,5}\]"
    r"|\bSIG[A-Z]{2,}\d*\b"
    r"|\b(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*"
    r"(?:Error|Exception|Warning|Exit|Interrupt|Timeout|Cancelled|Abort|Failure)\b"
    r"|\b(?:telegram_mcp|telethon|mcp|anyio|asyncio|uvicorn|starlette|httpx"
    r"|httpcore|sqlite3|socket|ssl|builtins|__main__)(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b"
    r"|\b(?:get|list|search|export|resolve|incoming|wait)_[a-z][a-z_]{1,40}\b"
    r"|\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b"
    r"|\b127\.0\.0\.1(?::\d{1,5})?\b"
)
# `<` and `>` are held out of the punctuation run so a marker this redactor
# already wrote is re-read as one shape instead of being split apart.
_TOKEN = re.compile(
    "(" + _SAFE_SHAPE + r")|([A-Za-z0-9_]+)|([ \t]+)|([!-/:;=?@\[-`{-~]+|[<>])|(.)"
)
_COLLAPSE = re.compile(r"<redacted>(?:[ \t]*<redacted>)+")
_TRAILING_SPACE = re.compile(r"[ \t]+$")


def _truncate(line):
    if len(line) > MAX_LINE_CHARS:
        return line[:MAX_LINE_CHARS] + "…"
    return line


def _summarize(text):
    """Keep the structured diagnostics; drop every run of free text.

    The vendored runtime puts free-form exception text on stderr, and free-form
    text is where names, chat titles and message content live — a blacklist can
    only remove the shapes it already knows. So the summary is built the other
    way round: an exception class, a signal name, an errno, a protocol error
    constant and the modules a traceback names survive, punctuation survives
    (it carries no identity), and every other run collapses into `<redacted>`.
    """
    pieces = []
    for match in _TOKEN.finditer(text):
        shape, _word, space, punct, _other = match.groups()
        if shape is not None or space is not None or punct is not None:
            pieces.append(match.group(0))
        else:
            pieces.append(REDACTED)
    return _TRAILING_SPACE.sub("", _COLLAPSE.sub(REDACTED, "".join(pieces)))


def redact_stderr_line(line, secrets=()):
    """One connector stderr line, safe to persist.

    Says what died, never who was being read. Error codes, exception types and
    code locations survive; identifiers, handles, paths, credential values and
    every run of free text do not.
    """
    out = line
    for secret in secrets:
        if secret and len(secret) >= 8:
            out = out.replace(secret, REDACTED)
    home = os.path.expanduser("~")
    if home and len(home) > 1:
        out = out.replace(home, "~")
    out = _FOREIGN_HOME.sub(r"/\1/<user>", out)
    if out.strip() in _SCAFFOLD:
        return out.strip()
    frame = _FRAME.match(out)
    if frame is not None:
        name = frame.group(3)
        if name is not None and _FRAME_NAME.match(name) is None:
            name = REDACTED
        summary = '  File "%s", line %s' % (frame.group(1), frame.group(2))
        if name is not None:
            summary += ", in %s" % name
        return _truncate(summary)
    out = _CONTEXT_KEY.sub(r"\1=<redacted>", out)
    out = _HANDLE.sub("@<user>", out)
    out = _LONG_NUMBER.sub("<id>", out)
    out = _OPAQUE_BLOB.sub(REDACTED, out)
    return _truncate(_summarize(out))


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
