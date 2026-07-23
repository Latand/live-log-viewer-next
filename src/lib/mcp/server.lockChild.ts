import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";

import type { McpToolBindings } from "./server";

type RaceRole = "winner" | "contender";
type CrashBoundary =
  | "pending-open"
  | "pending-partial-write"
  | "pending-fsync"
  | "owner-publish"
  | "recovery-link-publish"
  | "original-unlink"
  | "recovery-link-cleanup"
  | "owner-cleanup";

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function pauseAt(directory: string, role: RaceRole, phase: string): void {
  fs.writeFileSync(path.join(directory, `${role}-${phase}-ready`), "ready");
  waitFor(path.join(directory, `${role}-${phase}-release`));
}

function publishLock(lockPath: string, readyPath: string, releasePath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  const descriptor = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(descriptor, JSON.stringify(owner));
  fs.closeSync(descriptor);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  fs.writeFileSync(readyPath, "ready");
  waitFor(releasePath);
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (current.token === owner.token) fs.unlinkSync(lockPath);
  } catch {
    // The contender may already have retired a deliberately stale fixture.
  }
}

function pauseForCrash(readyPath: string): never {
  fs.writeFileSync(readyPath, "ready");
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
}

function installCrashBoundary(receiptPath: string, boundary: CrashBoundary, readyPath: string): void {
  const lockPath = `${receiptPath}.lock`;
  const originalOpen = fs.openSync.bind(fs);
  const originalWriteFile = fs.writeFileSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const originalLink = fs.linkSync.bind(fs);
  const originalUnlink = fs.unlinkSync.bind(fs);
  let pendingDescriptor: number | null = null;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    pauseForCrash(readyPath);
  };
  fs.openSync = ((filename: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    const descriptor = originalOpen(filename, flags, mode);
    if (String(filename).includes(".recovery-owner-") && String(filename).includes(".pending-v1-")) {
      pendingDescriptor = descriptor;
      if (boundary === "pending-open") fire();
    }
    return descriptor;
  }) as typeof fs.openSync;
  fs.writeFileSync = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    if (boundary === "pending-partial-write" && target === pendingDescriptor) {
      const serialized = typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
      fs.writeSync(target, serialized.slice(0, Math.max(1, Math.floor(serialized.length / 3))));
      fire();
    }
    return originalWriteFile(target, data, options as never);
  }) as typeof fs.writeFileSync;
  fs.fsyncSync = ((descriptor: number) => {
    const result = originalFsync(descriptor);
    if (boundary === "pending-fsync" && descriptor === pendingDescriptor) fire();
    return result;
  }) as typeof fs.fsyncSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    const result = originalLink(existingPath, newPath);
    const target = String(newPath);
    if (boundary === "owner-publish" && /\.recovery-owner-[0-9]+$/.test(target)) fire();
    if (boundary === "recovery-link-publish" && target.endsWith(".recovering")) fire();
    return result;
  }) as typeof fs.linkSync;
  fs.unlinkSync = ((filename: fs.PathLike) => {
    const target = String(filename);
    const result = originalUnlink(filename);
    if (boundary === "original-unlink" && target === lockPath) fire();
    if (boundary === "recovery-link-cleanup" && target.endsWith(".recovering")) fire();
    if (boundary === "owner-cleanup" && /\.recovery-owner-[0-9]+$/.test(target)) fire();
    return result;
  }) as typeof fs.unlinkSync;
}

function installTransientOwnerReadFailure(): void {
  const originalRead = fs.readFileSync.bind(fs);
  let fired = false;
  fs.readFileSync = ((filename: fs.PathOrFileDescriptor, options?: unknown) => {
    if (!fired && typeof filename !== "number" && /\.recovery-owner-[0-9]+$/.test(String(filename))) {
      fired = true;
      throw Object.assign(new Error("injected vanished recovery owner"), { code: "ENOENT" });
    }
    return originalRead(filename, options as never);
  }) as typeof fs.readFileSync;
}

function installNamespaceHandoffPause(
  receiptPath: string,
  pinPath: string,
  readyPath: string,
  releasePath: string,
): void {
  const lockPath = `${receiptPath}.lock`;
  const originalUnlink = fs.unlinkSync.bind(fs);
  let paused = false;
  fs.unlinkSync = ((filename: fs.PathLike) => {
    const target = String(filename);
    if (!paused && target !== lockPath && target.endsWith(".recovering")) {
      paused = true;
      fs.linkSync(filename, pinPath);
      const result = originalUnlink(filename);
      fs.writeFileSync(readyPath, "ready");
      waitFor(releasePath);
      return result;
    }
    return originalUnlink(filename);
  }) as typeof fs.unlinkSync;
}

function installForcedInodeReuse(
  receiptPath: string,
  pinPath: string,
  readyPath: string,
  releasePath: string,
): void {
  const lockPath = `${receiptPath}.lock`;
  const originalOpen = fs.openSync.bind(fs);
  let reused = false;
  fs.openSync = ((filename: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (!reused && String(filename) === lockPath && String(flags).includes("x") && fs.existsSync(pinPath)) {
      try {
        fs.linkSync(pinPath, lockPath);
        const descriptor = originalOpen(lockPath, "r+");
        reused = true;
        fs.writeFileSync(readyPath, String(fs.fstatSync(descriptor).ino));
        waitFor(releasePath);
        return descriptor;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return originalOpen(filename, flags, mode);
  }) as typeof fs.openSync;
}

function publishReusedLock(
  recoveryPath: string,
  lockPath: string,
  readyPath: string,
  releasePath: string,
): void {
  const owner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  const descriptor = fs.openSync(recoveryPath, "r+");
  fs.ftruncateSync(descriptor, 0);
  fs.writeFileSync(descriptor, JSON.stringify(owner));
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fs.linkSync(recoveryPath, lockPath);
  fs.writeFileSync(readyPath, "ready");
  waitFor(releasePath);
  for (const target of [lockPath, recoveryPath]) {
    try {
      const current = JSON.parse(fs.readFileSync(target, "utf8")) as { token?: unknown };
      if (current.token === owner.token) fs.unlinkSync(target);
    } catch {
      // A settled claimant may already have removed an unreferenced alias.
    }
  }
}

async function timedClaim(
  receiptPath: string,
  countPath: string,
  resultPath: string,
  heartbeatPath: string,
): Promise<void> {
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    fs.writeFileSync(heartbeatPath, String(ticks));
  }, 20);
  const startedAt = Date.now();
  try {
    await claimReceipt(receiptPath, countPath, path.join(path.dirname(resultPath), `discarded-${path.basename(resultPath)}`));
    fs.writeFileSync(resultPath, JSON.stringify({ outcome: "completed", ticks, elapsedMs: Date.now() - startedAt }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      ticks,
      elapsedMs: Date.now() - startedAt,
    }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function claimReceipt(
  receiptPath: string,
  countPath: string,
  resultPath: string,
  pausePath?: string,
  pauseReleasePath?: string,
  raceRole?: RaceRole,
  raceDirectory?: string,
  takeoverPausePath?: string,
  takeoverReleasePath?: string,
): Promise<void> {
  const lockPath = `${receiptPath}.lock`;
  if (takeoverPausePath && takeoverReleasePath) {
    const originalLink = fs.linkSync.bind(fs);
    let paused = false;
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      const result = originalLink(existingPath, newPath);
      if (!paused && String(newPath).includes(".recovery-owner-1")) {
        paused = true;
        fs.writeFileSync(takeoverPausePath, "paused");
        waitFor(takeoverReleasePath);
      }
      return result;
    }) as typeof fs.linkSync;
  } else if (raceRole && raceDirectory) {
    const originalOpen = fs.openSync.bind(fs);
    const originalUnlink = fs.unlinkSync.bind(fs);
    const originalLink = fs.linkSync.bind(fs);
    let linked = false;
    let unlinked = false;
    let blockAcquire = false;
    fs.openSync = ((filename: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (raceRole === "contender" && blockAcquire && String(filename) === lockPath) {
        pauseAt(raceDirectory, raceRole, "acquire");
        blockAcquire = false;
      }
      try {
        return originalOpen(filename, flags, mode);
      } catch (error) {
        if (raceRole === "contender"
          && (error as NodeJS.ErrnoException).code === "EEXIST"
          && String(filename) === lockPath) {
          blockAcquire = true;
          fs.writeFileSync(path.join(raceDirectory, `${raceRole}-owner-seen`), "seen");
        }
        throw error;
      }
    }) as typeof fs.openSync;
    fs.unlinkSync = ((filename: fs.PathLike) => {
      if (raceRole === "contender" && !unlinked && String(filename) === lockPath) {
        pauseAt(raceDirectory, raceRole, "before-unlink");
        unlinked = true;
      }
      const result = originalUnlink(filename);
      if (raceRole === "winner" && !unlinked && String(filename) === lockPath) {
        unlinked = true;
        pauseAt(raceDirectory, raceRole, "after-unlink");
      }
      return result;
    }) as typeof fs.unlinkSync;
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      const result = originalLink(existingPath, newPath);
      if (raceRole === "winner" && !linked && String(existingPath) === lockPath) {
        linked = true;
        pauseAt(raceDirectory, raceRole, "after-link");
      }
      return result;
    }) as typeof fs.linkSync;
  } else if (pausePath && pauseReleasePath) {
    const originalUnlink = fs.unlinkSync.bind(fs);
    const originalLink = fs.linkSync.bind(fs);
    let paused = false;
    const pause = () => {
      if (paused) return;
      paused = true;
      fs.writeFileSync(pausePath, "paused");
      waitFor(pauseReleasePath);
    };
    fs.unlinkSync = ((filename: fs.PathLike) => {
      if (String(filename) === lockPath) pause();
      return originalUnlink(filename);
    }) as typeof fs.unlinkSync;
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      const linked = originalLink(existingPath, newPath);
      if (String(existingPath) === lockPath) pause();
      return linked;
    }) as typeof fs.linkSync;
  }

  const { FileMcpReceiptStore, MCP_TOOL_NAMES, createMcpToolService } = await import("./server");
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})]));
  bindings.flow_action = async () => {
    fs.appendFileSync(countPath, `${process.pid}\n`);
    return { operationId: "operation_multiprocess_lock" };
  };
  const service = createMcpToolService(bindings as unknown as McpToolBindings, new FileMcpReceiptStore(receiptPath));
  const result = await service.callTool("flow_action", {
    clientRequestId: "request-multiprocess-lock",
    flowId: "flow_multiprocess",
    action: "pause",
  });
  fs.writeFileSync(resultPath, JSON.stringify(result));
}

async function claimWithMissingRecoveryDirectory(
  receiptPath: string,
  countPath: string,
  resultPath: string,
  heartbeatPath: string,
): Promise<void> {
  const directory = path.dirname(receiptPath);
  const originalReaddir = fs.readdirSync.bind(fs);
  let scans = 0;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (String(target) === directory) {
      scans += 1;
      throw Object.assign(new Error("injected missing receipt directory"), { code: "ENOENT" });
    }
    return originalReaddir(target, options as never);
  }) as typeof fs.readdirSync;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    fs.writeFileSync(heartbeatPath, String(ticks));
  }, 20);
  await Bun.sleep(40);
  const startedAt = Date.now();
  try {
    await claimReceipt(receiptPath, countPath, path.join(directory, "discarded-result.json"));
    fs.writeFileSync(resultPath, JSON.stringify({ outcome: "completed", scans, ticks, elapsedMs: Date.now() - startedAt }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      scans,
      ticks,
      elapsedMs: Date.now() - startedAt,
    }));
  } finally {
    clearInterval(heartbeat);
  }
}

const mode = process.argv[2];
if (mode === "hold") {
  publishLock(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else if (mode === "claim") {
  await claimReceipt(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5]!,
    process.argv[6] || undefined,
    process.argv[7] || undefined,
  );
} else if (mode === "race-claim") {
  await claimReceipt(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5]!,
    undefined,
    undefined,
    process.argv[6] as RaceRole,
    process.argv[7]!,
  );
} else if (mode === "takeover-claim") {
  await claimReceipt(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5]!,
    undefined,
    undefined,
    undefined,
    undefined,
    process.argv[6]!,
    process.argv[7]!,
  );
} else if (mode === "missing-directory-claim") {
  await claimWithMissingRecoveryDirectory(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5]!,
    process.argv[6]!,
  );
} else if (mode === "transient-owner-read-claim") {
  installTransientOwnerReadFailure();
  await claimReceipt(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else if (mode === "crash-claim") {
  installCrashBoundary(process.argv[3]!, process.argv[6] as CrashBoundary, process.argv[7]!);
  await claimReceipt(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else if (mode === "hold-reused") {
  publishReusedLock(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
} else if (mode === "namespace-handoff-claim") {
  installNamespaceHandoffPause(
    process.argv[3]!,
    process.argv[6]!,
    process.argv[7]!,
    process.argv[8]!,
  );
  await claimReceipt(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else if (mode === "reuse-claim") {
  installForcedInodeReuse(process.argv[3]!, process.argv[6]!, process.argv[7]!, process.argv[8]!);
  try {
    await claimReceipt(process.argv[3]!, process.argv[4]!, process.argv[5]!);
  } finally {
    try {
      fs.unlinkSync(process.argv[6]!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
} else if (mode === "timed-claim") {
  await timedClaim(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
} else {
  throw new Error(`unsupported lock child mode: ${String(mode)}`);
}
