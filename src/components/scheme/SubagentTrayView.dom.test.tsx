import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { SubagentTray } from "./SubagentTrayView";
import type { ParentTray, TrayMember } from "./subagentTray";

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
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; },
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

function member(overrides: Partial<TrayMember> & { id: string }): TrayMember {
  return {
    path: `/${overrides.id}`,
    title: overrides.title ?? overrides.id,
    engine: "codex",
    model: null,
    state: "closed",
    avatarSeed: overrides.id,
    ...overrides,
  };
}

function tray(overrides: Partial<ParentTray> = {}): ParentTray {
  const members = overrides.members ?? [member({ id: "child-a", title: "Quiet worker" })];
  return {
    parentConversationId: "parent",
    members,
    count: members.length,
    hottest: "closed",
    expanded: false,
    ...overrides,
  };
}

interface Handlers {
  onToggleExpanded?: (expanded: boolean) => void;
  onOpenMember?: (path: string) => void;
  onUnfold?: (id: string, path: string) => void;
  variant?: "docked" | "inline";
}

function mount(value: ParentTray, handlers: Handlers = {}) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SubagentTray
        tray={value}
        variant={handlers.variant}
        onToggleExpanded={handlers.onToggleExpanded ?? (() => undefined)}
        onOpenMember={handlers.onOpenMember ?? (() => undefined)}
        onUnfold={handlers.onUnfold ?? (() => undefined)}
      />,
    );
  });
  return host;
}

test("the collapsed chip announces its disclosure state and folded count", () => {
  const host = mount(tray({ members: [member({ id: "a" }), member({ id: "b", state: "running" })], hottest: "running" }));
  const chip = host.querySelector("[data-subagent-tray-toggle]") as HTMLButtonElement;
  expect(chip).toBeTruthy();
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(chip.getAttribute("aria-controls")).toBe("subagent-tray-parent");
  expect(chip.getAttribute("aria-label")).toContain("2");
  // Rows are not in the DOM while collapsed.
  expect(host.querySelector("#subagent-tray-parent")).toBeNull();
});

test("clicking the chip requests the durable disclosure toggle", () => {
  const toggles: boolean[] = [];
  const host = mount(tray(), { onToggleExpanded: (expanded) => toggles.push(expanded) });
  const chip = host.querySelector("[data-subagent-tray-toggle]") as HTMLButtonElement;
  flushSync(() => chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(toggles).toEqual([true]);
});

test("an expanded tray lists member rows that open read-only and can be unfolded", () => {
  const opened: string[] = [];
  const unfolded: Array<[string, string]> = [];
  const host = mount(
    tray({ expanded: true, members: [member({ id: "child-a", title: "Audit worker", path: "/audit" })] }),
    { onOpenMember: (path) => opened.push(path), onUnfold: (id, path) => unfolded.push([id, path]) },
  );
  const rows = host.querySelector("#subagent-tray-parent");
  expect(rows).toBeTruthy();
  expect(rows!.getAttribute("aria-label")).toBe("Folded subagents");

  const openButton = host.querySelector('[data-subagent-tray-member="child-a"]') as HTMLButtonElement;
  expect(openButton.getAttribute("aria-label")).toContain("Audit worker");
  flushSync(() => openButton.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(opened).toEqual(["/audit"]);

  const unfoldButton = host.querySelector('[data-subagent-tray-unfold="child-a"]') as HTMLButtonElement;
  flushSync(() => unfoldButton.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(unfolded).toEqual([["child-a", "/audit"]]);
});

test("Escape collapses an expanded tray and restores focus to the chip", () => {
  const toggles: boolean[] = [];
  const host = mount(tray({ expanded: true }), { onToggleExpanded: (expanded) => toggles.push(expanded) });
  const rows = host.querySelector("#subagent-tray-parent") as unknown as HTMLElement;
  flushSync(() => rows.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(toggles).toEqual([false]);
  const chip = host.querySelector("[data-subagent-tray-toggle]");
  expect(dom.document.activeElement as unknown).toBe(chip as unknown);
});

test("a zero-member tray renders nothing", () => {
  const host = mount(tray({ members: [], count: 0 }));
  expect(host.querySelector("[data-subagent-tray-toggle]")).toBeNull();
});

test("the inline (mobile) variant uses 44px targets and a full-width block without overflow", () => {
  const host = mount(tray({ expanded: true, members: [member({ id: "child-a", title: "Mobile worker" })] }), { variant: "inline" });
  const container = host.querySelector("[data-subagent-tray-variant]") as unknown as HTMLElement;
  expect(container.getAttribute("data-subagent-tray-variant")).toBe("inline");
  // Full-width block, min-w-0 guards keep long titles from forcing overflow.
  expect(container.className).toContain("w-full");
  expect(container.className).toContain("min-w-0");
  const chip = host.querySelector("[data-subagent-tray-toggle]") as HTMLButtonElement;
  expect(chip.className).toContain("min-h-11");
  const openButton = host.querySelector('[data-subagent-tray-member="child-a"]') as HTMLButtonElement;
  expect(openButton.className).toContain("min-h-11");
  const unfoldButton = host.querySelector('[data-subagent-tray-unfold="child-a"]') as HTMLButtonElement;
  expect(unfoldButton.className).toContain("min-h-11");
  expect(unfoldButton.className).toContain("min-w-11");
});
