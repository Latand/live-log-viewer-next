import fs from "node:fs";
import path from "node:path";

import { parseMeminfo, parseProcStatus } from "./memory";
import type { ProcBackend, ProcessMemory, ProcSnapshotEntry, SystemMemory } from "./types";

const PROC = "/proc";

function pidAlive(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && fs.existsSync(path.join(PROC, String(pid)));
}

function readArgv(pid: number): string[] {
  try {
    return fs
      .readFileSync(path.join(PROC, String(pid), "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(path.join(PROC, String(pid), "cwd"));
  } catch {
    return null;
  }
}

function statFields(pid: number): string[] | null {
  let stat: string;
  try {
    stat = fs.readFileSync(path.join(PROC, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  // comm can itself contain parens ("(foo (bar))"), so split after the last ")".
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
}

/** tty_nr from /proc/<pid>/stat; 0 means no controlling terminal. */
function readTty(pid: number): number {
  const fields = statFields(pid);
  const tty = fields ? Number(fields[4]) : NaN;
  return Number.isInteger(tty) && tty > 0 ? tty : 0;
}

/** ppid from /proc/<pid>/stat; null when the process is gone or is pid 1. */
function readPpid(pid: number): number | null {
  const fields = statFields(pid);
  const ppid = fields ? Number(fields[1]) : NaN;
  return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
}

function processIdentity(pid: number): string | null {
  const fields = statFields(pid);
  const startTicks = fields?.[19];
  return startTicks ? `${pid}:${startTicks}` : null;
}

/**
 * Value of `name` in /proc/<pid>/environ. The environ array can carry the
 * variable more than once when wrapper shells re-export it; the last
 * occurrence is what child processes inherit.
 */
function readEnvVar(pid: number, name: string): string | null {
  let environ: string;
  try {
    environ = fs.readFileSync(path.join(PROC, String(pid), "environ"), "utf8");
  } catch {
    return null;
  }
  const prefix = name + "=";
  let value: string | null = null;
  for (const pair of environ.split("\0")) {
    if (pair.startsWith(prefix)) value = pair.slice(prefix.length);
  }
  return value;
}

function systemMemory(): SystemMemory | null {
  try {
    return parseMeminfo(fs.readFileSync(path.join(PROC, "meminfo"), "utf8"));
  } catch {
    return null;
  }
}

/** VmRSS + VmSwap per pid from /proc/<pid>/status. A smaps read would be
    orders of magnitude slower, and status granularity is enough for a
    cleanup UI. */
function processMemory(pids: Iterable<number>): Map<number, ProcessMemory> {
  const map = new Map<number, ProcessMemory>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      map.set(pid, parseProcStatus(fs.readFileSync(path.join(PROC, String(pid), "status"), "utf8")));
    } catch {
      /* exited mid-scan: omit */
    }
  }
  return map;
}

function ppidMap(): Map<number, number> {
  const map = new Map<number, number>();
  let procEntries: fs.Dirent[];
  try {
    procEntries = fs.readdirSync(PROC, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    const fields = statFields(pid);
    const ppid = fields ? Number(fields[1]) : NaN;
    if (Number.isInteger(ppid) && ppid > 0) map.set(pid, ppid);
  }
  return map;
}

function listProcesses(): ProcSnapshotEntry[] {
  const list: ProcSnapshotEntry[] = [];
  let procEntries: fs.Dirent[];
  try {
    procEntries = fs.readdirSync(PROC, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    list.push({ pid, argv: readArgv(pid), cwd: readCwd(pid), tty: readTty(pid) });
  }
  return list;
}

/** The permission bits of a /proc fd symlink encode the open mode
    ("l-wx…" for a writer, "lr-x…" for a reader). */
function fdWritable(fdPath: string): boolean {
  try {
    return (fs.lstatSync(fdPath).mode & 0o200) !== 0;
  } catch {
    return false;
  }
}

function scanAllFdTargets(visit: (target: string, pid: number, writable: () => boolean) => void): void {
  let procEntries: fs.Dirent[];
  try {
    procEntries = fs.readdirSync(PROC, { withFileTypes: true });
  } catch {
    return;
  }

  for (const procEntry of procEntries) {
    if (!procEntry.isDirectory() || !/^\d+$/.test(procEntry.name)) continue;
    const pid = Number(procEntry.name);
    const fdDir = path.join(PROC, procEntry.name, "fd");
    let fds: fs.Dirent[];
    try {
      fds = fs.readdirSync(fdDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const fd of fds) {
      const fdPath = path.join(fdDir, fd.name);
      let target: string;
      try {
        target = fs.readlinkSync(fdPath);
      } catch {
        continue;
      }
      // Lazy: the lstat behind the open mode runs only when the visitor asks,
      // so scans that ignore the mode pay for the readlink alone.
      visit(target, pid, () => fdWritable(fdPath));
    }
  }
}

/** underDir is unused: the /proc walk already covers every fd on the system
    at the same cost regardless of scope, so there is nothing to narrow. */
function scanFdTargetsUnder(_underDir: string, visit: (target: string, pid: number, writable: () => boolean) => void): void {
  scanAllFdTargets(visit);
}

/** paths is unused for the same reason as scanFdTargetsUnder: the whole-/proc
    walk is already as cheap as a scoped one, so callers filter by target. */
function scanFdTargetsFor(_paths: string[], visit: (target: string, pid: number, writable: () => boolean) => void): void {
  scanAllFdTargets(visit);
}

function pidWritesPath(pid: number, pathname: string): boolean {
  let real: string | null;
  try {
    real = fs.realpathSync(pathname);
  } catch {
    real = null;
  }
  const fdDir = path.join(PROC, String(pid), "fd");
  let fds: fs.Dirent[];
  try {
    fds = fs.readdirSync(fdDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const fd of fds) {
    const fdPath = path.join(fdDir, fd.name);
    let target: string;
    try {
      target = fs.readlinkSync(fdPath);
    } catch {
      continue;
    }
    if ((target === pathname || target === real) && fdWritable(fdPath)) return true;
  }
  return false;
}

function pidHoldsPath(pid: number, pathname: string): boolean {
  let fds: fs.Dirent[];
  try {
    fds = fs.readdirSync(path.join(PROC, String(pid), "fd"), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      if (fs.readlinkSync(path.join(PROC, String(pid), "fd", fd.name)) === pathname) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export const linuxBackend: ProcBackend = {
  name: "linux",
  pidAlive,
  readArgv,
  readCwd,
  readPpid,
  processIdentity,
  readEnvVar,
  listProcesses,
  systemMemory,
  processMemory,
  ppidMap,
  scanFdTargetsUnder,
  scanFdTargetsFor,
  pidWritesPath,
  pidHoldsPath,
};
