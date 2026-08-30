import { createRequire } from "node:module";

/**
 * The one property the runtime-host singleton fence needs from the OS: an
 * exclusive, non-blocking lock that **the kernel releases when the holding
 * process dies**. That is what makes a host killed with `SIGKILL` — or, on
 * Windows, with `TerminateProcess`, which runs no exit handler at all — leave a
 * fence its successor can take.
 *
 * POSIX gets it from `flock(LOCK_EX | LOCK_NB)` on the descriptor the fence
 * already holds open. Windows has no `flock`; the equivalent is `LockFileEx` on
 * a kernel handle, and the fence's descriptor cannot supply one: Bun's file
 * descriptors on Windows are its own, not the C runtime's, so translating one
 * with `_get_osfhandle` is asking the CRT about a number it never issued.
 * Windows therefore opens the fence file a **second** time through
 * `CreateFileW`, sharing freely so nothing else is disturbed, and locks a byte
 * on that handle. The lock and the handle both die with the process, which is
 * the property being bought.
 *
 * A failure to load is a hard error rather than a silent "unlocked": a fence
 * that cannot lock is not a fence, and two runtime hosts on one endpoint is the
 * outage this module exists to prevent.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001;
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;
/**
 * One byte, far past the owner record, and never the whole file.
 *
 * This is the difference that would otherwise have shipped as a Windows-only
 * outage: `flock` is advisory, so a POSIX contender reads the owner JSON out of
 * a fence another host holds. `LockFileEx` is **mandatory** — a locked range
 * refuses every other handle's read as well — and the fence reads that JSON
 * twice before it locks, while the CLI's readiness probe reads it on every
 * poll. Locking a byte nobody reads keeps the mutual exclusion and leaves the
 * record readable, the same reservation SQLite makes at this offset.
 */
const LOCK_OFFSET = 0x40000000;
const LOCK_BYTES_LOW = 1;
const LOCK_BYTES_HIGH = 0;
/** sizeof(OVERLAPPED) on x64; LockFileEx requires a real, zeroed one. */
const OVERLAPPED_BYTES = 32;
/** OVERLAPPED.Offset / OffsetHigh on x64 (after two ULONG_PTR fields). */
const OVERLAPPED_OFFSET_AT = 16;
const OVERLAPPED_OFFSET_HIGH_AT = 20;

/* GENERIC_READ | GENERIC_WRITE, written out: `|` in JavaScript is a signed
   32-bit operator and would turn 0xC0000000 into a negative number. */
const GENERIC_READ_WRITE = 0xc0000000;
const FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;

/** The fence file, named both ways because each platform locks a different one. */
export interface FenceLockTarget {
  fd: number;
  filename: string;
}

/** A held lock. Releasing twice is harmless; the process dying releases it. */
export interface HeldFenceLock {
  release(): void;
}

interface BunFfiModule {
  FFIType: { i32: number; u32: number; u64: number; ptr: number };
  ptr(buffer: NodeJS.TypedArray): number | bigint;
  dlopen(path: string, symbols: Record<string, unknown>): { symbols: Record<string, (...args: never[]) => unknown> };
}

type LockImplementation = (target: FenceLockTarget) => HeldFenceLock | null;

let cached: LockImplementation | null = null;

function loadFfi(): BunFfiModule {
  const runtimeRequire = createRequire(import.meta.url);
  return runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
}

function posixLock(): LockImplementation {
  const ffi = loadFfi();
  const library = ffi.dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    { flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } },
  );
  const flock = (fd: number, operation: number): number =>
    library.symbols.flock!(fd as never, operation as never) as number;
  return (target) => {
    if (flock(target.fd, LOCK_EX | LOCK_NB) !== 0) return null;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        flock(target.fd, LOCK_UN);
      },
    };
  };
}

/**
 * A Windows HANDLE and a NULL argument are declared `u64`, not `ptr`.
 * Pointer-typed arguments make Bun marshal the value as one of its own pointer
 * objects, and handing that path a bare `0` crashes the process rather than
 * passing NULL. `u64` is the same eight bytes in the same register with none of
 * the marshalling — only the two real buffers below stay `ptr`.
 */
const NULL_ARGUMENT = BigInt(0);
/** CreateFileW answers INVALID_HANDLE_VALUE, which reads as all-ones unsigned. */
const INVALID_HANDLE = BigInt("0xffffffffffffffff");

function windowsLock(): LockImplementation {
  const ffi = loadFfi();
  const { i32, u32, u64, ptr } = ffi.FFIType;
  const kernel32 = ffi.dlopen("kernel32.dll", {
    CreateFileW: { args: [ptr, u32, u32, u64, u32, u32, u64], returns: u64 },
    CloseHandle: { args: [u64], returns: i32 },
    LockFileEx: { args: [u64, u32, u32, u32, u32, ptr], returns: i32 },
    UnlockFileEx: { args: [u64, u32, u32, u32, ptr], returns: i32 },
  });

  const lockRegion = (): Buffer => {
    const overlapped = Buffer.alloc(OVERLAPPED_BYTES);
    overlapped.writeUInt32LE(LOCK_OFFSET, OVERLAPPED_OFFSET_AT);
    overlapped.writeUInt32LE(0, OVERLAPPED_OFFSET_HIGH_AT);
    return overlapped;
  };

  return (target) => {
    /* UTF-16LE and NUL-terminated, because this is the wide entry point and a
       fence path can carry any character a Windows profile name can. */
    const wide = Buffer.from(`${target.filename}\0`, "utf16le");
    const handle = BigInt(kernel32.symbols.CreateFileW!(
      ffi.ptr(wide) as never,
      GENERIC_READ_WRITE as never,
      FILE_SHARE_ALL as never,
      NULL_ARGUMENT as never,
      OPEN_EXISTING as never,
      FILE_ATTRIBUTE_NORMAL as never,
      NULL_ARGUMENT as never,
    ) as bigint | number);
    if (handle === NULL_ARGUMENT || handle === INVALID_HANDLE) {
      throw new Error("runtime host fence file could not be opened for locking");
    }
    const close = (): void => {
      kernel32.symbols.CloseHandle!(handle as never);
    };
    const locked = kernel32.symbols.LockFileEx!(
      handle as never,
      (LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY) as never,
      0 as never,
      LOCK_BYTES_LOW as never,
      LOCK_BYTES_HIGH as never,
      ffi.ptr(lockRegion()) as never,
    ) as number;
    if (locked === 0) {
      close();
      return null;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        kernel32.symbols.UnlockFileEx!(
          handle as never,
          0 as never,
          LOCK_BYTES_LOW as never,
          LOCK_BYTES_HIGH as never,
          ffi.ptr(lockRegion()) as never,
        );
        close();
      },
    };
  };
}

function lockImplementation(): LockImplementation {
  if (!cached) cached = process.platform === "win32" ? windowsLock() : posixLock();
  return cached;
}

/** Takes the exclusive lock without waiting. Null means someone else holds it. */
export function tryLockFenceExclusive(target: FenceLockTarget): HeldFenceLock | null {
  return lockImplementation()(target);
}
