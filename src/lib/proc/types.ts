/**
 * Process-introspection backend contract. Linux reads `/proc` directly
 * (`linux.ts`); every other platform shells out to `ps`/`lsof` (`portable.ts`).
 * Callers never depend on which backend is active — see `scanner/process.ts`
 * and `tmux.ts`, which hold the platform-independent logic (engine matching,
 * memoization, ppid-chain walks) on top of these primitives.
 */

/** Whole-host memory pressure, all fields in bytes. `ramAvailable` is the
    kernel's reclaim-aware headroom (MemAvailable / vm_stat estimate); plain
    "free" excludes reclaimable caches and badly understates it. A host
    without swap has swapTotal 0. */
export interface SystemMemory {
  ramTotal: number;
  ramAvailable: number;
  swapTotal: number;
  swapUsed: number;
}

/** One process's resident + swapped footprint in bytes. Backends that cannot
    attribute swap per process (portable) report swapBytes 0. */
export interface ProcessMemory {
  rssBytes: number;
  swapBytes: number;
}

/** One live process, as much as a backend can cheaply report about it. */
export interface ProcSnapshotEntry {
  pid: number;
  argv: string[];
  /** Working directory, or null when it could not be determined (permission
      denied, the process exited mid-scan, or — portable only — `lsof` has no
      cwd entry for it). */
  cwd: string | null;
  /** 0 without a controlling terminal; otherwise a nonzero id. The id is only
      ever compared against 0 by callers, never against another process's id,
      so backends are free to choose any stable nonzero value. */
  tty: number;
}

export interface ProcBackend {
  readonly name: "linux" | "portable";

  pidAlive(pid: number): boolean;

  readArgv(pid: number): string[];
  readCwd(pid: number): string | null;
  readPpid(pid: number): number | null;
  /** PID plus a kernel start-time token where the platform exposes one. */
  processIdentity(pid: number): string | null;

  /**
   * Value of an environment variable for a live pid. Reading another
   * process's environment needs root without `/proc`, so the portable
   * backend always returns null here — see its comment for what degrades.
   */
  readEnvVar(pid: number, name: string): string | null;

  /** Every live process on the system, for the claude/codex scan in `agentProcesses`. */
  listProcesses(): ProcSnapshotEntry[];

  /**
   * Host memory pressure, or null when the platform probe fails (no
   * /proc/meminfo and no vm_stat) — null tells callers to hide the numbers,
   * since zeros would render as a full-pressure host.
   */
  systemMemory(): SystemMemory | null;

  /**
   * Resident + swapped bytes for each of `pids` that is still alive; pids
   * that vanished mid-scan are simply absent from the result.
   */
  processMemory(pids: Iterable<number>): Map<number, ProcessMemory>;

  /**
   * pid → ppid for every live process, in one pass — the input for process
   * tree walks (an agent pane's MCP children hold most of its memory).
   */
  ppidMap(): Map<number, number>;

  /**
   * Visits every open-file fd on the system whose target lives under
   * `underDir`. Linux ignores `underDir` — the /proc walk is already
   * whole-system and just as cheap either way; the portable backend scopes
   * an `lsof +D` search to it, which matters for its cost.
   *
   * `writable` is a thunk, not a value: on Linux the open mode costs an
   * extra lstat per fd, which paid eagerly across every fd on a busy system
   * roughly doubles the scan. Callers that ignore the mode (outputHolders)
   * never invoke it; callers that need it (writingHolders) invoke it only
   * for fds whose target already matched a candidate path. The portable
   * backend gets the mode for free out of lsof's field output and just
   * closes over it. The thunk is only valid within its visit call.
   */
  scanFdTargetsUnder(underDir: string, visit: (target: string, pid: number, writable: () => boolean) => void): void;

  /**
   * Visits every open-file fd currently open for any of the given, explicit
   * `paths`. Used when the candidate paths are known up front but scattered
   * outside a single directory (transcript pid attribution): Linux still
   * walks all of /proc, the portable backend passes `paths` straight to
   * `lsof` as filename arguments. `writable` is lazy, as above.
   */
  scanFdTargetsFor(paths: string[], visit: (target: string, pid: number, writable: () => boolean) => void): void;

  /** True when `pid` currently holds `pathname` open for writing. */
  pidWritesPath(pid: number, pathname: string): boolean;

  /** True when `pid` currently holds `pathname` open in any mode. */
  pidHoldsPath(pid: number, pathname: string): boolean;
}
