import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { isNamedPipePath } from "@/lib/runtime/localEndpoint";

import { tryLockFenceExclusive, type HeldFenceLock } from "./fenceLock";

const MAX_OWNER_BYTES = 4_096;

/*
 * How the fence file is opened, and why Windows asks by name.
 *
 * POSIX needs a numeric mask, because `O_CLOEXEC` — which keeps this descriptor
 * out of every spawned child — and `O_NOFOLLOW` — which refuses a fence path
 * that is a symlink — exist nowhere else. Windows has neither concern: a handle
 * is not inheritable unless it is asked to be, and an ordinary open does not
 * traverse a reparse point. `O_NOFOLLOW` is not even defined there, and one
 * absent constant turns the whole `|` mask into `NaN`.
 *
 * Removing it is not enough, and this is the part worth writing down. The
 * Windows runner reports the right numbers for the rest — `O_CREAT` 0x100,
 * `O_EXCL` 0x400, the C runtime's own values, printed by
 * `scripts/verify-platform-backend.ts` — and passing exactly those as a numeric
 * mask still did not perform the open that was asked for: creating answered
 * ENOENT for a directory that plainly exists, and opening an existing record
 * left a descriptor that failed at its first truncate with EPERM. The named
 * forms are translated by the runtime itself and do work. `wx+` is read-write,
 * create, fail-if-exists, and does not truncate; `r+` is read-write on
 * something that must already be there. Both were measured on the Windows leg,
 * after a probe printed beside them had cleared `mkdirSync` of suspicion.
 */
const CREATE_EXCLUSIVE = process.platform === "win32"
  ? "wx+"
  : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (process.platform === "darwin" ? 0x01000000 : 0x00080000) | fs.constants.O_NOFOLLOW;
const OPEN_EXISTING = process.platform === "win32"
  ? "r+"
  : fs.constants.O_RDWR
    | (process.platform === "darwin" ? 0x01000000 : 0x00080000) | fs.constants.O_NOFOLLOW;

interface RuntimeHostFenceOwner {
  pid: number;
  startIdentity: string | null;
  acquisitionId?: string;
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
  private lock: HeldFenceLock | null = null;
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
    try {
      fd = fs.openSync(this.filename, CREATE_EXCLUSIVE, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = fs.openSync(this.filename, OPEN_EXISTING);
    }

    let lock: HeldFenceLock | null = null;
    try {
      const observedOwner = readOwner(fd);
      if (!created && !observedOwner) throw new Error("runtime host singleton fence is held");
      if (observedOwner && !observedOwner.acquisitionId && this.ownerAlive(observedOwner)) {
        throw new Error("runtime host singleton fence is held");
      }
      lock = tryLockFenceExclusive({ fd, filename: this.filename });
      if (!lock) throw new Error("runtime host singleton fence is held");

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
      this.lock = lock;
      this.acquisitionId = acquisitionId;
    } catch (error) {
      lock?.release();
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
    /* A named pipe has no inode to retire: the kernel drops the name when the
       last handle closes. Only the Docker deployment bootstrap calls this, and
       that is Linux-only, but the endpoint kind is what decides, not the caller. */
    if (isNamedPipePath(socketPath)) return;
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
    const lock = this.lock;
    this.fd = null;
    this.lock = null;
    this.acquisitionId = null;
    if (fd === null) return;
    try {
      lock?.release();
    } finally {
      fs.closeSync(fd);
    }
  }
}
