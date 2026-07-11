import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { agentRegistry, AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

let scans = 0;
let scanOptions: unknown;
let scannedFiles: FileEntry[] = [];
let scanGates: Promise<void>[] = [];
let registryRoot = "";
let tmuxHealth: unknown = { status: "healthy" };

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-route-"));
  setAgentRegistryForTests(new AgentRegistry(path.join(registryRoot, "registry.json")));
  resetFilesRouteCacheForTests();
  scans = 0;
  scannedFiles = [];
  scanGates = [];
  tmuxHealth = { status: "healthy" };
});

afterEach(() => {
  setAgentRegistryForTests(null);
  fs.rmSync(registryRoot, { recursive: true, force: true });
});

mock.module("@/lib/scanner", () => ({
  listFiles: async () => [],
  listFilesWithProjectCatalog: async (_project: string | undefined, options: unknown) => {
    scans += 1;
    scanOptions = options;
    const files = scannedFiles;
    await scanGates.shift();
    return { files, projectCatalog: [] };
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
mock.module("@/lib/tmux", () => ({ tmuxEndpointHealth: () => tmuxHealth }));

const { cachedFileScan, resetFilesRouteCacheForTests } = await import("./scanCache");
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
  expect(scanOptions).toEqual({ persist: false });
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

test("an expired snapshot schedules its refresh after the response", async () => {
  await cachedFileScan();
  const stale = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER);

  expect(scans).toBe(1);
  expect(stale.refreshAfterResponse).toBeFunction();

  await stale.refreshAfterResponse?.();
  expect(scans).toBe(2);
});

test("a files revision request refreshes the snapshot before responding", async () => {
  scannedFiles = [file("/sessions/before-revision.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files"));

  scannedFiles = [file("/sessions/after-revision.jsonl")];
  const response = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "1" },
  }));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files.map((entry) => entry.path)).toEqual(["/sessions/after-revision.jsonl"]);
  expect(scans).toBe(2);
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

test("a persisted legacy cache slot upgrades before fresh hydration", async () => {
  const legacySnapshot = {
    files: [file("/sessions/sentinel-stale.jsonl")],
    projectCatalog: [],
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

  expect(result.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/upgraded-fresh.jsonl"]);
  expect(scans).toBe(1);
});

test("an arbitrary client revision cannot suppress a later revision refresh", async () => {
  scannedFiles = [file("/sessions/untrusted-watermark.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": String(Number.MAX_SAFE_INTEGER) },
  }));

  scannedFiles = [file("/sessions/genuine-revision.jsonl")];
  const response = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": "7" },
  }));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files.map((entry) => entry.path)).toEqual(["/sessions/genuine-revision.jsonl"]);
  expect(scans).toBe(2);
});

test("the project scan cache evicts its least recently used entry", async () => {
  for (let index = 0; index <= 32; index += 1) {
    await cachedFileScan(`project-${index}`);
  }
  expect(scans).toBe(33);

  await cachedFileScan("project-0");
  expect(scans).toBe(34);
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
