import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { expect, test } from "bun:test";

import { procBackend } from "@/lib/proc";

import {
  DELIVERED_REF_RETIREMENT_GRACE_MS,
  MAX_STRUCTURED_IMAGES,
  MAX_STRUCTURED_IMAGE_ENCODED_BYTES,
  collectRuntimeImageReachableDigests,
  RuntimeImageStore,
} from "./runtimeImageStore";

const WRITER_FIXTURE = path.join(import.meta.dir, "fixtures", "runtimeImageStoreWriter.ts");

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082",
  "hex",
);

function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-images-"));
}

function taggedPng(tag: string): Buffer {
  return Buffer.concat([PNG, Buffer.from(tag)]);
}

function currentProcessIdentity(): string | null {
  return procBackend.processIdentity(process.pid);
}

test("runtime images are validated and stored as private content-addressed blobs", () => {
  const root = sandbox();
  const store = new RuntimeImageStore(root);
  const input = { base64: PNG.toString("base64"), mime: "image/png" };

  const [first] = store.putMany([input]);
  const [second] = store.putMany([input]);
  const sha256 = crypto.createHash("sha256").update(PNG).digest("hex");

  expect(first).toEqual({ sha256, mime: "image/png", bytes: PNG.byteLength });
  expect(second).toEqual(first);
  expect(store.read(first!)).toEqual(PNG);
  expect(fs.statSync(store.pathFor(first!)).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(root)).toEqual([`${sha256}.png`]);
});

test("runtime image admission rejects malformed data, MIME mismatches, and excess images", () => {
  const store = new RuntimeImageStore(sandbox());
  expect(() => store.putMany([{ base64: "%%%", mime: "image/png" }])).toThrow("base64");
  expect(() => store.putMany([{ base64: PNG.toString("base64"), mime: "image/jpeg" }])).toThrow("signature");
  expect(() => store.putMany(Array.from({ length: MAX_STRUCTURED_IMAGES + 1 }, () => ({
    base64: PNG.toString("base64"),
    mime: "image/png",
  })))).toThrow("too many images");
  expect(() => store.putMany([{
    base64: "A".repeat(MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 4),
    mime: "image/png",
  }])).toThrow("encoding is too large");
});

test("runtime image reads reject missing and corrupt content-addressed refs", () => {
  const store = new RuntimeImageStore(sandbox());
  const [ref] = store.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  fs.writeFileSync(store.pathFor(ref), Buffer.from("corrupt"));
  expect(() => store.read(ref)).toThrow("digest mismatch");
  fs.rmSync(store.pathFor(ref));
  expect(() => store.read(ref)).toThrow("missing");
});

test("runtime image storage enforces a deterministic global byte quota", () => {
  const first = taggedPng("first");
  const second = taggedPng("second");
  const root = sandbox();
  const store = new RuntimeImageStore(root, { maxBytes: first.byteLength + second.byteLength - 1 });

  store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]);

  expect(() => store.putMany([{ base64: second.toString("base64"), mime: "image/png" }]))
    .toThrow("runtime image storage quota exceeded");
  expect(fs.readdirSync(root).filter((entry) => !entry.startsWith("."))).toHaveLength(1);
});

test("runtime image GC reclaims aged unreachable blobs and preserves reachable refs", () => {
  const first = taggedPng("gc-first");
  const second = taggedPng("gc-second");
  const root = sandbox();
  let reachable = new Set<string>();
  const store = new RuntimeImageStore(root, {
    maxBytes: Math.max(first.byteLength, second.byteLength),
    gcGraceMs: 0,
    reachableDigests: () => reachable,
  });
  const [firstRef] = store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]);
  if (!firstRef) throw new Error("first image ref missing");

  const [secondRef] = store.putMany([{ base64: second.toString("base64"), mime: "image/png" }]);
  if (!secondRef) throw new Error("second image ref missing");
  expect(fs.existsSync(store.pathFor(firstRef))).toBe(false);
  expect(store.read(secondRef)).toEqual(second);

  reachable = new Set([secondRef.sha256]);
  expect(() => store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]))
    .toThrow("runtime image storage quota exceeded");
  expect(store.read(secondRef)).toEqual(second);
});

test("runtime image reachability scans registry backends, Claude ledger, host events, and journal JSON", () => {
  const state = sandbox();
  const refs = ["a", "b", "c", "d", "e"].map((letter) => ({
    sha256: letter.repeat(64),
    mime: "image/png",
    bytes: PNG.byteLength,
  }));
  fs.writeFileSync(path.join(state, "agent-registry.json"), JSON.stringify({ heldDeliveries: { one: { runtimeImages: [refs[0]] } } }));
  fs.mkdirSync(path.join(state, "claude-delivery-ledger"));
  fs.writeFileSync(path.join(state, "claude-delivery-ledger", "session.jsonl"), `${JSON.stringify({ entry: { images: [refs[1]] } })}\n`);
  fs.mkdirSync(path.join(state, "structured-host-events"));
  fs.writeFileSync(path.join(state, "structured-host-events", "session.jsonl"), `${JSON.stringify({ effect: { images: [refs[2]] } })}\n`);
  const db = new Database(path.join(state, "runtime-events.sqlite"), { create: true });
  db.exec("CREATE TABLE operations (request_json TEXT, receipt_json TEXT)");
  db.query("INSERT INTO operations VALUES (?, ?)").run(JSON.stringify({ images: [refs[3]] }), "{}");
  db.close();
  const registryDb = new Database(path.join(state, "agent-registry.sqlite"), { create: true });
  registryDb.exec("CREATE TABLE registry_rows (value_json TEXT)");
  registryDb.query("INSERT INTO registry_rows VALUES (?)").run(JSON.stringify({ runtimeImages: [refs[4]] }));
  registryDb.close();

  expect([...collectRuntimeImageReachableDigests(state)].sort()).toEqual(refs.map((ref) => ref.sha256));
});

function reservationRow(sha: string, state: string, at: string | null): Record<string, unknown> {
  return {
    id: `delivery-${sha.slice(0, 8)}`,
    conversationId: "conversation_lifecycle",
    text: "",
    payloadKind: "runtime-images",
    runtimeImages: [{ sha256: sha, mime: "image/png", bytes: PNG.byteLength }],
    state,
    deliveredAt: state === "delivered" ? at : null,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

test("delivered reservations and ledger entries retire after the bounded grace while pending refs stay", () => {
  const state = sandbox();
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const grace = 60 * 60 * 1000;
  const retired = new Date(now - grace - 1_000).toISOString();
  const fresh = new Date(now - 1_000).toISOString();
  const sha = (letter: string) => letter.repeat(64);
  fs.writeFileSync(path.join(state, "agent-registry.json"), JSON.stringify({
    heldDeliveries: {
      retired: reservationRow(sha("1"), "delivered", retired),
      fresh: reservationRow(sha("2"), "delivered", fresh),
      held: reservationRow(sha("3"), "held", null),
      assigned: reservationRow(sha("4"), "assigned", null),
      uncertain: reservationRow(sha("5"), "delivery-uncertain", null),
    },
  }));
  fs.mkdirSync(path.join(state, "claude-delivery-ledger"));
  const ledgerImage = (letter: string) => ({ sha256: sha(letter), mime: "image/png", bytes: PNG.byteLength });
  fs.writeFileSync(path.join(state, "claude-delivery-ledger", "session.jsonl"), [
    JSON.stringify({ kind: "queued", entry: { id: "e-retired", images: [ledgerImage("6")] }, disposition: "turn-started", queuedAt: retired }),
    JSON.stringify({ kind: "delivered", entryId: "e-retired", engineMessageId: null, deliveredAt: retired }),
    JSON.stringify({ kind: "queued", entry: { id: "e-fresh", images: [ledgerImage("7")] }, disposition: "turn-started", queuedAt: fresh }),
    JSON.stringify({ kind: "delivered", entryId: "e-fresh", engineMessageId: null, deliveredAt: fresh }),
    JSON.stringify({ kind: "queued", entry: { id: "e-pending", images: [ledgerImage("8")] }, disposition: "queued-next-turn", queuedAt: retired }),
    "",
  ].join("\n"));

  const reachable = collectRuntimeImageReachableDigests(state, { now, retiredGraceMs: grace });

  expect([...reachable].sort()).toEqual(["2", "3", "4", "5", "7", "8"].map(sha));
  /* The default bound is finite: even without options the collector retires. */
  expect(DELIVERED_REF_RETIREMENT_GRACE_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
});

test("reachability tolerates a torn ledger tail and rejects interior corruption", () => {
  const state = sandbox();
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const sha = (letter: string) => letter.repeat(64);
  const queued = (id: string, letter: string) => JSON.stringify({
    kind: "queued",
    entry: { id, images: [{ sha256: sha(letter), mime: "image/png", bytes: PNG.byteLength }] },
    disposition: "turn-started",
    queuedAt: "2026-07-17T11:00:00.000Z",
  });
  fs.mkdirSync(path.join(state, "claude-delivery-ledger"));
  /* An interrupted final append: complete records stay reachable, quota GC
     stays enabled, and a later ledger repair/replay can finish the record. */
  fs.writeFileSync(
    path.join(state, "claude-delivery-ledger", "torn.jsonl"),
    `${queued("e-one", "a")}\n${queued("e-two", "b").slice(0, 25)}`,
  );
  fs.mkdirSync(path.join(state, "structured-host-events"));
  fs.writeFileSync(
    path.join(state, "structured-host-events", "torn.jsonl"),
    `${JSON.stringify({ effect: { images: [{ sha256: sha("c"), mime: "image/png", bytes: PNG.byteLength }] } })}\n{"effect": {"images`,
  );

  expect([...collectRuntimeImageReachableDigests(state, { now })].sort()).toEqual([sha("a"), sha("c")]);

  /* Interior corruption is real damage, not an interrupted append: fail
     closed so GC cannot run against a partial reachability picture. */
  fs.writeFileSync(
    path.join(state, "claude-delivery-ledger", "torn.jsonl"),
    `${queued("e-one", "a").slice(0, 25)}\n${queued("e-two", "b")}\n`,
  );
  expect(() => collectRuntimeImageReachableDigests(state, { now })).toThrow("malformed JSON");
});

test("sequential completed deliveries outlive one store cap while pending refs stay readable", () => {
  const state = sandbox();
  const root = path.join(state, "runtime-images");
  const grace = 60 * 60 * 1000;
  let clock = Date.now();
  const registry: Record<string, Record<string, unknown>> = {};
  const writeRegistry = () => fs.writeFileSync(path.join(state, "agent-registry.json"), JSON.stringify({ heldDeliveries: registry }));
  const pending = taggedPng("crash-pend");
  const deliveries = ["delivery-1", "delivery-2", "delivery-3"].map(taggedPng);
  const store = new RuntimeImageStore(root, {
    maxBytes: pending.byteLength + deliveries[0]!.byteLength,
    gcGraceMs: 0,
    now: () => clock,
    reachableDigests: () => collectRuntimeImageReachableDigests(state, { now: clock, retiredGraceMs: grace }),
  });

  const [pendingRef] = store.putMany([{ base64: pending.toString("base64"), mime: "image/png" }]);
  if (!pendingRef) throw new Error("pending ref missing");
  registry["crash-pending"] = { ...reservationRow(pendingRef.sha256, "held", null), runtimeImages: [pendingRef] };
  writeRegistry();

  /* Three completed deliveries push 3 payloads through a store that can only
     hold one beside the pending blob — more total delivered bytes than one
     store-cap lifetime. Each becomes admissible because its retired
     predecessor stopped pinning quota. */
  for (const [index, image] of deliveries.entries()) {
    const [ref] = store.putMany([{ base64: image.toString("base64"), mime: "image/png" }]);
    if (!ref) throw new Error(`delivery ref ${index} missing`);
    registry[`delivered-${index}`] = {
      ...reservationRow(ref.sha256, "delivered", new Date(clock).toISOString()),
      runtimeImages: [ref],
    };
    writeRegistry();
    clock += grace + 60_000;
  }

  /* The crash-pending blob never retired and stays readable. */
  expect(store.read(pendingRef)).toEqual(pending);
  const blobs = fs.readdirSync(root).filter((entry) => !entry.startsWith("."));
  expect(blobs).toHaveLength(2);
  expect(blobs).toContain(path.basename(store.pathFor(pendingRef)));
});

test("concurrent runtime image writers cannot exceed the global byte quota", async () => {
  const root = sandbox();
  const controls = sandbox();
  const start = path.join(controls, "start");
  const maxBytes = 4 * 1024 * 1024 + 128;
  const children = ["a", "b", "c", "d"].map((tag) => Bun.spawn([
    process.execPath,
    WRITER_FIXTURE,
    root,
    String(maxBytes),
    tag,
    path.join(controls, `ready-${tag}`),
    start,
  ], { stdout: "pipe", stderr: "pipe" }));
  while (fs.readdirSync(controls).filter((entry) => entry.startsWith("ready-")).length < children.length) {
    await Bun.sleep(2);
  }
  fs.writeFileSync(start, "go");

  const exits = await Promise.all(children.map((child) => child.exited));
  const storedBytes = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .reduce((sum, entry) => sum + fs.statSync(path.join(root, entry.name)).size, 0);

  expect(exits.filter((code) => code === 0)).toHaveLength(1);
  expect(exits.filter((code) => code === 2)).toHaveLength(children.length - 1);
  expect(storedBytes).toBeLessThanOrEqual(maxBytes);
}, 20_000);

test("an aged writer lock stays owned while its exact process identity is alive", () => {
  const root = sandbox();
  const lock = path.join(root, ".writer-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    startIdentity: currentProcessIdentity(),
    token: crypto.randomUUID(),
  }), { mode: 0o600 });
  fs.utimesSync(lock, new Date(1), new Date(1));

  expect(() => new RuntimeImageStore(root, { writerLockStaleMs: 0, writerLockWaitMs: 10 }))
    .toThrow("runtime image writer lock timed out");
  expect(fs.existsSync(lock)).toBe(true);
});

test("an aged writer lock with a backend that cannot fingerprint still respects pid liveness", () => {
  // A null startIdentity is what the portable (Darwin without FFI) backend
  // records; fencing then degrades to pid liveness and a live pid keeps the lock.
  const root = sandbox();
  const lock = path.join(root, ".writer-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    startIdentity: null,
    token: crypto.randomUUID(),
  }), { mode: 0o600 });
  fs.utimesSync(lock, new Date(1), new Date(1));

  expect(() => new RuntimeImageStore(root, { writerLockStaleMs: 0, writerLockWaitMs: 10 }))
    .toThrow("runtime image writer lock timed out");
  expect(fs.existsSync(lock)).toBe(true);
});

test("an aged writer lock is recovered after its owning process exits", () => {
  const root = sandbox();
  const lock = path.join(root, ".writer-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    startIdentity: "1",
    token: crypto.randomUUID(),
  }), { mode: 0o600 });
  fs.utimesSync(lock, new Date(1), new Date(1));

  new RuntimeImageStore(root, { writerLockStaleMs: 0, writerLockWaitMs: 10 });

  expect(fs.existsSync(lock)).toBe(false);
});

test("an aged writer lock is recovered when its pid was reused by another process", () => {
  // PID-reuse fence: the pid is alive (it is this test process) but its start
  // identity does not match the recorded owner, so the lock must break.
  const identity = currentProcessIdentity();
  if (identity === null) return;
  const root = sandbox();
  const lock = path.join(root, ".writer-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    startIdentity: `${identity}-reused`,
    token: crypto.randomUUID(),
  }), { mode: 0o600 });
  fs.utimesSync(lock, new Date(1), new Date(1));

  new RuntimeImageStore(root, { writerLockStaleMs: 0, writerLockWaitMs: 10 });

  expect(fs.existsSync(lock)).toBe(false);
});

test("the writer lock records the portable backend identity of its owner", () => {
  const root = sandbox();
  let owner: unknown = null;
  const store = new RuntimeImageStore(root, {
    fault(stage) {
      if (stage !== "write") return;
      owner = JSON.parse(fs.readFileSync(path.join(root, ".writer-lock", "owner.json"), "utf8"));
    },
  });

  store.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);

  expect(owner).toMatchObject({
    pid: process.pid,
    startIdentity: currentProcessIdentity(),
    token: expect.any(String),
  });
});

test("runtime image writes remove partial and published files after every injected failure", () => {
  for (const failedStage of ["write", "fsync", "link", "directory-fsync"] as const) {
    const root = sandbox();
    const store = new RuntimeImageStore(root, {
      fault(stage) {
        if (stage === failedStage) throw new Error(`injected ${stage} failure`);
      },
    });

    expect(() => store.putMany([{ base64: taggedPng(failedStage).toString("base64"), mime: "image/png" }]))
      .toThrow(`injected ${failedStage} failure`);
    expect(fs.readdirSync(root)).toEqual([]);
  }
});

test("runtime image store startup removes aged abandoned partials and keeps fresh writes", () => {
  const root = sandbox();
  const oldPartial = path.join(root, ".old.partial");
  const freshPartial = path.join(root, ".fresh.partial");
  fs.writeFileSync(oldPartial, "old");
  fs.writeFileSync(freshPartial, "fresh");
  fs.utimesSync(oldPartial, new Date(1_000), new Date(1_000));
  fs.utimesSync(freshPartial, new Date(9_500), new Date(9_500));

  new RuntimeImageStore(root, {
    now: () => 10_000,
    abandonedPartialMaxAgeMs: 1_000,
  });

  expect(fs.existsSync(oldPartial)).toBe(false);
  expect(fs.existsSync(freshPartial)).toBe(true);
});

test("runtime image storage requires a real private root owned by the current user", () => {
  const parent = sandbox();
  const createdRoot = path.join(parent, "created");
  new RuntimeImageStore(createdRoot);
  const created = fs.statSync(createdRoot);
  expect(created.isDirectory()).toBe(true);
  expect(created.mode & 0o777).toBe(0o700);
  const owner = process.geteuid?.();
  if (owner === undefined) throw new Error("effective uid is unavailable");
  expect(created.uid).toBe(owner);

  const unsafeMode = path.join(parent, "unsafe-mode");
  fs.mkdirSync(unsafeMode, { mode: 0o755 });
  fs.chmodSync(unsafeMode, 0o755);
  expect(() => new RuntimeImageStore(unsafeMode)).toThrow("runtime image root is unsafe");

  const target = path.join(parent, "symlink-target");
  const symlink = path.join(parent, "symlink-root");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, symlink);
  expect(() => new RuntimeImageStore(symlink)).toThrow("runtime image root is unsafe");
});

test("runtime image reads reject a symlink substituted for a blob", () => {
  const root = sandbox();
  const store = new RuntimeImageStore(root);
  const [ref] = store.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  const filename = store.pathFor(ref);
  const target = path.join(sandbox(), "attacker.png");
  fs.writeFileSync(target, PNG);
  fs.rmSync(filename);
  fs.symlinkSync(target, filename);

  expect(() => store.read(ref)).toThrow("runtime image ref is unsafe");
});

test("the Darwin path stores, reads, dedupes, and GCs without /proc/self/fd", () => {
  // procSelfFdPaths: false is the exact code path a Darwin (Bun) host takes.
  const first = taggedPng("darwin-first");
  const second = taggedPng("darwin-second");
  const root = sandbox();
  let reachable = new Set<string>();
  const store = new RuntimeImageStore(root, {
    procSelfFdPaths: false,
    maxBytes: Math.max(first.byteLength, second.byteLength),
    gcGraceMs: 0,
    reachableDigests: () => reachable,
  });

  const [firstRef] = store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]);
  const [firstAgain] = store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]);
  if (!firstRef) throw new Error("first image ref missing");
  expect(firstAgain).toEqual(firstRef);
  expect(store.read(firstRef)).toEqual(first);
  expect(fs.statSync(store.pathFor(firstRef)).mode & 0o777).toBe(0o600);

  const [secondRef] = store.putMany([{ base64: second.toString("base64"), mime: "image/png" }]);
  if (!secondRef) throw new Error("second image ref missing");
  expect(fs.existsSync(store.pathFor(firstRef))).toBe(false);
  reachable = new Set([secondRef.sha256]);
  expect(() => store.putMany([{ base64: first.toString("base64"), mime: "image/png" }]))
    .toThrow("runtime image storage quota exceeded");
  expect(store.read(secondRef)).toEqual(second);
});

test("the Darwin path removes partial and published files after injected failures", () => {
  for (const failedStage of ["write", "fsync", "link", "directory-fsync"] as const) {
    const root = sandbox();
    const store = new RuntimeImageStore(root, {
      procSelfFdPaths: false,
      fault(stage) {
        if (stage === failedStage) throw new Error(`injected ${stage} failure`);
      },
    });

    expect(() => store.putMany([{ base64: taggedPng(failedStage).toString("base64"), mime: "image/png" }]))
      .toThrow(`injected ${failedStage} failure`);
    expect(fs.readdirSync(root)).toEqual([]);
  }
});

test("the Darwin path rejects a symlink substituted for a blob", () => {
  const root = sandbox();
  const store = new RuntimeImageStore(root, { procSelfFdPaths: false });
  const [ref] = store.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  const filename = store.pathFor(ref);
  const target = path.join(sandbox(), "attacker.png");
  fs.writeFileSync(target, PNG);
  fs.rmSync(filename);
  fs.symlinkSync(target, filename);

  expect(() => store.read(ref)).toThrow("runtime image ref is unsafe");
});

test("the Darwin path rejects a root path replacement race via device/inode validation", () => {
  const parent = sandbox();
  const root = path.join(parent, "runtime-images");
  const movedRoot = path.join(parent, "runtime-images-original");
  const attackerRoot = path.join(parent, "attacker");
  const writer = new RuntimeImageStore(root, { procSelfFdPaths: false });
  const [ref] = writer.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  fs.mkdirSync(attackerRoot, { mode: 0o700 });
  let replaced = false;
  const reader = new RuntimeImageStore(root, {
    procSelfFdPaths: false,
    afterRootOpen(operation) {
      if (operation !== "read" || replaced) return;
      replaced = true;
      fs.renameSync(root, movedRoot);
      fs.symlinkSync(attackerRoot, root);
    },
  });

  expect(() => reader.read(ref)).toThrow("runtime image root changed during operation");
});

test("runtime image reads reject a root path replacement race", () => {
  const parent = sandbox();
  const root = path.join(parent, "runtime-images");
  const movedRoot = path.join(parent, "runtime-images-original");
  const attackerRoot = path.join(parent, "attacker");
  const writer = new RuntimeImageStore(root);
  const [ref] = writer.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  fs.mkdirSync(attackerRoot, { mode: 0o700 });
  let replaced = false;
  const reader = new RuntimeImageStore(root, {
    afterRootOpen(operation) {
      if (operation !== "read" || replaced) return;
      replaced = true;
      fs.renameSync(root, movedRoot);
      fs.symlinkSync(attackerRoot, root);
    },
  });

  expect(() => reader.read(ref)).toThrow("runtime image root changed during operation");
});
