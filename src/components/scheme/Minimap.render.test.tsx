import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { directReviewFlows, splitDirectReviewGroups } from "@/components/flows/directReviewGroups";
import { buildBranchGroups, type BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";

import { Minimap, stackDotsFor, type StackDot } from "./Minimap";
import { buildSchemeLayout, type SchemeLayout, type SchemeRect } from "./layout";
import type { WorkerStack } from "./workerCollapse";

const emptyLayout: SchemeLayout = {
  nodes: [], edges: [], stacks: [], decks: [], loops: [], groups: [], links: [], drafts: [], slots: [],
  byPath: new Map(), width: 1000, height: 1000,
};
const world: SchemeRect = { x: 0, y: 0, w: 1000, h: 1000 };
const cam = { x: 0, y: 0, z: 1 };
const vp = { w: 800, h: 600 };

test("collapsed worker stacks render one minimap dot per origin (#136 finding 2)", () => {
  const stackDots: StackDot[] = [
    { key: "wstack::flow::f1", color: "var(--color-accent)" },
    { key: "wstack::pipeline::p1", color: "var(--color-accent)" },
    { key: "wstack::origin::/root", color: "var(--color-muted)" },
  ];
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} stackDots={stackDots} cam={cam} vp={vp} onJump={() => {}} />,
  );
  /* One dot per stack, tinted by origin kind (orchestration accent / spawner gray). */
  const dots = html.match(/background-color:\s*var\(--color-accent\)/g) ?? [];
  expect(dots.length).toBe(2);
  expect(html).toContain("var(--color-muted)");
  /* The legend is titled with the stack count. */
  expect(html).toContain("3 collapsed stacks");
});

test("every collapsed stack gets a dot — none hidden behind a counter past 14 (finding 3)", () => {
  const stackDots: StackDot[] = Array.from({ length: 20 }, (_, i) => ({ key: "s" + i, color: i % 2 ? "var(--color-accent)" : "var(--color-muted)" }));
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} stackDots={stackDots} cam={cam} vp={vp} onJump={() => {}} />,
  );
  /* All 20 origins render a dot; no "+N" counter swallows any stack identity. */
  const dots = html.match(/h-1\.5 w-1\.5/g) ?? [];
  expect(dots.length).toBe(20);
  expect(html).not.toContain("+6");
  expect(html).toContain("20 collapsed stacks");
});

test("stackDotsFor maps each worker stack to one origin-toned dot (#136)", () => {
  const stacks = [
    { key: "wstack::flow::f1", kind: "flow", id: "f1", items: [] },
    { key: "wstack::pipeline::p1", kind: "pipeline", id: "p1", items: [] },
    { key: "wstack::origin::/root", kind: "origin", id: "/root", items: [] },
    { key: "wstack::worktree::wt", kind: "worktree", id: "wt", items: [] },
  ] as unknown as WorkerStack[];
  const dots = stackDotsFor(stacks);
  expect(dots).toHaveLength(4);
  expect(dots.map((d) => d.color)).toEqual([
    "var(--color-accent)",
    "var(--color-accent)",
    "var(--color-muted)",
    "var(--color-strong)",
  ]);
  expect(dots.map((d) => d.key)).toEqual(stacks.map((s) => s.key));
});

test("a folded engine child leaves layout.nodes so the minimap drops its rect (#142 regression)", () => {
  const base = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
    root: "claude-projects", name: over.path, project: "demo", title: over.path, engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: 1000, size: 10, activity: "idle", proc: null,
    pid: null, model: null, pendingQuestion: null, waitingInput: null, ...over,
  });
  const parent = base({ path: "/root", activity: "live" });
  const folded = base({ path: "/root/quiet", parent: "/root", kind: "subagent", activity: "idle", spawnOrigin: "engine" });
  const files = [parent, folded];

  const withoutFold = buildSchemeLayout(buildBranchGroups(files, "demo"), [], files);
  expect(withoutFold.nodes.map((node) => node.file.path)).toContain("/root/quiet");

  const groups = buildBranchGroups(files, "demo", { enginePlacement: { foldedEnginePaths: new Set(["/root/quiet"]) } });
  const layout = buildSchemeLayout(groups, [], files);
  const nodePaths = layout.nodes.map((node) => node.file.path);
  expect(nodePaths).toContain("/root");
  expect(nodePaths).not.toContain("/root/quiet");

  /* The minimap draws one rect per layout node, so the folded child yields one
     fewer node rect — the parent card alone represents the tray on the map. */
  const html = renderToStaticMarkup(
    <Minimap layout={layout} world={world} stackDots={[]} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect(html).toBeTruthy();
});

test("no worker stacks → no legend dots", () => {
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} stackDots={[]} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect(html).not.toContain("collapsed stack");
});

test("the minimap draws one compact outline per pipeline group (#353)", () => {
  const layout: SchemeLayout = {
    ...emptyLayout,
    groups: [
      { key: "group::pipeline::p1", kind: "pipeline", id: "p1", hue: 210, members: [], pipeline: { id: "p1" } as never, label: "Pipeline", x: 100, y: 120, w: 692, h: 150 },
    ],
  };
  const html = renderToStaticMarkup(
    <Minimap layout={layout} world={world} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect((html.match(/data-minimap-pipeline=/g) ?? []).length).toBe(1);
  expect(html).toContain("<title>Pipeline</title>");
});

test("the minimap keeps every desktop pipeline group visible past 14", () => {
  const pipelineGroups = Array.from({ length: 15 }, (_, index) => ({
    pipeline: { id: `pipeline-${index}`, task: `Pipeline ${index}`, state: index === 0 ? "draft" : "running" } as never,
    rect: { x: 100 + index * 20, y: 120 + index * 16, w: 360, h: 76 },
  }));
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} pipelineGroups={pipelineGroups} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect((html.match(/data-minimap-pipeline=/g) ?? []).length).toBe(15);
  expect(html).toContain("stroke-dasharray=");
});

test("the minimap draws the current-work frame separately from the viewport", () => {
  const currentWork = { x: 100, y: 120, w: 600, h: 780 };
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} currentWork={currentWork} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect((html.match(/data-minimap-current-work=/g) ?? []).length).toBe(1);
  expect((html.match(/stroke="var\(--color-accent\)"/g) ?? []).length).toBe(1);
});

test("an expanded task dot follows the full rendered card height", () => {
  const item = {
    id: "expanded-task", project: "demo", status: "assigned", placement: "pinned",
    text: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    pos: { x: 100, y: 120 }, assignments: [],
    createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
  } as never;
  const compact = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} tasks={[item]} textExpandedIds={new Set()} cam={cam} vp={vp} onJump={() => {}} />,
  );
  const full = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} tasks={[item]} textExpandedIds={new Set(["expanded-task"])} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect(full).not.toBe(compact);
  const compactCy = Number(compact.match(/cy="([\d.]+)"/)?.[1]);
  const fullCy = Number(full.match(/cy="([\d.]+)"/)?.[1]);
  expect(fullCy).toBeGreaterThan(compactCy);
});

test("a direct review group's deck shows on the minimap like any managed deck (#325)", () => {
  const builder: FileEntry = {
    root: "claude-projects", name: "/builder", project: "demo", title: "Builder", engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 10, activity: "live",
    proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    path: "/builder", conversationId: "conversation-builder",
  };
  const reviewer: FileEntry = {
    ...builder,
    path: "/reviewer-1", name: "/reviewer-1", title: "Reviewer", parent: "/builder",
    conversationId: "conversation-r1", mtime: 1_000, activity: "idle",
    review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T02:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  };
  const projected = directReviewFlows({ files: [builder, reviewer], flows: [], tasks: [] });
  expect(projected).toHaveLength(1);
  const group: BranchGroup = {
    key: builder.path,
    columns: [{ file: builder, tasks: [] }],
    returnable: [],
    finished: [],
    smt: builder.mtime,
    orphanTask: false,
  };
  const layout = buildSchemeLayout([group], [], [builder, reviewer], projected, []);
  expect(layout.decks).toHaveLength(1);

  const html = renderToStaticMarkup(
    <Minimap layout={layout} world={{ x: 0, y: 0, w: layout.width, h: layout.height }} stackDots={[]} cam={cam} vp={vp} onJump={() => {}} />,
  );
  /* One accent deck rect beside the builder node — same read as a managed loop. */
  expect((html.match(/fill="var\(--color-accent\)"/g) ?? []).length).toBeGreaterThanOrEqual(1);
});

test("a terminal group keeps its deck slot beside a placed anchor but never forces a quiet anchor onto the board (#289+#325)", () => {
  const quietBuilder: FileEntry = {
    root: "claude-projects", name: "/quiet", project: "demo", title: "Quiet builder", engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 10, activity: "idle",
    proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    path: "/quiet", conversationId: "conversation-quiet",
  };
  const reviewer: FileEntry = {
    ...quietBuilder,
    path: "/reviewer-done", name: "/reviewer-done", title: "Reviewer", parent: "/quiet",
    conversationId: "conversation-rdone", mtime: 1_000,
    review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T02:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-quiet", reviewsConversationId: "conversation-quiet", memberships: [] },
  };
  const projected = directReviewFlows({ files: [quietBuilder, reviewer], flows: [], tasks: [] });
  const { active, history } = splitDirectReviewGroups(projected);
  expect(active).toHaveLength(0);
  expect(history).toHaveLength(1);
  const group: BranchGroup = {
    key: quietBuilder.path,
    columns: [{ file: quietBuilder, tasks: [] }],
    returnable: [],
    finished: [],
    smt: quietBuilder.mtime,
    orphanTask: false,
  };
  /* Since #289 + #325 the dashboard hands the layout EVERY direct group: with
     the reviewed anchor placed for its own reasons, the terminal group keeps a
     deck slot (rendered as the collapsed verdict chip) — board and minimap
     stay in agreement about the group's presence. */
  const placed = buildSchemeLayout([group], [], [quietBuilder, reviewer], projected, []);
  expect(placed.decks).toHaveLength(1);

  /* With NO placed anchor, the terminal group never forces the quiet
     conversation onto the board: no deck, no minimap rect — the rounds park
     as a per-group review-history stack in the legend instead. */
  const layout = buildSchemeLayout([], [], [quietBuilder, reviewer], projected, []);
  expect(layout.decks).toHaveLength(0);
  const html = renderToStaticMarkup(
    <Minimap
      layout={layout}
      world={{ x: 0, y: 0, w: layout.width, h: layout.height }}
      tasks={[{
        id: "full-task", project: "demo", status: "assigned", text: "active card", placement: "pinned",
        pos: { x: 740, y: 120 }, assignments: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
      } as never]}
      stackDots={stackDotsFor([{ key: "wstack::flow::direct-review::task::t1", kind: "flow", id: "direct-review::task::t1", items: [reviewer] }])}
      cam={cam}
      vp={vp}
      onJump={() => {}}
    />,
  );
  /* No deck rect; exactly ONE task status dot (the full card) and one stack
     legend dot for the parked review history. */
  expect(html).not.toContain('fill="var(--color-accent)" opacity="0.3"');
  /* The SVG carries no quiet-branch stacks here, so every circle is a task
     status dot — exactly one, for the one full card. */
  const taskDots = html.match(/<circle/g) ?? [];
  expect(taskDots.length).toBe(1);
  expect(html).toContain("1 collapsed stack");
});
