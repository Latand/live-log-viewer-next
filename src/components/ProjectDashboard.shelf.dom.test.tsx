import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * Issue #419 (reopened) — Sol finding 1. The phone hidden/handoff shelf is a
 * modal (MobileBottomShelf). Its actions are TERMINAL: opening a task/agent,
 * retrying a launch, expanding a worker or review group, or handing off all
 * navigate to content that lives BEHIND the overlay. Leaving the modal open
 * after such an action strands the target under the sheet with the body scroll
 * still locked. This mounts the REAL ProjectDashboard and proves each terminal
 * action closes the shelf (unlocking the body and restoring focus), while the
 * strip's own nested disclosure toggles keep it open. Desktop renders the same
 * strips inline with no modal at all.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

let mobile = true;
/* useIsMobile reads `window.matchMedia` (i.e. dom.matchMedia), so the media
   query must live on the dom itself — a standalone globalThis.matchMedia is
   never consulted by the hook. */
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile && /max-width/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
beforeEach(() => { mobile = true; roots = []; dom.document.body.replaceChildren(); dom.document.body.style.overflow = ""; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; dom.document.body.style.overflow = ""; });

const task: BoardTask = {
  id: "t-shelf", project: "atlas", status: "inbox", text: "Wire the shelf",
  placement: "pinned", pos: { x: 740, y: 120 }, assignments: [],
  createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
} as BoardTask;

const dashboardProps = () => ({
  files: [], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: "atlas", loaded: true, openNonce: 0, archived: false, catalogKnown: false,
  projectCwd: "/home/user/Projects/atlas", catalogConversationCount: 0,
  onArchive: () => {}, onUnarchive: () => {},
});

function mount(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps()} />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const q = (host: HTMLElement, sel: string) => host.querySelector(sel) as unknown as HTMLElement | null;
/* The host sheet opens from the board menu's «Host details» row (mobile v2
   lane 1): ⋯ on the bar, then the row. */
const menuTrigger = (host: HTMLElement) => q(host, '[data-mobile2-open="menu"]');
const hostRow = (host: HTMLElement) => q(host, '[data-mobile2-open="host"]');
/* The host sheet itself (mobile v2 lane 2): the shelf modal it replaced kept
   the same modal semantics — body lock, focus return, Escape. */
const shelf = (host: HTMLElement) => q(host, '[data-mobile2-sheet="host"]');

/* The bar renders before the board settles; the leaf under it (the pinned
   orchestrator slot on an empty project) is what arrives with `boardReady`,
   and the host sheet mounts only then. */
const boardReady = (host: HTMLElement) => q(host, '[data-testid="mobile-orchestrator-slot"]') !== null || q(host, "[data-mobile2-board]") !== null;

async function openShelf(host: HTMLElement): Promise<HTMLElement> {
  const ready = await waitFor(() => boardReady(host));
  expect(ready).toBe(true);
  const more = menuTrigger(host)!;
  more.focus();
  flushSync(() => more.click());
  const row = hostRow(host)!;
  expect(row).not.toBeNull();
  flushSync(() => row.click());
  expect(shelf(host)).not.toBeNull();
  return more;
}

const pressEscape = () => flushSync(() => {
  dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
});

test("mobile: a terminal shelf action closes the modal, unlocks the body, and restores focus — nested disclosures keep it open", async () => {
  const host = mount();
  const opener = await openShelf(host);
  /* The modal locks body scroll and takes focus. */
  expect(dom.document.body.style.overflow).toBe("hidden");

  /* Two nested INTERNAL disclosures inside the readiness strip must keep the
     shelf open (they reveal content within the sheet, they do not navigate). */
  const strip = q(host, '[data-testid="task-readiness"]');
  expect(strip).not.toBeNull();
  const stripToggle = strip!.querySelector('button[aria-label="Readiness sections for every project task"]') as unknown as HTMLElement;
  flushSync(() => stripToggle.click());
  expect(shelf(host)).not.toBeNull();
  /* Expand every readiness section (the task lands in exactly one) — each is an
     internal disclosure that must keep the modal open. */
  for (const sectionToggle of [...strip!.querySelectorAll('[data-readiness-section] > button')] as unknown as HTMLElement[]) {
    flushSync(() => sectionToggle.click());
  }
  expect(shelf(host)).not.toBeNull();
  expect(dom.document.body.style.overflow).toBe("hidden");

  /* The TERMINAL action (open the task on the board) closes the modal. */
  const openBtn = [...strip!.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Open task on the board:")) as unknown as HTMLElement;
  expect(openBtn).toBeTruthy();
  flushSync(() => openBtn.click());
  expect(shelf(host)).toBeNull();
  /* Body scroll unlocked. The menu row that opened the sheet left with its
     menu, so focus has no opener to return to; the bar's ⋯ is still there. */
  expect(dom.document.body.style.overflow).toBe("");
  expect(opener.isConnected).toBe(true);
  await settle();
});

test("mobile: Escape closes the shelf and unlocks the body", async () => {
  const host = mount();
  const opener = await openShelf(host);
  expect(dom.document.body.style.overflow).toBe("hidden");
  pressEscape();
  expect(shelf(host)).toBeNull();
  expect(dom.document.body.style.overflow).toBe("");
  expect(opener.isConnected).toBe(true);
  await settle();
});

test("mobile: the project name is the bar's title cell and the host sheet stays one row behind ⋯ (finding 2)", async () => {
  const host = mount();
  const ready = await waitFor(() => boardReady(host));
  expect(ready).toBe(true);
  /* The bar's title cell is the ONE elastic cell (mobile v2 §3.2): the name
     reads in full, truncating only as the last resort. */
  const title = q(host, "[data-mobile2-title]")!;
  expect(title.textContent).toContain("atlas");
  expect(title.className).toContain("min-w-0");
  expect(title.className).toContain("flex-1");
  expect(q(host, "[data-mobile2-title-text]")!.className).toContain("truncate");
  /* Host access is one row behind the bar's ⋯: a 44px row, exactly one. */
  flushSync(() => menuTrigger(host)!.click());
  const rows = host.querySelectorAll('[data-mobile2-open="host"]');
  expect(rows.length).toBe(1);
  expect((rows[0] as unknown as HTMLElement).className).toContain("min-h-11");
  await settle();
});

test("desktop: the readiness strip renders inline with no shelf modal, no bar and no menu", async () => {
  mobile = false;
  const host = mount();
  const ready = await waitFor(() => q(host, '[data-testid="task-readiness"]') !== null);
  expect(ready).toBe(true);
  expect(menuTrigger(host)).toBeNull();
  expect(q(host, "[data-mobile2-bar]")).toBeNull();
  expect(shelf(host)).toBeNull();
  await settle();
});

test("desktop and mobile global pipeline actions submit the operator draft shape", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const surface of ["desktop", "mobile"] as const) {
      mobile = surface === "mobile";
      const posts: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pipelines/preflight") {
          return new Response(JSON.stringify({
            ok: true,
            repoDir: process.cwd(),
            gitCommonDir: `${process.cwd()}/.git`,
            worktreeParent: process.cwd(),
          }));
        }
        if (url === "/api/pipelines") {
          posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ pipeline: { id: `pipeline-${surface}` } }), { status: 201 });
        }
        const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
        return new Response(JSON.stringify(body));
      }) as typeof fetch;

      const host = mount();
      if (surface === "mobile") {
        /* ⋯ on the bar, then the «New pipeline» row (mobile v2 lane 1). */
        flushSync(() => (host.querySelector('[data-mobile2-open="menu"]') as HTMLButtonElement).click());
        const pipelineItem = host.querySelector('[data-mobile2-menu-row="new-pipeline"]') as HTMLButtonElement;
        expect(pipelineItem).not.toBeNull();
        flushSync(() => pipelineItem.click());
      } else {
        const pipelineButton = host.querySelector(`[aria-label="${translate("en", "dash.newPipeline")}"]`) as HTMLButtonElement;
        flushSync(() => pipelineButton.click());
      }

      expect(await waitFor(() => host.querySelector('[data-pipeline-picker-state="ready"]') !== null)).toBe(true);
      const blank = [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes(translate("en", "pipelineTemplates.blank")))!;
      flushSync(() => blank.click());
      expect(await waitFor(() => posts.length === 1)).toBe(true);
      expect(posts).toEqual([expect.objectContaining({
        autoStart: false,
        repoDir: process.cwd(),
        stages: expect.any(Array),
      })]);
      expect(posts[0]).not.toHaveProperty("src");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
