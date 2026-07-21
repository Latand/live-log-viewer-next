import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { SubagentBadges } from "./SubagentBadges";
import { createSubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";

const dom = new Window();

/* Query-aware matchMedia so a test can flip the pointer class; defaults model a
   fine-pointer desktop (the pre-existing tests' environment). */
const mediaState = { coarse: false };
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  get matches() { return query.includes("pointer: coarse") ? mediaState.coarse : false; },
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
});

const roots = new Set<Root>();

beforeEach(() => {
  mediaState.coarse = false;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

function entry(overrides: Partial<FileEntry> & { path: string; conversationId: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.name ?? overrides.path,
    project: "viewer",
    title: overrides.title ?? overrides.conversationId,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: overrides.parent ?? null,
    mtime: overrides.mtime ?? 1,
    size: 1,
    activity: overrides.activity ?? "recent",
    proc: overrides.proc ?? null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
    path: overrides.path,
    conversationId: overrides.conversationId,
  };
}

function mount(entries: FileEntry[], onNavigate: (id: string) => void) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SubagentBadges
        conversationId="parent"
        entries={entries}
        cardRect={{ x: 100, y: 200, w: 600, h: 70 }}
        onNavigate={onNavigate}
      />,
    );
  });
  return host;
}

test("hover expands a subagent circle to its title and click navigates by current transcript path", async () => {
  const navigated: string[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path, title: "Badge interaction worker" });
  const host = mount([parent, child], (path) => navigated.push(path));
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;

  expect(badge).toBeTruthy();
  expect(badge.getAttribute("aria-expanded")).toBe("false");
  badge.dispatchEvent(new dom.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
  await Bun.sleep(0);
  expect(badge.getAttribute("aria-expanded")).toBe("true");
  expect(badge.textContent).toContain("Badge interaction worker");

  flushSync(() => badge.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(navigated).toEqual(["/child"]);
});

test("badges own their taps under a coarse-pointer hand board: interactive and exempt from camera capture", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path, title: "Owned worker" });
  const host = mount([parent, child], () => undefined);
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;

  /* data-scheme-ui makes the camera's pointer/click/dblclick handlers bail on
     this element (so a tap is never swallowed into a pan), and pointer-events
     stay on even inside the hand-mode pointer-events-none node layer. */
  expect(badge.hasAttribute("data-scheme-ui")).toBe(true);
  expect(badge.className).toContain("pointer-events-auto");
});

test("navigation targets the current generation path, never the stale file-order entry", () => {
  const navigated: string[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const stale = entry({ path: "/child-gen1", conversationId: "child", parent: parent.path, generation: 1, mtime: 5, title: "Worker" });
  const current = entry({ path: "/child-gen2", conversationId: "child", parent: parent.path, generation: 2, mtime: 6, title: "Worker" });
  /* Stale generation first in file order — a re-resolution from order would
     open it; the badge must carry the selected current path. */
  const host = mount([stale, current, parent], (path) => navigated.push(path));
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;

  flushSync(() => badge.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(navigated).toEqual(["/child-gen2"]);
});

test("a dead child is dimmed, explains its unavailable state, and does not navigate", () => {
  const navigated: string[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const dead = entry({
    path: "/dead",
    conversationId: "dead",
    parent: parent.path,
    title: "Removed worker",
    spawn: {
      launchId: "launch-dead",
      clientAttemptId: null,
      accountId: null,
      state: "failed",
      initialMessage: "failed",
      retrySafe: false,
      error: "transcript unavailable",
    },
  });
  const host = mount([parent, dead], (id) => navigated.push(id));
  const badge = host.querySelector('[data-subagent-badge="dead"]') as HTMLButtonElement;

  expect(badge.dataset.subagentState).toBe("dead");
  expect(badge.className).toContain("opacity-45");
  expect(badge.title).toContain("unavailable");
  flushSync(() => badge.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(navigated).toEqual([]);
});

test("a killed child with a retained transcript stays dimmed and navigable", () => {
  const navigated: string[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const killed = entry({ path: "/killed", conversationId: "killed", parent: parent.path, title: "Stopped worker", proc: "killed" });
  const host = mount([parent, killed], (id) => navigated.push(id));
  const badge = host.querySelector('[data-subagent-badge="killed"]') as HTMLButtonElement;

  expect(badge.dataset.subagentState).toBe("closed");
  expect(badge.className).toContain("opacity-45");
  flushSync(() => badge.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(navigated).toEqual(["/killed"]);
});

test("the hard cap renders a final overflow circle with the complete hidden count", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const children = Array.from({ length: 13 }, (_, index) => entry({
    path: `/child-${index}`,
    conversationId: `child-${index}`,
    parent: parent.path,
    mtime: index + 2,
  }));
  const host = mount([parent, ...children], () => undefined);

  expect(host.querySelectorAll("[data-subagent-badge]")).toHaveLength(11);
  expect(host.querySelector("[data-subagent-overflow]")?.textContent).toBe("+2");
});

test("touch expands on the first tap and navigates on the second", async () => {
  const navigated: string[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/touch", conversationId: "touch", parent: parent.path, title: "Touch worker" });
  const host = mount([parent, child], (id) => navigated.push(id));
  const badge = host.querySelector('[data-subagent-badge="touch"]') as HTMLButtonElement;
  const tap = () => badge.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }) as unknown as Event);

  tap();
  await Bun.sleep(0);
  expect(badge.getAttribute("aria-expanded")).toBe("true");
  expect(navigated).toEqual([]);

  tap();
  await Bun.sleep(0);
  expect(navigated).toEqual(["/touch"]);
});

test("visible circles register their fixed world-space centers for structural arrows", async () => {
  const registry = createSubagentBadgeAnchorRegistry();
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path });
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SubagentBadges
        conversationId="parent"
        entries={[parent, child]}
        cardRect={{ x: 100, y: 200, w: 600, h: 70 }}
        anchorRegistry={registry}
        onNavigate={() => undefined}
      />,
    );
  });
  await Bun.sleep(0);

  expect(registry.anchorFor("parent", "child")).toEqual({ x: 721, y: 255 });
});

/* Issue #474 follow-up: the rail stays available on coarse pointers with
   stable tap/focus interaction and ≥44px hit targets, while the 30px circles
   keep their compact visual footprint and readable identity. */

function mountRail(entries: FileEntry[], onNavigate: (id: string) => void, cardRect = { x: 100, y: 200, w: 600, h: 200 }) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SubagentBadges conversationId="parent" entries={entries} cardRect={cardRect} onNavigate={onNavigate} />,
    );
  });
  return host;
}

test("every badge carries a coarse-pointer hit extender spanning a 44px target around its 30px circle", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path, title: "Hit target worker" });
  const host = mountRail([parent, child], () => undefined);
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;

  /* The extender is a non-layout absolute span reaching 7px past the 30px
     circle on every side (30 + 2·7 = 44), shown only under (pointer: coarse)
     so desktop hover geometry is untouched. It must not be clipped: the visual
     clipping for the sliding title lives on an inner wrapper, not the button. */
  const hit = badge.querySelector("[data-subagent-hit]") as HTMLElement;
  expect(hit).toBeTruthy();
  expect(hit.className).toContain("-inset-[7px]");
  expect(hit.className).toContain("pointer-coarse:block");
  expect(badge.className).not.toContain("overflow-hidden");
});

test("coarse pointers spread the rail pitch to 44px so neighboring tap targets never overlap", async () => {
  mediaState.coarse = true;
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const first = entry({ path: "/c1", conversationId: "c1", parent: parent.path, mtime: 2 });
  const second = entry({ path: "/c2", conversationId: "c2", parent: parent.path, mtime: 3 });
  const host = mountRail([parent, first, second], () => undefined);
  const a = host.querySelector('[data-subagent-badge="c1"]') as HTMLElement;
  const b = host.querySelector('[data-subagent-badge="c2"]') as HTMLElement;
  const pitch = Math.abs(Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top));
  expect(pitch).toBe(44);
});

test("fine pointers keep the compact 36px pitch", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const first = entry({ path: "/c1", conversationId: "c1", parent: parent.path, mtime: 2 });
  const second = entry({ path: "/c2", conversationId: "c2", parent: parent.path, mtime: 3 });
  const host = mountRail([parent, first, second], () => undefined);
  const a = host.querySelector('[data-subagent-badge="c1"]') as HTMLElement;
  const b = host.querySelector('[data-subagent-badge="c2"]') as HTMLElement;
  const pitch = Math.abs(Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top));
  expect(pitch).toBe(36);
});

test("avatar identity stays readable through collapsed, tapped, and expanded states", async () => {
  mediaState.coarse = true;
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path, title: "Identity worker" });
  const host = mountRail([parent, child], () => undefined);
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;
  const initials = () => (badge.querySelector("[data-subagent-avatar]") as HTMLElement | null)?.textContent ?? "";

  /* Collapsed: the circle carries the child's initials. */
  expect(initials()).toContain("IW");

  /* Tapped (expanded): the circle — and its initials — never disappears behind
     the revealed title; the title appears alongside it. */
  badge.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }) as unknown as Event);
  await Bun.sleep(0);
  expect(badge.getAttribute("aria-expanded")).toBe("true");
  expect(initials()).toContain("IW");
  expect(badge.textContent).toContain("Identity worker");
});

test("the expanded fold control reserves a coarse-pointer 44px hit area", async () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path, title: "Foldable worker" });
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SubagentBadges
        conversationId="parent"
        entries={[parent, child]}
        cardRect={{ x: 100, y: 200, w: 600, h: 70 }}
        onNavigate={() => undefined}
        onFold={() => undefined}
      />,
    );
  });
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;
  badge.dispatchEvent(new dom.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
  await Bun.sleep(0);
  const fold = host.querySelector('[data-subagent-fold="child"]') as HTMLButtonElement;
  expect(fold).toBeTruthy();
  /* 20px visual control + a 12px pseudo inset on coarse pointers = 44px. */
  expect(fold.className).toContain("pointer-coarse:before:-inset-3");
  expect(fold.className).toContain("pointer-coarse:before:content-['']");
});

test("removing the expanded child releases the parent card foreground layer", async () => {
  const expandedStates: boolean[] = [];
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const child = entry({ path: "/child", conversationId: "child", parent: parent.path });
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  const render = (entries: FileEntry[]) => (
    <SubagentBadges
      conversationId="parent"
      entries={entries}
      cardRect={{ x: 100, y: 200, w: 600, h: 70 }}
      onNavigate={() => undefined}
      onExpandedChange={(expanded) => expandedStates.push(expanded)}
    />
  );
  flushSync(() => root.render(render([parent, child])));
  const badge = host.querySelector('[data-subagent-badge="child"]') as HTMLButtonElement;
  flushSync(() => badge.focus());
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(expandedStates).toEqual([false, true]);

  flushSync(() => root.render(render([parent])));
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(expandedStates.at(-1)).toBe(false);
});
