import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { darwinProcessIdentity } from "./darwinIdentity";
import { parsePsMemory, parseSwapUsage, parseVmStat } from "./memory";
import type { ProcBackend, ProcessMemory, ProcSnapshotEntry, SystemMemory } from "./types";

/**
 * macOS (and any non-Linux POSIX) backend: no `/proc`, so process state comes
 * from shelling out to `ps` and `lsof`. Both calls are blocking (spawnSync) so
 * this backend's functions stay synchronous like the Linux ones; they are
 * expensive enough (tens of ms to ~1s per call) that every accessor here goes
 * through the same short-TTL snapshot cache instead of spawning per pid.
 *
 * `ps -axo pid=,ppid=,tty=,args=` and `lsof`'s `-F` field output are the two
 * primitives used throughout; both are POSIX/BSD-compatible option forms
 * (verified against lsof 4.99's manual, which is the same upstream project
 * Homebrew ships on macOS — unlike `ps`, lsof's CLI does not fork per-OS).
 */

const SNAPSHOT_TTL_MS = 5_000;
const RUN_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

interface SnapshotRow {
  argv: string[];
  ppid: number | null;
  tty: number;
  cwd: string | null;
}

function runCapture(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
  });
  // A nonzero/absent status (missing binary, no matches, directory vanished
  // mid-scan) degrades to "nothing found" rather than throwing: every caller
  // here treats an empty scan the same as a real empty result.
  if (res.error || typeof res.stdout !== "string") return "";
  return res.stdout;
}

const ttyIds = new Map<string, number>();
let nextTtyId = 1;

/** ps prints "?" (Linux) or "??"/"-" (BSD/macOS) for a process with no
    controlling terminal; anything else gets a stable nonzero id. Callers only
    ever compare against 0, never across two processes, so the id need not be
    the kernel's tty_nr. */
function ttyId(name: string): number {
  if (!name || name === "?" || name === "??" || name === "-") return 0;
  let id = ttyIds.get(name);
  if (id === undefined) {
    id = nextTtyId;
    nextTtyId += 1;
    ttyIds.set(name, id);
  }
  return id;
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

function parsePs(stdout: string): Map<number, { ppid: number | null; tty: number; argv: string[] }> {
  const rows = new Map<number, { ppid: number | null; tty: number; argv: string[] }>();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE_RE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppidNum = Number(match[2]);
    // argv is reconstructed by whitespace-splitting ps's already-joined
    // "args" column: unlike /proc/<pid>/cmdline this loses NUL-delimited
    // exactness, so an argument containing a literal space would split into
    // two tokens. Every consumer of argv (engine sniffing, --session-id
    // lookup, helper-arg matching) only inspects whole single-word tokens,
    // so this degradation is harmless in practice.
    const argv = (match[4] ?? "").trim().split(/\s+/).filter(Boolean);
    rows.set(pid, { ppid: Number.isInteger(ppidNum) && ppidNum > 1 ? ppidNum : null, tty: ttyId(match[3] ?? ""), argv });
  }
  return rows;
}

/** Parses `lsof -F pn` (or any superset with p/n fields) grouped as pid -> name. */
function parsePidNameGroups(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "n" && pid > 0) map.set(pid, value);
  }
  return map;
}

/** Parses `lsof -F pfan` output, calling `visit` once per file entry with its
    resolved name, owning pid, and whether the open mode included write. The
    mode is already in hand from the parse, so the laziness the interface
    requires (for Linux's benefit) costs nothing here: the thunk closes over
    a plain boolean. */
function parseFdEntries(stdout: string, visit: (target: string, pid: number, writable: () => boolean) => void): void {
  let pid = 0;
  let mode = "";
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      mode = "";
    } else if (tag === "f") {
      mode = "";
    } else if (tag === "a") {
      mode = value;
    } else if (tag === "n") {
      if (pid > 0 && value) {
        const writable = mode === "w" || mode === "u";
        visit(value, pid, () => writable);
      }
    }
  }
}

let snapshotMemo: { at: number; byPid: Map<number, SnapshotRow> } | null = null;

/**
 * Always TTL-cached, even for kill-time revalidation: argv/cwd read through
 * a snapshot up to 5s old, so verifyTranscriptPid's engine/cwd checks can be
 * that stale here. The remaining freshness comes from pidAlive (a live
 * process.kill(0) probe) and pidWritesPath (a per-pid lsof call), and every
 * kill path has an inherent verify→signal race anyway; a pid recycled within
 * 5s into a different claude/codex binary in the same cwd is the only case
 * this widens, which does not justify a ~0.5s ps+lsof respawn per request.
 */
function snapshot(): Map<number, SnapshotRow> {
  const now = Date.now();
  if (snapshotMemo && now - snapshotMemo.at < SNAPSHOT_TTL_MS) return snapshotMemo.byPid;

  const ps = parsePs(runCapture("ps", ["-axo", "pid=,ppid=,tty=,args="]));
  // A dedicated bulk cwd pass beats querying each pid one at a time: `-d cwd`
  // restricts lsof to the cwd pseudo-fd of every process in a single call.
  const cwds = parsePidNameGroups(runCapture("lsof", ["-w", "-d", "cwd", "-Fpn"]));

  const byPid = new Map<number, SnapshotRow>();
  for (const [pid, row] of ps) {
    byPid.set(pid, { argv: row.argv, ppid: row.ppid, tty: row.tty, cwd: cwds.get(pid) ?? null });
  }
  snapshotMemo = { at: now, byPid };
  return byPid;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 sends nothing; it only probes whether the pid can be signalled.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readArgv(pid: number): string[] {
  return snapshot().get(pid)?.argv ?? [];
}

function readCwd(pid: number): string | null {
  return snapshot().get(pid)?.cwd ?? null;
}

function readPpid(pid: number): number | null {
  return snapshot().get(pid)?.ppid ?? null;
}

function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "darwin" ? darwinProcessIdentity(pid) : null;
}

/**
 * No portable route to another process's environment without root (macOS has
 * no /proc, and reading another process's memory needs task_for_pid
 * entitlements this app doesn't have). Lineage resolution that depends on
 * this (scanner/links.ts: attachLiveCodexParents) falls back to the ppid
 * chain and the job-state link file, so it still works — it just cannot use
 * the env-var fallback for a hook-exported transcript path.
 */
function readEnvVar(): string | null {
  return null;
}

function listProcesses(): ProcSnapshotEntry[] {
  const list: ProcSnapshotEntry[] = [];
  for (const [pid, row] of snapshot()) {
    list.push({ pid, argv: row.argv, cwd: row.cwd, tty: row.tty });
  }
  return list;
}

/**
 * macOS memory pressure: total from the OS API, available approximated from
 * `vm_stat` page counts, swap from `sysctl vm.swapusage`. Every parse is
 * defensive — a host where `vm_stat` is missing (e.g. the portable backend
 * forced on Linux) yields null and the UI hides the block; a failed swap
 * probe alone hides only the swap row (swapTotal 0).
 */
function systemMemory(): SystemMemory | null {
  const ramTotal = os.totalmem();
  const ramAvailable = parseVmStat(runCapture("vm_stat", []));
  if (!ramTotal || ramAvailable === null) return null;
  const swap = parseSwapUsage(runCapture("sysctl", ["-n", "vm.swapusage"]));
  return {
    ramTotal,
    ramAvailable: Math.min(ramAvailable, ramTotal),
    swapTotal: swap?.swapTotal ?? 0,
    swapUsed: swap?.swapUsed ?? 0,
  };
}

/** One bulk `ps` pass; per-process swap has no portable source, so swapBytes
    is 0 and callers show RSS alone. */
function processMemory(pids: Iterable<number>): Map<number, ProcessMemory> {
  const wanted = new Set<number>();
  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 0) wanted.add(pid);
  }
  const map = new Map<number, ProcessMemory>();
  if (wanted.size === 0) return map;
  for (const [pid, rssBytes] of parsePsMemory(runCapture("ps", ["-axo", "pid=,rss="]))) {
    if (wanted.has(pid)) map.set(pid, { rssBytes, swapBytes: 0 });
  }
  return map;
}

function ppidMap(): Map<number, number> {
  const map = new Map<number, number>();
  for (const [pid, row] of snapshot()) {
    if (row.ppid !== null) map.set(pid, row.ppid);
  }
  return map;
}

function scanFdTargetsUnder(underDir: string, visit: (target: string, pid: number, writable: () => boolean) => void): void {
  if (!underDir || !fs.existsSync(underDir)) return;
  parseFdEntries(runCapture("lsof", ["-w", "+D", underDir, "-Fpfan"]), visit);
}

function scanFdTargetsFor(paths: string[], visit: (target: string, pid: number, writable: () => boolean) => void): void {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return;
  parseFdEntries(runCapture("lsof", ["-w", "-Fpfan", "--", ...unique]), visit);
}

function pidWritesPath(pid: number, pathname: string): boolean {
  let writes = false;
  parseFdEntries(runCapture("lsof", ["-w", "-a", "-p", String(pid), "-Fpfan", "--", pathname]), (_t, _p, writable) => {
    if (writable()) writes = true;
  });
  return writes;
}

function pidHoldsPath(pid: number, pathname: string): boolean {
  let holds = false;
  parseFdEntries(runCapture("lsof", ["-w", "-a", "-p", String(pid), "-Fpfan", "--", pathname]), () => {
    holds = true;
  });
  return holds;
}

export const portableBackend: ProcBackend = {
  name: "portable",
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
