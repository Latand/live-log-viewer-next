import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { directReviewFlows } from "@/components/flows/directReviewGroups";
import { buildBranchGroups } from "@/components/projectModel";

import { SchemeBoard } from "./SchemeBoard";

/*
 * DOM regressions for issue #531: on the rendered production board every
 * pipeline's colored region (the dashed halo) contains ALL of its conversation
 * surfaces — live panes, placeholder/completed stage shells, and attached review
 * decks — and two regions never intersect. The camera (62% lite zoom, Fit All)
 * must never perturb that world geometry.
 */

const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: over.path, project: "demo", title: over.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1000,
    size: 10, activity: "live", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, ...over,
  };
}

const stageRole = (access: "read-write" | "read-only") =>
  ({ roleId: null, engine: "codex" as const, model: null, effort: null, access, promptScaffold: null });

const stages = [
  { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: stageRole("read-write") },
  { id: "review", kind: "review-loop", prompt: "", next: "polish", onFail: { to: "build", maxRounds: 5 }, effectiveRole: stageRole("read-only") },
  { id: "polish", kind: "run", prompt: "", next: null, effectiveRole: stageRole("read-write") },
];

const pipe = (id: string, agentPath: string, attemptState = "running"): Pipeline =>
  ({
    id, task: `Region ${id}`, project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
    baseBranch: "main", baseRef: "a", lastPassedCommit: "a", stages,
    runs: [{ stageId: "build", attempts: [{ n: 1, state: attemptState, agentPath, flowId: null }] }],
    cursor: { stageId: "build", state: attemptState, input: null, activatedBy: null },
    state: attemptState === "needs_decision" ? "needs_decision" : "running",
    pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(0).toISOString(), closedAt: null,
  }) as unknown as Pipeline;

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

interface DomRect { x: number; y: number; w: number; h: number }

/* World rect of a halo region (positioned via left/top) or a board card
   (positioned via translate()). Both are world-space px, zoom-independent. */
function rectOf(element: HTMLElement): DomRect {
  const style = element.style;
  const translated = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style.transform ?? "");
  const x = translated ? Number.parseFloat(translated[1]!) : Number.parseFloat(style.left || "0");
  const y = translated ? Number.parseFloat(translated[2]!) : Number.parseFloat(style.top || "0");
  return { x, y, w: Number.parseFloat(style.width || "0"), h: Number.parseFloat(style.height || "0") };
}

const disjointWithGap = (a: DomRect, b: DomRect, gap: number): boolean =>
  a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;

const contains = (outer: DomRect, inner: DomRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

function haloRects(host: HTMLElement): Map<string, DomRect> {
  const rects = new Map<string, DomRect>();
  for (const header of host.querySelectorAll("[data-pipeline-group-header]")) {
    const region = (header as HTMLElement).closest('[data-scheme-group="pipeline"]') as HTMLElement | null;
    expect(region).toBeTruthy();
    rects.set(header.getAttribute("data-pipeline-group-header")!, rectOf(region!));
  }
  return rects;
}

function cardRect(host: HTMLElement, key: string): DomRect {
  const card = host.querySelector(`[data-scheme-node="${key}"]`) as HTMLElement | null;
  expect(card, `board card ${key} must render`).toBeTruthy();
  return rectOf(card!);
}

function expectSceneGeometry(host: HTMLElement, surfacesByPipeline: Map<string, string[]>) {
  const halos = haloRects(host);
  const ids = [...surfacesByPipeline.keys()];
  for (const id of ids) expect(halos.has(id), `pipeline ${id} must own a rendered colored region`).toBe(true);
  /* Region non-intersection: every pair keeps a stable visible corridor. */
  const entries = [...halos.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [aId, a] = entries[i]!;
      const [bId, b] = entries[j]!;
      expect(
        disjointWithGap(a, b, 24),
        `regions ${aId} ${JSON.stringify(a)} and ${bId} ${JSON.stringify(b)} intersect`,
      ).toBe(true);
    }
  }
  /* Complete child-bounds containment inside the owning region. */
  for (const [id, keys] of surfacesByPipeline) {
    const halo = halos.get(id)!;
    for (const key of keys) {
      const rect = cardRect(host, key);
      expect(
        contains(halo, rect),
        `surface ${key} ${JSON.stringify(rect)} escapes region ${id} ${JSON.stringify(halo)}`,
      ).toBe(true);
    }
  }
}

function mountScene(files: FileEntry[], pipelines: Pipeline[]): HTMLElement {
  const groups = buildBranchGroups(files, "demo");
  const reviewGroups = directReviewFlows({ files, flows: [], tasks: [] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard
      project="demo"
      groups={groups}
      manual={[]}
      files={files}
      flows={[]}
      reviewGroups={reviewGroups}
      pipelines={pipelines}
      surfacePipelines={pipelines}
      tasks={[]}
      drafts={[]}
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />,
  ));
  return host;
}

/* Production scene: one origin conversation spawned two pipeline builders. Both
   pipelines still have future stages, so each grows a placeholder row wider than
   its builder card. Builder A also carries a direct one-shot review deck. */
const origin = entry({ path: "/origin" });
const builderA = entry({ path: "/origin/a", parent: "/origin", kind: "subagent", conversationId: "c-a" });
const builderB = entry({ path: "/origin/b", parent: "/origin", kind: "subagent", conversationId: "c-b" });
const directReviewer = entry({
  path: "/origin/a/review-1",
  parent: "/origin/a",
  conversationId: "c-r1",
  durableLineage: {
    kind: "review",
    role: "reviewer",
    parentConversationId: "c-a",
    reviewsConversationId: "c-a",
    memberships: [],
  },
});

test("at 62% lite zoom every pipeline surface stays inside its region and neighboring regions keep their gap", async () => {
  /* The user parked the desktop camera at 62% — the lite far-zoom band where the
     production overlap was captured. World geometry must be identical to any
     other zoom: regions disjoint, every surface contained. */
  dom.sessionStorage.setItem("llvCam:demo", JSON.stringify({ x: 0, y: 0, z: 0.62 }));
  const files = [origin, builderA, builderB, directReviewer];
  const host = mountScene(files, [pipe("pa", "/origin/a"), pipe("pb", "/origin/b")]);
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  expect(world.style.transform).toContain("scale(0.62)");

  const directDeck = host.querySelector('[data-scheme-node^="deck::"]');
  expect(directDeck, "the direct one-shot review deck must render on the board").toBeTruthy();
  const surfaces = new Map<string, string[]>([
    ["pa", ["/origin/a", "slot::pa::review", "slot::pa::polish", directDeck!.getAttribute("data-scheme-node")!]],
    ["pb", ["/origin/b", "slot::pb::review", "slot::pb::polish"]],
  ]);
  expectSceneGeometry(host, surfaces);

  /* Fit All reframes the camera only — the world rects must not move. */
  const before = [...host.querySelectorAll("[data-scheme-node]")].map((card) => (card as HTMLElement).style.transform);
  const fit = [...host.querySelectorAll("button")].find((button) => button.title.startsWith("Fit all")) as HTMLButtonElement;
  expect(fit).toBeTruthy();
  flushSync(() => fit.click());
  await settle();
  const after = [...host.querySelectorAll("[data-scheme-node]")].map((card) => (card as HTMLElement).style.transform);
  expect(after).toEqual(before);
  expectSceneGeometry(host, surfaces);
});

test("host loss / delayed materialization: unscanned published transcripts keep two separated shell regions", async () => {
  /* Both builders published transcripts, then the runtime host died before the
     scanner surfaced them (the publish-to-place gap). Every stage rides a
     conversation-shaped shell; the two pipelines still own disjoint regions and
     every shell stays inside its own. */
  const files = [origin];
  const host = mountScene(files, [pipe("pa", "/lost/a"), pipe("pb", "/lost/b")]);
  await settle();

  expectSceneGeometry(host, new Map([
    ["pa", ["slot::pa::build", "slot::pa::review", "slot::pa::polish"]],
    ["pb", ["slot::pb::build", "slot::pb::review", "slot::pb::polish"]],
  ]));
  /* The origin conversation belongs to no pipeline: neither region may cover it. */
  const originRect = cardRect(host, "/origin");
  for (const halo of haloRects(host).values()) {
    expect(disjointWithGap(halo, originRect, 0), "a pipeline region covers a foreign conversation").toBe(true);
  }
});

test("parked and completed stage cards stay inside their regions beside a live neighbor", async () => {
  /* pa parked in needs_decision on its builder; pb kept running. The parked
     pipeline's placeholder row and the live neighbor's row keep both regions
     separated, and each pipeline's surfaces stay contained. */
  const files = [origin, builderA, builderB];
  const host = mountScene(files, [pipe("pa", "/origin/a", "needs_decision"), pipe("pb", "/origin/b")]);
  await settle();

  expectSceneGeometry(host, new Map([
    ["pa", ["/origin/a", "slot::pa::review", "slot::pa::polish"]],
    ["pb", ["/origin/b", "slot::pb::review", "slot::pb::polish"]],
  ]));
});
