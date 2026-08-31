import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";

const deadProbeView: RuntimeSessionView = {
  session: {
    conversationId: "conversation-live-legacy",
    sessionKey: { engine: "codex", sessionId: "legacy-session" },
    hostKind: "codex-app-server",
    host: "dead",
    turn: "unknown",
    activeTurnId: null,
  } as RuntimeSessionView["session"],
  uiState: "dead",
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
};

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeEnabled: () => true,
  useRuntimeSession: () => deadProbeView,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeSessionForConversation: () => deadProbeView,
  useRuntimeReceiptsForArtifact: () => [],
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [],
    linesStart: 0,
    size: 0,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { BranchPane } = await import("./BranchPane");

afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

function liveLegacyFile(): FileEntry {
  return {
    path: "/conversations/live-legacy.jsonl",
    root: "codex-sessions",
    name: "live-legacy.jsonl",
    project: "viewer",
    title: "live legacy turn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: Date.now() / 1000,
    size: 512,
    activity: "live",
    activityReason: "jsonl_turn_open",
    proc: "running",
    pid: 203,
    conversationId: "conversation-live-legacy",
    lastTurn: { startedAt: Date.now() - 60_000, endedAt: null },
    model: "gpt",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

test("a failed legacy pane-buffer probe over a live recorded host and running turn renders running with no Respawn CTA", () => {
  const html = renderToStaticMarkup(<BranchPane file={liveLegacyFile()} tasks={[]} isRoot />);

  expect(html).toContain('data-card-status="running"');
  expect(html).not.toContain("data-dead-host-banner");
  expect(html).not.toContain("Respawn conversation");
});
