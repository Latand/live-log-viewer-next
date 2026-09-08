import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";

import { activeGroup, activeFailureGroup, settledGroup, nestedGroup } from "../__fixtures__/readableTools";
import { ToolDisclosurePolicy } from "../toolDisclosure";
import { ToolCard } from "./ToolCard";
import { CmdGroupCard } from "./CmdGroupCard";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

beforeEach(() => {
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(async () => {}) },
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  host = null;
  document.body.replaceChildren();
});

function mount(node: ReactElement): HTMLDivElement {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  flushSync(() => root!.render(node));
  host = el as unknown as HTMLDivElement;
  return host;
}

// Re-render into the *same* root, so the component instance (and its lifecycle
// state) persists across the tick — the way an incremental re-feed updates it.
function rerender(node: ReactElement): HTMLDivElement {
  flushSync(() => root!.render(node));
  return host!;
}

function toggle(details: Element, open: boolean): void {
  (details as unknown as { open: boolean }).open = open;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}


const folded = (item = activeGroup()) => <ToolDisclosurePolicy value="collapsed"><CmdGroupCard item={item} /></ToolDisclosurePolicy>;

test("dock starts recursively closed, preserves toggles during arrivals and settlement; board stays full", () => {
  const item = nestedGroup({ active: true });
  const h = mount(folded(item));
  expect(h.querySelectorAll("details").length).toBe(1);
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  toggle(h.querySelector("details")!, true);
  const calls = h.querySelectorAll("details > ol > li > details");
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect((call as HTMLDetailsElement).open).toBe(false);
  toggle(calls[0], true);
  const first = calls[0];
  rerender(folded({ ...item, calls: [...item.calls, { ...item.calls[0], id: "arrived", srcCall: 900 }] }));
  expect((first as HTMLDetailsElement).open).toBe(true);
  expect((h.querySelector("details > ol > li:last-child > details") as HTMLDetailsElement).open).toBe(false);
  rerender(folded({ ...item, active: false }));
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  expect((first as HTMLDetailsElement).open).toBe(true);
  toggle(h.querySelector("details")!, false);
  rerender(folded(item));
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  rerender(<CmdGroupCard key="board" item={item} />);
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  expect(h.querySelectorAll("details").length).toBe(1);
  rerender(<ToolDisclosurePolicy key="remount" value="collapsed"><CmdGroupCard item={item} /></ToolDisclosurePolicy>);
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(false);
});

test("errors and running status remain in closed summaries", () => {
  const h = mount(folded(activeFailureGroup()));
  expect(h.textContent).toContain(String(activeFailureGroup().errCount));
  expect(h.querySelector("svg")).not.toBeNull();
  expect((h.querySelector("details") as HTMLDetailsElement).open).toBe(false);
});

test("standalone default-open call and functions.exec children disclose one level at a time", () => {
  const event = { ...activeGroup().calls[0], open: true, orchestration: { source: "", sourceTruncated: false, calls: [{ id: "inner", tool: "exec_command", family: "shell" as const, icon: "shell" as const, summary: "nested command output", children: [{ id: "leaf", tool: "read_file", family: "read" as const, icon: "shell" as const, summary: "deep leaf" }] }] } };
  const node = <ToolDisclosurePolicy value="collapsed"><ToolCard event={event} /></ToolDisclosurePolicy>;
  const h = mount(node);
  expect(h.textContent).not.toContain("nested command output");
  toggle(h.querySelector("details")!, true);
  const nested = h.querySelector("details details")!;
  expect((nested as HTMLDetailsElement).open).toBe(false);
  expect(h.textContent).not.toContain("nested command output");
  toggle(nested, true);
  expect(h.textContent).toContain("nested command output");
  const leaf = nested.querySelector("details")!;
  expect((leaf as HTMLDetailsElement).open).toBe(false);
  toggle(leaf, true);
  expect(h.textContent).toContain("deep leaf");
  rerender(node);
  expect((nested as HTMLDetailsElement).open).toBe(true);
});
