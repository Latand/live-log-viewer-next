import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import {
  applyTitleOverride,
  indexSessionTitles,
  isRenameableSessionPath,
  loadSessionTitles,
  MAX_TITLE_OVERRIDES,
  overrideForEntry,
  preferredTitleKey,
  readSessionTitles,
  sanitizeCustomTitle,
  saveSessionTitles,
  titleKeysForEntry,
  TitleStoreUnreadableError,
  writeSessionTitle,
  type SessionTitleOverride,
} from "./titleStore";

let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-titles-"));
  file = path.join(dir, "session-titles.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const UUID = "11111111-2222-4333-8444-555555555555";
const claudePath = `/home/u/.claude/projects/proj/${UUID}.jsonl`;
const codexPath = `/home/u/.codex/sessions/2026/07/12/rollout-2026-07-12T00-00-00-${UUID}.jsonl`;

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: claudePath,
    root: "claude-projects",
    name: "x",
    project: "proj",
    title: "Auto derived title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 0,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

/** Single-key write helper (the common case; `preferredKey` is the only key). */
function write(key: string, title: string | null, baseRevision: number | undefined, now: string) {
  return writeSessionTitle([key], key, title, baseRevision, now, file);
}

test("key precedence: conversation id wins, then session uuid, then path", () => {
  expect(titleKeysForEntry(entry({ conversationId: "conversation_abc" }))).toEqual([
    "conversation:conversation_abc",
    `uuid:claude:${UUID}`,
    `path:${claudePath}`,
  ]);
  expect(preferredTitleKey(entry({ conversationId: "conversation_abc" }))).toBe("conversation:conversation_abc");
  expect(preferredTitleKey(entry())).toBe(`uuid:claude:${UUID}`);
  expect(preferredTitleKey(entry({ engine: "codex", root: "codex-sessions", path: codexPath }))).toBe(`uuid:codex:${UUID}`);
});

test("path fallback when the filename carries no uuid", () => {
  const noUuid = entry({ path: "/home/u/.claude/projects/proj/not-a-uuid.jsonl" });
  expect(preferredTitleKey(noUuid)).toBe("path:/home/u/.claude/projects/proj/not-a-uuid.jsonl");
});

test("sanitize caps length, strips markdown, and treats blank as a clear", () => {
  expect(sanitizeCustomTitle("  **Bold** `code`  ")).toBe("Bold code");
  expect(sanitizeCustomTitle("   ")).toBeNull();
  expect(sanitizeCustomTitle("x".repeat(400))!.length).toBeLessThanOrEqual(120);
});

test("isRenameableSessionPath rejects Claude subagent transcripts", () => {
  expect(isRenameableSessionPath(claudePath)).toBe(true);
  expect(isRenameableSessionPath("/home/u/.claude/projects/proj/agent-123.jsonl")).toBe(false);
  expect(isRenameableSessionPath("/home/u/.claude/projects/proj/abc/subagents/agent-9.jsonl")).toBe(false);
  expect(isRenameableSessionPath("/home/u/.claude/projects/proj/abc/subagents/x.jsonl")).toBe(false);
});

test("set then clear leaves a tombstone and the label survives a reload (persistence)", () => {
  const key = preferredTitleKey(entry());
  const set = write(key, "My name", undefined, "2026-07-12T00:00:00.000Z");
  expect(set).toEqual({ ok: true, override: { key, title: "My name", revision: 1, updatedAt: "2026-07-12T00:00:00.000Z" }, revision: 1 });

  // A fresh load from disk sees the override — the label survives a restart.
  const reloaded = loadSessionTitles(file);
  expect(reloaded).toHaveLength(1);
  expect(reloaded[0]!.title).toBe("My name");

  const cleared = write(key, null, undefined, "2026-07-12T00:01:00.000Z");
  expect(cleared).toEqual({ ok: true, override: null, revision: 2 });
  // The record persists as a tombstone (title null) preserving the revision.
  const afterClear = loadSessionTitles(file);
  expect(afterClear).toHaveLength(1);
  expect(afterClear[0]!.title).toBeNull();
  expect(afterClear[0]!.revision).toBe(2);
});

test("overlay treats a tombstone as cleared but still surfaces its revision", () => {
  const key = preferredTitleKey(entry());
  write(key, "temp", undefined, "t1");
  write(key, null, 1, "t2");
  const index = indexSessionTitles(loadSessionTitles(file));
  const file0 = entry();
  applyTitleOverride(file0, index);
  // Cleared: the derived title stands, no autoTitle, but the base revision is
  // exposed so the next set does not spuriously conflict.
  expect(file0.title).toBe("Auto derived title");
  expect(file0.autoTitle).toBeUndefined();
  expect(file0.titleRevision).toBe(2);
});

test("revision stays monotonic across a clear so a stale write is rejected", () => {
  const key = preferredTitleKey(entry());
  write(key, "one", undefined, "t1"); // revision 1
  write(key, null, 1, "t2"); // tombstone revision 2
  // A stale editor still holding revision 1 must not overwrite the recreated
  // record: the new set resumes from the tombstone's revision, not from 1.
  const stale = write(key, "sneaky", 1, "t3");
  expect(stale.ok).toBe(false);
  const fresh = write(key, "proper", 2, "t4");
  expect(fresh).toMatchObject({ ok: true, override: { title: "proper", revision: 3 } });
});

test("revision increments on each set and empty save clears", () => {
  const key = preferredTitleKey(entry());
  expect(write(key, "one", undefined, "t1")).toMatchObject({ ok: true, override: { revision: 1 } });
  expect(write(key, "two", undefined, "t2")).toMatchObject({ ok: true, override: { revision: 2, title: "two" } });
  expect(write(key, "   ", undefined, "t3")).toEqual({ ok: true, override: null, revision: 3 });
});

test("base revision mismatch is a conflict carrying current server state", () => {
  const key = preferredTitleKey(entry());
  write(key, "one", undefined, "t1");
  const conflict = write(key, "two", 0, "t2");
  expect(conflict).toEqual({ ok: false, conflict: { key, title: "one", revision: 1, updatedAt: "t1" } });
  expect(loadSessionTitles(file)[0]!.title).toBe("one");
  expect(write(key, "two", 1, "t3")).toMatchObject({ ok: true, override: { title: "two", revision: 2 } });
});

test("alias conversation ids keep a title reachable and migrate it onto the canonical key", () => {
  const provKey = "conversation:conversation_prov";
  write(provKey, "Sticky", undefined, "t1");

  const canonical = entry({ conversationId: "conversation_canon" });
  const keys = titleKeysForEntry(canonical, ["conversation_prov"]);
  // Canonical id stays preferred; the alias id is an extra candidate key.
  expect(keys[0]).toBe("conversation:conversation_canon");
  expect(keys).toContain("conversation:conversation_prov");

  // Lookup finds the provisional-keyed record via the alias.
  const index = indexSessionTitles(loadSessionTitles(file));
  expect(overrideForEntry(canonical, index, ["conversation_prov"])?.title).toBe("Sticky");

  // A write collapses onto the canonical key and drops the stale provisional one.
  const updated = writeSessionTitle(keys, keys[0]!, "Renamed", 1, "t2", file);
  expect(updated).toMatchObject({ ok: true, override: { key: "conversation:conversation_canon", title: "Renamed", revision: 2 } });
  const after = loadSessionTitles(file);
  expect(after.some((record) => record.key === provKey)).toBe(false);
  expect(after).toHaveLength(1);
});

test("a title filed under a predecessor generation is reachable and migrates via ownedPaths", () => {
  // The title was filed under a predecessor transcript's UUID key.
  const predUuid = "22222222-2222-4333-8444-555555555555";
  const predPath = `/home/u/.claude/projects/proj/${predUuid}.jsonl`;
  const predKey = `uuid:claude:${predUuid}`;
  write(predKey, "Kept", undefined, "t1");

  // The conversation has since succeeded onto a new transcript (the default
  // entry's UUID differs); it still owns the predecessor path.
  const successor = entry({ conversationId: "conversation_x" });
  const owned = [predPath];
  const keys = titleKeysForEntry(successor, [], owned);
  expect(keys[0]).toBe("conversation:conversation_x");
  expect(keys).toContain(predKey);

  const index = indexSessionTitles(loadSessionTitles(file));
  expect(overrideForEntry(successor, index, [], owned)?.title).toBe("Kept");
  const applied = entry({ conversationId: "conversation_x" });
  applyTitleOverride(applied, index, [], owned);
  expect(applied.title).toBe("Kept");
  expect(applied.autoTitle).toBe("Auto derived title");

  // A write collapses the predecessor-keyed record onto the conversation key.
  const updated = writeSessionTitle(keys, keys[0]!, "Renamed", 1, "t2", file);
  expect(updated).toMatchObject({ ok: true, override: { key: "conversation:conversation_x", revision: 2 } });
  expect(loadSessionTitles(file).some((record) => record.key === predKey)).toBe(false);
});

test("an override equal to the derived title keeps its autoTitle provenance and Reset marker", () => {
  const key = preferredTitleKey(entry());
  write(key, "Auto derived title", undefined, "t1"); // identical to the derived title
  const index = indexSessionTitles(loadSessionTitles(file));
  const file0 = entry();
  applyTitleOverride(file0, index);
  expect(file0.title).toBe("Auto derived title");
  // autoTitle is set even though the strings match, so the client shows Reset.
  expect(file0.autoTitle).toBe("Auto derived title");
  expect(file0.titleRevision).toBe(1);
});

test("overlay applies the override and preserves the derived title as autoTitle", () => {
  const key = preferredTitleKey(entry());
  write(key, "Human name", undefined, "t1");
  const index = indexSessionTitles(loadSessionTitles(file));
  const file0 = entry();
  applyTitleOverride(file0, index);
  expect(file0.title).toBe("Human name");
  expect(file0.autoTitle).toBe("Auto derived title");
  expect(file0.titleRevision).toBe(1);
});

test("a fallback-key override migrates onto the conversation key and stays cleared", () => {
  // Filed while only the UUID was known.
  const uuidKey = `uuid:claude:${UUID}`;
  write(uuidKey, "Sticky", undefined, "t1");

  // The conversation id later appears; a clear routed through the full
  // candidate set bases on the UUID record (revision 1) and migrates it.
  const withId = entry({ conversationId: "conversation_new" });
  const keys = titleKeysForEntry(withId);
  const cleared = writeSessionTitle(keys, keys[0]!, null, 1, "t2", file);
  expect(cleared).toEqual({ ok: true, override: null, revision: 2 });

  // No active override survives, and the stale UUID record is gone — the next
  // poll cannot restore the old custom title.
  const records = loadSessionTitles(file);
  expect(records.filter((record) => record.title !== null)).toHaveLength(0);
  expect(records.some((record) => record.key === uuidKey)).toBe(false);
  const index = indexSessionTitles(records);
  expect(overrideForEntry(withId, index)?.title ?? null).toBeNull();
});

test("a fallback-key override is updated in place once the conversation key is preferred", () => {
  const uuidKey = `uuid:claude:${UUID}`;
  write(uuidKey, "Sticky", undefined, "t1");
  const withId = entry({ conversationId: "conversation_new" });
  const keys = titleKeysForEntry(withId);
  const updated = writeSessionTitle(keys, keys[0]!, "Renamed", 1, "t2", file);
  expect(updated).toMatchObject({ ok: true, override: { key: "conversation:conversation_new", title: "Renamed", revision: 2 } });
  const index = indexSessionTitles(loadSessionTitles(file));
  expect(overrideForEntry(withId, index)?.title).toBe("Renamed");
});

test("no override leaves the entry untouched", () => {
  const index = indexSessionTitles([]);
  const file0 = entry();
  applyTitleOverride(file0, index);
  expect(file0.title).toBe("Auto derived title");
  expect(file0.autoTitle).toBeUndefined();
  expect(file0.titleRevision).toBeUndefined();
});

test("a missing store is a legitimately empty store that a write then creates", () => {
  expect(readSessionTitles(file)).toEqual([]);
  write("path:/x", "New", undefined, "t1");
  expect(loadSessionTitles(file)).toHaveLength(1);
});

test("a mutation aborts on a corrupt store and never erases the existing bytes", () => {
  fs.writeFileSync(file, "{ not valid json");
  expect(() => write("path:/x", "New", undefined, "t1")).toThrow(TitleStoreUnreadableError);
  // The corrupt bytes are preserved — a blind rewrite would have destroyed the
  // real (recoverable) file.
  expect(fs.readFileSync(file, "utf8")).toBe("{ not valid json");
});

test("an unsupported schema version aborts a mutation", () => {
  fs.writeFileSync(file, JSON.stringify({ version: 2, titles: [] }));
  expect(() => write("path:/x", "New", undefined, "t1")).toThrow(TitleStoreUnreadableError);
});

test("a malformed record aborts a mutation instead of silently dropping it", () => {
  fs.writeFileSync(file, JSON.stringify({ version: 1, titles: [
    { key: "path:/a", title: "ok", revision: 1, updatedAt: "t" },
    { key: "path:/b", garbage: true },
  ] }));
  expect(() => write("path:/x", "New", undefined, "t1")).toThrow(TitleStoreUnreadableError);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).titles).toHaveLength(2);
});

test("read consumers degrade to no overrides on a corrupt store", () => {
  fs.writeFileSync(file, "garbage");
  expect(loadSessionTitles(file)).toEqual([]);
  expect(() => readSessionTitles(file)).toThrow(TitleStoreUnreadableError);
});

test("clearing an already-tombstoned record reports its revision, not a fabricated one", () => {
  const key = preferredTitleKey(entry());
  write(key, "temp", undefined, "t1"); // rev 1
  write(key, null, 1, "t2"); // tombstone rev 2
  // A second clear is a no-op: it must report the existing tombstone's revision
  // (2), so an optimistic client does not record a phantom rev 3 that never
  // settles against polls at 2.
  expect(write(key, null, 2, "t3")).toEqual({ ok: true, override: null, revision: 2 });
  expect(loadSessionTitles(file)[0]!.revision).toBe(2);
});

test("store is capped to the newest records", () => {
  const records: SessionTitleOverride[] = Array.from({ length: MAX_TITLE_OVERRIDES + 5 }, (_unused, index) => ({
    key: `path:/s/${index}`,
    title: `t${index}`,
    revision: 1,
    updatedAt: `2026-07-12T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(4, "0")}Z`,
  }));
  saveSessionTitles(records, file);
  write("path:/s/new", "fresh", undefined, "2027-01-01T00:00:00.000Z");
  const stored = loadSessionTitles(file);
  expect(stored.length).toBeLessThanOrEqual(MAX_TITLE_OVERRIDES);
  expect(stored.some((record) => record.title === "fresh")).toBe(true);
});
