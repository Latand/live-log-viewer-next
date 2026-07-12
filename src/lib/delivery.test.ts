import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation, type RegistryFile, type TmuxHostEvidence } from "./agent/registry";
import { emptyLaunchProfile } from "./accounts/migration/contracts";
import { drainHeldDeliveries } from "./accounts/migration/coordinator";
import { cleanupFailedImageDelivery, deliverConversationMessage, killConversation, migrationDeliveryOutcome, reconfigureConversation, type DeliveryFailure } from "./delivery";
import type { FileEntry } from "./types";
import { TmuxDeliveryUncertainError } from "./tmux";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-test-"));
const failure: DeliveryFailure = { ok: false, outcome: "failed", error: "resume unavailable", status: 503 };

function inboxImage(name: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, "image");
  return pathname;
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => setAgentRegistryForTests(null));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("removes a direct-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("direct.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("removes a relayed-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("relay.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("retains an inbox image when transcript-host actuation became ambiguous", () => {
  const imagePath = inboxImage("ambiguous-host.png");
  const ambiguous: DeliveryFailure = { ...failure, actuation: "started" };

  expect(cleanupFailedImageDelivery(ambiguous, [imagePath])).toEqual(ambiguous);
  expect(fs.existsSync(imagePath)).toBe(true);
});

test("migration delivery keeps an internally held result recoverable", () => {
  expect(migrationDeliveryOutcome({ ok: true, target: "conversation_held", outcome: "held" })).toBe("held");
  expect(migrationDeliveryOutcome({ ok: true, target: "pane" })).toBe("delivered");
  expect(migrationDeliveryOutcome(failure)).toBe("failed");
  expect(migrationDeliveryOutcome({ ...failure, actuation: "started" as const })).toBe("delivery-uncertain");
});

test("idle reconfiguration survives a transient host miss and resumes after verified termination", async () => {
  const sessionId = "019f4e76-66b4-7f87-94b2-cfa9bf733333";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "reconfigure-registry.json"));
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key, artifactPath: pathname, cwd: SANDBOX, accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, role: "worker", readOnly: true, permissionMode: "never" }), status: "idle",
    host: KILL_HOST, claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "worker",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0, activity: "idle",
    proc: "running", pid: KILL_HOST.agent.pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  let resumed = 0;
  let killed = false;
  let resumePolicy: { readOnly?: boolean | null; permissionMode?: string | null } = {};

  const outcome = await reconfigureConversation(pathname, { model: "gpt-5.6-terra", effort: "medium", fast: true }, {
    pathAllowed: () => true,
    listFiles: async () => [entry],
    resumeSpecFor: (_root, _path, options) => {
      resumePolicy = options ?? {};
      return { command: "codex resume", cwd: SANDBOX, windowName: "codex-resume", engine: "codex" };
    },
    livePaneHost: async () => null,
    registry,
    paneScreen: async () => "›\n? for shortcuts",
    killHost: async () => { killed = true; return true; },
    deliver: async () => registry.withOperationLock(key, { pid: process.pid, startIdentity: null }, async () => {
      resumed += 1;
      return killed
        ? { ok: true, outcome: "resumed", target: "%8" }
        : { ok: true, outcome: "delivered-to-live", target: KILL_HOST.paneId };
    }),
  });

  expect(outcome).toMatchObject({ ok: true, outcome: "reconfigured", target: "%8" });
  expect(resumed).toBe(1);
  expect(killed).toBe(true);
  expect(resumePolicy).toMatchObject({ readOnly: true, permissionMode: "never" });
});

const KILL_HOST: TmuxHostEvidence = {
  kind: "tmux",
  endpoint: "/run/user/1000/agent-log-viewer",
  server: { pid: 900, startIdentity: "900:one" },
  paneId: "%7",
  panePid: { pid: 107, startIdentity: "107:one" },
  windowName: "worker",
  agent: { pid: 207, startIdentity: "207:one" },
  argv: ["codex", "resume", "session"],
};

function killSnapshot(pathname: string, host: TmuxHostEvidence | null): RegistryFile {
  const registry = new AgentRegistry(path.join(SANDBOX, "kill-registry.json"));
  registry.upsert({
    key: { engine: "codex", sessionId: "019f4e76-66b4-7f87-94b2-cfa9bf711111" },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "worker" }),
    status: "idle",
    host,
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  return registry.snapshot();
}

test("conversation kill resolves the registry pane id and reports verified success", async () => {
  const pathname = "/transcripts/worker.jsonl";
  const killed: string[] = [];

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, KILL_HOST),
    killHost: async (host) => { killed.push(host.paneId); return true; },
  });

  expect(outcome).toEqual({ ok: true, target: "%7" });
  expect(killed).toEqual(["%7"]);
});

test("conversation kill fails clearly when the registry has no pane", async () => {
  const pathname = "/transcripts/missing.jsonl";

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, null),
  });

  expect(outcome).toEqual({ ok: false, outcome: "failed", error: "no registered agent pane for this conversation", status: 404 });
});

test("conversation kill rejects success when process-death verification fails", async () => {
  const pathname = "/transcripts/stubborn.jsonl";

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, KILL_HOST),
    killHost: async () => false,
  });

  expect(outcome).toEqual({ ok: false, outcome: "failed", error: "the registered pane changed or its process did not exit", status: 409 });
});

test("conversation kill refreshes the registry host inside the session lock", async () => {
  const pathname = "/transcripts/racing.jsonl";
  const oldSnapshot = killSnapshot(pathname, KILL_HOST);
  const replacement: TmuxHostEvidence = {
    ...KILL_HOST,
    paneId: "%8",
    panePid: { pid: 108, startIdentity: "108:one" },
    agent: { pid: 208, startIdentity: "208:one" },
  };
  const freshSnapshot = structuredClone(oldSnapshot);
  freshSnapshot.entries["codex:019f4e76-66b4-7f87-94b2-cfa9bf711111"]!.host = replacement;
  let snapshots = 0;
  const killed: string[] = [];
  const unhosted: string[] = [];
  const registry = {
    snapshot: () => snapshots++ === 0 ? oldSnapshot : freshSnapshot,
    withOperationLock: async (_key: unknown, _owner: unknown, task: () => Promise<unknown>) => task(),
    markUnhosted: (key: { sessionId: string }) => { unhosted.push(key.sessionId); },
  };

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => oldSnapshot,
    registry: registry as never,
    killHost: async (host) => { killed.push(host.paneId); return true; },
  });

  expect(outcome).toEqual({ ok: true, target: "%8" });
  expect(killed).toEqual(["%8"]);
  expect(unhosted).toHaveLength(1);
});

test("conversation kill preserves replacement ownership with matching process fields", async () => {
  const pathname = "/transcripts/owned-before-kill.jsonl";
  const replacementPath = "/transcripts/replacement-owner.jsonl";
  const registry = new AgentRegistry(path.join(SANDBOX, "kill-replacement-registry.json"));
  const key = { engine: "codex" as const, sessionId: "019f4e76-66b4-7f87-94b2-cfa9bf722222" };
  registry.upsert({
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "worker" }),
    status: "idle",
    host: KILL_HOST,
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const replacement: TmuxHostEvidence = {
    ...KILL_HOST,
    endpoint: "/run/user/1000/replacement-tmux",
    windowName: "replacement-worker",
    argv: ["codex", "exec", "replacement"],
  };

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registry,
    killHost: async () => {
      const entry = registry.snapshot().entries[`codex:${key.sessionId}`]!;
      registry.upsert({ ...entry, artifactPath: replacementPath, host: replacement, status: "live" });
      return true;
    },
  });

  expect(outcome).toEqual({ ok: true, target: "%7" });
  expect(registry.snapshot().entries[`codex:${key.sessionId}`]).toMatchObject({
    artifactPath: replacementPath,
    status: "live",
    host: replacement,
  });
});

test("image-only reservations stay request-local and never drain without the client payload", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-reservation-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-only.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const queued = registry.holdDelivery(conversation.id, "", "image-only", "ephemeral-images");
  expect(queued).toMatchObject({ state: "assigned", text: "", payloadKind: "ephemeral-images" });
  let delivered = 0;

  await drainHeldDeliveries(conversation.id, { async deliver() { delivered += 1; return "delivered"; } }, registry);

  expect(delivered).toBe(0);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([
    { state: "failed", text: "", payloadKind: "ephemeral-images", error: "request-local delivery requires client retry" },
  ]);
});

test("large text uses a request-local reservation and still reaches ordinary delivery", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "large-text-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const text = "x".repeat(32_001);
  let delivered = "";
  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text, images: [], clientMessageId: "large-text",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async (_target, payload) => { delivered = payload; },
  });

  expect(outcome.ok).toBe(true);
  expect(delivered).toBe(text);
  expect(registry.holdDelivery(conversation.id, "", "large-text", "ephemeral-text")).toMatchObject({ state: "delivered", text: "" });
});

test("ordinary delivery on the active account skips the lazy-migration registry write", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "active-account-registry.json"));
  setAgentRegistryForTests(registry);
  registry.setEngineRouting("codex", "default");
  const conversation = registry.ensureConversation("codex", "", "default");
  registry.requestConversationMigrationToActiveAccount = (() => {
    throw new Error("active account should skip migration mutation");
  }) as typeof registry.requestConversationMigrationToActiveAccount;

  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "fast path", images: [], clientMessageId: "fast-path",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => {},
  });

  expect(outcome.ok).toBe(true);
});

test("delivered reservations retain only a bounded idempotency window", () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "delivery-tombstones-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/bounded-delivery.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const generationId = conversation.generations.at(-1)!.id;
  for (let index = 0; index < 105; index += 1) {
    const queued = registry.holdDelivery(conversation.id, `message body ${index}`, `message-${index}`);
    registry.beginDeliveryAttempt(queued.id, generationId);
    registry.recordDeliveryOutcome(queued.id, "delivered");
  }

  const tombstones = Object.values(registry.snapshot().heldDeliveries);
  expect(tombstones).toHaveLength(100);
  expect(tombstones.every((delivery) => delivery.state === "delivered" && delivery.text === "")).toBe(true);
  expect(registry.holdDelivery(conversation.id, "replayed body", "message-104")).toMatchObject({ state: "delivered", text: "" });
});

test("an image-only migration race stays recoverable without an orphan reservation", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-race-registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-race.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex", targetId: "default", origin: "manual", requestId: "image-race",
    expectedRevision: registry.engineRouting("codex").revision, scope: "all",
  });
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "",
    images: [{ base64: "aW1hZ2U=", mime: "image/png" }],
    clientMessageId: "image-race-message",
  });

  expect(outcome).toMatchObject({ ok: false, status: 409 });
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
  expect(fs.readdirSync(SANDBOX).some((name) => name.endsWith(".png"))).toBe(false);
});

test("pre-actuation payload failure discards the reservation for retry", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "pre-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "pre-actuation",
  }, {
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => { throw new Error("payload failed"); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "payload failed" });
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
});

test("ambiguous actuation keeps images and retries only after the same client request returns", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "ambiguous-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const imagePath = inboxImage("ambiguous.png");
  let sends = 0;
  const message = {
    pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "ambiguous-actuation",
  };
  const outcome = await deliverConversationMessage(message, {
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
    sendText: async () => { sends += 1; throw new TmuxDeliveryUncertainError(new Error("transport lost")); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "transport lost" });
  expect(fs.existsSync(imagePath)).toBe(true);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "delivery-uncertain" }]);
  expect(() => registry.requeueHeldDelivery(registry.pendingDeliveries(conversation.id)[0]!.id)).toThrow("explicit client retry");
  const replay = await deliverConversationMessage(message, {
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => { throw new Error("retained image should be reused"); },
    sendText: async (_target, payload) => { sends += 1; expect(payload).toBe(imagePath); },
  });
  expect(replay.ok).toBe(true);
  expect(sends).toBe(2);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("reserved delivery reports uncertainty when direct tmux send fails after actuation starts", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "reserved-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const reserved = registry.holdDelivery(conversation.id, "migration payload", "reserved-actuation");

  const outcome = await deliverConversationMessage({
    pid: 1,
    path: "",
    conversationId: conversation.id,
    reservedDeliveryId: reserved.id,
    text: reserved.text,
    images: [],
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { throw new TmuxDeliveryUncertainError(new Error("post-paste transport lost")); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "post-paste transport lost", actuation: "started" });
  expect(migrationDeliveryOutcome(outcome)).toBe("delivery-uncertain");
});

test("reserved delivery reports a definite failure when tmux rejects before paste", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "reserved-pre-paste-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const reserved = registry.holdDelivery(conversation.id, "migration payload", "reserved-pre-paste");

  const outcome = await deliverConversationMessage({
    pid: 1,
    path: "",
    conversationId: conversation.id,
    reservedDeliveryId: reserved.id,
    text: reserved.text,
    images: [],
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { throw new Error("pane rejected before paste"); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "pane rejected before paste" });
  expect(outcome).not.toHaveProperty("actuation");
  expect(migrationDeliveryOutcome(outcome)).toBe("failed");
});

test("successful actuation retains images when settlement persistence fails", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "settlement-failure-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const imagePath = inboxImage("settled-before-write.png");
  const originalRecord = registry.recordDeliveryOutcome.bind(registry);
  registry.recordDeliveryOutcome = (() => { throw new Error("registry unavailable"); }) as typeof registry.recordDeliveryOutcome;
  try {
    const outcome = await deliverConversationMessage({
      pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "settlement-failure",
    }, {
      targetForKnownPid: async () => "%1",
      buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
      sendText: async () => {},
    });
    expect(outcome).toMatchObject({ ok: false, error: "registry unavailable", actuation: "started" });
    expect(migrationDeliveryOutcome(outcome)).toBe("delivery-uncertain");
    expect(fs.existsSync(imagePath)).toBe(true);
    expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "delivery-uncertain" }]);
  } finally {
    registry.recordDeliveryOutcome = originalRecord;
  }
});

test("switching engine routing leaves deferred transcript ownership unchanged", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/deferred-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  registry.setEngineRouting("codex", "default");

  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Continue this conversation",
    images: [],
    clientMessageId: "lazy-message",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
  expect(registry.conversationForPath(observation.path)?.generations.at(-1)?.accountId).toBe("managed");
  expect(registry.pendingDeliveries(conversation.id)).toHaveLength(0);
});

test("routing changes leave busy and unknown turns on their current generation", async () => {
  for (const turnState of ["busy", "unknown"] as const) {
    const registry = new AgentRegistry(path.join(SANDBOX, `${turnState}-registry.json`));
    setAgentRegistryForTests(registry);
    const observation: ConversationObservation = {
      engine: "codex",
      path: `/${turnState}-history.jsonl`,
      accountId: "managed",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: turnState, source: "lifecycle", terminalAt: null },
      observedAt: "2026-07-11T10:00:00.000Z",
    };
    registry.reconcileConversations([observation]);
    registry.setEngineRouting("codex", "default");

    const outcome = await deliverConversationMessage({
      pid: null,
      path: observation.path,
      text: "Continue the active turn",
      images: [],
      clientMessageId: `during-${turnState}-turn`,
    });

    expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
    expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
    expect(registry.conversationForPath(observation.path)?.generations.at(-1)?.accountId).toBe("managed");
    expect(registry.pendingDeliveries(registry.conversationForPath(observation.path)!.id)).toHaveLength(0);
  }
});

test("a stopped migration survives restart and unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/stopped-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([
    observation,
    { ...observation, path: "/active-turn.jsonl", turn: { state: "busy", source: "lifecycle", terminalAt: null } },
  ]);
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "stopped-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "active",
  });
  expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
  registry.setMigrationIntentState(intent.id, "stopped", intent.revision);
  const stoppedRevision = registry.engineRouting("codex").revision;
  const unrelated = { ...observation, path: "/unrelated-turn.jsonl" };
  registry.reconcileConversations([unrelated]);
  registry.reconcileConversations([{
    ...unrelated,
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);
  const unrelatedKey = { engine: "codex" as const, sessionId: "019f4e76-66b4-7f87-94b2-cfa9bf711111" };
  registry.upsert({
    key: unrelatedKey,
    artifactPath: unrelated.path,
    cwd: "/repo",
    accountId: "managed",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.markUnhosted(unrelatedKey);
  expect(registry.engineRouting("codex").revision).toBeGreaterThan(stoppedRevision);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Stay on the source account",
    images: [],
    clientMessageId: "after-stop",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)).toMatchObject({
    migration: null,
    migrationOptOut: { targetId: "default" },
  });
  expect(restarted.pendingDeliveries(restarted.conversationForPath(observation.path)!.id)).toHaveLength(0);
  expect(Object.values(restarted.snapshot().migrationIntents)).toHaveLength(1);

  restarted.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "later-explicit-switch",
    expectedRevision: restarted.engineRouting("codex").revision,
    scope: "active",
  });
  const reenrolled = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Use the newly selected account",
    images: [],
    clientMessageId: "after-new-switch",
  });
  expect(reenrolled).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)?.migration).toBeNull();
});

test("card-level Keep survives unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/kept-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "keep-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  const conversation = registry.conversationForPath(observation.path)!;
  registry.rollbackConversationMigration(conversation.id, conversation.migration!.revision);
  registry.reconcileConversations([{ ...observation, path: "/unrelated-after-keep.jsonl" }]);
  registry.reconcileConversations([{
    ...observation,
    path: "/unrelated-after-keep.jsonl",
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Keep using the source account",
    images: [],
    clientMessageId: "after-keep",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)?.migration?.phase).toBe("rolled-back");
  expect(restarted.pendingDeliveries(conversation.id)).toHaveLength(0);
});
