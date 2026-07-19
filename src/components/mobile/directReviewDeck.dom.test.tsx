import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

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

test("a terminal direct group rides the phone as a tappable collapsed verdict chip that expands to every round (#289+#325)", async () => {
  const builder = entry({ path: "/builder", title: "Builder session", conversationId: "conversation-builder", activity: "live", mtime: 9_000 });
  const r1 = entry({
    path: "/reviewer-1",
    parent: "/builder",
    conversationId: "conversation-r1",
    mtime: 1_000,
    review: { verdict: "REQUEST_CHANGES", findingsCount: 2, observedAt: "2026-07-10T02:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const r2 = entry({
    path: "/reviewer-2",
    parent: "/builder",
    conversationId: "conversation-r2",
    mtime: 2_000,
    review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T03:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const files = [builder, r1, r2];
  const reviewGroups = directReviewFlows({ files, flows: [], tasks: [] });
  expect(reviewGroups).toHaveLength(1);
  expect(reviewGroups[0]!.state).toBe("done_comment");
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

  /* The terminal group still rides the switch strip (board presence). */
  const chips = [...dom.document.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const deckChip = chips.find((chip) => chip.textContent?.trim().startsWith("R"));
  expect(deckChip).toBeDefined();
  flushSync(() => deckChip!.click());
  await settle();

  /* Collapsed by default after the final verdict: one chip carrying the
     rounds count and the verdict, tall enough for a 390px thumb (h-12 =
     48px ≥ the 44px target). */
  const collapsed = dom.document.querySelector("[data-review-deck-collapsed]") as HTMLButtonElement | null;
  expect(collapsed).not.toBeNull();
  expect(collapsed!.className).toContain("h-12");
  expect(collapsed!.textContent).toContain("2 rounds");
  expect(collapsed!.textContent).toContain("APPROVE");
  expect(collapsed!.getAttribute("aria-expanded")).toBe("false");

  /* Tap → the full deck: front card banner plus the prior round spine — every
     round reachable, no nested scroll container. */
  flushSync(() => collapsed!.click());
  await settle();
  expect(dom.document.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  const spine = dom.document.querySelector('button[title="Round 1 · ✖ REQUEST_CHANGES"]');
  expect(spine).not.toBeNull();
  const banner = [...dom.document.querySelectorAll("div")].find((el) => el.textContent?.trim().startsWith("Round 2 · ✓ APPROVE"));
  expect(banner).toBeDefined();
});

test("an active pipeline-owned review keeps prior same-round bindings in the compact mobile rail (#353)", async () => {
  const builder = entry({ path: "/pipeline-builder", title: "Pipeline builder", conversationId: "conversation-builder", activity: "live", mtime: 9_000 });
  const membership = (slot: string) => ({
    kind: "flow" as const,
    containerId: "pipeline-flow",
    role: "reviewer",
    slot,
    stageId: null,
    stageOrder: null,
    round: 1,
    parentConversationId: builder.conversationId!,
  });
  const priorReviewer = entry({
    path: "/pipeline-reviewer-1",
    parent: builder.path,
    conversationId: "conversation-reviewer-1",
    mtime: 9_500,
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: builder.conversationId!, reviewsConversationId: builder.conversationId!, memberships: [membership("reviewer:1:binding-a")] },
  });
  const reviewer = entry({
    path: "/pipeline-reviewer-2",
    parent: builder.path,
    conversationId: "conversation-reviewer-2",
    activity: "live",
    mtime: 10_000,
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: builder.conversationId!, reviewsConversationId: builder.conversationId!, memberships: [membership("reviewer:1:binding-b")] },
  });
  const flow = {
    id: "pipeline-flow",
    implementerPath: builder.path,
    rounds: [{ n: 1, reviewerPath: reviewer.path, reviewerConversationId: reviewer.conversationId }],
    state: "reviewing",
  } as unknown as Flow;
  const pipeline = {
    id: "pipeline-1", task: "Compact mobile review", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ],
    runs: [
      { stageId: "build", attempts: [{ n: 1, state: "passed", agentPath: builder.path, flowId: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }] },
      { stageId: "review", attempts: [{ n: 1, state: "reviewing", agentPath: reviewer.path, flowId: flow.id, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } }] },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null }, state: "reviewing", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2026-07-18T00:00:00Z", closedAt: null,
  } as unknown as Pipeline;
  const group: BranchGroup = { key: builder.path, columns: [{ file: builder, tasks: [] }], returnable: [], finished: [], smt: builder.mtime, orphanTask: false };
  const selected: { path: string | null } = { path: null };

  roots.push(mount(
    <MobileFocusView
      project="demo" groups={[group]} manual={[]} files={[builder, priorReviewer, reviewer]} flows={[flow]} pipelines={[pipeline]}
      surfacePipelines={[pipeline]} workerStacks={[]} tasks={[]} drafts={[]} loaded focus={null}
      onSelect={(file) => { selected.path = file.path; }} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
    />,
  ));
  await settle();

  expect(dom.document.querySelector("[data-review-deck-collapse]")).toBeNull();
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-dock"]')).not.toBeNull();
  const focusRow = dom.document.querySelector('[data-testid="mobile-pipeline-focus-row"]');
  expect(focusRow).not.toBeNull();
  const focusLabels = [...focusRow!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  expect(focusLabels.some((label) => label?.startsWith("Previous stage"))).toBe(false);
  expect(focusLabels.some((label) => /^Next stage .+, state .+$/.test(label ?? ""))).toBe(true);
  const deckChip = [...dom.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "R Flow");
  expect(deckChip).toBeUndefined();

  const dock = dom.document.querySelector('[data-testid="mobile-pipeline-dock"]');
  /* With a conversation focused the dock mounts collapsed (#156); the full rail
     — and its verdict/round history — stays reachable behind the disclosure. */
  const summary = dock!.querySelector('[data-testid="mobile-pipeline-dock-summary"]') as unknown as HTMLButtonElement;
  flushSync(() => summary.click());
  await settle();
  const history = ([...dock!.querySelectorAll("button")] as unknown as HTMLButtonElement[])
    .filter((button) => button.getAttribute("aria-label")?.startsWith("Open verdict for stage"))
    .at(-1);
  expect(history).toBeDefined();
  expect(history!.className).toContain("min-w-11");
  flushSync(() => (history as HTMLButtonElement).click());
  await settle();

  const priorTranscript = dom.document.querySelector('button[aria-label="Open review transcript 1"]') as unknown as HTMLButtonElement | null;
  expect(priorTranscript).not.toBeNull();
  expect(priorTranscript!.className).toContain("min-h-11");
  expect(priorTranscript!.className).toContain("min-w-11");
  flushSync(() => priorTranscript!.click());
  expect(selected.path).toBe(priorReviewer.path);
});

test("an active retry opens prior transcript history from the mobile focus row (#353)", async () => {
  const prior = entry({ path: "/pipeline-retry-1", title: "Pipeline retry 1", mtime: 9_000 });
  const current = entry({ path: "/pipeline-retry-2", title: "Pipeline retry 2", activity: "live", mtime: 10_000 });
  const pipeline = {
    id: "pipeline-retry", task: "Retry on mobile", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [{ id: "build", kind: "run", prompt: "", next: null }],
    runs: [{ stageId: "build", attempts: [
      { n: 1, state: "failed", agentPath: prior.path, error: "failed", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
      { n: 2, state: "running", agentPath: current.path, error: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    ] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2026-07-18T00:00:00Z", closedAt: null,
  } as unknown as Pipeline;
  const group: BranchGroup = { key: current.path, columns: [{ file: current, tasks: [] }], returnable: [], finished: [], smt: current.mtime, orphanTask: false };
  const selected: { path: string | null } = { path: null };

  roots.push(mount(
    <MobileFocusView
      project="demo" groups={[group]} manual={[]} files={[prior, current]} flows={[]} pipelines={[pipeline]}
      surfacePipelines={[pipeline]} workerStacks={[]} tasks={[]} drafts={[]} loaded focus={null}
      onSelect={(file) => { selected.path = file.path; }} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
    />,
  ));
  await settle();

  const focusRow = dom.document.querySelector('[data-testid="mobile-pipeline-focus-row"]');
  const history = focusRow?.querySelector('button[aria-haspopup="dialog"]') as unknown as HTMLButtonElement | null;
  expect(history?.disabled).toBe(false);
  flushSync(() => history!.click());
  await settle();

  const priorTranscript = dom.document.querySelector('button[aria-label="Open transcript for attempt 1"]') as unknown as HTMLButtonElement | null;
  expect(priorTranscript).not.toBeNull();
  expect(priorTranscript!.className).toContain("min-h-11");
  expect(priorTranscript!.className).toContain("min-w-11");
  flushSync(() => priorTranscript!.click());
  expect(selected.path).toBe(prior.path);
});
