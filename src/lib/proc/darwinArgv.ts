import { createRequire } from "node:module";

/**
 * macOS counterpart of `/proc/<pid>/cmdline`. The kernel keeps the exec-time
 * argument vector of every process and hands it back through
 * `sysctl(KERN_PROCARGS2)`, in this layout:
 *
 *   int argc | executable path (NUL-terminated) | NUL padding |
 *   argc NUL-terminated argv strings | environment strings
 *
 * so the argv this returns is NUL-exact, exactly like the Linux read it
 * mirrors. It deliberately does not go through `ps`: that column is argv
 * already joined by spaces, which cannot be split back without guessing, and
 * the portable backend's `ps` snapshot is up to 5s stale — useless for a pid
 * that was spawned milliseconds ago.
 *
 * Reading another process's arguments this way requires the same real uid,
 * which holds for the children this viewer spawns itself.
 */

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const ARGC_SIZE = 4;
/** Fallback when `kern.argmax` cannot be read; it has been 1 MiB on macOS for
    as long as the sysctl has existed. */
const DEFAULT_ARG_MAX = 1024 * 1024;
/* A host that lowered `kern.argmax` must be believed, not rounded up: the
   kernel refuses a request larger than the value it reports. */
const MIN_ARG_MAX = 4 * 1024;
const MAX_ARG_MAX = 32 * 1024 * 1024;
/** The fence matches argv of four or five entries; the cap only keeps a
    corrupt argc from driving a long parse loop. */
const MAX_ARGC = 4096;

type ProcArgsReader = (pid: number, buffer: Buffer) => number;

interface BunFfiModule {
  FFIType: { i32: number; u32: number; u64: number; ptr: number };
  ptr(buffer: Buffer): unknown;
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: { sysctl: (...args: unknown[]) => number };
  };
}

let cachedReader: ProcArgsReader | null | undefined;
let cachedBuffer: Buffer | null = null;

/** Splits one KERN_PROCARGS2 record into its argv. `bytesRead` is what the
    kernel actually wrote: everything past it is stale or absent, so a record
    that ends early yields null rather than a half-read command line. */
export function parseDarwinProcArgs2(buffer: Buffer, bytesRead: number): string[] | null {
  if (bytesRead < ARGC_SIZE || bytesRead > buffer.byteLength) return null;
  const argc = buffer.readInt32LE(0);
  if (argc <= 0 || argc > MAX_ARGC) return null;

  let cursor = buffer.indexOf(0, ARGC_SIZE);
  if (cursor < 0 || cursor >= bytesRead) return null;
  while (cursor < bytesRead && buffer[cursor] === 0) cursor += 1;

  const argv: string[] = [];
  while (argv.length < argc) {
    const end = buffer.indexOf(0, cursor);
    if (end < 0 || end >= bytesRead) return null;
    argv.push(buffer.toString("utf8", cursor, end));
    cursor = end + 1;
  }
  return argv;
}

function loadReader(): ProcArgsReader | null {
  if (cachedReader !== undefined) return cachedReader;
  if (process.platform !== "darwin") {
    cachedReader = null;
    return cachedReader;
  }
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: [ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.u64],
        returns: ffi.FFIType.i32,
      },
    });
    /* `newp` is ignored while `newlen` is 0, and passing a real (unused)
       buffer keeps every pointer argument a valid one. */
    const unusedNew = Buffer.alloc(8);
    const call = (mib: Buffer, out: Buffer, outLength: Buffer): number => Number(library.symbols.sysctl(
      ffi.ptr(mib),
      mib.byteLength / 4,
      ffi.ptr(out),
      ffi.ptr(outLength),
      ffi.ptr(unusedNew),
      BigInt(0),
    ));
    cachedReader = (pid, buffer) => {
      const mib = Buffer.alloc(12);
      mib.writeInt32LE(CTL_KERN, 0);
      mib.writeInt32LE(KERN_PROCARGS2, 4);
      mib.writeInt32LE(pid, 8);
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(buffer.byteLength));
      if (call(mib, buffer, length) !== 0) return -1;
      const written = Number(length.readBigUInt64LE());
      return Number.isSafeInteger(written) ? written : -1;
    };
    cachedBuffer = Buffer.alloc(readArgMax(call));
  } catch {
    cachedReader = null;
  }
  return cachedReader;
}

/** The buffer has to be exactly `kern.argmax`, which is both the most the
    record can need (it bounds argv and environment at exec time) and the most
    the kernel will accept: asking KERN_PROCARGS2 for more bytes than that
    fails outright, which the fence would read as an unidentifiable process.
    Reading the live value keeps both halves true on a host that changed it. */
function readArgMax(call: (mib: Buffer, out: Buffer, outLength: Buffer) => number): number {
  const mib = Buffer.alloc(8);
  mib.writeInt32LE(CTL_KERN, 0);
  mib.writeInt32LE(KERN_ARGMAX, 4);
  const value = Buffer.alloc(4);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(value.byteLength));
  if (call(mib, value, length) !== 0) return DEFAULT_ARG_MAX;
  const argMax = value.readInt32LE(0);
  return argMax >= MIN_ARG_MAX && argMax <= MAX_ARG_MAX ? argMax : DEFAULT_ARG_MAX;
}

/** Exec-time argv of a live process, or null when it cannot be read — a gone
    or foreign pid, a non-darwin host, or a runtime without the FFI reader. */
export function darwinProcessArgv(pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const reader = loadReader();
  const buffer = cachedBuffer;
  if (!reader || !buffer) return null;
  try {
    return parseDarwinProcArgs2(buffer, reader(pid, buffer));
  } catch {
    return null;
  }
}
