import { createHash, randomBytes } from "node:crypto";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 15 * 60_000;

function digest(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

/**
 * Runtime-host-owned, single-use authority for managed MCP health probes.
 *
 * A long-lived runtime host, or the fenced bootstrap host that precedes it,
 * holds this set. A short-lived deployment probe receives a random capability
 * for the child it is about to launch; the managed MCP child must redeem it
 * before its two health reads are admitted. Agent registry rows and launch
 * receipts never participate.
 */
export class McpHealthProbeAdmissions {
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  issue(): string {
    this.prune();
    const capability = randomBytes(32).toString("base64url");
    this.pending.set(digest(capability), this.now() + this.ttlMs);
    return capability;
  }

  consume(capability: unknown): boolean {
    this.prune();
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) return false;
    const key = digest(capability);
    const expiresAt = this.pending.get(key);
    if (expiresAt === undefined) return false;
    this.pending.delete(key);
    return expiresAt > this.now();
  }

  revoke(capability: string): void {
    if (CAPABILITY_PATTERN.test(capability)) this.pending.delete(digest(capability));
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(key);
    }
  }
}
