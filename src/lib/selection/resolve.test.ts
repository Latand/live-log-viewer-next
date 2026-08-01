import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationLookup, RegistryConversation } from "@/lib/agent/registry";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";

import {
  SELECTED_TAIL_MAX_BYTES,
  SELECTED_TAIL_MAX_LINES,
  selectedConversationResolver,
} from "./resolve";

/**
 * #844 §6/§7: the selected card resolves through a process-scoped identity
 * lookup and an explicitly bounded tail read. Both must keep working while a
 * full Viewer scan is unhealthy, which is why nothing here touches the scanner:
 * the fixtures below make any scan-shaped dependency hang or throw, and the
 * resolver still answers.
 */

const NEVER_RETURNS: ConversationLookup["conversationForPath"] = () => {
  throw new Error("a full scan must never be on the selected-card resolution path");
};

function conversation(id: string, artifactPath: string, project: string | null): RegistryConversation {
  return {
    id: id as ViewerConversationId,
    engine: "codex",
    generations: [{
      id: "gen-1",
      path: artifactPath,
      accountId: null,
      launchProfile: emptyLaunchProfile(),
      historyHash: null,
      host: null,
      createdAt: "2026-07-31T08:00:00.000Z",
      archivedAt: null,
    }],
    continuityPaths: [],
    abandonedContinuityPaths: [],
    providerForkPaths: [],
    projectOwnership: project ? { project, source: "operator", setAt: "2026-07-31T08:00:00.000Z", operationId: "op-1" } : null,
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    agentRole: null,
    delegationDepth: null,
    turn: { state: "idle", source: "empty", terminalAt: null, observedAt: null },
    createdAt: "2026-07-31T08:00:00.000Z",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
}

function lookupFor(records: Record<string, RegistryConversation>, calls: string[] = []): ConversationLookup {
  return {
    conversationForPath: NEVER_RETURNS,
    canonicalConversationId: (id) => id,
    conversation: (id) => {
      calls.push(id);
      return records[id] ?? null;
    },
  };
}

function transcript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-selected-resolve-"));
  const file = path.join(dir, "worker-a.jsonl");
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

test("resolution is one identity lookup, never a path walk or a scan", () => {
  const file = transcript(["{}"]);
  const calls: string[] = [];
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }, calls));
  expect(resolver.resolve("conversation_atlas_a")).toEqual({
    conversationId: "conversation_atlas_a",
    engine: "codex",
    path: file,
    project: "atlas",
  });
  expect(calls).toEqual(["conversation_atlas_a"]);
});

test("an unknown or malformed conversation id resolves to null without touching disk", () => {
  const resolver = selectedConversationResolver(lookupFor({}));
  expect(resolver.resolve("conversation_missing")).toBeNull();
  expect(resolver.resolve("not-a-conversation-id")).toBeNull();
  expect(resolver.resolve("")).toBeNull();
});

test("the tail read is bounded by lines and stays the LAST lines of the transcript", () => {
  const file = transcript(Array.from({ length: 40 }, (_, index) => `{"n":${index}}`));
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  const tail = resolver.readTail("conversation_atlas_a", { maxLines: 5 });
  expect(tail).not.toBeNull();
  expect(tail!.lines).toEqual(['{"n":35}', '{"n":36}', '{"n":37}', '{"n":38}', '{"n":39}']);
  expect(tail!.truncated).toBe(true);
  expect(tail!.path).toBe(file);
});

test("a short transcript is returned whole and is not marked truncated", () => {
  const file = transcript(['{"n":0}', '{"n":1}']);
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  const tail = resolver.readTail("conversation_atlas_a", { maxLines: 5 });
  expect(tail!.lines).toEqual(['{"n":0}', '{"n":1}']);
  expect(tail!.truncated).toBe(false);
});

test("the byte bound is enforced regardless of the line bound, and never splits a line", () => {
  const file = transcript(Array.from({ length: 200 }, (_, index) => `{"pad":"${"x".repeat(200)}","n":${index}}`));
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  const tail = resolver.readTail("conversation_atlas_a", { maxLines: 200, maxBytes: 2_048 });
  expect(tail!.bytes).toBeLessThanOrEqual(2_048);
  expect(tail!.truncated).toBe(true);
  for (const line of tail!.lines) expect(() => JSON.parse(line)).not.toThrow();
});

test("the caller cannot ask for an unbounded read", () => {
  const file = transcript(Array.from({ length: 5_000 }, (_, index) => `{"n":${index}}`));
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  const tail = resolver.readTail("conversation_atlas_a", { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
  expect(tail!.lines.length).toBeLessThanOrEqual(SELECTED_TAIL_MAX_LINES);
  expect(tail!.bytes).toBeLessThanOrEqual(SELECTED_TAIL_MAX_BYTES);
});

test("a conversation whose transcript is gone resolves but reads no tail", () => {
  const file = transcript(["{}"]);
  fs.rmSync(file);
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  expect(resolver.resolve("conversation_atlas_a")?.path).toBe(file);
  expect(resolver.readTail("conversation_atlas_a", { maxLines: 5 })).toBeNull();
});

test("a transcript path replaced by a symlink reads no tail", () => {
  const file = transcript(['{"n":0}']);
  const elsewhere = path.join(path.dirname(file), "elsewhere.jsonl");
  fs.writeFileSync(elsewhere, '{"secret":"other artifact"}\n');
  /* The registry recorded a regular file; something swapped the leaf for a link
     afterwards. The tail follows the identity the scan named, or nothing. */
  fs.rmSync(file);
  fs.symlinkSync(elsewhere, file);
  const resolver = selectedConversationResolver(lookupFor({ conversation_atlas_a: conversation("conversation_atlas_a", file, "atlas") }));
  expect(resolver.readTail("conversation_atlas_a", { maxLines: 5 })).toBeNull();
});
