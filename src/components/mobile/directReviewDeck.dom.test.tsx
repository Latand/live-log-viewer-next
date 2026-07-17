import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";

/*
 * Issue #325 — 390px coverage: a direct one-shot review group must surface on
 * the phone as the SAME round deck a managed flow gets: a deck chip on the
 * switch strip, verdict-bearing history spines (accessible buttons), and a
 * pullable front card. This mounts the real MobileFocusView with a projected
 * direct-review group.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");
const { directReviewFlows } = await import("@/components/flows/directReviewGroups");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); dom.sessionStorage.clear(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

test("a direct review group rides the phone strip as a round deck with accessible verdict history (#325)", async () => {
  const builder = entry({ path: "/builder", title: "Builder session", conversationId: "conversation-builder", activity: "live", mtime: 9_000 });
  const done = entry({
    path: "/reviewer-1",
    parent: "/builder",
    conversationId: "conversation-r1",
    mtime: 1_000,
    review: { verdict: "REQUEST_CHANGES", findingsCount: 2, observedAt: "2026-07-10T02:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const live = entry({
    path: "/reviewer-2",
    parent: "/builder",
    conversationId: "conversation-r2",
    mtime: 2_000,
    activity: "live",
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const files = [builder, done, live];
  const reviewGroups = directReviewFlows({ files, flows: [], tasks: [] });
  expect(reviewGroups).toHaveLength(1);
  const group: BranchGroup = {
    key: builder.path,
    columns: [{ file: builder, tasks: [] }],
    returnable: [],
    finished: [],
    smt: builder.mtime,
    orphanTask: false,
  };

  roots.push(
    mount(
      <MobileFocusView
        project="demo"
        groups={[group]}
        manual={[]}
        files={files}
        flows={[]}
        reviewGroups={reviewGroups}
        pipelines={[]}
        surfacePipelines={[]}
        workerStacks={[]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ),
  );
  await settle();

  /* The switch strip carries a deck chip for the direct group. */
  const chips = [...dom.document.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const deckChip = chips.find((chip) => chip.textContent?.trim().startsWith("R"));
  expect(deckChip).toBeDefined();

  flushSync(() => deckChip!.click());
  await settle();

  /* The terminal round parks as a compact history spine: a real button (so the
     keyboard and screen readers reach it) titled with its verdict. */
  const spine = dom.document.querySelector('button[title="Round 1 · ✖ REQUEST_CHANGES"]') as HTMLButtonElement | null;
  expect(spine).not.toBeNull();
  expect(spine!.textContent).toContain("REQUEST_CHANGES");

  /* Pulling the spine opens that round's transcript card in front. */
  flushSync(() => spine!.click());
  await settle();
  const banner = [...dom.document.querySelectorAll("div")].find((el) => el.textContent?.trim().startsWith("Round 1 · ✖ REQUEST_CHANGES"));
  expect(banner).toBeDefined();
});
