import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

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
