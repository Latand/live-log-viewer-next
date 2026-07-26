import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { focusTargetAnchorKeys } from "@/lib/attention/targets";
import type { FileEntry } from "@/lib/types";

import { COARSE_TARGET_HEIGHT, OverviewBoard } from "./OverviewBoard";

/*
 * Issue #699 — a near miss on an overview conversation row must never be
 * anything but a no-op.
 *
 * The card used to be a <button> with conversation rows nested inside it as
 * role="link" spans. Interactive content inside interactive content, and the
 * 4px gap between two ~20px rows belonged to the card — so a tap that missed a
 * row by a hair opened the whole project. This file pins the structure that
 * makes that impossible.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
let coarsePointer = true;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  matchMedia: (query: string) => ({
    matches: /pointer: coarse/.test(String(query)) ? coarsePointer : false,
    media: String(query),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  /* The pointer hook reads `window.matchMedia`, which resolves to the happy-dom
     window rather than the global override, so the query has to be answered
     there too. */
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; coarsePointer = true; });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "demo-project",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

const liveFiles = [
  fileEntry({ path: "/sessions/one.jsonl", title: "Reviewer", activity: "live" }),
  fileEntry({ path: "/sessions/two.jsonl", title: "Builder", activity: "live" }),
];

interface Taps {
  projects: string[];
  files: string[];
}

function mount(files: FileEntry[]): Taps {
  const taps: Taps = { projects: [], files: [] };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <OverviewBoard
      files={files}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={2_000}
      onSelectProject={(project) => taps.projects.push(project)}
      onSelectFile={(file) => taps.files.push(file.path)}
    />,
  ));
  roots.push(root);
  return taps;
}

const query = (selector: string) => [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[];

test("no conversation target is nested inside another interactive element", () => {
  mount(liveFiles);

  const interactive = query("button, [role='link'], [role='button'], a");
  expect(interactive.length).toBeGreaterThan(0);
  for (const element of interactive) {
    const ancestor = (element.parentElement as HTMLElement | null)?.closest("button, [role='link'], [role='button'], a");
    expect(ancestor).toBeNull();
  }
});

test("the card itself is inert, so every gap around a row is dead space", () => {
  const taps = mount(liveFiles);

  const card = query("[data-testid='overview-card']")[0]!;
  expect(card.tagName.toLowerCase()).toBe("div");
  expect(card.getAttribute("role")).toBeNull();

  /* A tap that lands in the card but on no target — the gap between two rows,
     the card's own padding — reaches nothing at all. */
  card.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  const rows = query("[data-testid='overview-rows']")[0]!;
  rows.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

  expect(taps).toEqual({ projects: [], files: [] });
});

test("each conversation row opens exactly its own conversation", () => {
  const taps = mount(liveFiles);

  const rows = query("[data-testid='overview-conversation']");
  expect(rows).toHaveLength(2);

  rows[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(taps).toEqual({ projects: [], files: ["/sessions/one.jsonl"] });

  rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  /* Never the neighbour, and never the parent project on the way up. */
  expect(taps).toEqual({ projects: [], files: ["/sessions/one.jsonl", "/sessions/two.jsonl"] });
});

test("project navigation survives as its own separate target", () => {
  const taps = mount(liveFiles);

  const project = query("[data-testid='overview-project']")[0]!;
  project.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

  expect(taps).toEqual({ projects: ["demo-project"], files: [] });
});

test("a coarse pointer gets a deliberate target height on every destination", () => {
  mount(liveFiles);

  for (const target of query("[data-testid='overview-conversation'], [data-testid='overview-project']")) {
    expect(target.style.minHeight).toBe(`${COARSE_TARGET_HEIGHT}px`);
  }
});

test("a fine pointer is not given phone-sized rows", () => {
  coarsePointer = false;
  mount(liveFiles);

  const row = query("[data-testid='overview-conversation']")[0]!;
  expect(row.style.minHeight).not.toBe(`${COARSE_TARGET_HEIGHT}px`);
});

test("a row addresses the same anchor a focus handoff resolves through", () => {
  mount(liveFiles);

  const row = query("[data-testid='overview-conversation']")[0]!;

  /* #688 points at a conversation by path; the row that a tap opens must be the
     same destination, or an accepted handoff and a tap disagree about where the
     operator just went. */
  expect(row.getAttribute("data-focus-target"))
    .toBe(focusTargetAnchorKeys({ kind: "conversation", path: "/sessions/one.jsonl" })[0]!);
});

test("with nothing live the card body stays one generous project target", () => {
  const taps = mount([fileEntry({ path: "/sessions/quiet.jsonl", activity: "idle" })]);

  /* No conversation targets exist to be confused with, so the reachability the
     card had before is kept rather than shrunk to a header strip. */
  expect(query("[data-testid='overview-conversation']")).toHaveLength(0);
  const project = query("[data-testid='overview-project']")[0]!;
  project.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(taps.projects).toEqual(["demo-project"]);
});
