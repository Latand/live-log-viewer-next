import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { expect, test } from "bun:test";

import {
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
