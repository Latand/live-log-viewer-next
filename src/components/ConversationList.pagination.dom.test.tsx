import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { clearRetainedConversationPages, useConversationCatalog } from "@/hooks/useConversationCatalog";

import { CONVERSATION_LIST_PAGE_SIZE, ConversationList } from "./ConversationList";

/**
 * The desktop agent list (#1614 item 4): a full browsable catalog with the
 * phone's page size, the phone's sentinel-driven paging, and — the part that
 * actually bit — pages that survive an update instead of snapping back to the
 * first one.
 */

const dom = new Window();
/* One controllable observer: the test decides when the sentinel is in view, so
   paging is driven by the product's own effect rather than by a direct call. */
const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; targets: HTMLElement[] }[] = [];
class TestIntersectionObserver {
  private entry: { callback: (entries: { isIntersecting: boolean }[]) => void; targets: HTMLElement[] };
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(target: HTMLElement) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() { const index = observers.indexOf(this.entry); if (index >= 0) observers.splice(index, 1); }
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  IntersectionObserver: TestIntersectionObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
let previousFetch: typeof fetch;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  /* Scoped pages are retained across unmount now (#1614), so one test's list
     would otherwise be the next test's starting point. */
  clearRetainedConversationPages();
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  observers.length = 0;
  document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

/** The reported catalog scale: 680 entries behind the paged endpoint. */
const CORPUS = 680;
function entry(index: number): FileEntry {
  return {
    path: `/catalog/agent-${index}.jsonl`, root: "claude-projects", name: `agent-${index}.jsonl`,
    project: "repo-board", title: `Agent ${index} keeps area ${index}`, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, conversationId: `conversation-agent-${index}`,
  } as FileEntry;
}

let urls: string[] = [];
function serveCatalog() {
  previousFetch = globalThis.fetch;
  urls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url.pathname + url.search);
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const items = Array.from({ length: Math.min(limit, CORPUS - offset) }, (_, index) => entry(offset + index));
    const next = offset + items.length;
    return new Response(JSON.stringify({ items, nextCursor: next < CORPUS ? String(next) : null, total: CORPUS }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mount(enabled = true) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = (next: boolean) => flushSync(() => root.render(
    <ConversationList project="repo-board" enabled={next} onOpen={() => {}} />,
  ));
  render(enabled);
  return { host, render };
}

const rows = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-quiet-path], [data-catalog-path], a, button")).length;
const titles = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("*"))
  .filter((node) => /^Agent \d+ keeps area \d+$/.test(node.textContent ?? "")).map((node) => node.textContent!);

/** Reports the sentinel as scrolled into view, the way a real scroll would. */
const reachSentinel = async () => {
  for (const observer of [...observers]) {
    if (observer.targets.some((target) => target.hasAttribute("data-conversation-list-sentinel"))) {
      flushSync(() => observer.callback([{ isIntersecting: true }]));
    }
  }
  await settle();
};

test("the desktop list asks for 50 at a time and pages on scroll, not on a button press", async () => {
  serveCatalog();
  expect(CONVERSATION_LIST_PAGE_SIZE).toBe(50);
  const { host } = mount();
  await settle();
  expect(urls[0]).toContain(`limit=${CONVERSATION_LIST_PAGE_SIZE}`);
  expect(titles(host).length).toBe(50);

  /* The sentinel at the end of the rows is what loads the next page. */
  await reachSentinel();
  expect(titles(host).length).toBe(100);
  await reachSentinel();
  expect(titles(host).length).toBe(150);
  expect(urls.length).toBe(3);
  /* Pages accumulate in order and never repeat a row. */
  expect(titles(host)[0]).toBe("Agent 0 keeps area 0");
  expect(titles(host)[149]).toBe("Agent 149 keeps area 149");
  expect(new Set(titles(host)).size).toBe(150);
});

test("pagination and focus survive an update — the list does not snap back to page one (#1614 item 4)", async () => {
  serveCatalog();
  const { host, render } = mount();
  await settle();
  await reachSentinel();
  await reachSentinel();
  expect(titles(host).length).toBe(150);
  const requestsBefore = urls.length;

  /* Focus a row deep in the loaded pages, the way an operator browsing does. */
  const deepRow = Array.from(host.querySelectorAll<HTMLElement>("button, a"))
    .find((node) => (node.textContent ?? "").includes("Agent 120 keeps area 120"))!;
  expect(deepRow).toBeDefined();
  deepRow.focus();
  expect(document.activeElement).toBe(deepRow);

  /* The update: the leaf is disabled and re-enabled, exactly what a view
     change or a readiness flip does around this component. Before the fix the
     catalog dropped its cached scope here and re-read page one, losing every
     page the operator had scrolled through — and the focused row with it. */
  render(false);
  await settle();
  render(true);
  await settle();

  expect(titles(host).length).toBe(150);
  expect(titles(host)[149]).toBe("Agent 149 keeps area 149");
  /* An update is not a return: the pages are kept as they are, and not one
     request is spent re-reading them while the operator is looking at them. */
  expect(urls.length).toBe(requestsBefore);
  /* The focused row is the same DOM node, so focus was never dropped. */
  expect(document.activeElement).toBe(deepRow);
  expect((document.activeElement as HTMLElement).textContent).toContain("Agent 120 keeps area 120");

  /* And paging continues from where it stopped, not from the start. */
  await reachSentinel();
  expect(titles(host).length).toBe(200);
});

test("reopening the list after opening an agent returns to the pages that were scrolled (#1614)", async () => {
  serveCatalog();
  const first = mount();
  await settle();
  await reachSentinel();
  await reachSentinel();
  expect(titles(first.host).length).toBe(150);
  const requestsBefore = urls.length;

  /* Opening an agent from the list is what unmounts it: the desktop shows the
     conversation on the board, and the list leaf goes away entirely. This is a
     harder case than the disable/enable update above — the component instance
     and every ref it owned are gone. */
  flushSync(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  document.body.replaceChildren();
  expect(document.querySelectorAll("[data-conversation-list-row]")).toHaveLength(0);

  const second = mount();
  /* The first paint is already the list that was left — the retained rows are
     rendered before a single response comes back, so returning never blinks
     through page one. */
  expect(titles(second.host).length).toBe(150);
  await settle();

  /* And they are re-read rather than trusted: the same three pages are asked
     for again, so an agent spawned or renamed while the operator was away is
     on the list they came back to. Bounded by the span they held — not one
     request (which would truncate them to page one) and not a poll. */
  expect(urls.length).toBe(requestsBefore + 3);
  expect(urls.slice(requestsBefore).every((url) => url.includes(`limit=${CONVERSATION_LIST_PAGE_SIZE}`))).toBe(true);
  expect(titles(second.host).length).toBe(150);
  expect(titles(second.host)[149]).toBe("Agent 149 keeps area 149");
  /* And the next scroll continues the same chain. */
  await reachSentinel();
  expect(titles(second.host).length).toBe(200);
});

test("the list that comes back carries what changed while it was gone (#1614)", async () => {
  /* The defect the retention above introduced on its own: a snapshot kept
     across an unmount is a photograph unless something re-reads it. */
  previousFetch = globalThis.fetch;
  let changed = false;
  urls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const items = changed
      ? [{ ...entry(0), title: "Agent 0 renamed while away" }, entry(1)]
      : [entry(0)];
    return new Response(JSON.stringify({ items, total: items.length, nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const first = mount();
  await settle();
  expect(first.host.textContent).toContain("Agent 0 keeps area 0");
  /* The chain is exhausted, so there is no «load more» to press either. */
  expect(first.host.querySelector("[data-conversation-list-more]")).toBeNull();

  flushSync(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  document.body.replaceChildren();
  changed = true;

  const returned = mount();
  await settle();
  expect(returned.host.textContent).toContain("Agent 0 renamed while away");
  expect(returned.host.textContent).toContain("Agent 1 keeps area 1");
});

test("a list with no scope of its own still starts clean on every mount", async () => {
  /* The switchboard's search passes no scopeKey: its results belong to the
     query being typed, not to a surface to come back to. */
  serveCatalog();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const Probe = () => {
    const catalog = useConversationCatalog({ query: "agent", enabled: true, pageSize: CONVERSATION_LIST_PAGE_SIZE });
    return <div data-probe-rows={catalog.items.length} />;
  };
  flushSync(() => root.render(<Probe />));
  await settle();
  expect(host.querySelector("[data-probe-rows]")?.getAttribute("data-probe-rows")).toBe(String(CONVERSATION_LIST_PAGE_SIZE));
  const requests = urls.length;
  flushSync(() => root.unmount());
  roots.delete(root);

  const second = createRoot(host);
  roots.add(second);
  flushSync(() => second.render(<Probe />));
  await settle();
  expect(urls.length).toBe(requests + 1);
});

test("the list still reaches the end of a 680-entry corpus and stops asking", async () => {
  serveCatalog();
  const { host } = mount();
  await settle();
  for (let page = 1; page < 20 && host.querySelector("[data-conversation-list-more]"); page += 1) await reachSentinel();
  expect(titles(host).length).toBe(CORPUS);
  expect(host.querySelector("[data-conversation-list-more]")).toBeNull();
  const settled = urls.length;
  await reachSentinel();
  expect(urls.length).toBe(settled);
});
