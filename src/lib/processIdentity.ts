import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { procBackend } from "@/lib/proc";

/** Durable process authority. The boot epoch disambiguates a repeated
    pid/start-token pair after a reboot. Older records omit it and remain
    fail-closed until a current writer republishes them. */
export interface ProcessIdentity {
  pid: number;
  startIdentity: string | null;
  bootEpoch?: string | null;
}

export interface ProcessIdentityProbe {
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  bootEpoch(): string | null;
}

export type ProcessIdentityStatus = "alive" | "dead" | "unverified";

let cachedBootEpoch: string | null | undefined;

/** Stable boot identity, or an equivalent process-token domain, for the Viewer
    and its engine children. Unsupported probes remain unverified. */
export function systemBootEpoch(): string | null {
  if (cachedBootEpoch !== undefined) return cachedBootEpoch;
  if (process.platform === "linux") {
    try {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
      cachedBootEpoch = bootId && pidNamespace
        ? `linux:${bootId}:pidns:${pidNamespace}`
        : null;
    } catch {
      cachedBootEpoch = null;
    }
    return cachedBootEpoch;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2_000 });
    const match = typeof result.stdout === "string"
      ? /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(result.stdout)
      : null;
    cachedBootEpoch = match ? `darwin:${match[1]}:${match[2]}` : null;
    return cachedBootEpoch;
  }
  if (process.platform === "win32") {
    /* Windows startIdentity is an absolute process-creation FILETIME from the
       kernel, so it already disambiguates reboots. This domain marker records
       that equivalent proof beside the token. */
    cachedBootEpoch = "windows:absolute-process-creation-filetime";
    return cachedBootEpoch;
  }
  cachedBootEpoch = null;
  return cachedBootEpoch;
}

const defaultProbe: ProcessIdentityProbe = {
  pidAlive: (pid) => procBackend.pidAlive(pid),
  processIdentity: (pid) => procBackend.processIdentity(pid),
  bootEpoch: systemBootEpoch,
};

export function captureProcessIdentity(
  pid: number,
  probe: ProcessIdentityProbe = defaultProbe,
  knownStartIdentity?: string | null,
): ProcessIdentity {
  return {
    pid,
    startIdentity: knownStartIdentity === undefined ? probe.processIdentity(pid) : knownStartIdentity,
    bootEpoch: probe.bootEpoch(),
  };
}

/** Classifies one recorded identity from current kernel evidence. `dead` is
    proof: the pid vanished, its start token changed, or its boot epoch changed.
    Missing evidence stays `unverified` and cannot authorize a signal or a
    replacement claim. */
export function processIdentityStatus(
  identity: Readonly<ProcessIdentity>,
  probe: ProcessIdentityProbe = defaultProbe,
): ProcessIdentityStatus {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return "dead";
  if (!probe.pidAlive(identity.pid)) return "dead";
  const currentStartIdentity = probe.processIdentity(identity.pid);
  if (identity.startIdentity === null || currentStartIdentity === null) return "unverified";
  if (currentStartIdentity !== identity.startIdentity) return "dead";
  const currentBootEpoch = probe.bootEpoch();
  if (typeof identity.bootEpoch !== "string" || !identity.bootEpoch || currentBootEpoch === null) {
    return "unverified";
  }
  return currentBootEpoch === identity.bootEpoch ? "alive" : "dead";
}

/** Whether an identity can still own a fence. Unknown evidence blocks takeover;
    ownership expires only from a `dead` verdict. */
export function processIdentityMayOwn(
  identity: Readonly<ProcessIdentity>,
  probe: ProcessIdentityProbe = defaultProbe,
): boolean {
  return processIdentityStatus(identity, probe) !== "dead";
}

export function processIdentityProvenDead(
  identity: Readonly<ProcessIdentity>,
  probe: ProcessIdentityProbe = defaultProbe,
): boolean {
  return processIdentityStatus(identity, probe) === "dead";
}

/** CAS comparison for a recorded process. A boot-aware expectation also pins
    the boot epoch; a legacy expectation retains its historical pid/start fence. */
export function sameRecordedProcessIdentity(
  current: Readonly<ProcessIdentity>,
  expected: Readonly<ProcessIdentity>,
): boolean {
  return current.pid === expected.pid
    && current.startIdentity === expected.startIdentity
    && (expected.bootEpoch === undefined || current.bootEpoch === expected.bootEpoch);
}
