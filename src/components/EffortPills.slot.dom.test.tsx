import { afterAll, afterEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { SchemeLayout, SchemeNode } from "./scheme/layout";

/*
 * Issue #270: the reasoning bars (EffortPills) must occupy a reserved in-flow
 * layout slot on every surface — never an overlay that paints over adjacent
 * chips. The old `scale(var(--inv-z))` counter-zoom grew the bars visually
 * while flexbox kept reserving their unscaled 11px, stacking them over the
 * model/effort cluster on scheme nodes. These tests pin the slot contract in
 * rendered DOM for the desktop pane header, a narrow (360px) scheme node, and
 * the 390px MobileFocusView, plus the width-threshold collapse on SwitchCard.
 */

const dom = new HappyWindow();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver,
    IntersectionObserver: undefined,
  });
}
bindDomGlobals();

/* Per-test viewport: desktop by default; the mobile test flips to a 390px
   phone (useIsMobile reads matchMedia on every render, so a flip between
   renders takes effect). */
let mobile = false;
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { BranchPane } = await import("./BranchPane");
const { SwitchCard } = await import("./SwitchCard");
const { NodesLayer } = await import("./scheme/nodes");
const { MobileFocusView } = await import("./mobile/MobileFocusView");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  mobile = false;
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

/* The screenshot cluster from the issue: a running Fable root with a low
   reasoning tier — model chip + bars side by side in the header. */
function fableRoot(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/root.jsonl", root: "claude-projects", name: "root.jsonl", project: "viewer", title: "root",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "live",
    proc: "running", pid: 5, model: "fable-5", effort: "low", fast: false, pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

function mount(): { host: HTMLElement; root: Root } {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  return { host, root };
}

/** The slot contract: in-flow flex item, no paint transform, no positioned
    escape between the meter and its host row. */
function expectInFlow(pills: HTMLElement) {
  expect(pills.className).toContain("reasoning-slot");
  expect(pills.className).toContain("shrink-0");
  expect(pills.className).not.toContain("absolute");
  expect(pills.getAttribute("style") ?? "").not.toContain("transform");
  expect(pills.getAttribute("style") ?? "").not.toContain("scale(");
  for (const bar of pills.querySelectorAll("span")) {
    expect(bar.getAttribute("style") ?? "").not.toContain("transform");
  }
}

test("desktop pane header: the bars ride the wrapping meta row beside the model chip, transform-free", () => {
  const { host, root } = mount();
  flushSync(() => root.render(<BranchPane file={fableRoot()} tasks={[]} isRoot />));

  const pills = host.querySelector("[data-effort-pills]") as HTMLElement;
  expect(pills).not.toBeNull();
  expectInFlow(pills);
  // reserved flex slot: the meter and the model chip are siblings of one
  // wrapping row, so a narrow pane wraps the row instead of overlapping
  const row = pills.parentElement as HTMLElement;
  expect(row.className).toContain("flex-wrap");
  expect(row.textContent).toContain("fable-5");
  // accessibility: the tier reads out through the localized tooltip label
  expect(pills.getAttribute("role")).toBe("img");
  expect(pills.getAttribute("aria-label")).toBe("Reasoning effort: low");
  // the header declares the width container that defines narrow-pane collapse
  const header = pills.closest("header") as HTMLElement;
  expect(header.className).toContain("reasoning-host");
});

test("narrow scheme node (360px): the in-node pane keeps the bars in-flow with no inv-z paint scaling", () => {
  const entry = fableRoot({ path: "/node.jsonl", name: "node.jsonl" });
  const node: SchemeNode = { file: entry, tasks: [], under: [], isRoot: true, x: 0, y: 0, w: 360, h: 780 };
  const layout: SchemeLayout = {
    nodes: [node], edges: [], stacks: [], decks: [], loops: [], groups: [], links: [], drafts: [], slots: [],
    byPath: new Map([[entry.path, node]]), width: 2000, height: 1000,
  };
  const { host, root } = mount();
  flushSync(() =>
    root.render(
      <NodesLayer
        layout={layout}
        project="viewer"
        files={[entry]}
        interactive
        lite={false}
        dormant
        selected={null}
        multi={new Set()}
        session={false}
        focus={null}
        attentionPaths={null}
        flowsByImpl={new Map()}
        flows={[]}
        pipelineStrips={new Map()}
        linkedTasksByPipeline={new Map()}
        deckFocus={null}
        onSelect={() => undefined}
        onClose={() => undefined}
        onFocusRound={() => undefined}
        onDraftClose={() => undefined}
        onDraftSpawned={() => undefined}
        onExpand={() => undefined}
      />,
    ),
  );

  const shell = host.querySelector(`[data-scheme-node="${entry.path}"]`) as HTMLElement;
  expect(shell.style.width).toBe("360px");
  const pills = shell.querySelector("[data-effort-pills]") as HTMLElement;
  expect(pills).not.toBeNull();
  expectInFlow(pills);
  // the scheme world sets --inv-z; nothing in the header may consume it as a
  // paint transform anymore (the #270 overlap)
  const header = pills.closest("header") as HTMLElement;
  for (const el of [header, ...header.querySelectorAll<HTMLElement>("*")]) {
    expect(el.getAttribute("style") ?? "").not.toContain("--inv-z");
  }
  expect((pills.parentElement as HTMLElement).className).toContain("flex-wrap");
  expect(header.className).toContain("reasoning-host");
});

test("390px MobileFocusView: reasoning telemetry is the merged chip inside the scrollable meta row, never a bar overlay", () => {
  mobile = true;
  Object.defineProperty(dom, "innerWidth", { configurable: true, value: 390 });
  const entry = fableRoot();
  const { host, root } = mount();
  flushSync(() =>
    root.render(
      <MobileFocusView
        project="viewer"
        groups={[]}
        manual={[entry]}
        files={[entry]}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={entry.path}
        onSelect={() => undefined}
        onClose={() => undefined}
        onDraftClose={() => undefined}
        onDraftSpawned={() => undefined}
      />,
    ),
  );

  // the phone slot is the merged «model · reasoning» chip (issue #241) —
  // the vertical bars never render, so no bar can overlay the 390px header
  expect(host.querySelector("[data-effort-pills]")).toBeNull();
  const chips = [...host.querySelectorAll<HTMLElement>("span")].filter((el) => el.textContent === "fable-5 · low");
  expect(chips.length).toBeGreaterThan(0);
  const chip = chips[0]!;
  expect(chip.className).toContain("shrink-0");
  expect(chip.className).not.toContain("absolute");
  // the chip rides the horizontally scrolling meta row — clipped chips scroll
  // into view instead of stacking
  const scroller = chip.closest(".overflow-x-auto") as HTMLElement;
  expect(scroller).not.toBeNull();
  expect(scroller.className).toContain("flex-nowrap");
  // nothing in the focused header paints an inv-z scale overlay
  const header = chip.closest("header") as HTMLElement;
  expect(header).not.toBeNull();
  for (const el of header.querySelectorAll<HTMLElement>("*")) {
    expect(el.getAttribute("style") ?? "").not.toContain("scale(");
  }
});

test("SwitchCard: fixed-width cards declare the reasoning-host container so the meter collapses below the threshold", () => {
  const entry = fableRoot();
  for (const size of ["small", "large"] as const) {
    const { host, root } = mount();
    flushSync(() =>
      root.render(
        <SwitchCard
          file={entry}
          title="root"
          project="viewer"
          currentProject="viewer"
          descendants={0}
          statusLine=""
          size={size}
          tone="working"
          onOpen={() => undefined}
          onArchive={() => undefined}
        />,
      ),
    );
    const card = host.querySelector("article") as HTMLElement;
    expect(card.className).toContain("reasoning-host");
    const pills = card.querySelector("[data-effort-pills]") as HTMLElement;
    expect(pills).not.toBeNull();
    expectInFlow(pills);
    // telemetry survives the collapse: the model chip tooltip carries the tier
    const chip = [...card.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "fable-5");
    expect(chip?.getAttribute("title") ?? "").toContain("Reasoning effort: low");
  }
});

test("SwitchCard fallback badge: with model unknown, the engine chip still carries the effort tooltip", () => {
  // model=null flips the identity chip to the engine-badge fallback; the tier
  // must survive the sub-260px meter collapse through the badge's title
  const entry = fableRoot({ model: null });
  const { host, root } = mount();
  flushSync(() =>
    root.render(
      <SwitchCard
        file={entry}
        title="root"
        project="viewer"
        currentProject="viewer"
        descendants={0}
        statusLine=""
        size="small"
        tone="working"
        onOpen={() => undefined}
        onArchive={() => undefined}
      />,
    ),
  );
  const badge = [...host.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "Claude") as HTMLElement;
  expect(badge).not.toBeNull();
  expect(badge.getAttribute("title")).toBe("Reasoning effort: low");
});

test("pane fallback badge: with model unknown, desktop and mobile engine chips carry the effort tooltip", () => {
  const entry = fableRoot({ model: null });
  for (const asMobile of [false, true]) {
    mobile = asMobile;
    const { host, root } = mount();
    flushSync(() => root.render(<BranchPane file={entry} tasks={[]} isRoot />));
    const badge = [...host.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent?.trim() === "Claude") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("title")).toBe("Reasoning effort: low");
    flushSync(() => root.unmount());
    roots.delete(root);
    dom.document.body.replaceChildren();
  }
});

test("globals.css defines the reasoning-host container and the 260px collapse for the slot", () => {
  // the class contract above only holds if the stylesheet ships the container
  // query — pin it so a rename or a dropped rule fails here, not in the field
  const css = fs.readFileSync(path.join(import.meta.dir, "../app/globals.css"), "utf8");
  expect(css).toContain(".reasoning-host {");
  expect(css).toContain("container: reasoning-host / inline-size;");
  expect(css).toContain("@container reasoning-host (max-width: 259px)");
  expect(css.slice(css.indexOf("@container reasoning-host"))).toContain(".reasoning-slot");
});
