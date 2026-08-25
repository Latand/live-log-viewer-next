import { afterAll, beforeEach, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { chromium, type Browser } from "playwright-core";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

/**
 * Browser-rendered evidence for issue #613: at a 390x844 phone viewport the
 * project header row (hamburger, project name, undo, view switch, hidden shelf,
 * create and «more» menus) pushed the document to 422px — a 32px horizontal
 * page scroll, with the «More actions» trigger hanging off the right edge.
 *
 * It also holds the budget for everything added since. Fitting is necessary but
 * not sufficient: a row can fit at 390px and still be useless, because the ONE
 * elastic cell absorbs every overrun. Global search as a SIXTH 44px target
 * measured here at a 25px project name — «l…» — so this now asserts a readable
 * floor for that cell, and search's slot came from folding undo into the «⋯»
 * menu (issue #1054 review).
 *
 * The header now fits BY CONSTRUCTION: every always-mounted control is a fixed
 * 44px target, the ONE elastic cell is the project name (the filler beside it is
 * an empty spacer that collapses to nothing first, and the attention pill holds
 * its own width), and the scheme/list switch is one tap inside the «more» menu
 * instead of a 94px inline segmented pair. The budget itself is documented at
 * the header in ProjectDashboard.tsx. This renders the REAL ProjectDashboard
 * with a populated board and measures the production CSS in Chromium, exactly as
 * the issue's repro did.
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

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "issue-613");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

function productionCss(): string {
  const files = fs.existsSync(CSS_DIR) ? fs.readdirSync(CSS_DIR).filter((name) => name.endsWith(".css")) : [];
  return files.map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8")).join("\n");
}

const dom = new Window({ url: "http://localhost/" });
installActEnv();
/* The phone face: useIsMobile reads window.matchMedia off the dom itself. */
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (q: string) => ({
  matches: /max-width|pointer: coarse/.test(String(q)),
  media: String(q),
  onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

let browser: Browser;

/* A long project name and a long conversation title — the two strings that used
   to push the layout wide. Synthetic, no operator content. */
const PROJECT = "live-log-viewer-next-mobile";
const TITLE = "Builder · keep the conversation header inside a 390px viewport (#613)";

const conversation: FileEntry = {
  path: "/repo/worktrees/mobile-header/0f1e2d3c.jsonl",
  root: "claude-projects",
  name: "0f1e2d3c.jsonl",
  project: PROJECT,
  title: TITLE,
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 9_000,
  size: 4_096,
  activity: "live",
  proc: null,
  pid: null,
  model: "claude-opus-4-8",
  effort: "high",
  ctx: 62,
  renamable: true,
  conversationId: "conversation_613mobile",
  pendingQuestion: null,
  waitingInput: null,
} as unknown as FileEntry;

const task: BoardTask = {
  id: "t-613", project: PROJECT, status: "inbox", text: "Keep the header inside 390px",
  placement: "pinned", pos: { x: 720, y: 140 }, assignments: [],
  createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
} as unknown as BoardTask;

const ATTENTION_LABEL = translate("en", "attention.badge", { count: 3 });
/* The production attention badge as Viewer renders it on the phone: a bounded
   «⚠ N» pill whose button opens the queue. It is an action, so it must survive
   a full header at 390px. */
const attentionBadge = (
  <div className="pointer-events-auto relative">
    <div className="flex items-center overflow-hidden rounded-full border border-warning/45 bg-warning-soft shadow-1">
      <button type="button" className="inline-flex min-h-11 items-center px-3.5 text-[12px] font-bold text-warning" aria-label={ATTENTION_LABEL}>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3" aria-hidden />3
        </span>
      </button>
    </div>
  </div>
);

const dashboardProps = () => ({
  files: [conversation], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  /* Both view faces available → the scheme/list switch is offered. */
  catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {},
  onMenu: () => {},
  onOpenSearch: () => {},
  attention: attentionBadge,
});

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

beforeEach(() => {
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  /* A closed card in the device-local log → the header offers undo (#184). */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/repo/closed.jsonl", title: "Closed card" }], cursor: 1 }),
  );
  setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
});
afterAll(async () => {
  await browser?.close();
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
};

const CSS = productionCss();

function pageHtml(inner: string, width: number): string {
  /* No clipping wrapper: the host is exactly the phone viewport, so any header
     overflow reaches the document, which is what production measured. */
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
    html,body{margin:0;padding:0;background:var(--color-canvas,#fff);}
    #evidence-host{display:flex;flex-direction:column;width:${width}px;height:100vh;}
    </style></head><body><div id="evidence-host">${inner}</div></body></html>`;
}

interface Box { label: string; left: number; right: number; width: number; height: number }
interface Geometry {
  scrollWidth: number;
  bodyScrollWidth: number;
  viewportWidth: number;
  headerScrollWidth: number;
  headerClientWidth: number;
  controls: Box[];
  titleText: string;
  titleWidth: number;
  /* The focused conversation's own header (BranchPane) inside the same phone. */
  paneControls: Box[];
  paneHeaderScrollWidth: number;
  paneHeaderClientWidth: number;
  paneTitleText: string;
}

const VIEWPORT = { width: 390, height: 844 };

async function measure(inner: string, key: string): Promise<Geometry> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.setContent(pageHtml(inner, VIEWPORT.width), { waitUntil: "load" });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${key}.html`), pageHtml(inner, VIEWPORT.width));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}.png`) });
  const geometry = await page.evaluate(() => {
    const collect = (root: Element | null): Box[] => {
      const boxes: Box[] = [];
      for (const node of Array.from(root?.querySelectorAll("button, [role='menuitem'], [role='menuitemradio'], a") ?? [])) {
        const el = node as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        boxes.push({
          label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "",
          left: rect.left, right: rect.right, width: rect.width, height: rect.height,
        });
      }
      return boxes;
    };
    const header = document.querySelector("[data-testid='mobile-project-header']") as HTMLElement | null;
    const paneHeader = document.querySelector("[data-testid='mobile-focused-pane'] header") as HTMLElement | null;
    const title = header?.querySelector("h1") as HTMLElement | null;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      headerScrollWidth: header?.scrollWidth ?? -1,
      headerClientWidth: header?.clientWidth ?? -1,
      controls: collect(header),
      titleText: title?.textContent ?? "",
      titleWidth: title?.getBoundingClientRect().width ?? -1,
      paneControls: collect(paneHeader),
      paneHeaderScrollWidth: paneHeader?.scrollWidth ?? -1,
      paneHeaderClientWidth: paneHeader?.clientWidth ?? -1,
      paneTitleText: (paneHeader?.querySelector("[role='button']") as HTMLElement | null)?.textContent ?? "",
    } as Geometry;
  });
  await page.close();
  return geometry;
}

async function renderDashboard(openMoreMenu: boolean): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ProjectDashboard {...dashboardProps()} />); });
  await settle();
  if (openMoreMenu) {
    const trigger = host.querySelector(
      `[data-testid="mobile-project-header"] button[aria-label="${translate("en", "dash.moreMenu")}"]`,
    ) as unknown as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    await settle();
  }
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

test("issue 613: the populated phone header fits a 390px viewport with every control reachable", async () => {
  expect(CSS.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });

  const closed = await measure(await renderDashboard(false), "header-390");

  /* The acceptance measurement from the issue: no page-level horizontal scroll. */
  expect(closed.viewportWidth).toBe(390);
  expect(closed.scrollWidth).toBeLessThanOrEqual(390);
  expect(closed.bodyScrollWidth).toBeLessThanOrEqual(390);
  /* And the header row itself is not internally clipped — it FITS, so nothing
     hides behind an invisible edge. */
  expect(closed.headerScrollWidth).toBeLessThanOrEqual(closed.headerClientWidth);

  /* Every control the row still owns is inside the viewport at a 44px target. */
  expect(closed.controls.length).toBeGreaterThanOrEqual(6);
  for (const control of closed.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
  }
  const labels = closed.controls.map((control) => control.label);
  for (const key of ["dash.openProjects", "search.openMobile", "dash.hiddenShelf", "dash.createMenu", "dash.moreMenu"] as const) {
    expect(labels.some((label) => label.startsWith(translate("en", key).slice(0, 12)))).toBe(true);
  }
  /* Five targets, not six: undo folded into the «⋯» menu when search arrived. */
  expect(closed.controls.filter((control) => control.label !== ATTENTION_LABEL)).toHaveLength(5);
  expect(labels.some((label) => label.startsWith(translate("en", "board.undo").slice(0, 12)))).toBe(false);
  /* The attention-queue badge is an action, so a full row must not squeeze it
     out of existence — it is no longer elastic (before #613 it rode the
     flex-1 filler and collapsed to zero px here). */
  expect(labels).toContain(ATTENTION_LABEL);

  /* The long project name truncates instead of pushing the row wide — and is
     still READABLE while doing it. The budget's own arithmetic leaves it ~73px
     on a fully populated 390px row; a sixth 44px target cut that to 25px, which
     renders as a single letter and an ellipsis. 60px is the floor that keeps a
     name a name. */
  expect(closed.titleText.length).toBeGreaterThan(0);
  expect(closed.titleWidth).toBeGreaterThanOrEqual(60);

  /* The focused conversation's own header sits in the same 390px: its long
     title truncates and every pane control (rename, details, favorite, delete,
     close) stays on screen at a 44px target rather than behind the clip. */
  expect(closed.paneControls.length).toBeGreaterThanOrEqual(5);
  expect(closed.paneHeaderScrollWidth).toBeLessThanOrEqual(closed.paneHeaderClientWidth);
  for (const control of closed.paneControls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(closed.paneTitleText.length).toBeGreaterThan(0);

  /* Nothing was dropped: the scheme/list switch moved into the «more» menu and
     both faces are one tap away there, still inside the viewport. */
  const opened = await measure(await renderDashboard(true), "header-390-more-open");
  const openLabels = opened.controls.map((control) => control.label);
  expect(openLabels).toContain(translate("en", "dash.viewSchemeMenu"));
  expect(openLabels).toContain(translate("en", "dash.viewListMenu"));
  /* And neither is board undo: it is one tap away in the same menu. */
  expect(openLabels).toContain(translate("en", "board.undo"));
  expect(opened.scrollWidth).toBeLessThanOrEqual(390);
  for (const control of opened.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "geometry.json"),
    JSON.stringify({ "header-390": closed, "header-390-more-open": opened }, null, 2),
  );
});
