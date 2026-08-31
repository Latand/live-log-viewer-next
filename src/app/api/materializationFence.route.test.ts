import { afterAll, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { FileEntry } from "@/lib/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-materialization-fence-"));
const stateDir = path.join(sandbox, "state");
const codexHome = path.join(sandbox, "codex");
const cwd = path.join(sandbox, "worktree");
const binary = path.join(sandbox, "codex-fixture");
const previous = {
  stateDir: process.env.LLV_STATE_DIR,
  codexHome: process.env.LLV_CODEX_HOME,
  claudeHome: process.env.LLV_CLAUDE_HOME,
  codexBinary: process.env.LLV_CODEX_BINARY,
};

process.env.LLV_STATE_DIR = stateDir;
process.env.LLV_CODEX_HOME = codexHome;
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_BINARY = binary;
fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(binary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
fs.chmodSync(binary, 0o755);

const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { AgentRegistry, identityMaterializationFence, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const realScanCache = await import("@/lib/scanner/scanCache");
let scannedFiles: FileEntry[] = [];
mock.module("@/lib/scanner/scanCache", () => ({
  ...realScanCache,
  cachedFileScan: async () => ({ snapshot: { files: scannedFiles, projectCatalog: [], complete: true } }),
}));
const { GET: getSession } = await import("@/app/api/session/route");
const { GET: getAttachCommand } = await import("@/app/api/attach-command/route");

const registryFilename = path.join(stateDir, "registry.json");
const registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
setAgentRegistryForTests(registry);

afterAll(() => {
  setAgentRegistryForTests(null);
  mock.module("@/lib/scanner/scanCache", () => realScanCache);
  for (const [key, value] of [
    ["LLV_STATE_DIR", previous.stateDir],
    ["LLV_CODEX_HOME", previous.codexHome],
    ["LLV_CLAUDE_HOME", previous.claudeHome],
    ["LLV_CODEX_BINARY", previous.codexBinary],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function request(url: string): NextRequest {
  return new NextRequest(url, {
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
    },
  });
}

test("structured identity becomes externally resolvable only after readable finalization (#1329)", async () => {
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    `rollout-2026-08-31T00-00-00-${sessionId}.jsonl`,
  );
  const launchProfile = emptyLaunchProfile({ cwd, title: "Verify materialization fence" });
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "default",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "default",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:fixture",
      process: { pid: process.pid, startIdentity: "fixture-process" },
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:fixture",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");

  const stagedSessionUrls = [
    `http://127.0.0.1:8898/api/session?conversationId=${encodeURIComponent(begun.receipt.conversationId)}`,
    `http://127.0.0.1:8898/api/session?path=${encodeURIComponent(artifactPath)}`,
  ];
  for (const url of stagedSessionUrls) {
    const response = await getSession(request(url));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not available") });
  }

  const stagedAttachUrls = [
    `http://127.0.0.1:8898/api/attach-command?path=${encodeURIComponent(artifactPath)}`,
    `http://127.0.0.1:8898/api/attach-command?path=${encodeURIComponent(`spawn:${begun.receipt.launchId}`)}`,
  ];
  for (const url of stagedAttachUrls) {
    const response = await getAttachCommand(request(url));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not available") });
  }

  const persisted = JSON.parse(fs.readFileSync(registryFilename, "utf8")) as {
    receipts: Record<string, { transport: string | null }>;
  };
  persisted.receipts[begun.receipt.launchId]!.transport = null;
  fs.writeFileSync(registryFilename, JSON.stringify(persisted));
  const legacyRegistry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(legacyRegistry);
  try {
    const response = await getAttachCommand(request(stagedAttachUrls[1]!));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not available") });
  } finally {
    setAgentRegistryForTests(registry);
  }

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Verify the completed session" } }),
  ].join("\n") + "\n");
  const finalized = registry.finalizeStructuredSpawn(begun.receipt.launchId);
  if (finalized.kind !== "settled") throw new Error("spawn finalization failed");
  scannedFiles = [{
    path: artifactPath,
    root: "codex-sessions",
    name: path.basename(artifactPath),
    project: "fixture-project",
    title: "Materialized session",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: fs.statSync(artifactPath).mtimeMs / 1_000,
    size: fs.statSync(artifactPath).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    effort: null,
    pendingQuestion: null,
    waitingInput: null,
    cwd,
  } as FileEntry];

  for (const url of stagedSessionUrls) {
    const response = await getSession(request(url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: artifactPath,
      messages: [expect.objectContaining({ text: "Verify the completed session" })],
    });
  }
  for (const url of stagedAttachUrls) {
    const response = await getAttachCommand(request(url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ engine: "codex", cwd });
  }
});

test("failure cleanup keeps a transport-null structured identity private by conversation, path, and launch (#1329)", async () => {
  scannedFiles = [];
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    `rollout-2026-08-31T01-00-00-${sessionId}.jsonl`,
  );
  const launchProfile = emptyLaunchProfile({ cwd, title: "Verify failed materialization fence" });
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "default",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "default",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:failure-fixture",
      process: { pid: process.pid, startIdentity: "failure-fixture-process" },
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:failure-fixture",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");

  const persisted = JSON.parse(fs.readFileSync(registryFilename, "utf8")) as {
    receipts: Record<string, { transport: string | null }>;
  };
  persisted.receipts[begun.receipt.launchId]!.transport = null;
  fs.writeFileSync(registryFilename, JSON.stringify(persisted));
  const cleanupRegistry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
  expect(cleanupRegistry.failStructuredSpawn(begun.receipt.launchId, "transcript did not materialize")).toMatchObject({
    claimed: true,
    receipt: { state: "failed", transport: null },
  });

  const snapshot = cleanupRegistry.readOnlySnapshot();
  const receipt = snapshot.receipts[begun.receipt.launchId]!;
  const entry = snapshot.entries[`codex:${sessionId}`]!;
  expect(entry).toMatchObject({
    structuredHost: null,
    structuredHostOperationId: begun.receipt.launchId,
  });
  const fence = identityMaterializationFence(snapshot);
  expect(fence.allowsReceipt(receipt)).toBeFalse();
  expect(fence.allowsPath(artifactPath)).toBeFalse();
  expect(fence.pathForConversation(begun.receipt.conversationId)).toBeNull();

  setAgentRegistryForTests(cleanupRegistry);
  try {
    const urls = [
      `http://127.0.0.1:8898/api/session?conversationId=${encodeURIComponent(begun.receipt.conversationId)}`,
      `http://127.0.0.1:8898/api/session?path=${encodeURIComponent(artifactPath)}`,
      `http://127.0.0.1:8898/api/attach-command?path=${encodeURIComponent(artifactPath)}`,
      `http://127.0.0.1:8898/api/attach-command?path=${encodeURIComponent(`spawn:${begun.receipt.launchId}`)}`,
    ];
    for (const [index, url] of urls.entries()) {
      const response = index < 2
        ? await getSession(request(url))
        : await getAttachCommand(request(url));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ error: expect.stringContaining("not available") });
      if (index === 3) expect(body).not.toHaveProperty("command");
    }
  } finally {
    setAgentRegistryForTests(registry);
  }
});
