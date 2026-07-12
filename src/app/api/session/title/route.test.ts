import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { loadSessionTitles, writeSessionTitle } from "@/lib/session/titleStore";
import type { TitleTarget, TitleTargetInput } from "@/lib/session/titleTarget";

const UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_PATH = `/home/u/.claude/projects/proj/${UUID}.jsonl`;

/* Session resolution and tmux propagation live behind @/lib/session/titleTarget
   so this route test can stub them without importing @/lib/scanner/roots or
   @/lib/tmux — modules that sibling suites replace through bun's shared module
   registry. `target` drives what resolveTitleTarget returns; `renamed` records
   propagation calls. */
let target: TitleTarget | null = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner", aliasConversationIds: [], ownedPaths: [] };
let renamed: { path: string; name: string }[] = [];

mock.module("@/lib/session/titleTarget", () => ({
  resolveTitleTarget: (input: TitleTargetInput) => {
    // Model the real gate closely enough for validation tests.
    if (typeof input.conversationId === "string" && !input.conversationId.startsWith("conversation_")) return null;
    if (input.conversationId === "conversation_missing") return null;
    if (typeof input.path === "string" && input.path === "/etc/passwd") return null;
    return target;
  },
  propagateTitleToWindow: async (resolved: TitleTarget, name: string) => {
    // Records the resolved target and window name — the route resolves the pane
    // from the target, never from the request.
    renamed.push({ path: resolved.path, name });
  },
}));

const { PATCH } = await import("./route");

let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-title-state-"));
  process.env.LLV_STATE_DIR = stateDir;
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner", aliasConversationIds: [], ownedPaths: [] };
  renamed = [];
});

afterEach(() => {
  // Restore the prior value (the test-preload sandbox), never unset it — leaving
  // LLV_STATE_DIR undefined would point later tests at the real state dir.
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function patch(body: unknown): Promise<Response> {
  return PATCH(new NextRequest("http://127.0.0.1/api/session/title", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("sets a custom title keyed by the stable conversation identity and persists it", async () => {
  const res = await patch({ conversationId: "conversation_owner", title: "My name" });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; override: { key: string; title: string; revision: number } };
  expect(json.ok).toBe(true);
  expect(json.override.key).toBe("conversation:conversation_owner");
  expect(json.override.title).toBe("My name");
  expect(json.override.revision).toBe(1);
  expect(loadSessionTitles()).toHaveLength(1);
});

test("falls back to the session UUID key when the registry does not own the session", async () => {
  target = { engine: "claude", path: SESSION_PATH, aliasConversationIds: [], ownedPaths: [] };
  const res = await patch({ path: SESSION_PATH, title: "Named" });
  const json = (await res.json()) as { override: { key: string } };
  expect(json.override.key).toBe(`uuid:claude:${UUID}`);
});

test("a title filed under a coalesced alias id migrates onto the canonical key", async () => {
  // A rename lands while the session's provisional id is current.
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_prov", aliasConversationIds: [], ownedPaths: [] };
  await patch({ conversationId: "conversation_prov", title: "Sticky" });
  expect(loadSessionTitles().find((record) => record.key === "conversation:conversation_prov")?.title).toBe("Sticky");

  // The registry coalesces it into the canonical id; the target now carries the
  // former id as an alias. An update must find and migrate the stored record.
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_canon", aliasConversationIds: ["conversation_prov"], ownedPaths: [] };
  const res = await patch({ conversationId: "conversation_canon", title: "Renamed", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { override: { key: string; title: string; revision: number } };
  expect(json.override.key).toBe("conversation:conversation_canon");
  expect(json.override.title).toBe("Renamed");
  const records = loadSessionTitles();
  expect(records.some((record) => record.key === "conversation:conversation_prov")).toBe(false);
  expect(records).toHaveLength(1);
});

test("a rename finds and migrates a title filed under a predecessor generation", async () => {
  // A title was filed under a predecessor transcript's UUID before succession.
  const predUuid = "22222222-2222-4333-8444-555555555555";
  const predPath = `/home/u/.claude/projects/proj/${predUuid}.jsonl`;
  writeSessionTitle([`uuid:claude:${predUuid}`], `uuid:claude:${predUuid}`, "Kept", undefined, "t1");

  // The current target owns that predecessor path; the rename must find and
  // migrate the stored record onto the conversation key.
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner", aliasConversationIds: [], ownedPaths: [predPath] };
  const res = await patch({ conversationId: "conversation_owner", title: "Renamed", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { override: { key: string } };
  expect(json.override.key).toBe("conversation:conversation_owner");
  const records = loadSessionTitles();
  expect(records.some((record) => record.key === `uuid:claude:${predUuid}`)).toBe(false);
  expect(records).toHaveLength(1);
});

test("empty title clears the override (leaving a revision-preserving tombstone)", async () => {
  await patch({ conversationId: "conversation_owner", title: "temp" });
  const res = await patch({ conversationId: "conversation_owner", title: "", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; override: null };
  expect(json.override).toBeNull();
  // No active override remains; the tombstone keeps the revision monotonic.
  const records = loadSessionTitles();
  expect(records.filter((record) => record.title !== null)).toHaveLength(0);
  expect(records[0]?.revision).toBe(2);
});

test("revision conflict returns a structured 409 with current server state", async () => {
  await patch({ conversationId: "conversation_owner", title: "first" });
  const res = await patch({ conversationId: "conversation_owner", title: "second", baseRevision: 0 });
  expect(res.status).toBe(409);
  const json = (await res.json()) as { error: string; conflict: { title: string; revision: number } };
  expect(json.error).toBe("revision conflict");
  expect(json.conflict.title).toBe("first");
  expect(json.conflict.revision).toBe(1);
});

test("retrying against the current revision after a conflict succeeds", async () => {
  await patch({ conversationId: "conversation_owner", title: "first" });
  const res = await patch({ conversationId: "conversation_owner", title: "second", baseRevision: 1 });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { override: { title: string; revision: number } };
  expect(json.override.title).toBe("second");
  expect(json.override.revision).toBe(2);
});

test("propagates the server-sanitized title to the resolved target, ignoring a crafted windowName", async () => {
  // The client asks for one window label but the persisted title is another —
  // the window must follow the sanitized stored title, not the raw request; and
  // propagation targets the resolved session, not a request-supplied pid.
  await patch({ conversationId: "conversation_owner", title: "**Bold** name", windowName: "arbitrary label" });
  expect(renamed).toEqual([{ path: SESSION_PATH, name: "Bold name" }]);
});

test("a reset sanitizes the client-provided window name before it reaches tmux", async () => {
  await patch({ conversationId: "conversation_owner", title: "temp" });
  renamed = [];
  await patch({ conversationId: "conversation_owner", title: "", baseRevision: 1, windowName: "**Auto** derived" });
  expect(renamed).toEqual([{ path: SESSION_PATH, name: "Auto derived" }]);
});

test("clearing after the registry claims ownership migrates and clears the fallback-key override", async () => {
  // Filed under the session UUID before the conversation id existed.
  target = { engine: "claude", path: SESSION_PATH, aliasConversationIds: [], ownedPaths: [] };
  await patch({ path: SESSION_PATH, title: "Sticky" });
  expect(loadSessionTitles().find((record) => record.key === `uuid:claude:${UUID}`)?.title).toBe("Sticky");

  // The registry now owns the session; a reset routed through the conversation
  // key must still clear the UUID-filed record (finding: fallback-key overrides
  // couldn't be cleared and got restored on the next poll).
  target = { engine: "claude", path: SESSION_PATH, conversationId: "conversation_owner", aliasConversationIds: [], ownedPaths: [] };
  const res = await patch({ conversationId: "conversation_owner", title: "", baseRevision: 1 });
  expect(res.status).toBe(200);
  const records = loadSessionTitles();
  expect(records.filter((record) => record.title !== null)).toHaveLength(0);
  expect(records.some((record) => record.key === `uuid:claude:${UUID}`)).toBe(false);
});

test("rejects an unknown conversation id", async () => {
  const res = await patch({ conversationId: "conversation_missing", title: "x" });
  expect(res.status).toBe(400);
});

test("rejects a disallowed session path", async () => {
  const res = await patch({ path: "/etc/passwd", title: "x" });
  expect(res.status).toBe(400);
});

test("rejects a non-string, non-null title before resolving the session", async () => {
  const res = await patch({ conversationId: "conversation_owner", title: 42 });
  expect(res.status).toBe(400);
});
