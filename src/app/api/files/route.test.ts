import { expect, mock, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { agentRegistry } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

let scans = 0;
let scanOptions: unknown;
let scannedFiles: FileEntry[] = [];

mock.module("@/lib/scanner", () => ({
  listFiles: async () => [],
  listFilesWithProjectCatalog: async (_project: string | undefined, options: unknown) => {
    scans += 1;
    scanOptions = options;
    return { files: scannedFiles, projectCatalog: [] };
  },
}));
mock.module("@/lib/flows/store", () => ({ loadFlows: () => [] }));
mock.module("@/lib/tasks/store", () => ({
  loadTasks: () => [],
  mutateTasks: () => { throw new Error("files route attempted a task mutation"); },
}));
mock.module("@/lib/workflows/store", () => ({ loadWorkflows: () => [] }));
mock.module("@/lib/workflows/visibility", () => ({ filterWorkflowsForFileScan: () => [] }));

const { GET } = await import("./route");

test("repeated files reads execute only pure read ports and retain ETag behavior", async () => {
  scans = 0;
  scannedFiles = [];
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  const second = await GET(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ files: [], projectCatalog: [], flows: [], workflows: [], tasks: [] });
  expect(second.status).toBe(304);
  expect(scans).toBe(2);
  expect(scanOptions).toEqual({ persist: false });
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
