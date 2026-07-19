import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { SubagentBadges } from "./SubagentBadges";
import { createSubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";

const dom = new Window();
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
