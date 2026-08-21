import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "../agent/registry";
import { archivedTranscriptPaths, hostedTranscriptPaths, pinnedPathsFor } from "./index";

afterEach(() => setAgentRegistryForTests(null));

async function withEnvironment(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const previous = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A state dir holding a registry whose account home symlinks into the shared
    transcript store, so one physical transcript has two absolute forms. */
async function sharedStoreFixture(prefix: string): Promise<{
  base: string;
  registryFile: string;
  environment: Record<string, string>;
  accountForm: (name: string) => string;
  sharedForm: (name: string) => string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  const shared = path.join(base, "shared", "claude", "projects", "-repo");
  const accountHome = path.join(base, "account-home");
  await mkdir(shared, { recursive: true });
  await mkdir(accountHome, { recursive: true });
  fs.symlinkSync(path.join(base, "shared", "claude", "projects"), path.join(accountHome, "projects"));
  await mkdir(path.join(base, "state"), { recursive: true });
  return {
    base,
    registryFile: path.join(base, "state", "agent-registry.json"),
    environment: { LLV_STATE_DIR: path.join(base, "state"), LLV_CLAUDE_HOME: accountHome },
    accountForm: (name) => path.join(accountHome, "projects", "-repo", name),
    sharedForm: (name) => path.join(shared, name),
  };
}

test("a live transcript reached through a symlinked account home is not its own archived predecessor", async () => {
  const fixture = await sharedStoreFixture("llv-registry-demotion-shared-");
  try {
    await writeFile(fixture.sharedForm("live.jsonl"), "{}\n");
    await writeFile(fixture.sharedForm("predecessor.jsonl"), "{}\n");
    await withEnvironment(fixture.environment, async (): Promise<void> => {
      const store = new AgentRegistry(fixture.registryFile);
      const conversation = store.ensureConversation("claude", fixture.accountForm("live.jsonl"), "default");
      const snapshot = store.snapshot();
      /* The registry recorded the current generation through the account home
         while discovery walks the shared store, and the same physical file is
         also listed as a continuity path in the shared form. */
      snapshot.conversations[conversation.id]!.continuityPaths = [
        fixture.sharedForm("live.jsonl"),
        fixture.sharedForm("predecessor.jsonl"),
      ];
      await writeFile(fixture.registryFile, JSON.stringify(snapshot));
      setAgentRegistryForTests(new AgentRegistry(fixture.registryFile));

      const archived = archivedTranscriptPaths();
      /* The live transcript keeps its cap slot; a genuinely different
         predecessor still demotes below current transcripts. */
      expect(archived.has(fixture.sharedForm("live.jsonl"))).toBe(false);
      expect(archived.has(fixture.sharedForm("predecessor.jsonl"))).toBe(true);
    });
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("hosted transcripts report the paths a running host owns", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-hosted-transcripts-"));
  try {
    const file = path.join(base, "agent-registry.json");
    const snapshot = new AgentRegistry(file).snapshot();
    for (const [sessionId, status] of [["live-session", "live"], ["dead-session", "dead"]] as const) {
      snapshot.entries[`codex:${sessionId}`] = {
        key: { engine: "codex", sessionId },
        artifactPath: `/repo/${status}.jsonl`,
        cwd: "/repo",
        accountId: null,
        status,
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
        updatedAt: new Date(0).toISOString(),
        structuredHost: null,
      };
    }
    await writeFile(file, JSON.stringify(snapshot));
    setAgentRegistryForTests(new AgentRegistry(file));

    const hosted = hostedTranscriptPaths();
    expect(hosted.has("/repo/live.jsonl")).toBe(true);
    expect(hosted.has("/repo/dead.jsonl")).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unreadable registry reports no hosted transcripts", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-hosted-corrupt-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(hostedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a corrupt agent registry yields an empty demotion set and discovery stays available", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unsupported registry schema also degrades to no demotion", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-schema-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 999 }));
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a conversation-id pin resolves to its current generation path", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-${process.pid}`, "agent-registry.json"));
  const conversation = store.ensureConversation("codex", "/repo/current.jsonl", "default");
  setAgentRegistryForTests(store);
  expect(pinnedPathsFor(conversation.id)).toEqual(new Set(["/repo/current.jsonl"]));
  expect(pinnedPathsFor([conversation.id, "/plain/path.jsonl"])).toEqual(new Set(["/repo/current.jsonl", "/plain/path.jsonl"]));
  /* Paths outside the registry pass through; unknown ids leave the scan unpinned. */
  expect(pinnedPathsFor("/plain/path.jsonl")).toEqual(new Set(["/plain/path.jsonl"]));
  expect(pinnedPathsFor("conversation_unknown")).toEqual(new Set());
});

test("an archived path pin brings its current generation along", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-arch-${process.pid}`, "agent-registry.json"));
  const conversation = store.ensureConversation("codex", "/repo/old.jsonl", "default");
  setAgentRegistryForTests(store);
  const snapshot = store.snapshot();
  expect(snapshot.conversations[conversation.id]?.generations.at(-1)?.path).toBe("/repo/old.jsonl");
  /* Same conversation with the generation advanced: the pin must ship both
     the requested predecessor and the successor the link redirects to. */
  const pins = pinnedPathsFor("/repo/old.jsonl");
  expect(pins.has("/repo/old.jsonl")).toBe(true);
});

test("a member pin restores the complete durable lineage family", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-lineage-${process.pid}`, "agent-registry.json"));
  const implementer = store.ensureConversation("codex", "/repo/implementer.jsonl", "default");
  const reviewer = store.ensureConversation("codex", "/repo/reviewer.jsonl", "default");
  const child = store.ensureConversation("codex", "/repo/reviewer-child.jsonl", "default");
  const snapshot = store.snapshot();
  snapshot.lineageEdges[reviewer.id] = {
    childConversationId: reviewer.id,
    parentConversationId: implementer.id,
    childSessionKey: null,
    parentSessionKey: null,
    childArtifactPath: "/repo/reviewer.jsonl",
    parentArtifactPath: "/repo/implementer.jsonl",
    kind: "review",
    role: "reviewer",
    reviewsConversationId: implementer.id,
    source: "viewer-spawn",
    evidence: { launchId: null, clientAttemptId: null },
    createdAt: "now",
  };
  snapshot.lineageEdges[child.id] = {
    ...snapshot.lineageEdges[reviewer.id]!,
    childConversationId: child.id,
    parentConversationId: reviewer.id,
    childArtifactPath: "/repo/reviewer-child.jsonl",
    parentArtifactPath: "/repo/reviewer.jsonl",
    kind: "spawn",
    role: null,
    reviewsConversationId: null,
  };
  fs.mkdirSync(path.dirname(store.filename), { recursive: true });
  fs.writeFileSync(store.filename, JSON.stringify(snapshot));
  setAgentRegistryForTests(store);

  expect(pinnedPathsFor(reviewer.id)).toEqual(new Set([
    "/repo/reviewer.jsonl",
    "/repo/implementer.jsonl",
    "/repo/reviewer-child.jsonl",
  ]));
});

test("an unreadable registry keeps a path pin and drops an id pin", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-pin-corrupt-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(pinnedPathsFor("conversation_x")).toEqual(new Set());
    expect(pinnedPathsFor("/some/path.jsonl")).toEqual(new Set(["/some/path.jsonl"]));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
