import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { appendRuntimeLiveTurnDelta, projectRuntimeLiveTurnItem, type RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { emptyStore, type RuntimeSession } from "@/components/runtime/runtimeModel";

/**
 * Issue #1100: the FIRST live turn of a freshly spawned conversation. The
 * structured host streams prose and tool calls; the transcript tail has read
 * nothing yet. The pane must already show the tool calls, interleaved with the
 * prose in response order — and once the transcript echoes them, the live rows
 * yield to the canonical rows without duplicates.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  IntersectionObserver: undefined,
});

const CONVERSATION_ID = "conversation_first_turn_1100";
const AT = (second: number) => `2026-08-23T08:30:${String(second).padStart(2, "0")}.000Z`;

/* The host's event stream for the first turn, projected by the real reducer
   helpers: a thought, a Read, a Bash that fails, more prose still streaming. */
function firstTurn(): RuntimeLiveTurn {
  let live = appendRuntimeLiveTurnDelta(null, "turn-first", "Reading the issue first.", AT(0));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-text-1",
    message: { role: "assistant", content: [{ type: "text", text: "Reading the issue first." }] },
  }, "completed", AT(1));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-tool-read",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/AGENTS.md" } }] },
  }, "completed", AT(2));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "user", uuid: "uuid-result-read",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read" }] },
  }, "completed", AT(3));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-tool-bash",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "gh issue view 1100" } }] },
  }, "completed", AT(4));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "user", uuid: "uuid-result-bash",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true }] },
  }, "completed", AT(5));
  live = appendRuntimeLiveTurnDelta(live, "turn-first", "The CLI is not authenticated, retrying", AT(6));
  return live!;
}

/* The transcript echo of that same turn, as the tail reads it a moment later. */
const TRANSCRIPT_ECHO = [
  { type: "user", uuid: "uuid-prompt", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "Fix issue 1100" }] } },
  { type: "assistant", uuid: "uuid-text-1", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "Reading the issue first." }] } },
  { type: "assistant", uuid: "uuid-tool-read", timestamp: AT(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/AGENTS.md" } }] } },
  { type: "user", uuid: "uuid-result-read", timestamp: AT(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "# AGENTS" }] } },
  { type: "assistant", uuid: "uuid-tool-bash", timestamp: AT(4), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "gh issue view 1100" } }] } },
  { type: "user", uuid: "uuid-result-bash", timestamp: AT(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content: "gh: not logged in" }] } },
].map((line) => JSON.stringify(line));

const session: RuntimeSession = {
  conversationId: CONVERSATION_ID,
  sessionKey: { engine: "claude", sessionId: "session-first-turn" },
  hostKind: "claude-broker",
  host: "hosted",
  turn: "running",
  provenance: "structured",
  revision: 9,
  attentionIds: [],
  recentReceipts: [],
  accountId: null,
  parentConversationId: null,
  flowId: null,
  workflowId: null,
  cwd: "/repo",
  artifactPath: null,
  capabilities: { steer: true, structuredAttention: true },
  activeTurnId: "turn-first",
  liveTurn: firstTurn(),
};

const tailState = { lines: [] as string[] };

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => ({
    session,
    uiState: "working",
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  }),
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tailState.lines,
    linesStart: 0,
    size: tailState.lines.length,
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
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");
const { resetCanonicalAssistantClaimsForTests } = await import("./conversation/liveTurnHandoff");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
  dom.sessionStorage.clear();
  resetCanonicalAssistantClaimsForTests();
  tailState.lines = [];
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

const file: FileEntry = {
  path: "/fixtures/claude/projects/-repo/session-first-turn.jsonl",
  root: "claude-projects",
  name: "session-first-turn.jsonl",
  project: "repo",
  title: "Fix issue 1100",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(AT(6)) / 1000,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: CONVERSATION_ID,
} as FileEntry;

function render(): { host: HTMLElement; root: Root } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const paint = () => flushSync(() => {
    root.render(
      <LogFeed
        file={file}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  paint();
  return { host: host as unknown as HTMLElement, root };
}

function liveRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-live-turn]")].map((row) =>
    row.dataset.liveTool ? `tool:${row.dataset.liveTurnItemId}:${row.dataset.liveToolStatus}` : `prose:${row.dataset.liveTurnItemId ?? "streaming"}`);
}

test("the first live turn shows tool calls interleaved with prose before the transcript has read anything", () => {
  const { host } = render();
  /* No transcript rows at all: this is the launch window, tail unread. */
  expect(host.querySelectorAll("[data-feed-kind]").length).toBe(0);
  /* Every tool call of the turn is on screen, in response order, with its outcome. */
  expect(liveRows(host)).toEqual([
    "prose:uuid-text-1",
    "tool:toolu_read:ok",
    "tool:toolu_bash:err",
    "prose:streaming",
  ]);
  const bash = host.querySelector<HTMLElement>('[data-live-turn-item-id="toolu_bash"]')!;
  expect(bash.textContent).toContain("gh issue view 1100");
  expect(bash.textContent).toContain("error");
  const read = host.querySelector<HTMLElement>('[data-live-turn-item-id="toolu_read"]')!;
  expect(read.textContent).toContain("AGENTS.md");
});

test("once the transcript echoes the calls, the live tool rows yield without duplicates and the order stays stable", () => {
  tailState.lines = TRANSCRIPT_ECHO;
  const { host } = render();
  /* The canonical rows now carry the calls (a folded run of two tool cards). */
  const canonicalToolIds = [...host.querySelectorAll<HTMLElement>("[data-feed-kind]")]
    .filter((row) => row.dataset.feedKind === "tool" || row.dataset.feedKind === "cmd-group");
  expect(canonicalToolIds.length).toBeGreaterThan(0);
  /* Nothing is shown twice: the prose and both tool rows were claimed, only the
     still-streaming prose remains in the live tail, below the transcript. */
  expect(liveRows(host)).toEqual(["prose:streaming"]);
  expect(host.querySelectorAll('[data-live-turn-item-id="toolu_read"]').length).toBe(0);
  expect(host.querySelectorAll('[data-live-turn-item-id="toolu_bash"]').length).toBe(0);
  const all = [...host.querySelectorAll<HTMLElement>("[data-feed-kind], [data-live-turn]")];
  expect(all.at(-1)?.hasAttribute("data-live-turn")).toBeTrue();
});

test("a live tool row newer than every transcript record still yields to the row that carries its call id", () => {
  /* The transcript has the Bash call but not its result yet: the live row
     (finished, newer than anything in the file) is claimed by identity, and the
     canonical card is what shows the call now — still running, in its view. */
  tailState.lines = TRANSCRIPT_ECHO.slice(0, -1);
  const { host } = render();
  expect(liveRows(host)).toEqual(["prose:streaming"]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-feed-kind]")];
  expect(rows.some((row) => row.textContent?.includes("gh issue view 1100"))).toBeTrue();
});
