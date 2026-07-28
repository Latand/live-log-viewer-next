import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { procBackend } from "@/lib/proc";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const MAX_OWNER_BYTES = 4_096;
// Linux and Darwin expose O_CLOEXEC under different numeric values.
const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : 0x00080000;

interface RuntimeHostFenceOwner {
  pid: number;
  startIdentity: string | null;
  acquisitionId?: string;
}

interface BunFfiModule {
  FFIType: { i32: number };
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: { flock: (fd: number, operation: number) => number };
  };
}

let cachedFlock: ((fd: number, operation: number) => number) | null = null;

function flock(fd: number, operation: number): number {
  if (!cachedFlock) {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const library = ffi.dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      {
        flock: {
          args: [ffi.FFIType.i32, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
      },
    );
    cachedFlock = (lockedFd, lockedOperation) => library.symbols.flock(lockedFd, lockedOperation);
  }
  return cachedFlock(fd, operation);
}

function readOwner(fd: number): RuntimeHostFenceOwner | null {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_BYTES) return null;
  const bytes = Buffer.alloc(stat.size);
  if (fs.readSync(fd, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) return null;
  try {
    const owner = JSON.parse(bytes.toString("utf8")) as Partial<RuntimeHostFenceOwner>;
    if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0) return null;
    if (owner.startIdentity !== null && typeof owner.startIdentity !== "string" && owner.startIdentity !== undefined) return null;
    if (owner.acquisitionId !== undefined && (typeof owner.acquisitionId !== "string" || owner.acquisitionId.length < 16)) return null;
    return {
      pid: Number(owner.pid),
      startIdentity: owner.startIdentity ?? null,
      ...(owner.acquisitionId ? { acquisitionId: owner.acquisitionId } : {}),
    };
  } catch {
    return null;
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface RuntimeHostSocketIdentity {
  dev: number;
  ino: number;
}

/**
 * Serializes bootstrap and long-lived runtime-host ownership on one stable
 * inode. The open descriptor is the authority; JSON is diagnostic metadata
 * and a rolling-upgrade guard for predecessors that only owned the pathname.
 */
export class RuntimeHostFence {
  private fd: number | null = null;
  private acquisitionId: string | null = null;

  constructor(
    private readonly filename: string,
    private readonly ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = (owner) => {
      try {
        if (!procBackend.pidAlive(owner.pid)) return false;
        if (owner.startIdentity === null) return true;
        const currentIdentity = procBackend.processIdentity(owner.pid);
        return currentIdentity === null || currentIdentity === owner.startIdentity;
      } catch {
        return true;
      }
    },
  ) {}

  acquire(): void {
    if (this.fd !== null) throw new Error("runtime host singleton fence is held");
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    let created = false;
    let fd: number;
    const openFlags = fs.constants.O_RDWR | O_CLOEXEC | fs.constants.O_NOFOLLOW;
    try {
      fd = fs.openSync(this.filename, openFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = fs.openSync(this.filename, openFlags);
    }

    let locked = false;
    try {
      const observedOwner = readOwner(fd);
      if (!created && !observedOwner) throw new Error("runtime host singleton fence is held");
      if (observedOwner && !observedOwner.acquisitionId && this.ownerAlive(observedOwner)) {
        throw new Error("runtime host singleton fence is held");
      }
      if (flock(fd, LOCK_EX | LOCK_NB) !== 0) throw new Error("runtime host singleton fence is held");
      locked = true;

      const lockedOwner = readOwner(fd);
      if (!created && !lockedOwner) throw new Error("runtime host singleton fence is held");
      if (lockedOwner && !lockedOwner.acquisitionId && this.ownerAlive(lockedOwner)) {
        throw new Error("runtime host singleton fence is held");
      }
      const descriptorIdentity = fs.fstatSync(fd);
      const canonicalIdentity = fs.lstatSync(this.filename);
      if (!descriptorIdentity.isFile() || !sameFile(descriptorIdentity, canonicalIdentity)) {
        throw new Error("runtime host singleton fence changed during acquisition");
      }

      const acquisitionId = crypto.randomUUID();
      const metadata = JSON.stringify({
        pid: process.pid,
        startIdentity: procBackend.processIdentity(process.pid),
        acquisitionId,
      });
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, metadata, 0, "utf8");
      fs.fsyncSync(fd);
      if (!sameFile(fs.fstatSync(fd), fs.lstatSync(this.filename))) {
        throw new Error("runtime host singleton fence changed during acquisition");
      }
      this.fd = fd;
      this.acquisitionId = acquisitionId;
    } catch (error) {
      if (locked) flock(fd, LOCK_UN);
      fs.closeSync(fd);
      throw error;
    }
  }

  /**
   * Detach the canonical name before validating it. A moved replacement is
   * linked back without overwriting a later successor; only the socket inode
   * captured by this acquisition is unlinked from the private retirement path.
   */
  removeOwnedSocket(socketPath: string, identity: RuntimeHostSocketIdentity): void {
    const fd = this.fd;
    const acquisitionId = this.acquisitionId;
    if (fd === null || !acquisitionId) throw new Error("runtime host singleton fence is not held");
    const owner = readOwner(fd);
    if (owner?.acquisitionId !== acquisitionId || !sameFile(fs.fstatSync(fd), fs.lstatSync(this.filename))) {
      throw new Error("runtime host singleton fence changed during socket cleanup");
    }

    const retirementDir = fs.mkdtempSync(path.join(
      path.dirname(socketPath),
      `.${path.basename(socketPath)}.retire-${acquisitionId}-`,
    ));
    const retiredSocket = path.join(retirementDir, "socket");
    try {
      try {
        fs.renameSync(socketPath, retiredSocket);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const retiredIdentity = fs.lstatSync(retiredSocket);
      if (!retiredIdentity.isSocket() || retiredIdentity.dev !== identity.dev || retiredIdentity.ino !== identity.ino) {
        try {
          fs.linkSync(retiredSocket, socketPath);
          fs.unlinkSync(retiredSocket);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        throw new Error("runtime host socket changed during bootstrap probe");
      }
      fs.unlinkSync(retiredSocket);
    } finally {
      try {
        fs.rmdirSync(retirementDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
    }
  }

  release(): void {
    const fd = this.fd;
    this.fd = null;
    this.acquisitionId = null;
    if (fd === null) return;
    try {
      flock(fd, LOCK_UN);
    } finally {
      fs.closeSync(fd);
    }
  }
}
