import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  conversationIdentity,
  formatConversationHash,
  isArchivedPredecessor,
  isMigrationSuccessor,
  parseConversationHash,
  resolveConversationTarget,
  withoutArchivedPredecessors,
} from "./identity";

const file = (over: Partial<FileEntry>): FileEntry =>
  ({ path: "/p", name: "n", root: "codex-sessions", project: "proj", title: "t", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 0, size: 0, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...over }) as FileEntry;

describe("conversationIdentity", () => {
  test("prefers the stable id, falls back to path", () => {
    expect(conversationIdentity(file({ path: "/a" }))).toBe("/a");
    expect(conversationIdentity(file({ path: "/a", conversationId: "conv-1" }))).toBe("conv-1");
  });
});

describe("predecessor / successor markers", () => {
  test("migratedTo marks an archived predecessor", () => {
    expect(isArchivedPredecessor(file({ migratedTo: "/b" }))).toBeTrue();
    expect(isArchivedPredecessor(file({}))).toBeFalse();
  });
  test("predecessorPath marks a successor", () => {
    expect(isMigrationSuccessor(file({ predecessorPath: "/a" }))).toBeTrue();
    expect(isMigrationSuccessor(file({}))).toBeFalse();
  });
});

describe("parseConversationHash", () => {
  test("recognises #c=, #f=, #p= and strips #question", () => {
    expect(parseConversationHash("#c=conv-1")).toEqual({ conversationId: "conv-1", filePath: null, project: null });
    expect(parseConversationHash("#c=conv-1#question")).toEqual({ conversationId: "conv-1", filePath: null, project: null });
    expect(parseConversationHash("#f=%2Ftmp%2Fx.jsonl")).toEqual({ conversationId: null, filePath: "/tmp/x.jsonl", project: null });
    expect(parseConversationHash("#p=My%20Project")).toEqual({ conversationId: null, filePath: null, project: "My Project" });
    expect(parseConversationHash("")).toEqual({ conversationId: null, filePath: null, project: null });
  });
});

describe("formatConversationHash", () => {
  test("canonicalises to #c= when a stable id exists", () => {
    expect(formatConversationHash(file({ path: "/a b", conversationId: "conv-1" }))).toBe("#c=conv-1");
    expect(formatConversationHash(file({ path: "/a b" }))).toBe("#f=%2Fa%20b");
  });
});

describe("resolveConversationTarget", () => {
  const predecessor = file({ path: "/gen1", conversationId: "conv-1", migratedTo: "/gen2" });
  const successor = file({ path: "/gen2", conversationId: "conv-1", predecessorPath: "/gen1" });
  const other = file({ path: "/other" });
  const files = [predecessor, successor, other];

  test("a #c= link resolves to the current (non-archived) generation", () => {
    expect(resolveConversationTarget(files, { conversationId: "conv-1", filePath: null, project: null })).toBe(successor);
  });

  test("a legacy #f= path pointing at an archived predecessor redirects to the successor", () => {
    expect(resolveConversationTarget(files, { conversationId: null, filePath: "/gen1", project: null })).toBe(successor);
  });

  test("a legacy #f= path with no migration resolves directly", () => {
    expect(resolveConversationTarget(files, { conversationId: null, filePath: "/other", project: null })).toBe(other);
  });

  test("returns null when nothing matches yet", () => {
    expect(resolveConversationTarget(files, { conversationId: "missing", filePath: null, project: null })).toBeNull();
    expect(resolveConversationTarget(files, { conversationId: null, filePath: null, project: null })).toBeNull();
  });
});

describe("withoutArchivedPredecessors", () => {
  test("keeps identity (same array) when nothing migrated", () => {
    const plain = [file({ path: "/a" }), file({ path: "/b" })];
    expect(withoutArchivedPredecessors(plain)).toBe(plain);
  });
  test("drops archived predecessors so a migrated card shows once", () => {
    const kept = [file({ path: "/gen2", conversationId: "c", predecessorPath: "/gen1" })];
    const all = [file({ path: "/gen1", conversationId: "c", migratedTo: "/gen2" }), ...kept];
    expect(withoutArchivedPredecessors(all)).toEqual(kept);
  });
});

describe("succession keeps a stable card identity (finding 6)", () => {
  test("a successor's identity equals its predecessor's, so DOM/React keys never remount", () => {
    const predecessor = file({ path: "/gen1", conversationId: "conv-9" });
    const successor = file({ path: "/gen2", conversationId: "conv-9", predecessorPath: "/gen1" });
    // Same key across the path change → the card, its scroll and focus survive.
    expect(conversationIdentity(successor)).toBe(conversationIdentity(predecessor));
    // The canonical deep link is likewise stable across the succession.
    expect(formatConversationHash(successor)).toBe(formatConversationHash(predecessor));
  });
});

describe("legacy deep links must resolve against the UNFILTERED payload (finding 6)", () => {
  const predecessor = file({ path: "/gen1", conversationId: "conv-1", migratedTo: "/gen2" });
  const successor = file({ path: "/gen2", conversationId: "conv-1", predecessorPath: "/gen1" });
  const all = [predecessor, successor];

  test("against all files, a #f=predecessor link redirects to the successor", () => {
    expect(resolveConversationTarget(all, { conversationId: null, filePath: "/gen1", project: null })).toBe(successor);
  });

  test("folding the predecessor out first breaks resolution — why Viewer resolves against allFiles", () => {
    const folded = withoutArchivedPredecessors(all); // what the board renders from
    expect(resolveConversationTarget(folded, { conversationId: null, filePath: "/gen1", project: null })).toBeNull();
  });
});

test("resolveConversationTarget canonicalizes an aliased conversation id", () => {
  const current = { path: "/repo/current.jsonl", conversationId: "conversation_canonical" } as unknown as FileEntry;
  const hash = { conversationId: "conversation_old-alias", filePath: null, project: null };
  /* Without the alias map the stale id matches nothing. */
  expect(resolveConversationTarget([current], hash)).toBeNull();
  expect(resolveConversationTarget([current], hash, { "conversation_old-alias": "conversation_canonical" })).toBe(current);
});

test("resolveConversationTarget follows chained aliases and survives cycles", () => {
  const current = { path: "/repo/current.jsonl", conversationId: "conversation_C" } as unknown as FileEntry;
  const hash = { conversationId: "conversation_A", filePath: null, project: null };
  /* Repeated provisional-id adoptions chain aliases A → B → C. */
  expect(resolveConversationTarget([current], hash, { conversation_A: "conversation_B", conversation_B: "conversation_C" })).toBe(current);
  /* A malformed cyclic map terminates at the last unvisited id. */
  expect(resolveConversationTarget([current], hash, { conversation_A: "conversation_B", conversation_B: "conversation_A" })).toBeNull();
});
