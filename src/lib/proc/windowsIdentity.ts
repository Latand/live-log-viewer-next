import { createRequire } from "node:module";

/**
 * The Windows process-identity token, read from the kernel.
 *
 * Identity exists to survive pid reuse, and Windows reuses a pid harder than
 * any other platform this repository runs on: pids are handed out in multiples
 * of four from a small table and a freed one comes back within seconds. Every
 * kill path here (`structuredHostControl`, `structuredSpawn`, the agent
 * registry, `signalProcessGroup`) and the runtime-host singleton fence
 * re-reads the identity of a pid before acting on it, so the token has to be a
 * value the OS supplies about *that* process — a counter, a hash of the
 * command line or anything else that merely differs between two processes
 * would be reused along with the pid.
 *
 * `GetProcessTimes`' creation FILETIME is that value: 100 ns ticks since
 * 1601-01-01 UTC, fixed for the life of the process, and the same quantity
 * `/proc/<pid>/stat` field 22 supplies on Linux and `proc_pidinfo`'s
 * `pbi_start_tv{sec,usec}` supplies on macOS. The token is `${pid}:${filetime}`,
 * matching the `pid:` prefix `bin/cli.mjs` already validates on the fence owner
 * record.
 *
 * Deliberately NOT the snapshot's `Win32_Process.CreationDate`: that is a
 * CIM_DATETIME truncated to whole microseconds, so it disagrees with the
 * kernel value in its last digit, and it is up to a TTL old — the exact window
 * a reused pid lives in. The snapshot column orders parents against children
 * (`windowsSnapshot.ts`) and nothing else.
 *
 * When the reader cannot load (the Viewer running under Node instead of Bun,
 * so `bun:ffi` is absent) this returns null, and null propagates as "identity
 * unknown", which every caller treats conservatively — the fence refuses to
 * reclaim an owner it cannot disprove. That is safe but not silent: the CLI's
 * readiness probe requires a string identity in the fence owner record, so a
 * host whose identity reader is dead fails to start rather than running
 * unfenced. `platform-tests.yml` exercises the reader on `windows-latest`.
 */

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/**
 * `GetExitCodeProcess` reports this while a process is running. A Windows
 * process object outlives the process itself for as long as anyone holds a
 * handle to it — the spawning parent always does — and `GetProcessTimes` keeps
 * answering for that corpse. An identity that outlives its process is the one
 * thing this token must not do: `pidAlive` would say gone while the identity
 * said present, and a caller comparing only identities would treat a dead host
 * as a live one. (A process that genuinely exits with 259 reads as alive here.
 * That is the documented ambiguity of this call, and it errs toward refusing to
 * reclaim rather than toward reclaiming something live.)
 */
const STILL_ACTIVE = 259;
/** FILETIME of 2000-01-01T00:00:00Z. A creation time below it is not a real one. */
const MIN_PLAUSIBLE_FILETIME = BigInt("125911584000000000");

type ProcessTimesReader = (pid: number, creation: Buffer) => boolean;

interface BunFfiModule {
  FFIType: { i32: number; u32: number; u64: number; ptr: number };
  ptr(buffer: Buffer): unknown;
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: {
      OpenProcess: (...args: unknown[]) => bigint | number;
      CloseHandle: (...args: unknown[]) => number;
      GetProcessTimes: (...args: unknown[]) => number;
      GetExitCodeProcess: (...args: unknown[]) => number;
    };
  };
}

/* A HANDLE crosses the boundary as `u64`, never as `ptr`: a pointer-typed
   argument makes Bun marshal the value through its own pointer objects, and
   that path crashes the process on a bare integer. `u64` is the same eight
   bytes in the same register. Only real buffers stay `ptr`. */
const NULL_HANDLE = BigInt(0);

let cachedReader: ProcessTimesReader | null | undefined;

/**
 * Formats a creation FILETIME read into `creation` as an identity token. Pure,
 * so the token's shape and its rejection rules are proven on every platform.
 */
export function parseWindowsCreationIdentity(pid: number, creation: Buffer, ok: boolean): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!ok || creation.byteLength < 8) return null;
  const filetime = creation.readBigUInt64LE(0);
  if (filetime < MIN_PLAUSIBLE_FILETIME) return null;
  return `${pid}:${filetime}`;
}

function loadReader(): ProcessTimesReader | null {
  if (cachedReader !== undefined) return cachedReader;
  if (process.platform !== "win32") {
    cachedReader = null;
    return cachedReader;
  }
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const { i32, u32, u64, ptr } = ffi.FFIType;
    const library = ffi.dlopen("kernel32.dll", {
      OpenProcess: { args: [u32, i32, u32], returns: u64 },
      CloseHandle: { args: [u64], returns: i32 },
      GetProcessTimes: { args: [u64, ptr, ptr, ptr, ptr], returns: i32 },
      GetExitCodeProcess: { args: [u64, ptr], returns: i32 },
    });
    cachedReader = (pid, creation) => {
      const handle = BigInt(library.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
      if (handle === NULL_HANDLE) return false;
      const scratch = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
      try {
        const exitCode = Buffer.alloc(4);
        if (library.symbols.GetExitCodeProcess(handle, ffi.ptr(exitCode)) !== 0
          && exitCode.readUInt32LE(0) !== STILL_ACTIVE) return false;
        return library.symbols.GetProcessTimes(
          handle,
          ffi.ptr(creation),
          ffi.ptr(scratch[0]!),
          ffi.ptr(scratch[1]!),
          ffi.ptr(scratch[2]!),
        ) !== 0;
      } finally {
        library.symbols.CloseHandle(handle);
      }
    };
  } catch {
    cachedReader = null;
  }
  return cachedReader;
}

/** `${pid}:${creationFiletime}`, or null when the kernel would not say. */
export function windowsProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const reader = loadReader();
  if (!reader) return null;
  const creation = Buffer.alloc(8);
  try {
    return parseWindowsCreationIdentity(pid, creation, reader(pid, creation));
  } catch {
    return null;
  }
}
