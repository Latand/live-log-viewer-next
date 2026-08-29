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
/** FILETIME of 2000-01-01T00:00:00Z. A creation time below it is not a real one. */
const MIN_PLAUSIBLE_FILETIME = BigInt("125911584000000000");

type ProcessTimesReader = (pid: number, creation: Buffer) => boolean;

interface BunFfiModule {
  FFIType: { i32: number; u32: number; ptr: number };
  ptr(buffer: Buffer): unknown;
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: {
      OpenProcess: (...args: unknown[]) => unknown;
      CloseHandle: (...args: unknown[]) => number;
      GetProcessTimes: (...args: unknown[]) => number;
    };
  };
}

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
    const library = ffi.dlopen("kernel32.dll", {
      OpenProcess: { args: [ffi.FFIType.u32, ffi.FFIType.i32, ffi.FFIType.u32], returns: ffi.FFIType.ptr },
      CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
      GetProcessTimes: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
    });
    cachedReader = (pid, creation) => {
      const handle = library.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) return false;
      const scratch = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
      try {
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
