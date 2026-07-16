import { createRequire } from "node:module";

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const PBI_PID_OFFSET = 12;
const PBI_START_TVSEC_OFFSET = 120;
const PBI_START_TVUSEC_OFFSET = 128;
const MICROSECONDS_PER_SECOND = BigInt(1_000_000);

type ProcPidInfoReader = (pid: number, buffer: Buffer) => number;

interface BunFfiModule {
  FFIType: { i32: number; u64: number; ptr: number };
  ptr(buffer: Buffer): unknown;
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: { proc_pidinfo: (...args: unknown[]) => number };
  };
}

let cachedReader: ProcPidInfoReader | null | undefined;

export class StructuredRuntimeRequirementError extends Error {
  override readonly name = "StructuredRuntimeRequirementError";
}

export function assertDarwinStructuredRuntime(
  platform = process.platform,
  versions: { bun?: string } = process.versions,
): void {
  if (platform === "darwin" && !versions.bun) {
    throw new StructuredRuntimeRequirementError("structured hosts on macOS require the Viewer server to run with Bun");
  }
}

export function parseDarwinProcBsdInfoIdentity(pid: number, buffer: Buffer, bytesRead: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || bytesRead < PROC_BSDINFO_SIZE || buffer.byteLength < PROC_BSDINFO_SIZE) return null;
  if (buffer.readUInt32LE(PBI_PID_OFFSET) !== pid) return null;
  const seconds = buffer.readBigUInt64LE(PBI_START_TVSEC_OFFSET);
  const microseconds = buffer.readBigUInt64LE(PBI_START_TVUSEC_OFFSET);
  if (seconds === BigInt(0) || microseconds >= MICROSECONDS_PER_SECOND) return null;
  return `${pid}:${seconds}:${microseconds.toString().padStart(6, "0")}`;
}

function loadReader(): ProcPidInfoReader | null {
  if (cachedReader !== undefined) return cachedReader;
  if (process.platform !== "darwin") {
    cachedReader = null;
    return cachedReader;
  }
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const library = ffi.dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
    });
    cachedReader = (pid, buffer) => Number(library.symbols.proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      BigInt(0),
      ffi.ptr(buffer),
      buffer.byteLength,
    ));
  } catch {
    cachedReader = null;
  }
  return cachedReader;
}

export function darwinProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const reader = loadReader();
  if (!reader) return null;
  const buffer = Buffer.alloc(PROC_BSDINFO_SIZE);
  try {
    return parseDarwinProcBsdInfoIdentity(pid, buffer, reader(pid, buffer));
  } catch {
    return null;
  }
}
