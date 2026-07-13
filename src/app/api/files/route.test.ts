import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { agentRegistry, AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { writeSessionTitle } from "@/lib/session/titleStore";
import type { FileEntry } from "@/lib/types";

let scans = 0;
let scanOptions: unknown;
let scannedFiles: FileEntry[] = [];
let scanGates: Promise<void>[] = [];
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
  scannedFiles = [];
  scanGates = [];
  tmuxHealth = { status: "healthy" };
  replaceConversationCatalog([]);
});

afterEach(() => {
  setAgentRegistryForTests(null);
  replaceConversationCatalog([]);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
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
  let adopted = false;
  registry.snapshot = () => {
    const snapshot = originalSnapshot();
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
