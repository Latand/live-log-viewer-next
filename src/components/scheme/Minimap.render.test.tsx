import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Minimap, stackDotsFor, type StackDot } from "./Minimap";
import type { SchemeLayout, SchemeRect } from "./layout";
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

test("no worker stacks → no legend dots", () => {
  const html = renderToStaticMarkup(
    <Minimap layout={emptyLayout} world={world} stackDots={[]} cam={cam} vp={vp} onJump={() => {}} />,
  );
  expect(html).not.toContain("collapsed stack");
});
