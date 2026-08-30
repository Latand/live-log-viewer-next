import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { compactText } from "./compactText";
import { resetPresenceForTest, upsertPresence } from "./presenceStore";
import { composeSnapshot } from "./snapshot";
import type { PresencePayloadV1 } from "./types";

/*
 * Issue #1207. Without the widened transcript filter a focused or selected
 * OpenClaw path is silently dropped from every snapshot an agent reads, and
 * without dropping the `"claude" | "codex"` cast beside it the entry would be
 * reported as Claude. Both are viewing surfaces outside the scanner, and
 * without them an OpenClaw card is scanned, attributed and rendered and then
 * vanishes from the agent-facing view.
 *
 * A sibling of `view.test.ts` rather than a section inside it: that file
 * carries redaction fixtures whose literal shapes the publication gate reads
 * as credentials, so editing it would fail the gate on content this change
 * does not own. Every path below is invented.
 */

afterEach(() => resetPresenceForTest());

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-view-openclaw-"));

const OPENCLAW_PATH = "/openclaw/agents/primary/sessions/oc-session-alpha.jsonl";

function presence(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-openclaw",
    deviceId: "desktop",
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "viewer",
    mode: "scheme",
    viewport: { width: 100, height: 100, dpr: 1 },
    camera: null,
    focusedPath: OPENCLAW_PATH,
    selectedPaths: [],
    visiblePaths: [OPENCLAW_PATH],
    board: { renderedRevision: 1, durableRevision: 1, sync: "current" },
    ...overrides,
  };
}

function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: "openclaw-sessions",
    name: path.basename(pathname),
    project: "viewer",
    title: "Invented OpenClaw prompt",
    engine: "openclaw",
    kind: "session",
    fmt: "openclaw",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: "demo-model",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

test("a focused OpenClaw path is reported under its own engine", async () => {
  upsertPresence(presence(), 1000);
  const result = await composeSnapshot({
    request: { schemaVersion: 1, text: { include: false } },
    files: [file(OPENCLAW_PATH)],
    siblings: { selfResolution: "omitted", agents: [] },
    scannerDurationMs: 0,
    now: 2000,
  });

  expect(result.conversations.map((item) => item.path)).toEqual([OPENCLAW_PATH]);
  expect(result.conversations[0]).toMatchObject({ engine: "openclaw", model: "demo-model", title: "Invented OpenClaw prompt" });
});

test("an OpenClaw path with no scan entry is still omitted", async () => {
  const absent = "/openclaw/agents/primary/sessions/oc-session-absent.jsonl";
  upsertPresence(presence({ focusedPath: absent, visiblePaths: [absent] }), 1000);
  const result = await composeSnapshot({
    request: { schemaVersion: 1, text: { include: false } },
    files: [],
    siblings: { selfResolution: "omitted", agents: [] },
    scannerDurationMs: 0,
    now: 2000,
  });

  expect(result.conversations).toEqual([]);
  expect(result.scope).toMatchObject({ omittedCount: 1, truncated: true });
});

/* The snapshot's text body is the other half of admitting the entry: a path
   that resolves and then reports no messages tells an agent the conversation
   is empty. Every record below is invented. */
function seedTranscript(name: string): string {
  const pathname = path.join(sandbox, name);
  fs.writeFileSync(pathname, [
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "Invented OpenClaw request" },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-01T00:00:05.000Z",
      message: {
        role: "assistant",
        provider: "invented-provider",
        model: "demo-model",
        content: [
          { type: "thinking", thinking: "Invented private reasoning" },
          { type: "text", text: "Invented OpenClaw answer" },
          { type: "toolCall", id: "call-alpha", name: "read", arguments: { path: "/invented/file" } },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-01T00:00:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-alpha",
        toolName: "read",
        content: [{ type: "text", text: "Invented tool output" }],
      },
    }),
    "",
  ].join("\n"));
  return pathname;
}

test("an OpenClaw transcript contributes its prompts and prose to the snapshot text", () => {
  const pathname = seedTranscript("oc-session-text.jsonl");

  const value = compactText(file(pathname), 6, 4000, 4000);

  expect(value.messages).toEqual([
    { role: "user", at: "2026-08-01T00:00:00.000Z", text: "Invented OpenClaw request" },
    { role: "assistant", at: "2026-08-01T00:00:05.000Z", text: "Invented OpenClaw answer" },
  ]);
  expect(value.error).toBeUndefined();
});

test("the snapshot text drops OpenClaw thinking, tool calls and tool results", () => {
  const pathname = seedTranscript("oc-session-nonprose.jsonl");

  const serialized = JSON.stringify(compactText(file(pathname), 6, 4000, 4000));

  expect(serialized).not.toContain("Invented private reasoning");
  expect(serialized).not.toContain("Invented tool output");
  expect(serialized).not.toContain("call-alpha");
});

test("a selected OpenClaw path carries its text through composeSnapshot", async () => {
  const pathname = seedTranscript("oc-session-selected.jsonl");
  upsertPresence(presence({ focusedPath: pathname, visiblePaths: [pathname] }), 1000);

  const result = await composeSnapshot({
    request: { schemaVersion: 1 },
    files: [file(pathname)],
    siblings: { selfResolution: "omitted", agents: [] },
    scannerDurationMs: 0,
    now: 2000,
  });

  expect(result.conversations[0]?.text?.messages.map((message) => message.text)).toEqual([
    "Invented OpenClaw request",
    "Invented OpenClaw answer",
  ]);
});
