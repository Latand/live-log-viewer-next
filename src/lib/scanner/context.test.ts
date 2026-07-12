import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { contextUsage, ctxFor } from "./context";

const OBSERVED_AT = "2026-07-12T10:00:00.000Z";
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-context-test-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(records: unknown[], root: FileEntry["root"]): FileEntry {
  const pathname = path.join(SANDBOX, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(pathname, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stat = fs.statSync(pathname);
  return {
    path: pathname, root, name: path.basename(pathname), project: "proj", title: "session",
    engine: root === "codex-sessions" ? "codex" : "claude", kind: "session",
    fmt: root === "codex-sessions" ? "codex" : "claude", parent: null,
    mtime: stat.mtimeMs / 1000, size: stat.size, activity: "idle", proc: null,
    pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}

describe("contextUsage", () => {
  test("allows runtime metadata to report an exact 100 percent", () => {
    expect(contextUsage(353_000, { windowTokens: 353_000, source: "runtime", confidence: "exact" }, OBSERVED_AT)).toEqual({
      usedTokens: 353_000, windowTokens: 353_000, pct: 100, source: "runtime", confidence: "exact", observedAt: OBSERVED_AT,
    });
  });

  test("caps registry percentages at 99 and carries registry provenance", () => {
    expect(contextUsage(999_000, { windowTokens: 1_000_000, source: "registry", confidence: "approximate", registryVersion: "2026-07-10" }, OBSERVED_AT)).toEqual({
      usedTokens: 999_000, windowTokens: 1_000_000, pct: 99, source: "registry", confidence: "approximate",
      registryVersion: "2026-07-10", observedAt: OBSERVED_AT,
    });
  });

  test("demotes registry overflow to raw unknown usage", () => {
    expect(contextUsage(1_000_001, { windowTokens: 1_000_000, source: "registry", confidence: "approximate", registryVersion: "2026-07-10" }, OBSERVED_AT)).toEqual({
      usedTokens: 1_000_001, windowTokens: null, pct: null, source: "unknown", confidence: "unknown", observedAt: OBSERVED_AT,
    });
  });
});

describe("ctxFor", () => {
  test("uses Codex runtime metadata and suppresses usage missing its window", () => {
    const usage = { total_tokens: 176_000 };
    const withWindow = entry([{ timestamp: OBSERVED_AT, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, model_context_window: 353_000 } } }], "codex-sessions");
    const withoutWindow = entry([{ timestamp: OBSERVED_AT, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage } } }], "codex-sessions");
    expect(ctxFor(withWindow)).toMatchObject({ usedTokens: 176_000, windowTokens: 353_000, pct: 50, source: "runtime", confidence: "exact", observedAt: OBSERVED_AT });
    expect(ctxFor(withoutWindow)).toBeNull();
  });

  test("resolves the model on each Claude usage record and keeps the post-compaction usage", () => {
    const assistant = (model: string, input_tokens: number, timestamp: string) => ({ type: "assistant", timestamp, message: { model, usage: { input_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    const file = entry([
      assistant("claude-sonnet-4-5-20250929", 180_000, "2026-07-12T09:00:00.000Z"),
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 180_000 } },
      assistant("claude-opus-4-8", 12_000, OBSERVED_AT),
    ], "claude-projects");
    expect(ctxFor(file)).toMatchObject({ usedTokens: 12_000, windowTokens: 1_000_000, pct: 1, source: "registry", registryVersion: "2026-07-10", observedAt: OBSERVED_AT });
  });

  test("preserves raw tokens for an unknown Claude model", () => {
    const file = entry([{ type: "assistant", timestamp: OBSERVED_AT, message: { model: "claude-newthing-9", usage: { input_tokens: 42_000 } } }], "claude-projects");
    expect(ctxFor(file)).toEqual({ usedTokens: 42_000, windowTokens: null, pct: null, source: "unknown", confidence: "unknown", observedAt: OBSERVED_AT });
  });
});
