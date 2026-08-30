import { createRequire } from "node:module";

/**
 * Another process's working directory on Windows.
 *
 * `agentProcesses` drops every process whose cwd is null
 * (`src/lib/scanner/process.ts`), so a backend that never resolved one would
 * show zero agents on Windows — the acceptance sentence of issue #1201 fails
 * on that alone. Windows has no `/proc/<pid>/cwd` and no `lsof -d cwd`: the
 * only route is to read the target's own process parameters out of its
 * address space, which is what this module does.
 *
 *   OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
 *     -> NtQueryInformationProcess(ProcessBasicInformation)  -> PEB address
 *     -> ReadProcessMemory(PEB + 0x20)                       -> RTL_USER_PROCESS_PARAMETERS
 *     -> ReadProcessMemory(params + 0x38)                    -> CurrentDirectory.DosPath
 *     -> ReadProcessMemory(DosPath.Buffer, DosPath.Length)   -> the UTF-16 path
 *
 * Every offset above is the x64 layout and only the x64 layout, so a 32-bit
 * (WOW64) target is refused rather than read at the wrong offsets — checked
 * with `IsWow64Process`. Claude Code's native binary is 64-bit.
 *
 * Failure is always `null`, never a throw: an elevated process, a process
 * owned by another account, one that exited between the snapshot and the read,
 * or a Viewer running under Node instead of Bun (no `bun:ffi`) all degrade to
 * "cwd unknown", which is exactly what the portable backend reports on macOS
 * when `lsof` has no cwd row. Such a process stays invisible to
 * `agentProcesses`; a Viewer-spawned host is still attributed through its
 * `--session-id` argv.
 *
 * The `windows-latest` leg of `platform-tests.yml` is where this executes:
 * `windows.test.ts` spawns a child in a known directory and requires the read
 * to return that directory.
 */

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;

/** sizeof(PROCESS_BASIC_INFORMATION) on x64, PebBaseAddress at offset 8. */
const PBI_SIZE = 48;
const PBI_PEB_OFFSET = 8;
/** PEB.ProcessParameters (x64). */
const PEB_PARAMETERS_OFFSET = 0x20;
/** RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath (x64): a UNICODE_STRING. */
const PARAMETERS_HEAD_BYTES = 0x50;
const CURDIR_DOSPATH_OFFSET = 0x38;
const UNICODE_STRING_LENGTH_OFFSET = 0;
const UNICODE_STRING_BUFFER_OFFSET = 8;
/** A DosPath longer than this is a torn read, not a path. */
const MAX_DOSPATH_BYTES = 0x7ffe;

interface BunFfiModule {
  FFIType: { i32: number; u32: number; u64: number; ptr: number };
  ptr(buffer: NodeJS.TypedArray): number | bigint;
  dlopen(path: string, symbols: Record<string, unknown>): { symbols: Record<string, (...args: never[]) => unknown> };
}

/*
 * A HANDLE and a remote address cross the boundary as `u64`, never as `ptr`.
 * A pointer-typed argument makes Bun marshal the value through its own pointer
 * objects, and that path crashes the process on a bare integer; `u64` is the
 * same eight bytes in the same register with none of the marshalling. Only the
 * buffers this process owns stay `ptr`, passed through `ffi.ptr`.
 */
const NULL_HANDLE = BigInt(0);

interface WindowsMemoryReader {
  /** The target's process-parameters block address, or null when unreadable. */
  parametersAddress(pid: number): bigint | null;
  /** `size` bytes at `address` in `pid`'s address space, or null. */
  read(pid: number, address: bigint, size: number): Buffer | null;
  /** Releases whatever handle the two calls above opened for `pid`. */
  close(pid: number): void;
}

let cachedReader: WindowsMemoryReader | null | undefined;

/**
 * Recovers the DosPath out of the two raw reads. Pure, so the offsets and the
 * rejection rules are asserted on every platform rather than only where the
 * FFI can run.
 */
export function parseWindowsProcessParametersCwd(
  parameters: Buffer,
  readBuffer: (address: bigint, size: number) => Buffer | null,
): string | null {
  if (parameters.byteLength < PARAMETERS_HEAD_BYTES) return null;
  const dosPath = CURDIR_DOSPATH_OFFSET;
  const length = parameters.readUInt16LE(dosPath + UNICODE_STRING_LENGTH_OFFSET);
  const address = parameters.readBigUInt64LE(dosPath + UNICODE_STRING_BUFFER_OFFSET);
  if (length === 0 || length % 2 !== 0 || length > MAX_DOSPATH_BYTES) return null;
  if (address === BigInt(0)) return null;
  const raw = readBuffer(address, length);
  if (!raw || raw.byteLength < length) return null;
  const text = raw.subarray(0, length).toString("utf16le");
  return text.length === 0 ? null : text;
}

function loadReader(): WindowsMemoryReader | null {
  if (cachedReader !== undefined) return cachedReader;
  if (process.platform !== "win32") {
    cachedReader = null;
    return cachedReader;
  }
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const { i32, u32, u64, ptr } = ffi.FFIType;
    const kernel32 = ffi.dlopen("kernel32.dll", {
      OpenProcess: { args: [u32, i32, u32], returns: u64 },
      CloseHandle: { args: [u64], returns: i32 },
      ReadProcessMemory: { args: [u64, u64, ptr, u64, ptr], returns: i32 },
      IsWow64Process: { args: [u64, ptr], returns: i32 },
    });
    const ntdll = ffi.dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [u64, i32, ptr, u32, ptr], returns: i32 },
    });

    const handles = new Map<number, bigint>();
    const open = (pid: number): bigint | null => {
      const existing = handles.get(pid);
      if (existing !== undefined) return existing;
      for (const access of [
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
      ]) {
        const handle = BigInt(kernel32.symbols.OpenProcess!(access as never, 0 as never, pid as never) as bigint | number);
        if (handle !== NULL_HANDLE) {
          handles.set(pid, handle);
          return handle;
        }
      }
      return null;
    };

    const readInto = (handle: bigint, address: bigint, out: Buffer): boolean => {
      const transferred = Buffer.alloc(8);
      const ok = kernel32.symbols.ReadProcessMemory!(
        handle as never,
        address as never,
        ffi.ptr(out) as never,
        BigInt(out.byteLength) as never,
        ffi.ptr(transferred) as never,
      ) as number;
      return ok !== 0 && transferred.readBigUInt64LE(0) === BigInt(out.byteLength);
    };

    cachedReader = {
      parametersAddress(pid) {
        const handle = open(pid);
        if (handle === null) return null;
        /* A WOW64 target's parameters block uses the 32-bit layout, and every
           offset here is x64. Refuse it instead of reading garbage. */
        const wow64 = Buffer.alloc(4);
        if ((kernel32.symbols.IsWow64Process!(handle as never, ffi.ptr(wow64) as never) as number) !== 0
          && wow64.readInt32LE(0) !== 0) return null;
        const pbi = Buffer.alloc(PBI_SIZE);
        const returned = Buffer.alloc(8);
        const status = ntdll.symbols.NtQueryInformationProcess!(
          handle as never,
          0 as never,
          ffi.ptr(pbi) as never,
          PBI_SIZE as never,
          ffi.ptr(returned) as never,
        ) as number;
        if (status !== 0) return null;
        const peb = pbi.readBigUInt64LE(PBI_PEB_OFFSET);
        if (peb === BigInt(0)) return null;
        const parametersPointer = Buffer.alloc(8);
        if (!readInto(handle, peb + BigInt(PEB_PARAMETERS_OFFSET), parametersPointer)) return null;
        const parameters = parametersPointer.readBigUInt64LE(0);
        return parameters === BigInt(0) ? null : parameters;
      },
      read(pid, address, size) {
        const handle = open(pid);
        if (handle === null || size <= 0) return null;
        const out = Buffer.alloc(size);
        return readInto(handle, address, out) ? out : null;
      },
      close(pid) {
        const handle = handles.get(pid);
        if (handle === undefined) return;
        handles.delete(pid);
        try {
          kernel32.symbols.CloseHandle!(handle as never);
        } catch {
          /* the handle is going away with the process either way */
        }
      },
    };
  } catch {
    cachedReader = null;
  }
  return cachedReader;
}

/** The process's own working directory, or null when Windows will not say. */
export function windowsProcessCwd(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const reader = loadReader();
  if (!reader) return null;
  try {
    const parametersAddress = reader.parametersAddress(pid);
    if (parametersAddress === null) return null;
    const parameters = reader.read(pid, parametersAddress, PARAMETERS_HEAD_BYTES);
    if (!parameters) return null;
    return parseWindowsProcessParametersCwd(parameters, (address, size) => reader.read(pid, address, size));
  } catch {
    return null;
  } finally {
    reader.close(pid);
  }
}
