import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry, ResourcesPayload } from "@/lib/types";

import { allowedKillTarget, applyResourceTargets, buildResourceSnapshot, canonicalResourceEntry, conflictingResourceHost, consumeKillTarget, createResourcesReader, lastResourceBuildDiagnostic, noteSessionTargets, parsePersistedResourceObservation, parseResourcesFixture, resetResourcesForTests, RESOURCE_OBSERVATION_MAX_BYTES, RESOURCE_WORKER_OUTPUT_MAX_BYTES } from "./resources";

const PATHNAME = "/home/user/.codex/sessions/2026/07/10/rollout-2026-07-10-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
const EMPTY_WORKER_MESSAGE = JSON.stringify({
  type: "observation",
  payload: { system: null, sessions: [] },
  diagnostic: {
    fresh: false,
    status: "complete",
    durationMs: 0,
    phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
  },
  targets: [],
});
const EMPTY_FRESH_WORKER_MESSAGE = EMPTY_WORKER_MESSAGE.replace('"fresh":false', '"fresh":true');
const FAILED_FRESH_WORKER_MESSAGE = EMPTY_FRESH_WORKER_MESSAGE.replace('"status":"complete"', '"status":"failed"');
const UNBOUND_TARGET_WORKER_MESSAGE = JSON.stringify({
  ...JSON.parse(EMPTY_FRESH_WORKER_MESSAGE),
  targets: [{ target: "agents:9.0", ref: ref(900, 999, "%9") }],
});
const OVERSIZED_WORKER_MESSAGE = JSON.stringify({
  type: "observation",
  payload: { system: null, sessions: [{
    target: "agents:1.0",
    panePid: 100,
    path: null,
    engine: "codex",
    hostConflict: false,
    title: "x".repeat(2_048),
    project: null,
    activity: null,
    lastActiveAt: null,
    cwd: "/repo",
    rssBytes: 1,
    swapBytes: 0,
    procCount: 1,
  }] },
  diagnostic: {
    fresh: true,
    status: "complete",
    durationMs: 0,
    phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
  },
  targets: [],
});

const entry: FileEntry = {
  path: PATHNAME,
  root: "codex-sessions",
  name: PATHNAME,
  project: "live-log-viewer-next",
  title: "Issue 31",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 200,
  model: "gpt-5.6-terra",
  pendingQuestion: null,
  waitingInput: null,
};

const duplicate: TranscriptHost = {
  tmuxServerPid: 900,
  paneId: "%2",
  panePid: 101,
  agentPid: 201,
  display: "agents:5.0",
  engine: "codex",
  cwd: "/repo",
  agentArgv: ["codex", "resume", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"],
  agentIdentity: "200:one",
  launchId: null,
  claimedPaths: [PATHNAME],
  primaryPath: PATHNAME,
};

const canonical: TranscriptHost = {
  ...duplicate,
  paneId: "%1",
  panePid: 100,
  agentPid: 200,
  display: "agents:4.0",
};

function ref(tmuxServerPid: number, panePid: number, paneId: string) {
  return {
    tmuxServerPid,
    tmuxServerStartIdentity: `${tmuxServerPid}:one`,
    panePid,
    paneStartIdentity: `${panePid}:one`,
    paneId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withResourceWorkerScript<T>(
  lines: string[] | ((directory: string) => string[]),
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-worker-"));
  const executable = path.join(directory, "fixture-worker");
  const body = typeof lines === "function" ? lines(directory) : lines;
  writeFileSync(executable, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(executable, 0o700);
  const previousExecutable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
  process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = executable;
  try {
    return await task(directory);
  } finally {
    if (previousExecutable === undefined) delete process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
    else process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = previousExecutable;
    rmSync(directory, { recursive: true, force: true });
  }
}

function workerTestReader(options: Parameters<typeof createResourcesReader>[4] = {}) {
  const payload: ResourcesPayload = { system: null, sessions: [] };
  const diagnostic = { fresh: true, status: "complete" as const, durationMs: 0, phases: {
    systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
  } };
  return createResourcesReader(async () => payload, () => null, Date.now, () => diagnostic, {
    readFiles: async () => [],
    initial: {
      generation: 1,
      startedAt: 1,
      completedAt: 2,
      collectorId: "durable",
      value: { payload, diagnostic, hostCount: 0, treeCount: 0, targets: [] },
    },
    ...options,
  });
}

describe("resource observation", () => {
  test("the collector child leaves shared state byte-identical", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-purity-"));
    const home = path.join(directory, "home");
    const state = path.join(directory, "state");
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });
    const staleRegistryTemp = path.join(state, "agent-registry.json.99999999.00000000-0000-4000-8000-000000000000.tmp");
    const scanSentinel = path.join(state, "files-scan-snapshot.json");
    writeFileSync(staleRegistryTemp, "stale-temp-sentinel\n");
    writeFileSync(scanSentinel, "scan-byte-sentinel\n");
    const before = readFileSync(scanSentinel);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, LLV_STATE_DIR: state, LLV_AGENT_REGISTRY_SQLITE: "off" };
    delete env.LLV_RESOURCE_COLLECTOR_IN_PROCESS;
    const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/resourceCollector.worker.ts")], {
      cwd: process.cwd(),
      env,
      stdin: new Blob(["{\"type\":\"collect\",\"fresh\":false,\"files\":[]}\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const exit = await Promise.race([
        child.exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ]);
      if (exit === "timeout") child.kill("SIGKILL");
      expect(exit).toBe(0);
      expect(existsSync(staleRegistryTemp)).toBeTrue();
      expect(readFileSync(scanSentinel)).toEqual(before);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("builds host ownership and metadata from one shared transcript generation", async () => {
    let scans = 0;
    let processTableReads = 0;
    let attachBatches = 0;
    let hostFresh: boolean | null = null;
    const files = [entry];
    const payload = await buildResourceSnapshot(true, {
      readFiles: async () => {
        scans += 1;
        return files;
      },
      readHosts: async (fresh, entries, ppids) => {
        hostFresh = fresh;
        expect(entries).toBe(files);
        expect(ppids).toEqual(new Map([[200, 100], [300, 200]]));
        return {
          hosts: [canonical],
          observation: "available",
          conflicts: [],
          canonicalFor: (pathname: string) => pathname === PATHNAME ? canonical : null,
        };
      },
      proc: {
        systemMemory: () => ({ ramTotal: 1_000, ramAvailable: 750, swapTotal: 100, swapUsed: 25 }),
        ppidMap: () => {
          processTableReads += 1;
          return new Map([[200, 100], [300, 200]]);
        },
        processMemory: () => new Map([
          [100, { rssBytes: 10, swapBytes: 1 }],
          [200, { rssBytes: 20, swapBytes: 2 }],
          [300, { rssBytes: 30, swapBytes: 3 }],
        ]),
      },
      captureAttachReferences: (refs) => {
        attachBatches += 1;
        expect(refs).toEqual([{ tmuxServerPid: 900, panePid: 100, paneId: "%1" }]);
        return new Map([["%1", ref(900, 100, "%1")]]);
      },
    });

    expect(scans).toBe(1);
    expect(processTableReads).toBe(1);
    expect(attachBatches).toBe(1);
    expect(hostFresh).toBeTrue();
    expect(payload.sessions).toEqual([{
      target: "agents:4.0",
      panePid: 100,
      path: PATHNAME,
      engine: "codex",
      hostConflict: false,
      title: "Issue 31",
      project: "live-log-viewer-next",
      activity: "live",
      lastActiveAt: "1970-01-01T00:00:01.000Z",
      cwd: "/repo",
      rssBytes: 60,
      swapBytes: 6,
      procCount: 3,
    }]);
    expect(allowedKillTarget("agents:4.0")).toEqual(ref(900, 100, "%1"));
    expect(lastResourceBuildDiagnostic()).toEqual(expect.objectContaining({
      fresh: true,
      status: "complete",
      phases: expect.objectContaining({
        readFiles: expect.any(Number),
        readHosts: expect.any(Number),
        ppidMap: expect.any(Number),
        processMemory: expect.any(Number),
        attach: expect.any(Number),
        serialization: expect.any(Number),
      }),
    }));
  });

  test("accepts a deterministic resource fixture", () => {
    const fixture = {
      system: {
        ramTotal: 34_359_738_368,
        ramAvailable: 21_474_836_480,
        swapTotal: 8_589_934_592,
        swapUsed: 1_073_741_824,
        capturedAt: "2100-01-02T12:00:00.000Z",
      },
      sessions: [],
    };

    expect(parseResourcesFixture(JSON.stringify(fixture))).toEqual(fixture);
    expect(() => parseResourcesFixture('{"system":{"ramTotal":-1},"sessions":[]}')).toThrow("invalid resources fixture");
  });

  test("durable and worker framing bounds align at the exact declared limit", () => {
    const session = {
      target: "agents:1.0",
      panePid: 100,
      path: null,
      engine: "codex" as const,
      hostConflict: false,
      title: "",
      project: null,
      activity: null,
      lastActiveAt: null,
      cwd: "/repo",
      rssBytes: 1,
      swapBytes: 0,
      procCount: 1,
    };
    const diagnostic = {
      fresh: false,
      status: "complete" as const,
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    };
    const observation = {
      generation: 1,
      startedAt: 1,
      completedAt: 2,
      collectorId: "worker:1",
      value: { payload: { system: null, sessions: [session] }, diagnostic, hostCount: 1, treeCount: 1, targets: [] },
    };
    const base = JSON.stringify({ version: 1, observation }) + "\n";
    session.title = "x".repeat(RESOURCE_OBSERVATION_MAX_BYTES - Buffer.byteLength(base));
    const boundary = JSON.stringify({ version: 1, observation }) + "\n";
    const workerFrame = JSON.stringify({ type: "observation", payload: observation.value.payload, diagnostic, targets: [] }) + "\n";

    expect(Buffer.byteLength(boundary)).toBe(RESOURCE_OBSERVATION_MAX_BYTES);
    expect(parsePersistedResourceObservation(boundary)).toMatchObject({ generation: 1 });
    expect(Buffer.byteLength(workerFrame) <= RESOURCE_WORKER_OUTPUT_MAX_BYTES).toBeTrue();

    session.title += "x";
    const overLimit = JSON.stringify({ version: 1, observation }) + "\n";
    expect(Buffer.byteLength(overLimit)).toBe(RESOURCE_OBSERVATION_MAX_BYTES + 1);
    expect(parsePersistedResourceObservation(overLimit)).toBeNull();
  });

  test("attributes a duplicated transcript only to the shared canonical host", () => {
    const snapshot = { hosts: [duplicate, canonical], observation: "available" as const, canonicalFor: (pathname: string) => (pathname === PATHNAME ? canonical : null) };

    expect(canonicalResourceEntry(snapshot, [duplicate], new Map([[PATHNAME, entry]]))).toBeNull();
    expect(canonicalResourceEntry(snapshot, [canonical], new Map([[PATHNAME, entry]]))).toEqual(entry);
  });

  test("marks every pane in a stable-conversation host conflict", () => {
    const snapshot = {
      hosts: [duplicate, canonical],
      observation: "available" as const,
      conflicts: [{ conversationId: "conversation_test", paths: [PATHNAME], paneIds: ["%1", "%2"] }],
      canonicalFor: () => null,
    };

    expect(conflictingResourceHost(snapshot, duplicate)).toBeTrue();
    expect(conflictingResourceHost(snapshot, canonical)).toBeTrue();
  });
});

describe("kill-target allowlist", () => {
  test("nothing is killable before a snapshot exists", () => {
    noteSessionTargets([]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("")).toBeNull();
  });

  test("only targets from the last snapshot pass, each with its pane id and pid", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    expect(allowedKillTarget("agents:1.0")).toEqual(ref(900, 111, "%11"));
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
    expect(allowedKillTarget("agents:3.0")).toBeNull();
    expect(allowedKillTarget("main:0.0")).toBeNull();
  });

  test("a new snapshot fully replaces the allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    noteSessionTargets([{ target: "agents:2.0", ref: ref(900, 222, "%22") }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });

  test("a consumed target no longer passes — tmux may reuse its coordinates", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    consumeKillTarget("agents:1.0");
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });

  test("an older observation cannot re-arm a concurrently consumed target", () => {
    applyResourceTargets(2, [{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    consumeKillTarget("agents:1.0");
    applyResourceTargets(1, [{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
  });

  test("a reset drops the global reader, diagnostics, and allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    resetResourcesForTests();
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(lastResourceBuildDiagnostic()).toBeNull();
  });
});

describe("resource recurring reads", () => {
  test("an incomplete observation message settles promptly with a degraded response", async () => {
    await withResourceWorkerScript([
      "trap 'exit 0' TERM INT",
      "printf '{\"type\":\"observation\"}\\n'",
      "while :; do sleep 0.01; done",
    ], async () => {
      const reader = workerTestReader();
      const outcome = await Promise.race([
        reader.read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({
        payload: { system: null, sessions: [] },
        diagnostic: { degradedReason: "collector-crash" },
      });
    });
  });

  test("an observation with invalid nested types settles promptly with a degraded response", async () => {
    await withResourceWorkerScript([
      "trap 'exit 0' TERM INT",
      "printf '{\"type\":\"observation\",\"payload\":{\"system\":null,\"sessions\":\"invalid\"},\"diagnostic\":{},\"targets\":[]}\\n'",
      "while :; do sleep 0.01; done",
    ], async () => {
      const reader = workerTestReader();
      const outcome = await Promise.race([
        reader.read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
    });
  });

  test("semantically invalid observations cannot publish kill targets or failed builds", async () => {
    for (const message of [UNBOUND_TARGET_WORKER_MESSAGE, FAILED_FRESH_WORKER_MESSAGE]) {
      await withResourceWorkerScript([
        `printf '%s\\n' '${message}'`,
      ], async () => {
        const outcome = await workerTestReader().read(true);
        expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
      });
    }
  });

  test("a fresh request rejects an observation labeled as ordinary", async () => {
    await withResourceWorkerScript([
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async () => {
      const outcome = await workerTestReader().read(true);
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
    });
  });

  test("truncated, oversized, crash, timeout, close, and spawn errors settle and release workers", async () => {
    const cases: Array<{ name: string; lines: (directory: string) => string[]; limits?: { timeoutMs?: number; closeTimeoutMs?: number; outputMaxBytes?: number } }> = [
      {
        name: "truncated",
        lines: (directory) => [
          `printf '%s' \"$$\" > \"${path.join(directory, "pid")}\"`,
          "trap 'exit 0' TERM INT",
          "printf '{\"type\":\"observation\"\\n'",
          "while :; do :; done",
        ],
      },
      {
        name: "oversized",
        lines: (directory) => [
          `printf '%s' \"$$\" > \"${path.join(directory, "pid")}\"`,
          "trap 'exit 0' TERM INT",
          `printf '%s\\n' '${OVERSIZED_WORKER_MESSAGE}'`,
          "while :; do :; done",
        ],
        limits: { outputMaxBytes: 1_024 },
      },
      {
        name: "crash",
        lines: (directory) => [`printf '%s' \"$$\" > \"${path.join(directory, "pid")}\"`, "exit 7"],
      },
      {
        name: "timeout",
        lines: (directory) => [
          `printf '%s' \"$$\" > \"${path.join(directory, "pid")}\"`,
          "trap 'exit 0' TERM INT",
          "while :; do :; done",
        ],
        limits: { timeoutMs: 20, closeTimeoutMs: 20 },
      },
      {
        name: "close",
        lines: (directory) => [`printf '%s' \"$$\" > \"${path.join(directory, "pid")}\"`, "exit 0"],
      },
    ];

    for (const fixture of cases) {
      await withResourceWorkerScript(fixture.lines, async (directory) => {
        const outcome = await Promise.race([
          workerTestReader({ workerLimits: fixture.limits }).read(true),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
        ]);
        expect(outcome === "hung", fixture.name).toBeFalse();
        expect(outcome, fixture.name).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
        const pid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        expect(alive, fixture.name).toBeFalse();
      });
    }

    const previousExecutable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
    process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = path.join(os.tmpdir(), "missing-resource-worker-executable");
    try {
      const outcome = await Promise.race([
        workerTestReader().read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
    } finally {
      if (previousExecutable === undefined) delete process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
      else process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = previousExecutable;
    }
  });

  test("persists each completed generation once across ordinary reads", async () => {
    let now = 0;
    let builds = 0;
    const persisted: number[] = [];
    const reader = createResourcesReader(async () => {
      builds += 1;
      return { system: null, sessions: [] };
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true, persist: (observation) => {
      persisted.push(observation.generation);
      return true;
    } });

    await reader.read();
    await reader.read();
    await reader.read();
    await reader.read();
    expect(persisted).toEqual([1]);

    now = 10_000;
    await reader.read();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await reader.read(true);
    expect(persisted).toEqual([1, 3]);
    expect(builds).toBe(3);
  });

  test("a failed durable write retries on a later read of the same generation", async () => {
    let attempts = 0;
    const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => ({
      fresh: true,
      status: "complete",
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    }), {
      inProcess: true,
      persist: () => {
        attempts += 1;
        return attempts > 1;
      },
    });

    await reader.read();
    expect(attempts).toBe(1);
    await reader.read();
    expect(attempts).toBe(2);
  });

  test("an initial durable observation seeds the persistence guard", async () => {
    let attempts = 0;
    const reader = workerTestReader({
      inProcess: true,
      persist: () => {
        attempts += 1;
        return true;
      },
    });

    await reader.read();
    expect(attempts).toBe(0);
  });

  test("twelve concurrent cold ordinary polls share one collection", async () => {
    const collection = deferred<ResourcesPayload>();
    let builds = 0;
    const reader = createResourcesReader(async () => {
      builds += 1;
      return collection.promise;
    }, () => null, Date.now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    const polls = Array.from({ length: 12 }, () => reader.read());
    await Promise.resolve();
    expect(builds).toBe(1);
    collection.resolve({ system: null, sessions: [] });
    await Promise.all(polls);
    expect(builds).toBe(1);
  });

  test("twelve concurrent off-process polls share one worker and one Viewer-main file handoff", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const fileFreshness: boolean[] = [];
      const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => null, {
        readFiles: async (fresh) => {
          fileFreshness.push(fresh);
          return [];
        },
      });

      const reads = await Promise.all(Array.from({ length: 12 }, () => reader.read()));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
      expect(fileFreshness).toEqual([false]);
      expect(reads.every((read) => read.diagnostic.degradedReason === undefined)).toBeTrue();
    });
  });

  test("duplicate bundled resource modules share one versioned reader", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const previousHome = process.env.HOME;
      const previousState = process.env.LLV_STATE_DIR;
      const home = path.join(directory, "home");
      const state = path.join(directory, "state");
      mkdirSync(home, { recursive: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(path.join(state, "files-scan-snapshot.json"), JSON.stringify({
        version: 1,
        snapshot: { complete: true, files: [], projectCatalog: [] },
      }));
      process.env.HOME = home;
      process.env.LLV_STATE_DIR = state;
      const scanCache = await import("./scanner/scanCache");
      let first: typeof import("./resources") | undefined;
      try {
        scanCache.resetFilesRouteCacheForTests();
        const modulePath = path.join(import.meta.dir, "resources.ts");
        first = await import(`${modulePath}?reader-copy=first-${Date.now()}`) as typeof import("./resources");
        const second = await import(`${modulePath}?reader-copy=second-${Date.now()}`) as typeof import("./resources");
        first.resetResourcesForTests();
        const [left, right] = await Promise.all([
          first.readResourcesWithDiagnostic(),
          second.readResourcesWithDiagnostic(),
        ]);

        expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
        expect(left.diagnostic.collectorId).toBe(right.diagnostic.collectorId);
        expect(left.diagnostic.generation).toBe(right.diagnostic.generation);
      } finally {
        first?.resetResourcesForTests();
        scanCache.resetFilesRouteCacheForTests();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousState === undefined) delete process.env.LLV_STATE_DIR;
        else process.env.LLV_STATE_DIR = previousState;
      }
    });
  });

  test("a missing ordinary Viewer-main file handoff degrades within its bound without spawning a worker", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const missing = deferred<never>();
      const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => null, {
        readFiles: async () => missing.promise,
        workerLimits: { inputTimeoutMs: 20 },
      });
      const outcome = await Promise.race([
        reader.read(),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-busy" } });
      expect(existsSync(path.join(directory, "workers"))).toBeFalse();
    });
  });

  test("overlapping fresh polls share one post-fence collection", async () => {
    const collection = deferred<ResourcesPayload>();
    let builds = 0;
    const reader = createResourcesReader(async () => {
      builds += 1;
      return collection.promise;
    }, () => null, Date.now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    const polls = Array.from({ length: 12 }, () => reader.read(true));
    await Promise.resolve();
    expect(builds).toBe(1);
    collection.resolve({ system: null, sessions: [] });
    await Promise.all(polls);
    expect(builds).toBe(1);
  });

  test("overlapping fresh off-process polls share one worker and preserve the fresh handoff", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const fileFreshness: boolean[] = [];
      const reader = workerTestReader({
        readFiles: async (fresh) => {
          fileFreshness.push(fresh);
          return [];
        },
      });

      await Promise.all(Array.from({ length: 12 }, () => reader.read(true)));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
      expect(fileFreshness).toEqual([true]);
    });
  });

  test("expired ordinary reads return the cached snapshot while one rebuild runs, and fresh waits for a newer build", async () => {
    let now = 0;
    let builds = 0;
    const fresh = deferred<ResourcesPayload>();
    const cached: ResourcesPayload = { system: null, sessions: [] };
    const freshResult: ResourcesPayload = { system: null, sessions: [{ target: "agents:3.0", panePid: 3, path: null, engine: "codex", hostConflict: false, title: null, project: null, activity: null, lastActiveAt: null, cwd: "/repo", rssBytes: 3, swapBytes: 0, procCount: 1 }] };
    const reader = createResourcesReader(async () => {
      builds += 1;
      if (builds === 1) return cached;
      return fresh.promise;
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    expect((await reader.read()).payload).toEqual(cached);
    now = 10_000;
    expect((await reader.read()).payload).toEqual(cached);
    await Promise.resolve();
    expect(builds).toBe(2);
    expect((await reader.read()).payload).toEqual(cached);
    expect(builds).toBe(2);

    const forced = reader.read(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fresh.resolve(freshResult);
    expect((await forced).payload).toEqual(freshResult);
    expect(builds).toBe(3);
  });

  test("a failed ordinary rebuild leaves the cached snapshot available and later polls retry", async () => {
    let now = 0;
    let builds = 0;
    const recovered = deferred<ResourcesPayload>();
    const cached: ResourcesPayload = { system: null, sessions: [] };
    const reader = createResourcesReader(async () => {
      builds += 1;
      if (builds === 1) return cached;
      if (builds === 2) throw new Error("transient resource build failure");
      return recovered.promise;
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    await reader.read();
    now = 10_000;
    expect((await reader.read()).payload).toEqual(cached);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
    expect(builds).toBe(2);
    expect((await reader.read()).payload).toEqual(cached);
    await Promise.resolve();
    expect(builds).toBe(3);
    recovered.resolve(cached);
    await Promise.resolve();
  });
});
