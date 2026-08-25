import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { ensureTelegramStateDir } from "./sessionStore";

const CONNECTOR_LOG_FILE = "connector.log";
const LOG_SINK_DIR = "connector-log-sink";
const LOG_SINK_MODULE = "sitecustomize.py";

export const TELEGRAM_CONNECTOR_LOG_MAX_BYTES = 256 * 1024;

/* Loaded by the connector's own Python process through PYTHONPATH. Every
   stdout/stderr write takes the same advisory file lock and retains only the
   newest bytes, so the bound survives the Viewer process that launched it. */
const LOG_SINK_SOURCE = String.raw`import fcntl
import io
import os
import stat
import sys
import threading

try:
    _path = os.environ["LLV_TELEGRAM_CONNECTOR_LOG"]
    _limit = int(os.environ["LLV_TELEGRAM_CONNECTOR_LOG_MAX_BYTES"])
    if _limit <= 0:
        raise ValueError("invalid log limit")
    _flags = os.O_RDWR | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        _flags |= os.O_NOFOLLOW
    _fd = os.open(_path, _flags, 0o600)
    _info = os.fstat(_fd)
    if not stat.S_ISREG(_info.st_mode) or (_info.st_mode & 0o077):
        raise PermissionError("unsafe connector log")
    if hasattr(os, "getuid") and _info.st_uid != os.getuid():
        raise PermissionError("connector log owner mismatch")
except Exception as _error:
    raise SystemExit("connector log sink unavailable") from _error


def _write_all(data):
    view = memoryview(data)
    while view:
        written = os.write(_fd, view)
        view = view[written:]


class _BoundedConnectorLog(io.TextIOBase):
    encoding = "utf-8"
    errors = "backslashreplace"

    def __init__(self):
        self._lock = threading.Lock()

    def writable(self):
        return True

    def isatty(self):
        return False

    def fileno(self):
        return _fd

    def flush(self):
        return None

    def write(self, value):
        if not isinstance(value, str):
            value = str(value)
        data = value.encode(self.encoding, self.errors)
        if not data:
            return len(value)
        with self._lock:
            fcntl.flock(_fd, fcntl.LOCK_EX)
            try:
                size = os.fstat(_fd).st_size
                if len(data) >= _limit:
                    tail = data[-_limit:]
                    os.ftruncate(_fd, 0)
                    _write_all(tail)
                elif size + len(data) > _limit:
                    keep = _limit - len(data)
                    prior = os.pread(_fd, keep, max(0, size - keep))
                    os.ftruncate(_fd, 0)
                    _write_all(prior[-keep:] + data)
                else:
                    _write_all(data)
            finally:
                fcntl.flock(_fd, fcntl.LOCK_UN)
        return len(value)


_sink = _BoundedConnectorLog()
sys.stdout = _sink
sys.stderr = _sink
`;

export function telegramConnectorLogPath(): string {
  return statePath("telegram", CONNECTOR_LOG_FILE);
}

function logSinkDir(): string {
  return statePath("telegram", LOG_SINK_DIR);
}

function assertOwnerOnlyDirectory(directory: string): void {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("unsafe connector log sink directory");
  }
}

function trimExistingLog(): void {
  const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(
    telegramConnectorLogPath(),
    fs.constants.O_RDWR | fs.constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("unsafe connector log");
    }
    if (info.size <= TELEGRAM_CONNECTOR_LOG_MAX_BYTES) return;
    const tail = Buffer.alloc(TELEGRAM_CONNECTOR_LOG_MAX_BYTES);
    fs.readSync(fd, tail, 0, tail.length, info.size - tail.length);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, tail, 0, tail.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Installs the connector-process output sink and returns its minimal env. */
export function connectorLogSinkEnv(): Record<string, string> {
  ensureTelegramStateDir(true);
  const directory = logSinkDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnerOnlyDirectory(directory);

  const target = path.join(directory, LOG_SINK_MODULE);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, LOG_SINK_SOURCE, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  trimExistingLog();
  return {
    PYTHONPATH: directory,
    LLV_TELEGRAM_CONNECTOR_LOG: telegramConnectorLogPath(),
    LLV_TELEGRAM_CONNECTOR_LOG_MAX_BYTES: String(TELEGRAM_CONNECTOR_LOG_MAX_BYTES),
  };
}
