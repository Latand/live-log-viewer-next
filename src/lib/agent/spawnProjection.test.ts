import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { AgentRegistry } from "./registry";
import { preallocatedStructuredSpawnCards, projectLaunchConversations } from "./spawnProjection";

function scannedFile(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "Settled spawn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function observeArtifact(registry: AgentRegistry, artifactPath: string, cwd: string): void {
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T10:00:00.000Z",
  }]);
}

test("a settled artifact stays projected across restart until inventory observes it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-scan-lag-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe0.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "scan lag" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "scan_lag_20260717_a1",
      requestDigest: "c".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe0" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** The #569 live evidence, reproduced: launch f6b3cf69 settles `route-recovered`
    with `artifactLifecycle: materialized` while its Codex transcript is already
    scanned and running. */
function lateSuccessLaunch(directory: string): { registry: AgentRegistry; artifactPath: string; launchId: string; conversationId: string; createdAt: number } {
  const artifactPath = path.join(directory, "late-success.jsonl");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "late-success" }, artifactPath, cwd: directory,
    accountId: "work", launchProfile: emptyLaunchProfile({ cwd: directory }), status: "idle",
    host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  }, "route-recovered");
  observeArtifact(registry, artifactPath, directory);
  return {
    registry,
    artifactPath,
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    createdAt: Date.parse(begun.receipt.createdAt),
  };
}

test("issue 569: a materialized live conversation retires the duplicate launch card and keeps the launch as transient facts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-late-success-projection-"));
  try {
    const launch = lateSuccessLaunch(directory);
    const scanned = scannedFile(launch.artifactPath);
    scanned.activity = "live";

    /* The operator's 12:26–12:30 window: the transcript is live and the launch
       is `live-late-success`. Exactly one board entry — the conversation — and
       the launch renders inside it, never as a second card saying "queued". */
    const fresh = projectLaunchConversations([scanned], launch.registry.snapshot(), launch.createdAt + 60_000);
    expect(fresh.cards).toEqual([]);
    expect(fresh.facts.get(launch.artifactPath)).toMatchObject({ state: "live-late-success", initialMessage: "delivered" });
    /* Issue #533 stays satisfied: the late success is still visible — as the
       live conversation's own chip, which is what the operator was looking for. */
    expect(preallocatedStructuredSpawnCards([scanned], launch.registry.snapshot(), launch.createdAt + 60_000)).toEqual([]);

    /* Transient: past the freshness horizon the chips stop rendering, and the
       conversation window is unchanged underneath. */
    const later = projectLaunchConversations([scanned], launch.registry.snapshot(), launch.createdAt + 16 * 60_000);
    expect(later.cards).toEqual([]);
    expect(later.facts.get(launch.artifactPath)).toBeUndefined();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 569: the launch route resolves to the canonical conversation long after the card retires", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-late-success-route-"));
  try {
    const launch = lateSuccessLaunch(directory);
    const scanned = scannedFile(launch.artifactPath);
    const route = `spawn:${launch.launchId}`;

    /* The operator's second failure phase: 14 minutes in, and again after the
       15-minute card cutoff, `#c=spawn:<launchId>` must still name the live
       conversation rather than dead-ending on Overview. */
    for (const offset of [60_000, 14 * 60_000, 16 * 60_000, 23 * 60 * 60_000]) {
      expect(projectLaunchConversations([scanned], launch.registry.snapshot(), launch.createdAt + offset).routes[route])
        .toBe(launch.conversationId);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 560 P1#5: routes keep every retained launch id — a second launch never invalidates the earlier link", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-launch-routes-multi-"));
  const filename = path.join(directory, "agent-registry.json");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const first = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (first.kind !== "created") throw new Error("expected structured launch creation");
    const conversationId = first.receipt.conversationId;

    /* Forge a SECOND launch receipt for the SAME conversation (a fresh launch id
       and a newer timestamp), and age the first into terminal history >24h. This
       is the exact production shape the review named: two launch ids, one
       conversation, and an aged durable receipt. */
    const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as { receipts: Record<string, Record<string, unknown>> };
    const firstReceipt = raw.receipts[first.receipt.launchId]!;
    firstReceipt.state = "completed";
    firstReceipt.createdAt = new Date(Date.now() - 26 * 60 * 60 * 1_000).toISOString();
    const secondLaunchId = "launch_second_" + "aaaaaaaa";
    raw.receipts[secondLaunchId] = {
      ...firstReceipt,
      launchId: secondLaunchId,
      state: "prompt-delivered",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(filename, JSON.stringify(raw));

    const snapshot = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" }).snapshot();
    const routes = projectLaunchConversations([], snapshot).routes;

    /* BOTH launch links resolve to the conversation: the newer one AND the aged
       terminal one. Freshness rules affect only cards/chips, never routing. */
    expect(routes[`spawn:${secondLaunchId}`]).toBe(conversationId);
    expect(routes[`spawn:${first.receipt.launchId}`]).toBe(conversationId);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 569: a launch with no materialized transcript still projects the conversation window itself", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-late-success-unmaterialized-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");

    const projection = projectLaunchConversations([], registry.snapshot());
    expect(projection.cards).toEqual([expect.objectContaining({ path: `spawn:${begun.receipt.launchId}` })]);
    expect(projection.facts.size).toBe(0);
    expect(projection.routes[`spawn:${begun.receipt.launchId}`]).toBe(begun.receipt.conversationId);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 614: a transcript-less launch projects the queued prompt as the first user bubble across multiple polls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-614-pre-transcript-prompt-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    /* The queued initial delivery the spawn holds for this launch — the durable
       source of the first user bubble on EVERY surface, not only the browser
       that ran the composer. */
    registry.holdDelivery(begun.receipt.conversationId, "LLV614_CANONICAL_PROBE_20260723", `spawn_${begun.receipt.launchId}`);

    const createdMs = Date.parse(begun.receipt.createdAt);
    /* The launch stays transcript-less across several projection polls (the
       production regression sampled ~0s / ~17s / ~32s). Every poll keeps ONE
       window carrying the prompt as its first user bubble — never an empty shell
       under status chips, and never a vanished window. */
    for (const offset of [0, 17_000, 32_000, 4 * 60_000]) {
      const projection = projectLaunchConversations([], registry.snapshot(), createdMs + offset);
      expect(projection.cards).toHaveLength(1);
      expect(projection.cards[0]!.spawn).toMatchObject({
        state: "queued",
        initialMessage: "queued",
        promptImages: 0,
        promptAt: createdMs, prompt: "LLV614_CANONICAL_PROBE_20260723",
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 614: a materialized launch whose transcript a scoped scan omits keeps its window until the live conversation is in the response", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-614-pre-adoption-continuity-"));
  const artifactPath = path.join(directory, "019f8dbe_e6cc_9e62_40df_06fb8f88b8a1.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "LLV614_CANONICAL_PROBE_20260723" })}\n`);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f8dbe-" + "e6cc-9e62-40df-06fb8f88b8a1" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);
    const createdMs = Date.parse(begun.receipt.createdAt);
    const snapshot = registry.snapshot();
    expect(snapshot.receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("materialized");

    /* The #614 vanish: inventory materialized the transcript, but the canonical
       project poll that the operator is watching has not carried it yet. The
       window must NOT blink out — the launch keeps its window while the
       transcript still exists on disk and the launch is recent. */
    const gap = projectLaunchConversations([], snapshot, createdMs + 17_000);
    expect(gap.cards).toHaveLength(1);
    expect(gap.cards[0]!).toMatchObject({ path: `spawn:${begun.receipt.launchId}` });

    /* The receipt-to-transcript handoff in ONE response: the live transcript
       arrives, the launch folds into that single window as transient facts, and
       there is exactly one card — never a duplicate. */
    const adopted = projectLaunchConversations([scannedFile(artifactPath)], snapshot, createdMs + 20_000);
    expect(adopted.cards).toEqual([]);
    expect(adopted.facts.get(artifactPath)).toMatchObject({ state: "recovered", initialMessage: "delivered" });

    /* Aged past the pre-adoption grace with the transcript still outside the
       scoped scan: it folds into history rather than resurrecting a phantom. */
    expect(projectLaunchConversations([], snapshot, createdMs + 16 * 60_000).cards).toEqual([]);

    /* A genuinely deleted transcript retires the window rather than lingering. */
    fs.unlinkSync(artifactPath);
    expect(projectLaunchConversations([], snapshot, createdMs + 17_000).cards).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 615 HIGH1: the launch prompt projects from the durable display payload across the whole lifecycle, independent of held-delivery text, and stops on transcript adoption", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-615-durable-display-"));
  const artifactPath = path.join(directory, "019f8dbe_e6cc_9e62_40df_06fb8f88b8b2.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "scaffold\n\nLLV615_RAW_PROMPT" })}\n`);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      /* Persisted at receipt birth — BEFORE any deferred delivery admission and
         BEFORE receipt publication. Raw prompt for display, the delivered
         (scaffolded) text as the canonical echo identity, plus the image count. */
      launchDisplay: { prompt: "LLV615_RAW_PROMPT", images: 2, echo: "scaffold\n\nLLV615_RAW_PROMPT" },
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const createdMs = Date.parse(begun.receipt.createdAt);

    /* `starting`, BEFORE the held delivery exists: the display payload still
       projects the raw prompt, its echo identity, and the image count. */
    const starting = projectLaunchConversations([], registry.snapshot(), createdMs + 1_000);
    expect(starting.cards[0]!.spawn).toMatchObject({
      state: "starting",
      promptImages: 2,
      promptAt: createdMs,
      promptEcho: "scaffold\n\nLLV615_RAW_PROMPT", prompt: "LLV615_RAW_PROMPT",
    });

    /* Delivered settlement scrubs held-delivery text; the display payload is
       independent, so the prompt still projects during the scan-lag interval. */
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f8dbe-" + "e6cc-9e62-40df-06fb8f88b8b2" },
      artifactPath, cwd: directory, accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    registry.holdDelivery(begun.receipt.conversationId, "scaffold\n\nLLV615_RAW_PROMPT", `spawn_${begun.receipt.launchId}`);
    registry.recordDeliveryOutcome(
      Object.values(registry.snapshot().heldDeliveries).find((d) => d.clientMessageId === `spawn_${begun.receipt.launchId}`)!.id,
      "delivered",
    );
    observeArtifact(registry, artifactPath, directory);
    const snapshot = registry.snapshot();
    /* The held-delivery text is scrubbed (or the reservation compacted) once
       delivered — no longer a source for the prompt. */
    expect(Object.values(snapshot.heldDeliveries).find((d) => d.clientMessageId === `spawn_${begun.receipt.launchId}`)?.text ?? "").toBe("");

    const scanLag = projectLaunchConversations([], snapshot, createdMs + 20_000);
    expect(scanLag.cards).toHaveLength(1);
    expect(scanLag.cards[0]!.spawn).toMatchObject({ prompt: "LLV615_RAW_PROMPT", promptImages: 2, promptEcho: "scaffold\n\nLLV615_RAW_PROMPT" });
    /* The delivered receipt time is projected so the client can settle the launch
       bubble even when the transcript echo never matches (issue #648). */
    const deliveredAt = scanLag.cards[0]!.spawn!.deliveredAt;
    expect(typeof deliveredAt).toBe("number");
    expect(Number.isFinite(deliveredAt)).toBe(true);

    /* The response that ADOPTS the live transcript stops projecting the prompt —
       the transcript now renders the message, so the facts carry no bubble. */
    const adopted = projectLaunchConversations([scannedFile(artifactPath)], snapshot, createdMs + 21_000);
    expect(adopted.cards).toEqual([]);
    const facts = adopted.facts.get(artifactPath)!;
    expect(facts).toMatchObject({ state: "recovered" });
    expect(facts.prompt).toBeUndefined();
    expect(facts.promptEcho).toBeUndefined();
    expect(facts.promptImages).toBeUndefined();
    /* The delivered receipt time survives prompt scrubbing: a materialized window
       whose echo never matches can still settle the launch bubble (issue #648). */
    expect(facts.deliveredAt).toBe(deliveredAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 615 HIGH1: the durable display payload survives restart and never leaks into a successor receipt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-615-display-restart-"));
  const filename = path.join(directory, "agent-registry.json");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      launchDisplay: { prompt: "LLV615_RAW_PROMPT", images: 0, echo: "LLV615_RAW_PROMPT" },
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");

    /* A refresh/restart rehydrates the durable payload from disk unchanged. */
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.snapshot().receipts[begun.receipt.launchId]?.launchDisplay)
      .toEqual({ prompt: "LLV615_RAW_PROMPT", images: 0, echo: "LLV615_RAW_PROMPT" });

    /* A second, unrelated launch never inherits the first launch's display. */
    const other = restarted.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (other.kind !== "created") throw new Error("expected structured launch creation");
    expect(restarted.snapshot().receipts[other.receipt.launchId]?.launchDisplay).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal synthetic spawn cards join compact history after the scanner freshness horizon", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-terminal-age-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe4.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const recovered = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "terminal_age_recovered_20260717_a1",
      requestDigest: "1".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    const failed = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "terminal_age_failed_20260717_a1",
      requestDigest: "2".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (recovered.kind !== "created" || failed.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(recovered.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe4" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    registry.failSpawn(failed.receipt.launchId, "runtime host request timed out");

    const createdMs = Math.max(Date.parse(recovered.receipt.createdAt), Date.parse(failed.receipt.createdAt));
    const fresh = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 14 * 60 * 1_000);
    expect(fresh.find((card) => card.path === `spawn:${recovered.receipt.launchId}`)?.activity).toBe("recent");
    expect(fresh.find((card) => card.path === `spawn:${failed.receipt.launchId}`)?.activity).toBe("stalled");

    const historical = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 16 * 60 * 1_000);
    expect(historical.find((card) => card.path === `spawn:${recovered.receipt.launchId}`)?.activity).toBe("idle");
    expect(historical.find((card) => card.path === `spawn:${failed.receipt.launchId}`)?.activity).toBe("idle");
    expect(historical.map((card) => card.spawn?.retrySafe)).toContain(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy completed receipt with a recorded transcript stays materialized after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-legacy-materialized-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f678d_951e_77f1_bc6a_c3175a6a7bd4.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "legacy completed transcript" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "legacy_materialized_20260717_a1",
      requestDigest: "b".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-" + "951e-77f1-bc6a-c3175a6a7bd4" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);

    const legacy = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { artifactLifecycle?: string; createdAt: string }>;
    };
    delete legacy.receipts[begun.receipt.launchId]?.artifactLifecycle;
    legacy.receipts[begun.receipt.launchId]!.createdAt = "2026-07-15T20:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(legacy));

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite import backfills a rollout-era pending lifecycle from durable inventory evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-legacy-sqlite-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f678d_951e_77f1_bc6a_c3175a6a7bd5.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "legacy sqlite transcript" })}\n`);
    const jsonRegistry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = jsonRegistry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "legacy_sqlite_materialized_20260717_a1",
      requestDigest: "7".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    jsonRegistry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-" + "951e-77f1-bc6a-c3175a6a7bd5" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(jsonRegistry, artifactPath, directory);

    const rolloutEra = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { artifactLifecycle: string; createdAt: string }>;
    };
    rolloutEra.receipts[begun.receipt.launchId]!.artifactLifecycle = "pending";
    rolloutEra.receipts[begun.receipt.launchId]!.createdAt = "2026-07-15T20:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(rolloutEra));

    const imported = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(imported.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("another generation's newer observation cannot materialize a pending launch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-existing-scan-lag-"));
  const filename = path.join(directory, "agent-registry.json");
  const firstPath = path.join(directory, "019f678d_951e_77f1_bc6a_c3175a6a7bd6.jsonl");
  const successorPath = path.join(directory, "019f678d_951e_77f1_bc6a_c3175a6a7bd7.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("codex", firstPath, "work");
    observeArtifact(registry, firstPath, directory);
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      conversationId: conversation.id,
      clientAttemptId: "successor_scan_lag_20260717_a1",
      requestDigest: "8".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-" + "951e-77f1-bc6a-c3175a6a7bd7" },
      artifactPath: successorPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const persisted = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { createdAt: string }>;
      conversations: Record<string, {
        generations: Array<{ path: string; createdAt: string }>;
        turn: { observedAt: string | null };
      }>;
    };
    persisted.receipts[begun.receipt.launchId]!.createdAt = "2026-07-17T08:00:00.000Z";
    persisted.conversations[conversation.id]!.turn.observedAt = "2026-07-17T11:00:00.000Z";
    persisted.conversations[conversation.id]!.generations
      .find((generation) => generation.path === successorPath)!.createdAt = "2026-07-17T10:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(persisted));

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("pending");
    /* Pinned inside the 24 h retirement window (#342): scan-lag protection is
       about the recent horizon; an aged terminal receipt retires instead. */
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot(), Date.parse("2026-07-17T12:00:00.000Z"))).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a deleted settled structured transcript stays absent after JSON restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-delete-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe1.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "settled" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "settled_delete_20260717_a1",
      requestDigest: "d".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe1" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    expect(settled.kind).toBe("settled");
    expect(preallocatedStructuredSpawnCards([scannedFile(artifactPath)], registry.snapshot())).toEqual([]);
    observeArtifact(registry, artifactPath, directory);

    fs.unlinkSync(artifactPath);
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });

    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending launch remains visible until inventory materializes its transcript", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-pending-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe2.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "pending_materialize_20260717_a1",
      requestDigest: "e".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe2" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(preallocatedStructuredSpawnCards([], registry.snapshot())).toHaveLength(1);

    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "materialized" })}\n`);
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart preserves materialized transcript deletion and pending launch visibility", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-sqlite-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe3.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "sqlite" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const settled = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_delete_20260717_a1",
      requestDigest: "f".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    const pending = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_pending_20260717_a1",
      requestDigest: "a".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (settled.kind !== "created" || pending.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(settled.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe3" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const cards = preallocatedStructuredSpawnCards([], restarted.snapshot());

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      path: `spawn:${pending.receipt.launchId}`,
      spawn: { state: "starting", initialMessage: "pending" },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inventory materialization stays scoped to the observed engine", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-engine-scope-"));
  const artifactPath = path.join(directory, "shared.jsonl");
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const codex = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_codex_20260717_a1",
      requestDigest: "1".repeat(64),
    });
    const claude = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_claude_20260717_a1",
      requestDigest: "2".repeat(64),
    });
    if (codex.kind !== "created" || claude.kind !== "created") throw new Error("expected structured launch creation");

    observeArtifact(registry, artifactPath, directory);
    const snapshot = registry.snapshot();

    expect(snapshot.receipts[codex.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    expect(snapshot.receipts[claude.receipt.launchId]?.artifactLifecycle).toBe("pending");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected launch projects a terminal failed card with zero conversation artifacts and lineage depth is exposed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-rejection-"));
  const filename = path.join(directory, "agent-registry.json");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const rootBegun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      role: "reviewer",
      reviewsConversationId: registry.ensureConversation("codex", path.join(directory, "reviewed.jsonl"), "work").id,
      origin: { kind: "operator" },
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (rootBegun.kind !== "created") throw new Error("expected creation");
    const settled = registry.settleSpawn(rootBegun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe1" },
      artifactPath: path.join(directory, "019f7b8a_9f75_7dc0_b231_17f7eadd7fe1.jsonl"),
      cwd: directory,
      accountId: "work",
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("expected settlement");

    let launchId = "";
    let conversationId = "";
    try {
      registry.beginSpawnRequest({
        engine: "codex",
        cwd: directory,
        transport: "structured",
        accountId: "work",
        origin: { kind: "agent", conversationId: settled.conversation.id },
        launchProfile: emptyLaunchProfile({ cwd: directory }),
      });
      throw new Error("expected a spawn admission rejection");
    } catch (error) {
      const rejection = error as { receipt?: { launchId: string; conversationId: string } };
      if (!rejection.receipt) throw error;
      launchId = rejection.receipt.launchId;
      conversationId = rejection.receipt.conversationId;
    }

    const snapshot = registry.snapshot();
    expect(snapshot.conversations[conversationId]).toBeUndefined();
    const cards = preallocatedStructuredSpawnCards([], snapshot);
    const rejectedCard = cards.find((card) => card.path === `spawn:${launchId}`)!;
    expect(rejectedCard).toMatchObject({
      activity: "stalled",
      activityReason: "structured_spawn_failed",
      spawn: { state: "failed", retrySafe: true },
    });

    /* Lineage depth rides the projection for admitted launches. */
    const childBegun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      parentConversationId: settled.conversation.id,
      role: "builder",
      origin: { kind: "operator" },
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (childBegun.kind !== "created") throw new Error("expected creation");
    const childCard = preallocatedStructuredSpawnCards([], registry.snapshot())
      .find((card) => card.path === `spawn:${childBegun.receipt.launchId}`)!;
    expect(childCard.durableLineage).toMatchObject({ role: "builder", depth: 0 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal receipts age through history and retire at the 24h bound; non-terminal receipts always project (#342)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-retire-"));
  const filename = path.join(directory, "agent-registry.json");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const failed = registry.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      transport: "structured",
      accountId: "work",
      clientAttemptId: "retire_failed_20260719_a1",
      requestDigest: "a".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    });
    if (failed.kind !== "created") throw new Error("expected structured launch creation");
    registry.failStructuredSpawn(failed.receipt.launchId, "structured spawn interrupted");
    const pending = registry.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      transport: "structured",
      accountId: "work",
      clientAttemptId: "retire_pending_20260719_a1",
      requestDigest: "b".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    });
    if (pending.kind !== "created") throw new Error("expected structured launch creation");
    const createdMs = Date.parse(failed.receipt.createdAt);

    const at23h = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 23 * 60 * 60 * 1_000);
    const failedAt23h = at23h.find((card) => card.path === `spawn:${failed.receipt.launchId}`);
    expect(failedAt23h).toMatchObject({ activity: "idle", activityReason: "structured_spawn_failed" });

    const at25h = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 25 * 60 * 60 * 1_000);
    expect(at25h.map((card) => card.path)).toEqual([`spawn:${pending.receipt.launchId}`]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the production placeholder baseline converges by projection alone with a loss-free inventory across restart (#342)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-baseline-"));
  const filename = path.join(directory, "agent-registry.json");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const parent = registry.ensureConversation("codex", path.join(directory, "parent-019f0000_0000_7000_8000_000000000342.jsonl"), "work");
    const seed = (index: number, terminal: "completed" | "failed") => {
      const begun = registry.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        transport: "structured",
        accountId: "work",
        parentConversationId: parent.id,
        clientAttemptId: `baseline_${terminal}_${String(index).padStart(3, "0")}`,
        requestDigest: String(index % 10).repeat(64),
        launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      });
      if (begun.kind !== "created") throw new Error("expected structured launch creation");
      if (terminal === "failed") {
        registry.failStructuredSpawn(begun.receipt.launchId, "structured spawn interrupted before identity staging");
      } else {
        const sessionId = `019f7b8a-9f75-7dc0-b231-${String(100000000000 + index)}`;
        registry.settleSpawn(begun.receipt.launchId, {
          key: { engine: "codex", sessionId },
          artifactPath: path.join(directory, `${sessionId}.jsonl`),
          cwd: "/repo",
          accountId: "work",
          launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
          status: "unhosted",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        });
      }
      return begun.receipt.launchId;
    };
    /* The production baseline: 107 recovered/completed + 73 failed terminal
       receipts, all past the retirement bound, with none of their transcripts
       scanned — 180 placeholders on the live board today. */
    for (let index = 0; index < 107; index += 1) seed(index, "completed");
    for (let index = 0; index < 73; index += 1) seed(1000 + index, "failed");

    const before = registry.snapshot();
    const inventory = (snapshot: typeof before) => ({
      receipts: Object.keys(snapshot.receipts).length,
      byState: Object.values(snapshot.receipts).reduce<Record<string, number>>((acc, receipt) => {
        acc[receipt.state] = (acc[receipt.state] ?? 0) + 1;
        return acc;
      }, {}),
      conversations: Object.keys(snapshot.conversations).length,
      lineageEdges: Object.keys(snapshot.lineageEdges).length,
    });
    const beforeInventory = inventory(before);
    expect(beforeInventory.receipts).toBe(180);
    expect(beforeInventory.byState).toEqual({ completed: 107, failed: 73 });
    expect(beforeInventory.lineageEdges).toBe(180);

    const baselineNow = Date.now();
    const withinWindow = preallocatedStructuredSpawnCards([], before, baselineNow);
    expect(withinWindow).toHaveLength(180);

    /* One day later — no registry write, no restart-as-cleanup: the whole
       terminal baseline retires from the projection. */
    const afterRetirement = baselineNow + 25 * 60 * 60 * 1_000;
    expect(preallocatedStructuredSpawnCards([], before, afterRetirement)).toEqual([]);
    /* Idempotent and byte-stable across repeated projections. */
    expect(preallocatedStructuredSpawnCards([], before, afterRetirement)).toEqual([]);

    /* Restart: a fresh load projects identically and loses nothing. */
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const after = restarted.snapshot();
    expect(inventory(after)).toEqual(beforeInventory);
    expect(preallocatedStructuredSpawnCards([], after, afterRetirement)).toEqual([]);
    expect(preallocatedStructuredSpawnCards([], after, baselineNow)).toHaveLength(180);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
