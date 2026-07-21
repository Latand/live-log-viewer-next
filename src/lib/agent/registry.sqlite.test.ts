import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry, RegistryParityError } from "./registry";

const CHILD = path.join(import.meta.dir, "registry.sqliteChild.ts");

function waitFor(pathname: string): void {
  while (!fs.existsSync(pathname)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)]!;
}

test("SQLite first boot imports JSON and preserves membership and capability digest paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-import-"));
  const filename = path.join(directory, "agent-registry.json");
  const digest = "a".repeat(64);
  const legacy = new AgentRegistry(filename);
  const begun = legacy.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: digest,
    memberships: [{
      kind: "flow",
      containerId: "flow-187",
      role: "builder",
      slot: "builder:0",
      stageId: null,
      stageOrder: null,
      round: null,
      parentConversationId: null,
    }],
  });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  const expected = legacy.snapshot();

  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read", mirrorCheckpointMs: 0 });

  expect(fs.existsSync(path.join(directory, "agent-registry.sqlite"))).toBeTrue();
  expect(sqlite.snapshot()).toEqual(expected);
  expect(sqlite.conversationIdForSpawnCapabilityDigest(digest)).toBe(begun.receipt.conversationId);
  expect(sqlite.snapshot().memberships[begun.receipt.conversationId]).toEqual([
    expect.objectContaining({ containerId: "flow-187", slot: "builder:0" }),
  ]);

  sqlite.rememberMembership(begun.receipt.conversationId, {
    kind: "pipeline",
    containerId: "pipeline-187",
    role: "builder",
    slot: "stage:build",
    stageId: "build",
    stageOrder: 1,
    round: null,
    parentConversationId: null,
  });
  sqlite.checkpointRollbackMirror();

  expect(new AgentRegistry(filename).snapshot()).toEqual(sqlite.snapshot());
});

for (const version of [1, 2]) {
  test(`dual-write migration normalizes a legacy v${version} registry deterministically across processes`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-sqlite-legacy-v${version}-`));
    const filename = path.join(directory, "agent-registry.json");
    fs.writeFileSync(filename, JSON.stringify({ version, entries: {}, receipts: {} }));

    const first = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
    expect(first.snapshot().autoBalance.claude.restartedAt).toBe(first.snapshot().autoBalance.codex.restartedAt);

    const ready = path.join(directory, "restart.ready");
    const release = path.join(directory, "restart.release");
    const restarted = Bun.spawn([
      process.execPath,
      CHILD,
      "dual-writer",
      filename,
      ready,
      release,
      `legacy-v${version}-restart`,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    waitFor(ready);
    fs.writeFileSync(release, "start");
    expect(await restarted.exited).toBe(0);
    expect(await new Response(restarted.stderr).text()).toBe("");
  });
}

test("supersedence edges round-trip JSON ↔ SQLite with parity intact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-supersede-"));
  const filename = path.join(directory, "agent-registry.json");
  const store = new AgentRegistry(filename);
  const predecessor = store.ensureConversation("codex", "/rounds/predecessor.jsonl", "a");
  const successor = store.ensureConversation("codex", "/rounds/successor.jsonl", "a");
  store.recordSupersedence(predecessor.id, successor.id, "recovery-spawn");
  const expected = store.snapshot();

  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read", mirrorCheckpointMs: 0 });
  expect(sqlite.snapshot()).toEqual(expected);
  expect(sqlite.conversation(predecessor.id)?.supersededBy).toMatchObject({
    conversationId: successor.id,
    reason: "recovery-spawn",
  });

  sqlite.clearSupersedence(predecessor.id);
  expect(sqlite.conversation(predecessor.id)?.supersededBy).toBeNull();
  sqlite.checkpointRollbackMirror();
  expect(new AgentRegistry(filename).conversation(predecessor.id)?.supersededBy).toBeNull();
});

test("a staged pending supersedence edge round-trips JSON ↔ SQLite with parity intact (#383 repair)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-pending-"));
  const filename = path.join(directory, "agent-registry.json");
  const store = new AgentRegistry(filename);
  const predecessorSessionId = ["819f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
  const successorSessionId = ["919f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
  const predecessorPath = `/repo/${predecessorSessionId}.jsonl`;
  const predecessor = store.ensureConversation("codex", predecessorPath, "a");
  store.upsert({
    key: { engine: "codex", sessionId: predecessorSessionId },
    artifactPath: predecessorPath,
    cwd: "/repo",
    accountId: "a",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a", supersedes: predecessor.id, supersedesReason: "stage-retry" });
  if (begun.kind !== "created") throw new Error("expected create");
  store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: successorSessionId },
    artifactPath: `/sessions/${successorSessionId}.jsonl`,
    cwd: "/repo",
    accountId: "a",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  expect(Object.keys(store.snapshot().pendingSupersedence)).toHaveLength(1);

  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  expect(sqlite.snapshot()).toEqual(store.snapshot());
  expect(Object.values(sqlite.snapshot().pendingSupersedence)).toMatchObject([{
    predecessorConversationId: predecessor.id,
    successorConversationId: begun.receipt.conversationId,
    reason: "stage-retry",
  }]);
});

test("dual-write keeps JSON authoritative and SQLite reads require parity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-parity-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  const dual = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  const receipt = dual.beginSpawn("codex", "/parity");

  expect(new AgentRegistry(filename).snapshot().receipts[receipt.launchId]).toEqual(
    new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot().receipts[receipt.launchId],
  );

  const db = new Database(sqliteFilename);
  const stored = db.query<{ value_json: string }, [string, string]>(
    "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("receipts", receipt.launchId);
  if (!stored) throw new Error("expected SQLite receipt");
  const changed = JSON.parse(stored.value_json) as { cwd: string };
  changed.cwd = "/drifted";
  db.query("UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify(changed), "receipts", receipt.launchId);
  db.close();

  expect(() => new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" })).toThrow(RegistryParityError);
});

test("SQLite restart normalizes legacy held-delivery rows before parity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-held-upgrade-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = sqlite.ensureConversation("codex", "/sessions/legacy-held.jsonl", "default");
  const reserved = sqlite.holdDelivery(conversation.id, "continue after SQLite upgrade", "legacy-sqlite-held");

  const db = new Database(sqliteFilename);
  const stored = db.query<{ value_json: string }, [string, string]>(
    "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("heldDeliveries", reserved.id);
  if (!stored) throw new Error("expected the held-delivery SQLite row");
  const legacy = JSON.parse(stored.value_json) as Partial<typeof reserved>;
  delete legacy.command;
  delete legacy.requestDigest;
  db.query("UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify(legacy), "heldDeliveries", reserved.id);
  db.close();

  const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(restarted.pendingDeliveries(conversation.id)[0]).toMatchObject({
    id: reserved.id,
    command: {
      operationId: reserved.id,
      kind: "send",
      policy: "interrupt-active",
    },
    requestDigest: expect.any(String),
  });
});

test("SQLite restart derives and persists explicit operation ownership before tombstone compaction", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-operation-owner-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = sqlite.ensureConversation("codex", "/sessions/sqlite-operation-owner.jsonl", "default");
  const command = { operationId: "sqlite-operation-owner", kind: "send" as const, policy: "queue" as const };
  const original = sqlite.holdDelivery(
    conversation.id,
    "retain SQLite operation ownership",
    "sqlite-operation-owner-client",
    "text",
    [],
    null,
    command,
  );
  const claimed = sqlite.beginDeliveryAttempt(original.id, original.generationId!);
  expect(claimed).not.toBeNull();
  sqlite.recordDeliveryOutcome(original.id, "delivered");

  const legacyDb = new Database(sqliteFilename);
  legacyDb.query("DELETE FROM registry_rows WHERE collection = ?").run("deliveryOperationOwners");
  legacyDb.close();

  const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(restarted.snapshot().deliveryOperationOwners[command.operationId]).toMatchObject({
    clientMessageId: "sqlite-operation-owner-client",
    deliveryId: original.id,
    command,
  });
  for (let index = 0; index < 101; index += 1) {
    const delivery = restarted.holdDelivery(
      conversation.id,
      `later SQLite delivery ${index}`,
      `later-sqlite-delivery-${index}`,
    );
    restarted.recordDeliveryOutcome(delivery.id, "delivered");
  }
  expect(restarted.snapshot().heldDeliveries[original.id]).toBeUndefined();

  const persistedDb = new Database(sqliteFilename, { readonly: true });
  expect(persistedDb.query<{ count: number }, [string, string]>(
    "SELECT COUNT(*) AS count FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("deliveryOperationOwners", command.operationId)?.count).toBe(1);
  persistedDb.close();
  const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(reopened.snapshot().deliveryOperationOwners[command.operationId]).toMatchObject({
    terminalState: "delivered",
    requestDigest: original.requestDigest,
  });
  expect(reopened.snapshot().deliveryOperationOwners[command.operationId]).not.toHaveProperty("settledDelivery");
  expect(() => reopened.holdDelivery(
    conversation.id,
    "retain SQLite operation ownership",
    "second-sqlite-operation-owner-client",
    "text",
    [],
    null,
    command,
  )).toThrow("operation id is already reserved for another client message");
  expect(reopened.holdDelivery(
    conversation.id,
    "retain SQLite operation ownership",
    "sqlite-operation-owner-client",
    "text",
    [],
    null,
    command,
  )).toMatchObject({ id: original.id, state: "delivered", command });
});

test("terminal operation ownership stays bounded and payload-free in JSON and SQLite", () => {
  for (const backend of ["json", "sqlite"] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-bounded-owners-${backend}-`));
    const filename = path.join(directory, "agent-registry.json");
    const sqliteFilename = path.join(directory, "agent-registry.sqlite");
    const storage = { sqliteMode: backend === "sqlite" ? "sqlite" as const : "off" as const };
    let store = new AgentRegistry(filename, undefined, undefined, storage);
    const conversation = store.ensureConversation("codex", `/sessions/bounded-owners-${backend}.jsonl`, "default");
    const writeFailures = (start: number, end: number) => {
      for (let index = start; index < end; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const delivery = store.holdDelivery(
          conversation.id,
          `sensitive failed payload ${backend} ${suffix}`,
          `bounded-owner-client-${backend}-${suffix}`,
          "text",
          [],
          null,
          {
            operationId: `bounded-owner-operation-${backend}-${suffix}`,
            kind: "send",
            policy: "queue",
          },
        );
        if (!store.beginDeliveryAttempt(delivery.id, delivery.generationId!)) {
          throw new Error("expected explicit operation delivery attempt");
        }
        store.recordDeliveryOutcome(delivery.id, "failed", "host unavailable");
      }
    };
    const sqliteOwnerStats = () => {
      const db = new Database(sqliteFilename, { readonly: true });
      const stats = db.query<{ count: number; bytes: number }, [string]>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(value_json)), 0) AS bytes FROM registry_rows WHERE collection = ?",
      ).get("deliveryOperationOwners")!;
      const payload = db.query<{ value_json: string }, [string]>(
        "SELECT value_json FROM registry_rows WHERE collection = ? ORDER BY row_order",
      ).all("deliveryOperationOwners").map((row) => row.value_json).join("\n");
      db.close();
      return { ...stats, payload };
    };

    writeFailures(0, 220);
    const firstJsonBytes = fs.statSync(filename).size;
    const firstSqliteStats = backend === "sqlite" ? sqliteOwnerStats() : null;
    writeFailures(220, 440);
    store.compactDeliveryReservations();

    const snapshot = store.snapshot();
    expect(Object.keys(snapshot.deliveryOperationOwners)).toHaveLength(200);
    expect(Object.values(snapshot.deliveryOperationOwners).every((owner) =>
      owner.terminalState === "failed" && !("settledDelivery" in owner))).toBeTrue();
    const retainedIndex = "250";
    const retainedOperationId = `bounded-owner-operation-${backend}-${retainedIndex}`;
    const retainedText = `sensitive failed payload ${backend} ${retainedIndex}`;
    const retainedClientId = `bounded-owner-client-${backend}-${retainedIndex}`;
    expect(snapshot.deliveryOperationOwners[retainedOperationId]).toMatchObject({
      terminalState: "failed",
      requestDigest: expect.any(String),
    });
    expect(Object.values(snapshot.heldDeliveries)
      .some((delivery) => delivery.command.operationId === retainedOperationId)).toBeFalse();
    expect(fs.readFileSync(filename, "utf8")).not.toContain(retainedText);
    expect(fs.statSync(filename).size).toBeLessThanOrEqual(firstJsonBytes + 16_384);
    if (backend === "sqlite") {
      const secondSqliteStats = sqliteOwnerStats();
      expect(secondSqliteStats.count).toBe(200);
      expect(secondSqliteStats.bytes).toBeLessThanOrEqual(firstSqliteStats!.bytes + 4_096);
      expect(secondSqliteStats.payload).not.toContain(retainedText);
    }

    store = new AgentRegistry(filename, undefined, undefined, storage);
    expect(store.holdDelivery(
      conversation.id,
      retainedText,
      retainedClientId,
      "text",
      [],
      null,
      { operationId: retainedOperationId, kind: "send", policy: "queue" },
    )).toMatchObject({ state: "failed", text: retainedText });
    expect(Object.values(store.snapshot().heldDeliveries)
      .some((delivery) => delivery.command.operationId === retainedOperationId)).toBeFalse();
    expect(() => store.holdDelivery(
      conversation.id,
      `${retainedText} changed`,
      retainedClientId,
      "text",
      [],
      null,
      { operationId: retainedOperationId, kind: "send", policy: "queue" },
    )).toThrow("operation id is already reserved for another client message");
    const unrelated = store.ensureConversation("codex", `/sessions/unrelated-${backend}.jsonl`, "default");
    expect(() => store.holdDelivery(
      unrelated.id,
      retainedText,
      retainedClientId,
      "text",
      [],
      null,
      { operationId: retainedOperationId, kind: "send", policy: "queue" },
    )).toThrow("operation id is already reserved for another client message");
  }
}, 15_000);

test("dual-write leaves both backends unchanged after a no-op mutation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-noop-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  let replaceCalls = 0;
  const dual = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "dual-write",
    beforeDualWriteMutationReplace: () => { replaceCalls += 1; },
  });
  dual.setEngineRouting("codex", "work");
  expect(replaceCalls).toBe(1);
  const before = fs.statSync(filename);
  const db = new Database(sqliteFilename);
  const revision = () => Number(db.query<{ value: string }, [string]>(
    "SELECT value FROM registry_meta WHERE key = ?",
  ).get("revision")?.value ?? -1);
  const beforeRevision = revision();

  expect(dual.releaseStructuredHostClaim(
    { engine: "codex", sessionId: "missing-session" },
    "missing-owner",
    99,
  )).toBeFalse();

  const after = fs.statSync(filename);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(revision()).toBe(beforeRevision);
  expect(replaceCalls).toBe(1);
  db.close();
});

for (const sqliteMode of ["read", "sqlite"] as const) {
  test(`${sqliteMode} mode leaves the durable revision unchanged after a missing claim release`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-${sqliteMode}-noop-`));
    const filename = path.join(directory, "agent-registry.json");
    new AgentRegistry(filename).beginSpawn("codex", "/seed");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
    const before = registry.storageDiagnostics().revision;

    expect(registry.releaseStructuredHostClaim({ engine: "codex", sessionId: "missing" }, "owner", 1)).toBeFalse();

    expect(registry.storageDiagnostics().revision).toBe(before);
    expect(registry.storageDiagnostics().mirrorDirty).toBeFalse();
  });
}

test("dual-write fails closed when SQLite is ahead of its JSON mirror", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-transition-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = sqlite.ensureConversation("codex", "/sessions/sqlite-only.jsonl", "sqlite-only");
  const staleMirror = fs.readFileSync(filename, "utf8");

  expect(() => new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" })).toThrow(RegistryParityError);
  expect(fs.readFileSync(filename, "utf8")).toBe(staleMirror);

  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(recovered.snapshot().conversations[conversation.id]).toBeDefined();
  expect(new AgentRegistry(filename).snapshot().conversations[conversation.id]).toBeDefined();
});

test("dual-write startup serializes SQLite replacement with a concurrent writer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-dual-startup-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  const startupReady = path.join(directory, "startup.ready");
  const releaseStartup = path.join(directory, "startup.release");
  const startup = Bun.spawn([process.execPath, CHILD, "dual-startup", filename, startupReady, releaseStartup], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(startupReady);

  const writerReady = path.join(directory, "writer.ready");
  const startWriter = path.join(directory, "writer.start");
  const attempted = path.join(directory, "writer.attempted");
  const writer = Bun.spawn([
    process.execPath,
    CHILD,
    "dual-writer",
    filename,
    writerReady,
    startWriter,
    "concurrent-dual-writer",
    "0",
    attempted,
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  waitFor(writerReady);
  fs.writeFileSync(startWriter, "start");
  waitFor(attempted);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  expect(fs.existsSync(`${attempted}.done`)).toBeFalse();

  fs.writeFileSync(releaseStartup, "release");
  expect(await Promise.all([startup.exited, writer.exited])).toEqual([0, 0]);
  expect(await Promise.all([
    new Response(startup.stderr).text(),
    new Response(writer.stderr).text(),
  ])).toEqual(["", ""]);

  const dual = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  expect(Object.values(dual.snapshot().conversations).some((conversation) =>
    conversation.generations.some((generation) => generation.path === "/sessions/concurrent-dual-writer.jsonl"))).toBeTrue();
});

for (const mode of ["read", "sqlite"] as const) {
  test(`dual-write startup fails closed across a concurrent ${mode} writer`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-${mode}-transition-`));
    const filename = path.join(directory, "agent-registry.json");
    new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
    const startupReady = path.join(directory, "startup.ready");
    const releaseStartup = path.join(directory, "startup.release");
    const startup = Bun.spawn([process.execPath, CHILD, "dual-startup", filename, startupReady, releaseStartup], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    waitFor(startupReady);

    const writerReady = path.join(directory, "writer.ready");
    const startWriter = path.join(directory, "writer.start");
    const writerDone = path.join(directory, "writer.done");
    const writer = Bun.spawn([
      process.execPath,
      CHILD,
      "transition-writer",
      filename,
      writerReady,
      startWriter,
      mode,
      "0",
      writerDone,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    waitFor(writerReady);
    fs.writeFileSync(startWriter, "start");
    expect(await writer.exited).toBe(0);
    expect(await new Response(writer.stderr).text()).toBe("");

    fs.writeFileSync(releaseStartup, "release");
    expect(await startup.exited).not.toBe(0);
    expect(await new Response(startup.stderr).text()).toContain("RegistryParityError");

    const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(Object.values(sqlite.snapshot().conversations).some((conversation) =>
      conversation.generations.some((generation) => generation.path === `/sessions/${mode}.jsonl`))).toBeTrue();
    expect(new AgentRegistry(filename).snapshot()).toEqual(sqlite.snapshot());
    expect(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" })
      .conversationForPath(`/sessions/${mode}.jsonl`)).toBeDefined();
  });
}

test("dual-write mutation fails closed across a concurrent SQLite writer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-dual-mutation-transition-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  const writerReady = path.join(directory, "writer.ready");
  const startWriter = path.join(directory, "writer.start");
  const writerDone = path.join(directory, "writer.done");
  const writer = Bun.spawn([
    process.execPath,
    CHILD,
    "transition-writer",
    filename,
    writerReady,
    startWriter,
    "sqlite",
    "0",
    writerDone,
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  waitFor(writerReady);
  const dual = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "dual-write",
    beforeDualWriteMutationReplace: () => {
      fs.writeFileSync(startWriter, "start");
      waitFor(`${writerDone}.done`);
    },
  });

  expect(() => dual.ensureConversation("codex", "/sessions/dual.jsonl", "dual")).toThrow(RegistryParityError);
  expect(await writer.exited).toBe(0);
  expect(await new Response(writer.stderr).text()).toBe("");

  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  expect(recovered.conversationForPath("/sessions/sqlite.jsonl")).toBeDefined();
  expect(recovered.conversationForPath("/sessions/dual.jsonl")).toBeNull();
  expect(new AgentRegistry(filename).snapshot()).toEqual(recovered.snapshot());
});

test("SQLite restart preserves first-owner insertion order for shared paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-order-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const first = sqlite.ensureConversation("codex", "/sessions/first-owner.jsonl", "first");
  let later = sqlite.ensureConversation("codex", "/sessions/later-owner-0.jsonl", "later");
  for (let attempt = 1; first.id < later.id && attempt < 100; attempt += 1) {
    later = sqlite.ensureConversation("codex", `/sessions/later-owner-${attempt}.jsonl`, "later");
  }
  if (first.id < later.id) throw new Error("failed to create reverse-lexical conversation ids");
  const db = new Database(path.join(directory, "agent-registry.sqlite"));
  const stored = db.query<{ value_json: string }, [string, string]>(
    "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("conversations", later.id);
  if (!stored) throw new Error("expected the later SQLite conversation");
  const duplicateOwner = JSON.parse(stored.value_json) as { continuityPaths: string[] };
  duplicateOwner.continuityPaths.push("/sessions/first-owner.jsonl");
  db.query("UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify(duplicateOwner), "conversations", later.id);
  db.close();

  const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });

  expect(restarted.conversationForPath("/sessions/first-owner.jsonl")?.id).toBe(first.id);
});

test("rollback rebaseline imports off-mode writes into a fresh SQLite database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-rollback-rebaseline-"));
  const filename = path.join(directory, "agent-registry.json");
  const dualReady = path.join(directory, "dual.ready");
  const startDual = path.join(directory, "dual.start");
  const dual = Bun.spawn([
    process.execPath,
    CHILD,
    "dual-writer",
    filename,
    dualReady,
    startDual,
    "before-rollback",
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  waitFor(dualReady);
  fs.writeFileSync(startDual, "start");
  expect(await dual.exited).toBe(0);

  const offReady = path.join(directory, "off.ready");
  const startOff = path.join(directory, "off.start");
  const off = Bun.spawn([
    process.execPath,
    CHILD,
    "writer-json",
    filename,
    offReady,
    startOff,
    "after-rollback",
    "1",
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  waitFor(offReady);
  fs.writeFileSync(startOff, "start");
  expect(await off.exited).toBe(0);

  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const active = `${sqliteFilename}${suffix}`;
    if (fs.existsSync(active)) fs.renameSync(active, `${active}.rollback-evidence`);
  }

  const resumed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  expect(resumed.conversationForPath("/sessions/after-rollback-000.jsonl")).toBeDefined();
  expect(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" })
    .conversationForPath("/sessions/after-rollback-000.jsonl")).toBeDefined();
});

test("two SQLite registry processes preserve every concurrent write without registry locks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-writers-"));
  const filename = path.join(directory, "agent-registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  seed.ensureConversation("codex", "/sessions/seed.jsonl", "seed");
  const start = path.join(directory, "start");
  const count = 40;
  const children = ["alpha", "beta"].map((label) => {
    const ready = path.join(directory, `${label}.ready`);
    const child = Bun.spawn([process.execPath, CHILD, "writer", filename, ready, start, label, String(count)], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { child, ready };
  });
  for (const { ready } of children) waitFor(ready);
  fs.writeFileSync(start, "start");

  const exits = await Promise.all(children.map(({ child }) => child.exited));
  const errors = await Promise.all(children.map(({ child }) => new Response(child.stderr).text()));
  expect(exits).toEqual([0, 0]);
  expect(errors).toEqual(["", ""]);

  const snapshot = seed.snapshot();
  const written = Object.values(snapshot.conversations).filter((conversation) =>
    conversation.generations.some((generation) => /\/(?:alpha|beta)-\d+\.jsonl$/.test(generation.path)));
  expect(written).toHaveLength(count * 2);
  expect(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot()).toEqual(snapshot);
  expect(fs.existsSync(`${filename}.write-lock`)).toBeFalse();
});

test("WAL readers stay available during a writer transaction", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-reader-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  const existing = registry.ensureConversation("codex", "/sessions/reader-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const child = Bun.spawn([process.execPath, CHILD, "hold", filename, ready, release], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(registry.snapshot().conversations[existing.id]).toBeDefined();
  expect(registry.snapshot().conversations.conversation_crash_mid_write).toBeUndefined();

  fs.writeFileSync(release, "release");
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  expect(registry.snapshot().conversations.conversation_crash_mid_write).toBeDefined();
});

test("a process exit inside a SQLite transaction rolls the registry back", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-crash-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  const existing = registry.ensureConversation("codex", "/sessions/crash-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const unusedRelease = path.join(directory, "unused-release");
  const child = Bun.spawn([process.execPath, CHILD, "crash", filename, ready, unusedRelease], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(await child.exited).toBe(73);
  expect(await new Response(child.stderr).text()).toBe("");
  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(recovered.conversations[existing.id]).toBeDefined();
  expect(recovered.conversations.conversation_crash_mid_write).toBeUndefined();
});

test("restart refreshes the JSON rollback mirror after a post-commit process exit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-post-commit-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  registry.ensureConversation("codex", "/sessions/post-commit-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const unusedRelease = path.join(directory, "unused-release");
  const child = Bun.spawn([process.execPath, CHILD, "commit-crash", filename, ready, unusedRelease], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(await child.exited).toBe(74);
  expect(await new Response(child.stderr).text()).toBe("");
  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(recovered.conversations.conversation_crash_mid_write).toBeDefined();
  expect(new AgentRegistry(filename).snapshot()).toEqual(recovered);
});

test("SQLite-only operations avoid JSON rewrites and the read mode prepares rollback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-only-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const before = fs.readFileSync(filename, "utf8");

  const conversation = sqlite.ensureConversation("codex", "/sessions/sqlite-only.jsonl", "work");

  expect(sqlite.snapshot().conversations[conversation.id]).toBeDefined();
  expect(fs.readFileSync(filename, "utf8")).toBe(before);
  const rollback = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(new AgentRegistry(filename).snapshot()).toEqual(rollback);
  expect(rollback.conversations[conversation.id]).toBeDefined();
});

test("SQLite demotion checkpoint publishes every revision without streaming mirror writes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-demotion-checkpoint-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const externalWriter = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const before = JSON.parse(fs.readFileSync(filename, "utf8")) as { _sqliteRevision: number };
  externalWriter.beginSpawn("codex", "/after-promotion");
  const stale = JSON.parse(fs.readFileSync(filename, "utf8")) as { _sqliteRevision: number };
  expect(stale._sqliteRevision).toBe(before._sqliteRevision);
  expect(registry.storageDiagnostics().mirrorDirty).toBeTrue();

  registry.checkpointRollbackMirror();

  const checkpoint = JSON.parse(fs.readFileSync(filename, "utf8")) as { _sqliteRevision: number };
  expect(checkpoint._sqliteRevision).toBe(registry.storageDiagnostics().revision!);
  expect(registry.storageDiagnostics().mirrorDirty).toBeFalse();
});

test("dual-write release demotion leaves the authoritative JSON handoff untouched", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-dual-write-handoff-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  let rollbackWrites = 0;
  const retiring = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "dual-write",
    afterMirrorWrite: () => { rollbackWrites += 1; },
  });
  const successor = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });

  retiring.checkpointRollbackMirror();
  successor.beginSpawn("codex", "/successor");

  expect(rollbackWrites).toBe(0);
  expect(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot())
    .toEqual(successor.snapshot());
});

test("read mode bounds rollback mirror writes and exposes checkpoint diagnostics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-mirror-cadence-"));
  const filename = path.join(directory, "agent-registry.json");
  let now = 1_000;
  const checkpoints: Array<() => void> = [];
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    mirrorCheckpointMs: 5_000,
    now: () => now,
    scheduleMirrorCheckpoint: (callback) => {
      checkpoints.push(callback);
      return { unref() {} };
    },
  });
  const initialRevision = JSON.parse(fs.readFileSync(filename, "utf8"))._sqliteRevision;

  registry.beginSpawn("codex", "/cursor-1");
  registry.beginSpawn("codex", "/cursor-2");
  expect(JSON.parse(fs.readFileSync(filename, "utf8"))._sqliteRevision).toBe(initialRevision);
  expect(registry.storageDiagnostics()).toMatchObject({
    backendMode: "read",
    mirrorDirty: true,
    mirrorAgeMs: 0,
  });

  now += 5_001;
  expect(checkpoints).toHaveLength(1);
  checkpoints.shift()!();
  expect(JSON.parse(fs.readFileSync(filename, "utf8"))._sqliteRevision).toBeGreaterThan(initialRevision);
  expect(registry.storageDiagnostics()).toMatchObject({ mirrorDirty: false, mirrorAgeMs: 0 });
});

test("read mode schedules only the remaining rollback checkpoint interval", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-mirror-boundary-"));
  const filename = path.join(directory, "agent-registry.json");
  let now = 1_000;
  const delays: number[] = [];
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    mirrorCheckpointMs: 5_000,
    now: () => now,
    scheduleMirrorCheckpoint: (_callback, delayMs) => {
      delays.push(delayMs);
      return { unref() {} };
    },
  });

  now += 4_999;
  registry.beginSpawn("codex", "/boundary");

  expect(registry.storageDiagnostics().mirrorAgeMs).toBe(4_999);
  expect(delays).toEqual([1]);
});

test("one rollback checkpoint publishes one coherent snapshot under sustained writers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-bounded-checkpoint-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const writer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const scheduled: Array<() => void> = [];
  let concurrentWrites = false;
  let mirrorWrites = 0;
  const checkpoint = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    mirrorCheckpointMs: 60_000,
    scheduleMirrorCheckpoint: (callback) => { scheduled.push(callback); return { unref() {} }; },
    afterMirrorWrite: () => {
      mirrorWrites += 1;
      if (concurrentWrites) writer.beginSpawn("codex", `/concurrent-${mirrorWrites}`);
    },
  });
  checkpoint.beginSpawn("codex", "/dirty");
  concurrentWrites = true;
  const startedAt = performance.now();
  checkpoint.checkpointRollbackMirror();

  expect(mirrorWrites).toBe(2); // startup plus this checkpoint
  expect(performance.now() - startedAt).toBeLessThan(100);
  expect(checkpoint.storageDiagnostics().mirrorDirty).toBeTrue();
  expect(scheduled).toHaveLength(1);
  const mirror = JSON.parse(fs.readFileSync(filename, "utf8")) as { _sqliteRevision: number };
  expect(mirror._sqliteRevision).toBeLessThan(writer.storageDiagnostics().revision!);
});

test("release demotion converges a mirror dirtied by one concurrent successor commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-demotion-convergence-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const successor = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  let concurrentCommit = false;
  const retiring = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    afterMirrorWrite: () => {
      if (!concurrentCommit) return;
      concurrentCommit = false;
      successor.beginSpawn("codex", "/successor-during-checkpoint");
    },
  });
  successor.beginSpawn("codex", "/dirty-before-demotion");
  concurrentCommit = true;

  retiring.checkpointRollbackMirrorForDemotion();

  const json = JSON.parse(fs.readFileSync(filename, "utf8")) as { _sqliteRevision: number };
  expect(json._sqliteRevision).toBe(successor.storageDiagnostics().revision!);
  expect(retiring.storageDiagnostics().mirrorDirty).toBeFalse();
});

test("release demotion fails closed after bounded continuously dirty checkpoints", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-demotion-bounded-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const successor = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  let mirrorWrites = 0;
  const retiring = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    afterMirrorWrite: () => {
      mirrorWrites += 1;
      successor.beginSpawn("codex", `/successor-${mirrorWrites}`);
    },
  });

  expect(() => retiring.checkpointRollbackMirrorForDemotion()).toThrow("did not converge");
  expect(mirrorWrites).toBe(3); // startup plus two bounded demotion attempts
});

test("failed rollback checkpoints retry with bounded backoff until the mirror converges", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-checkpoint-retry-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let failCheckpoint = false;
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    mirrorCheckpointMs: 5_000,
    now: () => 1_000,
    scheduleMirrorCheckpoint: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return { unref() {} };
    },
    afterMirrorWrite: () => {
      if (failCheckpoint) throw new Error("injected checkpoint failure");
    },
  });
  registry.beginSpawn("codex", "/dirty");
  expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([5_000]);

  failCheckpoint = true;
  scheduled.shift()!.callback();
  expect(registry.storageDiagnostics().mirrorDirty).toBeTrue();
  expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000]);

  failCheckpoint = false;
  scheduled.shift()!.callback();
  expect(registry.storageDiagnostics().mirrorDirty).toBeFalse();
  expect(scheduled).toHaveLength(0);
});

test("production-sized read burn-in defers full snapshot loading until its checkpoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-read-no-snapshot-"));
  const filename = path.join(directory, "agent-registry.json");
  const seed = new AgentRegistry(filename);
  const template = seed.beginSpawn("codex", "/read-seed");
  const production = seed.snapshot();
  for (let index = 1; index < 18_000; index += 1) {
    const launchId = `read-seed-${String(index).padStart(5, "0")}`;
    production.receipts[launchId] = { ...structuredClone(template), launchId };
  }
  const payload = JSON.stringify(production);
  expect(Buffer.byteLength(payload)).toBeGreaterThanOrEqual(14_660_822);
  fs.writeFileSync(filename, payload);
  let snapshotLoads = 0;
  let now = 1_000;
  const checkpoints: Array<() => void> = [];
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "read",
    mirrorCheckpointMs: 60_000,
    now: () => now,
    scheduleMirrorCheckpoint: (callback) => {
      checkpoints.push(callback);
      return { unref() {} };
    },
    onSqliteSnapshotLoad: () => { snapshotLoads += 1; },
  });
  const startupLoads = snapshotLoads;
  const durations: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const startedAt = performance.now();
    registry.ensureConversation("codex", `/sessions/read-${index}.jsonl`, "read-burn-in");
    durations.push(performance.now() - startedAt);
  }

  expect(snapshotLoads).toBe(startupLoads);
  expect(percentile(durations, 0.95)).toBeLessThan(250);
  expect(registry.storageDiagnostics().mirrorDirty).toBeTrue();

  now += 60_000;
  const dueStartedAt = performance.now();
  registry.ensureConversation("codex", "/sessions/read-due.jsonl", "read-burn-in");
  const dueMutationMs = performance.now() - dueStartedAt;
  expect(dueMutationMs).toBeLessThan(250);
  expect(snapshotLoads).toBe(startupLoads);

  checkpoints.shift()!();
  expect(snapshotLoads).toBe(startupLoads + 1);
  expect(registry.storageDiagnostics().mirrorDirty).toBeFalse();
});

test("SQLite snapshot cache follows external revisions and reports writer metrics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-snapshot-cache-"));
  const filename = path.join(directory, "agent-registry.json");
  new AgentRegistry(filename).beginSpawn("codex", "/seed");
  const waits: number[] = [];
  const first = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteWriterWait: (duration) => waits.push(duration),
  });
  const second = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });

  first.readOnlySnapshot();
  second.beginSpawn("codex", "/external-writer");
  expect(first.readOnlySnapshot().receipts).toEqual(expect.objectContaining(
    Object.fromEntries(Object.entries(second.snapshot().receipts)),
  ));
  first.beginSpawn("codex", "/metric-writer");
  expect(waits.length).toBeGreaterThan(0);
  expect(first.storageDiagnostics()).toMatchObject({
    backendMode: "sqlite",
    revision: expect.any(Number),
    transactionCount: expect.any(Number),
    writerRatePerSecond: expect.any(Number),
    writerWaitP95Ms: expect.any(Number),
    transactionP95Ms: expect.any(Number),
  });
});

test.each(["off", "dual-write", "read", "sqlite"] as const)(
  "%s diagnostics keep cumulative counts and a rolling rate beyond the percentile sample cap",
  (sqliteMode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-metrics-${sqliteMode}-`));
    const filename = path.join(directory, "agent-registry.json");
    let clock = 0;
    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode,
      now: () => clock,
      mirrorCheckpointMs: 60_000,
    });
    for (let index = 0; index < 650; index += 1) {
      registry.beginSpawn("codex", `/metric-${index}`);
      clock += 100;
    }

    expect(registry.storageDiagnostics()).toMatchObject({
      backendMode: sqliteMode,
      transactionCount: 650,
      writerRatePerSecond: expect.closeTo(9.83, 1),
      transactionP95Ms: expect.any(Number),
    });
  },
  30_000,
);

test("SQLite adoption keeps structured-host writer epochs fenced across restarts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-adoption-"));
  const filename = path.join(directory, "agent-registry.json");
  const key = { engine: "codex" as const, sessionId: "sqlite-adoption" };
  const structuredHost = {
    kind: "codex-app-server" as const,
    endpoint: "stdio:released",
    process: null,
    eventCursor: 4,
    protocolVersion: "1",
    writerClaimEpoch: 0,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
  const first = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "read" });
  first.upsert({
    key,
    artifactPath: "/sessions/sqlite-adoption.jsonl",
    cwd: "/repo",
    accountId: "work",
    status: "unhosted",
    host: null,
    structuredHost,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const firstClaim = first.claimStructuredHost(key, { pid: 41, startIdentity: "41:first" }, { allowUnhosted: true });
  if (!firstClaim?.claimOwner) throw new Error("expected the first writer claim");

  const restarted = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "read" });
  const replacement = restarted.claimStructuredHost(key, { pid: 42, startIdentity: "42:replacement" }, { allowUnhosted: true });
  if (!replacement?.claimOwner) throw new Error("expected the replacement writer claim");

  expect(replacement.claimEpoch).toBe(firstClaim.claimEpoch + 1);
  expect(first.setStructuredHostClaimed(key, structuredHost, "idle", firstClaim.claimOwner, firstClaim.claimEpoch)).toBeNull();
  expect(restarted.setStructuredHostClaimed(
    key,
    { ...structuredHost, writerClaimEpoch: replacement.claimEpoch, eventCursor: 5 },
    "idle",
    replacement.claimOwner,
    replacement.claimEpoch,
    true,
  )).toMatchObject({ status: "idle", claimOwner: null, structuredHost: { eventCursor: 5 } });
});

test("production-sized SQLite registry bounds ten-lane writes, concurrent reads, and JSON rewrites", async () => {
  const PRODUCTION_BYTES = 14_660_822;
  async function measure(): Promise<{
    operationP95: number;
    writerWaitP95: number;
    readerP95: number;
  }> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-production-ten-lane-"));
    const filename = path.join(directory, "agent-registry.json");
    const seed = new AgentRegistry(filename);
    const template = seed.beginSpawn("codex", "/benchmark-seed");
    const productionShape = seed.snapshot();
    for (let index = 1; index < 18_000; index += 1) {
      const launchId = `benchmark-seed-${String(index).padStart(5, "0")}`;
      productionShape.receipts[launchId] = { ...structuredClone(template), launchId };
    }
    const payload = JSON.stringify(productionShape);
    expect(Buffer.byteLength(payload)).toBeGreaterThanOrEqual(PRODUCTION_BYTES);
    fs.writeFileSync(filename, payload);
    new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const revisionBefore = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" })
      .storageDiagnostics().revision!;
    const start = path.join(directory, "start");
    const children = Array.from({ length: 10 }, (_, lane) => {
      const label = `sqlite-lane-${lane}`;
      const ready = path.join(directory, `${label}.ready`);
      const result = path.join(directory, `${label}.json`);
      const child = Bun.spawn([
        process.execPath,
        CHILD,
        "writer-mixed",
        filename,
        ready,
        start,
        label,
        "12",
        result,
      ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      return { child, ready, result };
    });
    const readerReady = path.join(directory, "reader.ready");
    const readerResult = path.join(directory, "reader.json");
    const reader = Bun.spawn([
      process.execPath, CHILD, "reader-sqlite", filename, readerReady, start, "reader", "40", readerResult,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    for (const { ready } of children) waitFor(ready);
    waitFor(readerReady);
    const jsonBefore = fs.statSync(filename);
    fs.writeFileSync(start, "start");
    expect(await Promise.all(children.map(({ child }) => child.exited))).toEqual(Array(10).fill(0));
    expect(await reader.exited).toBe(0);
    expect(await Promise.all(children.map(({ child }) => new Response(child.stderr).text()))).toEqual(Array(10).fill(""));
    expect(await new Response(reader.stderr).text()).toBe("");
    const measurements = children.map(({ result }) => JSON.parse(fs.readFileSync(result, "utf8")) as {
      durations: number[];
      writerWaits: number[];
    });
    const durations = measurements.flatMap((measurement) => measurement.durations);
    expect(durations).toHaveLength(120);
    const writerWaits = measurements.flatMap((measurement) => measurement.writerWaits);
    expect(writerWaits.length).toBeGreaterThanOrEqual(durations.length);
    const readerDurations = (JSON.parse(fs.readFileSync(readerResult, "utf8")) as { durations: number[] }).durations;
    const jsonAfter = fs.statSync(filename);
    expect(jsonAfter.mtimeMs).toBe(jsonBefore.mtimeMs);
    expect(jsonAfter.size).toBe(jsonBefore.size);
    expect(jsonAfter.ino).toBe(jsonBefore.ino);
    const finalRegistry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(finalRegistry.storageDiagnostics().revision! - revisionBefore).toBe(140);
    return {
      operationP95: percentile(durations, 0.95),
      writerWaitP95: percentile(writerWaits, 0.95),
      readerP95: percentile(readerDurations, 0.95),
    };
  }

  const sqlite = await measure();
  console.info(
    `[agent registry benchmark] production ten-lane p95: operation=${sqlite.operationP95.toFixed(1)}ms `
    + `writer wait=${sqlite.writerWaitP95.toFixed(1)}ms; reader=${sqlite.readerP95.toFixed(1)}ms`,
  );
  expect(sqlite.operationP95).toBeLessThan(250);
  expect(sqlite.writerWaitP95).toBeLessThan(100);
  expect(sqlite.readerP95).toBeLessThan(100);
}, 60_000);
