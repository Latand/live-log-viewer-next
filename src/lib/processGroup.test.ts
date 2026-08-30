import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { resetWindowsSnapshotForTests } from "@/lib/proc/windows";

import {
  processTreeTerminationOrder,
  signalDetachedProcessGroup,
  signalProcessGroup,
  terminateProcessTree,
  type ProcessTreeSource,
} from "./processGroup";

/*
 * What replaces `kill(-pgid)` where there are no process groups.
 *
 * The rules below are pure or injected, so they hold on every platform; the
 * `windows-latest` leg of `platform-tests.yml` runs the same file with the real
 * `process.platform`, which is what proves `signalProcessGroup` actually takes
 * the tree branch there instead of throwing on a negative pid.
 */

function source(ppids: Array<[number, number]>, identities: Record<number, string | null> = {}): ProcessTreeSource {
  return {
    ppidMap: () => new Map(ppids),
    processIdentity: (pid) => (pid in identities ? identities[pid]! : `${pid}:start`),
  };
}

test("a tree is signalled descendants first and the leader last", () => {
  /* Order is the difference between killing a supervisor that immediately
     respawns its child and killing the child first. */
  const order = processTreeTerminationOrder(10, new Map([[11, 10], [12, 10], [13, 11]]));
  expect(order[order.length - 1]).toBe(10);
  expect(order.indexOf(13)).toBeLessThan(order.indexOf(11));
  expect(order.slice().sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
});

test("a leader with no children is its own whole tree", () => {
  expect(processTreeTerminationOrder(10, new Map())).toEqual([10]);
});

test("the walk reaches every descendant exactly once", () => {
  const signalled: number[] = [];
  const killed = terminateProcessTree(10, "SIGTERM", (pid) => signalled.push(pid), source([[11, 10], [12, 11]]));
  expect(killed).toBe(true);
  expect(signalled.sort((a, b) => a - b)).toEqual([10, 11, 12]);
});

test("a member whose identity changed under the walk is left alone", () => {
  /* Windows reissues a freed pid within seconds. Between reading the parent map
     and reaching a member, that member can have exited and its number can now
     name something unrelated — an editor, another agent's host. Only the
     kernel's creation-time token can tell, and it is re-read immediately before
     the kill. */
  let reads = 0;
  const recycled: ProcessTreeSource = {
    ppidMap: () => new Map([[11, 10], [12, 10]]),
    processIdentity: (pid) => {
      if (pid !== 11) return `${pid}:start`;
      reads += 1;
      return reads === 1 ? "11:start" : "11:someone-else";
    },
  };
  const signalled: number[] = [];
  terminateProcessTree(10, "SIGKILL", (pid) => signalled.push(pid), recycled);
  expect(signalled).not.toContain(11);
  expect(signalled.sort((a, b) => a - b)).toEqual([10, 12]);
});

test("a backend that cannot read identity still terminates the tree", () => {
  /* Null for both reads is "unknown", not "changed": the walk degrades to the
     unconditional kill `kill(-pgid)` already performs on Linux. */
  const signalled: number[] = [];
  terminateProcessTree(10, "SIGTERM", (pid) => signalled.push(pid), source([[11, 10]], { 10: null, 11: null }));
  expect(signalled.sort((a, b) => a - b)).toEqual([10, 11]);
});

test("a member that refuses the signal does not abandon the rest of the tree", () => {
  const signalled: number[] = [];
  const killed = terminateProcessTree(10, "SIGTERM", (pid) => {
    if (pid === 12) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    signalled.push(pid);
  }, source([[11, 10], [12, 10]]));
  expect(killed).toBe(true);
  expect(signalled.sort((a, b) => a - b)).toEqual([10, 11]);
});

test("a leader that was itself recycled is reported as not signalled", () => {
  let reads = 0;
  const recycled: ProcessTreeSource = {
    ppidMap: () => new Map(),
    processIdentity: () => {
      reads += 1;
      return reads === 1 ? "10:start" : "10:someone-else";
    },
  };
  const signalled: number[] = [];
  expect(terminateProcessTree(10, "SIGTERM", (pid) => signalled.push(pid), recycled)).toBe(false);
  expect(signalled).toEqual([]);
});

test("a backend that throws while reading the tree still signals the leader", () => {
  const exploding: ProcessTreeSource = {
    ppidMap: () => {
      throw new Error("snapshot unavailable");
    },
    processIdentity: () => null,
  };
  const signalled: number[] = [];
  expect(terminateProcessTree(10, "SIGKILL", (pid) => signalled.push(pid), exploding)).toBe(true);
  expect(signalled).toEqual([10]);
});

test("an unusable pid is never signalled on any platform", () => {
  const signalled: number[] = [];
  const record = (pid: number): void => {
    signalled.push(pid);
  };
  expect(signalProcessGroup(0, "SIGTERM", record)).toBe(false);
  expect(signalProcessGroup(undefined, "SIGTERM", record)).toBe(false);
  expect(signalProcessGroup(-4, "SIGTERM", record)).toBe(false);
  expect(signalled).toEqual([]);
});

test.if(process.platform !== "win32")("POSIX still signals the negative pid, once", () => {
  const signalled: number[] = [];
  expect(signalProcessGroup(4321, "SIGTERM", (pid) => signalled.push(pid))).toBe(true);
  expect(signalled).toEqual([-4321]);
});

test.if(process.platform === "win32")("win32 signals real pids, never a negative one", () => {
  /* `process.kill(-pid, …)` throws on Windows. Reaching that call at all would
     mean a host is never terminated, only reported as un-terminatable. */
  const signalled: number[] = [];
  signalProcessGroup(process.pid, "SIGTERM", (pid) => {
    signalled.push(pid);
  });
  expect(signalled).toContain(process.pid);
  expect(signalled.every((pid) => pid > 0)).toBe(true);
});

test.if(process.platform === "win32")("a real child and its grandchild are both gone after one call", async () => {
  /* The acceptance case: a structured host spawns an agent, the agent spawns
     its own helper, and stopping the host must not leave the helper running.
     On Linux one `kill(-pgid)` does that; here the walk has to find the
     grandchild through the parent map and reach it first. */
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tree-kill-"));
  const marker = path.join(sandbox, "grandchild.pid");
  const script = [
    "const grandchild = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'],",
    "  { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });",
    `Bun.write(${JSON.stringify(marker)}, String(grandchild.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });

  try {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(100);
    const grandchild = Number(fs.readFileSync(marker, "utf8").trim());
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    resetWindowsSnapshotForTests();

    expect(signalProcessGroup(child.pid, "SIGKILL")).toBe(true);

    const gone = async (pid: number): Promise<boolean> => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        if (!procBackend.pidAlive(pid)) return true;
        await Bun.sleep(150);
      }
      return !procBackend.pidAlive(pid);
    };
    expect(await gone(grandchild)).toBe(true);
    expect(await gone(child.pid)).toBe(true);
  } finally {
    try {
      child.kill();
    } catch {
      /* already terminated by the walk under test */
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 60_000);

test("a detached child falls back to its own handle when the group signal finds nothing", () => {
  let killedDirectly = false;
  const child = {
    pid: undefined,
    kill: () => {
      killedDirectly = true;
      return true;
    },
  };
  expect(signalDetachedProcessGroup(child, "SIGTERM", () => undefined)).toBe(true);
  expect(killedDirectly).toBe(true);
});
