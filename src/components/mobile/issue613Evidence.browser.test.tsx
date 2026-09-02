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
 * Mobile v2 lane 1 (issue #1439) replaced that row with the shell's bar: the
 * project name is the ONE elastic cell and at most three 44px targets follow
 * it (the attention badge, search, ⋯), everything else a row in the board
 * menu sheet. The budget it holds is the design's (README §3.2): the title
 * cell keeps at least 190px at 390 with every target present. This renders the
 * REAL ProjectDashboard with a populated board and measures the production CSS
 * in Chromium, exactly as the issue's repro did; `MobileShell.titleCellWidth`
 * is the same arithmetic, and `scripts/capture-mobile-v2.ts` gates the same
 * number on every phone frame.
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

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

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
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    /* A tiny in-memory board API. Opening a board row PLACES the conversation,
       which writes through /api/board; the store folds the answer in and needs
       a real `{ board }` envelope whose revision MOVES, or it re-sends the same
       intent forever. */
    /* The durable board is UNAVAILABLE here: this test measures geometry, not
       persistence, and a write it cannot honour must fail cleanly rather than
       answer with a board that does not carry the intent — which the store
       would re-send forever. Placement is optimistic, so the conversation the
       row opens is on screen either way. */
    if (url.startsWith("/api/board")) {
      if (init?.method && init.method !== "GET") return { ok: false, status: 503, json: async () => ({}), text: async () => "{}" };
      return jsonResponse({});
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    return jsonResponse({});
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

const ATTENTION_LABEL = translate("en", "mobile2.bar.attention", { count: 3 });
/* What the board leaf under that bar must carry at minimum: the live
   conversation as a Working row, and «All conversations · n» closing the
   list. The seat card sits above them and adds its own. */
const BOARD_ROWS = 2;
/* The title too long for the header this test was written about, now a row
   title (`cleanTitle` drops the issue number's #). */
const ROW_TITLE = "keep the conversation header inside a 390px viewport";

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { TITLE_MIN_PX } = await import("@/components/mobile/MobileShell");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;
/* The shell's host as Viewer wires it on the phone: three items need the
   operator, so the bar carries the badge — the one target that is not 44 wide. */
const mobileShell: MobileShellHost = { attentionCount: 3, arrival: null, renderSheet: () => null };

const dashboardProps = () => ({
  files: [conversation], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  /* Both view faces available → the board's two faces are offered in the menu. */
  catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {},
  onOpenSearch: () => {},
  mobileShell,
});

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
  /* The board menu sheet's rows, when it is open. */
  menuControls: Box[];
  /* The board leaf's own rows (mobile v2 lane 2) inside the same phone. */
  rows: Box[];
  boardScrollWidth: number;
  boardClientWidth: number;
  rowTitles: string[];
  /* Whether a conversation pane is what the phone opened on. */
  focusedPane: boolean;
  /* Controls inside the focused pane's own header row, if it still had one. */
  paneControls: Box[];
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
    const header = document.querySelector("[data-mobile2-bar]") as HTMLElement | null;
    const board = document.querySelector("[data-mobile2-board]") as HTMLElement | null;
    const title = header?.querySelector("[data-mobile2-title]") as HTMLElement | null;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      headerScrollWidth: header?.scrollWidth ?? -1,
      headerClientWidth: header?.clientWidth ?? -1,
      controls: collect(header),
      menuControls: collect(document.querySelector("[data-mobile2-sheet='menu']")),
      titleText: title?.textContent ?? "",
      titleWidth: title?.getBoundingClientRect().width ?? -1,
      rows: collect(board),
      boardScrollWidth: board?.scrollWidth ?? -1,
      boardClientWidth: board?.clientWidth ?? -1,
      rowTitles: Array.from(board?.querySelectorAll("[data-mobile2-row]") ?? []).map((row) => (row.textContent ?? "").trim()),
      focusedPane: document.querySelector("[data-testid='mobile-focused-pane']") !== null,
      paneControls: collect(document.querySelector("[data-testid='mobile-focused-pane'] header")),
    } as Geometry;
  });
  await page.close();
  return geometry;
}

/** What the phone is showing when the snapshot is taken: the board leaf, the
    conversation screen a board row pushes (mobile v2 lane 3), and either of
    them with the `⋯` sheet open over it. */
type Face = "board" | "board-menu" | "chat";

async function renderDashboard(face: Face): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ProjectDashboard {...dashboardProps()} />); });
  await settle();
  if (face === "chat") {
    /* The board row is the phone's open gesture: it pushes the conversation
       screen, whose bar is the one this issue was written about. */
    const row = host.querySelector('[data-mobile2-row="conversation"]') as unknown as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    await act(async () => { row!.click(); });
    await settle();
  }
  if (face === "board-menu") {
    const trigger = host.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    await settle();
  }
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

test("issue 613: the populated phone bar fits a 390px viewport with every control reachable and a 190px title cell", async () => {
  expect(CSS.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });

  const closed = await measure(await renderDashboard("board"), "header-390");

  /* The acceptance measurement from the issue: no page-level horizontal scroll. */
  expect(closed.viewportWidth).toBe(390);
  expect(closed.scrollWidth).toBeLessThanOrEqual(390);
  expect(closed.bodyScrollWidth).toBeLessThanOrEqual(390);
  /* And the header row itself is not internally clipped — it FITS, so nothing
     hides behind an invisible edge. */
  expect(closed.headerScrollWidth).toBeLessThanOrEqual(closed.headerClientWidth);

  /* Every control the bar owns is inside the viewport at a 44px target. The
     phone opens on the BOARD (mobile v2 lane 2), so this is the board bar's
     set: the title cell is the project switcher, then the badge, search and
     `⋯` (README §3.2). */
  expect(closed.controls.length).toBe(4);
  for (const control of closed.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
  }
  const labels = closed.controls.map((control) => control.label);
  /* The title cell, then the targets in the design's order. */
  expect(labels[0]).toBe(translate("en", "mobile2.bar.switchProject"));
  expect(labels.slice(1)).toEqual([ATTENTION_LABEL, translate("en", "mobile2.bar.search"), translate("en", "mobile2.bar.more")]);
  /* Nothing from the old five-target row rides the bar. */
  for (const key of ["dash.openProjects", "dash.hiddenShelf", "dash.createMenu", "board.undo"] as const) {
    expect(labels.some((label) => label.startsWith(translate("en", key).slice(0, 12)))).toBe(false);
  }

  /* The long project name truncates inside the ONE elastic cell instead of
     pushing the row wide — and the cell keeps the design's 190px budget. */
  expect(closed.titleText.length).toBeGreaterThan(0);
  expect(closed.titleWidth).toBeGreaterThanOrEqual(TITLE_MIN_PX);

  /* Under this bar the phone opens on the BOARD, not on a conversation
     (mobile v2 lane 2, README §3.3): the conversation header this block used
     to measure — five controls crowded into the same 390px — is gone, and the
     conversation it belonged to is a screen pushed over the list. So the same
     three rules are measured on what the phone actually shows: nothing
     clipped, every target 44px, nothing past the edge. */
  expect(closed.focusedPane).toBe(false);
  expect(closed.boardClientWidth).toBe(390);
  expect(closed.boardScrollWidth).toBeLessThanOrEqual(closed.boardClientWidth);
  expect(closed.rows.length).toBeGreaterThanOrEqual(BOARD_ROWS);
  for (const control of closed.rows) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  /* The long title the old pane header could not hold is a row title now: it
     is on the list whole and truncates inside its own row rather than
     widening the list around it. */
  expect(closed.rowTitles.some((title) => title.includes(ROW_TITLE))).toBe(true);

  /* Nothing was dropped: the board's two faces, undo, accounts and the host
     sheet are rows in the menu sheet, each a 44px row inside the viewport. */
  const opened = await measure(await renderDashboard("board-menu"), "header-390-more-open");
  const openLabels = opened.menuControls.map((control) => control.label);
  expect(openLabels).toContain(translate("en", "mobile2.menu.board"));
  expect(openLabels.some((label) => label.startsWith(translate("en", "mobile2.menu.catalog")))).toBe(true);
  expect(openLabels).toContain(translate("en", "board.undo"));
  expect(openLabels).toContain(translate("en", "mobile2.menu.accounts"));
  expect(openLabels.some((label) => label.startsWith(translate("en", "mobile2.menu.host")))).toBe(true);
  expect(opened.scrollWidth).toBeLessThanOrEqual(390);
  for (const control of opened.menuControls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }

  /* Measured LAST: the conversation is a screen PUSHED on the shell's stack,
     which lives on the window and outlives one React root, so a board face read
     after it would be read through that push.
     The conversation screen (mobile v2 lane 3) is what a row pushes, and its
     bar is the one the issue's screenshot showed crowded: five 44px controls
     and four characters of title. It now carries ‹, the title cell — which IS
     the switcher and holds the whole long title with its state meta line — the
     badge and `⋯`. Search is a `⋯` row here rather than a target of its own
     (README §3.1), and the cell keeps the same 190px budget with ‹ present. */
  const chat = await measure(await renderDashboard("chat"), "chat-390");
  expect(chat.focusedPane).toBe(true);
  expect(chat.scrollWidth).toBeLessThanOrEqual(390);
  expect(chat.headerScrollWidth).toBeLessThanOrEqual(chat.headerClientWidth);
  expect(chat.controls.length).toBe(4);
  for (const control of chat.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
  }
  const chatLabels = chat.controls.map((control) => control.label);
  expect(chatLabels[0]).toBe(translate("en", "mobile2.bar.back"));
  expect(chatLabels[1]).toBe(translate("en", "mobile2.chat.switcher"));
  expect(chatLabels.slice(2)).toEqual([ATTENTION_LABEL, translate("en", "mobile2.bar.more")]);
  expect(chatLabels).not.toContain(translate("en", "mobile2.bar.search"));
  expect(chat.titleText).toContain(ROW_TITLE);
  expect(chat.titleWidth).toBeGreaterThanOrEqual(TITLE_MIN_PX);
  /* And the pane under it renders no header of its own: the bar's title cell
     is the conversation's only name on this screen (§3.4 spends 0px there). */
  expect(chat.paneControls.length).toBe(0);

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "geometry.json"),
    JSON.stringify({ "header-390": closed, "chat-390": chat, "header-390-more-open": opened }, null, 2),
  );
/* Three real Chromium pages, each with the production stylesheet: well past
   bun's 5 s default. */
}, 120_000);
