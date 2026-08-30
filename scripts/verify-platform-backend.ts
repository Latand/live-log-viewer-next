/**
 * Proves the process backend this platform selects can actually read the
 * kernel, and fails loudly when it cannot.
 *
 * The Windows cases in `src/lib/proc/windows.test.ts`,
 * `windowsIdentity.test.ts` and `processGroup.test.ts` skip themselves off
 * win32. A silent skip leaves a green job that executed nothing — the exact
 * shape of #1256, where the macOS half of the login fence had never run
 * anywhere and shipped broken. This script runs before those files on each leg
 * of `platform-tests.yml` and refuses a runner that is not what the leg claims,
 * or a backend whose readers return nothing.
 *
 *   bun scripts/verify-platform-backend.ts --expect win32
 *
 * Every stage announces itself and every failure is printed on **stdout**
 * before a nonzero exit: a runner that reports "exit code 1" and nothing else
 * is not a diagnosis, and this script is the first thing a Windows change has
 * to get past. It prints shapes and counts, never paths — the runner's own
 * directories are not interesting and this repository is public.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { selectProcBackend } from "@/lib/proc";
import { windowsProcessCwd } from "@/lib/proc/windowsCwd";
import { windowsProcessIdentity } from "@/lib/proc/windowsIdentity";
import { tryLockFenceExclusive } from "@/runtime-host/fenceLock";
import { RuntimeHostFence } from "@/runtime-host/runtimeHostFence";

const EXPECTED_BACKEND: Partial<Record<NodeJS.Platform, string>> = {
  linux: "linux",
  darwin: "portable",
  win32: "windows",
};

function fail(message: string): never {
  throw new Error(message);
}

function stage(name: string): void {
  console.log(`--- ${name}`);
}

function requireRunner(): NodeJS.Platform {
  const index = process.argv.indexOf("--expect");
  const expected = index >= 0 ? process.argv[index + 1] : undefined;
  if (!expected) fail("usage: verify-platform-backend.ts --expect <platform>");
  if (process.platform !== expected) fail(`expected a ${expected} runner, got ${process.platform}`);
  return process.platform;
}

/**
 * That `bun:ffi` loads and can call into the platform's own C library at all.
 * Both the identity token and the fence lock go through it, and a Bun that
 * cannot reach the kernel here would otherwise surface as three unrelated
 * failures further down.
 */
function verifyForeignFunctionInterface(platform: NodeJS.Platform): void {
  stage("bun:ffi reaches the platform C library");
  const runtimeRequire = createRequire(import.meta.url);
  const ffi = runtimeRequire(`bun:${"ffi"}`) as {
    FFIType: { i32: number; u32: number };
    dlopen(library: string, symbols: Record<string, unknown>): { symbols: Record<string, () => number> };
  };
  const library = platform === "win32"
    ? "kernel32.dll"
    : platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const symbol = platform === "win32" ? "GetCurrentProcessId" : "getpid";
  const returns = platform === "win32" ? ffi.FFIType.u32 : ffi.FFIType.i32;
  const opened = ffi.dlopen(library, { [symbol]: { args: [], returns } });
  const reported = Number(opened.symbols[symbol]!());
  if (reported !== process.pid) fail(`${symbol} returned ${reported}, this process is ${process.pid}`);
  console.log(`bun:ffi: ${library} loaded and ${symbol} agrees with process.pid`);
}

/**
 * The fence's exclusivity, exercised on the primitive rather than through a
 * host boot. `flock` is advisory and `LockFileEx` is mandatory, so this also
 * checks the thing that difference threatens: the owner record must stay
 * readable while the lock is held, because the fence reads it before locking
 * and the CLI's readiness probe reads it on every poll.
 */
function verifyFenceLock(): void {
  stage("the runtime-host fence lock");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-platform-lock-"));
  const filename = path.join(directory, "fence");
  fs.writeFileSync(filename, '{"pid":1}');
  const first = fs.openSync(filename, "r+");
  const second = fs.openSync(filename, "r+");
  try {
    const held = tryLockFenceExclusive({ fd: first, filename });
    if (!held) fail("the fence lock could not be taken at all");
    if (tryLockFenceExclusive({ fd: second, filename })) fail("a second holder took a lock that is supposed to be exclusive");
    if (fs.readFileSync(filename, "utf8") !== '{"pid":1}') fail("the owner record is unreadable while the fence is held");
    held.release();
    const again = tryLockFenceExclusive({ fd: second, filename });
    if (!again) fail("the lock was not released");
    again.release();
  } finally {
    fs.closeSync(first);
    fs.closeSync(second);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("fence lock: exclusive, releasable, and does not block reads of the owner record");
}

/**
 * The fence a viewer creates on a machine it has never run on: the state
 * directory does not exist yet, the record does not exist yet, and the very
 * first boot has to make both. This is what a Windows install does the first
 * time it starts, and it is where a wrong open-flag mask shows up — as ENOENT
 * for a directory that plainly exists, or as EPERM at the first write.
 */
function verifyFenceBootstrap(): void {
  stage("a fence created from nothing, as a first boot does");
  /* Printed because the numbers behind these names are the reason the fence
     asks for its two openings by name on Windows rather than by mask. */
  const flags = Object.entries({
    O_RDWR: fs.constants.O_RDWR,
    O_CREAT: fs.constants.O_CREAT,
    O_EXCL: fs.constants.O_EXCL,
    O_NOFOLLOW: fs.constants.O_NOFOLLOW,
  }).map(([name, value]) => `${name}=${value === undefined ? "absent" : `0x${value.toString(16)}`}`);
  console.log(`open flags this platform reports: ${flags.join(" ")}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-platform-fence-"));
  const filename = path.join(root, "state", "runtime-host.lock");
  const fence = new RuntimeHostFence(filename);
  try {
    fence.acquire();
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as { pid?: number; startIdentity?: unknown };
    if (owner.pid !== process.pid) fail(`the fence recorded pid ${String(owner.pid)}, this process is ${process.pid}`);
    if (typeof owner.startIdentity !== "string" || !owner.startIdentity.startsWith(`${process.pid}:`)) {
      fail("the fence recorded no usable start identity, so the CLI would never accept its own host");
    }
    /* A second holder must be refused while the first holds it, and admitted
       once it lets go — through the whole fence, not just the lock primitive. */
    let refused = false;
    try {
      new RuntimeHostFence(filename, () => true).acquire();
    } catch {
      refused = true;
    }
    if (!refused) fail("a second fence acquired a record the first one holds");
    fence.release();
    const successor = new RuntimeHostFence(filename, () => false);
    successor.acquire();
    successor.release();
  } finally {
    fence.release();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  console.log("fence bootstrap: created its own directory and record, refused a rival, and handed over");
}

function verifyWindowsReaders(): void {
  const backend = selectProcBackend();

  stage("the process-identity token");
  const identity = windowsProcessIdentity(process.pid);
  if (!identity || !identity.startsWith(`${process.pid}:`)) {
    fail("GetProcessTimes reported no creation time for this process; the identity token would be unavailable");
  }
  const creation = identity.slice(identity.indexOf(":") + 1);
  if (!/^\d+$/.test(creation)) fail(`the identity token carries no FILETIME: ${creation.length} characters`);
  console.log(`identity token: pid + a ${creation.length}-digit kernel FILETIME`);

  stage("the working-directory read");
  const cwd = windowsProcessCwd(process.pid);
  if (!cwd) fail("the process-parameters read returned no working directory for this process");
  if (path.resolve(cwd).toLowerCase() !== path.resolve(process.cwd()).toLowerCase()) {
    fail("the process-parameters read returned a working directory that is not this process's own");
  }
  console.log(`working directory: read from the process parameters, ${cwd.length} characters, matches this process`);

  stage("the Win32_Process snapshot");
  const listed = backend.listProcesses();
  if (listed.length < 5) fail(`the Win32_Process snapshot listed ${listed.length} processes; PowerShell or the CSV parse is broken`);
  const self = listed.find((entry) => entry.pid === process.pid);
  if (!self) fail("the Win32_Process snapshot does not contain this process");
  if (!self.argv[0]) fail("the command line of this process did not survive argv splitting");
  console.log(`snapshot: ${listed.length} processes, this one has ${self.argv.length} argv tokens`);

  const parents = backend.ppidMap();
  if (parents.size < 3) fail(`the parent map has ${parents.size} links; the stale-link filter dropped too much`);
  console.log(`parent map: ${parents.size} links after the stale-parent filter`);

  const memory = backend.processMemory([process.pid]).get(process.pid);
  if (!memory || memory.rssBytes <= 0) fail("the snapshot reported no working set for this process");
  if (backend.processCpuMs(process.pid) === null) fail("the snapshot reported no CPU time for this process");
  const system = backend.systemMemory();
  if (!system || system.ramTotal <= 0 || system.ramAvailable <= 0) fail("host memory is unreadable");
  console.log("memory: working set and CPU for this pid, and host totals, all readable");
}

try {
  const platform = requireRunner();
  stage("backend selection");
  const expectedBackend = EXPECTED_BACKEND[platform];
  const selected = selectProcBackend(platform, undefined).name;
  if (selected !== expectedBackend) fail(`${platform} selected the "${selected}" backend, expected "${expectedBackend}"`);
  console.log(`backend: ${platform} selects "${selected}"`);

  verifyForeignFunctionInterface(platform);
  verifyFenceLock();
  verifyFenceBootstrap();
  if (platform === "win32") verifyWindowsReaders();
  console.log("platform readers verified");
} catch (error) {
  /* stdout, not stderr: a Windows runner that reported "exit code 1" and no
     other line is what this whole script exists to stop happening. */
  console.log(`PLATFORM VERIFICATION FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.log(error.stack);
  process.exitCode = 1;
}
