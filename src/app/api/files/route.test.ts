import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { agentRegistry, AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { recordBridgeDirectiveAnswer, recordManagerReport } from "@/lib/bridge/service";
import { createManualProject, setProjectCrown } from "@/lib/projects/curation";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { globalCache } from "@/lib/scanner/caches";
import { describe as describeTranscript, projectInfoFromCwd, projectRootForCwd } from "@/lib/scanner/describe";
import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";
import { writeSessionTitle } from "@/lib/session/titleStore";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { createFilesClientCache } from "@/hooks/useFiles";
import { beginLegacySpawnFixture, beginLegacySpawnReceiptFixture, withLegacySpawnFixtureTitles } from "@/lib/agent/registryTestFixtures";

let scans = 0;
let scanOptions: unknown;
let scanProjects: Array<string | undefined> = [];
let scannedFiles: FileEntry[] = [];
let scannedProjectCatalog: ProjectCatalogEntry[] = [];
let scanFileResults: FileEntry[][] = [];
let scanPinOverlayResults: Array<string[] | undefined> = [];
let scanCompleteResults: Array<boolean | undefined> = [];
let scanGates: Promise<void>[] = [];
let scanAborts = 0;
let hydrateScannedFiles: (files: FileEntry[], options: unknown) => FileEntry[] = (files) => files;
let registryRoot = "";
let tmuxHealth: unknown = { status: "healthy" };
let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

function resetFilesProjectionCacheForTests(): void {
  const store = globalThis as typeof globalThis & {
    __llvFilesProjectionCache?: Map<string, unknown>;
    __llvFilesProjectionInflight?: Map<string, Promise<unknown>>;
    __llvFilesProjectionWorkerTail?: Promise<void>;
    __llvFilesPersistedProjectionChecked?: boolean;
  };
  store.__llvFilesProjectionCache = new Map();
  store.__llvFilesProjectionInflight = new Map();
  store.__llvFilesProjectionWorkerTail = undefined;
  store.__llvFilesPersistedProjectionChecked = undefined;
}

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-route-"));
  // Sandbox the title store so the integration test's writeSessionTitle never
  // touches the real ~/.config/agent-log-viewer state.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-route-state-"));
  process.env.LLV_STATE_DIR = stateDir;
  setAgentRegistryForTests(withLegacySpawnFixtureTitles(new AgentRegistry(path.join(registryRoot, "registry.json"))));
  resetFilesRouteCacheForTests();
  resetFilesProjectionCacheForTests();
  scans = 0;
  scanProjects = [];
  scannedFiles = [];
  scannedProjectCatalog = [];
  scanFileResults = [];
  scanPinOverlayResults = [];
  scanCompleteResults = [];
  scanGates = [];
  scanAborts = 0;
  hydrateScannedFiles = (files) => files;
  tmuxHealth = { status: "healthy" };
  flowsStore = () => [];
  pipelinesStore = () => [];
  pipelineVisibility = () => [];
  pipelineMutationCalls = 0;
  replaceConversationCatalog([]);
  resetPresenceForTest();
});

afterEach(() => {
  setAgentRegistryForTests(null);
  resetPresenceForTest();
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
    const resourceSnapshot = { files, projectCatalog: scannedProjectCatalog, complete: true };
    (options as { onResourceSnapshot?: (snapshot: typeof resourceSnapshot) => void }).onResourceSnapshot?.(resourceSnapshot);
    const gate = scanGates.shift();
    const signal = (options as { signal?: AbortSignal }).signal;
    if (gate && signal) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          scanAborts += 1;
          signal.removeEventListener("abort", onAbort);
          reject(new DOMException("scan cancelled", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        gate.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    } else {
      await gate;
    }
    const pinOverlayPaths = scanPinOverlayResults.shift();
    const complete = scanCompleteResults.shift();
    return { files, projectCatalog: scannedProjectCatalog, ...(pinOverlayPaths ? { pinOverlayPaths } : {}), complete: complete ?? true };
  },
}));
let pipelinesStore: () => unknown[] = () => [];
let flowsStore: () => unknown[] = () => [];
let pipelineVisibility: (pipelines: unknown[]) => unknown[] = () => [];
let pipelineMutationCalls = 0;
mock.module("@/lib/flows/store", () => ({ loadFlows: () => flowsStore() }));
mock.module("@/lib/pipelines/store", () => ({
  loadPipelines: () => pipelinesStore(),
  loadPipelinesForProjection: () => pipelinesStore(),
  withPipelineMutation: (...args: unknown[]) => {
    pipelineMutationCalls += 1;
    const real = realModules.get("@/lib/pipelines/store") as { withPipelineMutation: (...call: unknown[]) => unknown };
    return real.withPipelineMutation(...args);
  },
}));
mock.module("@/lib/pipelines/visibility", () => ({ filterPipelinesForFileScan: (pipelines: unknown[]) => pipelineVisibility(pipelines) }));
let boardTasksStore: () => unknown[] = () => [];
mock.module("@/lib/tasks/store", () => ({
  loadTasks: () => boardTasksStore(),
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

const { cachedFileScan, completedFileScan, currentFileScan, fileScanCacheStatus, resetFilesRouteCacheForTests } = await import("@/lib/scanner/scanCache");
const { fileScanCoordinatorStatus } = await import("@/lib/scanner/scanCoordinator");
const { postSnapshot } = await import("@/app/api/agent/snapshot/handler");
const { resetPresenceForTest, upsertPresence } = await import("@/lib/view/presenceStore");
const { controllerFileScan } = await import("@/lib/pipelines/controller");
const { allowedKillTarget, buildResourceSnapshot, lastResourceTargetRefs, noteSessionTargets, readResourceFileSnapshot } = await import("@/lib/resources");
const { GET } = await import("./route");
const { consolidateProjectCatalogByRepository } = await import("./response");

test("repository-backed catalog rows collapse to the current repository identity", () => {
  const repositoryRoot = process.cwd();
  const canonical = projectInfoFromCwd(repositoryRoot)!;
  const result = consolidateProjectCatalogByRepository([
    {
      project: canonical.project,
      displayName: canonical.displayName,
      smt: 20,
      conversations: 7,
      projectRoot: repositoryRoot,
      repository: "owner/repository",
    },
    {
      project: "repo-00000000000000000000000000000000",
      displayName: canonical.displayName,
      smt: 10,
      conversations: 3,
      projectRoot: repositoryRoot,
      repository: "owner/repository",
    },
  ]);

  expect(result.projectCatalog).toEqual([expect.objectContaining({
    project: canonical.project,
    conversations: 10,
    smt: 20,
  })]);
  expect(result.projectRemap.get("repo-00000000000000000000000000000000")).toBe(canonical.project);
});

test("a repository binding on one member never absorbs a directory project", () => {
  const result = consolidateProjectCatalogByRepository([
    {
      project: "repo-11111111111111111111111111111111",
      displayName: "shared-repository",
      smt: 30,
      conversations: 12,
      repository: "owner/shared-repository",
    },
    {
      // A folder group whose one recent session happens to be MCP-bound to
      // the repository above — the folder keeps its own project.
      project: "dir-22222222222222222222222222222222",
      displayName: "home-operator",
      smt: 40,
      conversations: 600,
      repository: "owner/shared-repository",
    },
  ]);

  const projects = result.projectCatalog.map((entry) => entry.project).sort();
  expect(projects).toEqual(["dir-22222222222222222222222222222222", "repo-11111111111111111111111111111111"]);
  expect(result.projectRemap.get("dir-22222222222222222222222222222222")).toBe("dir-22222222222222222222222222222222");
});

test("a repository checkout recorded as a folder group's projectRoot never renames it", () => {
  // A session in a plain folder that administers a repository records the
  // checkout as its projectRoot metadata — the folder group must keep its
  // directory identity anyway.
  const repositoryRoot = process.cwd();
  const repoIdentity = projectInfoFromCwd(repositoryRoot)!;
  const result = consolidateProjectCatalogByRepository([
    {
      project: "dir-33333333333333333333333333333333",
      displayName: "home-operator",
      smt: 50,
      conversations: 600,
      projectRoot: repositoryRoot,
    },
    {
      project: repoIdentity.project,
      displayName: repoIdentity.displayName,
      smt: 40,
      conversations: 12,
      projectRoot: repositoryRoot,
      repository: "owner/shared-repository",
    },
  ]);

  const projects = result.projectCatalog.map((entry) => entry.project).sort();
  expect(projects).toEqual(["dir-33333333333333333333333333333333", repoIdentity.project].sort());
  expect(result.projectRemap.get("dir-33333333333333333333333333333333")).toBe("dir-33333333333333333333333333333333");
  const folder = result.projectCatalog.find((entry) => entry.project.startsWith("dir-"))!;
  expect(folder.displayName).toBe("home-operator");
});

test("project cwd projection rejects repository evidence poisoned into a directory project", async () => {
  const directoryCwd = path.join(stateDir, "plain-workspace");
  const repositoryCwd = process.cwd();
  fs.mkdirSync(directoryCwd, { recursive: true });
  const directory = projectInfoFromCwd(directoryCwd)!;
  const repository = projectInfoFromCwd(repositoryCwd)!;

  scannedProjectCatalog = [
    {
      project: directory.project,
      displayName: directory.displayName,
      projectRoot: repositoryCwd,
      smt: 20,
      conversations: 1,
    },
    {
      project: repository.project,
      displayName: repository.displayName,
      projectRoot: repositoryCwd,
      smt: 10,
      conversations: 1,
    },
  ];
  replaceConversationCatalog(scannedProjectCatalog.map((entry, index) => ({
    path: path.join(stateDir, `project-cwd-${index}.jsonl`),
    root: "codex-sessions",
    name: `project-cwd-${index}.jsonl`,
    project: entry.project,
    projectName: entry.displayName,
    title: "Project cwd fixture",
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: entry.smt,
    size: 1,
  })));
  fs.writeFileSync(path.join(stateDir, "project-catalog.json"), JSON.stringify({
    version: 2,
    files: {
      directory: { cwd: directoryCwd, projectRoot: repositoryCwd },
      repository: { cwd: repositoryCwd, projectRoot: repositoryCwd },
    },
  }));

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { projectCwds?: Record<string, string> };

  expect(body.projectCwds?.[directory.project]).toBe(directoryCwd);
  expect(body.projectCwds?.[repository.project]).toBe(repositoryCwd);
  expect(body.projectCwds?.[directory.project]).not.toBe(body.projectCwds?.[repository.project]);
});

test("catalog aliases collapse a legacy dashed-path variant before grouping", () => {
  const canonical = "repo-0123456789abcdef0123456789abcdef";
  const result = consolidateProjectCatalogByRepository(
    [
      {
        project: "home-primary-Projects-example",
        displayName: "Unresolved project",
        smt: 20,
        conversations: 1,
      },
      {
        project: canonical,
        displayName: "example",
        smt: 10,
        conversations: 3,
        repository: "owner/example",
      },
    ],
    { "-home-primary-Projects-example": canonical },
    { [canonical]: "example" },
  );

  expect(result.projectCatalog).toEqual([expect.objectContaining({
    project: canonical,
    displayName: "example",
    conversations: 4,
  })]);
  expect(result.projectRemap.get("home-primary-Projects-example")).toBe(canonical);
});

test("a unique repository display name absorbs its matching legacy project key", () => {
  const repositoryRoot = process.cwd();
  const canonical = projectInfoFromCwd(repositoryRoot)!;
  const result = consolidateProjectCatalogByRepository([
    {
      project: canonical.project,
      displayName: canonical.displayName,
      smt: 20,
      conversations: 7,
    },
    {
      project: canonical.displayName,
      displayName: canonical.displayName,
      smt: 10,
      conversations: 1,
      projectRoot: os.homedir(),
    },
  ]);

  expect(result.projectCatalog).toEqual([expect.objectContaining({
    project: canonical.project,
    displayName: canonical.displayName,
    conversations: 8,
    smt: 20,
  })]);
  expect(result.projectRemap.get(canonical.displayName)).toBe(canonical.project);
  const repeated = consolidateProjectCatalogByRepository(result.projectCatalog);
  expect(repeated.projectCatalog).toEqual(result.projectCatalog);
  expect(repeated.projectRemap.get(canonical.project)).toBe(canonical.project);
});

test("distinct readable legacy projects do not share the unresolved label", () => {
  const result = consolidateProjectCatalogByRepository([
    {
      project: "readable-project",
      displayName: "Unresolved project",
      smt: 20,
      conversations: 1,
    },
    {
      project: "project_unresolved",
      displayName: "Unresolved project",
      smt: 10,
      conversations: 3,
    },
  ]);

  expect(result.projectCatalog.find((entry) => entry.project === "readable-project")?.displayName)
    .toBe("readable-project");
  expect(result.projectCatalog.find((entry) => entry.project === "project_unresolved")?.displayName)
    .toBe("Unresolved project");
});

test("repeated files reads reuse the pure read snapshot and retain ETag behavior", async () => {
  scannedFiles = [];
  const registry = agentRegistry();
  const target = registry as unknown as { readOnlySnapshot: AgentRegistry["readOnlySnapshot"] };
  const realReadOnlySnapshot = target.readOnlySnapshot.bind(registry);
  let registryReads = 0;
  target.readOnlySnapshot = () => {
    registryReads += 1;
    return realReadOnlySnapshot();
  };
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  const second = await GET(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    files: [], projectCatalog: [], flows: [], pipelines: [], workflows: [], tasks: [],
    systemHealth: { tmux: { status: "healthy" }, registry: { backendMode: expect.any(String) } },
    conversationAliases: {},
  });
  expect(second.status).toBe(304);
  expect(scans).toBe(1);
  expect(scanOptions).toEqual(expect.objectContaining({
    persist: false,
    persistIndex: true,
  }));
  expect(scanOptions).not.toHaveProperty("onResourceSnapshot");
  expect(first.headers.get("x-llv-files-cache")).toBe("miss");
  expect(second.headers.get("x-llv-files-cache")).toBe("hit");
  expect(first.headers.get("x-llv-files-projection-cache")).toBe("miss");
  expect(second.headers.get("x-llv-files-projection-cache")).toBe("hit");
  expect(first.headers.get("x-llv-files-cache-requests")).toBe("1");
  expect(second.headers.get("x-llv-files-cache-requests")).toBe("2");
  expect(registryReads).toBe(1);
  expect(first.headers.get("server-timing")).toMatch(/files-clone;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-scan;dur=\d+(?:\.\d+)?;desc="cold generation 1"/);
  expect(first.headers.get("server-timing")).toMatch(/files-(?:source|registry|flows|authorship|stores|projects|json);dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-project-rate-limits;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-project-catalog;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-project-cwds;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-session-titles;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-project-affinity;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-flow-store;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-flow-restore;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-task-store;dur=\d+(?:\.\d+)?/);
  expect(first.headers.get("server-timing")).toMatch(/files-role-titles;dur=\d+(?:\.\d+)?/);
});

test("a cross-process SQLite pipeline commit invalidates a warm files projection", async () => {
  scannedFiles = [];
  const real = realModules.get("@/lib/pipelines/store") as {
    savePipelines: (pipelines: Pipeline[]) => void;
  };
  real.savePipelines([]);
  pipelinesStore = () => readStateCollectionRows(path.join(stateDir, "state.sqlite"), "pipelines") ?? [];
  pipelineVisibility = (pipelines) => pipelines;
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const second = await GET(new Request("http://127.0.0.1/api/files"));
  expect((await first.json() as { pipelines: Pipeline[] }).pipelines).toEqual([]);
  expect(second.headers.get("x-llv-files-projection-cache")).toBe("hit");

  const ready = path.join(stateDir, "pipeline-writer-ready");
  const release = path.join(stateDir, "pipeline-writer-release");
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(process.cwd(), "src/lib/state/hotStateStores.sqliteChild.ts"), "pipelines", "external", ready, release],
    cwd: process.cwd(),
    env: { ...process.env, LLV_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 2_000 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(5);
  expect(fs.existsSync(ready)).toBe(true);
  fs.writeFileSync(release, "release");
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`pipeline writer failed: ${await new Response(child.stderr).text()}`);

  const refreshed = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await refreshed.json() as { pipelines: Pipeline[] };
  expect(refreshed.headers.get("x-llv-files-projection-cache")).toBe("miss");
  expect(body.pipelines.map((pipeline) => pipeline.id)).toEqual(["pipe-external"]);
});

test("a process restart serves the persisted global projection while refreshing it", async () => {
  const store = globalThis as typeof globalThis & {
    __llvFilesProjectionInflight?: Map<string, Promise<unknown>>;
    __llvFilesProjectionPersistenceTail?: Promise<void>;
  };
  process.env.LLV_FILES_PROJECTION_PERSIST_FOR_TEST = "1";
  try {
    scannedFiles = [file("/sessions/persisted-projection.jsonl")];
    const first = await GET(new Request("http://127.0.0.1/api/files?project=project-a"));
    const firstBody = await first.text();
    await store.__llvFilesProjectionPersistenceTail;

    resetFilesProjectionCacheForTests();
    const restarted = await GET(new Request("http://127.0.0.1/api/files?project=project-b"));

    expect(restarted.status).toBe(200);
    expect(restarted.headers.get("x-llv-files-projection-cache")).toBe("stale");
    expect(await restarted.text()).toBe(firstBody);

    for (let attempt = 0; attempt < 100 && store.__llvFilesProjectionInflight?.size; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(store.__llvFilesProjectionInflight?.size ?? 0).toBe(0);
    await store.__llvFilesProjectionPersistenceTail;
  } finally {
    delete process.env.LLV_FILES_PROJECTION_PERSIST_FOR_TEST;
  }
});

test("registry heartbeat writes do not invalidate the completed files projection", async () => {
  scannedFiles = [];
  const registry = agentRegistry();
  const key = { engine: "codex" as const, sessionId: "heartbeat-cache-test" };
  const entry = {
    key,
    artifactPath: path.join(registryRoot, "heartbeat-cache-test.jsonl"),
    cwd: registryRoot,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: registryRoot }),
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
  registry.upsert(entry);
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const before = registry.storageDiagnostics();
  registry.upsert(entry);
  const after = registry.storageDiagnostics();
  const etag = first.headers.get("etag");
  const second = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "if-none-match": etag! },
  }));

  expect(after.transactionCount).toBeGreaterThan(before.transactionCount);
  expect(first.headers.get("x-llv-files-projection-cache")).toBe("miss");
  expect(second.status).toBe(304);
  expect(second.headers.get("x-llv-files-projection-cache")).toBe("stale");
});

test("a stable scope serves its prior conditional representation while projection inputs advance", async () => {
  scannedFiles = [file("/sessions/current.jsonl")];
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");

  fs.writeFileSync(path.join(stateDir, "flows.json"), JSON.stringify({ schemaVersion: 1, flows: [] }));
  const second = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "if-none-match": etag! },
  }));

  expect(second.status).toBe(304);
  expect(second.headers.get("x-llv-files-generation")).toBe("1");
  expect(second.headers.get("x-llv-files-projection-cache")).toBe("stale");
});

test("generation completion retries skip the stale projection while its refresh is running", async () => {
  scannedFiles = [file("/sessions/generation-1.jsonl")];
  const initial = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = initial.headers.get("etag");
  expect(initial.headers.get("x-llv-files-generation")).toBe("1");

  let releaseRefresh!: () => void;
  scanGates.push(new Promise<void>((resolve) => { releaseRefresh = resolve; }));
  scannedFiles = [file("/sessions/generation-2.jsonl")];
  try {
    const revision = await GET(new Request("http://127.0.0.1/api/files", {
      headers: {
        "if-none-match": etag!,
        "x-llv-files-revision": "41",
      },
    }));
    expect(revision.headers.get("x-llv-files-generation")).toBe("1");
    expect(revision.headers.get("x-llv-files-target-generation")).toBe("2");

    const retry = await GET(new Request("http://127.0.0.1/api/files", {
      headers: {
        "if-none-match": etag!,
        "x-llv-files-generation": "2",
      },
    }));

    expect(retry.status).toBe(304);
    expect(await retry.text()).toBe("");
    expect(retry.headers.get("etag")).toBe(etag);
    expect(retry.headers.get("x-llv-files-generation")).toBe("1");
    expect(retry.headers.get("x-llv-files-target-generation")).toBe("2");
    expect(retry.headers.get("x-llv-files-cache")).toBe("stale");
    expect(retry.headers.get("server-timing")).toContain("files-generation-wait");
    expect(retry.headers.get("server-timing")).not.toContain("files-registry");
    expect(scans).toBe(2);
  } finally {
    releaseRefresh();
  }
});

test("issues 532/798: files response projects exactly one request-level flow read", async () => {
  const oldFlow = {
    id: "flow-atomic-projection", template: "implement-review-loop", project: "demo", cwd: "/repo",
    implementerPath: "/missing/implementer.jsonl", roles: {
      implementer: { engine: "codex", model: null, effort: "low" },
      reviewer: { engine: "codex", model: null, effort: "high" },
    }, baseRef: "a".repeat(40), baseMode: "head", mode: "auto", reviewerMode: "headless",
    roundLimit: 5, state: "reviewing", stateDetail: null,
    rounds: [{ n: 1, reviewerPath: "/reviewer-1.jsonl", reviewHeadSha: "1".repeat(40) }],
    createdAt: "2026-07-22T00:00:00Z", closedAt: null,
  };
  const currentFlow = {
    ...structuredClone(oldFlow),
    rounds: [
      ...oldFlow.rounds,
      { n: 2, reviewerPath: "/reviewer-2.jsonl", reviewHeadSha: "2".repeat(40) },
    ],
  };
  let reads = 0;
  flowsStore = () => structuredClone(reads++ === 0 ? [oldFlow] : [currentFlow]);
  scannedFiles = [];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { flows: Array<{ id: string; rounds: Array<{ n: number }> }> };
  /* One flow load per request (issue #798): every consumer — restored flows,
     the pipeline sync overlay, role titles — shares that single generation, so
     a store advance mid-request can never mix generations (issue #532). */
  expect(reads).toBe(1);
  expect(body.flows).toEqual([expect.objectContaining({
    id: oldFlow.id,
    rounds: [expect.objectContaining({ n: 1 })],
  })]);
});

test("issue 798: a files GET reads the registry once, threads it to titles, and never mutates pipelines", async () => {
  const sessionPath = "/sessions/threaded-projection.jsonl";
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", sessionPath, null);
  scannedFiles = [file(sessionPath)];
  const target = registry as unknown as { readOnlySnapshot: AgentRegistry["readOnlySnapshot"] };
  const realReadOnlySnapshot = target.readOnlySnapshot.bind(registry);
  let registryReads = 0;
  target.readOnlySnapshot = () => {
    registryReads += 1;
    return realReadOnlySnapshot();
  };
  try {
    const response = await GET(new Request("http://127.0.0.1/api/files"));
    const body = await response.json() as { files: Array<{ path: string; conversationId?: string }> };
    expect(response.status).toBe(200);
    expect(body.files.find((entry) => entry.path === sessionPath)?.conversationId).toBe(conversation.id);
    /* The single read-only snapshot is threaded to every projection consumer
       (title overlay included); a second read here is the #798 regression. */
    expect(registryReads).toBe(1);
    expect(pipelineMutationCalls).toBe(0);
  } finally {
    target.readOnlySnapshot = realReadOnlySnapshot;
  }
});

test("volatile registry diagnostics do not invalidate an otherwise stable files ETag", async () => {
  const filename = path.join(registryRoot, "registry.json");
  beginLegacySpawnReceiptFixture(new AgentRegistry(filename), "codex", "/seed");
  let now = 1_000;
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    now: () => now,
    mirrorCheckpointMs: 120_000,
    scheduleMirrorCheckpoint: () => ({ unref() {} }),
  });
  beginLegacySpawnReceiptFixture(registry, "codex", "/writer-rate-sample");
  setAgentRegistryForTests(registry);
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");

  now += 61_000;
  const second = await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "if-none-match": etag! },
  }));

  expect(first.status).toBe(200);
  expect(second.status).toBe(304);
});

test("production-sized SQLite registry keeps cold and warm files probes within budget", async () => {
  const filename = path.join(registryRoot, "production-registry.json");
  const seed = new AgentRegistry(filename);
  const template = beginLegacySpawnReceiptFixture(seed, "codex", "/production-seed");
  const production = seed.snapshot();
  for (let index = 1; index < 18_000; index += 1) {
    const launchId = `production-seed-${String(index).padStart(5, "0")}`;
    production.receipts[launchId] = {
      ...structuredClone(template),
      launchId,
      state: "failed",
      artifactLifecycle: "materialized",
      error: "fixture-terminal",
    };
  }
  const payload = JSON.stringify(production);
  expect(Buffer.byteLength(payload)).toBeGreaterThanOrEqual(14_660_822);
  fs.writeFileSync(filename, payload);
  setAgentRegistryForTests(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" }));

  const writerReady = path.join(registryRoot, "production-writer.ready");
  const writerStart = path.join(registryRoot, "production-writer.start");
  const writerResult = path.join(registryRoot, "production-writer.json");
  const writer = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../../../lib/agent/registry.sqliteChild.ts"),
    "writer-mixed",
    filename,
    writerReady,
    writerStart,
    "files-probe-writer",
    "12",
    writerResult,
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  while (!fs.existsSync(writerReady)) await Bun.sleep(1);
  fs.writeFileSync(writerStart, "start");

  const coldStartedAt = performance.now();
  const cold = await GET(new Request("http://127.0.0.1/api/files"));
  const coldDuration = performance.now() - coldStartedAt;
  const warmStartedAt = performance.now();
  const warm = await GET(new Request("http://127.0.0.1/api/files"));
  const warmDuration = performance.now() - warmStartedAt;
  expect(await writer.exited).toBe(0);
  expect(await new Response(writer.stderr).text()).toBe("");

  expect(cold.status).toBe(200);
  expect(warm.status).toBe(200);
  expect(coldDuration).toBeLessThan(1_000);
  expect(warmDuration).toBeLessThan(500);
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

test("concurrent cold files reads share one scan and one projection", async () => {
  const registry = agentRegistry();
  const target = registry as unknown as { readOnlySnapshot: AgentRegistry["readOnlySnapshot"] };
  const realReadOnlySnapshot = target.readOnlySnapshot.bind(registry);
  let registryReads = 0;
  target.readOnlySnapshot = () => {
    registryReads += 1;
    return realReadOnlySnapshot();
  };
  const [first, second] = await Promise.all([
    GET(new Request("http://127.0.0.1/api/files")),
    GET(new Request("http://127.0.0.1/api/files")),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(scans).toBe(1);
  expect(registryReads).toBe(1);
  expect([
    first.headers.get("x-llv-files-projection-cache"),
    second.headers.get("x-llv-files-projection-cache"),
  ].sort()).toEqual(["joined", "miss"]);
});

test("a restart serves the persisted completed snapshot while revalidating", async () => {
  const persistedSnapshot = {
    files: [file("/sessions/persisted.jsonl")],
    projectCatalog: [],
    complete: true,
  };
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    schemaVersion: 10,
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

test("the pipeline controller warm-starts from the persisted completed snapshot while revalidating", async () => {
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    schemaVersion: 10,
    snapshot: {
      files: [file("/sessions/persisted-controller.jsonl")],
      projectCatalog: [],
      complete: true,
    },
  }));
  resetFilesRouteCacheForTests();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [file("/sessions/refreshed-controller.jsonl")];

  const started = performance.now();
  const snapshot = await controllerFileScan();

  expect(performance.now() - started).toBeLessThan(300);
  expect(snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/persisted-controller.jsonl"]);
  expect(scans).toBe(0);

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(1);
  release();
});

test("a current scan joins restart revalidation before publishing transcript metadata", async () => {
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), JSON.stringify({
    version: 1,
    schemaVersion: 10,
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

  expect(scansBeforeRelease).toBe(1);
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
  await cachedFileScan(undefined, undefined, now + 300_100);
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
  await cachedFileScan(undefined, undefined, now + 300_100);
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

  expect(settledBeforeFullScan).toBeFalse();
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
  await cachedFileScan(undefined, undefined, now + 300_100);
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

  // The scan coordinator starts the merged generation one microtask after the
  // callers enqueue (#287); both retries still share exactly one scan.
  await Promise.resolve();
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
  const revalidating = await cachedFileScan(undefined, undefined, now + 300_100);
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
  // The scan coordinator starts the fresh generation one microtask after the
  // resource reader enqueues it (#287).
  await Promise.resolve();
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
  const sessionId = "199e8e95-0e87-\x34b4f-84bf-f62b3c0993a3";
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
    schemaVersion: 10,
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
    schemaVersion: 10,
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
  expect(persisted.schemaVersion).toBe(10);
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
    schemaVersion: 10,
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

  const stale = await cachedFileScan(undefined, undefined, now + 300_100);
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
  await cachedFileScan(undefined, undefined, now + 300_100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scans).toBe(2);

  const retryTraffic = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    cachedFileScan(undefined, undefined, now + 301_000 + index * 375)));
  expect(retryTraffic.every((scan) => scan.snapshot.files[0]?.path === "/sessions/ordinary-retry.jsonl")).toBeTrue();
  expect(retryTraffic.every((scan) => scan.cacheStatus === "hit" && scan.targetGeneration === scan.generation)).toBeTrue();
  expect(scans).toBe(2);

  await cachedFileScan(undefined, undefined, now + 600_200);
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

  const stale = await cachedFileScan(undefined, undefined, now + 300_100);
  expect(stale.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await cachedFileScan()).snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/canonical.jsonl"]);

  scanFileResults = [[file("/sessions/recovered.jsonl")]];
  const recovered = await cachedFileScan(undefined, undefined, now + 600_200);
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

test("a cold completed scan aborts its refresh after every subscriber leaves", async () => {
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const reads = controllers.map((controller) => completedFileScan({ signal: controller.signal })
    .then(() => "resolved", (error: unknown) => error instanceof Error ? error.name : String(error)));

  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toBe(1);
  expect(fileScanCacheStatus()).toEqual({ inFlight: true, subscribers: 20 });

  for (const controller of controllers) controller.abort();
  const outcomes = await Promise.race([
    Promise.all(reads),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancelled scan retained its subscribers")), 1_000)),
  ]);
  release();
  await Promise.resolve();
  await Promise.resolve();

  expect(outcomes).toEqual(Array.from({ length: 20 }, () => "AbortError"));
  expect(scanAborts).toBe(1);
  expect(fileScanCacheStatus()).toEqual({ inFlight: false, subscribers: 0 });
  expect(fileScanCoordinatorStatus()).toEqual({ inFlight: false, queued: 0, subscribers: 0 });
});

test("a warm snapshot returns the completed projection while an independent refresh is blocked", async () => {
  const completed = file("/sessions/completed-snapshot.jsonl");
  scannedFiles = [completed];
  await completedFileScan({ revalidate: false });
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  scannedFiles = [file("/sessions/unhealthy-refresh.jsonl")];
  const refresh = currentFileScan({ fresh: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toBe(2);

  upsertPresence({
    schemaVersion: 1,
    viewSessionId: "warm-snapshot",
    deviceId: "fixture-device",
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "repo",
    mode: "scheme",
    viewport: { width: 1280, height: 720, dpr: 1 },
    camera: null,
    focusedPath: completed.path,
    selectedPaths: [],
    visiblePaths: [completed.path],
    board: { renderedRevision: 1, durableRevision: 1, sync: "current" },
  });
  const startedAt = performance.now();
  const response = await postSnapshot(new Request("http://127.0.0.1:8898/api/agent/snapshot", {
    method: "POST",
    headers: { host: "127.0.0.1:8898" },
    body: JSON.stringify({ schemaVersion: 1, text: { include: false } }),
  }) as never, {
    completedFileScan,
    resolveSiblings: async () => ({ selfResolution: "omitted", agents: [] }),
    registrySnapshot: () => ({ conversations: {}, entries: {}, lineageEdges: {}, memberships: {}, conversationAliases: {}, receipts: {} }) as never,
    snapshotDeadlineMs: 1_000,
    scheduler: { setTimeout, clearTimeout },
  });

  expect(performance.now() - startedAt).toBeLessThan(300);
  expect(response.status).toBe(200);
  expect((await response.json()).conversations.map((entry: { path: string }) => entry.path)).toEqual([completed.path]);
  expect(fileScanCacheStatus()).toEqual({ inFlight: true, subscribers: 1 });

  release();
  await refresh;
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

test("a pin already present in the global snapshot does not start an exclusive scan", async () => {
  const pinnedPath = "/sessions/visible-pin.jsonl";
  scannedFiles = [file("/sessions/global.jsonl"), file(pinnedPath)];
  await cachedFileScan();

  const pinned = await cachedFileScan(undefined, pinnedPath, Date.now());
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(pinned.snapshot.files.map((entry) => entry.path)).toEqual([
    "/sessions/global.jsonl",
    pinnedPath,
  ]);
  expect(pinned.pinOverlayPaths).toBeUndefined();
  expect(scans).toBe(1);
});

test("visible pins share one revision generation across browser scopes", async () => {
  const firstPath = "/sessions/visible-a.jsonl";
  const secondPath = "/sessions/visible-b.jsonl";
  scannedFiles = [file(firstPath), file(secondPath)];
  await cachedFileScan();

  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  await Promise.all([
    cachedFileScan(undefined, firstPath, Date.now(), 580),
    cachedFileScan(undefined, secondPath, Date.now(), 580),
  ]);
  await Promise.resolve();
  expect(scans).toBe(2);

  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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

test("a dead registry generation closes an interrupted transcript after its process exits", async () => {
  const sessionId = "aaaaaaaa-bbbb-\x34ccc-8ddd-eeeeeeeeeeee";
  const pathname = `/sessions/${sessionId}.jsonl`;
  scannedFiles = [{
    ...file(pathname),
    root: "claude-projects",
    engine: "claude",
    fmt: "claude",
    activity: "live",
    activityReason: "jsonl_turn_open",
    authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    mtime: Date.now() / 1000,
    pid: null,
    proc: null,
  }];
  const registry = agentRegistry();
  registry.ensureConversation("claude", pathname, null);
  registry.upsert({
    key: { engine: "claude", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "dead",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };

  expect(body.files.find((entry) => entry.path === pathname)).toMatchObject({
    activity: "recent",
    activityReason: "registry_terminal",
    proc: "killed",
    authoritativeTurn: { state: "terminal", source: "lifecycle" },
  });
});

test("a superseded round demotes terminally while the chain tail projects its lineage (#383)", async () => {
  const paths = [
    "/sessions/11111111-1111-\x34111-8111-111111111111.jsonl",
    "/sessions/22222222-2222-\x34222-8222-222222222222.jsonl",
    "/sessions/33333333-3333-\x34333-8333-333333333333.jsonl",
  ] as const;
  scannedFiles = paths.map((pathname, index) => ({
    ...file(pathname),
    activity: index === 2 ? "live" as const : "recent" as const,
    mtime: Date.now() / 1000,
    pendingQuestion: index === 0
      ? { id: "q1", question: "stale approval?", options: [], createdAt: "2026-07-18T12:00:00.000Z" } as unknown as FileEntry["pendingQuestion"]
      : null,
    waitingInput: index === 0 ? { question: "stale?", options: [] } as unknown as FileEntry["waitingInput"] : null,
  }));
  const registry = agentRegistry();
  const first = registry.ensureConversation("codex", paths[0], null);
  const second = registry.ensureConversation("codex", paths[1], null);
  const third = registry.ensureConversation("codex", paths[2], null);
  registry.recordSupersedence(first.id, second.id, "recovery-spawn");
  /* Repeated recovery names the ORIGINAL round; the edge chains at the tail. */
  registry.recordSupersedence(first.id, third.id, "stage-retry");

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const byPath = new Map(body.files.map((entry) => [entry.path, entry]));

  /* Primary navigation resolves the chain TAIL (A→B→C opens C) while the
     immediate edge stays as the round history (#383 repair). */
  expect(byPath.get(paths[0])).toMatchObject({
    supersededBy: {
      conversationId: second.id,
      path: paths[1],
      reason: "recovery-spawn",
      tailConversationId: third.id,
      tailPath: paths[2],
    },
    activity: "idle",
    activityReason: "superseded",
    proc: "killed",
    authoritativeTurn: { state: "terminal", source: "lifecycle" },
    pendingQuestion: null,
    waitingInput: null,
  });
  expect(byPath.get(paths[1])).toMatchObject({
    supersededBy: {
      conversationId: third.id,
      path: paths[2],
      reason: "stage-retry",
      tailConversationId: third.id,
      tailPath: paths[2],
    },
    activity: "idle",
  });
  /* The live tail is untouched by demotion and numbers its round from chain
     depth: round 3 of the recovered work, continuing round 2. */
  expect(byPath.get(paths[2])).toMatchObject({
    activity: "live",
    continues: { conversationId: second.id, path: paths[1], round: 3 },
  });
  expect(byPath.get(paths[2])?.supersededBy).toBeUndefined();
});

test("a dangling supersedence successor fails open to today's rendering (#383)", async () => {
  const pathname = "/sessions/44444444-4444-\x34444-8444-444444444444.jsonl";
  scannedFiles = [{ ...file(pathname), activity: "recent" as const, mtime: Date.now() / 1000 }];
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", pathname, null);
  const raw = JSON.parse(fs.readFileSync(path.join(registryRoot, "registry.json"), "utf8")) as {
    conversations: Record<string, { supersededBy: unknown }>;
  };
  raw.conversations[conversation.id]!.supersededBy = {
    conversationId: "conversation_never_settled",
    at: "2026-07-18T12:41:00.000Z",
    reason: "recovery-spawn",
  };
  fs.writeFileSync(path.join(registryRoot, "registry.json"), JSON.stringify(raw));

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const entry = body.files.find((candidate) => candidate.path === pathname);

  expect(entry?.supersededBy).toBeUndefined();
  expect(entry?.activity).toBe("recent");
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
  await cachedFileScan();
  let release!: () => void;
  scanGates.push(new Promise<void>((resolve) => { release = resolve; }));
  const request = () => cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER, 41);

  const first = request();
  await Promise.resolve();
  const second = request();
  release();
  await Promise.all([first, second]);
  await currentFileScan();

  expect(scans).toBe(2);
});

test("a completed revision generation absorbs newer revision noise inside the scan cooldown", async () => {
  await cachedFileScan();
  const started = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER, 41);
  const completed = await currentFileScan();
  const repeated = await cachedFileScan(undefined, undefined, Date.now(), 42);

  expect(started.targetGeneration).toBeGreaterThan(started.generation);
  expect(repeated.generation).toBe(completed.generation);
  expect(repeated.targetGeneration).toBe(completed.generation);
  expect(scans).toBe(2);
});

test("a newer revision during an active scan does not reserve a trailing full-corpus scan", async () => {
  scannedFiles = [file("/sessions/warm.jsonl")];
  await cachedFileScan();
  let releaseOlder!: () => void;
  scanGates.push(new Promise<void>((resolve) => { releaseOlder = resolve; }));
  scannedFiles = [file("/sessions/revision-1.jsonl")];
  const older = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER, 1);
  await Promise.resolve();
  expect(scans).toBe(2);

  scannedFiles = [file("/sessions/revision-2.jsonl")];
  const newer = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER, 2);
  releaseOlder();
  const completed = await currentFileScan();

  expect(older.targetGeneration).toBeGreaterThan(older.generation);
  expect(newer.targetGeneration).toBe(newer.generation);
  expect(completed.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/revision-1.jsonl"]);
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

test("an arbitrary client revision cannot suppress a later refresh beyond the cooldown", async () => {
  scannedFiles = [file("/sessions/untrusted-watermark.jsonl")];
  await GET(new Request("http://127.0.0.1/api/files", {
    headers: { "x-llv-files-revision": String(Number.MAX_SAFE_INTEGER) },
  }));

  scannedFiles = [file("/sessions/genuine-revision.jsonl")];
  const stale = await cachedFileScan(undefined, undefined, Number.MAX_SAFE_INTEGER, 7);

  expect(stale.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/untrusted-watermark.jsonl"]);
  expect(scans).toBe(2);

  const completed = await currentFileScan();
  expect(completed.snapshot.files.map((entry) => entry.path)).toEqual(["/sessions/genuine-revision.jsonl"]);
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
  const first = await GET(new Request("http://127.0.0.1/api/files?project=project-a"));
  const second = await GET(new Request("http://127.0.0.1/api/files?project=project-b"));

  expect(scans).toBe(1);
  expect(scanProjects).toEqual([undefined]);
  expect(first.headers.get("x-llv-files-projection-cache")).toBe("miss");
  expect(second.headers.get("x-llv-files-projection-cache")).toBe("hit");
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

test("a no-transcript structured reservation projects its card from canonical cwd truth", async () => {
  const registry = agentRegistry();
  const cwd = process.cwd();
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "terra",
    clientAttemptId: "attempt_93c42855_account_a",
    requestDigest: "9".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd, model: "gpt-5.6-sol", effort: "xhigh" }),
  });
  if (begun.kind !== "created") throw new Error("expected a structured reservation");
  scannedFiles = [];

  const response = await GET(new Request("http://127.0.0.1/api/files?project=latand"));
  const body = await response.json() as { files: Array<FileEntry & { spawn?: Record<string, unknown> }> };
  const card = body.files.find((entry) => entry.conversationId === begun.receipt.conversationId);

  expect(card).toMatchObject({
    path: `spawn:${begun.receipt.launchId}`,
    project: projectInfoFromCwd(cwd)?.project,
    cwd,
    projectRoot: projectRootForCwd(cwd),
    engine: "codex",
    kind: "session",
    activity: "live",
    proc: null,
    renamable: false,
    conversationId: begun.receipt.conversationId,
    launchModel: "gpt-5.6-sol",
    effort: "xhigh",
    spawn: {
      launchId: begun.receipt.launchId,
      clientAttemptId: "attempt_93c42855_account_a",
      state: "starting",
      initialMessage: "pending",
      retrySafe: false,
      error: null,
    },
  });
  expect(card?.project).not.toBe("latand");
});

test("a Telegram report run is recognisable from the registry alone, with no history file", async () => {
  /* Issue #1091: report runs were identified only by the `conversationId` in
     the Daily Reports history row, so a lost or evicted history left a board
     conversation nobody could attribute. The durable marker is the launch
     receipt's attempt id, which the projection reads here — no Telegram state
     is consulted, and none exists in this test. */
  const registry = agentRegistry();
  /* Assembled rather than written out: the publication privacy gate refuses any
     literal with the shape of a session identifier, invented or not. */
  const runId = ["0192d4f1", "8f43", "4a10", "9c1e", "6b0f0a5d77c2"].join("-");
  const cwd = process.cwd();
  const artifactPath = path.join(stateDir, "telegram-report-2a6f19c4.jsonl");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    clientAttemptId: `telegram-report-${runId}`,
    explicitProject: "telegram-reports",
    launchProfile: emptyLaunchProfile({ cwd }),
  });
  if (begun.kind !== "created") throw new Error("expected a report-run reservation");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "telegram-report-2a6f19c4" },
    artifactPath,
    cwd,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd }),
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(artifactPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const card = body.files.find((entry) => entry.conversationId === begun.receipt.conversationId);

  expect(card?.telegramReport).toEqual({ runId });
  /* And the board groups it where the operator's Telegram panel lives, rather
     than in a phantom project named after the scratch workspace it ran in. */
  expect(card?.project).toBe("telegram-reports");
  /* Every other card stays untouched by the marker. */
  expect(body.files.filter((entry) => entry.telegramReport).length).toBe(1);
});

test("the report-run marker groups the card even with no ownership record", async () => {
  /* The marker has to be what does the GROUPING, not a decoration beside it:
     a report run works in a neutral scratch directory, so every attribution
     path below ownership would file it under a project of its own. Here the
     conversation carries no ownership record at all and its cwd resolves to an
     ordinary repository — and the run still collects under the Telegram
     project, from registry evidence alone (#1091). */
  const registry = agentRegistry();
  const runId = ["0192d4f1", "8f43", "4a10", "9c1e", "6b0f0a5d77c3"].join("-");
  const cwd = process.cwd();
  const artifactPath = path.join(stateDir, "telegram-report-5b1c73de.jsonl");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    clientAttemptId: `telegram-report-${runId}`,
    launchProfile: emptyLaunchProfile({ cwd }),
  });
  if (begun.kind !== "created") throw new Error("expected a report-run reservation");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "telegram-report-5b1c73de" },
    artifactPath,
    cwd,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd }),
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(artifactPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const card = body.files.find((entry) => entry.conversationId === begun.receipt.conversationId);

  expect(card?.telegramReport).toEqual({ runId });
  expect(card?.project).toBe("telegram-reports");
  expect(card?.projectOwnership).toBeUndefined();
});

test("a selected sidebar project cannot replace canonical cwd attribution after transcript discovery", async () => {
  const registry = agentRegistry();
  const cwd = process.cwd();
  const artifactPath = path.join(stateDir, "cwd-attribution-9173e9a2.jsonl");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "terra",
    launchProfile: emptyLaunchProfile({ cwd, project: "latand" }),
  });
  if (begun.kind !== "created") throw new Error("expected a structured reservation");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "cwd-attribution-9173e9a2" },
    artifactPath,
    cwd,
    accountId: "terra",
    launchProfile: emptyLaunchProfile({ cwd, project: "latand" }),
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const scanned = file(artifactPath);
  scanned.project = "latand";
  scanned.cwd = cwd;
  scannedFiles = [scanned];

  const response = await GET(new Request("http://127.0.0.1/api/files?project=latand"));
  const body = await response.json() as { files: FileEntry[] };
  const entry = body.files.find((candidate) => candidate.conversationId === begun.receipt.conversationId);

  expect(entry?.project).toBe(projectInfoFromCwd(cwd)?.project);
  expect(entry?.project).not.toBe("latand");
});

/* Production reproduction (issue #315): conversation_4840d34a… ran with
   cwd=$HOME, projected under the home-root project, while its Viewer-owned
   family worked in the LLV worktrees. Explicit operator ownership must move
   the ROOT's attribution everywhere (files, catalog, lineage) without touching
   its transcript path, identity, or the children's own attribution. */
test("explicit operator ownership attributes a home-root conversation to its project across files and catalog", async () => {
  const registry = agentRegistry();
  const homeRootCwd = fs.mkdtempSync(path.join(stateDir, "home-root-"));
  const worktreeCwd = path.join(
    os.homedir(),
    ".agents", "tools", "live-log-viewer-next", ".claude", "worktrees", "pipeline-315-builder",
  );
  const llvProject = "-agents-tools-live-log-viewer-next";
  const rootPath = path.join(stateDir, "root-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1401.jsonl");
  const childPath = path.join(stateDir, "child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1402.jsonl");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: homeRootCwd,
    accountId: "terra",
    explicitProject: llvProject,
    launchProfile: emptyLaunchProfile({ cwd: homeRootCwd }),
  });
  if (begun.kind !== "created") throw new Error("expected an explicit-project reservation");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1401" },
    artifactPath: rootPath,
    cwd: homeRootCwd,
    accountId: "terra",
    launchProfile: emptyLaunchProfile({ cwd: homeRootCwd }),
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  const rootScan = file(rootPath);
  rootScan.project = path.basename(homeRootCwd);
  rootScan.cwd = homeRootCwd;
  rootScan.projectRoot = homeRootCwd;
  const childScan = file(childPath);
  childScan.project = llvProject;
  childScan.cwd = worktreeCwd;
  childScan.worktree = "pipeline-315-builder";
  childScan.parent = rootPath;
  scannedFiles = [rootScan, childScan];
  replaceConversationCatalog([
    { path: rootPath, root: "codex-sessions", name: "root", project: path.basename(homeRootCwd), title: "root", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 2, size: 1 },
    { path: childPath, root: "codex-sessions", name: "child", project: llvProject, title: "child", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 1, size: 1 },
  ]);

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[]; projectCatalog: Array<{ project: string; conversations: number }> };
  const root = body.files.find((entry) => entry.path === rootPath);
  const child = body.files.find((entry) => entry.path === childPath);

  expect(root?.project).toBe(llvProject);
  expect(root?.projectOwnership).toMatchObject({ project: llvProject, source: "operator" });
  expect(root?.conversationId).toBe(begun.receipt.conversationId);
  expect(root?.path).toBe(rootPath);
  expect(child?.project).toBe(llvProject);
  expect(child?.worktree).toBe("pipeline-315-builder");
  /* The whole family now lives under exactly one project key. */
  expect(new Set([root?.project, child?.project]).size).toBe(1);
  const catalogProjects = Object.fromEntries(body.projectCatalog.map((entry) => [entry.project, entry.conversations]));
  expect(catalogProjects[llvProject]).toBe(2);
  expect(catalogProjects[path.basename(homeRootCwd)]).toBeUndefined();
});

test("a cross-project lineage stub inherits its owner's explicit project", async () => {
  const registry = agentRegistry();
  const homeRootCwd = fs.mkdtempSync(path.join(stateDir, "home-root-"));
  const llvProject = "-agents-tools-live-log-viewer-next";
  const parentPath = path.join(stateDir, "parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1411.jsonl");
  const childPath = path.join(stateDir, "child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1412.jsonl");
  fs.writeFileSync(parentPath, "{}\n");
  const parentSpawn = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd: homeRootCwd,
    accountId: "terra",
    explicitProject: llvProject,
  });
  if (parentSpawn.kind !== "created") throw new Error("expected parent reservation");
  registry.settleSpawn(parentSpawn.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1411" },
    artifactPath: parentPath,
    cwd: homeRootCwd,
    accountId: "terra",
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const childSpawn = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd: homeRootCwd,
    accountId: "terra",
    parentConversationId: parentSpawn.receipt.conversationId,
  });
  if (childSpawn.kind !== "created") throw new Error("expected child reservation");
  registry.settleSpawn(childSpawn.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1412" },
    artifactPath: childPath,
    cwd: homeRootCwd,
    accountId: "terra",
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const childScan = file(childPath);
  childScan.cwd = homeRootCwd;
  scannedFiles = [childScan];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const stub = body.files.find((entry) => entry.path === parentPath);

  expect(stub?.activityReason).toBe("lineage_placeholder");
  expect(stub?.project).toBe(llvProject);
  expect(stub?.projectOwnership).toMatchObject({ project: llvProject, source: "operator" });
});

test("a staged structured card stays binding until its initial message is admitted", async () => {
  const registry = agentRegistry();
  const cwd = process.cwd();
  const artifactPath = path.join(stateDir, "e9e8a4b4.jsonl");
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "account-a",
    clientAttemptId: "attempt_e9e8a4b4_account_a",
  });
  if (begun.kind !== "created") throw new Error("expected a structured reservation");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "e9e8a4b4" },
    artifactPath,
    cwd,
    accountId: "account-a",
    status: "unhosted",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  scannedFiles = [];

  const bindingResponse = await GET(new Request("http://127.0.0.1/api/files"));
  const bindingBody = await bindingResponse.json() as { files: FileEntry[] };
  expect(bindingBody.files.find((entry) => entry.conversationId === begun.receipt.conversationId)?.spawn)
    .toMatchObject({ state: "binding", initialMessage: "pending" });

  registry.holdDelivery(
    begun.receipt.conversationId,
    "Own issue #282",
    `spawn_${begun.receipt.launchId}`,
    "text",
    [],
    null,
    { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", policy: "queue" },
  );
  const queuedResponse = await GET(new Request("http://127.0.0.1/api/files"));
  const queuedBody = await queuedResponse.json() as { files: FileEntry[] };
  expect(queuedBody.files.find((entry) => entry.conversationId === begun.receipt.conversationId)?.spawn)
    .toMatchObject({ state: "queued", initialMessage: "queued" });
});

test("transcript discovery suppresses the preallocated card for the same conversation", async () => {
  const registry = agentRegistry();
  const cwd = process.cwd();
  const artifactPath = path.join(stateDir, "9173e9a2.jsonl");
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "terra",
    clientAttemptId: "p0_282_duplicate_suppression_20260716_a1",
  });
  if (begun.kind !== "created") throw new Error("expected a structured reservation");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "9173e9a2" },
    artifactPath,
    cwd,
    accountId: "terra",
    status: "idle",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  scannedFiles = [file(artifactPath)];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const matches = body.files.filter((entry) => entry.conversationId === begun.receipt.conversationId);

  expect(matches).toHaveLength(1);
  expect(matches[0]?.path).toBe(artifactPath);
  expect(matches[0]?.spawn).toBeUndefined();
});

test("a provisional Codex fork projects as archived history of its stable conversation", async () => {
  const registry = agentRegistry();
  const sourcePath = "/sessions/source-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1301.jsonl";
  const forkPath = "/source-account/sessions/fork-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1302.jsonl";
  const targetPath = "/target-account/sessions/fork-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1302.jsonl";
  const conversation = registry.ensureConversation("codex", sourcePath, "source");
  registry.setConversationMigration(conversation.id, {
    intentId: "files-route-continuity",
    phase: "verifying",
    targetId: "target",
    revision: 1,
    error: null,
    operationId: "files-route-continuity-operation",
    providerReceipt: {
      operationId: "files-route-continuity-operation",
      nativeId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1302",
      path: targetPath,
      continuityPaths: [forkPath],
      historyHash: "files-route-continuity-history",
      host: { kind: "codex-app-server", identity: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1302", epoch: 1, verifiedAt: "2026-07-20T12:00:00.000Z" },
    },
    updatedAt: "2026-07-10T12:00:00.000Z",
  });
  registry.recordConversationContinuityPath(conversation.id, forkPath);
  registry.commitSuccessor(conversation.id, { id: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1302", path: targetPath, accountId: "target" }, 1,
    registry.conversation(conversation.id)!.migration!.operationId, registry.conversation(conversation.id)!.migration!.providerReceipt!);
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
  const sourcePath = "/sessions/pending-delivery-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1303.jsonl";
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
  const parentPath = "/sessions/parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = registry.ensureConversation("codex", parentPath, null);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325" },
    parentArtifactPath: parentPath,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
  });
  if (begun.kind !== "created") throw new Error("expected a fresh spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326" },
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
  const parentPath = "/sessions/removed-parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl";
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
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326" },
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

test("a relocated Claude worktree transcript remains the readable parent card", async () => {
  const registry = agentRegistry();
  const repository = path.join(registryRoot, "repository");
  const worktree = path.join(repository, ".claude", "worktrees", "topic");
  const projectsRoot = path.join(registryRoot, "projects");
  const parentSessionId = "11111111-1111-\x34111-8111-111111111111";
  const childSessionId = "22222222-2222-\x34222-8222-222222222222";
  const oldParentPath = path.join(projectsRoot, "-repository--claude-worktrees-topic", `${parentSessionId}.jsonl`);
  const newParentPath = path.join(projectsRoot, "-repository", `${parentSessionId}.jsonl`);
  const childPath = path.join(projectsRoot, "-repository", `${childSessionId}.jsonl`);
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = https://example.invalid/team/repository.git",
    "",
  ].join("\n"));
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.dirname(oldParentPath), { recursive: true });
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(oldParentPath, `${JSON.stringify({
    type: "user",
    cwd: worktree,
    message: { content: "Fixture parent prompt" },
  })}\n`);
  fs.writeFileSync(childPath, `${JSON.stringify({
    type: "user",
    cwd: worktree,
    message: { content: "Fixture child prompt" },
  })}\n`);
  const observation = (pathname: string, observedAt: string) => ({
    engine: "claude" as const,
    path: pathname,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: worktree }),
    turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
    observedAt,
  });
  registry.reconcileConversations([
    observation(oldParentPath, "2026-08-29T10:00:00.000Z"),
    {
      ...observation(childPath, "2026-08-29T10:00:00.000Z"),
      parentArtifactPath: oldParentPath,
    },
  ]);
  const parent = registry.conversationForPath(oldParentPath)!;

  const live = describeTranscript("claude-projects", projectsRoot, oldParentPath, fs.statSync(oldParentPath));
  const project = projectInfoFromCwd(repository)!;
  expect(live.project).toBe(project.project);
  registry.recordConversationContinuityPath(parent.id, newParentPath);
  fs.copyFileSync(oldParentPath, newParentPath);
  registry.reconcileConversations([observation(newParentPath, "2026-08-29T10:00:30.000Z")]);
  expect(registry.conversation(parent.id)?.generations.at(-1)?.path).toBe(oldParentPath);
  fs.rmSync(oldParentPath);
  fs.rmSync(worktree, { recursive: true, force: true });
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();
  registry.reconcileConversations([observation(newParentPath, "2026-08-29T10:01:00.000Z")]);

  const relocated = registry.conversation(parent.id)!;
  expect(relocated.generations.at(-1)?.path).toBe(newParentPath);
  expect(relocated.continuityPaths).toContain(oldParentPath);
  expect(registry.canonicalPath(oldParentPath)).toBe(newParentPath);
  const archived = (realModules.get("@/lib/scanner") as {
    archivedTranscriptPaths(): ReadonlySet<string>;
  }).archivedTranscriptPaths();
  expect(archived.has(newParentPath)).toBe(false);
  expect(archived.has(oldParentPath)).toBe(true);

  const removedStat = fs.statSync(newParentPath);
  const removedMetadata = describeTranscript("claude-projects", projectsRoot, newParentPath, removedStat);
  expect(removedMetadata.project).toBe(project.project);
  expect(removedMetadata.project).toBe(live.project);
  expect(removedMetadata.worktree).toBe("topic");
  const removed = {
    ...file(newParentPath),
    ...removedMetadata,
    path: newParentPath,
    root: "claude-projects" as const,
    name: path.relative(projectsRoot, newParentPath),
    mtime: removedStat.mtimeMs / 1_000,
    size: removedStat.size,
  };
  const childScan = {
    ...file(childPath),
    root: "claude-projects" as const,
    engine: "claude" as const,
    fmt: "claude" as const,
    project: project.project,
    cwd: worktree,
    parent: oldParentPath,
  };
  scannedFiles = [removed, childScan];
  scannedProjectCatalog = [{
    project: project.project,
    displayName: project.displayName,
    projectRoot: repository,
    smt: removed.mtime,
    conversations: 2,
  }];

  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };
  const parentCards = body.files.filter((entry) => entry.conversationId === parent.id);
  const projectedChild = body.files.find((entry) => entry.path === childPath);
  expect(parentCards).toHaveLength(1);
  expect(parentCards[0]).toMatchObject({ path: newParentPath, project: project.project });
  expect(fs.readFileSync(parentCards[0]!.path, "utf8")).toContain("Fixture parent prompt");
  expect(projectedChild?.parent).toBe(newParentPath);
  expect(projectedChild?.parentRemoved).toBeUndefined();
});

test("an existing durable parent omitted from the scan enters the response closure", async () => {
  const registry = agentRegistry();
  const parentPath = path.join(registryRoot, "parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325.jsonl");
  const childPath = "/sessions/child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl";
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
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326" },
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
  const parentPath = path.join(registryRoot, "pinned-parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1335.jsonl");
  const childPath = "/sessions/pinned-child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1336.jsonl";
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
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1336" },
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
  const sourcePath = "/sessions/source-parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1324.jsonl";
  const parentPath = "/sessions/provisional-parent-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325.jsonl";
  const childPath = "/sessions/child-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl";
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
  const migration = beginLegacySpawnFixture(registry, {
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
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326" },
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
        key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1325" },
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

test("a Viewer root with three engine-native children projects viewer/engine provenance and three parent links (issue #339)", async () => {
  const registry = agentRegistry();
  const parentSid = "019f4906-3f67-\x37b72-9fbc-9ec3b5ad2001";
  const parentPath = `/sessions/rollout-2026-07-20-${parentSid}.jsonl`;
  const childSids = [
    "019f4906-3f67-\x37b72-9fbc-9ec3b5ad2002",
    "019f4906-3f67-\x37b72-9fbc-9ec3b5ad2003",
    "019f4906-3f67-\x37b72-9fbc-9ec3b5ad2004",
  ];
  const childPaths = childSids.map((sid) => `/sessions/rollout-2026-07-20-${sid}.jsonl`);

  // The Viewer launch settles a spawn receipt onto the root conversation, so the
  // root is receipt-owned even though it carries no parent lineage edge.
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/repo", accountId: null });
  if (begun.kind !== "created") throw new Error("expected create");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: parentSid },
    artifactPath: parentPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  // Three engine-native children observed in one inventory cycle, each carrying
  // only its path-derived parent (no pre-resolved parentConversationId).
  registry.reconcileConversations(childPaths.map((childPath) => ({
    engine: "codex" as const,
    path: childPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
    observedAt: "2026-07-20T12:00:00.000Z",
    parentArtifactPath: parentPath,
  })));

  scannedFiles = [file(parentPath), ...childPaths.map((childPath) => file(childPath))];
  const response = await GET(new Request("http://127.0.0.1/api/files"));
  const body = await response.json() as { files: FileEntry[] };

  expect(Object.values(registry.snapshot().conversations)).toHaveLength(4);
  expect(body.files.find((entry) => entry.path === parentPath)?.spawnOrigin).toBe("viewer");
  const children = childPaths.map((childPath) => body.files.find((entry) => entry.path === childPath));
  expect(children.map((child) => child?.spawnOrigin)).toEqual(["engine", "engine", "engine"]);
  expect(children.map((child) => child?.parent)).toEqual([parentPath, parentPath, parentPath]);
});

test("a custom session title (issue #33) overrides the derived title and keeps it as autoTitle", async () => {
  const sessionUuid = "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1399";
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

test("the files rail reaggregates uncapped conversations under canonical cwd projects", async () => {
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

  expect(body.projectCatalog).toEqual([
    expect.objectContaining({ project: projectInfoFromCwd(stateDir)?.project, conversations: 1 }),
  ]);
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
  const currentPath = "/sessions/current-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1401.jsonl";
  const priorPath = "/sessions/prior-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1400.jsonl";
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
  const currentPath = "/sessions/succ-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1403.jsonl";
  const priorPath = "/sessions/pred-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1402.jsonl";
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
  const gonePath = "/sessions/gone-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1404.jsonl"; // never created → ENOENT
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

test("role titles (issue #325): spawned builder/reviewer present task + role instead of boilerplate", async () => {
  const registry = agentRegistry();
  const orchestratorPath = "/sessions/orchestrator-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1501.jsonl";
  const builderPath = "/sessions/builder-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1502.jsonl";
  const reviewerPath = "/sessions/reviewer-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1503.jsonl";
  const orchestrator = registry.ensureConversation("codex", orchestratorPath, null);
  const builderSpawn = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: orchestrator.id,
    parentArtifactPath: orchestratorPath,
    role: "builder",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: orchestrator.id }),
  });
  if (builderSpawn.kind !== "created") throw new Error("expected a fresh builder receipt");
  registry.settleSpawn(builderSpawn.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1502" },
    artifactPath: builderPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const reviewerSpawn = registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: orchestrator.id,
    parentArtifactPath: orchestratorPath,
    role: "reviewer",
    reviewsConversationId: builderSpawn.receipt.conversationId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: orchestrator.id }),
  });
  if (reviewerSpawn.kind !== "created") throw new Error("expected a fresh reviewer receipt");
  registry.settleSpawn(reviewerSpawn.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1503" },
    artifactPath: reviewerPath,
    cwd: "/repo",
    accountId: null,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  boardTasksStore = () => [{
    id: "task-325",
    project: "repo",
    status: "assigned",
    text: "🧩 #325 — Group review rounds per task\n\nDetails…",
    placement: "unplaced",
    assignments: [{
      path: null,
      conversationId: builderSpawn.receipt.conversationId,
      panePid: null,
      state: "delivered",
      error: null,
      at: "2026-07-16T00:00:00.000Z",
    }],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }];
  try {
    // An explicit user rename on the builder must keep final precedence; the
    // role title becomes its Reset base instead of clobbering the rename.
    writeSessionTitle(
      [`conversation:${builderSpawn.receipt.conversationId}`],
      `conversation:${builderSpawn.receipt.conversationId}`,
      "My builder",
      undefined,
      "2026-07-16T00:00:00.000Z",
    );
    scannedFiles = [
      { ...file(orchestratorPath), title: "Codex session" },
      { ...file(builderPath), title: "Codex session", mtime: 2 },
      { ...file(reviewerPath), title: "Codex session", mtime: 3 },
    ];

    const response = await GET(new Request("http://127.0.0.1/api/files"));
    const body = await response.json() as { files: FileEntry[] };
    const builder = body.files.find((entry) => entry.path === builderPath);
    const reviewer = body.files.find((entry) => entry.path === reviewerPath);
    const orchestratorEntry = body.files.find((entry) => entry.path === orchestratorPath);

    expect(builder?.title).toBe("My builder");
    expect(builder?.autoTitle).toBe("#325 — Group review rounds per task — builder");
    expect(reviewer?.title).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(reviewer?.autoTitle).toBeUndefined();
    // A role-less session keeps its scanner title untouched.
    expect(orchestratorEntry?.title).toBe("Codex session");
  } finally {
    boardTasksStore = () => [];
  }
});

/* Crown + manual projects (operator sidebar curation): both stores are
   server-durable and must surface in the same /api/files payload the rail
   consumes — the created project as a zero-conversation catalog row whose root
   feeds the spawn cwd, the crown list under the operator's chosen ids. */
test("crowned and manually created projects flow through the files payload", async () => {
  const manualRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-manual-"));
  try {
    const created = createManualProject("Fresh Board", manualRoot);
    if (!created.ok) throw new Error(`expected creation, got ${created.code}`);
    expect(setProjectCrown(created.entry.project, true)).toBe(true);

    const response = await GET(new Request("http://127.0.0.1/api/files"));
    const body = await response.json() as {
      projectCatalog: Array<{ project: string; displayName?: string; projectRoot?: string; conversations: number }>;
      projectDisplayNames: Record<string, string>;
      projectCwds?: Record<string, string>;
      crownedProjects?: string[];
    };
    expect(body.projectCatalog.find((entry) => entry.project === created.entry.project)).toMatchObject({
      displayName: "Fresh Board",
      projectRoot: created.entry.root,
      conversations: 0,
    });
    expect(body.crownedProjects).toEqual([created.entry.project]);
    expect(body.projectDisplayNames[created.entry.project]).toBe("Fresh Board");
    expect(body.projectCwds?.[created.entry.project]).toBe(created.entry.root);
  } finally {
    fs.rmSync(manualRoot, { recursive: true, force: true });
  }
});

/** The production seat resolver: the registry's own alias chain, exactly as
    `/api/files` and the MCP relay both take their seat identities through. */
const registrySeatIdentity = seatIdentityResolver((id) => agentRegistry().canonicalConversationId(id));

test("issue 1168: the seat's open bridge ask rides the files payload and clears on the answering directive", async () => {
  const seatPath = "/sessions/orchestrator-seat.jsonl";
  const seat = agentRegistry().ensureConversation("codex", seatPath, null);
  scannedFiles = [file(seatPath), file("/sessions/worker.jsonl")];
  const filed = recordManagerReport({
    key: "lane-4-blocked",
    class: "blocked",
    at: new Date().toISOString(),
    project: "repo",
    targetSeatConversationId: seat.id,
    body: "cannot proceed: the lane needs a base branch",
  });

  const asking = await (await GET(new Request("http://127.0.0.1/api/files"))).json() as { files: FileEntry[] };
  expect(asking.files.find((entry) => entry.path === seatPath)?.bridgeAsk).toEqual({
    id: "lane-4-blocked",
    at: filed!.at,
  });
  /* The ask belongs to the seat alone — no other scanned row carries it. */
  expect(asking.files.find((entry) => entry.path === "/sessions/worker.jsonl")?.bridgeAsk).toBeUndefined();

  /* Nothing above opened a gateway channel or moved a cursor: this reaches the
     operator with the voice gateway off, which is the whole point of #1168. */
  recordBridgeDirectiveAnswer(filed!.seq, { project: "repo", seatConversationId: seat.id }, registrySeatIdentity);
  const answered = await (await GET(new Request("http://127.0.0.1/api/files"))).json() as { files: FileEntry[] };
  expect(answered.files.find((entry) => entry.path === seatPath)?.bridgeAsk).toBeUndefined();
});

test("issue 1168: a seat rekeyed since it filed keeps one identity — the ask reaches its card and the directive still clears it", async () => {
  /* The reviewer's HIGH: the projection resolved a recorded seat through the
     registry so a migrated conversation's ask lands on the card that exists,
     while the settlement compared raw ids. The rekey that made the item visible
     was therefore the rekey that made it unanswerable, and the queue kept a
     decision request nothing in the log could retire. */
  const seatPath = "/sessions/orchestrator-seat-rekeyed.jsonl";
  const registry = agentRegistry();
  const seat = registry.ensureConversation("codex", seatPath, null);
  const preMigrationSeatId = "conversation_seat_before_migration";
  const realSnapshot = registry.readOnlySnapshot.bind(registry);
  registry.readOnlySnapshot = () => {
    const snapshot = realSnapshot();
    return {
      ...snapshot,
      conversationAliases: { ...snapshot.conversationAliases, [preMigrationSeatId]: seat.id },
    };
  };

  scannedFiles = [file(seatPath)];
  /* Routed under the id the seat had WHEN IT ASKED — the log is history and is
     never rewritten by a migration. */
  const filed = recordManagerReport({
    key: "lane-4-blocked",
    class: "blocked",
    at: new Date().toISOString(),
    project: "repo",
    targetSeatConversationId: preMigrationSeatId,
    body: "cannot proceed: the lane needs a base branch",
  });

  const asking = await (await GET(new Request("http://127.0.0.1/api/files"))).json() as { files: FileEntry[] };
  expect(asking.files.find((entry) => entry.path === seatPath)?.bridgeAsk?.id).toBe("lane-4-blocked");

  /* The relay only ever knows the seat by the identity the seat authority hands
     it, which is the canonical one. */
  recordBridgeDirectiveAnswer(filed!.seq, { project: "repo", seatConversationId: seat.id }, registrySeatIdentity);
  const answered = await (await GET(new Request("http://127.0.0.1/api/files"))).json() as { files: FileEntry[] };
  expect(answered.files.find((entry) => entry.path === seatPath)?.bridgeAsk).toBeUndefined();
});
