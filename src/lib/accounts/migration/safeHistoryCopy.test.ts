import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HistorySecurityError, safeCopyHistory } from "./safeHistoryCopy";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-history-copy-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  const sourcePath = path.join(sourceRoot, "rollout.jsonl");
  fs.writeFileSync(sourcePath, "one\ntwo\n", { mode: 0o600 });
  return { root, sourceRoot, targetRoot, sourcePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("safe history copy", () => {
  test("streams, hashes, publishes with private modes, and dedupes one operation", () => {
    const f = fixture();
    const first = safeCopyHistory({ ...f, destinationRelative: "2026/07/rollout.jsonl", operationId: "operation-1" });
    expect(first.reused).toBeFalse();
    expect(first.hash).toHaveLength(64);
    expect(fs.readFileSync(first.path, "utf8")).toBe("one\ntwo\n");
    expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
    const repeated = safeCopyHistory({ ...f, destinationRelative: "2026/07/rollout.jsonl", operationId: "operation-1" });
    expect(repeated).toMatchObject({ path: first.path, hash: first.hash, reused: true });
    fs.writeFileSync(f.sourcePath, "changed\n", { mode: 0o600 });
    expect(() => safeCopyHistory({ ...f, destinationRelative: "2026/07/rollout.jsonl", operationId: "operation-1" }))
      .toThrow(HistorySecurityError);
  });

  test("rejects traversal, symlinks, unsafe modes, oversize input, and collisions", () => {
    const f = fixture();
    expect(() => safeCopyHistory({ ...f, destinationRelative: "../escape.jsonl", operationId: "traversal" }))
      .toThrow(HistorySecurityError);

    const symlink = path.join(f.sourceRoot, "link.jsonl");
    fs.symlinkSync(f.sourcePath, symlink);
    expect(() => safeCopyHistory({ ...f, sourcePath: symlink, destinationRelative: "link.jsonl", operationId: "symlink" }))
      .toThrow(HistorySecurityError);

    const nested = path.join(f.sourceRoot, "nested");
    fs.mkdirSync(nested, { mode: 0o700 });
    fs.symlinkSync(nested, path.join(f.sourceRoot, "nested-link"));
    const nestedSource = path.join(nested, "source.jsonl");
    fs.writeFileSync(nestedSource, "nested\n", { mode: 0o600 });
    expect(() => safeCopyHistory({ ...f, sourcePath: path.join(f.sourceRoot, "nested-link", "source.jsonl"), destinationRelative: "nested.jsonl", operationId: "nested-link" }))
      .toThrow(HistorySecurityError);

    const hardlink = path.join(f.sourceRoot, "hardlink.jsonl");
    fs.linkSync(f.sourcePath, hardlink);
    expect(() => safeCopyHistory({ ...f, sourcePath: hardlink, destinationRelative: "hardlink.jsonl", operationId: "hardlink" }))
      .toThrow(HistorySecurityError);
    fs.unlinkSync(hardlink);

    fs.chmodSync(f.sourcePath, 0o644);
    expect(() => safeCopyHistory({ ...f, destinationRelative: "mode.jsonl", operationId: "mode" }))
      .toThrow(HistorySecurityError);
    fs.chmodSync(f.sourcePath, 0o600);

    expect(() => safeCopyHistory({ ...f, destinationRelative: "large.jsonl", operationId: "large", maxBytes: 2 }))
      .toThrow(HistorySecurityError);

    safeCopyHistory({ ...f, destinationRelative: "collision.jsonl", operationId: "first" });
    expect(() => safeCopyHistory({ ...f, destinationRelative: "collision.jsonl", operationId: "second" }))
      .toThrow(HistorySecurityError);

    fs.writeFileSync(path.join(f.targetRoot, "receipt-only.jsonl.llv-receipt.json"), "{}\n", { mode: 0o600 });
    expect(() => safeCopyHistory({ ...f, destinationRelative: "receipt-only.jsonl", operationId: "receipt-collision" }))
      .toThrow(HistorySecurityError);
  });

  test("rejects a symlinked target directory component", () => {
    const f = fixture();
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(f.targetRoot, "linked"));
    expect(() => safeCopyHistory({ ...f, destinationRelative: "linked/rollout.jsonl", operationId: "target-link" }))
      .toThrow(HistorySecurityError);
  });
});
