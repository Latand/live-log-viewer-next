import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";

import { AgentRegistry, conversationLookupFromSnapshot, CORRUPT_HELD_DELIVERY_IMAGES_ERROR, DeliveryReservationConflictError, SPAWN_STARTING_ADMISSION_LEASE_MS } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { structuredContent } from "@/lib/runtime/structuredContent";

const KEY = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function registry(ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"), ownerAlive);
}

function spawnEntry(pathname: string, accountId = "terra") {
  return {
    key: { engine: "codex" as const, sessionId: pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: pathname,
    cwd: "/repo",
    accountId,
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
}

describe("agent registry", () => {
  test("snapshot lookup preserves aliases and first path ownership without disk reads", () => {
    const store = registry();
    const first = store.ensureConversation("codex", "/shared.jsonl", "default");
    const second = store.ensureConversation("codex", "/second.jsonl", "default");
    const snapshot = store.snapshot();
    snapshot.conversations[second.id]!.continuityPaths.push("/shared.jsonl");
    snapshot.conversationAliases["conversation_alias"] = first.id;

    const lookup = conversationLookupFromSnapshot(snapshot);

    expect(lookup.conversationForPath("/shared.jsonl")?.id).toBe(first.id);
    expect(lookup.canonicalConversationId("conversation_alias")).toBe(first.id);
    expect(lookup.conversation("conversation_alias")?.id).toBe(first.id);
  });

  test("read-only snapshots reuse one parse until an atomic registry replacement", () => {
    const store = registry();
    store.setEngineRouting("codex", "work");
    const reads = spyOn(fs, "readFileSync");
    let first: ReturnType<AgentRegistry["snapshot"]>;
    let second: ReturnType<AgentRegistry["snapshot"]>;
    try {
      first = store.readOnlySnapshot();
      second = store.readOnlySnapshot();
      expect(reads.mock.calls.filter(([filename]) => filename === store.filename)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
    expect(second!).toBe(first!);

    store.setEngineRouting("codex", "default");
    const replacement = store.readOnlySnapshot();

    expect(replacement).not.toBe(first!);
    expect(replacement.engineRouting.codex.activeAccountId).toBe("default");
    expect(store.snapshot()).not.toBe(replacement);
  });

  test("read helpers share one signature-fenced registry parse", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/sessions/read-helper.jsonl", "work");
    store.setEngineRouting("codex", "work");
    const reads = spyOn(fs, "readFileSync");
    try {
      expect(store.engineRouting("codex").activeAccountId).toBe("work");
      expect(store.conversationForPath("/sessions/read-helper.jsonl")?.id).toBe(conversation.id);
      expect(store.canonicalConversationId(conversation.id)).toBe(conversation.id);
      expect(store.autoBalancePolicy("codex").enabled).toBeTrue();
      expect(store.quotaObservations("codex")).toEqual([]);
      expect(reads.mock.calls.filter(([filename]) => filename === store.filename)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("startup compaction bounds legacy delivered reservations per conversation", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy-deliveries.jsonl", "default");
    const snapshot = store.snapshot();
    for (let index = 0; index < 105; index += 1) {
      const id = `legacy-${String(index).padStart(3, "0")}`;
      snapshot.heldDeliveries[id] = {
        id,
        conversationId: conversation.id,
        text: `legacy body ${index}`,
        createdAt: `2026-07-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        clientMessageId: id,
        payloadKind: "text",
        runtimeImages: [],
        contentDigest: null,
        artifactPaths: [],
        state: "delivered",
        generationId: conversation.generations.at(-1)!.id,
        attempts: 1,
        assignedAt: null,
        deliveredAt: `2026-07-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        error: null,
      } as unknown as (typeof snapshot.heldDeliveries)[string];
    }
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    const upgraded = new AgentRegistry(store.filename);
    expect(upgraded.compactDeliveryReservations()).toBe(0);
    const restarted = new AgentRegistry(store.filename);
    const retained = Object.values(restarted.snapshot().heldDeliveries);
    expect(retained).toHaveLength(100);
    expect(retained.every((delivery) => delivery.text === "")).toBe(true);
    expect(retained.map((delivery) => delivery.id)).not.toContain("legacy-000");
    expect(retained.map((delivery) => delivery.id)).toContain("legacy-104");
  });

  test("a restarted legacy delivered tombstone replays while modern digests retain payload conflicts", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy-delivered-retry.jsonl", "default");
    const snapshot = store.snapshot();
    snapshot.heldDeliveries["legacy-delivered"] = {
      id: "legacy-delivered",
      conversationId: conversation.id,
      text: "",
      createdAt: "2026-07-11T00:00:00.000Z",
      clientMessageId: "legacy-client-message",
      payloadKind: "text",
      runtimeImages: [],
      contentDigest: null,
      artifactPaths: [],
      state: "delivered",
      generationId: conversation.generations.at(-1)!.id,
      attempts: 1,
      assignedAt: "2026-07-11T00:00:01.000Z",
      deliveredAt: "2026-07-11T00:00:02.000Z",
      error: null,
    } as unknown as (typeof snapshot.heldDeliveries)[string];
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    const restarted = new AgentRegistry(store.filename);
    const originalContent = structuredContent("original payload", []);
    expect(restarted.holdDelivery(
      conversation.id,
      originalContent.content.text,
      "legacy-client-message",
      "text",
      [],
      originalContent.contentDigest,
    )).toMatchObject({ id: "legacy-delivered", state: "delivered", contentDigest: null });

    const modernContent = structuredContent("modern payload", []);
    const modern = restarted.holdDelivery(
      conversation.id,
      modernContent.content.text,
      "modern-client-message",
      "text",
      [],
      modernContent.contentDigest,
    );
    restarted.beginDeliveryAttempt(modern.id, conversation.generations.at(-1)!.id);
    restarted.recordDeliveryOutcome(modern.id, "delivered");
    const changedContent = structuredContent("changed payload", []);
    expect(() => restarted.holdDelivery(
      conversation.id,
      changedContent.content.text,
      "modern-client-message",
      "text",
      [],
      changedContent.contentDigest,
    )).toThrow("client message id is already reserved for another request");
  });

  test("a changed-image replay of one client message id raises a typed 409 reservation conflict", () => {
    const store = registry();
    const conversation = store.ensureConversation("claude", "/changed-image-conflict.jsonl", "default");
    const originalRefs = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 }];
    const original = structuredContent("ship the screenshot", originalRefs);
    const held = store.holdDelivery(
      conversation.id, original.content.text, "image-client-message", "runtime-images", originalRefs, original.contentDigest,
    );
    expect(held.state).toBe("assigned");

    /* The exact replay (same text and image digests) stays idempotent. */
    const replay = store.holdDelivery(
      conversation.id, original.content.text, "image-client-message", "runtime-images", originalRefs, original.contentDigest,
    );
    expect(replay.id).toBe(held.id);

    /* Same client message id and text, different image set: a reservation
       conflict typed for HTTP 409, with the original reservation untouched. */
    const changedRefs = [{ sha256: "b".repeat(64), mime: "image/png" as const, bytes: 91 }];
    const changed = structuredContent("ship the screenshot", changedRefs);
    expect(() => store.holdDelivery(
      conversation.id, changed.content.text, "image-client-message", "runtime-images", changedRefs, changed.contentDigest,
    )).toThrow(DeliveryReservationConflictError);
    expect(store.snapshot().heldDeliveries[held.id]).toMatchObject({
      contentDigest: original.contentDigest,
      runtimeImages: originalRefs,
      state: "assigned",
    });

    /* And the exact replay still works after the rejected conflict. */
    expect(store.holdDelivery(
      conversation.id, original.content.text, "image-client-message", "runtime-images", originalRefs, original.contentDigest,
    ).id).toBe(held.id);
  });

  test("a retirement-aged delivered reservation still replays exactly and conflicts by digest", () => {
    const store = registry();
    const conversation = store.ensureConversation("claude", "/retired-tombstone.jsonl", "default");
    const refs = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 }];
    const content = structuredContent("retired but idempotent", refs);
    const held = store.holdDelivery(conversation.id, content.content.text, "retired-key", "runtime-images", refs, content.contentDigest);
    store.beginDeliveryAttempt(held.id, conversation.generations.at(-1)!.id);
    store.recordDeliveryOutcome(held.id, "delivered");
    /* Age the tombstone far past the reachability retirement grace: blob refs
       may retire from quota accounting, but the digest tombstone itself keeps
       replay and conflict semantics untouched. */
    const snapshot = store.snapshot();
    snapshot.heldDeliveries[held.id]!.deliveredAt = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));
    const restarted = new AgentRegistry(store.filename);

    expect(restarted.holdDelivery(conversation.id, content.content.text, "retired-key", "runtime-images", refs, content.contentDigest))
      .toMatchObject({ id: held.id, state: "delivered" });
    const changed = structuredContent("retired but idempotent", [{ sha256: "b".repeat(64), mime: "image/png" as const, bytes: 91 }]);
    expect(() => restarted.holdDelivery(conversation.id, changed.content.text, "retired-key", "runtime-images", changed.content.images, changed.contentDigest))
      .toThrow(DeliveryReservationConflictError);
  });

  test("corrupt persisted image refs become a visible recoverable failure with zero actuation", () => {
    const store = registry();
    const conversation = store.ensureConversation("claude", "/corrupt-image-refs.jsonl", "default");
    const refs = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 }];
    const content = structuredContent("annotate the diagram", refs);
    const held = store.holdDelivery(conversation.id, content.content.text, "corrupt-image-key", "runtime-images", refs, content.contentDigest);
    expect(held.state).toBe("assigned");
    const snapshot = store.snapshot();
    (snapshot.heldDeliveries[held.id] as { runtimeImages: unknown }).runtimeImages =
      [{ sha256: "not-a-digest", mime: "image/png", bytes: 67 }];
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    /* Normalization keeps the image reservation in a recoverable failure
       state and blocks caption-only actuation. */
    const restarted = new AgentRegistry(store.filename);
    expect(restarted.snapshot().heldDeliveries[held.id]).toMatchObject({
      state: "failed",
      runtimeImages: [],
      generationId: null,
      error: CORRUPT_HELD_DELIVERY_IMAGES_ERROR,
      contentDigest: content.contentDigest,
    });

    /* No delivery attempt can claim it, and an exact replay cannot revive it
       into an assignable text-only delivery — it stays visibly failed. */
    expect(restarted.beginDeliveryAttempt(held.id, conversation.generations.at(-1)!.id)).toBeNull();
    expect(restarted.holdDelivery(conversation.id, content.content.text, "corrupt-image-key", "runtime-images", refs, content.contentDigest))
      .toMatchObject({ id: held.id, state: "failed", error: CORRUPT_HELD_DELIVERY_IMAGES_ERROR });

    /* A changed payload under the same key still raises the typed conflict. */
    const changed = structuredContent("annotate the diagram", [{ sha256: "b".repeat(64), mime: "image/png" as const, bytes: 91 }]);
    expect(() => restarted.holdDelivery(conversation.id, changed.content.text, "corrupt-image-key", "runtime-images", changed.content.images, changed.contentDigest))
      .toThrow(DeliveryReservationConflictError);
  });

  for (const scenario of [
    { label: "missing", runtimeImages: undefined },
    { label: "null", runtimeImages: null },
    { label: "empty", runtimeImages: [] },
  ] as const) {
    test(`runtime-images reservation with ${scenario.label} refs becomes a recoverable failure`, () => {
      const store = registry();
      const conversation = store.ensureConversation("claude", `/missing-image-refs-${scenario.label}.jsonl`, "default");
      const refs = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 }];
      const content = structuredContent("keep the image", refs);
      const held = store.holdDelivery(conversation.id, content.content.text, null, "runtime-images", refs, content.contentDigest);
      const snapshot = store.snapshot();
      if (scenario.runtimeImages === undefined) delete (snapshot.heldDeliveries[held.id] as Partial<typeof held>).runtimeImages;
      else (snapshot.heldDeliveries[held.id] as { runtimeImages: unknown }).runtimeImages = scenario.runtimeImages;
      fs.writeFileSync(store.filename, JSON.stringify(snapshot));

      expect(new AgentRegistry(store.filename).snapshot().heldDeliveries[held.id]).toMatchObject({
        state: "failed",
        runtimeImages: [],
        generationId: null,
        error: CORRUPT_HELD_DELIVERY_IMAGES_ERROR,
      });
    });
  }

  test("new runtime-images reservations require at least one valid image ref", () => {
    const store = registry();
    const conversation = store.ensureConversation("claude", "/empty-image-reservation.jsonl", "default");

    expect(() => store.holdDelivery(
      conversation.id,
      "caption",
      "empty-runtime-images",
      "runtime-images",
      [],
      structuredContent("caption", []).contentDigest,
    )).toThrow("runtime-images delivery requires image references");
  });

  test("held delivery captions share one UTF-8 envelope bound across payload kinds", () => {
    const store = registry();
    const conversation = store.ensureConversation("claude", "/caption-envelope.jsonl", "default");
    const refs = [{ sha256: "c".repeat(64), mime: "image/png" as const, bytes: 67 }];
    /* 32001 UTF-8 bytes in 10667 UTF-16 units: the legacy length gate missed
       this, and the runtime-images kind skipped the gate entirely. */
    const oversized = "€".repeat(10_667);
    expect(() => store.holdDelivery(conversation.id, oversized, "caption-overflow", "runtime-images", refs, "d".repeat(64)))
      .toThrow("32000-byte envelope");
    expect(() => store.holdDelivery(conversation.id, oversized, "text-overflow"))
      .toThrow("32000-byte envelope");

    const boundary = "€".repeat(10_666) + "aa";
    expect(store.holdDelivery(conversation.id, boundary, "caption-boundary", "runtime-images", refs, "e".repeat(64)))
      .toMatchObject({ state: "assigned" });
    expect(store.holdDelivery(conversation.id, "", "image-only", "runtime-images", refs, "f".repeat(64)))
      .toMatchObject({ state: "assigned" });
  });

  test("startup compaction bounds abandoned failed reservations and leaves capacity", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/failed-deliveries.jsonl", "default");
    const generationId = conversation.generations.at(-1)!.id;
    for (let index = 0; index < 105; index += 1) {
      const queued = store.holdDelivery(conversation.id, `failed body ${index}`, `failed-${index}`);
      store.beginDeliveryAttempt(queued.id, generationId);
      store.recordDeliveryOutcome(queued.id, "failed", "host unavailable");
    }

    const failed = store.pendingDeliveries(conversation.id);
    expect(failed).toHaveLength(50);
    expect(failed.every((delivery) => delivery.state === "failed")).toBe(true);
    expect(store.holdDelivery(conversation.id, "new body", "new-after-failures")).toMatchObject({ state: "assigned" });
  });

  test("startup compaction stores normalized snapshots sparsely without changing durable state", () => {
    const store = registry();
    store.ensureConversation("codex", "/sessions/compact-a.jsonl", "default");
    store.ensureConversation("claude", "/sessions/compact-b.jsonl", "work");
    const expected = store.snapshot();
    fs.writeFileSync(store.filename, JSON.stringify(expected, null, 2) + "\n");
    const verboseBytes = fs.statSync(store.filename).size;

    const restarted = new AgentRegistry(store.filename);
    const compactPayload = fs.readFileSync(store.filename, "utf8");

    expect(fs.statSync(store.filename).size).toBeLessThan(verboseBytes);
    expect(compactPayload).not.toContain("\n  \"entries\"");
    expect(compactPayload).not.toContain("\"model\":null");
    expect(restarted.snapshot()).toEqual(expected);
  });

  test("startup removes registry temp files only after their writer exits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-tmp-"));
    const filename = path.join(dir, "agent-registry.json");
    const deadWriter = `${filename}.42.11111111-1111-4111-8111-111111111111.tmp`;
    const liveWriter = `${filename}.43.22222222-2222-4222-8222-222222222222.tmp`;
    fs.writeFileSync(deadWriter, "dead writer");
    fs.writeFileSync(liveWriter, "live writer");

    new AgentRegistry(filename, (owner) => owner.pid === 43);

    expect(fs.existsSync(deadWriter)).toBeFalse();
    expect(fs.existsSync(liveWriter)).toBeTrue();
  });

  test("account-retirement compensation preserves unrelated concurrent mutations", () => {
    const store = registry();
    store.setEngineRouting("codex", "work");
    const before = store.snapshot();
    store.retireAccount("codex", "work", "default");
    const retired = store.snapshot();
    store.setAutoBalancePolicy("claude", false, store.autoBalancePolicy("claude").revision);

    store.restoreSnapshot(retired, before);

    expect(store.engineRouting("codex").activeAccountId).toBe("work");
    expect(store.autoBalancePolicy("claude").enabled).toBeFalse();
  });

  test("writes receipts and a canonical atomic entry", () => {
    const store = registry();
    const receipt = store.beginSpawn("codex", "/repo");
    const entry = store.completeSpawn(receipt.launchId, {
      key: KEY, artifactPath: "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl", cwd: "/repo", accountId: null,
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
    });
    expect(entry.key).toEqual(KEY);
    expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("completed");
  });

  test("skips an atomic rewrite when a mutation leaves the registry unchanged", () => {
    const store = registry();
    store.setEngineRouting("codex", "work");
    const beforeBytes = fs.readFileSync(store.filename, "utf8");
    const before = fs.statSync(store.filename);
    const reads = spyOn(fs, "readFileSync");

    try {
      expect(store.releaseStructuredHostClaim(KEY, "missing-owner", 99)).toBeFalse();
      expect(reads.mock.calls.filter(([filename]) => filename === store.filename)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }

    const after = fs.statSync(store.filename);
    expect(fs.readFileSync(store.filename, "utf8")).toBe(beforeBytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("route settlement recovers when observation completed the same spawn first", () => {
    const store = registry();
    const receipt = store.beginSpawn("codex", "/repo");
    const entry = spawnEntry("/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl");

    expect(store.completeObservedSpawn(receipt.launchId, entry).kind).toBe("settled");
    const route = store.settleSpawn(receipt.launchId, entry);

    expect(route.kind).toBe("settled");
    expect(route.receipt.state).toBe("completed");
    expect(route.receipt.completionMode).toBe("route-recovered");
  });

  test("an observed account-home Claude session recovers a pane-bound late-readiness failure", () => {
    const store = registry();
    const sessionId = "88d36d1d-d681-4dc3-ac3b-0b0c54f33c7e";
    const artifactPath = `/home/user/.config/agent-log-viewer/accounts/claude/work/projects/-repo/${sessionId}.jsonl`;
    const begun = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      accountId: "work",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const pane = {
      endpoint: "/run/user/1000/agent-log-viewer",
      server: { pid: 900, startIdentity: "900:one" },
      paneId: "%25",
      panePid: { pid: 100, startIdentity: "100:one" },
      target: "agents:17.0",
    };
    store.bindSpawnPane(begun.receipt.launchId, pane);
    store.failSpawn(begun.receipt.launchId, "agent never reached a launch-ready prompt");

    const observed = store.completeObservedSpawn(begun.receipt.launchId, {
      key: { engine: "claude", sessionId },
      artifactPath,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: {
        kind: "tmux",
        ...pane,
        windowName: "claude-new",
        agent: { pid: 101, startIdentity: "101:one" },
        argv: ["claude", "--session-id", sessionId],
      },
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(observed).toMatchObject({
      kind: "settled",
      receipt: { state: "completed", artifactPath, key: { engine: "claude", sessionId } },
      entry: { host: { paneId: "%25", argv: ["claude", "--session-id", sessionId] } },
    });
    expect(store.conversationForPath(artifactPath)?.id).toBe(begun.receipt.conversationId);
  });

  test("live pane evidence releases a readiness quarantine and preserves hard identity fences", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (begun.kind !== "created") throw new Error("expected create");
    const binding = {
      endpoint: "/tmp",
      server: { pid: 900, startIdentity: null },
      paneId: "%25",
      panePid: { pid: 100, startIdentity: null },
      target: "agents:17.0",
    };
    const host = {
      kind: "tmux" as const,
      endpoint: "/tmp",
      server: { pid: 900, startIdentity: "900:observed" },
      paneId: "%25",
      panePid: { pid: 100, startIdentity: "100:observed" },
      windowName: "claude-new",
      agent: { pid: 101, startIdentity: "101:observed" },
      argv: ["claude", "--session-id", "88d36d1d-d681-4dc3-ac3b-0b0c54f33c7e"],
    };
    store.bindSpawnPane(begun.receipt.launchId, binding);
    store.failSpawn(begun.receipt.launchId, "agent never reached a launch-ready prompt");

    expect(store.confirmSpawnPaneAlive(begun.receipt.launchId, host, { engine: "claude", cwd: "/repo" })).toMatchObject({
      state: "host-verified",
      error: null,
      verifiedHost: host,
    });

    const fenced = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (fenced.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(fenced.receipt.launchId, binding);
    store.invalidateSpawnHost(fenced.receipt.launchId, "spawn_host_identity_conflict");
    expect(store.confirmSpawnPaneAlive(fenced.receipt.launchId, host, { engine: "claude", cwd: "/repo" })).toMatchObject({
      state: "conflicted",
      error: "spawn_host_identity_conflict",
    });

    const authFailure = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (authFailure.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(authFailure.receipt.launchId, binding);
    store.failSpawn(authFailure.receipt.launchId, "Claude account work needs re-login. Open Accounts, sign in, and retry.");
    expect(store.confirmSpawnPaneAlive(authFailure.receipt.launchId, host, { engine: "claude", cwd: "/repo" })).toMatchObject({
      state: "conflicted",
      error: "Claude account work needs re-login. Open Accounts, sign in, and retry.",
    });

    const changedHost = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (changedHost.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(changedHost.receipt.launchId, binding);
    store.failSpawn(changedHost.receipt.launchId, "spawn host identity changed before launch confirmation");
    expect(store.confirmSpawnPaneAlive(changedHost.receipt.launchId, host, { engine: "claude", cwd: "/repo" })).toMatchObject({
      state: "conflicted",
      error: "spawn host identity changed before launch confirmation",
    });
  });

  test("a verified ready-composer host stays available after prompt verification fails", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (begun.kind !== "created") throw new Error("expected create");
    const binding = {
      endpoint: "/tmp",
      server: { pid: 900, startIdentity: "900:one" },
      paneId: "%25",
      panePid: { pid: 100, startIdentity: "100:one" },
      target: "agents:17.0",
    };
    const host = {
      kind: "tmux" as const,
      endpoint: "/tmp",
      server: binding.server,
      paneId: binding.paneId,
      panePid: binding.panePid,
      windowName: "claude-new",
      agent: { pid: 101, startIdentity: "101:one" },
      argv: ["claude", "--session-id", "88d36d1d-d681-4dc3-ac3b-0b0c54f33c7e"],
    };
    store.bindSpawnPane(begun.receipt.launchId, binding);
    store.markSpawnHostVerified(begun.receipt.launchId, host);
    store.failSpawn(begun.receipt.launchId, "launch prompt was not accepted by the agent: ready composer");

    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "host-verified",
      error: "launch prompt was not accepted by the agent: ready composer",
      verifiedHost: host,
    });
    store.failSpawn(begun.receipt.launchId, "tmux paste failed after ready composer");
    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "host-verified",
      error: "tmux paste failed after ready composer",
      verifiedHost: host,
    });

    const authFailure = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (authFailure.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(authFailure.receipt.launchId, binding);
    store.markSpawnHostVerified(authFailure.receipt.launchId, host);
    store.invalidateSpawnHost(authFailure.receipt.launchId, "Claude account work needs re-login. Open Accounts, sign in, and retry.");
    store.failSpawn(authFailure.receipt.launchId, "Claude account work needs re-login. Open Accounts, sign in, and retry.");
    expect(store.snapshot().receipts[authFailure.receipt.launchId]).toMatchObject({
      state: "conflicted",
      error: "Claude account work needs re-login. Open Accounts, sign in, and retry.",
      verifiedHost: null,
    });
  });

  test("serializes durable operations", async () => {
    const store = registry();
    store.upsert({ key: KEY, artifactPath: "/a", cwd: "/repo", accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    expect(await store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => "done")).toBe("done");
    await expect(store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("queues a transiently contended operation lock", async () => {
    const store = registry();
    const owner = { pid: process.pid, startIdentity: null };
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = store.withOperationLock(KEY, owner, async () => {
      events.push("first-started");
      await firstGate;
      events.push("first-finished");
    });
    await Bun.sleep(0);
    const second = store.withOperationLock(KEY, owner, async () => {
      events.push("second-started");
    });

    await Bun.sleep(10);
    expect(events).toEqual(["first-started"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-started", "first-finished", "second-started"]);
  });

  test("waits beyond the complete delivery retry budget for a valid operation holder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-long-lock-"));
    const filename = path.join(dir, "agent-registry.json");
    let elapsedMs = 0;
    let lock = "";
    const store = new AgentRegistry(filename, () => true, {
      now: () => elapsedMs,
      wait: async (delayMs) => {
        elapsedMs += delayMs;
        if (elapsedMs >= 180_000) fs.rmSync(lock, { recursive: true, force: true });
      },
    });
    lock = `${store.filename}.locks/${encodeURIComponent("codex:long-holder")}`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:holder" }));

    const result = await store.withOperationLock(
      { engine: "codex", sessionId: "long-holder" },
      { pid: process.pid, startIdentity: null },
      async () => "completed",
    );

    expect(result).toBe("completed");
    expect(elapsedMs).toBeGreaterThanOrEqual(180_000);
  });

  test("preserves an ownerless legacy publisher beyond the former grace period", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-paused-legacy-publisher-"));
    const filename = path.join(dir, "agent-registry.json");
    let nowMs = Date.now();
    let waits = 0;
    const store = new AgentRegistry(filename, (owner) => owner.startIdentity === "42:legacy", {
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
        waits += 1;
        expect(fs.statSync(lock).ino).toBe(legacyIdentity.ino);
        if (waits === 1) {
          fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:legacy" }));
        } else {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      },
    });
    const lock = `${store.filename}.locks/${encodeURIComponent("codex:paused-legacy-publisher")}`;
    fs.mkdirSync(lock, { recursive: true });
    const legacyIdentity = fs.statSync(lock);
    const pausedAt = new Date(nowMs - 2_000);
    fs.utimesSync(lock, pausedAt, pausedAt);

    const result = await store.withOperationLock(
      { engine: "codex", sessionId: "paused-legacy-publisher" },
      { pid: process.pid, startIdentity: null },
      async () => "completed",
    );

    expect(result).toBe("completed");
    expect(waits).toBe(2);
  });

  test("publishes a macOS-compatible lock owner without Linux procfs", async () => {
    const store = registry();
    const lock = `${store.filename}.locks/${encodeURIComponent("codex:portable-publication")}`;
    const originalLink = fs.linkSync;
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(newPath).startsWith("/proc/self/fd/")) {
        const error = new Error("procfs is unavailable") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return originalLink(existingPath, newPath);
    }) as typeof fs.linkSync;

    try {
      await expect(store.withOperationLock(
        { engine: "codex", sessionId: "portable-publication" },
        { pid: process.pid, startIdentity: null },
        async () => {
          expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
          expect(fs.statSync(lock).isDirectory()).toBe(true);
          expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
          return "completed";
        },
      )).resolves.toBe("completed");
    } finally {
      fs.linkSync = originalLink;
    }
    expect(fs.readdirSync(path.dirname(lock)).filter((entry) => entry.includes(".owner.pending-"))).toEqual([]);
  });

  test("a delayed publisher cannot overwrite a replacement owner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-delayed-publisher-"));
    const filename = path.join(dir, "agent-registry.json");
    const lock = `${filename}.locks/${encodeURIComponent("codex:delayed-publisher")}`;
    const replacementToken = "44444444-4444-4444-8444-444444444444";
    let observedReplacement = false;
    const store = new AgentRegistry(filename, (owner) => owner.startIdentity === "43:replacement", {
      now: () => Date.now(),
      wait: async () => {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        expect(owner.token).toBe(replacementToken);
        observedReplacement = true;
        fs.rmSync(lock, { recursive: true, force: true });
      },
    });
    const originalSymlink = fs.symlinkSync;
    let injected = false;
    fs.symlinkSync = ((target: fs.PathLike, newPath: fs.PathLike, type?: fs.symlink.Type) => {
      if (!injected && String(newPath) === lock) {
        injected = true;
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
          pid: 43,
          startIdentity: "43:replacement",
          token: replacementToken,
        }));
      }
      return originalSymlink(target, newPath, type);
    }) as typeof fs.symlinkSync;

    try {
      await store.withOperationLock(
        { engine: "codex", sessionId: "delayed-publisher" },
        { pid: process.pid, startIdentity: null },
        async () => undefined,
      );
    } finally {
      fs.symlinkSync = originalSymlink;
    }

    expect(observedReplacement).toBe(true);
  });

  test("publication preserves an empty lock directory owned by a delayed legacy writer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-legacy-publisher-"));
    const filename = path.join(dir, "agent-registry.json");
    const lock = `${filename}.locks/${encodeURIComponent("codex:legacy-publisher")}`;
    let observedLegacyLock = false;
    const store = new AgentRegistry(filename, () => true, {
      now: () => Date.now(),
      wait: async () => {
        expect(fs.statSync(lock).isDirectory()).toBe(true);
        expect(fs.readdirSync(lock)).toEqual([]);
        observedLegacyLock = true;
        fs.rmSync(lock, { recursive: true, force: true });
      },
    });
    const originalOpen = fs.openSync;
    let injected = false;
    fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!injected && String(target).startsWith(lock) && String(target).includes("owner")) {
        injected = true;
        fs.mkdirSync(lock);
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync;

    try {
      await store.withOperationLock(
        { engine: "codex", sessionId: "legacy-publisher" },
        { pid: process.pid, startIdentity: null },
        async () => undefined,
      );
    } finally {
      fs.openSync = originalOpen;
    }

    expect(observedLegacyLock).toBe(true);
  });

  test("a pinned-base reader can inspect a newly published lock owner", async () => {
    const store = registry();
    const lock = `${store.filename}.locks/${encodeURIComponent("codex:legacy-reader")}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const operation = store.withOperationLock(
      { engine: "codex", sessionId: "legacy-reader" },
      { pid: process.pid, startIdentity: null },
      async () => { await held; },
    );
    await Bun.sleep(0);

    expect(fs.statSync(lock).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))).toEqual(expect.objectContaining({
      pid: process.pid,
      token: expect.any(String),
    }));

    release();
    await operation;
  });

  test("a delayed stale contender preserves the replacement lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-stale-race-"));
    const filename = path.join(dir, "agent-registry.json");
    const staleToken = "11111111-1111-4111-8111-111111111111";
    const replacementToken = "22222222-2222-4222-8222-222222222222";
    const lock = `${filename}.locks/${encodeURIComponent("codex:stale-race")}`;
    let raced = false;
    const store = new AgentRegistry(filename, (owner) => {
      if (owner.startIdentity === "42:stale" && !raced) {
        raced = true;
        fs.renameSync(lock, `${lock}.retired-${staleToken}`);
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
          pid: 43,
          startIdentity: "43:replacement",
          token: replacementToken,
        }));
        return false;
      }
      return owner.startIdentity === "43:replacement";
    }, {
      now: () => Date.now(),
      wait: async () => {
        expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token).toBe(replacementToken);
        fs.rmSync(lock, { recursive: true, force: true });
      },
    });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      pid: 42,
      startIdentity: "42:stale",
      token: staleToken,
    }));

    await expect(store.withOperationLock(
      { engine: "codex", sessionId: "stale-race" },
      { pid: process.pid, startIdentity: null },
      async () => "completed",
    )).resolves.toBe("completed");
  });

  test("stale recovery preserves a replacement acquired during the liveness check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-liveness-race-"));
    const filename = path.join(dir, "agent-registry.json");
    const staleToken = "66666666-6666-4666-8666-666666666666";
    const replacementToken = "77777777-7777-4777-8777-777777777777";
    const lock = `${filename}.locks/${encodeURIComponent("codex:liveness-race")}`;
    let raced = false;
    let replacementMoved = false;
    const store = new AgentRegistry(filename, (owner) => {
      if (owner.startIdentity === "42:stale" && !raced) {
        raced = true;
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
          pid: 43,
          startIdentity: "43:replacement",
          token: replacementToken,
        }));
        return false;
      }
      return owner.startIdentity === "43:replacement";
    }, {
      now: () => Date.now(),
      wait: async () => {
        const retired = `${lock}.retired-${staleToken}`;
        replacementMoved = !fs.existsSync(lock) && fs.existsSync(retired);
        const replacementPath = replacementMoved ? retired : lock;
        expect(JSON.parse(fs.readFileSync(path.join(replacementPath, "owner.json"), "utf8")).token).toBe(replacementToken);
        fs.rmSync(replacementPath, { recursive: true, force: true });
      },
    });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      pid: 42,
      startIdentity: "42:stale",
      token: staleToken,
    }));

    await store.withOperationLock(
      { engine: "codex", sessionId: "liveness-race" },
      { pid: process.pid, startIdentity: null },
      async () => undefined,
    );

    expect(raced).toBe(true);
    expect(replacementMoved).toBe(false);
  });

  test("interrupted recovery preserves a replacement acquired during the liveness check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-interrupted-recovery-race-"));
    const filename = path.join(dir, "agent-registry.json");
    const publishedToken = "88888888-8888-4888-8888-888888888888";
    const recoveryToken = "99999999-9999-4999-8999-999999999999";
    const replacementToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const lock = `${filename}.locks/${encodeURIComponent("codex:interrupted-recovery-race")}`;
    const recovery = `${lock}.recovering`;
    let raced = false;
    const store = new AgentRegistry(filename, (owner) => {
      if (owner.startIdentity === "42:published" && !raced) {
        raced = true;
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
          pid: 43,
          startIdentity: "43:replacement",
          token: replacementToken,
        }));
        return false;
      }
      return owner.startIdentity === "43:replacement";
    }, {
      now: () => Date.now(),
      wait: async () => {
        expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token).toBe(replacementToken);
        fs.rmSync(lock, { recursive: true, force: true });
      },
    });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      pid: 42,
      startIdentity: "42:published",
      token: publishedToken,
    }));
    fs.mkdirSync(recovery);
    fs.writeFileSync(path.join(recovery, "owner.json"), JSON.stringify({
      pid: 41,
      startIdentity: "41:recovery",
      token: recoveryToken,
    }));

    await store.withOperationLock(
      { engine: "codex", sessionId: "interrupted-recovery-race" },
      { pid: process.pid, startIdentity: null },
      async () => undefined,
    );

    const retired = `${lock}.retired-${publishedToken}`;
    const replacementMoved = fs.existsSync(retired)
      && JSON.parse(fs.readFileSync(path.join(retired, "owner.json"), "utf8")).token === replacementToken;
    expect(raced).toBe(true);
    expect(replacementMoved).toBe(false);
    fs.rmSync(retired, { recursive: true, force: true });
  });

  test("an old claim cannot release a replacement lock", async () => {
    const store = registry();
    const lock = `${store.filename}.locks/${encodeURIComponent("codex:replacement")}`;
    const replacementToken = "33333333-3333-4333-8333-333333333333";

    await store.withOperationLock(
      { engine: "codex", sessionId: "replacement" },
      { pid: process.pid, startIdentity: null },
      async () => {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
          pid: process.pid,
          startIdentity: null,
          token: replacementToken,
        }));
      },
    );

    expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token).toBe(replacementToken);
    fs.rmSync(lock, { recursive: true, force: true });
  });

  test("reclaims a lock only after its recorded process identity is stale", () => {
    const store = registry(() => false);
    const lock = `${store.filename}.write-lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:old" }));
    expect(() => store.beginSpawn("codex", "/repo")).not.toThrow();
  });

  test("waits through transient write-lock contention", () => {
    let livenessChecks = 0;
    const store = registry(() => {
      livenessChecks += 1;
      return livenessChecks <= 100;
    });
    const lock = `${store.filename}.write-lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:writer" }));

    expect(() => store.setEngineRouting("codex", "work")).not.toThrow();
    expect(livenessChecks).toBeGreaterThan(100);
    expect(store.engineRouting("codex").activeAccountId).toBe("work");
  });

  test("waits for an interprocess write owner beyond the former deadline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-interprocess-lock-"));
    const filename = path.join(dir, "agent-registry.json");
    const lock = `${filename}.write-lock`;
    const store = new AgentRegistry(filename);
    const child = Bun.spawn([process.execPath, "-e", `
      const fs = require("node:fs");
      const path = require("node:path");
      const lock = process.env.LOCK_PATH;
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
        pid: process.pid,
        startIdentity: null,
        token: "55555555-5555-4555-8555-555555555555",
      }));
      process.stdout.write("ready\\n");
      setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 8_500);
    `], {
      env: { ...process.env, LOCK_PATH: lock },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");

    try {
      const startedAt = Date.now();
      expect(() => store.setEngineRouting("codex", "work")).not.toThrow();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8_400);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(store.engineRouting("codex").activeAccountId).toBe("work");
  }, 15_000);

  test("preserves corrupt registry bytes and rejects mutation", () => {
    const store = registry();
    fs.mkdirSync(path.dirname(store.filename), { recursive: true });
    fs.writeFileSync(store.filename, "{ broken");
    expect(() => store.beginSpawn("codex", "/repo")).toThrow("cannot be read");
    expect(fs.readFileSync(store.filename, "utf8")).toBe("{ broken");
  });

  test.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects persisted non-safe structured event cursor %p without rewriting it",
    (eventCursor) => {
      const store = registry();
      store.upsert({
        ...spawnEntry("/repo/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl"),
        structuredHost: {
          kind: "codex-app-server",
          endpoint: "stdio:released",
          process: null,
          eventCursor: 0,
          protocolVersion: "0.144.1",
          writerClaimEpoch: 1,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
      });
      const persisted = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
        entries: Record<string, { structuredHost: { eventCursor: number } }>;
      };
      persisted.entries[`codex:${KEY.sessionId}`]!.structuredHost.eventCursor = eventCursor;
      const invalidBytes = `${JSON.stringify(persisted)}\n`;
      fs.writeFileSync(store.filename, invalidBytes);

      const reloaded = new AgentRegistry(store.filename);
      expect(() => reloaded.snapshot()).toThrow("structured host event cursor is invalid");
      expect(fs.readFileSync(store.filename, "utf8")).toBe(invalidBytes);
    },
  );

  test("upgrades v1, retains stable identity, and commits an A to B to A generation chain", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({ version: 1, entries: {}, receipts: {}, importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} } }));
    const conversation = store.ensureConversation("codex", "/a.jsonl", "a");
    expect(store.snapshot().version).toBe(2);
    store.setConversationMigration(conversation.id, { intentId: "intent-a", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: new Date().toISOString() });
    store.commitSuccessor(conversation.id, { id: "native-b", path: "/b.jsonl", accountId: "b" }, 1);
    store.setConversationMigration(conversation.id, { intentId: "intent-b", phase: "verifying", targetId: "a", revision: 2, error: null, updatedAt: new Date().toISOString() });
    const final = store.commitSuccessor(conversation.id, { id: "native-a2", path: "/a2.jsonl", accountId: "a" }, 2);
    expect(final.id).toBe(conversation.id);
    expect(final.generations.map((generation) => generation.path)).toEqual(["/a.jsonl", "/b.jsonl", "/a2.jsonl"]);
    expect(store.canonicalPath("/a.jsonl")).toBe("/a2.jsonl");
  });

  test("provisional migration paths retain one stable conversation owner", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    store.recordConversationContinuityPath(source.id, "/source-account/fork.jsonl");

    store.reconcileConversations([{
      engine: "codex",
      path: "/source-account/fork.jsonl",
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    }]);

    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    expect(store.conversationForPath("/source-account/fork.jsonl")?.id).toBe(source.id);
    expect(store.canonicalPath("/source-account/fork.jsonl")).toBe("/source.jsonl");

    store.setConversationMigration(source.id, {
      intentId: "later-intent",
      phase: "requested",
      targetId: "c",
      revision: 2,
      error: null,
      updatedAt: "2026-07-10T12:02:00.000Z",
    });
    expect(store.conversationForPath("/source-account/fork.jsonl")?.id).toBe(source.id);
  });

  test("a stale inventory observation preserves a newer turn state", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/turn-race.jsonl", "a");
    const observe = (state: "idle" | "busy", observedAt: string) => store.reconcileConversations([{
      engine: "codex",
      path: "/turn-race.jsonl",
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state, source: "empty" as const, terminalAt: null },
      observedAt,
    }]);

    observe("busy", "2026-07-14T12:00:01.000Z");
    observe("idle", "2026-07-14T12:00:00.000Z");

    expect(store.conversation(conversation.id)?.turn).toEqual({
      state: "busy",
      source: "empty",
      terminalAt: null,
      observedAt: "2026-07-14T12:00:01.000Z",
    });
  });

  test("migration provenance adopts a path allocated by a concurrent inventory scan", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    const targetPath = "/target-account/fork.jsonl";
    store.reconcileConversations([{
      engine: "codex",
      path: targetPath,
      accountId: "b",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    }]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(2);

    const beforeAdoption = store.snapshot();
    store.recordConversationContinuityPath(source.id, targetPath);

    const adopted = store.snapshot();
    expect(Object.values(adopted.conversations)).toHaveLength(1);
    expect(store.conversationForPath(targetPath)?.id).toBe(source.id);
    expect(store.canonicalPath(targetPath)).toBe("/source.jsonl");
    expect(adopted.conversationRevision.codex).toBe(beforeAdoption.conversationRevision.codex + 1);
    expect(adopted.engineRouting.codex.revision).toBe(beforeAdoption.engineRouting.codex.revision + 1);
  });

  test("provisional adoption refreshes the pending resume fence within one inventory transaction", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-source-${nativeId}.jsonl`;
    const resumedPath = `/sessions/2026/07/12/rollout-resumed-${nativeId}.jsonl`;
    const canonical = store.ensureConversation("codex", sourcePath, "a");
    store.setConversationMigration(canonical.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
    const persisted = store.snapshot();
    const provisionalId = `conversation_${crypto.randomUUID()}` as const;
    persisted.conversations[provisionalId] = {
      ...structuredClone(persisted.conversations[canonical.id]!),
      id: provisionalId,
      generations: [{
        ...structuredClone(persisted.conversations[canonical.id]!.generations[0]!),
        path: sourcePath,
      }],
      continuityPaths: [],
      migration: null,
    };
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "a",
      conversationId: provisionalId,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const observation = (pathname: string) => ({
      engine: "codex" as const,
      path: pathname,
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt: "2026-07-14T12:01:00.000Z",
    });

    store.reconcileConversations([observation(sourcePath), observation(resumedPath)]);

    expect(store.conversation(canonical.id)?.generations[0]?.path).toBe(sourcePath);
    expect(store.conversation(canonical.id)?.continuityPaths).toEqual([]);
    expect(store.conversationForPath(resumedPath)).toBeNull();
    expect(store.snapshot().receipts[begun.receipt.launchId]?.conversationId).toBe(canonical.id);
  });

  test("validated provider provenance survives migration retarget and stop", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    store.setConversationMigration(source.id, {
      intentId: "replacement",
      phase: "rolled-back",
      targetId: "c",
      revision: 2,
      error: null,
      updatedAt: "2026-07-10T12:01:00.000Z",
    });

    store.recordConversationContinuityPath(source.id, "/late-provider-artifact.jsonl");

    expect(store.conversationForPath("/late-provider-artifact.jsonl")?.id).toBe(source.id);
  });

  test("coalesces durable intents and enforces policy compare-and-set", () => {
    const store = registry();
    const first = store.upsertMigrationIntent("claude", "a", "auto", "first");
    const latest = store.upsertMigrationIntent("claude", "b", "manual", "second");
    expect(latest.id).toBe(first.id);
    expect(latest.targetId).toBe("b");
    expect(latest.revision).toBe(2);
    expect(() => store.setAutoBalancePolicy("claude", true, 1)).toThrow("revision is stale");
    expect(store.setAutoBalancePolicy("claude", true, 0).enabled).toBe(true);
  });

  test("normalizes legacy v2 migration fields for restart recovery", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy.jsonl", "a");
    store.setConversationMigration(conversation.id, {
      intentId: "legacy-intent",
      phase: "requested",
      targetId: "b",
      revision: 3,
      error: null,
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as { conversations: Record<string, { migration: Record<string, unknown> }> };
    delete raw.conversations[conversation.id]!.migration.operationId;
    delete raw.conversations[conversation.id]!.migration.sourceGenerationId;
    delete raw.conversations[conversation.id]!.migration.providerReceipt;
    delete raw.conversations[conversation.id]!.migration.errorCode;
    fs.writeFileSync(store.filename, JSON.stringify(raw));

    const recovered = new AgentRegistry(store.filename).conversation(conversation.id)!;
    expect(recovered.migration).toMatchObject({
      operationId: `legacy-intent:${conversation.id}:3`,
      sourceGenerationId: recovered.generations[0]!.id,
      providerReceipt: null,
      errorCode: null,
    });
  });

  test("replays one client attempt, reserves its stable conversation, and rejects a changed request", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("expected create");
    const replay = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(replay).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId, conversationId: first.receipt.conversationId } });
    const conflict = store.beginSpawnRequest({ engine: "codex", cwd: "/other", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-b" });
    expect(conflict.kind).toBe("conflict");
  });

  test("spawn idempotency includes effective permission mode and reserved transport", () => {
    const store = registry();
    const request = {
      engine: "claude" as const,
      cwd: "/repo",
      accountId: "work",
      clientAttemptId: "attempt_permission_mode",
      requestDigest: "same-public-shape",
      transport: "structured" as const,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "bypassPermissions" }),
    };
    const first = store.beginSpawnRequest(request);
    if (first.kind !== "created") throw new Error("expected create");

    expect(store.beginSpawnRequest(request)).toMatchObject({
      kind: "replay",
      receipt: { launchId: first.receipt.launchId },
    });
    expect(store.beginSpawnRequest({
      ...request,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "default" }),
    }).kind).toBe("conflict");
    expect(store.beginSpawnRequest({ ...request, transport: "tmux" }).kind).toBe("conflict");
  });

  test("structured admission recovery fences a live owner and adopts a recycled pid", () => {
    const store = registry((owner) =>
      owner.pid === process.pid || (owner.pid === 987_654 && owner.startIdentity === "987654:new"));
    const begun = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      accountId: "work",
      clientAttemptId: "attempt_admission_owner",
      requestDigest: "digest",
      transport: "structured",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const snapshot = store.snapshot();
    snapshot.receipts[begun.receipt.launchId]!.admissionOwner = {
      pid: 987_654,
      startIdentity: "987654:new",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    expect(store.claimStartingStructuredSpawn(begun.receipt.launchId)).toMatchObject({
      claimed: false,
      receipt: { admissionOwner: { pid: 987_654, startIdentity: "987654:new" } },
    });

    snapshot.receipts[begun.receipt.launchId]!.admissionOwner = {
      pid: 987_654,
      startIdentity: "987654:old",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    expect(store.claimStartingStructuredSpawn(begun.receipt.launchId)).toMatchObject({
      claimed: true,
      receipt: { admissionOwner: { pid: process.pid } },
    });
  });

  test("a claimed structured admission releases only through its exact owner", () => {
    const store = registry((owner) => owner.pid === process.pid && owner.startIdentity === null);
    const begun = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      accountId: "work",
      clientAttemptId: "attempt_admission_release",
      requestDigest: "digest",
      transport: "structured",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const launchId = begun.receipt.launchId;
    const claimedOwner = begun.receipt.admissionOwner!;

    /* A raced release from another process identity is a no-op: the lease
       stays with its claimant. */
    expect(store.releaseStartingStructuredSpawn(launchId, { pid: 987_654, startIdentity: "987654:other" }))
      .toMatchObject({ released: false, receipt: { admissionOwner: { pid: process.pid } } });

    /* The exact owner hands the lease back and the receipt stays starting. */
    expect(store.releaseStartingStructuredSpawn(launchId, claimedOwner))
      .toMatchObject({ released: true, receipt: { admissionOwner: null, state: "starting" } });

    /* A released lease is immediately re-claimable — the retry path. */
    const reclaimed = store.claimStartingStructuredSpawn(launchId);
    expect(reclaimed).toMatchObject({ claimed: true, receipt: { admissionOwner: { pid: process.pid } } });

    /* A double release with the stale first-claim owner cannot strip the new
       claimant's lease when identities differ, and a settled receipt refuses
       release outright. */
    store.settleSpawn(launchId, {
      key: { engine: "claude", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
      artifactPath: "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
      cwd: "/repo",
      accountId: "work",
      status: "starting",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    expect(store.releaseStartingStructuredSpawn(launchId, reclaimed.receipt.admissionOwner!))
      .toMatchObject({ released: false });
  });

  test("spawn capability digest durably resolves its reserved conversation", () => {
    const store = registry();
    const digest = "a".repeat(64);
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      spawnCapabilityDigest: digest,
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(new AgentRegistry(store.filename).conversationIdForSpawnCapabilityDigest(digest))
      .toBe(begun.receipt.conversationId);
    expect(store.conversationIdForSpawnCapabilityDigest("b".repeat(64))).toBeNull();
  });

  test("restart inventory recovers a path-pending Codex receipt after its pane exits", () => {
    const store = registry();
    const parentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
      parentArtifactPath: parentPath,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(begun.receipt.launchId, {
      endpoint: "/tmp",
      server: { pid: 9, startIdentity: "9:a" },
      paneId: "%9",
      panePid: { pid: 99, startIdentity: "99:a" },
      target: "agents:9.0",
    });
    store.markSpawnHostVerified(begun.receipt.launchId, {
      kind: "tmux",
      endpoint: "/tmp",
      server: { pid: 9, startIdentity: "9:a" },
      paneId: "%9",
      panePid: { pid: 99, startIdentity: "99:a" },
      windowName: "codex-new",
      agent: { pid: 100, startIdentity: "100:a" },
      argv: ["codex"],
    });
    store.markSpawnPromptDelivered(begun.receipt.launchId);
    const pending = store.markSpawnPathPending(begun.receipt.launchId);
    const startedAt = new Date(Date.parse(pending.pathCorrelation!.startedAt) + 1_000).toISOString();

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt,
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(restarted.conversationForPath(childPath)?.id).toBe(begun.receipt.conversationId);
    expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "completed",
      artifactPath: childPath,
      completionMode: "observed-completed",
    });
    expect(restarted.snapshot().lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      parentArtifactPath: parentPath,
      evidence: { launchId: begun.receipt.launchId },
    });
  });

  test("restart inventory pairs distinct same-cwd Codex windows and repairs provisional owners", () => {
    const store = registry();
    const parentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
    const childPaths = [
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
    ];
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const receipts = childPaths.map(() => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
      parentArtifactPath: parentPath,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
    }));
    if (receipts.some((receipt) => receipt.kind !== "created")) throw new Error("expected creates");
    const created = receipts.map((receipt) => {
      if (receipt.kind !== "created") throw new Error("expected create");
      return receipt.receipt;
    });
    const persisted = store.snapshot();
    const launchStarts = ["2026-07-12T12:00:00.000Z", "2026-07-12T12:00:40.000Z"];
    for (const [index, receipt] of created.entries()) {
      persisted.receipts[receipt.launchId]!.state = "path-pending";
      persisted.receipts[receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: launchStarts[index]! };
    }
    fs.writeFileSync(store.filename, JSON.stringify(persisted));

    const observations = childPaths.map((childPath, index) => ({
      engine: "codex" as const,
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      startedAt: index === 0 ? "2026-07-12T12:00:00.250Z" : "2026-07-12T12:00:40.250Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }));
    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations(observations.map((observation) => ({
      engine: observation.engine,
      path: observation.path,
      accountId: observation.accountId,
      launchProfile: observation.launchProfile,
      turn: observation.turn,
      observedAt: observation.observedAt,
    })));
    const provisionalIds = childPaths.map((childPath) => restarted.conversationForPath(childPath)!.id);
    expect(provisionalIds).not.toContain(created[0]!.conversationId);
    expect(provisionalIds).not.toContain(created[1]!.conversationId);

    restarted.reconcileConversations([...observations].reverse());
    expect(restarted.conversationForPath(childPaths[0]!)?.id).toBe(created[0]!.conversationId);
    expect(restarted.conversationForPath(childPaths[1]!)?.id).toBe(created[1]!.conversationId);
    expect(restarted.snapshot().receipts[created[0]!.launchId]).toMatchObject({ state: "completed", artifactPath: childPaths[0] });
    expect(restarted.snapshot().receipts[created[1]!.launchId]).toMatchObject({ state: "completed", artifactPath: childPaths[1] });
    expect(restarted.snapshot().lineageEdges[created[0]!.conversationId]).toMatchObject({
      parentConversationId: parent.id,
      childArtifactPath: childPaths[0],
      source: "viewer-spawn",
    });
    expect(restarted.snapshot().lineageEdges[created[1]!.conversationId]).toMatchObject({
      parentConversationId: parent.id,
      childArtifactPath: childPaths[1],
      source: "viewer-spawn",
    });

    restarted.reconcileConversations(observations);
    expect(restarted.conversationForPath(childPaths[0]!)?.id).toBe(created[0]!.conversationId);
    expect(restarted.conversationForPath(childPaths[1]!)?.id).toBe(created[1]!.conversationId);
    expect(Object.keys(restarted.snapshot().conversations)).not.toContain(provisionalIds[0]);
    expect(Object.keys(restarted.snapshot().conversations)).not.toContain(provisionalIds[1]);
  });

  test("path-pending adoption preserves a provisional owner's stopped-migration opt-out", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "source" });
    if (begun.kind !== "created") throw new Error("expected create");
    const persisted = store.snapshot();
    persisted.receipts[begun.receipt.launchId]!.state = "path-pending";
    persisted.receipts[begun.receipt.launchId]!.pathCorrelation = {
      cwd: "/repo",
      startedAt: "2026-07-12T12:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const observation = {
      engine: "codex" as const,
      path: childPath,
      accountId: "source",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt: "2026-07-12T12:01:00.000Z",
    };

    store.reconcileConversations([observation]);
    const provisional = store.conversationForPath(childPath)!;
    const intent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "target",
      origin: "auto",
      requestId: "auto-before-correlation",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    store.setMigrationIntentState(intent.id, "stopped", intent.revision);
    expect(store.conversation(provisional.id)?.migrationOptOut).toMatchObject({ targetId: "target" });

    store.reconcileConversations([{ ...observation, startedAt: "2026-07-12T12:00:01.000Z" }]);

    expect(store.conversationForPath(childPath)?.id).toBe(begun.receipt.conversationId);
    expect(store.conversation(begun.receipt.conversationId)?.migrationOptOut).toMatchObject({ targetId: "target" });
    const later = store.commitMigrationIntent({
      engine: "codex",
      targetId: "target",
      origin: "auto",
      requestId: "auto-after-correlation",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    expect(later.state).toBe("complete");
    expect(store.conversation(begun.receipt.conversationId)).toMatchObject({
      migration: null,
      migrationOptOut: { targetId: "target" },
    });
  });

  test("path-pending recovery partitions reversed Codex startup by birth account", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "b" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const persisted = store.snapshot();
    persisted.receipts[first.receipt.launchId]!.state = "path-pending";
    persisted.receipts[first.receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: "2026-07-12T12:00:00.000Z" };
    persisted.receipts[second.receipt.launchId]!.state = "path-pending";
    persisted.receipts[second.receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: "2026-07-12T12:00:01.000Z" };
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const firstPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "b",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt: "2026-07-12T12:00:02.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }, {
      engine: "codex",
      path: firstPath,
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt: "2026-07-12T12:00:10.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }]);

    expect(restarted.conversationForPath(firstPath)?.id).toBe(first.receipt.conversationId);
    expect(restarted.conversationForPath(secondPath)?.id).toBe(second.receipt.conversationId);
    expect(restarted.conversationForPath(firstPath)?.generations.at(-1)?.accountId).toBe("a");
    expect(restarted.conversationForPath(secondPath)?.generations.at(-1)?.accountId).toBe("b");
  });

  test("path-pending recovery leaves indistinguishable same-account launches unresolved", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const persisted = store.snapshot();
    for (const [index, receipt] of [first.receipt, second.receipt].entries()) {
      persisted.receipts[receipt.launchId]!.state = "path-pending";
      persisted.receipts[receipt.launchId]!.pathCorrelation = {
        cwd: "/repo",
        startedAt: index === 0 ? "2026-07-12T12:00:00.000Z" : "2026-07-12T12:00:01.000Z",
      };
    }
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const observations = [
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
    ].map((pathname, index) => ({
      engine: "codex" as const,
      path: pathname,
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      startedAt: index === 0 ? "2026-07-12T12:00:10.000Z" : "2026-07-12T12:00:02.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }));

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations(observations);

    expect(restarted.snapshot().receipts[first.receipt.launchId]).toMatchObject({ state: "path-pending", artifactPath: null });
    expect(restarted.snapshot().receipts[second.receipt.launchId]).toMatchObject({ state: "path-pending", artifactPath: null });
    expect(observations.map((observation) => restarted.conversationForPath(observation.path)?.id)).not.toContain(first.receipt.conversationId);
    expect(observations.map((observation) => restarted.conversationForPath(observation.path)?.id)).not.toContain(second.receipt.conversationId);
  });

  test("settles observer then route exactly once with receipt-owned account and profile", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({
      engine: "codex", cwd: "/repo", accountId: "terra", parentConversationId: "conversation_parent",
      parentSessionKey: { engine: "codex", sessionId: "parent-session" }, parentArtifactPath: "/sessions/parent-session.jsonl",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6", parentConversationId: "conversation_parent" }),
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const born = new AgentRegistry(store.filename).snapshot();
    expect(born.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: "conversation_parent",
      childSessionKey: null,
      parentSessionKey: { engine: "codex", sessionId: "parent-session" },
      childArtifactPath: null,
      parentArtifactPath: "/sessions/parent-session.jsonl",
      source: "viewer-spawn",
      evidence: { launchId: begun.receipt.launchId },
    });
    const receipt = store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
    expect(receipt.state).toBe("pane-bound");
    store.markSpawnPromptDelivered(receipt.launchId);
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const observed = store.completeObservedSpawn(receipt.launchId, {
      ...spawnEntry(path, "wrong-account"),
      host: { kind: "tmux", endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, windowName: "codex", agent: { pid: 100, startIdentity: "100:a" }, argv: ["codex"] },
    });
    expect(observed.kind).toBe("settled");
    const revisionAfterObservedSettlement = store.snapshot().conversationRevision.codex;
    const route = store.settleSpawn(receipt.launchId, spawnEntry(path));
    expect(route).toMatchObject({ kind: "settled", receipt: { completionMode: "route-recovered", accountId: "terra", conversationId: begun.receipt.conversationId } });
    const snapshot = store.snapshot();
    expect(snapshot.conversations[begun.receipt.conversationId]?.generations).toHaveLength(1);
    expect(snapshot.conversationRevision.codex).toBe(revisionAfterObservedSettlement);
    expect(snapshot.entries["codex:019f4906-3f67-7b72-9fbc-9ec3b5ad1326"]?.launchProfile?.parentConversationId).toBe("conversation_parent");
    expect(snapshot.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
      childArtifactPath: path,
    });
  });

  test("keeps one conversation identity through a controlled resume chain", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const thirdPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");

    for (const pathname of [secondPath, thirdPath]) {
      const begun = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        accountId: "terra",
        conversationId: conversation.id,
        purpose: "resume-successor",
      });
      if (begun.kind !== "created") throw new Error("expected create");
      expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname))).toMatchObject({
        kind: "settled",
        conversation: { id: conversation.id },
      });
    }

    const resumed = store.conversation(conversation.id)!;
    expect(resumed.generations.map((generation) => generation.path)).toEqual([firstPath, secondPath, thirdPath]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    for (const pathname of [firstPath, secondPath, thirdPath]) {
      expect(store.conversationForPath(pathname)?.id).toBe(conversation.id);
    }
  });

  test("freezes a resume receipt after its first successor settlement", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const unrelatedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({ kind: "settled" });
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(unrelatedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_artifact_conflict",
      receipt: { state: "completed", artifactPath: secondPath },
    });

    expect(store.conversation(conversation.id)?.generations.map((generation) => generation.path)).toEqual([firstPath, secondPath]);
    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "completed",
      artifactPath: secondPath,
      key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
      error: null,
    });
  });

  test("replaces an owned registry entry when a Codex resume keeps its native session id", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.upsert({
      ...spawnEntry(firstPath),
      status: "unhosted",
      host: null,
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: secondPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(secondPath);
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [firstPath],
      generations: [{ id: nativeId, path: secondPath }],
    });
  });

  test("same-session resume preserves durable launch metadata through default overrides", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const parent = store.ensureConversation("codex", "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl", "terra");
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.reconcileConversations([{
      engine: "codex",
      path: firstPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({
        cwd: "/repo/original",
        model: "gpt-original",
        effort: "medium",
        title: "Durable title",
        project: "durable-project",
        parentConversationId: parent.id,
        role: "root",
        goal: { objective: "Preserve lineage", status: "active", tokensUsed: null, timeUsedSeconds: null },
      }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo/resumed",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
      launchProfile: emptyLaunchProfile({ cwd: "/repo/resumed", model: "gpt-resumed", effort: "high" }),
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(begun.receipt.launchProfile).toMatchObject({
      cwd: "/repo/resumed",
      model: "gpt-resumed",
      effort: "high",
      title: "Durable title",
      project: "durable-project",
      parentConversationId: parent.id,
      role: "root",
      goal: { objective: "Preserve lineage", status: "active" },
    });
    expect(store.settleSpawn(begun.receipt.launchId, { ...spawnEntry(secondPath), cwd: "/repo/resumed" })).toMatchObject({ kind: "settled" });
    expect(store.conversation(conversation.id)?.generations[0]?.launchProfile).toMatchObject({
      cwd: "/repo/resumed",
      model: "gpt-resumed",
      effort: "high",
      title: "Durable title",
      project: "durable-project",
      parentConversationId: parent.id,
      role: "root",
      goal: { objective: "Preserve lineage", status: "active" },
    });
  });

  test("settles a same-session successor after inventory moves the generation first", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.upsert({
      ...spawnEntry(firstPath),
      status: "unhosted",
      host: null,
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.snapshot()).toMatchObject({
      entries: { [`codex:${nativeId}`]: { artifactPath: firstPath } },
      conversations: {
        [conversation.id]: {
          continuityPaths: [firstPath],
          generations: [{ id: nativeId, path: secondPath }],
        },
      },
    });
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: secondPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(secondPath);
  });

  test("fresh newest-first inventory keeps the newest same-session rollout current", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const newestPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const olderPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const observation = (pathname: string, observedAt: string) => ({
      engine: "codex" as const,
      path: pathname,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt,
    });

    store.reconcileConversations([
      observation(newestPath, "2026-07-12T12:00:00.000Z"),
      observation(olderPath, "2026-07-12T12:01:00.000Z"),
    ]);

    const conversation = store.conversationForPath(newestPath)!;
    expect(conversation).toMatchObject({
      continuityPaths: [olderPath],
      generations: [{ id: nativeId, path: newestPath }],
    });
    expect(store.conversationForPath(olderPath)?.id).toBe(conversation.id);
  });

  test("completed resume receipt advances after observing its source path first", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const successorPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const unrelatedPath = `/sessions/2026/07/13/rollout-2026-07-13T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", sourcePath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(sourcePath))).toMatchObject({
      kind: "settled",
      receipt: { state: "completed", artifactPath: sourcePath },
    });
    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(successorPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: successorPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(successorPath);
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [sourcePath],
      generations: [{ id: nativeId, path: successorPath }],
    });
    store.reconcileConversations([{
      engine: "codex",
      path: unrelatedPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-13T12:00:00.000Z",
    }]);
    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(unrelatedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_artifact_conflict",
      receipt: { state: "completed", artifactPath: successorPath, resumeSourcePath: sourcePath },
    });
  });

  test("resume succession rebases a migration before provider work", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const resumedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.setConversationMigration(conversation.id, {
      intentId: "resume-rebase",
      phase: "requested",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath));

    expect(settled.kind).toBe("settled");
    const resumed = store.conversation(conversation.id)!;
    expect(resumed.generations.at(-1)?.path).toBe(resumedPath);
    expect(resumed.migration?.sourceGenerationId).toBe(resumed.generations.at(-1)?.id);
  });

  test("resume succession is fenced after migration provider work starts", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const resumedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.setConversationMigration(conversation.id, {
      intentId: "resume-fence",
      phase: "successor-starting",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_identity_conflict",
    });
    expect(store.conversation(conversation.id)?.generations.map((generation) => generation.path)).toEqual([firstPath]);
  });

  test("inventory cannot canonicalize a same-session resume after migration provider work starts", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const resumedPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", sourcePath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.setConversationMigration(conversation.id, {
      intentId: "inventory-resume-fence",
      phase: "successor-starting",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });

    store.reconcileConversations([{
      engine: "codex",
      path: resumedPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:01:00.000Z",
    }]);

    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [],
      generations: [{ id: nativeId, path: sourcePath }],
    });
    expect(store.conversationForPath(resumedPath)).toBeNull();
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_identity_conflict",
    });
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [],
      generations: [{ id: nativeId, path: sourcePath }],
    });
  });

  test("treats a second rollout path with the same native session key as one conversation", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");

    store.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T10:00:00.000Z",
    }]);

    expect(store.conversationForPath(firstPath)?.id).toBe(conversation.id);
    expect(store.conversationForPath(secondPath)?.id).toBe(conversation.id);
    expect(store.conversation(conversation.id)?.generations.at(-1)?.path).toBe(secondPath);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
  });

  test("repairs an exact-path provisional owner split in favor of receipt-owned identity", () => {
    const store = registry();
    const pathname = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra" });
    if (begun.kind !== "created") throw new Error("expected create");
    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname));
    if (settled.kind !== "settled") throw new Error("expected settlement");
    const snapshot = store.snapshot();
    const provisionalId = "conversation_00000000-0000-4000-8000-000000000001";
    snapshot.conversations[provisionalId] = {
      ...structuredClone(settled.conversation),
      id: provisionalId,
      createdAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    store.reconcileConversations([{
      engine: "codex",
      path: pathname,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    expect(store.conversationForPath(pathname)?.id).toBe(settled.conversation.id);
    expect(store.canonicalConversationId(provisionalId)).toBe(settled.conversation.id);
  });

  test("transfers an adopted successor path during the same reconciliation", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const successorPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const canonical = store.ensureConversation("codex", sourcePath, "terra");
    const snapshot = store.snapshot();
    snapshot.conversations[canonical.id]!.createdAt = "2026-07-12T10:00:00.000Z";
    snapshot.conversations[canonical.id]!.updatedAt = "2026-07-12T10:00:00.000Z";
    const provisionalId = "conversation_00000000-0000-4000-8000-000000000002";
    snapshot.conversations[provisionalId] = {
      ...structuredClone(canonical),
      id: provisionalId,
      generations: [{ ...structuredClone(canonical.generations[0]!), path: successorPath }],
      createdAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.conversationForPath(successorPath)?.id).toBe(canonical.id);
    expect(store.conversationForPath(sourcePath)?.id).toBe(canonical.id);
    expect(store.conversation(canonical.id)).toMatchObject({
      generations: [{ path: successorPath }],
      continuityPaths: [sourcePath],
    });
    expect(store.canonicalConversationId(provisionalId)).toBe(canonical.id);
  });

  test("persists engine-native lineage by stable conversation identity", () => {
    const store = registry();
    const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const childPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");

    store.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "busy", source: "assistant", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    const child = store.conversationForPath(childPath)!;
    expect(new AgentRegistry(store.filename).snapshot().lineageEdges[child.id]).toMatchObject({
      childConversationId: child.id,
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      parentArtifactPath: parentPath,
      source: "engine-native",
    });
  });

  test("reserves reviewer lineage and container membership before launch actuation", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl",
      "terra",
    );
    const implementer = store.ensureConversation(
      "codex",
      "/sessions/implementer-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );

    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: caller.id,
      role: "reviewer",
      reviewsConversationId: implementer.id,
      memberships: [{
        kind: "flow",
        containerId: "flow-durable",
        role: "reviewer",
        slot: "reviewer:3",
        stageId: null,
        stageOrder: null,
        round: 3,
        parentConversationId: caller.id,
      }],
    });
    if (begun.kind !== "created") throw new Error("expected create");

    const restarted = new AgentRegistry(store.filename).snapshot();
    expect(restarted.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: caller.id,
      kind: "review",
      role: "reviewer",
      reviewsConversationId: implementer.id,
      childArtifactPath: null,
    });
    expect(restarted.memberships[begun.receipt.conversationId]).toEqual([expect.objectContaining({
      conversationId: begun.receipt.conversationId,
      kind: "flow",
      containerId: "flow-durable",
      role: "reviewer",
      slot: "reviewer:3",
      round: 3,
      parentConversationId: caller.id,
    })]);
  });

  test("reserves at most three live viewer-spawn children per caller", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );
    const reservations = Array.from({ length: 3 }, () => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "builder",
      liveChildrenCap: 3,
    }));

    expect(reservations.every((reservation) => reservation.kind === "created")).toBe(true);
    const reservedEdges = Object.values(store.snapshot().lineageEdges).filter((edge) => edge.parentConversationId === caller.id);
    expect(reservedEdges).toHaveLength(3);
    expect(reservedEdges.every((edge) => edge.source === "viewer-spawn" && edge.childArtifactPath === null)).toBe(true);
    const childPaths = [
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1329.jsonl",
    ];
    reservations.forEach((reservation, index) => {
      if (reservation.kind !== "created") throw new Error("expected reservation");
      store.settleSpawn(reservation.receipt.launchId, spawnEntry(childPaths[index]!));
    });
    expect(() => store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    })).toThrow("3 live children (cap: 3)");

    const firstEntry = store.snapshot().entries[`codex:019f4906-3f67-7b72-9fbc-9ec3b5ad1327`]!;
    store.upsert({ ...firstEntry, status: "dead" });
    expect(store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    }).kind).toBe("created");
  });

  test("expired pre-host reservations release child-cap capacity", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );
    const reservations = Array.from({ length: 3 }, () => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "builder",
      liveChildrenCap: 3,
    }));
    const snapshot = store.snapshot();
    const expiredAt = new Date(Date.now() - SPAWN_STARTING_ADMISSION_LEASE_MS - 1_000).toISOString();
    for (const reservation of reservations) {
      if (reservation.kind !== "created") throw new Error("expected reservation");
      snapshot.receipts[reservation.receipt.launchId]!.createdAt = expiredAt;
    }
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    expect(store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    }).kind).toBe("created");
  });

  test("dead pane-bound reservations release child-cap capacity", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const deadPid = 900_000 + index;
      store.bindSpawnPane(reservation.receipt.launchId, {
        endpoint: "/dead-tmux",
        server: { pid: deadPid, startIdentity: "dead" },
        paneId: `%${index}`,
        panePid: { pid: deadPid, startIdentity: "dead" },
        target: `agents:${index}.0`,
      });
    }

    expect(store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    }).kind).toBe("created");
  });

  test("completed children with stale live entries release capacity when their verified host is dead", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const deadPid = 910_000 + index;
      const pane = {
        endpoint: "/dead-tmux",
        server: { pid: deadPid, startIdentity: "dead" },
        paneId: `%${index}`,
        panePid: { pid: deadPid, startIdentity: "dead" },
        target: `agents:${index}.0`,
      };
      store.bindSpawnPane(reservation.receipt.launchId, pane);
      store.markSpawnHostVerified(reservation.receipt.launchId, {
        kind: "tmux",
        ...pane,
        windowName: "codex-new",
        agent: { pid: deadPid, startIdentity: "dead" },
        argv: ["codex"],
      });
      store.settleSpawn(reservation.receipt.launchId, spawnEntry(
        `/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad13${30 + index}.jsonl`,
      ));
    }

    expect(store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    }).kind).toBe("created");
  });

  test("a verified live host consumes capacity despite a stale dead entry", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const pane = {
        endpoint: "/live-tmux",
        server: { pid: process.pid, startIdentity: null },
        paneId: `%${index}`,
        panePid: { pid: process.pid, startIdentity: null },
        target: `agents:${index}.0`,
      };
      store.bindSpawnPane(reservation.receipt.launchId, pane);
      store.markSpawnHostVerified(reservation.receipt.launchId, {
        kind: "tmux",
        ...pane,
        windowName: "codex-new",
        agent: { pid: process.pid, startIdentity: null },
        argv: ["codex"],
      });
      store.settleSpawn(reservation.receipt.launchId, {
        ...spawnEntry(`/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad13${40 + index}.jsonl`),
        status: "dead",
      });
    }

    expect(() => store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    })).toThrow("3 live children (cap: 3)");
  });

  test("a conflicted receipt with a live pane keeps consuming child capacity", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1350.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      store.bindSpawnPane(reservation.receipt.launchId, {
        endpoint: "/live-tmux",
        server: { pid: process.pid, startIdentity: null },
        paneId: `%${index}`,
        panePid: { pid: process.pid, startIdentity: null },
        target: `agents:${index}.0`,
      });
      store.failSpawn(reservation.receipt.launchId, "post-bind confirmation failed");
    }

    expect(() => store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    })).toThrow("3 live children (cap: 3)");
  });

  test("a live adopted structured host outweighs dead original tmux evidence", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1360.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const deadPid = 930_000 + index;
      const pane = {
        endpoint: "/dead-tmux",
        server: { pid: deadPid, startIdentity: "dead" },
        paneId: `%${index}`,
        panePid: { pid: deadPid, startIdentity: "dead" },
        target: `agents:${index}.0`,
      };
      store.bindSpawnPane(reservation.receipt.launchId, pane);
      store.markSpawnHostVerified(reservation.receipt.launchId, {
        kind: "tmux",
        ...pane,
        windowName: "codex-new",
        agent: { pid: deadPid, startIdentity: "dead" },
        argv: ["codex"],
      });
      const settled = store.settleSpawn(
        reservation.receipt.launchId,
        spawnEntry(`/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad13${60 + index}.jsonl`),
      );
      if (settled.kind !== "settled") throw new Error("expected settlement");
      store.setStructuredHost(settled.entry.key, {
        kind: "codex-app-server",
        endpoint: `stdio:${process.pid}`,
        process: { pid: process.pid, startIdentity: null },
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 0,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      }, "idle");
    }

    expect(() => store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    })).toThrow("3 live children (cap: 3)");
  });

  test("a live resumed generation outweighs dead original launch evidence", () => {
    const store = registry();
    const caller = store.ensureConversation(
      "codex",
      "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1370.jsonl",
      "terra",
    );
    for (let index = 0; index < 3; index += 1) {
      const reservation = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        parentConversationId: caller.id,
        role: "builder",
        liveChildrenCap: 3,
      });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const deadPid = 940_000 + index;
      const pane = {
        endpoint: "/dead-tmux",
        server: { pid: deadPid, startIdentity: "dead" },
        paneId: `%${index}`,
        panePid: { pid: deadPid, startIdentity: "dead" },
        target: `agents:${index}.0`,
      };
      store.bindSpawnPane(reservation.receipt.launchId, pane);
      store.markSpawnHostVerified(reservation.receipt.launchId, {
        kind: "tmux",
        ...pane,
        windowName: "codex-new",
        agent: { pid: deadPid, startIdentity: "dead" },
        argv: ["codex"],
      });
      const settled = store.settleSpawn(
        reservation.receipt.launchId,
        spawnEntry(`/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad13${70 + index}.jsonl`),
      );
      if (settled.kind !== "settled") throw new Error("expected settlement");
      const resumed = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        conversationId: settled.conversation.id,
        purpose: "resume-successor",
      });
      if (resumed.kind !== "created") throw new Error("expected resume reservation");
      const liveHost = {
        kind: "tmux" as const,
        endpoint: "/live-tmux",
        server: { pid: process.pid, startIdentity: null },
        paneId: `%${10 + index}`,
        panePid: { pid: process.pid, startIdentity: null },
        windowName: "codex-resume",
        agent: { pid: process.pid, startIdentity: null },
        argv: ["codex", "resume"],
      };
      store.settleSpawn(resumed.receipt.launchId, {
        ...spawnEntry(`/sessions/resumed-019f4906-3f67-7b72-9fbc-9ec3b5ad13${80 + index}.jsonl`),
        host: liveHost,
      });
    }

    expect(() => store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "architect",
      liveChildrenCap: 3,
    })).toThrow("3 live children (cap: 3)");
  });

  test("provisional successor adoption discards lineage that canonicalizes to a self-edge", () => {
    const store = registry();
    const sourcePath = "/sessions/source-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const successorPath = "/sessions/successor-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const canonical = store.ensureConversation("codex", sourcePath, "terra");
    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: canonical.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);
    const provisional = store.conversationForPath(successorPath)!;
    expect(store.snapshot().lineageEdges[provisional.id]).toMatchObject({
      childConversationId: provisional.id,
      parentConversationId: canonical.id,
      source: "engine-native",
    });
    const migration = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "work",
      conversationId: canonical.id,
      purpose: "migration-successor",
      expectedArtifactPath: successorPath,
    });
    if (migration.kind !== "created") throw new Error("expected migration receipt");

    expect(store.settleSpawn(migration.receipt.launchId, spawnEntry(successorPath, "work"))).toMatchObject({
      kind: "settled",
      conversation: { id: canonical.id },
    });
    const snapshot = store.snapshot();
    expect(snapshot.conversationAliases[provisional.id]).toBe(canonical.id);
    expect(snapshot.lineageEdges[canonical.id]).toBeUndefined();
    expect(Object.values(snapshot.lineageEdges).some((edge) => edge.childConversationId === edge.parentConversationId)).toBe(false);
  });

  test("stronger engine-native evidence corrects an inferred parent", () => {
    const store = registry();
    const parentA = store.ensureConversation("codex", "/sessions/parent-a-019f4906-3f67-7b72-9fbc-9ec3b5ad1301.jsonl", "terra");
    const parentB = store.ensureConversation("codex", "/sessions/parent-b-019f4906-3f67-7b72-9fbc-9ec3b5ad1302.jsonl", "terra");
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1303.jsonl";
    const observation = (parentConversationId: `conversation_${string}`, observedAt: string) => ({
      engine: "codex" as const,
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt,
    });

    store.reconcileConversations([observation(parentA.id, "2026-07-12T12:00:00.000Z")]);
    const child = store.conversationForPath(childPath)!;
    store.reconcileConversations([observation(parentB.id, "2026-07-12T12:01:00.000Z")]);

    expect(store.conversation(child.id)?.generations[0]?.launchProfile.parentConversationId).toBe(parentB.id);
    expect(store.snapshot().lineageEdges[child.id]).toMatchObject({
      source: "engine-native",
      parentConversationId: parentB.id,
      parentArtifactPath: parentB.generations[0]?.path,
    });
  });

  test("inventory refresh preserves authoritative viewer-spawn lineage evidence", () => {
    const store = registry();
    const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const childPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentArtifactPath: parentPath,
      clientAttemptId: "viewer_spawn_evidence",
      requestDigest: "digest",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(childPath));
    if (settled.kind !== "settled") throw new Error("expected settlement");

    store.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.snapshot().lineageEdges[settled.conversation.id]).toMatchObject({
      source: "viewer-spawn",
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      evidence: {
        launchId: begun.receipt.launchId,
        clientAttemptId: "viewer_spawn_evidence",
      },
    });
  });

  test("keeps simultaneous same-engine same-cwd receipts isolated and fails conflicting artifacts closed", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "b" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const firstPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    expect(store.settleSpawn(first.receipt.launchId, spawnEntry(firstPath)).kind).toBe("settled");
    expect(store.settleSpawn(second.receipt.launchId, spawnEntry(secondPath, "b")).kind).toBe("settled");
    const conflict = store.settleSpawn(second.receipt.launchId, spawnEntry(firstPath, "b"));
    expect(conflict).toMatchObject({ kind: "conflict", code: "spawn_artifact_conflict" });
    expect(store.snapshot().receipts[first.receipt.launchId]?.artifactPath).toBe(firstPath);
    expect(store.snapshot().receipts[second.receipt.launchId]?.artifactPath).toBe(secondPath);
  });

  test("keeps a conflicted spawn receipt terminal across later settlement", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo" });
    if (begun.kind !== "created") throw new Error("expected create");
    const pathname = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const conflict = store.settleSpawn(begun.receipt.launchId, { ...spawnEntry(pathname), cwd: "/wrong" });
    const replay = store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname));

    expect(conflict).toMatchObject({ kind: "conflict", code: "spawn_identity_conflict" });
    expect(replay).toMatchObject({ kind: "conflict", receipt: { state: "conflicted", error: "spawn_identity_conflict" } });
    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "conflicted", error: "spawn_identity_conflict" });
  });

  test("migration settlement atomically reassigns durable provisional references", () => {
    const store = registry();
    const original = store.ensureConversation("claude", "/source.jsonl", "source");
    const caller = store.ensureConversation("claude", "/caller.jsonl", "source");
    const targetPath = "/target.jsonl";
    store.reconcileConversations([{
      engine: "claude",
      path: targetPath,
      accountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:00:00.000Z",
    }]);
    const provisional = store.conversationForPath(targetPath)!;
    const childReceipt = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", parentConversationId: provisional.id });
    const reviewerReceipt = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      parentConversationId: caller.id,
      role: "reviewer",
      reviewsConversationId: provisional.id,
    });
    const held = store.holdDelivery(provisional.id, "deliver after migration", "provisional-migration-message");
    store.reconcileConversations([{
      engine: "claude",
      path: "/child.jsonl",
      accountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: provisional.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:00:01.000Z",
    }]);
    const migration = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      conversationId: original.id,
      purpose: "migration-successor",
      expectedArtifactPath: targetPath,
    });
    if (migration.kind !== "created") throw new Error("expected create");

    const settled = store.settleSpawn(migration.receipt.launchId, {
      key: { engine: "claude", sessionId: "target" },
      artifactPath: targetPath,
      cwd: "/repo",
      accountId: "target",
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(settled).toMatchObject({ kind: "settled", conversation: { id: original.id } });
    expect(store.conversationForPath(targetPath)?.id).toBe(original.id);
    expect(store.conversation(original.id)?.continuityPaths).toEqual([targetPath]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(3);
    const snapshot = store.snapshot();
    expect(snapshot.receipts[childReceipt.receipt.launchId]).toMatchObject({ parentConversationId: original.id });
    expect(snapshot.lineageEdges[childReceipt.receipt.conversationId]).toMatchObject({ parentConversationId: original.id });
    expect(snapshot.lineageEdges[reviewerReceipt.receipt.conversationId]).toMatchObject({
      parentConversationId: caller.id,
      reviewsConversationId: original.id,
    });
    expect(snapshot.heldDeliveries[held.id]).toMatchObject({ conversationId: original.id });
    expect(store.holdDelivery(original.id, "deliver after migration", "provisional-migration-message").id).toBe(held.id);
    expect(store.conversationForPath("/child.jsonl")?.generations[0]?.launchProfile.parentConversationId).toBe(original.id);
    expect(snapshot.conversationAliases[provisional.id]).toBe(original.id);
    expect(store.canonicalConversationId(provisional.id)).toBe(original.id);
    expect(store.conversation(provisional.id)?.id).toBe(original.id);
    expect(new AgentRegistry(store.filename).conversation(provisional.id)?.id).toBe(original.id);
  });

  test("normalizes a legacy receipt after restart without changing its schema version", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({
      version: 2, entries: {}, receipts: { legacy: { launchId: "legacy", engine: "codex", cwd: "/repo", createdAt: "2026-07-10T00:00:00.000Z", state: "starting", artifactPath: null, error: null, launchProfile: { cwd: "/repo" } } },
      importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} }, conversations: {}, conversationRevision: { claude: 0, codex: 0 }, migrationIntents: {}, engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } }, autoBalance: {}, quotaObservations: {}, heldDeliveries: {},
    }));
    const restarted = new AgentRegistry(store.filename).snapshot();
    expect(restarted.version).toBe(2);
    expect(restarted.receipts.legacy).toMatchObject({ clientAttemptId: null, pane: null, key: null, state: "starting", artifactLifecycle: "pending" });
    expect(restarted.receipts.legacy?.conversationId.startsWith("conversation_")).toBe(true);
  });

  test("keeps birth-account provenance while attaching an active migration intent", () => {
    const store = registry();
    const receipt = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "birth" });
    if (receipt.kind !== "created") throw new Error("expected create");
    const intent = store.upsertMigrationIntent("codex", "target", "manual", "move-after-spawn");
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";

    const settled = store.settleSpawn(receipt.receipt.launchId, spawnEntry(path, "target"));

    expect(settled).toMatchObject({ kind: "settled", entry: { accountId: "birth" }, conversation: { migration: { intentId: intent.id, targetId: "target" } } });
  });
});
