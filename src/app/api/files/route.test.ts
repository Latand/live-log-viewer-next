import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { agentRegistry, AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { writeSessionTitle } from "@/lib/session/titleStore";
import type { FileEntry } from "@/lib/types";
import { createFilesClientCache } from "@/hooks/useFiles";

let scans = 0;
let scanOptions: unknown;
let scanProjects: Array<string | undefined> = [];
let scannedFiles: FileEntry[] = [];
let scanFileResults: FileEntry[][] = [];
let scanPinOverlayResults: Array<string[] | undefined> = [];
let scanCompleteResults: Array<boolean | undefined> = [];
let scanGates: Promise<void>[] = [];
let hydrateScannedFiles: (files: FileEntry[], options: unknown) => FileEntry[] = (files) => files;
let registryRoot = "";
let tmuxHealth: unknown = { status: "healthy" };
let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-route-"));
  // Sandbox the title store so the integration test's writeSessionTitle never
  // touches the real ~/.config/agent-log-viewer state.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-route-state-"));
  process.env.LLV_STATE_DIR = stateDir;
  setAgentRegistryForTests(new AgentRegistry(path.join(registryRoot, "registry.json")));
  resetFilesRouteCacheForTests();
  scans = 0;
  scanProjects = [];
  scannedFiles = [];
  scanFileResults = [];
  scanPinOverlayResults = [];
  scanCompleteResults = [];
  scanGates = [];
  hydrateScannedFiles = (files) => files;
  tmuxHealth = { status: "healthy" };
  replaceConversationCatalog([]);
});

afterEach(() => {
  setAgentRegistryForTests(null);
  replaceConversationCatalog([]);
  noteSessionTargets([]);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/* `mock.module` is process-global and outlives this file. Capture the real
   namespaces first and restore them in afterAll so the stubs stay local. */
const MOCKED_MODULES = [
  "@/lib/scanner",
  "@/lib/flows/store",
  "@/lib/pipelines/store",
  "@/lib/pipelines/visibility",
  "@/lib/tasks/store",
  "@/lib/workflows/store",
  "@/lib/workflows/visibility",
  "@/lib/tmux",
] as const;
const realModules = new Map<string, unknown>(
  await Promise.all(MOCKED_MODULES.map(async (name) => [name, { ...(await import(name)) }] as const)),
);

mock.module("@/lib/scanner", () => ({
  listFiles: async () => [],
  listFilesWithProjectCatalog: async (project: string | undefined, options: unknown) => {
    scans += 1;
    scanProjects.push(project);
    scanOptions = options;
    const files = hydrateScannedFiles(scanFileResults.shift() ?? scannedFiles, options);
    const resourceSnapshot = { files, projectCatalog: [], complete: true };
    (options as { onResourceSnapshot?: (snapshot: typeof resourceSnapshot) => void }).onResourceSnapshot?.(resourceSnapshot);
    await scanGates.shift();
    const pinOverlayPaths = scanPinOverlayResults.shift();
    const complete = scanCompleteResults.shift();
    return { files, projectCatalog: [], ...(pinOverlayPaths ? { pinOverlayPaths } : {}), complete: complete ?? true };
  },
}));
let pipelinesStore: () => unknown[] = () => [];
mock.module("@/lib/flows/store", () => ({ loadFlows: () => [] }));
mock.module("@/lib/pipelines/store", () => ({ loadPipelines: () => pipelinesStore() }));
mock.module("@/lib/pipelines/visibility", () => ({ filterPipelinesForFileScan: () => [] }));
mock.module("@/lib/tasks/store", () => ({
  loadTasks: () => [],
  mutateTasks: () => { throw new Error("files route attempted a task mutation"); },
}));
mock.module("@/lib/workflows/store", () => ({ loadWorkflows: () => [] }));
mock.module("@/lib/workflows/visibility", () => ({ filterWorkflowsForFileScan: () => [] }));
mock.module("@/lib/tmux", () => ({
  ...(realModules.get("@/lib/tmux") as Record<string, unknown>),
  tmuxEndpointHealth: () => tmuxHealth,
}));

afterAll(() => {
  for (const [name, real] of realModules) mock.module(name, () => real as Record<string, unknown>);
});

const { cachedFileScan, currentFileScan, resetFilesRouteCacheForTests } = await import("@/lib/scanner/scanCache");
const { allowedKillTarget, buildResourceSnapshot, lastResourceTargetRefs, noteSessionTargets, readResourceFileSnapshot } = await import("@/lib/resources");
const { GET } = await import("./route");

test("repeated files reads reuse the pure read snapshot and retain ETag behavior", async () => {
  scannedFiles = [];
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  const second = await GET(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ files: [], projectCatalog: [], flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" } }, conversationAliases: {} });
  expect(second.status).toBe(304);
  expect(scans).toBe(1);
  expect(scanOptions).toEqual(expect.objectContaining({
    persist: false,
    persistIndex: true,
    onResourceSnapshot: expect.any(Function),
  }));
  expect(first.headers.get("x-llv-files-cache")).toBe("miss");
  expect(second.headers.get("x-llv-files-cache")).toBe("hit");
  expect(first.headers.get("x-llv-files-cache-requests")).toBe("1");
  expect(second.headers.get("x-llv-files-cache-requests")).toBe("2");
  expect(first.headers.get("server-timing")).toMatch(/files-clone;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-scan;dur=\d+(?:\.\d+)?;desc="cold generation 1"/);
});

test("files API surfaces degraded tmux endpoint health", async () => {
  tmuxHealth = {
    status: "degraded",
    code: "migration-marker-endpoint-mismatch",
    configuredTmpdir: "/tmp",
    expectedTmpdir: "/run/user/1000/agent-log-viewer",
    message: "stale migration marker",
  };
  try {
    const response = await GET(new Request("http://127.0.0.1/api/files"));
    expect(response.status).toBe(200);
    expect((await response.json()).systemHealth.tmux).toEqual(tmuxHealth);
  } finally {
    tmuxHealth = { status: "healthy" };
  }
});

test("concurrent cold files reads share one scan", async () => {
  const [first, second] = await Promise.all([
    GET(new Request("http://127.0.0.1/api/files")),
    GET(new Request("http://127.0.0.1/api/files")),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(scans).toBe(1);
});

test("a restart serves the persisted completed snapshot while revalidating", async () => {
  const persistedSnapshot = {
    files: [file("/sessions/persisted.jsonl")],
    projectCatalog: [],
    complete: true,
  };
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    snapshot: persistedSnapshot,
  }));
  resetFilesRouteCacheForTests();
  scannedFiles = [file("/sessions/refreshed.jsonl")];

  const restarted = await cachedFileScan();

  expect(restarted.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/persisted.jsonl"]);
  expect(scans).toBe(0);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(1);
  const next = await cachedFileScan();
  expect(next.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/refreshed.jsonl"]);
});

test("a current scan joins restart revalidation before publishing transcript metadata", async () => {
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    snapshot: {
      files: [file("/sessions/persisted-resource.jsonl")],
      projectCatalog: [],
      complete: true,
    },
  }));
  resetFilesRouteCacheForTests();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [file("/sessions/current-resource.jsonl")];

  const stale = await cachedFileScan();
  expect(stale.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/persisted-resource.jsonl"]);

  let settled = false;
  const current = currentFileScan().then((scan) => {
    settled = true;
    return scan;
  });

  expect(scans).toBe(0);
  expect(settled).toBeFalse();

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(1);
  release();
  expect((await current).snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/current-resource.jsonl"]);
  expect(scans).toBe(1);
});

test("an ordinary resource snapshot reuses the completed scanner generation", async () => {
  const before = file("/sessions/completed-resource.jsonl");
  const after = file("/sessions/gated-resource-refresh.jsonl");
  scannedFiles = [before];
  await cachedFileScan();
  const cacheStore = globalThis as typeof globalThis & {
    __llvFilesRouteScans?: Map<string, { refreshedAt: number }>;
  };
  cacheStore.__llvFilesRouteScans!.get("")!.refreshedAt = 0;

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [after];
  let settled = false;
  const resourceFiles = readResourceFileSnapshot(false).then((files) => {
    settled = true;
    return files;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const scansBeforeRelease = scans;
  const settledBeforeRelease = settled;
  release();
  const files = await resourceFiles;

  expect(scansBeforeRelease).toBe(2);
  expect(settledBeforeRelease).toBeTrue();
  expect(files.map((entry) => entry.path)).toEqual([before.path]);
});

test("a fresh resource handoff publishes the exact scan scope before full file enrichment settles", async () => {
  const before = file("/sessions/resource-stage-before.jsonl");
  const after = file("/sessions/resource-stage-after.jsonl");
  scannedFiles = [before];
  await cachedFileScan();

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [after];
  let settled = false;
  const handoff = readResourceFileSnapshot(true).then((files) => {
    settled = true;
    return files;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeFullScan = settled;
  release();
  const files = await handoff;

  expect(settledBeforeFullScan).toBeTrue();
  expect(files.map((entry) => entry.path)).toEqual([after.path]);
  expect(scans).toBe(2);
});

test("a fresh resource handoff replaces deferred ordinary work without a duplicate scan", async () => {
  const now = Date.now();
  const before = file("/sessions/resource-promote-before.jsonl");
  const after = file("/sessions/resource-promote-after.jsonl");
  const freshFlags: boolean[] = [];
  hydrateScannedFiles = (files, options) => {
    freshFlags.push((options as { fresh?: boolean }).fresh === true);
    return files;
  };
  scannedFiles = [before];
  await cachedFileScan(undefined, undefined, now);

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [after];
  await cachedFileScan(undefined, undefined, now + 10_100);
  let settled = false;
  const handoff = readResourceFileSnapshot(true).then((files) => {
    settled = true;
    return files;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeFullScan = settled;
  const scansBeforeFullScan = scans;
  release();
  const files = await handoff;

  expect(settledBeforeFullScan).toBeTrue();
  expect(scansBeforeFullScan).toBe(2);
  expect(files.map((entry) => entry.path)).toEqual([after.path]);
  expect(freshFlags).toEqual([false, true]);
  expect(scans).toBe(2);
});

test("a fresh resource handoff joins an ordinary generation that already started", async () => {
  const now = Date.now();
  const before = file("/sessions/resource-running-before.jsonl");
  const after = file("/sessions/resource-running-after.jsonl");
  scannedFiles = [before];
  await cachedFileScan(undefined, undefined, now);

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [after];
  await cachedFileScan(undefined, undefined, now + 10_100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);

  let settled = false;
  const handoff = readResourceFileSnapshot(true).then((files) => {
    settled = true;
    return files;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeFullScan = settled;
  const scansBeforeFullScan = scans;
  release();
  const files = await handoff;

  expect(settledBeforeFullScan).toBeTrue();
  expect(scansBeforeFullScan).toBe(2);
  expect(files.map((entry) => entry.path)).toEqual([after.path]);
  expect(scans).toBe(2);
});

test("concurrent fresh callers share one pending generation through failure and retry", async () => {
  const now = Date.now();
  const before = file("/sessions/shared-fresh-before.jsonl");
  const after = file("/sessions/shared-fresh-after.jsonl");
  const freshFlags: boolean[] = [];
  hydrateScannedFiles = (files, options) => {
    freshFlags.push((options as { fresh?: boolean }).fresh === true);
    return files;
  };
  scannedFiles = [before];

  await cachedFileScan(undefined, undefined, now);
  let releaseOld!: () => void;
  let releaseFresh!: () => void;
  scanGates.push(
    new Promise<void>((resolve) => { releaseOld = resolve; }),
    new Promise<void>((resolve) => { releaseFresh = resolve; }),
  );
  await cachedFileScan(undefined, undefined, now + 10_100);
  scannedFiles = [after];

  let firstSettled = false;
  let secondSettled = false;
  const first = currentFileScan({ fresh: true }).then((scan) => {
    firstSettled = true;
    return scan;
  });
  const second = currentFileScan({ fresh: true }).then((scan) => {
    secondSettled = true;
    return scan;
  });

  releaseOld();
  for (let attempt = 0; attempt < 100 && scans < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(scans).toBe(3);
  expect(firstSettled).toBeFalse();
  expect(secondSettled).toBeFalse();

  releaseFresh();
  const [firstFresh, secondFresh] = await Promise.all([first, second]);
  expect(firstFresh.snapshot.files.map((entry) => entry.path)).toEqual([after.path]);
  expect(secondFresh.snapshot.files.map((entry) => entry.path)).toEqual([after.path]);
  expect(freshFlags).toEqual([false, false, true]);
  expect(scans).toBe(3);

  scanCompleteResults = [false];
  await expect(currentFileScan({ fresh: true })).rejects.toThrow("filesystem scan incomplete");
  const scansAfterFailure = scans;
  expect(freshFlags.at(-1)).toBeTrue();

  let releaseRetry!: () => void;
  scanGates.push(new Promise<void>((resolve) => { releaseRetry = resolve; }));
  let firstRetrySettled = false;
  let secondRetrySettled = false;
  const firstRetry = currentFileScan({ fresh: true }).then((scan) => {
    firstRetrySettled = true;
    return scan;
  });
  const secondRetry = currentFileScan({ fresh: true }).then((scan) => {
    secondRetrySettled = true;
    return scan;
  });

  expect(scans).toBe(scansAfterFailure + 1);
  expect(firstRetrySettled).toBeFalse();
  expect(secondRetrySettled).toBeFalse();
  releaseRetry();
  const [firstRecovered, secondRecovered] = await Promise.all([firstRetry, secondRetry]);
  expect(firstRecovered.generation).toBe(secondRecovered.generation);
  expect(scans).toBe(scansAfterFailure + 1);
  expect(freshFlags).toEqual([false, false, true, true, true]);

  const scansAfterRecovery = scans;
  await currentFileScan();
  expect(scans).toBe(scansAfterRecovery);
});

test("a fresh resource snapshot fences a pre-kill refresh before host election", async () => {
  const now = Date.now();
  const before = { ...file("/sessions/resource-before.jsonl"), title: "Before kill", activity: "idle" as const };
  const after = { ...file("/sessions/resource-after.jsonl"), title: "After kill", activity: "recent" as const, mtime: 2 };
  scannedFiles = [before];

  const warm = await cachedFileScan(undefined, undefined, now);
  expect(warm.snapshot.files.map((entry) => entry.path)).toEqual([before.path]);
  let releasePreKillRefresh!: () => void;
  scanGates.push(new Promise<void>((resolve) => { releasePreKillRefresh = resolve; }));
  const revalidating = await cachedFileScan(undefined, undefined, now + 10_100);
  expect(revalidating.snapshot.files.map((entry) => entry.path)).toEqual([before.path]);
  expect(scans).toBe(1);

  scannedFiles = [after];

  let filesFresh: boolean | undefined;
  let hostEntries: Array<{ path: string }> = [];
  let resourceSettled = false;
  const resourceRef = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    panePid: 100,
    paneStartIdentity: "100:one",
    paneId: "%1",
  };
  const payloadPromise = buildResourceSnapshot(true, {
    readFiles: async (fresh) => {
      filesFresh = fresh;
      return readResourceFileSnapshot(fresh);
    },
    readHosts: async (_fresh, entries) => {
      hostEntries = entries;
      const selected = entries[0]!;
      const target = selected.path === after.path ? "agents:after" : "agents:before";
      const host = {
        tmuxServerPid: 900,
        paneId: "%1",
        panePid: 100,
        agentPid: 200,
        display: target,
        engine: "codex" as const,
        cwd: "/repo",
        agentArgv: ["codex", "resume", selected.path],
        agentIdentity: "200:one",
        launchId: null,
        claimedPaths: [selected.path],
        primaryPath: selected.path,
      };
      return {
        hosts: [host],
        observation: "available" as const,
        conflicts: [],
        canonicalFor: (pathname: string) => pathname === selected.path ? host : null,
      };
    },
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map([[200, 100]]),
      processMemory: () => new Map([[100, { rssBytes: 10, swapBytes: 0 }], [200, { rssBytes: 20, swapBytes: 0 }]]),
    },
    captureAttachReferences: () => new Map([[resourceRef.paneId, resourceRef]]),
  }).then((payload) => {
    resourceSettled = true;
    return payload;
  });

  expect(filesFresh).toBeTrue();
  expect(scans).toBe(2);
  const payload = await payloadPromise;
  expect(resourceSettled).toBeTrue();
  expect(scans).toBe(2);
  expect(hostEntries.map((entry) => entry.path)).toEqual([after.path]);
  expect(payload.sessions).toEqual([expect.objectContaining({
    target: "agents:after",
    path: after.path,
    title: "After kill",
    activity: "recent",
    lastActiveAt: "1970-01-01T00:00:02.000Z",
  })]);
  expect(lastResourceTargetRefs()).toEqual([{ target: "agents:after", ref: resourceRef }]);
  expect(allowedKillTarget("agents:after")).toBeNull();
  expect(allowedKillTarget("agents:before")).toBeNull();
  releasePreKillRefresh();
});

test("a fresh resource snapshot replaces stale process and pane observations before host reconciliation", async () => {
  const sessionId = "199e8e95-0e87-4b4f-84bf-f62b3c0993a3";
  const pathname = `/home/user/.claude/projects/-repo/${sessionId}.jsonl`;
  const transcript = {
    ...file(pathname),
    root: "claude-projects" as const,
    engine: "claude" as const,
    fmt: "claude" as const,
    title: "Plain Claude CLI",
    activity: "live" as const,
    mtime: 2,
  };
  const oldCli = { agentPid: 200, panePid: 100, paneId: "%1", target: "agents:old" };
  const newCli = { agentPid: 201, panePid: 101, paneId: "%2", target: "agents:new" };
  let processMemo = oldCli;
  let paneMemo = oldCli;
  const liveProcess = newCli;
  const livePane = newCli;
  scannedFiles = [transcript];
  hydrateScannedFiles = (files, options) => {
    if ((options as { fresh?: boolean }).fresh === true) {
      processMemo = liveProcess;
      paneMemo = livePane;
    }
    const owner = processMemo.agentPid === paneMemo.agentPid && processMemo.panePid === paneMemo.panePid
      ? processMemo
      : null;
    return files.map((entry) => ({
      ...entry,
      pid: owner?.agentPid ?? null,
      proc: owner ? "running" as const : null,
    }));
  };

  const registry = agentRegistry();
  const key = { engine: "claude" as const, sessionId };
  registry.upsert({
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  const resourceRef = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    panePid: newCli.panePid,
    paneStartIdentity: `${newCli.panePid}:one`,
    paneId: newCli.paneId,
  };
  const payload = await buildResourceSnapshot(true, {
    readFiles: async (fresh) => (await currentFileScan({ fresh })).snapshot.files,
    readHosts: async (fresh, entries) => {
      if (fresh) {
        processMemo = liveProcess;
        paneMemo = livePane;
      }
      const primaryPath = entries.find((entry) => entry.pid === processMemo.agentPid)?.path ?? null;
      const host = {
        tmuxServerPid: 900,
        paneId: paneMemo.paneId,
        panePid: paneMemo.panePid,
        agentPid: processMemo.agentPid,
        display: paneMemo.target,
        engine: "claude" as const,
        cwd: "/repo",
        agentArgv: ["claude"],
        agentIdentity: `${processMemo.agentPid}:one`,
        launchId: null,
        claimedPaths: primaryPath ? [primaryPath] : [],
        primaryPath,
      };
      if (primaryPath) {
        const current = registry.snapshot().entries[`claude:${sessionId}`]!;
        registry.upsert({ ...current, artifactPath: primaryPath, status: "live" });
      } else {
        registry.markUnhosted(key);
      }
      return {
        hosts: [host],
        observation: "available" as const,
        conflicts: [],
        canonicalFor: (candidate: string) => candidate === primaryPath ? host : null,
      };
    },
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map([[newCli.agentPid, newCli.panePid]]),
      processMemory: () => new Map([
        [newCli.panePid, { rssBytes: 10, swapBytes: 0 }],
        [newCli.agentPid, { rssBytes: 20, swapBytes: 0 }],
      ]),
    },
    captureAttachReferences: () => new Map([[resourceRef.paneId, resourceRef]]),
  });

  expect(scans).toBe(1);
  expect(payload.sessions).toEqual([expect.objectContaining({
    target: newCli.target,
    path: pathname,
    title: "Plain Claude CLI",
    activity: "live",
    lastActiveAt: "1970-01-01T00:00:02.000Z",
  })]);
  expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
    artifactPath: pathname,
    status: "live",
  });
});

test("a client automatically converges from a persisted restart snapshot to its completed generation", async () => {
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    snapshot: {
      files: [file("/sessions/persisted-client.jsonl")],
      projectCatalog: [],
      complete: true,
    },
  }));
  resetFilesRouteCacheForTests();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [file("/sessions/refreshed-client.jsonl")];
  const cache = createFilesClientCache((input, init) =>
    GET(new Request(`http://127.0.0.1${input}`, init)));
  const unsubscribe = cache.subscribe(() => {});

  const started = performance.now();
  const stale = await cache.revalidate();

  expect(performance.now() - started).toBeLessThan(300);
  expect(stale.files.map((entry) => entry.path)).toEqual(["/sessions/persisted-client.jsonl"]);
  expect(scans).toBe(0);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(1);
  release();
  for (let attempt = 0; attempt < 100 && cache.read().files[0]?.path !== "/sessions/refreshed-client.jsonl"; attempt += 1) {
    await Bun.sleep(10);
  }

  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/sessions/refreshed-client.jsonl"]);
  expect(scans).toBe(1);
  unsubscribe();
});

test("a restart hydrates a persisted 7700-row snapshot within two seconds", async () => {
  const files = Array.from({ length: 7_700 }, (_, index) => file(`/sessions/persisted-${index}.jsonl`));
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    snapshot: { files, projectCatalog: [], complete: true },
  }));
  resetFilesRouteCacheForTests();

  const started = performance.now();
  const restarted = await cachedFileScan();

  expect(performance.now() - started).toBeLessThan(2_000);
  expect(restarted.snapshot.files).toHaveLength(7_700);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("a corrupt completed snapshot falls back to a cold scan and repairs persistence", async () => {
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), "{ corrupt");
  resetFilesRouteCacheForTests();
  scannedFiles = [file("/sessions/cold-fallback.jsonl")];

  const recovered = await cachedFileScan();

  expect(recovered.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/cold-fallback.jsonl"]);
  expect(scans).toBe(1);
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "files-scan-snapshot.json"), "utf8"));
  expect(persisted.version).toBe(1);
});

test("repeated first-ever incomplete scans stay unpublished until recovery", async () => {
  scanFileResults = [
    [file("/sessions/first-partial.jsonl")],
    [file("/sessions/second-partial.jsonl")],
    [file("/sessions/recovered-cold.jsonl")],
  ];
  scanCompleteResults = [false, false, true];
  const snapshotPath = path.join(stateDir, "files-scan-snapshot.json");

  await expect(cachedFileScan()).rejects.toThrow("filesystem scan incomplete");
  expect(fs.existsSync(snapshotPath)).toBe(false);
  await expect(cachedFileScan()).rejects.toThrow("filesystem scan incomplete");
  expect(fs.existsSync(snapshotPath)).toBe(false);

  const recovered = await cachedFileScan();
  expect(recovered.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/recovered-cold.jsonl"]);
  expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).snapshot.files.map((entry: FileEntry) => entry.path))
    .toEqual(["/sessions/recovered-cold.jsonl"]);
});

test("snapshot persistence creates private state and replaces permissive files as 0600", async () => {
  const privateStateDir = path.join(stateDir, "private-snapshot-state");
  const snapshotPath = path.join(privateStateDir, "files-scan-snapshot.json");
  const originalRename = fs.renameSync;
  const previousUmask = process.umask(0);
  const temporaryModes: number[] = [];
  process.env.LLV_STATE_DIR = privateStateDir;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (target === snapshotPath) temporaryModes.push(fs.statSync(source).mode & 0o777);
    return originalRename(source, target);
  }) as typeof fs.renameSync;

  try {
    resetFilesRouteCacheForTests();
    scannedFiles = [file("/sessions/private-initial.jsonl")];
    await cachedFileScan();

    expect(fs.statSync(privateStateDir).mode & 0o777).toBe(0o700);
    expect(temporaryModes).toEqual([0o600]);
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);

    fs.chmodSync(snapshotPath, 0o666);
    scannedFiles = [file("/sessions/private-replacement.jsonl")];
    await cachedFileScan(undefined, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(temporaryModes).toEqual([0o600, 0o600]);
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).snapshot.files.map((entry: FileEntry) => entry.path))
      .toEqual(["/sessions/private-replacement.jsonl"]);
  } finally {
    fs.renameSync = originalRename;
    process.umask(previousUmask);
    process.env.LLV_STATE_DIR = stateDir;
    resetFilesRouteCacheForTests();
  }
});

test("snapshot publication failures preserve the canonical file, clean temps, stay non-fatal, and recover", async () => {
  const snapshotPath = path.join(stateDir, "files-scan-snapshot.json");
  const canonical = JSON.stringify({
    version: 1,
    snapshot: {
      files: [file("/sessions/canonical.jsonl")],
      projectCatalog: [],
      complete: true,
    },
  });
  fs.writeFileSync(snapshotPath, canonical);
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const originalError = console.error;
  const diagnostics: string[] = [];
  let failure: "write" | "rename" | null = null;
  fs.writeFileSync = ((filename: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    const result = originalWrite(filename, data, options);
    if (failure === "write" && String(filename).includes(".files-scan-snapshot.json.")) {
      throw new Error("injected snapshot write failure");
    }
    return result;
  }) as typeof fs.writeFileSync;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (failure === "rename" && target === snapshotPath) {
      throw new Error("injected snapshot rename failure");
    }
    return originalRename(source, target);
  }) as typeof fs.renameSync;
  console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
  const tempFiles = () => fs.readdirSync(stateDir)
    .filter((name) => name.startsWith(".files-scan-snapshot.json.") && name.endsWith(".tmp"));
  const attempt = async (mode: "write" | "rename", freshPath: string) => {
    failure = mode;
    resetFilesRouteCacheForTests();
    scannedFiles = [file(freshPath)];
    const response = await GET(new Request("http://127.0.0.1/api/files"));
    expect(response.status).toBe(200);
    expect((await response.json()).files.map((entry: FileEntry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  try {
    await attempt("write", "/sessions/write-failed.jsonl");
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(canonical);
    expect(tempFiles()).toEqual([]);

    await attempt("rename", "/sessions/rename-failed.jsonl");
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(canonical);
    expect(tempFiles()).toEqual([]);
    expect(diagnostics).toEqual([
      expect.stringContaining("write temporary snapshot failed"),
    ]);
    expect(diagnostics[0]).toContain("injected snapshot write failure");
    expect(diagnostics[0]).toContain(".files-scan-snapshot.json.");
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    console.error = originalError;
  }

  resetFilesRouteCacheForTests();
  scannedFiles = [file("/sessions/recovered.jsonl")];
  const recovery = await GET(new Request("http://127.0.0.1/api/files"));
  expect(recovery.status).toBe(200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).snapshot.files.map((entry: FileEntry) => entry.path))
    .toEqual(["/sessions/recovered.jsonl"]);
  expect(tempFiles()).toEqual([]);
});

test("an expired snapshot returns stale data while one shared refresh runs", async () => {
  scannedFiles = [file("/sessions/project-a.jsonl")];
  await cachedFileScan();
  scannedFiles = [file("/sessions/project-b.jsonl")];
  const refreshed = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER);

  expect(refreshed.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/project-a.jsonl"]);
  expect(scans).toBe(1);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);
  const next = await cachedFileScan();
  expect(next.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/project-b.jsonl"]);
});

test("ordinary reads defer one shared refresh to the bounded fallback cadence", async () => {
  const now = Date.now();
  const before = file("/sessions/ordinary-before.jsonl");
  const after = file("/sessions/ordinary-after.jsonl");
  scannedFiles = [before];
  await cachedFileScan(undefined, undefined, now);

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [after];
  const frequentReads = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    cachedFileScan(undefined, undefined, now + 1_000 + index * 375)));

  expect(frequentReads.every((scan) => scan.snapshot.files[0]?.path === before.path)).toBeTrue();
  expect(scans).toBe(1);

  const stale = await cachedFileScan(undefined, undefined, now + 10_100);
  expect(stale.snapshot.files.map((entry) => entry.path)).toEqual([before.path]);
  expect(stale.cacheStatus).toBe("stale");
  expect(scans).toBe(1);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);

  const completed = currentFileScan();
  release();
  expect((await completed).snapshot.files.map((entry) => entry.path)).toEqual([after.path]);

  const completedAt = Date.now();
  const nextFrequentReads = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    cachedFileScan(undefined, undefined, completedAt + index * 375)));
  expect(nextFrequentReads.every((scan) => scan.snapshot.files[0]?.path === after.path)).toBeTrue();
  expect(scans).toBe(2);
});

test("a failed ordinary refresh keeps retry traffic on the bounded cadence", async () => {
  const now = Date.now();
  scannedFiles = [file("/sessions/ordinary-retry.jsonl")];
  await cachedFileScan(undefined, undefined, now);

  scanCompleteResults = [false];
  await cachedFileScan(undefined, undefined, now + 10_100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);

  const retryTraffic = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    cachedFileScan(undefined, undefined, now + 11_000 + index * 375)));
  expect(retryTraffic.every((scan) => scan.snapshot.files[0]?.path === "/sessions/ordinary-retry.jsonl")).toBeTrue();
  expect(retryTraffic.every((scan) => scan.cacheStatus === "hit" && scan.targetGeneration === scan.generation)).toBeTrue();
  expect(scans).toBe(2);

  await cachedFileScan(undefined, undefined, now + 20_200);
  expect(scans).toBe(2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(3);
});

test("an incomplete filesystem scan retains the last completed route snapshot until recovery", async () => {
  const now = Date.now();
  scannedFiles = [file("/sessions/canonical.jsonl")];
  await cachedFileScan(undefined, undefined, now);
  scanFileResults = [[file("/sessions/partial.jsonl")]];
  scanCompleteResults = [false];

  const stale = await cachedFileScan(undefined, undefined, now + 10_100);
  expect(stale.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await cachedFileScan()).snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);

  scanFileResults = [[file("/sessions/recovered.jsonl")]];
  const recovered = await cachedFileScan(undefined, undefined, now + 20_200);
  expect(recovered.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await cachedFileScan()).snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/recovered.jsonl"]);
});

test("concurrent reads during a blocked refresh share one scan and return within 300ms", async () => {
  scannedFiles = [file("/sessions/complete.jsonl")];
  await cachedFileScan();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [file("/sessions/in-flight.jsonl")];

  const started = performance.now();
  const [first, second] = await Promise.all([
    cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER),
    cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER),
  ]);

  expect(performance.now() - started).toBeLessThan(300);
  expect(first.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/complete.jsonl"]);
  expect(second.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/complete.jsonl"]);
  expect(scans).toBe(1);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("a pinned refresh serves stale data then advances the shared global slot with its overlay", async () => {
  scannedFiles = [file("/sessions/old-global.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files"));

  const pinnedPath = "/archive/predecessor.jsonl";
  const currentPath = "/sessions/current.jsonl";
  const closurePath = "/sessions/closure-parent.jsonl";
  const freshGlobal = file("/sessions/fresh-global.jsonl");
  scanFileResults = [[freshGlobal, file(pinnedPath), file(currentPath), file(closurePath)]];
  scanPinOverlayResults = [[pinnedPath, currentPath, closurePath]];
  const stalePinned = await GET(new Request(`http://127.0.0.1/api/files?path=${encodeURIComponent(pinnedPath)}`));
  const staleBody = await stalePinned.json() as { files: FileEntry[]; pinOverlayPaths?: string[] };

  expect(staleBody.files.map((entry) => entry.path)).toEqual(["/sessions/old-global.jsonl"]);
  expect(staleBody.pinOverlayPaths).toBeUndefined();

  await new Promise<void>((resolve) => setImmediate(resolve));
  const pinned = await GET(new Request(`http://127.0.0.1/api/files?path=${encodeURIComponent(pinnedPath)}`));
  const pinnedBody = await pinned.json() as { files: FileEntry[]; pinOverlayPaths: string[] };

  expect(pinnedBody.files.map((entry) => entry.path)).toEqual([
    freshGlobal.path,
    pinnedPath,
    currentPath,
    closurePath,
  ]);
  expect(pinnedBody.pinOverlayPaths).toEqual([pinnedPath, currentPath, closurePath]);

  scannedFiles = [file("/sessions/stale-unshared.jsonl")];
  const ordinary = await GET(new Request("http://127.0.0.1/api/files"));
  const ordinaryBody = await ordinary.json() as { files: FileEntry[] };
  expect(ordinaryBody.files.map((entry) => entry.path)).toEqual([freshGlobal.path]);
  expect(scans).toBe(2);
});

test("pinned response projection cannot mutate the shared global scan rows", async () => {
  const sharedPath = "/sessions/shared-registry-row.jsonl";
  const pinnedPath = "/archive/pin-only-row.jsonl";
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", sharedPath, "source");
  scanFileResults = [[file(sharedPath), file(pinnedPath)]];
  scanPinOverlayResults = [[pinnedPath]];

  const pinned = await GET(new Request(`http://127.0.0.1/api/files?path=${encodeURIComponent(pinnedPath)}`));
  const pinnedBody = await pinned.json() as { files: FileEntry[] };
  expect(pinnedBody.files.find((entry) => entry.path === sharedPath)?.conversationId).toBe(conversation.id);

  setAgentRegistryForTests(new AgentRegistry(path.join(registryRoot, "empty-registry.json")));
  const ordinary = await GET(new Request("http://127.0.0.1/api/files"));
  const ordinaryBody = await ordinary.json() as { files: FileEntry[] };
  expect(ordinaryBody.files.find((entry) => entry.path === sharedPath)?.conversationId).toBeUndefined();
});

test("unique pinned snapshots use bounded LRU retention while recent pins stay warm", async () => {
  const global = file("/sessions/global.jsonl");
  scannedFiles = [global];
  await cachedFileScan();
  const now = Date.now();
  const pins = Array.from({ length: 9 }, (_, index) => `/archive/pin-${index}.jsonl`);

  for (const pinnedPath of pins) {
    scanFileResults = [[global, file(pinnedPath)]];
    scanPinOverlayResults = [[pinnedPath]];
    await cachedFileScan(undefined, pinnedPath, now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const hydrated = await cachedFileScan(undefined, pinnedPath, now);
    expect(hydrated.snapshot.files.some((entry) => entry.path === pinnedPath)).toBe(true);
  }

  expect(scans).toBe(10);
  await cachedFileScan(undefined, pins.at(-1), now);
  expect(scans).toBe(10);

  scanFileResults = [[global, file(pins[0]!)]];
  scanPinOverlayResults = [[pins[0]!]];
  const evicted = await cachedFileScan(undefined, pins[0], now);
  expect(evicted.snapshot.files.map((entry) => entry.path)).toEqual([global.path]);
  expect(scans).toBe(11);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("a files revision request returns stale data and schedules a refresh", async () => {
  scannedFiles = [file("/sessions/before-revision.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files"));

  scannedFiles = [file("/sessions/after-revision.jsonl")];
  const response = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "1" },
  }));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files.map((entry) => entry.path)).toEqual(["/sessions/before-revision.jsonl"]);
  expect(scans).toBe(2);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = await GET(new Request("http://127.0.0.1/api/files"));
  expect((await next.json()).files.map((entry: FileEntry) => entry.path)).toEqual(["/sessions/after-revision.jsonl"]);
});

test("a pinned client receives stale data immediately then converges on its completed revision generation", async () => {
  scannedFiles = [file("/sessions/before-revision.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files"));

  const pinnedPath = "/archive/pinned-revision.jsonl";
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scanFileResults = [[file("/sessions/after-revision.jsonl"), file(pinnedPath)]];
  scanPinOverlayResults = [[pinnedPath]];
  const cache = createFilesClientCache((input, init) =>
    GET(new Request(`http://127.0.0.1${input}`, init)));
  const updates: string[][] = [];
  const unsubscribe = cache.subscribe((data) => {
    updates.push(data.files.map((entry) => entry.path));
  }, pinnedPath);

  const started = performance.now();
  const stale = await cache.revalidate(pinnedPath, 17);

  expect(performance.now() - started).toBeLessThan(300);
  expect(stale.files.map((entry) => entry.path)).toEqual(["/sessions/before-revision.jsonl"]);
  expect(scans).toBe(2);

  release();
  for (let attempt = 0; attempt < 100 && !cache.read().files.some((entry) => entry.path === pinnedPath); attempt += 1) {
    await Bun.sleep(10);
  }

  expect(cache.read().files.map((entry) => entry.path)).toEqual([
    "/sessions/after-revision.jsonl",
    pinnedPath,
  ]);
  expect(updates.at(-1)).toEqual(["/sessions/after-revision.jsonl", pinnedPath]);
  expect(scans).toBe(2);
  unsubscribe();
});

test("a warm global-only incomplete response retains an out-of-cap pin until its target generation completes", async () => {
  const global = file("/sessions/global.jsonl");
  const pinnedPath = "/archive/warm-pinned.jsonl";
  scanFileResults = [[global, file(pinnedPath)]];
  scanPinOverlayResults = [[pinnedPath]];
  const cache = createFilesClientCache((input, init) => GET(new Request(`http://127.0.0.1${input}`, init)));
  const unsubscribe = cache.subscribe(() => {}, pinnedPath);
  await cache.revalidate(pinnedPath);
  expect(cache.read().files.some((entry) => entry.path === pinnedPath)).toBe(true);

  resetFilesRouteCacheForTests();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scanFileResults = [[file("/sessions/warm-global.jsonl")], [file("/sessions/completed-global.jsonl"), file(pinnedPath)]];
  scanPinOverlayResults = [undefined, [pinnedPath]];
  await cachedFileScan();
  const stale = await cache.revalidate(pinnedPath, 91);
  expect(stale.files.some((entry) => entry.path === pinnedPath)).toBe(true);

  release();
  for (let attempt = 0; attempt < 100 && cache.read().files[0]?.path !== "/sessions/completed-global.jsonl"; attempt += 1) {
    await Bun.sleep(10);
  }
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/sessions/completed-global.jsonl", pinnedPath]);
  unsubscribe();
});

test("concurrent requests for one files revision share one forced scan", async () => {
  await GET(new Request("http://127.0.0.1/api/files"));
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  const request = () => GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "41" },
  }));

  const first = request();
  await Promise.resolve();
  const second = request();
  release();
  await Promise.all([first, second]);

  expect(scans).toBe(2);
});

test("a completed client revision cannot suppress a later refresh with the same value", async () => {
  const request = () => GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "41" },
  }));

  await request();
  await request();

  expect(scans).toBe(2);
});

test("a newer revision waits for a follow-up scan when an older scan is in flight", async () => {
  let releaseOlder!: () => void;
  scanGates.push(new Promise<void>((resolve) => { releaseOlder = resolve; }));
  scannedFiles = [file("/sessions/revision-1.jsonl")];
  const older = cachedFileScan(undefined, undefined, Date.now(), 1);
  await Promise.resolve();
  expect(scans).toBe(1);

  scannedFiles = [file("/sessions/revision-2.jsonl")];
  const newer = cachedFileScan(undefined, undefined, Date.now(), 2);
  releaseOlder();
  await older;
  const result = await newer;

  expect(result.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/revision-2.jsonl"]);
  expect(scans).toBe(2);
});

test("a persisted legacy cache slot serves stale data during fresh hydration", async () => {
  const legacySnapshot = {
    files: [file("/sessions/sentinel-stale.jsonl")],
    projectCatalog: [],
    complete: true,
  };
  const cacheStore = globalThis as typeof globalThis & {
    __llvFilesRouteScans?: Map<string, unknown>;
  };
  cacheStore.__llvFilesRouteScans = new Map([["", {
    snapshot: legacySnapshot,
    refreshedAt: Date.now(),
    refresh: Promise.resolve(legacySnapshot),
  }]]);
  scannedFiles = [file("/sessions/upgraded-fresh.jsonl")];

  const result = await cachedFileScan(undefined, undefined, Date.now(), 1);

  expect(result.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/sentinel-stale.jsonl"]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(1);
  const next = await cachedFileScan();
  expect(next.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/upgraded-fresh.jsonl"]);
});

test("an arbitrary client revision cannot suppress a later background refresh", async () => {
  scannedFiles = [file("/sessions/untrusted-watermark.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": String(Number.MAX_SAFE_INTEGER) },
  }));

  scannedFiles = [file("/sessions/genuine-revision.jsonl")];
  const response = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "7" },
  }));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files.map((entry) => entry.path)).toEqual(["/sessions/untrusted-watermark.jsonl"]);
  expect(scans).toBe(2);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = await GET(new Request("http://127.0.0.1/api/files"));
  expect((await next.json()).files.map((entry: FileEntry) => entry.path)).toEqual(["/sessions/genuine-revision.jsonl"]);
});

test("a client generation above the issued watermark cannot advance the server counter", async () => {
  scannedFiles = [file("/sessions/issued-generation.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files"));

  const response = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-generation": String(Number.MAX_SAFE_INTEGER) },
  }));

  expect(response.headers.get("x-llv-files-generation")).toBe("1");
  expect(response.headers.get("x-llv-files-target-generation")).toBe("1");
  expect(scans).toBe(1);
});

test("project query changes reuse one global scan snapshot", async () => {
  await GET(new Request("http://127.0.0.1/api/files?project=project-a"));
  await GET(new Request("http://127.0.0.1/api/files?project=project-b"));

  expect(scans).toBe(1);
  expect(scanProjects).toEqual([undefined]);
});

function file(path: string): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "repo",
    title: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("a provisional Codex fork projects as archived history of its stable conversation", async () => {
  const registry = agentRegistry();
  const sourcePath = "/sessions/source-019f4906-3f67-7b72-9fbc-9ec3b5ad1301.jsonl";
  const forkPath = "/source-account/sessions/fork-019f4906-3f67-7b72-9fbc-9ec3b5ad1302.jsonl";
  const targetPath = "/target-account/sessions/fork-019f4906-3f67-7b72-9fbc-9ec3b5ad1302.jsonl";
  const conversation = registry.ensureConversation("codex", sourcePath, "source");
  registry.setConversationMigration(conversation.id, {
    intentId: "files-route-continuity",
    phase: "verifying",
    targetId: "target",
    revision: 1,
    error: null,
    updatedAt: "2026-07-10T12:00:00.000Z",
  });
  registry.recordConversationContinuityPath(conversation.id, forkPath);
  registry.commitSuccessor(conversation.id, { id: "019f4906-3f67-7b72-9fbc-9ec3b5ad1302", path: targetPath, accountId: "target" }, 1);
  scannedFiles = [file(forkPath), file(targetPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const fork = body.files.find((entry) => entry.path === forkPath);

  expect(fork?.conversationId).toBe(conversation.id);
  expect(fork?.migratedTo).toBe(targetPath);
  expect(withoutArchivedPredecessors(body.files).map((entry) => entry.path)).toEqual([targetPath]);
});

test("migration projection counts pending deliveries and omits delivered tombstones", async () => {
  const registry = agentRegistry();
  const sourcePath = "/sessions/pending-delivery-019f4906-3f67-7b72-9fbc-9ec3b5ad1303.jsonl";
  const conversation = registry.ensureConversation("codex", sourcePath, "source");
  const delivered = registry.holdDelivery(conversation.id, "already sent", "delivered-message");
  registry.beginDeliveryAttempt(delivered.id, conversation.generations.at(-1)!.id);
  registry.recordDeliveryOutcome(delivered.id, "delivered");
  registry.setConversationMigration(conversation.id, {
    intentId: "files-route-deliveries",
    phase: "requested",
    targetId: "target",
    revision: 1,
    error: null,
    updatedAt: "2026-07-11T12:00:00.000Z",
  });
  registry.holdDelivery(conversation.id, "send after switch", "pending-message");
  scannedFiles = [file(sourcePath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files[0]?.migration?.heldDeliveries).toBe(1);
});

test("spawn-time lineage keeps the child grouped after its tmux host disappears", async () => {
  const registry = agentRegistry();
  const parentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = registry.ensureConversation("codex", parentPath, null);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
  });
  if (begun.kind !== "created") throw new Error("expected a fresh spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.invalidateSpawnHost(begun.receipt.launchId, "test host loss");
  scannedFiles = [file(parentPath), file(childPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const child = body.files.find((entry) => entry.path === childPath);

  expect(child?.parent).toBe(parentPath);
  expect(child?.conversationId).toBe(begun.receipt.conversationId);
});

test("deleted parent lineage projects a tombstone and leaves no missing tree path", async () => {
  const registry = agentRegistry();
  const parentPath = "/sessions/removed-parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = registry.ensureConversation("codex", parentPath, null);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
  });
  if (begun.kind !== "created") throw new Error("expected a fresh spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(childPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const child = body.files.find((entry) => entry.path === childPath);

  expect(child?.parent).toBeNull();
  expect(child?.parentRemoved).toEqual({ conversationId: parent.id, path: parentPath });
});

test("an existing durable parent omitted from the scan enters the response closure", async () => {
  const registry = agentRegistry();
  const parentPath = path.join(registryRoot, "parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl");
  const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  fs.writeFileSync(parentPath, "{}\n");
  const parent = registry.ensureConversation("codex", parentPath, null);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
  });
  if (begun.kind !== "created") throw new Error("expected a fresh spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(childPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const child = body.files.find((entry) => entry.path === childPath);
  const projectedParent = body.files.find((entry) => entry.path === parentPath);

  expect(child?.parent).toBe(parentPath);
  expect(child?.parentRemoved).toBeUndefined();
  expect(projectedParent).toMatchObject({
    path: parentPath,
    conversationId: parent.id,
    project: "repo",
    activityReason: "lineage_placeholder",
  });
});

test("a lineage placeholder introduced for a pinned child stays inside the pin overlay", async () => {
  const registry = agentRegistry();
  const parentPath = path.join(registryRoot, "pinned-parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1335.jsonl");
  const childPath = "/sessions/pinned-child-019f4906-3f67-7b72-9fbc-9ec3b5ad1336.jsonl";
  fs.writeFileSync(parentPath, "{}\n");
  const parent = registry.ensureConversation("codex", parentPath, null);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
  });
  if (begun.kind !== "created") throw new Error("expected a fresh spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1336" },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scanFileResults = [[file(childPath)]];
  scanPinOverlayResults = [[childPath]];

  const response = await GET(new Request(`http://127.0.0.1/api/files?path=${encodeURIComponent(childPath)}`));
  const body = await response.json() as { files: FileEntry[]; pinOverlayPaths: string[] };

  expect(body.files.map((entry) => entry.path)).toEqual([childPath, parentPath]);
  expect(body.pinOverlayPaths).toEqual([childPath, parentPath]);
});

test("lineage projection uses one registry revision during provisional parent adoption", async () => {
  const registry = agentRegistry();
  const sourcePath = "/sessions/source-parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1324.jsonl";
  const parentPath = "/sessions/provisional-parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const canonicalParent = registry.ensureConversation("codex", sourcePath, null);
  registry.reconcileConversations([{
    engine: "codex",
    path: parentPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-12T12:00:00.000Z",
  }]);
  const provisionalParent = registry.conversationForPath(parentPath)!;
  const migration = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: canonicalParent.id,
    purpose: "migration-successor",
    expectedArtifactPath: parentPath,
  });
  if (migration.kind !== "created") throw new Error("expected migration receipt");
  const child = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: provisionalParent.id,
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: provisionalParent.id }),
  });
  if (child.kind !== "created") throw new Error("expected child receipt");
  registry.settleSpawn(child.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(parentPath), file(childPath)];

  const originalSnapshot = registry.snapshot.bind(registry);
  const originalReadOnlySnapshot = registry.readOnlySnapshot.bind(registry);
  let adopted = false;
  registry.readOnlySnapshot = () => {
    const snapshot = originalReadOnlySnapshot();
    if (!adopted) {
      adopted = true;
      registry.settleSpawn(migration.receipt.launchId, {
        key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
        artifactPath: parentPath,
        cwd: "/repo",
        accountId: null,
        status: "unhosted",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
    }
    return snapshot;
  };

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const projectedChild = body.files.find((entry) => entry.path === childPath);

  expect(projectedChild?.parent).toBe(parentPath);
  expect(projectedChild?.parentRemoved).toBeUndefined();
  expect(originalSnapshot().conversationAliases[provisionalParent.id]).toBe(canonicalParent.id);
});

test("a custom session title (issue #33) overrides the derived title and keeps it as autoTitle", async () => {
  const sessionUuid = "019f4906-3f67-7b72-9fbc-9ec3b5ad1399";
  const sessionPath = `/sessions/rollout-2026-07-12T00-00-00-${sessionUuid}.jsonl`;
  writeSessionTitle([`uuid:codex:${sessionUuid}`], `uuid:codex:${sessionUuid}`, "My human name", undefined, "2026-07-12T00:00:00.000Z");
  const derived = file(sessionPath);
  derived.title = "auto derived from first prompt";
  scannedFiles = [derived];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const entry = body.files.find((candidate) => candidate.path === sessionPath);

  expect(entry?.title).toBe("My human name");
  expect(entry?.autoTitle).toBe("auto derived from first prompt");
  expect(entry?.titleRevision).toBe(1);
  // A main session projects the rename-eligibility flag for the client gate.
  expect(entry?.renamable).toBe(true);
});

test("the files rail reaggregates uncapped conversations under registry launch projects", async () => {
  const registry = agentRegistry();
  const transcript = path.join(stateDir, "capped-out-launch-project.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Catalog prompt" } }) + "\n");
  const stat = fs.statSync(transcript);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: stateDir, project: "effective-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "capped-out-launch-project.jsonl",
    project: "scanner-project",
    title: "Catalog prompt",
    firstPrompt: "",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  scannedFiles = [];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { projectCatalog: Array<{ project: string; conversations: number }> };

  expect(body.projectCatalog).toEqual([expect.objectContaining({ project: "effective-project", conversations: 1 })]);
});

test("an unreadable pipelines store degrades to pipelinesError without failing the poll", async () => {
  scannedFiles = [];
  pipelinesStore = () => { throw new Error("pipeline registry contains malformed records"); };
  try {
    const response = await GET(new Request("http://127.0.0.1/api/files"));
    expect(response.status).toBe(200);
    const body = await response.json() as { files: unknown[]; pipelines: unknown[]; pipelinesError?: string };
    expect(body.pipelines).toEqual([]);
    expect(body.pipelinesError).toContain("malformed records");
  } finally {
    pipelinesStore = () => [];
  }
});

test("authorship freshness is path-scoped: an unscanned worker never certifies clean (issue #112)", async () => {
  /* The reaper's state file mtime (its coarse "last cycle" time) is fresh, yet
     `scannedAt` only carries the paths the reaper actually looked at. A worker
     that exited before any cycle scanned it is absent from `scannedAt`, so even
     with a stale on-disk mtime it must fail CLOSED to `authorshipUnverified` —
     a global cycle timestamp would falsely certify it and let a user-authored
     conversation collapse. */
  const authoredPath = "/sessions/authored-worker.jsonl";
  const scannedPath = "/sessions/scanned-clean-worker.jsonl";
  const unscannedPath = "/sessions/unscanned-worker.jsonl";
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: { [authoredPath]: true },
    scannedAt: { [scannedPath]: 5000 },
  }));
  scannedFiles = [
    { ...file(authoredPath), engine: "claude", mtime: 5000 },
    { ...file(scannedPath), engine: "codex", mtime: 4000 },
    { ...file(unscannedPath), engine: "codex", mtime: 1 },
  ];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const byPath = new Map(body.files.map((entry) => [entry.path, entry]));

  // Sticky user-authorship pins the card regardless of freshness.
  expect(byPath.get(authoredPath)?.userAuthored).toBe(true);
  expect(byPath.get(authoredPath)?.authorshipUnverified).toBeUndefined();
  // A path the reaper scanned clean at or after its current mtime is collapse-eligible.
  expect(byPath.get(scannedPath)?.userAuthored).toBeUndefined();
  expect(byPath.get(scannedPath)?.authorshipUnverified).toBeUndefined();
  // The hard constraint: an unscanned worker stays pinned even though the
  // state file's global mtime is newer than the transcript's.
  expect(byPath.get(unscannedPath)?.authorshipUnverified).toBe(true);
});

test("a worker whose transcript changed after its last clean scan re-pins as unverified (issue #112)", async () => {
  const stalePath = "/sessions/grew-after-scan.jsonl";
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [stalePath]: 3000 },
  }));
  scannedFiles = [{ ...file(stalePath), engine: "codex", mtime: 3600 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  expect(body.files[0]?.authorshipUnverified).toBe(true);
});

test("a message appended after a cached clean scan re-pins as unverified against live mtime (issue #112 finding)", async () => {
  /* The scan is a cache: a GET can reuse a snapshot whose mtime predates a
     just-appended owner message. A clean stamp taken before the append would
     look fresh against that stale cached mtime, so freshness must be checked
     against the LIVE filesystem, not the snapshot. */
  const workerPath = path.join(stateDir, "appended-worker.jsonl");
  fs.writeFileSync(workerPath, "line\n");
  const stampMtime = 4000;
  const liveMtime = 5000; // the real file grew after the clean scan
  fs.utimesSync(workerPath, liveMtime, liveMtime);
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [workerPath]: stampMtime },
  }));
  // The cached snapshot still carries the pre-append mtime.
  scannedFiles = [{ ...file(workerPath), engine: "codex", mtime: stampMtime }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const worker = body.files.find((entry) => entry.path === workerPath);
  expect(worker?.authorshipUnverified).toBe(true);
});

test("an unreadable transcript (non-ENOENT stat failure) fails closed to unverified (issue #112 finding)", async () => {
  /* Only a CONFIRMED absence lets a clean stamp stand on the cached mtime. A
     stat that fails for any other reason (EACCES/EIO/ENOTDIR) leaves freshness
     unknown, so the hard exemption must fail closed rather than trust the cache. */
  const blocker = path.join(stateDir, "blocker"); // a regular file...
  fs.writeFileSync(blocker, "x");
  const workerPath = path.join(blocker, "worker.jsonl"); // ...so statSync here throws ENOTDIR, not ENOENT
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [workerPath]: 3000 }, // a clean stamp that the cached mtime alone would certify
  }));
  scannedFiles = [{ ...file(workerPath), engine: "codex", mtime: 3000 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const worker = body.files.find((entry) => entry.path === workerPath);
  expect(worker?.authorshipUnverified).toBe(true);
});

test("authorship aggregates across the whole conversation lineage (issue #112 finding)", async () => {
  /* A user message recorded on an earlier generation/continuity path must pin
     the current generation even after the historical entry leaves the board. */
  const registry = agentRegistry();
  const currentPath = "/sessions/current-019f4906-3f67-7b72-9fbc-9ec3b5ad1401.jsonl";
  const priorPath = "/sessions/prior-019f4906-3f67-7b72-9fbc-9ec3b5ad1400.jsonl";
  const conversation = registry.ensureConversation("codex", currentPath, "acc");
  registry.recordConversationContinuityPath(conversation.id, priorPath);
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: { [priorPath]: true }, // the owner message lives on the prior generation
    scannedAt: { [currentPath]: 5000 },
  }));
  scannedFiles = [{ ...file(currentPath), engine: "codex", mtime: 4000 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const current = body.files.find((entry) => entry.path === currentPath);
  expect(current?.userAuthored).toBe(true);
});

test("fail-closed freshness spans the lineage: an unscanned predecessor pins the successor (issue #112 finding)", async () => {
  const registry = agentRegistry();
  const currentPath = "/sessions/succ-019f4906-3f67-7b72-9fbc-9ec3b5ad1403.jsonl";
  const priorPath = "/sessions/pred-019f4906-3f67-7b72-9fbc-9ec3b5ad1402.jsonl";
  const conversation = registry.ensureConversation("codex", currentPath, "acc");
  registry.recordConversationContinuityPath(conversation.id, priorPath);
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [currentPath]: 5000 }, // current is clean+fresh, but the predecessor was never scanned
  }));
  scannedFiles = [{ ...file(currentPath), engine: "codex", mtime: 4000 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const current = body.files.find((entry) => entry.path === currentPath);
  expect(current?.authorshipUnverified).toBe(true);
});

test("an uncertain live-mtime read (not ENOENT) fails closed to unverified (issue #112 finding)", async () => {
  /* A stamp is only trustworthy against a KNOWN live mtime. EACCES/EIO/ENOTDIR
     leave freshness unknown — mapping every stat error to the cached snapshot
     mtime would falsely certify a transcript that may have grown since. Force a
     non-ENOENT stat failure by nesting the transcript path under a regular file
     (statSync → ENOTDIR) and confirm it stays pinned despite a fresh stamp. */
  const blocker = path.join(stateDir, "blocker");
  fs.writeFileSync(blocker, "not a directory\n");
  const workerPath = path.join(blocker, "worker.jsonl"); // statSync(workerPath) → ENOTDIR
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [workerPath]: 5000 }, // stamp is fresh against the cached mtime below
  }));
  scannedFiles = [{ ...file(workerPath), engine: "codex", mtime: 4000 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const worker = body.files.find((entry) => entry.path === workerPath);
  expect(worker?.authorshipUnverified).toBe(true);
});

test("a confirmed-gone transcript (ENOENT) is certified by its immutable snapshot mtime (issue #112 finding)", async () => {
  /* A deleted transcript is immutable and off the board — a clean stamp at or
     past its last-known mtime certifies it, so it is not needlessly pinned. */
  const gonePath = "/sessions/gone-019f4906-3f67-7b72-9fbc-9ec3b5ad1404.jsonl"; // never created → ENOENT
  fs.writeFileSync(path.join(stateDir, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { [gonePath]: 5000 },
  }));
  scannedFiles = [{ ...file(gonePath), engine: "codex", mtime: 4000 }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const gone = body.files.find((entry) => entry.path === gonePath);
  expect(gone?.authorshipUnverified).toBeUndefined();
});
