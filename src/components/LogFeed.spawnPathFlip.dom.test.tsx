import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { appendRuntimeLiveTurnDelta, projectRuntimeLiveTurnItem, type RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { emptyStore, type RuntimeSession } from "@/components/runtime/runtimeModel";
import type { LogSubscriber } from "@/hooks/logBus";

/**
 * Issue #1100, layer (b) evidence: a freshly spawned conversation's card is
 * `spawn:<launchId>` until the scanner carries its transcript, then the SAME
 * pane receives the artifact path. This renders the real `LogFeed` with the
 * REAL `useLogTail` over a fake log bus and proves that the tail follows the
 * card's path flip on its own: while the path is the placeholder nothing is
 * read (the bus answers the way the server does), the live overlay carries the
 * tool rows; once the path flips, the tail subscribes to the artifact, the
 * canonical rows render, and the live tool rows retire exactly once.
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

const CONVERSATION_ID = "conversation_spawn_flip_1100";
const LAUNCH_PATH = "spawn:launch-flip-1100";
const ARTIFACT_PATH = "/fixtures/claude/projects/-repo/session-spawn-flip.jsonl";
const AT = (second: number) => `2026-08-23T09:00:${String(second).padStart(2, "0")}.000Z`;

function firstTurn(): RuntimeLiveTurn {
  let live = projectRuntimeLiveTurnItem(null, "turn-flip", {
    type: "assistant", uuid: "uuid-flip-text",
    message: { role: "assistant", content: [{ type: "text", text: "Checking the worktree." }] },
  }, "completed", AT(1));
  live = projectRuntimeLiveTurnItem(live, "turn-flip", {
    type: "assistant", uuid: "uuid-flip-tool",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_flip_status", name: "Bash", input: { command: "git status --short" } }] },
  }, "completed", AT(2));
  live = projectRuntimeLiveTurnItem(live, "turn-flip", {
    type: "user", uuid: "uuid-flip-result",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_flip_status" }] },
  }, "completed", AT(3));
  live = appendRuntimeLiveTurnDelta(live, "turn-flip", "Clean tree, moving on", AT(4));
  return live!;
}

const TRANSCRIPT = [
  { type: "user", uuid: "uuid-flip-prompt", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "Fix issue 1100" }] } },
  { type: "assistant", uuid: "uuid-flip-text", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "Checking the worktree." }] } },
  { type: "assistant", uuid: "uuid-flip-tool", timestamp: AT(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_flip_status", name: "Bash", input: { command: "git status --short" } }] } },
  { type: "user", uuid: "uuid-flip-result", timestamp: AT(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_flip_status", content: "" }] } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

const session: RuntimeSession = {
  conversationId: CONVERSATION_ID,
  sessionKey: { engine: "claude", sessionId: "session-spawn-flip" },
  hostKind: "claude-broker",
  host: "hosted",
  turn: "running",
  provenance: "structured",
  revision: 3,
  attentionIds: [],
  recentReceipts: [],
  accountId: null,
  parentConversationId: null,
  flowId: null,
  workflowId: null,
  cwd: "/repo",
  artifactPath: ARTIFACT_PATH,
  capabilities: { steer: true, structuredAttention: true },
  activeTurnId: "turn-flip",
  liveTurn: firstTurn(),
};

/* The log bus as the server behaves: a placeholder path is not a readable
   artifact, the transcript path serves its bytes. Every subscription is logged
   so the test can prove which path the tail actually read. */
const bus = { events: [] as string[] };
const actualLogBus = await import("@/hooks/logBus");
mock.module("@/hooks/logBus", () => ({
  ...actualLogBus,
  subscribeLog: (sub: LogSubscriber) => {
    bus.events.push(`subscribe:${sub.path}`);
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      if (sub.path === ARTIFACT_PATH) {
        const size = new TextEncoder().encode(TRANSCRIPT).length;
        sub.onChunk({ offset: size, start: 0, size, data: sub.getOffset() >= size ? "" : TRANSCRIPT });
      } else {
        sub.onChunk({ error: "path not allowed" });
      }
    });
    return () => {
      alive = false;
      bus.events.push(`unsubscribe:${sub.path}`);
    };
  },
}));

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  /* Resolved by conversation identity, as the real hook does during launch. */
  useRuntimeSessionForConversation: (conversationId: string | null) => (conversationId === CONVERSATION_ID
    ? { session, uiState: "working", attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true }
    : null),
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");
const { resetLogTailCacheForTests } = await import("@/hooks/useLogTail");
const { resetCanonicalAssistantClaimsForTests } = await import("./conversation/liveTurnHandoff");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
  dom.sessionStorage.clear();
  resetCanonicalAssistantClaimsForTests();
  resetLogTailCacheForTests();
  bus.events = [];
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  mock.module("@/hooks/logBus", () => actualLogBus);
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

const base = {
  root: "claude-projects",
  project: "repo",
  title: "Fix issue 1100",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(AT(4)) / 1000,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: CONVERSATION_ID,
} as Partial<FileEntry>;

/* The launch placeholder the board projects before the scanner carries the
   transcript, then the scanned transcript entry of the same conversation. */
const launchCard = { ...base, path: LAUNCH_PATH, name: LAUNCH_PATH, size: 0, spawnOrigin: "viewer" } as FileEntry;
const transcriptCard = { ...base, path: ARTIFACT_PATH, name: "session-spawn-flip.jsonl", size: 1 } as FileEntry;

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(): { host: HTMLElement; paint: (file: FileEntry) => void } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const paint = (file: FileEntry) => flushSync(() => {
    root.render(
      <LogFeed
        file={file}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused={false}
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  return { host: host as unknown as HTMLElement, paint };
}

function liveRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-live-turn]")].map((row) =>
    row.dataset.liveTool ? `tool:${row.dataset.liveTurnItemId}:${row.dataset.liveToolStatus}` : `prose:${row.dataset.liveTurnItemId ?? "streaming"}`);
}

function canonicalRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-feed-kind]")].map((row) => row.dataset.feedKind ?? "");
}

test("the tail follows the card's spawn → artifact path flip: canonical rows land, live tool rows retire once, no duplicates", async () => {
  const { host, paint } = mount();
  paint(launchCard);
  await settle();
  /* Launch window: the pane asked the bus for the placeholder (unreadable, as
     on the server), read nothing, and shows the turn from the host stream —
     tool call included. */
  expect(bus.events).toEqual([`subscribe:${LAUNCH_PATH}`]);
  expect(canonicalRows(host)).toEqual([]);
  expect(liveRows(host)).toEqual(["prose:uuid-flip-text", "tool:toolu_flip_status:ok", "prose:streaming"]);

  /* The scanner carried the transcript: the same pane now receives the
     artifact path. The tail re-subscribes on its own and reads the file. */
  paint(transcriptCard);
  await settle();
  expect(bus.events).toEqual([
    `subscribe:${LAUNCH_PATH}`,
    `unsubscribe:${LAUNCH_PATH}`,
    `subscribe:${ARTIFACT_PATH}`,
  ]);
  const canonical = canonicalRows(host);
  expect(canonical.length).toBeGreaterThan(0);
  expect(canonical.some((kind) => kind === "tool" || kind === "cmd-group")).toBeTrue();
  /* The prose and the tool call are claimed by their canonical rows; only the
     still-streaming prose remains, below the transcript. */
  expect(liveRows(host)).toEqual(["prose:streaming"]);
  expect(host.querySelectorAll('[data-live-turn-item-id="toolu_flip_status"]').length).toBe(0);
  const all = [...host.querySelectorAll<HTMLElement>("[data-feed-kind], [data-live-turn]")];
  expect(all.at(-1)?.hasAttribute("data-live-turn")).toBeTrue();
  /* Exactly one rendering of the call across both layers. */
  const callRows = all.filter((row) => row.textContent?.includes("git status --short"));
  expect(callRows.length).toBe(1);
});
