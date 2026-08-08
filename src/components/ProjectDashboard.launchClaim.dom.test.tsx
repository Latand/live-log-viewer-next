/**
 * A failed delivery must never hide a transcript that actually exists.
 *
 * A structured launch can fail its initial delivery (e.g. cancelled while the
 * owning account migration stalled) while the agent still materializes a real
 * conversation. When that terminal launch record rides on the SAME path that
 * identifies the scanned transcript, the launch-history shelf used to claim
 * the path off the scene: `sceneFiles` dropped the conversation, `claimedPaths`
 * fenced it from the tray, and the archive fallback and worker stacks inherited
 * the same hole — the operator's finished conversation vanished from the map,
 * with only a "Launch history · 1" failure row left.
 *
 * This mounts the REAL ProjectDashboard with that exact shape and proves the
 * conversation keeps its board card while the shelf still reports the failed
 * delivery. A pathless `spawn:<launchId>` receipt keeps today's behavior: it is
 * shelved and claimed, because it has no transcript to hide.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({ items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {} }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

const OVERRIDES: Record<string, unknown> = {
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
  matchMedia: (query: string) => ({
    matches: false, media: String(query), onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});
afterAll(async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
let projectCounter = 0;
let PROJECT = "launch-claim-0";
beforeEach(() => {
  roots = [];
  projectCounter += 1;
  PROJECT = `launch-claim-${projectCounter}`;
  dom.document.body.replaceChildren();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return predicate();
};

/* One hour old: past the 15-minute launch-history horizon, inside the ~48 h
   automatic-placement age horizon — the exact incident window. */
const AGE_SECONDS = 3_600;

const failedDelivery = (launchId: string): StructuredSpawnCardState => ({
  launchId,
  clientAttemptId: null,
  accountId: null,
  conversationId: `conversation-${launchId}`,
  state: "failed",
  initialMessage: "failed",
  retrySafe: true,
  error: "delivery cancelled because its owning account migration made no progress",
});

function conversationWithFailedLaunchRecord(path: string): FileEntry {
  return {
    path,
    root: "claude-projects",
    name: "conversation-claim.jsonl",
    project: PROJECT,
    title: "Finished conversation",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: Date.now() / 1000 - AGE_SECONDS,
    size: 2048,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation-launch-claim-1",
    spawn: failedDelivery("launch-claim-1"),
  };
}

function pathlessReceipt(launchId: string): FileEntry {
  return {
    ...conversationWithFailedLaunchRecord(`spawn:${launchId}`),
    name: `spawn:${launchId}`,
    title: "Claude",
    size: 0,
    conversationId: `conversation-${launchId}`,
    spawn: failedDelivery(launchId),
  };
}

function mount(files: FileEntry[]): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() =>
    root.render(
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={[]}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
      />,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}

test("a failed-delivery launch record on a scanned transcript path never hides the conversation", async () => {
  const path = "/claude-projects/repo-fixture/conversation-claim.jsonl";
  const host = mount([conversationWithFailedLaunchRecord(path)]);

  /* The conversation is real board content: it must keep its scheme card. */
  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${path}"]`) !== null)).toBe(true);

  /* The failed delivery stays visible: the shelf still lists the record. */
  await settle();
  expect(host.querySelector('[data-testid="launch-history"]')).not.toBeNull();
});

test("a pathless terminal receipt is still shelved and never becomes a board card", async () => {
  const host = mount([pathlessReceipt("launch-claim-2")]);
  await settle();

  expect(host.querySelector('[data-scheme-node="spawn:launch-claim-2"]')).toBeNull();
  expect(host.querySelector('[data-testid="launch-history"]')).not.toBeNull();
});
