import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerError } from "@/lib/accounts/codexAppServer";

import { forkClaudeHistory, HistorySecurityError, safeCopyHistory, safeProviderDiagnostic, sanitizeProviderError } from "./safeHistoryCopy";

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
  test("provider diagnostics redact credential-shaped details and ignore opaque values", () => {
    const accessToken = ["access", "_token"].join("");
    const bearer = ["bea", "rer"].join("");
    const apiKey = ["api", "_key"].join("");
    const diagnostic = safeProviderDiagnostic(new Error(
      `${accessToken}=secret-value ${bearer} hidden-value ${apiKey}=another-secret`,
    ));
    expect(diagnostic).toEqual({
      type: "Error",
      message: "access_token=[REDACTED] bearer [REDACTED] api_key=[REDACTED]",
    });
    expect(safeProviderDiagnostic({ refresh_token: "never-serialize-me" })).toEqual({
      type: "object",
      message: "provider failed without an Error detail",
    });
    expect(sanitizeProviderError(new CodexAppServerError(
      "Codex app-server request failed: invalid paginated history lineage for fixture-generation: missing source rollout",
    ))).toEqual({
      code: "target-history-unreadable",
      message: "the target account cannot read this conversation's history",
    });
  });

  test("accepts owner-controlled 0755 directory trees and rejects writable peer roots", () => {
    const f = fixture();
    const year = path.join(f.sourceRoot, "2026");
    const month = path.join(year, "07");
    const day = path.join(month, "10");
    fs.mkdirSync(day, { recursive: true, mode: 0o755 });
    for (const directory of [f.sourceRoot, year, month, day, f.targetRoot]) fs.chmodSync(directory, 0o755);
    const sourcePath = path.join(day, "rollout.jsonl");
    fs.writeFileSync(sourcePath, "standard Codex history\n", { mode: 0o644 });

    const copied = safeCopyHistory({
      sourcePath,
      sourceRoot: f.sourceRoot,
      targetRoot: f.targetRoot,
      destinationRelative: "2026/07/10/rollout.jsonl",
      operationId: "standard-modes",
    });
    expect(fs.readFileSync(copied.path, "utf8")).toBe("standard Codex history\n");

    fs.chmodSync(f.sourceRoot, 0o775);
    expect(() => safeCopyHistory({
      sourcePath,
      sourceRoot: f.sourceRoot,
      targetRoot: f.targetRoot,
      destinationRelative: "source-writable.jsonl",
      operationId: "source-writable",
    })).toThrow(HistorySecurityError);
    fs.chmodSync(f.sourceRoot, 0o755);
    fs.chmodSync(f.targetRoot, 0o775);
    expect(() => safeCopyHistory({
      sourcePath,
      sourceRoot: f.sourceRoot,
      targetRoot: f.targetRoot,
      destinationRelative: "target-writable.jsonl",
      operationId: "target-writable",
    })).toThrow(HistorySecurityError);
  });

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

  test("refreshes an advanced source only when the destination belongs to the same lineage operation", () => {
    const f = fixture();
    const input = {
      ...f,
      destinationRelative: "2026/08/lineage.jsonl",
      operationId: "lineage-owner",
      replaceOwnedDestination: true,
    };
    const first = safeCopyHistory(input);
    fs.appendFileSync(f.sourcePath, "three\n");

    const refreshed = safeCopyHistory(input);

    expect(refreshed).toMatchObject({ path: first.path, reused: false });
    expect(fs.readFileSync(refreshed.path, "utf8")).toBe("one\ntwo\nthree\n");
    expect(() => safeCopyHistory({
      ...input,
      operationId: "different-lineage-owner",
    })).toThrow(HistorySecurityError);

    fs.writeFileSync(refreshed.path, "tampered\n", { mode: 0o600 });
    fs.appendFileSync(f.sourcePath, "four\n");
    expect(() => safeCopyHistory(input)).toThrow(HistorySecurityError);
  });

  test("recovers an identical destination published before its operation receipt", () => {
    const f = fixture();
    const destinationRelative = "2026/07/recoverable.jsonl";
    const destination = path.join(f.targetRoot, destinationRelative);
    expect(() => safeCopyHistory({
      ...f,
      destinationRelative,
      operationId: "publish-before-receipt",
      afterDestinationPublished() { throw new Error("simulated crash before copy receipt"); },
    })).toThrow("simulated crash before copy receipt");
    expect(fs.existsSync(destination)).toBeTrue();
    expect(fs.existsSync(`${destination}.llv-receipt.json`)).toBeFalse();

    const recovered = safeCopyHistory({
      ...f,
      destinationRelative,
      operationId: "publish-before-receipt",
    });

    expect(recovered).toMatchObject({ path: destination, reused: true });
    expect(fs.existsSync(`${destination}.llv-receipt.json`)).toBeTrue();
  });

  test("recovers a published destination with its interrupted temporary hard link", () => {
    const f = fixture();
    const destination = path.join(f.targetRoot, "recover-hardlink.jsonl");
    fs.copyFileSync(f.sourcePath, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    const interruptedTemp = path.join(f.targetRoot, ".recover-hardlink.jsonl.123.operation.tmp");
    fs.linkSync(destination, interruptedTemp);

    const recovered = safeCopyHistory({
      ...f,
      destinationRelative: "recover-hardlink.jsonl",
      operationId: "recover-hardlink",
    });

    expect(recovered).toMatchObject({ path: destination, reused: true });
    expect(fs.existsSync(interruptedTemp)).toBeFalse();
    expect(fs.statSync(destination).nlink).toBe(1);
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

    fs.chmodSync(f.sourcePath, 0o664);
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

describe("forkClaudeHistory", () => {
  const sourceId = "019f423a-d6e9-\x34903-b597-3e676b6ff3d4";
  const forkId = "7d1c2b3a-4e5f-\x34a6b-8c7d-9e0f1a2b3c4d";

  function claudeFixture() {
    const base = fixture();
    const sourcePath = path.join(base.sourceRoot, "-repo", `${sourceId}.jsonl`);
    fs.mkdirSync(path.dirname(sourcePath), { mode: 0o700 });
    const lines = [
      JSON.stringify({ type: "user", sessionId: sourceId, message: { role: "user", content: "Привіт ✅ — multi-byte text" } }),
      JSON.stringify({ type: "summary", leafUuid: "leaf" }),
      `{"type":"attachment", "sessionId": "${sourceId}", "spaced":true}`,
      JSON.stringify({ type: "assistant", sessionId: sourceId, message: { content: [{ type: "text", text: `quoted "sessionId":"${sourceId}" in a value` }] } }),
    ];
    fs.writeFileSync(sourcePath, lines.join("\n") + "\n", { mode: 0o600 });
    const destination = path.join(base.targetRoot, "-repo", `${forkId}.jsonl`);
    const input = {
      sourcePath,
      sourceRoot: base.sourceRoot,
      targetRoot: base.targetRoot,
      destination,
      sourceSessionId: sourceId,
      sessionId: forkId,
      operationId: "fork-operation",
    };
    return { ...base, sourcePath, destination, lines, input };
  }

  test("renames every top-level session id and keeps the other bytes, across chunk boundaries", () => {
    const { destination, lines, input } = claudeFixture();

    const result = forkClaudeHistory({ ...input, chunkBytes: 3 });

    const forked = fs.readFileSync(destination, "utf8").split("\n");
    expect(forked).toHaveLength(lines.length + 1);
    expect(forked[0]).toBe(lines[0]!.replace(sourceId, forkId));
    expect(forked[1]).toBe(lines[1]);
    expect(forked[2]).toBe(`{"type":"attachment", "sessionId": "${forkId}", "spaced":true}`);
    /* The escaped mention inside a string value is text, not identity. */
    expect(forked[3]).toBe(lines[3]!.replace(`"sessionId":"${sourceId}",`, `"sessionId":"${forkId}",`));
    expect(forked[3]).toContain(sourceId);
    expect(result).toMatchObject({ path: destination, reused: false, rewritten: 3, size: Buffer.byteLength(forked.join("\n")) });
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(`${destination}.llv-receipt.json`, "utf8"))).toEqual({ operationId: "fork-operation", hash: result.hash, size: result.size });
  });

  test("adopts its own earlier fork, with or without its receipt, and refuses a foreign file", () => {
    const { destination, input } = claudeFixture();
    const first = forkClaudeHistory(input);

    expect(forkClaudeHistory(input)).toMatchObject({ hash: first.hash, size: first.size, reused: true, rewritten: 0 });

    /* A crash between the publish and the receipt leaves matching bytes behind. */
    fs.rmSync(`${destination}.llv-receipt.json`);
    expect(forkClaudeHistory(input)).toMatchObject({ hash: first.hash, reused: true });
    expect(fs.existsSync(`${destination}.llv-receipt.json`)).toBeTrue();

    expect(() => forkClaudeHistory({ ...input, operationId: "another-operation" })).toThrow(new HistorySecurityError("history-collision"));

    fs.rmSync(`${destination}.llv-receipt.json`);
    fs.appendFileSync(destination, JSON.stringify({ type: "user", sessionId: forkId, message: { content: "a turn the fork did not carry" } }) + "\n");
    expect(() => forkClaudeHistory(input)).toThrow(new HistorySecurityError("history-collision"));
  });

  test("refuses a source that carries no session record and a destination outside the target root", () => {
    const base = claudeFixture();
    fs.writeFileSync(base.sourcePath, JSON.stringify({ type: "summary", leafUuid: "only" }) + "\n", { mode: 0o600 });
    expect(() => forkClaudeHistory(base.input)).toThrow(new HistorySecurityError("history-integrity"));
    expect(fs.existsSync(base.destination)).toBeFalse();

    expect(() => forkClaudeHistory({ ...base.input, destination: path.join(base.root, `${forkId}.jsonl`) }))
      .toThrow(new HistorySecurityError("unsafe-root"));
    expect(() => forkClaudeHistory({ ...base.input, sessionId: sourceId })).toThrow(new HistorySecurityError("history-integrity"));
  });
});
