import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { compactText, hardenedRedact } from "./compactText";
import { freshness, listPresence, presenceLimits, resetPresenceForTest, upsertPresence } from "./presenceStore";
import { composeSnapshot, SnapshotError } from "./snapshot";
import type { PresencePayloadV1, SnapshotRequestV1 } from "./types";
import { validatePresence, validateSnapshotRequest, ViewValidationError } from "./validation";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-view-"));
afterEach(() => resetPresenceForTest());

function presence(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return { schemaVersion: 1, viewSessionId: "view-a", deviceId: "desktop", device: { kind: "desktop", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 1, project: "viewer", mode: "scheme", viewport: { width: 100, height: 100, dpr: 1 }, camera: null, focusedPath: "/a.jsonl", selectedPaths: ["/b.jsonl"], visiblePaths: ["/a.jsonl", "/b.jsonl", "/c.jsonl"], board: { renderedRevision: 1, durableRevision: 1, sync: "current" }, ...overrides };
}
function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: pathname, root: "claude-projects", name: path.basename(pathname), project: "viewer", title: pathname, engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...overrides };
}
async function snapshot(request: Partial<SnapshotRequestV1> = {}) {
  upsertPresence(presence(), 1000);
  return composeSnapshot({ request: { schemaVersion: 1, ...request }, files: [file("/a.jsonl"), file("/b.jsonl"), file("/c.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 1, now: 2000 });
}

describe("view presence", () => {
  test("ignores old sequences and derives freshness from server receipt time", () => {
    upsertPresence(presence({ sequence: 2, inputSequence: 2 }), 1000);
    const ignored = upsertPresence(presence({ sequence: 1, inputSequence: 3, project: "wrong" }), 2000);
    expect(ignored.accepted).toBe(false);
    expect(ignored.session.project).toBe("viewer");
  });
  test("evicts old retained presence and caps sessions", () => {
    for (let index = 0; index < presenceLimits.CAPACITY; index += 1) upsertPresence(presence({ viewSessionId: `v-${index}`, sequence: 1 }), index);
    expect(listPresence(100).length).toBe(presenceLimits.CAPACITY);
    upsertPresence(presence({ viewSessionId: "v-new", sequence: 1 }), 101);
    expect(listPresence(101).length).toBe(presenceLimits.CAPACITY);
    expect(listPresence(101).some((session) => session.viewSessionId === "v-new")).toBe(true);
  });
  test("preserves the maximum input sequence across accepted transport updates", () => {
    upsertPresence(presence({ sequence: 1, inputSequence: 10 }), 1000);
    upsertPresence(presence({ sequence: 2, inputSequence: 5 }), 2000);
    const result = upsertPresence(presence({ sequence: 3, inputSequence: 6 }), 3000);
    expect(result.session.inputSequence).toBe(10);
    expect(result.session.lastInteractionAt).toBe(1000);
  });
  test("keeps a hidden session eligible across one-minute heartbeats until retention expires", async () => {
    const files = [file("/a.jsonl"), file("/b.jsonl"), file("/c.jsonl")];
    for (const [sequence, seenAt] of [1000, 61_000, 121_000].entries()) {
      upsertPresence(presence({ visibility: "hidden", sequence: sequence + 1 }), seenAt);
      const result = await composeSnapshot({ request: { schemaVersion: 1, text: { include: false } }, files, siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: seenAt + 59_999 });
      expect(result.view.freshness).toBe("background");
    }
    await expect(composeSnapshot({ request: { schemaVersion: 1 }, files, siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 241_001 })).rejects.toMatchObject({ code: "NO_ACTIVE_VIEW", status: 404 } satisfies Partial<SnapshotError>);
  });
  test("keeps visible active freshness at the existing 25-second boundary", async () => {
    upsertPresence(presence(), 1000);
    const session = listPresence(1000)[0]!;
    expect(freshness(session, 25_999)).toBe("active");
    expect(freshness(session, 26_000)).toBe("stale");
    await expect(composeSnapshot({ request: { schemaVersion: 1 }, files: [file("/a.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 26_000 })).rejects.toMatchObject({ code: "NO_ACTIVE_VIEW", status: 404 } satisfies Partial<SnapshotError>);
  });
  test("has no active view after an in-memory restart", async () => {
    upsertPresence(presence(), 1000);
    resetPresenceForTest();
    await expect(composeSnapshot({ request: { schemaVersion: 1 }, files: [], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 })).rejects.toMatchObject({ code: "NO_ACTIVE_VIEW", status: 404 } satisfies Partial<SnapshotError>);
  });
});

describe("snapshot scope", () => {
  test("keeps full membership independent from focused text scope", async () => {
    const result = await snapshot({ scope: { kind: "focused" }, text: { include: false } });
    expect(result.view.visiblePaths).toEqual(["/a.jsonl", "/b.jsonl", "/c.jsonl"]);
    expect(result.view.selectedPaths).toEqual(["/b.jsonl"]);
    expect(result.conversations.map((item) => item.path)).toEqual(["/a.jsonl"]);
  });
  test("rejects an explicit path outside published membership even when the scanner finds it", async () => {
    upsertPresence(presence(), 1000);
    await expect(composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "paths", paths: ["/escape.jsonl"] } }, files: [file("/a.jsonl"), file("/b.jsonl"), file("/c.jsonl"), file("/escape.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 })).rejects.toMatchObject({ code: "PATH_OUTSIDE_CURRENT_VIEW", status: 422 } satisfies Partial<SnapshotError>);
  });
  test("filters an unknown visible path while preserving published view metadata", async () => {
    upsertPresence(presence({ focusedPath: null, selectedPaths: [], visiblePaths: ["/a.jsonl", "/missing.jsonl", "/b.jsonl"] }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }, files: [file("/a.jsonl"), file("/b.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    expect(result.view.visiblePaths).toEqual(["/a.jsonl", "/missing.jsonl", "/b.jsonl"]);
    expect(result.scope).toEqual({ kind: "visible", totalPaths: 3, returnedPaths: ["/a.jsonl", "/b.jsonl"], truncated: true, omittedCount: 1 });
    expect(result.conversations.map((item) => item.path)).toEqual(["/a.jsonl", "/b.jsonl"]);
  });
  test("filters rendered shell-task paths from the transcript scope", async () => {
    upsertPresence(presence({ focusedPath: null, selectedPaths: [], visiblePaths: ["/a.jsonl", "/task.output"] }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }, files: [file("/a.jsonl"), file("/task.output", { engine: "shell" })], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    expect(result.scope).toEqual({ kind: "visible", totalPaths: 2, returnedPaths: ["/a.jsonl"], truncated: true, omittedCount: 1 });
    expect(result.conversations.map((item) => item.path)).toEqual(["/a.jsonl"]);
  });
  test("filters missing focused and selected paths independently", async () => {
    upsertPresence(presence({ focusedPath: "/focused-missing.jsonl", selectedPaths: ["/b.jsonl", "/selected-missing.jsonl"], visiblePaths: ["/b.jsonl"] }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, text: { include: false } }, files: [file("/b.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    expect(result.scope).toEqual({ kind: "focused-selected", totalPaths: 3, returnedPaths: ["/b.jsonl"], truncated: true, omittedCount: 2 });
    expect(result.conversations.map((item) => item.path)).toEqual(["/b.jsonl"]);
  });
  test("accepts an explicit published path that has become unavailable", async () => {
    upsertPresence(presence({ focusedPath: null, selectedPaths: [], visiblePaths: ["/missing.jsonl"] }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "paths", paths: ["/missing.jsonl"] }, text: { include: false } }, files: [], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    expect(result.scope).toEqual({ kind: "paths", totalPaths: 1, returnedPaths: [], truncated: true, omittedCount: 1 });
    expect(result.conversations).toEqual([]);
  });
  test("reports pre-cap totals and omissions", async () => {
    const selected = Array.from({ length: 20 }, (_, index) => `/selected-${index}.jsonl`);
    upsertPresence(presence({ focusedPath: null, selectedPaths: selected, visiblePaths: selected }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "selected" }, text: { include: false } }, files: selected.map((pathname) => file(pathname)), siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    expect(result.scope).toMatchObject({ totalPaths: 20, truncated: true, omittedCount: 4 });
    expect(result.scope.returnedPaths).toHaveLength(16);
  });
  test("requires an explicit target for close multi-device interactions", async () => {
    upsertPresence(presence(), 1000);
    upsertPresence(presence({ viewSessionId: "view-b", deviceId: "phone", device: { kind: "mobile", browser: "safari" } }), 1001);
    try {
      await composeSnapshot({ request: { schemaVersion: 1, view: { resolution: "require-explicit" } }, files: [], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
      throw new Error("expected ambiguity");
    } catch (error) {
      expect(error).toMatchObject({ code: "AMBIGUOUS_ACTIVE_VIEW", status: 409 } satisfies Partial<SnapshotError>);
      expect((error as SnapshotError).sessions?.map((session) => session.viewSessionId)).toEqual(["view-b", "view-a"]);
    }
  });
  test("reads an explicitly selected stale retained session", async () => {
    upsertPresence(presence(), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, view: { id: "view-a" }, text: { include: false } }, files: [file("/a.jsonl"), file("/b.jsonl"), file("/c.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 30_000 });
    expect(result.view.freshness).toBe("stale");
    expect(result.resolution.by).toBe("explicit");
  });
  test("includes stale retained alternatives and only flags close interactions", async () => {
    upsertPresence(presence({ viewSessionId: "old" }), 1000);
    upsertPresence(presence({ viewSessionId: "new" }), 50_000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, text: { include: false } }, files: [file("/a.jsonl"), file("/b.jsonl"), file("/c.jsonl")], siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 60_000 });
    expect(result.view.viewSessionId).toBe("new");
    expect(result.resolution.ambiguous).toBe(false);
    expect(result.resolution.alternatives.map((session) => session.viewSessionId)).toEqual(["old"]);
  });
});

describe("snapshot text", () => {
  test("redacts token-shaped content and excludes tool records", () => {
    const pathname = path.join(sandbox, "redaction.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "user", timestamp: "t1", message: { content: "token=secret sk-ant-abcdefghijklmnopqrstuvwxyz" } }),
      JSON.stringify({ type: "assistant", timestamp: "t2", message: { content: [{ type: "text", text: "Bearer abcdefghijklmnopqrstuvwxyz" }, { type: "tool_use", name: "Bash", input: { secret: "x" } }] } }),
    ].join("\n"));
    const value = compactText(file(pathname), 6, 4000, 4000);
    expect(JSON.stringify(value)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(hardenedRedact("ghp_abcdefghijklmnopqrstuvwxyz1234567890")).toBe("[redacted]");
  });
  test("redacts credential families and header values", () => {
    const fixtures = [
      "Authorization: Basic dXNlcjpwYXNz", "Cookie: session=secret; csrf=secret", "Set-Cookie: auth=secret",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456", "xoxb-" + "1234567890-abcdefghijklmnopqrstuvwxyz", "npm_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP", "AIzaabcdefghijklmnopqrstuvwxyz123456789", "eyJabcdefghij.abcdefghijk.abcdefghijk",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    ];
    for (const fixture of fixtures) expect(hardenedRedact(fixture)).not.toContain("secret");
    expect(hardenedRedact(fixtures.join("\n"))).not.toMatch(/github_pat_|xoxb-|npm_|AKIA|AIza|eyJ/);
  });
  test("refuses a scan-then-symlink transcript swap", () => {
    const target = path.join(sandbox, "outside.txt");
    const pathname = path.join(sandbox, "swapped.jsonl");
    fs.writeFileSync(target, "TOP_SECRET_OUTSIDE");
    fs.rmSync(pathname, { force: true });
    fs.symlinkSync(target, pathname);
    const result = compactText(file(pathname), 6, 4000, 4000);
    expect(result).toMatchObject({ messages: [], truncated: true, error: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET_OUTSIDE");
  });
  test("keeps aggregate multibyte text within 32 KiB", async () => {
    const paths = Array.from({ length: 9 }, (_, index) => path.join(sandbox, `emoji-${index}.jsonl`));
    for (const pathname of paths) fs.writeFileSync(pathname, JSON.stringify({ type: "assistant", timestamp: "t", message: { content: [{ type: "text", text: "😀".repeat(4000) }] } }) + "\n");
    upsertPresence(presence({ focusedPath: null, selectedPaths: paths, visiblePaths: paths }), 1000);
    const result = await composeSnapshot({ request: { schemaVersion: 1, scope: { kind: "selected" }, text: { maxCharsPerConversation: 4000 } }, files: paths.map((pathname) => file(pathname)), siblings: { selfResolution: "omitted", agents: [] }, scannerDurationMs: 0, now: 2000 });
    const bytes = result.conversations.flatMap((item) => item.text?.messages ?? []).reduce((total, message) => total + Buffer.byteLength(message.text, "utf8"), 0);
    expect(bytes).toBeLessThanOrEqual(32 * 1024);
  });
});

test("validators bound membership and scope", () => {
  expect(() => validatePresence({ ...presence(), visiblePaths: Array.from({ length: 129 }, (_, index) => `/p-${index}`) })).toThrow(ViewValidationError);
  expect(() => validateSnapshotRequest({ schemaVersion: 1, scope: { kind: "paths", paths: Array.from({ length: 17 }, (_, index) => `/p-${index}`) } })).toThrow(ViewValidationError);
  expect(() => validatePresence({ ...presence(), sequence: 1.5 })).toThrow(ViewValidationError);
  expect(() => validatePresence({ ...presence(), project: "p".repeat(257) })).toThrow(ViewValidationError);
  expect(() => validatePresence({ ...presence(), mode: "list", camera: { x: 0, y: 0, zoom: 1, worldRect: { x: 0, y: 0, width: 1, height: 1 } } })).toThrow(ViewValidationError);
  expect(() => validatePresence({ ...presence(), extra: true })).toThrow(ViewValidationError);
  expect(() => validateSnapshotRequest({ schemaVersion: 1, text: { lastMessages: 1.5 } })).toThrow(ViewValidationError);
  expect(() => validateSnapshotRequest({ schemaVersion: 1, unknown: true })).toThrow(ViewValidationError);
});

describe("viewer.snapshot spawn path resolution (#342)", () => {
  async function spawnScopedSnapshot(options: { settle: boolean }) {
    const { AgentRegistry } = await import("@/lib/agent/registry");
    const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
    const directory = fs.mkdtempSync(path.join(sandbox, "spawn-scope-"));
    const store = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      transport: "structured",
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const artifactPath = "/sessions/019f7b8a-9f75-7dc0-b231-17f7eadd0342.jsonl";
    if (options.settle) {
      const settled = store.settleSpawn(begun.receipt.launchId, {
        key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd0342" },
        artifactPath,
        cwd: "/repo",
        accountId: "work",
        launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
        status: "unhosted",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      if (settled.kind !== "settled") throw new Error("expected settlement");
    }
    const spawnPath = `spawn:${begun.receipt.launchId}`;
    upsertPresence(presence({ visiblePaths: [spawnPath, "/a.jsonl"] }), 1000);
    const result = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } },
      files: [file("/a.jsonl"), ...(options.settle ? [file(artifactPath, { engine: "codex", fmt: "codex", root: "codex-sessions", title: "Spawned worker" })] : [])],
      siblings: { selfResolution: "omitted", agents: [] },
      registry: store.readOnlySnapshot(),
      scannerDurationMs: 1,
      now: 2000,
    });
    return { result, spawnPath, artifactPath, receipt: begun.receipt };
  }

  test("a spawn: visible path resolves to its materialized conversation", async () => {
    const { result, spawnPath, artifactPath } = await spawnScopedSnapshot({ settle: true });
    expect(result.scope.returnedPaths).toEqual([artifactPath, "/a.jsonl"]);
    expect(result.scope).toMatchObject({ truncated: false, omittedCount: 0 });
    expect(result.stubs).toEqual([]);
    const resolved = result.conversations.find((card) => card.path === artifactPath);
    expect(resolved).toMatchObject({ engine: "codex", resolvedFrom: spawnPath });
  });

  test("an unresolved spawn: path returns a typed stub instead of silent omission", async () => {
    const { result, spawnPath, receipt } = await spawnScopedSnapshot({ settle: false });
    expect(result.scope.returnedPaths).toEqual(["/a.jsonl"]);
    expect(result.scope).toMatchObject({ truncated: false, omittedCount: 0 });
    expect(result.stubs).toEqual([{
      path: spawnPath,
      kind: "spawn-stub",
      launch: {
        launchId: receipt.launchId,
        state: "starting",
        error: null,
        retrySafe: false,
        engine: "codex",
        cwd: "/repo",
        createdAt: receipt.createdAt,
      },
    }]);
  });

  test("a spawn: path with no receipt still counts as genuine omission", async () => {
    upsertPresence(presence({ visiblePaths: ["spawn:unknown-launch", "/a.jsonl"] }), 1000);
    const result = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } },
      files: [file("/a.jsonl")],
      siblings: { selfResolution: "omitted", agents: [] },
      scannerDurationMs: 1,
      now: 2000,
    });
    expect(result.scope).toMatchObject({ returnedPaths: ["/a.jsonl"], truncated: true, omittedCount: 1 });
    expect(result.stubs).toEqual([]);
  });
});
