import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";

import type { McpToolBindings } from "./server";

type RaceRole = "winner" | "contender";

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
} else {
  throw new Error(`unsupported lock child mode: ${String(mode)}`);
}
