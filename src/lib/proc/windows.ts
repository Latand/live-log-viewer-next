import { spawnSync } from "node:child_process";
import os from "node:os";

import type { ProcBackend, ProcessMemory, ProcSnapshotEntry, SystemMemory } from "./types";
import { windowsProcessCwd } from "./windowsCwd";
import { windowsProcessIdentity } from "./windowsIdentity";
import {
  normalizeWindowsCwd,
  parseWindowsProcessSnapshot,
  snapshotEntries,
  type WindowsSnapshot,
} from "./windowsSnapshot";

/**
 * The Windows process backend: the third one, beside Linux's `/proc` reader and
 * the POSIX `ps`/`lsof` portable backend. It exists because `portableBackend`
 * is not merely slower on Windows, it is empty there — it shells out to `ps`,
 * `lsof`, `vm_stat` and `sysctl`, none of which exist, and its identity token
 * is Darwin-only. Selecting it on win32 would make every scan return nothing.
 *
 * One Windows PowerShell call per TTL supplies pid, parent pid, command line,
 * working set and creation time for every process; `Get-CimInstance
 * Win32_Process` is the only always-present source with all five columns
 * (`tasklist` has no lineage, `wmic` is gone from Windows 11 24H2, and
 * `Get-Process` on Windows PowerShell 5.1 has no command line). The parsing of
 * that output lives in `windowsSnapshot.ts` and is pure. The two things
 * PowerShell cannot supply come from the kernel through `bun:ffi`: the identity
 * token (`windowsIdentity.ts`) and the working directory (`windowsCwd.ts`).
 *
 * Nobody working on this repository has a Windows machine. Everything here
 * that touches the OS is exercised by the `windows-latest` leg of
 * `.github/workflows/platform-tests.yml`, and everything that is a rule about
 * bytes is a pure function with a test that runs on every platform.
 */

const SNAPSHOT_TTL_MS = 5_000;
const RUN_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Windows has no cheap "does this process have a console" probe, and the field
 * is only ever compared against 0 (see `types.ts`). Zero means headless, which
 * both makes a process a reaper candidate and *blocks* the cwd-fallback
 * transcript attribution. Reporting a constant nonzero keeps interactive Claude
 * sessions attributable and keeps the (opt-in, unported) reaper from ever
 * selecting a Windows process.
 */
const CONSTANT_TTY = 1;

/**
 * CSV, not JSON: Windows PowerShell 5.1 serialises a DateTime into JSON as
 * `/Date(ms)/` and drops everything below the millisecond, and the whole point
 * of the `Created` column is ordering a parent against its child. The
 * `ToFileTimeUtc()` projection carries the value as an integer instead.
 *
 * The script is handed over as `-EncodedCommand` (UTF-16LE base64) so that no
 * layer between here and PowerShell — Node's Windows argument quoting,
 * `CreateProcess`, PowerShell's own re-parse — can reinterpret a quote or a
 * dollar sign in it.
 */
export const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  /* UTF-8 so a non-ASCII path survives the console encoding, and explicitly
     *without* a byte-order mark: `[System.Text.Encoding]::UTF8` carries a BOM
     preamble, and a BOM in front of the header turns the first column name into
     something `indexOf` does not find — a silently empty process table. The
     parser strips one anyway; this keeps it from being written. */
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "Get-CimInstance Win32_Process |",
  " Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime,",
  "  @{n='Created';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() }}} |",
  " ConvertTo-Csv -NoTypeInformation",
].join("\n");

/** PowerShell's `-EncodedCommand` argument for `script`. Pure. */
export function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runSnapshotCommand(): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShellCommand(WINDOWS_PROCESS_SNAPSHOT_SCRIPT)],
    { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: RUN_TIMEOUT_MS, windowsHide: true },
  );
  /* A missing or refused PowerShell degrades to "nothing found", the same way
     the portable backend treats a missing `ps`. It is not silent in practice:
     zero rows means zero agents on the board, and `platform-tests.yml` fails
     when the call stops working on a supported runner. */
  if (result.error || typeof result.stdout !== "string") return "";
  return result.stdout;
}

interface Snapshot {
  at: number;
  data: WindowsSnapshot;
  /** cwd reads are the expensive part; one attempt per pid per snapshot. */
  cwds: Map<number, string | null>;
}

let snapshotMemo: Snapshot | null = null;

/** Test seam: forces the next read to take a fresh snapshot rather than one up
    to five seconds old, so a test that just spawned a child can see it. */
export function resetWindowsSnapshotForTests(): void {
  snapshotMemo = null;
}

function snapshot(): Snapshot {
  const now = Date.now();
  if (snapshotMemo && now - snapshotMemo.at < SNAPSHOT_TTL_MS) return snapshotMemo;
  snapshotMemo = { at: now, data: parseWindowsProcessSnapshot(runSnapshotCommand()), cwds: new Map() };
  return snapshotMemo;
}

function cwdFor(pid: number): string | null {
  const current = snapshot();
  const cached = current.cwds.get(pid);
  if (cached !== undefined) return cached;
  const raw = windowsProcessCwd(pid);
  const resolved = raw === null ? null : normalizeWindowsCwd(raw);
  current.cwds.set(pid, resolved);
  return resolved;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    /* Signal 0 is an existence probe on Windows too: libuv's uv_kill short
       circuits before TerminateProcess when signum is 0. Every other signal
       number would kill the process, so nothing else may be passed here. */
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readArgv(pid: number): string[] {
  return snapshot().data.rows.get(pid)?.argv ?? [];
}

function readCwd(pid: number): string | null {
  return cwdFor(pid);
}

function readPpid(pid: number): number | null {
  return snapshot().data.ppids.get(pid) ?? null;
}

function processIdentity(pid: number): string | null {
  return windowsProcessIdentity(pid);
}

/**
 * `Win32_Process` already counts user and kernel time per process, so the CPU
 * reading the liveness verdict wants costs nothing beyond the snapshot that was
 * taken anyway — unlike macOS, which answers null here. It is snapshot-fresh,
 * so two reads inside one TTL report the same number.
 */
function processCpuMs(pid: number): number | null {
  return snapshot().data.rows.get(pid)?.cpuMs ?? null;
}

/**
 * Reading another process's environment on Windows needs the same
 * ReadProcessMemory walk the cwd read does, plus a whole-block parse, for a
 * value only the Codex hook-path lineage fallback consults. Null here matches
 * macOS, and `scanner/process.ts` already tolerates it.
 */
function readEnvVar(): string | null {
  return null;
}

function listProcesses(): ProcSnapshotEntry[] {
  return snapshotEntries(snapshot().data, cwdFor, CONSTANT_TTY);
}

/**
 * `os.freemem()` on Windows is `GlobalMemoryStatusEx().ullAvailPhys`, which is
 * already the reclaim-aware headroom `ramAvailable` wants; there is no second
 * PowerShell call here. Swap is reported as absent rather than guessed: the
 * page file is not a Unix swap device and the rail only displays the number.
 */
function systemMemory(): SystemMemory | null {
  const ramTotal = os.totalmem();
  if (!ramTotal) return null;
  return { ramTotal, ramAvailable: Math.min(os.freemem(), ramTotal), swapTotal: 0, swapUsed: 0 };
}

function processMemory(pids: Iterable<number>): Map<number, ProcessMemory> {
  const rows = snapshot().data.rows;
  const map = new Map<number, ProcessMemory>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const row = rows.get(pid);
    if (row) map.set(pid, { rssBytes: row.workingSetBytes, swapBytes: 0 });
  }
  return map;
}

function ppidMap(): Map<number, number> {
  return new Map(snapshot().data.ppids);
}

/**
 * No open-handle enumeration. Restoring it would mean walking
 * `NtQuerySystemInformation`'s handle table and resolving each device path,
 * which is large, undocumented and fragile. What degrades is named in the
 * README: a transcript's liveness comes from mtime recency and its owning pid
 * from `--session-id` argv or cwd, never from a live writer's open handle, and
 * background-task `.output` files cannot be mapped to a pid.
 */
function scanFdTargetsUnder(): void {}
function scanFdTargetsFor(): void {}
function pidWritesPath(): boolean {
  return false;
}
function pidHoldsPath(): boolean {
  return false;
}

export const windowsBackend: ProcBackend = {
  name: "windows",
  pidAlive,
  readArgv,
  readCwd,
  readPpid,
  processIdentity,
  processCpuMs,
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
