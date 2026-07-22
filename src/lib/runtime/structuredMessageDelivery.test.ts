import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, RuntimeImageStore, runtimeImageCapability } from "./runtimeImageStore";
import { structuredContentDigest, type StructuredImageRef } from "./structuredContent";

import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";

const artifactPath = "/sessions/11111111-1111-4111-8111-111111111111.jsonl";
const conversationId = "conversation_11111111-1111-4111-8111-111111111111";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-message-"));
let registryNumber = 0;
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
const SECOND_PNG_BASE64 = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.from([1])]).toString("base64");

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function registryWithConversation(accountId = "default", engine: "codex" | "claude" = "codex") {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  return { registry, conversation };
}

function recordStructuredOwner(registry: AgentRegistry, conversation: ReturnType<typeof registryWithConversation>["conversation"]): void {
  const generation = conversation.generations.at(-1)!;
  registry.upsert({
    key: { engine: conversation.engine, sessionId: generation.id },
    artifactPath: generation.path,
    cwd: generation.launchProfile.cwd,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:deployment-window",
      process: { pid: 101, startIdentity: "runtime-before-restart" },
      eventCursor: 17,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: "structured-host:runtime-before-restart",
    pendingAction: null,
  });
}

function recordLegacyOwner(registry: AgentRegistry, conversation: ReturnType<typeof registryWithConversation>["conversation"]): void {
  const generation = conversation.generations.at(-1)!;
  registry.upsert({
    key: { engine: conversation.engine, sessionId: generation.id },
    artifactPath: generation.path,
    cwd: generation.launchProfile.cwd,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    status: "idle",
    host: {
      kind: "tmux",
      endpoint: "/run/user/1000/tmux/default",
      server: { pid: 201, startIdentity: "tmux-server" },
      paneId: "%21",
      panePid: { pid: 202, startIdentity: "tmux-pane" },
      windowName: "legacy-root",
      agent: { pid: 203, startIdentity: "legacy-agent" },
      argv: ["codex", "resume", generation.id],
    },
    structuredHost: null,
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
}

function snapshot(ownedConversationId = conversationId, engine: "codex" | "claude" = "codex", imageSupported = false): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-13T00:00:00.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId: ownedConversationId,
      sessionKey: { engine, sessionId: "11111111-1111-4111-8111-111111111111" },
      hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath,
      capabilities: {
        steer: engine === "codex",
        structuredAttention: true,
        imageInput: runtimeImageCapability(engine, imageSupported),
      },
      activeTurnId: null,
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

test("Claude image-only admission stores refs and journals their content digest", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const imageRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  let command: Record<string, unknown> | null = null;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async (value: Record<string, unknown>) => {
      command = value;
      return {
        operationId: "op-image-only",
        replayed: false,
        receipt: {
          operationId: "op-image-only",
          idempotencyKey: "image-only-key",
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "image-only-key",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages: () => [imageRef],
    previewImageRefs: () => [imageRef],
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "queued" });
  expect(command).toMatchObject({
    text: "",
    images: [imageRef],
    contentDigest: structuredContentDigest({ text: "", images: [imageRef] }),
  });
});

test("a changed-image replay of one client message id maps to a 409 reservation conflict", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const originalRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const changedRef: StructuredImageRef = { sha256: "b".repeat(64), mime: "image/png", bytes: 91 };
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async (value: { operationId: string; idempotencyKey: string }) => {
      commands += 1;
      return {
        operationId: value.operationId,
        replayed: false,
        receipt: {
          operationId: value.operationId,
          idempotencyKey: value.idempotencyKey,
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-17T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const request = (ref: StructuredImageRef) => enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "changed-image-replay",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages: () => [ref],
    previewImageRefs: () => [ref],
    kick: () => {},
  });

  const first = await request(originalRef);
  expect(first).toMatchObject({ ok: true, outcome: "queued" });
  expect(commands).toBe(1);

  /* Same client message id, different image content: a typed reservation
     conflict surfaces as HTTP 409 and never reaches the host command plane. */
  const conflict = await request(changedRef);
  expect(conflict).toMatchObject({
    ok: false,
    outcome: "failed",
    status: 409,
    error: "client message id is already reserved for another request",
  });
  expect(commands).toBe(1);

  /* The original reservation survives the conflict untouched. */
  const reservation = Object.values(registry.snapshot().heldDeliveries)
    .find((held) => held.clientMessageId === "changed-image-replay");
  expect(reservation).toMatchObject({
    contentDigest: structuredContentDigest({ text: "", images: [originalRef] }),
    runtimeImages: [originalRef],
  });

  /* The exact replay stays idempotent after the rejected conflict. */
  const replay = await request(originalRef);
  expect(replay).toMatchObject({ ok: true });
});

test("an image send to a dead session recovers ownership first and enqueues exactly once", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const imageRef: StructuredImageRef = { sha256: "c".repeat(64), mime: "image/png", bytes: 67 };
  /* The dead projection advertises no image capability — judging the payload
     against it would 409 before recovery ever ran. */
  const deadSnapshot = snapshot(conversation.id, "claude", false);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let snapshots = 0;
  let recoveries = 0;
  let stores = 0;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => {
      snapshots += 1;
      return snapshots === 1 ? deadSnapshot : snapshot(conversation.id, "claude", true);
    },
    command: async (command: { operationId: string; idempotencyKey: string }) => {
      commands.push(command);
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-17T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "dead-recovery-image",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveries += 1;
      return { target: null, path: artifactPath, conversationId: conversation.id as never, spawned: true };
    },
    storeImages: () => { stores += 1; return [imageRef]; },
    previewImageRefs: () => [imageRef],
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "queued", spawned: true });
  expect(recoveries).toBe(1);
  expect(stores).toBe(1);
  expect(commands).toHaveLength(1);
});

test("a recovered Codex host with unknown image capability reaches the command queue for a fresh probe", async () => {
  const { registry, conversation } = registryWithConversation();
  const imageRef: StructuredImageRef = { sha256: "c".repeat(64), mime: "image/png", bytes: 67 };
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let snapshots = 0;
  let stores = 0;
  let previews = 0;
  let commands = 0;
  const client = {
    /* The recovered projection is hosted while image capability remains
       unconfirmed. The host performs the authoritative retry. */
    snapshot: async () => {
      snapshots += 1;
      return snapshots === 1 ? deadSnapshot : snapshot(conversation.id, "codex", false);
    },
    command: async (command: { operationId: string; idempotencyKey: string }) => {
      commands += 1;
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-17T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "dead-recovery-text-only",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => ({ target: null, path: artifactPath, conversationId: conversation.id as never, spawned: true }),
    storeImages: () => { stores += 1; return [imageRef]; },
    previewImageRefs: () => { previews += 1; return [imageRef]; },
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "queued" });
  expect(stores).toBe(1);
  expect(previews).toBe(1);
  expect(commands).toBe(1);
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(1);
});

test("a changed payload rejects before any blob publication even at full quota", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const originalRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const changedRef: StructuredImageRef = { sha256: "b".repeat(64), mime: "image/png", bytes: 91 };
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async (command: { operationId: string; idempotencyKey: string }) => {
      commands += 1;
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-17T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  let stores = 0;
  const request = (ref: StructuredImageRef, storeImages: () => StructuredImageRef[]) => enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "preflight-conflict",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages,
    previewImageRefs: () => [ref],
    kick: () => {},
  });

  const first = await request(originalRef, () => { stores += 1; return [originalRef]; });
  expect(first).toMatchObject({ ok: true, outcome: "queued" });
  expect(stores).toBe(1);
  const reserved = structuredClone(registry.snapshot().heldDeliveries);

  /* The changed payload must reject on the digest preflight without touching
     the store at all: the stub simulates a full-quota store where any write
     attempt would fail, and the 409 arrives with zero writes, GC, registry
     mutation, or host commands. */
  const conflict = await request(changedRef, () => { throw new Error("runtime image storage quota exceeded"); });
  expect(conflict).toMatchObject({
    ok: false,
    outcome: "failed",
    status: 409,
    error: "client message id is already reserved for another request",
  });
  expect(commands).toBe(1);
  expect(registry.snapshot().heldDeliveries).toEqual(reserved);

  /* The exact replay stays idempotent and still publishes before reference. */
  const replay = await request(originalRef, () => { stores += 1; return [originalRef]; });
  expect(replay).toMatchObject({ ok: true });
  expect(stores).toBe(2);
});

test("a reservation race leaves publication cleanup to grace-period GC", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const winnerRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const loserRef: StructuredImageRef = { sha256: "b".repeat(64), mime: "image/png", bytes: 91 };
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async () => { commands += 1; throw new Error("unexpected command"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "raced-admission",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    previewImageRefs: () => [loserRef],
    storeImages: () => {
      /* Simulate a concurrent writer in another process: it lands its own
         reservation for this key AFTER our preflight, DURING our blob
         publication. */
      new AgentRegistry(registry.filename).holdDelivery(
        conversation.id, "", "raced-admission", "runtime-images", [winnerRef],
        structuredContentDigest({ text: "", images: [winnerRef] }),
      );
      return [loserRef];
    },
    kick: () => {},
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    status: 409,
    error: "client message id is already reserved for another request",
  });
  expect(commands).toBe(0);
  /* The winner's reservation is untouched. */
  const reservation = Object.values(new AgentRegistry(registry.filename).snapshot().heldDeliveries)
    .find((held) => held.clientMessageId === "raced-admission");
  expect(reservation).toMatchObject({ runtimeImages: [winnerRef] });
});

test("a spawn publication survives a later deduplicated admission conflict", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const imageRoot = path.join(sandbox, `spawn-publication-${registryNumber}`);
  const store = new RuntimeImageStore(imageRoot);
  const upload = { base64: PNG_BASE64, mime: "image/png" };
  /* The spawn route publishes before its deferred runtime command creates a
     durable reservation. A later raw admission deduplicates this blob. */
  const [spawnRef] = store.putMany([upload]);
  const winnerRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async () => { throw new Error("unexpected command"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "spawn-publication-conflict",
    text: "",
    images: [upload],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    previewImageRefs: () => [spawnRef!],
    storeImages: () => {
      const refs = store.putMany([upload]);
      new AgentRegistry(registry.filename).holdDelivery(
        conversation.id,
        "",
        "spawn-publication-conflict",
        "runtime-images",
        [winnerRef],
        structuredContentDigest({ text: "", images: [winnerRef] }),
      );
      return refs;
    },
    kick: () => {},
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    status: 409,
    error: "client message id is already reserved for another request",
  });
  expect(store.read(spawnRef!)).toEqual(Buffer.from(PNG_BASE64, "base64"));
});

test("cross-process image admission fences publication through durable reservation", async () => {
  const stateRoot = fs.mkdtempSync(path.join(sandbox, "cross-process-admission-"));
  const registry = new AgentRegistry(
    path.join(stateRoot, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  );
  const sharedArtifact = path.join(stateRoot, "shared-session.jsonl");
  registry.reconcileConversations([{
    engine: "claude",
    path: sharedArtifact,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T00:00:00.000Z",
  }]);

  const fixture = path.join(import.meta.dir, "fixtures", "structuredImageAdmissionWriter.ts");
  const marker = (name: string) => path.join(stateRoot, name);
  const aPublished = marker("a-published");
  const aRelease = marker("a-release");
  const cPublished = marker("c-published");
  const cRelease = marker("c-release");
  const child = (key: string, image: string, published = "-", release = "-") => Bun.spawn([
    process.execPath,
    fixture,
    stateRoot,
    sharedArtifact,
    key,
    image,
    published,
    release,
  ], {
    env: {
      ...process.env,
      LLV_STATE_DIR: stateRoot,
      LLV_AGENT_REGISTRY_SQLITE: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const waitForFile = async (filename: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(filename)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filename)}`);
      await Bun.sleep(10);
    }
  };
  const finish = async (process: ReturnType<typeof child>): Promise<string> => {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || `structured image admission writer exited ${exitCode}`);
    return stdout;
  };

  const writerA = child("admission-a", PNG_BASE64, aPublished, aRelease);
  let writerC: ReturnType<typeof child> | null = null;
  let writerB: ReturnType<typeof child> | null = null;
  try {
    await waitForFile(aPublished);
    writerC = child("admission-b", PNG_BASE64, cPublished, cRelease);
    await Bun.sleep(40);
    writerB = child("admission-b", SECOND_PNG_BASE64);
    await Bun.sleep(150);
    const crossedPublicationFence = fs.existsSync(cPublished);

    if (crossedPublicationFence) {
      await finish(writerB);
      fs.writeFileSync(cRelease, "release\n");
      await finish(writerC);
      fs.writeFileSync(aRelease, "release\n");
      await finish(writerA);
    } else {
      fs.writeFileSync(aRelease, "release\n");
      await finish(writerA);
      const cPublishedBeforeExit = await Promise.race([
        waitForFile(cPublished).then(() => true),
        writerC.exited.then(() => false),
      ]);
      if (cPublishedBeforeExit) fs.writeFileSync(cRelease, "release\n");
      await Promise.all([finish(writerC), finish(writerB)]);
    }

    expect(crossedPublicationFence).toBe(false);
    const persisted = new AgentRegistry(
      path.join(stateRoot, "agent-registry.json"),
      undefined,
      undefined,
      { sqliteMode: "off" },
    ).snapshot();
    const reservation = Object.values(persisted.heldDeliveries)
      .find((delivery) => delivery.clientMessageId === "admission-a");
    expect(reservation?.runtimeImages).toHaveLength(1);
    const store = new RuntimeImageStore(path.join(stateRoot, "runtime-images"));
    expect(store.read(reservation!.runtimeImages[0]!)).toEqual(Buffer.from(PNG_BASE64, "base64"));
  } finally {
    fs.writeFileSync(aRelease, "release\n");
    fs.writeFileSync(cRelease, "release\n");
    for (const process of [writerA, writerC, writerB]) {
      if (process && process.exitCode === null) process.kill();
    }
  }
});

test("one UTF-8 envelope bound rejects an oversized multibyte caption before storage, recovery, and reservation", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const deadSnapshot = snapshot(conversation.id, "claude", true);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let recoveries = 0;
  let stores = 0;
  let commands = 0;
  const client = {
    snapshot: async () => deadSnapshot,
    command: async () => { commands += 1; throw new Error("unexpected command"); },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveries += 1;
      return { target: null, path: artifactPath, conversationId: conversation.id as never, spawned: false };
    },
    storeImages: () => { stores += 1; return []; },
    previewImageRefs: () => { stores += 1; return []; },
  };

  /* 10667 three-byte characters = 32001 UTF-8 bytes while only 10667 UTF-16
     units — the old length gate would have admitted this caption. */
  const oversized = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "envelope-multibyte-overflow",
    text: "€".repeat(10_667),
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, dependencies);

  expect(oversized).toMatchObject({ ok: false, outcome: "failed", status: 413 });
  expect(oversized).toMatchObject({ error: expect.stringContaining("32000-byte envelope") });
  expect(recoveries).toBe(0);
  expect(stores).toBe(0);
  expect(commands).toBe(0);
  expect(Object.values(registry.snapshot().heldDeliveries)).toEqual([]);
});

test("a caption at exactly the 32000-byte envelope boundary is admitted with images", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  const imageRef: StructuredImageRef = { sha256: "d".repeat(64), mime: "image/png", bytes: 67 };
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async (command: { operationId: string; idempotencyKey: string }) => {
      commands += 1;
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          text: "",
          imageCount: 1,
          at: "2026-07-17T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  /* 10666 three-byte characters plus two ASCII = exactly 32000 UTF-8 bytes. */
  const boundary = "€".repeat(10_666) + "aa";
  expect(Buffer.byteLength(boundary, "utf8")).toBe(32_000);

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "envelope-boundary",
    text: boundary,
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages: () => [imageRef],
    previewImageRefs: () => [imageRef],
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "queued" });
  expect(commands).toBe(1);
});

test("stale structured image capability rejects before blob storage or command admission", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  let stores = 0;
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", false),
    command: async () => { commands += 1; throw new Error("unexpected command"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "stale-image-capability",
    text: "",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages: () => { stores += 1; return []; },
  });

  expect(result).toMatchObject({ ok: false, status: 409, error: "Structured image protocol is unavailable for this host." });
  expect(stores).toBe(0);
  expect(commands).toBe(0);
});

test("an over-limit encoded aggregate fails before blob storage or command admission", async () => {
  const { registry, conversation } = registryWithConversation("default", "claude");
  let stores = 0;
  let commands = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", true),
    command: async () => { commands += 1; throw new Error("unexpected command"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "oversized-image-aggregate",
    text: "",
    images: [{ base64: "A".repeat(MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 4), mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    storeImages: () => { stores += 1; return []; },
  });

  expect(result).toMatchObject({ ok: false, error: "runtime image request encoding is too large" });
  expect(stores).toBe(0);
  expect(commands).toBe(0);
});

test("structured message routing is inert while its gate is disabled", async () => {
  let called = false;
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    {
      enabled: () => false,
      client: () => {
        called = true;
        return null;
      },
    },
  );

  expect(result).toBeNull();
  expect(called).toBe(false);
});

test("structured message routing fences failed startup when no persisted owner exists", async () => {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => null, registry: () => registry, startupFailed: () => true },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("structured message routing fences a missing runtime client without startup failure evidence", async () => {
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => null, startupFailed: () => false },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("a persisted structured current generation holds the exact send while the runtime client is absent", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  let migrationTicks = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "deployment-window-message",
    text: "continue through runtime synchronization",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
    startupFailed: () => false,
  });

  expect(result).toMatchObject({
    ok: true,
    structured: true,
    target: conversation.id,
    outcome: "held",
  });
  expect(migrationTicks).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "deployment-window-message",
    text: "continue through runtime synchronization",
    state: "assigned",
    generationId: conversation.generations.at(-1)!.id,
  }]);
});

test("a reopened synchronization hold replays the exact steer command", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "deployment-window-steer",
    operationId: "operation-deployment-window-steer",
    kind: "steer" as const,
    policy: "steer-if-active" as const,
    turnId: "turn-before-runtime-restart",
    text: "amend the active turn after runtime recovery",
    hasImages: false,
  };

  expect(await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => {},
  })).toMatchObject({ ok: true, structured: true, outcome: "held" });

  const reopened = new AgentRegistry(registry.filename);
  const persisted = reopened.pendingDeliveries(conversation.id)[0]!;
  expect(persisted).toMatchObject({
    command: {
      operationId: request.operationId,
      kind: request.kind,
      policy: request.policy,
      turnId: request.turnId,
    },
    requestDigest: expect.any(String),
  });

  let acceptedCommand: unknown;
  const receipt = {
    operationId: request.operationId,
    idempotencyKey: request.clientMessageId,
    conversationId: conversation.id,
    kind: request.kind,
    status: "delivered" as const,
    turnId: request.turnId,
    at: "2026-07-13T00:00:00.000Z",
    revision: 2,
  };
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async (command: unknown) => {
      acceptedCommand = command;
      return { operationId: request.operationId, replayed: false, receipt };
    },
    operationStatus: async () => ({ operationId: request.operationId, replayed: true, receipt }),
  } as unknown as RuntimeHostClient;
  const heldRequest = {
    conversationId: conversation.id,
    path: artifactPath,
    deliveryId: persisted.id,
    clientMessageId: request.clientMessageId,
    text: persisted.text,
    command: persisted.command,
  };

  expect(await deliverHeldStructuredMessage(heldRequest, {
    enabled: () => true,
    client: () => client,
    kick: () => {},
  })).toBe("delivered");
  expect(acceptedCommand).toEqual({
    operationId: request.operationId,
    conversationId: conversation.id,
    idempotencyKey: request.clientMessageId,
    kind: request.kind,
    policy: request.policy,
    turnId: request.turnId,
    text: request.text,
    contentDigest: expect.any(String),
  });
});

test("a reopened synchronization hold rejects changed payload and command reuse", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const dependencies = {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => {},
  };
  const original = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "deployment-window-conflict",
    operationId: "operation-deployment-window-conflict",
    kind: "steer" as const,
    policy: "steer-if-active" as const,
    turnId: "turn-before-conflict",
    text: "retain the original draft",
    hasImages: false,
  };

  expect(await enqueueStructuredMessage(original, dependencies)).toMatchObject({
    ok: true,
    structured: true,
    outcome: "held",
  });
  const firstReservation = registry.pendingDeliveries(conversation.id)[0]!;
  const reopened = new AgentRegistry(registry.filename);
  const reopenedDependencies = { ...dependencies, registry: () => reopened };

  expect(await enqueueStructuredMessage({
    ...original,
    text: "changed caller draft",
  }, reopenedDependencies)).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 409,
  });
  expect(await enqueueStructuredMessage({
    ...original,
    kind: "send",
  }, reopenedDependencies)).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 409,
  });
  expect(await enqueueStructuredMessage({
    ...original,
    policy: "queue",
  }, reopenedDependencies)).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 409,
  });
  expect(await enqueueStructuredMessage({
    ...original,
    turnId: null,
  }, reopenedDependencies)).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 409,
  });
  expect(reopened.pendingDeliveries(conversation.id)).toEqual([firstReservation]);

  expect(await enqueueStructuredMessage({
    ...original,
    operationId: "operation-from-refreshed-caller",
  }, reopenedDependencies)).toMatchObject({
    ok: true,
    structured: true,
    outcome: "held",
  });
  expect(reopened.pendingDeliveries(conversation.id)[0]).toMatchObject({
    id: firstReservation.id,
    text: firstReservation.text,
    command: firstReservation.command,
    requestDigest: firstReservation.requestDigest,
  });
});

test("a delivered tombstone rejects changed client-id reuse and preserves the caller draft", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const original = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "delivered-client-id-conflict",
    operationId: "operation-delivered-client-id-conflict",
    kind: "send" as const,
    policy: "queue" as const,
    turnId: null,
    text: "the delivered draft",
    hasImages: false,
  };
  const receipt = {
    operationId: original.operationId,
    idempotencyKey: original.clientMessageId,
    conversationId: conversation.id,
    kind: original.kind,
    status: "delivered" as const,
    turnId: "turn-delivered",
    at: "2026-07-13T00:00:00.000Z",
    revision: 2,
  };
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => ({ operationId: original.operationId, replayed: false, receipt }),
  } as unknown as RuntimeHostClient;

  expect(await enqueueStructuredMessage(original, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => {},
  })).toMatchObject({ ok: true, structured: true, outcome: "delivered" });
  const tombstone = Object.values(registry.snapshot().heldDeliveries)[0]!;
  expect(tombstone).toMatchObject({ state: "delivered", text: "", requestDigest: expect.any(String) });

  const callerDraft = "the caller's changed draft";
  const conflict = await enqueueStructuredMessage({
    ...original,
    kind: "steer" as const,
    policy: "steer-if-active" as const,
    turnId: "turn-new",
    text: callerDraft,
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => {},
  });

  expect(conflict).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });
  expect(callerDraft).toBe("the caller's changed draft");
  expect(registry.snapshot().heldDeliveries[tombstone.id]).toEqual(tombstone);
});

test("a persisted tmux current generation falls through during runtime client absence", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  let migrationTicks = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "legacy-deployment-window-message",
    text: "continue through the legacy pane",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
    startupFailed: () => false,
  });

  expect(result).toBeNull();
  expect(migrationTicks).toBe(0);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("legacy synchronization rejects structured command semantics before fallback", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "legacy-structured-command",
    operationId: "operation-legacy-structured-command",
    kind: "steer" as const,
    policy: "steer-if-active" as const,
    turnId: "stale-legacy-turn",
    text: "preserve structured command semantics",
    hasImages: false,
  };
  const result = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
  });
  const legacySnapshot = snapshot(conversation.id);
  legacySnapshot.sessions[0] = { ...legacySnapshot.sessions[0]!, hostKind: "tmux-legacy" };
  const snapshotResult = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => ({ snapshot: async () => legacySnapshot }) as unknown as RuntimeHostClient,
    registry: () => registry,
  });

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });
  expect(snapshotResult).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("conflicting persisted ownership stays fenced during runtime client absence", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  const generation = conversation.generations.at(-1)!;
  registry.setStructuredHost({ engine: conversation.engine, sessionId: generation.id }, {
    kind: "codex-app-server",
    endpoint: "stdio:conflicting-owner",
    process: null,
    eventCursor: 9,
    protocolVersion: "v2",
    writerClaimEpoch: 2,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  });

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "ambiguous-deployment-window-message",
    text: "keep conflicting ownership fenced",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
  });

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("structured runtime synchronization keeps images and oversized text request-local", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const dependencies = {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
  };

  const image = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "runtime-window-image",
    text: "image caption",
    hasImages: true,
  }, dependencies);
  const oversized = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "runtime-window-oversized",
    text: "x".repeat(32_001),
    hasImages: false,
  }, dependencies);

  expect(image).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });
  expect(oversized).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 413 });
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("legacy runtime synchronization leaves request-local payloads for the legacy ladder", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  const dependencies = {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
  };

  expect(await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "legacy-runtime-window-image",
    text: "image caption",
    hasImages: true,
  }, dependencies)).toBeNull();
  expect(await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "legacy-runtime-window-oversized",
    text: "x".repeat(32_001),
    hasImages: false,
  }, dependencies)).toBeNull();
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("structured message routing fences when the snapshot and registry have no current owner", async () => {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  const client = {
    snapshot: async () => ({ ...snapshot(), sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client, registry: () => registry },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("structured message routing fences a failed startup snapshot without persisted ownership", async () => {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  const client = {
    snapshot: async () => { throw new Error("startup adoption failed"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client, registry: () => registry, startupFailed: () => true },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("structured message routing fences a transient snapshot failure", async () => {
  const client = {
    snapshot: async () => { throw new Error("runtime socket timed out"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client, startupFailed: () => false },
  );

  expect(result).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 503,
  });
});

test("a persisted structured current generation holds the send after a runtime snapshot failure", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  let migrationTicks = 0;
  const client = {
    snapshot: async () => { throw new Error("runtime host is unavailable"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "snapshot-window-message",
    text: "retain this snapshot-window send",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
    startupFailed: () => false,
  });

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect(migrationTicks).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "snapshot-window-message",
    text: "retain this snapshot-window send",
    state: "assigned",
  }]);
});

test("a persisted tmux current generation falls through after a runtime snapshot failure", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  const client = {
    snapshot: async () => { throw new Error("runtime host is unavailable"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "legacy-snapshot-window-message",
    text: "deliver through the legacy pane",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    startupFailed: () => false,
  });

  expect(result).toBeNull();
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
});

test("structured ownership recovery revokes startup-failure fallback authorization", async () => {
  let startupFailed = true;
  let snapshots = 0;
  const client = {
    snapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot();
      throw new Error("runtime socket timed out after recovery");
    },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    startupFailed: () => startupFailed,
    startupRecovered: () => { startupFailed = false; },
  };

  expect(await enqueueStructuredMessage(
    { path: artifactPath, text: "observe recovery", hasImages: true },
    dependencies,
  )).toMatchObject({ ok: false, structured: true, status: 409 });
  expect(startupFailed).toBe(false);
  expect(await enqueueStructuredMessage(
    { path: artifactPath, text: "remain fenced", hasImages: false },
    dependencies,
  )).toMatchObject({ ok: false, structured: true, status: 503 });
});

test("structured message routing only falls through for an explicit legacy owner", async () => {
  const legacySnapshot = snapshot();
  legacySnapshot.sessions[0] = { ...legacySnapshot.sessions[0]!, hostKind: "tmux-legacy" };
  const client = {
    snapshot: async () => legacySnapshot,
    command: async () => { throw new Error("legacy delivery reached the structured host"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toBeNull();
});

test("dead structured composer send is durable before recovery and delivers after claim", async () => {
  const { registry, conversation } = registryWithConversation();
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let recovered = false;
  let durableBeforeRecovery = false;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => deadSnapshot,
    command: async (command: {
      kind: "send";
      operationId?: string;
      idempotencyKey: string;
      conversationId: string;
      text: string;
    }) => {
      commands.push(command);
      return {
        operationId: command.operationId ?? "recovered-send-one",
        replayed: false,
        receipt: {
          operationId: command.operationId ?? "recovered-send-one",
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          kind: command.kind,
          status: recovered ? "queued" as const : "rejected" as const,
          reason: recovered ? null : "dead-host",
          queuePosition: recovered ? 1 : null,
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    {
      path: artifactPath,
      conversationId: conversation.id,
      clientMessageId: "recovered-message-one",
      text: "continue after host loss",
      hasImages: false,
    },
    {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      recover: async () => {
        durableBeforeRecovery = registry.pendingDeliveries(conversation.id).some((delivery) =>
          delivery.clientMessageId === "recovered-message-one"
            && delivery.text === "continue after host loss");
        recovered = true;
        return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
      },
      kick: () => {},
    } as never,
  );

  expect(durableBeforeRecovery).toBe(true);
  expect(recovered).toBe(true);
  expect(commands).toHaveLength(1);
  expect(result).toMatchObject({
    ok: true,
    structured: true,
    target: null,
    spawned: true,
    outcome: "queued",
    receipt: { idempotencyKey: "recovered-message-one", status: "queued" },
  });
});

test("structured recovery failures remain admitted, avoid delivery, and allow a later retry", async () => {
  const { registry, conversation } = registryWithConversation();
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let recoveryAttempts = 0;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => deadSnapshot,
    command: async (command: unknown) => {
      commands.push(command);
      return {
        operationId: "recovery-retry-message",
        replayed: false,
        receipt: {
          operationId: "recovery-retry-message",
          idempotencyKey: "recovery-retry-message",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("recovery spawn failed");
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
    kick: () => {},
  } as never;
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "recovery-retry-message",
    text: "retain this draft through recovery failure",
    hasImages: false,
  };

  await expect(enqueueStructuredMessage(request, dependencies)).resolves.toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 503,
  });
  expect(commands).toEqual([]);
  expect(registry.pendingDeliveries(conversation.id)).toHaveLength(1);
  expect(registry.pendingDeliveries(conversation.id)[0]).toMatchObject({
    clientMessageId: "recovery-retry-message",
    state: "assigned",
    text: "retain this draft through recovery failure",
  });

  await expect(enqueueStructuredMessage(request, dependencies)).resolves.toMatchObject({
    ok: true,
    structured: true,
    spawned: true,
    outcome: "queued",
  });
  expect(commands).toHaveLength(1);
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(1);
});

test("structured message republishes an in-process host after runtime restart before recovery", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  const hostedSnapshot = snapshot(conversation.id);
  let currentSnapshot = deadSnapshot;
  let republishCalls = 0;
  let recoveryCalls = 0;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => currentSnapshot,
    command: async (command: unknown) => {
      commands.push(command);
      return {
        operationId: "runtime-restart-message",
        replayed: false,
        receipt: {
          operationId: "runtime-restart-message",
          idempotencyKey: "runtime-restart-message",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-17T20:47:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "runtime-restart-message",
    text: "continue the same conversation",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    republish: async (key) => {
      republishCalls += 1;
      expect(key).toEqual({ engine: "codex", sessionId: conversation.generations.at(-1)!.id });
      currentSnapshot = hostedSnapshot;
      return true;
    },
    recover: async () => {
      recoveryCalls += 1;
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
    kick: () => {},
  });

  expect(result).toMatchObject({
    ok: true,
    structured: true,
    outcome: "queued",
    operationId: "runtime-restart-message",
  });
  expect(result).not.toHaveProperty("spawned");
  expect(republishCalls).toBe(1);
  expect(recoveryCalls).toBe(0);
  expect(commands).toHaveLength(1);
});

test("structured ownership stays fenced while its registry projection is missing", async () => {
  const client = {
    snapshot: async () => snapshot(),
  } as unknown as RuntimeHostClient;
  const { registry } = registryWithConversation("missing-projection");

  const result = await enqueueStructuredMessage(
    { path: artifactPath, conversationId, text: "stay structured", hasImages: false },
    {
      enabled: () => true,
      client: () => client,
      registry: () => new AgentRegistry(path.join(path.dirname(registry.filename), "missing.json")),
    },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("structured message routing fences an unhosted runtime projection", async () => {
  const unhostedSnapshot = snapshot();
  unhostedSnapshot.sessions[0] = { ...unhostedSnapshot.sessions[0]!, hostKind: "unhosted" };
  const client = { snapshot: async () => unhostedSnapshot } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
});

test("structured message routing returns the durable queued receipt immediately", async () => {
  const { registry, conversation } = registryWithConversation();
  let command: unknown;
  let kicked = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async (value: unknown) => {
      command = value;
      return {
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "message-one",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-13T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", clientMessageId: "message-one", hasImages: false },
    { enabled: () => true, client: () => client, registry: () => registry, kick: () => { kicked += 1; } },
  );

  expect(command).toMatchObject({
    conversationId: conversation.id,
    text: "hello",
    idempotencyKey: "message-one",
    policy: "interrupt-active",
  });
  expect(result).toMatchObject({ ok: true, structured: true, outcome: "queued", operationId: "op-one" });
  expect(kicked).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "message-one",
    state: "delivery-uncertain",
  }]);
});

test("migration-held delivery settles through the runtime journal after EngineHost completion", async () => {
  const { conversation } = registryWithConversation();
  let command: unknown;
  let status = "queued" as "queued" | "delivered";
  const receipt = () => ({
    operationId: "held-delivery-one",
    idempotencyKey: "held-message-one",
    conversationId: conversation.id,
    kind: "send" as const,
    status,
    queuePosition: 1,
    at: "2026-07-13T00:00:00.000Z",
    revision: status === "queued" ? 1 : 2,
  });
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async (value: unknown) => {
      command = value;
      return { operationId: "held-delivery-one", replayed: false, receipt: receipt() };
    },
    operationStatus: async () => ({ operationId: "held-delivery-one", replayed: true, receipt: receipt() }),
  } as unknown as RuntimeHostClient;

  const outcome = await deliverHeldStructuredMessage(
    {
      conversationId: conversation.id,
      path: artifactPath,
      deliveryId: "held-delivery-one",
      clientMessageId: "held-message-one",
      text: "after migration",
    },
    {
      enabled: () => true,
      client: () => client,
      kick: async () => { status = "delivered"; },
    },
  );

  expect(command).toMatchObject({
    kind: "send",
    operationId: "held-delivery-one",
    conversationId: conversation.id,
    idempotencyKey: "held-message-one",
    text: "after migration",
    policy: "interrupt-active",
  });
  expect(outcome).toBe("delivered");
});

test("held delivery stays fenced when persisted ownership is unavailable", async () => {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  const request = {
    conversationId: "conversation_missing",
    path: artifactPath,
    deliveryId: "held-missing-owner",
    clientMessageId: "held-missing-owner-message",
    text: "continue through tmux",
  };
  const missingSessionClient = {
    snapshot: async () => ({ ...snapshot(), sessions: [] }),
  } as unknown as RuntimeHostClient;

  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    startupFailed: () => true,
  })).toBe("delivery-uncertain");
  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => missingSessionClient,
    registry: () => registry,
  })).toBe("delivery-uncertain");
});

test("held delivery fences a missing runtime client without startup failure evidence", async () => {
  expect(await deliverHeldStructuredMessage({
    conversationId,
    path: artifactPath,
    deliveryId: "held-missing-client",
    clientMessageId: "held-missing-client-message",
    text: "stay fenced",
  }, {
    enabled: () => true,
    client: () => null,
    startupFailed: () => false,
  })).toBe("delivery-uncertain");
});

test("held delivery keeps a persisted structured owner fenced when startup failed", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);

  expect(await deliverHeldStructuredMessage({
    conversationId: conversation.id,
    path: artifactPath,
    deliveryId: "held-structured-startup-failure",
    clientMessageId: "held-structured-startup-failure-message",
    text: "remain structured through startup recovery",
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    startupFailed: () => true,
  })).toBe("delivery-uncertain");
});

test("held delivery authorizes legacy fallback from persisted tmux ownership", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);

  expect(await deliverHeldStructuredMessage({
    conversationId: conversation.id,
    path: artifactPath,
    deliveryId: "held-legacy-startup-failure",
    clientMessageId: "held-legacy-startup-failure-message",
    text: "continue through the legacy ladder",
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    startupFailed: () => true,
  })).toBeNull();
});

test("held delivery rejects structured command semantics before legacy fallback", async () => {
  const { registry, conversation } = registryWithConversation();
  recordLegacyOwner(registry, conversation);
  const request = {
    conversationId: conversation.id,
    path: artifactPath,
    deliveryId: "held-legacy-structured-command",
    clientMessageId: "held-legacy-structured-command-message",
    text: "retain the stale turn fence",
    command: {
      operationId: "operation-held-legacy-structured-command",
      kind: "steer" as const,
      policy: "steer-if-active" as const,
      turnId: "stale-legacy-turn",
    },
  };
  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
  })).toBe("failed");
  const legacySnapshot = snapshot(conversation.id);
  legacySnapshot.sessions[0] = { ...legacySnapshot.sessions[0]!, hostKind: "tmux-legacy" };
  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => ({ snapshot: async () => legacySnapshot }) as unknown as RuntimeHostClient,
    registry: () => registry,
  })).toBe("failed");
});

test("held delivery stays uncertain during a transient structured snapshot failure", async () => {
  const client = {
    snapshot: async () => { throw new Error("runtime socket timed out"); },
  } as unknown as RuntimeHostClient;

  expect(await deliverHeldStructuredMessage({
    conversationId,
    path: artifactPath,
    deliveryId: "held-transient-snapshot",
    clientMessageId: "held-transient-snapshot-message",
    text: "stay fenced",
  }, {
    enabled: () => true,
    client: () => client,
    startupFailed: () => false,
  })).toBe("delivery-uncertain");
});

test("structured message routing holds composer delivery when migration owns the fence", async () => {
  const { registry, conversation } = registryWithConversation("managed");
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "structured-migration",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  registry.requestConversationMigrationToActiveAccount(conversation.id);
  let commands = 0;
  let migrationTicks = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => {
      commands += 1;
      throw new Error("the predecessor host received a fenced message");
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "after migration", clientMessageId: "migration-message", hasImages: false },
    {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      requestMigrationTick: () => { migrationTicks += 1; },
    },
  );

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect(commands).toBe(0);
  expect(migrationTicks).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    state: "held",
    clientMessageId: "migration-message",
    text: "after migration",
  }]);
});
