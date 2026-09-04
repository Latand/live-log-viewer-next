import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

/*
 * Renaming a focused conversation on a phone (issue #1348), against the REAL
 * `MobileFocusView` → `BranchPane` → `SessionTitle` at 390×844.
 *
 * The operator tapped the pencil and got a field with no visible text. The
 * pane header at that width was a single flex row already carrying the status
 * dot, the status word, the kill control, the details toggle, the favourite
 * crown, delete and close — every one a fixed 44px target — and the inline
 * editor then joined that row with THREE more 44px targets of its own, so the
 * `min-w-0 flex-1` input was the only thing left to give and gave everything:
 * zero width, text and caret included. On top of that the input was set in
 * 12px type, which iOS Safari answers by zooming the page on focus, panning the
 * caret out of view.
 *
 * Mobile v2 lane 3 removed that pane header entirely. Rename is a labelled row
 * in the conversation's `⋯` menu and it edits the BAR's title cell in place
 * (README §4.2): the editor lays over the 52 px bar edge to edge, and the cell
 * under it follows the optimistic rename at once. This file still pins the
 * render path #1348 fixed — the field is legible, set in a size the phone will
 * not zoom, its face spelled out for both themes — and a drag inside it moves
 * the text rather than the conversation.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent, FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: false, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
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

const { MobileFocusView } = await import("../mobile/MobileFocusView");
const { resetOrchestratorSeatCacheForTests } = await import("../orchestrator/useOrchestratorSeat");

interface Recorded { url: string; method: string; body: Record<string, unknown> }
const requests: Recorded[] = [];
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/session/title")) {
    return json({ ok: true, override: { key: "uuid:claude:renamed", title: body.title, revision: 1, updatedAt: "t" }, revision: 1 });
  }
  if (url.startsWith("/api/orchestrator/seat")) return json({ seat: null, pending: null, exists: true });
  if (url.startsWith("/api/accounts")) return json({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
  return json({});
}) as typeof fetch;

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  resetOrchestratorSeatCacheForTests();
  requests.length = 0;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

const LONG_TITLE = "Builder · keep every orchestrator control reachable from a 390px phone viewport, and make the rename editor legible";

function conversation(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/other.jsonl", root: "claude-projects", name: "other.jsonl", project: "atlas", title: "Some other work",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 100, size: 1, activity: "live",
    proc: "running", pid: 3, conversationId: "conv_other", model: "sonnet", cwd: "/repo/atlas", projectRoot: "/repo/atlas",
    renamable: true, pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

const focused = conversation({ path: "/focused.jsonl", name: "focused.jsonl", conversationId: "conv_focused", title: LONG_TITLE, mtime: 200 });
const neighbour = conversation({});

const view = (files: FileEntry[]) => (
  <MobileFocusView
    project="atlas"
    projectName="atlas"
    groups={[]}
    manual={files}
    files={files}
    flows={[]}
    pipelines={[]}
    tasks={[]}
    drafts={[]}
    loaded
    focus="/focused.jsonl"
    onSelect={() => undefined}
    onClose={() => undefined}
    onDraftClose={() => undefined}
    onDraftSpawned={() => undefined}
  />
);

async function settle(root: Root, element: React.ReactElement, rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => root.render(element));
  }
}

async function mount(files: FileEntry[]): Promise<{ host: HTMLElement; root: Root }> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(view(files)));
  await settle(root, view(files));
  return { host: host as unknown as HTMLElement, root };
}

const renameSlot = (host: HTMLElement) => host.querySelector('[data-testid="mobile-rename-slot"]') as HTMLElement | null;
const barTitle = (host: HTMLElement) => host.querySelector("[data-mobile2-title-text]")?.textContent ?? "";
/** Rename is a labelled row in the `⋯` menu now, not an icon in a header. */
function openRename(host: HTMLElement): void {
  const more = host.querySelector('[data-mobile2-open="menu"]') as HTMLButtonElement;
  flushSync(() => more.click());
  const row = host.querySelector('[data-testid="mobile-menu-rename"]') as HTMLButtonElement;
  expect(row).not.toBeNull();
  expect(row.className).toContain("min-h-11");
  flushSync(() => row.click());
}
const editor = (host: HTMLElement) => (renameSlot(host)?.querySelector("[data-session-title-editor]") ?? null) as HTMLElement | null;
const input = (host: HTMLElement) => (renameSlot(host)?.querySelector('input[aria-label="Session title"]') ?? null) as HTMLInputElement | null;
const focusedPath = (host: HTMLElement) =>
  host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')?.getAttribute("data-link-path") ?? null;

function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

/** A finger moving across `target`: touchstart at `from`, touchend at `to`. */
function drag(target: Element, from: number, to: number): void {
  const start = new dom.Event("touchstart", { bubbles: true, cancelable: true }) as unknown as Event;
  Object.assign(start, { touches: [{ clientX: from, clientY: 20 }], changedTouches: [{ clientX: from, clientY: 20 }] });
  const end = new dom.Event("touchend", { bubbles: true, cancelable: true }) as unknown as Event;
  Object.assign(end, { touches: [], changedTouches: [{ clientX: to, clientY: 22 }] });
  flushSync(() => {
    target.dispatchEvent(start);
    target.dispatchEvent(end);
  });
}

test("the phone's rename editor shows the current title in a field that takes the bar over, set in a size the phone will not zoom", async () => {
  const files = [neighbour, focused];
  const { host, root } = await mount(files);
  expect(focusedPath(host)).toBe("/focused.jsonl");
  /* Nothing is renamed until the menu row asks: no editor sits on the bar. */
  expect(renameSlot(host)).toBeNull();

  openRename(host);
  await settle(root, view(files), 1);

  /* The current title is IN the field, whole, and preselected. */
  const field = input(host);
  expect(field).not.toBeNull();
  expect(field!.value).toBe(LONG_TITLE);
  expect(field!.getAttribute("type")).toBe("text");
  expect(dom.document.activeElement).toBe(field as unknown as typeof dom.document.activeElement);

  /* The editor is not one more cell in a crowded row: it lays over the bar
     edge to edge, so no fixed 44px control beside the title can squeeze the
     field to nothing. */
  const box = editor(host);
  expect(box).not.toBeNull();
  expect(box!.getAttribute("data-session-title-editor")).toBe("mobile");
  expect(box!.className).toContain("absolute");
  expect(box!.className).toContain("inset-x-0");
  expect(box!.className).toContain("top-0");
  expect(box!.className).not.toContain("flex-1");
  expect(renameSlot(host)!.className).toContain("inset-x-0");

  /* The field itself: a 44px row, 16px type (iOS zooms anything smaller on
     focus, which pans the caret off screen), and a face spelled out for both
     themes — surface, ink and caret all from the role tokens. */
  const cls = field!.className;
  expect(cls).toContain("h-11");
  expect(cls).toContain("text-[16px]");
  expect(cls).toContain("bg-canvas");
  expect(cls).toContain("text-primary");
  expect(cls).toContain("caret-accent");
  expect(cls).toContain("flex-1");
  expect(cls).toContain("min-w-0");

  /* Save and Cancel keep their phone targets inside the same row. */
  const save = box!.querySelector('button[aria-label="Save name"]') as HTMLButtonElement;
  const cancel = box!.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement;
  expect(save.className).toContain("h-11");
  expect(cancel.className).toContain("h-11");
});

test("a drag inside the rename field scrolls the title, never the conversation under it", async () => {
  const files = [neighbour, focused];
  const { host, root } = await mount(files);
  openRename(host);
  await settle(root, view(files), 1);
  const field = input(host)!;

  /* The bar is the phone's swipe zone: a leftward drag across it steps to the
     next conversation. The same drag inside the editor over it is the operator
     moving through a long title, so it must stay in the field. */
  drag(field, 300, 100);
  await settle(root, view(files), 1);
  expect(focusedPath(host)).toBe("/focused.jsonl");
  expect(input(host)).not.toBeNull();
  expect(input(host)!.value).toBe(LONG_TITLE);
});

test("Enter saves what was typed and the bar's title cell shows the new name", async () => {
  const files = [neighbour, focused];
  const { host, root } = await mount(files);
  expect(barTitle(host)).toContain(LONG_TITLE.slice(0, 20));
  openRename(host);
  await settle(root, view(files), 1);
  const field = input(host)!;
  flushSync(() => typeInto(field, "Phone rename"));
  flushSync(() => field.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event));
  await settle(root, view(files), 3);

  const saves = requests.filter((request) => request.url === "/api/session/title");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.body).toMatchObject({ path: "/focused.jsonl", title: "Phone rename" });
  expect(input(host)).toBeNull();
  /* The cell under the editor followed the optimistic rename, so the operator
     sees the name they typed without waiting for the next scan. */
  expect(barTitle(host)).toBe("Phone rename");
});

for (const action of ["Cancel", "Save name"] as const) {
  test(`a phone ${action} press prevents null-target blur before click`, async () => {
    const files = [neighbour, focused];
    const { host, root } = await mount(files);
    const originalBarTitle = barTitle(host);
    openRename(host);
    await settle(root, view(files), 1);
    const field = input(host)!;
    flushSync(() => typeInto(field, "Phone draft"));
    const button = editor(host)!.querySelector(`button[aria-label="${action}"]`)!;
    // Press the icon too: the event must reach the button through its child.
    const target = button.querySelector("svg")!;
    const press = new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" });
    flushSync(() => target.dispatchEvent(press as unknown as Event));
    // happy-dom has no native Safari focus default. Model its reported
    // blur-before-click ordering only when the press permits that default.
    if (!press.defaultPrevented) {
      flushSync(() => field.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true, relatedTarget: null }) as unknown as Event));
    }
    expect(requests.filter((request) => request.url === "/api/session/title")).toHaveLength(0);
    expect(press.defaultPrevented).toBe(true);
    expect(input(host)).toBe(field);
    expect(dom.document.activeElement).toBe(field as unknown as typeof dom.document.activeElement);
    flushSync(() => target.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
    await settle(root, view(files));

    const saves = requests.filter((request) => request.url === "/api/session/title");
    expect(saves).toHaveLength(action === "Cancel" ? 0 : 1);
    if (action === "Save name") expect(saves[0]!.body.title).toBe("Phone draft");
    expect(input(host)).toBeNull();
    expect(barTitle(host)).toBe(action === "Cancel" ? originalBarTitle : "Phone draft");
    if (action === "Cancel") {
      openRename(host);
      await settle(root, view(files), 1);
      expect(input(host)!.value).toBe(LONG_TITLE);
    }
  });
}
