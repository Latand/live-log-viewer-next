import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { chromium, type Browser } from "playwright-core";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/**
 * Browser-rendered evidence for issues #1347 and #1348, at a 390×844 phone
 * viewport, in BOTH colour schemes, against the production CSS:
 *
 *   bun run build && bun test src/components/mobile/issue1347Evidence.browser.test.tsx
 *
 * #1348 — the rename editor. The operator tapped the pencil and got a field
 * with no visible text. Happy-dom does no layout, so the claim that the field
 * now has real width, real ink and a real caret is settled here: the REAL
 * `MobileFocusView` is rendered, rename is opened THROUGH THE PRODUCT'S OWN
 * ROUTE, and Chromium measures the input's box, its computed colour against
 * its surface, its caret colour and its font size — and that a long title
 * scrolls INSIDE the field rather than pushing the row wide.
 *
 * That route moved with mobile v2 lane 3 (README §4.2): the phone's pane header
 * is gone, so rename is a labelled row in the conversation's `⋯` and its editor
 * lays over the shell BAR (`[data-testid="mobile-rename-slot"]`) instead of
 * inside a pane header. The measurement is the same one, taken where the field
 * now lives; `SessionTitle.mobile.dom.test.tsx` pins the route, this pins the
 * geometry.
 *
 * #1347 — the orchestrator controls. The seat card's entry point and the
 * sheet's Rotate control are measured as 44px targets inside the viewport, the
 * rotate draft's two footer actions likewise, and the card keeps the board's
 * own first row above the fold. Lane 3 took the row off the conversation
 * screen with the rest of the strip and lane 6 made it the board's first CARD
 * (`mobile-orchestrator-slot`), so it is measured where it now lives, inside
 * the REAL `ProjectDashboard` board leaf rather than in markup copied out of
 * it. The keyboard-open case is a live measurement and lives in
 * `scripts/capture-issue-979-mobile-orchestrator.ts`.
 *
 * Every measurement is written to `evidence/issue-1347-1348/geometry.json`;
 * the frames and HTML beside it are regenerated on demand and not committed.
 */

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
  refreshRuntime: () => Promise.resolve(false),
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "issue-1347-1348");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

function productionCss(): string {
  const files = fs.existsSync(CSS_DIR) ? fs.readdirSync(CSS_DIR).filter((name) => name.endsWith(".css")) : [];
  return files.map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8")).join("\n");
}

const dom = new Window({ url: "http://localhost/", innerWidth: 390, innerHeight: 844 });
installActEnv();
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (q: string) => ({
  matches: /max-width|pointer: coarse/.test(String(q)),
  media: String(q),
  onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const seat = {
  project: "atlas", seatEpoch: 4, conversationId: "conversation_orchestrator", path: "/repo/atlas/orchestrator.jsonl",
  mandate: "You run the Atlas board. Talk to me here, directly, whenever you have something worth saying.",
  promptVersion: 3, predecessorConversationId: "conversation_predecessor", state: "active",
  intent: { clientRequestId: "seatreq-0001", mode: "spawn", launchId: "launch-0001", error: null },
  designatedAt: "2100-01-02T11:00:00.000Z", activatedAt: "2100-01-02T11:00:02.000Z",
};
const incumbent = {
  project: "atlas", designated: true, conversationId: "conversation_orchestrator", predecessorConversationId: "conversation_predecessor",
  engine: "claude", model: "opus", effort: "high", accountId: "spare", cwd: "/repo/atlas/worktrees/board",
  transcriptPath: "/repo/atlas/orchestrator.jsonl",
  liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 },
  context: { tokens: 24_000, limit: 100_000, percent: 24, estimated: false, basis: "provider-reported usage" },
  transcriptFacts: { bytes: 4_096, messageCount: 12, toolCount: 3, compactionCount: 0 },
  rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
};
const accounts = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: true }] },
  codex: { active: "", accounts: [] },
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/orchestrator/seat/status")) return json(incumbent);
  if (url.startsWith("/api/orchestrator/seat")) return json({ seat, pending: null, exists: true });
  if (url.startsWith("/api/accounts")) return json(accounts);
  return json({});
}) as typeof fetch;

const { MobileFocusView } = await import("./MobileFocusView");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { resetOrchestratorSeatCacheForTests } = await import("../orchestrator/useOrchestratorSeat");
const { resetOrchestratorIncumbentCacheForTests } = await import("../orchestrator/useOrchestratorIncumbent");

let browser: Browser;

/* Synthetic, no operator content: a long conversation title — the string that
   has to scroll inside the editor — and the seat conversation. */
const LONG_TITLE = "Builder · keep every orchestrator control reachable from a 390px phone viewport, and make the rename editor legible";

function conversation(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/repo/atlas/other.jsonl", root: "claude-projects", name: "other.jsonl", project: "atlas", title: "Some other work",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 100, size: 1, activity: "live",
    proc: "running", pid: 3, conversationId: "conversation_other", model: "sonnet", cwd: "/repo/atlas", projectRoot: "/repo/atlas",
    renamable: true, effort: "high",
    pendingQuestion: null, waitingInput: null,
    ...over,
  } as unknown as FileEntry;
}
const focused = conversation({ path: "/repo/atlas/focused.jsonl", name: "focused.jsonl", conversationId: "conversation_focused", title: LONG_TITLE, mtime: 200 });
const orchestrator = conversation({ path: "/repo/atlas/orchestrator.jsonl", name: "orchestrator.jsonl", conversationId: "conversation_orchestrator", title: "Run the Atlas board", model: "opus", mtime: 10 });

/* The phone as the Viewer wires it (`issue613Evidence` mounts the same shape):
   the board leaf is what `ProjectDashboard` renders with no conversation on the
   navigation stack, and the seat slot is inside it. */
const dashboardProps = (files: FileEntry[]) => ({
  files,
  flows: [],
  pipelines: [],
  workflows: [],
  tasks: [],
  project: "atlas",
  projectName: "atlas",
  projectCwd: "/repo/atlas",
  loaded: true,
  openNonce: 0,
  archived: false,
  catalogKnown: true,
  catalogConversationCount: files.length,
  onArchive: () => undefined,
  onUnarchive: () => undefined,
  onOpenSearch: () => undefined,
  mobileShell: { attentionCount: 0, arrival: null, renderSheet: () => null },
});

const view = (files: FileEntry[], focus: string) => (
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
    focus={focus}
    onSelect={() => undefined}
    onClose={() => undefined}
    onDraftClose={() => undefined}
    onDraftSpawned={() => undefined}
  />
);

beforeEach(() => {
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  resetOrchestratorSeatCacheForTests();
  resetOrchestratorIncumbentCacheForTests();
  setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
});
afterAll(async () => {
  await browser?.close();
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

const settle = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  }
};

const CSS = productionCss();
const VIEWPORT = { width: 390, height: 844 };

function pageHtml(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${CSS}
    html,body{margin:0;padding:0;background:var(--color-canvas,#fff);}
    #evidence-host{display:flex;flex-direction:column;width:${VIEWPORT.width}px;height:100vh;}
    </style></head><body><div id="evidence-host">${inner}</div></body></html>`;
}

interface Box { label: string; left: number; right: number; top: number; bottom: number; width: number; height: number }
interface EditorGeometry {
  scheme: "light" | "dark";
  viewportWidth: number;
  scrollWidth: number;
  /* The row the editor lays over: the shell bar, since lane 3 (§3.4). */
  barScrollWidth: number;
  barClientWidth: number;
  editor: Box | null;
  input: Box | null;
  inputValueLength: number;
  inputScrollWidth: number;
  inputClientWidth: number;
  fontSizePx: number;
  color: string;
  background: string;
  caretColor: string;
  contrast: number;
  controls: Box[];
}
interface ControlsGeometry {
  scheme: "light" | "dark";
  scrollWidth: number;
  cardBox: Box | null;
  firstRowBottom: number;
  rowOpen: Box | null;
  rowControls: Box | null;
  sheet: { rotate: Box | null; identityText: string; contextLeft: string | null; predecessor: boolean; mandateView: boolean } | null;
  rotateDraft: { confirm: Box | null; cancel: Box | null; mandate: Box | null; scrollerBottom: number } | null;
}

async function withPage<T>(inner: string, key: string, scheme: "light" | "dark", measure: (page: import("playwright-core").Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: scheme });
  await page.setContent(pageHtml(inner), { waitUntil: "load" });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${key}-${scheme}.html`), pageHtml(inner));
  const result = await measure(page);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}-${scheme}.png`) });
  await page.close();
  return result;
}

/* WCAG relative luminance from a CSS `rgb(a)` string, for the ink-on-surface
   contrast the operator's «no visible text» complaint is ultimately about. */
function luminance(css: string): number {
  const parts = css.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  const [r, g, b] = parts.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const BOX = `(el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "", left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }`;

async function measureEditor(page: import("playwright-core").Page, scheme: "light" | "dark", title: string): Promise<EditorGeometry> {
  const raw = await page.evaluate(({ boxSource, value }) => {
    const box = new Function("return " + boxSource)() as (el: Element) => Box;
    const bar = document.querySelector("[data-mobile2-bar]") as HTMLElement | null;
    const editor = document.querySelector("[data-testid='mobile-rename-slot'] [data-session-title-editor]") as HTMLElement | null;
    const input = editor?.querySelector("input[aria-label='Session title']") as HTMLInputElement | null;
    /* React writes the value as a property, which the static markup does not
       carry: put the title back so the field measures what the phone shows. */
    if (input) input.value = value;
    const style = input ? getComputedStyle(input) : null;
    const controls: Box[] = [];
    for (const node of Array.from(editor?.querySelectorAll("button") ?? [])) controls.push(box(node));
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      barScrollWidth: bar?.scrollWidth ?? -1,
      barClientWidth: bar?.clientWidth ?? -1,
      editor: editor ? box(editor) : null,
      input: input ? box(input) : null,
      inputValueLength: input?.value.length ?? 0,
      inputScrollWidth: input?.scrollWidth ?? -1,
      inputClientWidth: input?.clientWidth ?? -1,
      fontSizePx: style ? parseFloat(style.fontSize) : -1,
      color: style?.color ?? "",
      background: style?.backgroundColor ?? "",
      caretColor: style?.caretColor ?? "",
      controls,
    };
  }, { boxSource: BOX, value: title });
  return { scheme, ...raw, contrast: contrast(raw.color, raw.background) };
}

async function measureControls(page: import("playwright-core").Page, scheme: "light" | "dark"): Promise<ControlsGeometry> {
  const raw = await page.evaluate(({ boxSource }) => {
    const box = new Function("return " + boxSource)() as (el: Element) => Box;
    const card = document.querySelector("[data-mobile2-seat-card]");
    const open = document.querySelector("[data-mobile2-seat-open]");
    const controls = document.querySelector("[data-mobile2-seat-controls]");
    const body = document.querySelector("[data-testid='mobile-orchestrator-sheet']");
    /* The seat's two controls are the sheet's FOOTER, outside its scrolling
       body, so they are looked up on the document. */
    const rotate = document.querySelector("[data-orchestrator-rotate]");
    const draft = document.querySelector("[data-orchestrator-draft='rotate']");
    /* What the card leads on the board: the first conversation row under it. */
    const firstRow = document.querySelector("[data-mobile2-row='conversation']");
    return {
      scrollWidth: document.documentElement.scrollWidth,
      cardBox: card ? box(card) : null,
      firstRowBottom: firstRow ? Math.round(firstRow.getBoundingClientRect().bottom) : -1,
      rowOpen: open ? box(open) : null,
      rowControls: controls ? box(controls) : null,
      sheet: body ? {
        rotate: rotate ? box(rotate) : null,
        identityText: body.querySelector("[data-orchestrator-incumbent]")?.textContent ?? "",
        contextLeft: body.querySelector("[data-mobile2-seat-context]")?.getAttribute("data-mobile2-seat-context") ?? null,
        predecessor: Boolean(body.querySelector("[data-orchestrator-predecessor]")),
        mandateView: Boolean(body.querySelector("[data-orchestrator-mandate-view]")),
      } : null,
      rotateDraft: draft ? {
        confirm: document.querySelector("[data-orchestrator-confirm]") ? box(document.querySelector("[data-orchestrator-confirm]")!) : null,
        cancel: document.querySelector("[data-orchestrator-rotate-cancel]") ? box(document.querySelector("[data-orchestrator-rotate-cancel]")!) : null,
        mandate: document.querySelector("[data-orchestrator-mandate]") ? box(document.querySelector("[data-orchestrator-mandate]")!) : null,
        scrollerBottom: draft.getBoundingClientRect().bottom,
      } : null,
    };
  }, { boxSource: BOX });
  return { scheme, ...raw };
}

async function renderFocusView(files: FileEntry[], focus: string, drive: (host: HTMLElement) => Promise<void>): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(view(files, focus)); });
  await settle();
  await drive(host as unknown as HTMLElement);
  await settle();
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

/* The seat's pinned row where the phone actually puts it: the slot the BOARD
   LEAF gives it, rendered by the real `ProjectDashboard` on a real phone
   viewport. This used to render markup hand-copied from that call site, and
   the copy had drifted onto the catalog leaf's fallback slot — a different
   wrapper, a different width — so the geometry was the test measuring itself
   rather than the screen an operator opens. Nothing about the row is
   constructed here now; the product mounts it, and the drive below reaches it
   the way a finger does. */
async function renderBoardSeat(files: FileEntry[], drive: (host: HTMLElement) => Promise<void>): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ProjectDashboard {...dashboardProps(files)} />); });
  await settle();
  /* The row is the product's, in the product's slot, on the board leaf. */
  expect(host.querySelector("[data-testid='mobile-orchestrator-slot'] [data-mobile2-seat-card]")).not.toBeNull();
  await drive(host as unknown as HTMLElement);
  await settle();
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

const click = async (host: HTMLElement, selector: string) => {
  const target = host.querySelector(selector) as HTMLButtonElement | null;
  expect(target, selector).not.toBeNull();
  await act(async () => { target!.click(); });
  await settle();
};

test("issues 1347 + 1348: the phone's rename editor and orchestrator controls measure as usable at 390px in both themes", async () => {
  expect(CSS.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });

  /* ---- #1348: the rename editor over the shell bar --------------------- */
  const editorHtml = await renderFocusView([conversation({}), focused, orchestrator], focused.path, async (host) => {
    /* The product's own route since lane 3: `⋯`, then the Rename row. */
    await click(host, "[data-mobile2-open='menu']");
    await click(host, "[data-testid='mobile-menu-rename']");
    expect(host.querySelector("[data-testid='mobile-rename-slot'] input[aria-label='Session title']")).not.toBeNull();
  });
  const editors: EditorGeometry[] = [];
  for (const scheme of ["light", "dark"] as const) {
    const geometry = await withPage(editorHtml, "rename-editor", scheme, (page) => measureEditor(page, scheme, LONG_TITLE));
    editors.push(geometry);
    /* The page never scrolls sideways, and the row the editor lays over — the
       shell bar — is not clipped underneath it. */
    expect(geometry.scrollWidth).toBeLessThanOrEqual(390);
    expect(geometry.barClientWidth).toBeGreaterThan(0);
    expect(geometry.barScrollWidth).toBeLessThanOrEqual(geometry.barClientWidth);
    /* The field has REAL width — the whole complaint — inside the viewport,
       and a long title scrolls within it instead of widening the row. */
    expect(geometry.input).not.toBeNull();
    expect(geometry.input!.width).toBeGreaterThanOrEqual(160);
    expect(geometry.input!.left).toBeGreaterThanOrEqual(0);
    expect(geometry.input!.right).toBeLessThanOrEqual(390);
    expect(geometry.input!.height).toBeGreaterThanOrEqual(44);
    expect(geometry.inputValueLength).toBe(LONG_TITLE.length);
    expect(geometry.inputScrollWidth).toBeGreaterThan(geometry.inputClientWidth);
    /* Legible in this theme: ink against surface at the AA text floor, a caret
       that is not transparent, and type the phone will not zoom. */
    expect(geometry.contrast).toBeGreaterThanOrEqual(4.5);
    expect(geometry.caretColor).not.toMatch(/rgba\(\s*0,\s*0,\s*0,\s*0\)|transparent/);
    expect(geometry.caretColor).not.toBe(geometry.background);
    expect(geometry.fontSizePx).toBeGreaterThanOrEqual(16);
    /* Save and Cancel stay inside the same row at phone targets. */
    expect(geometry.controls.length).toBeGreaterThanOrEqual(2);
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(390);
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.width).toBeGreaterThanOrEqual(44);
    }
  }

  /* ---- #1347: the pinned row's entry point, the sheet, the rotate draft --- */
  const files = [conversation({}), orchestrator];
  const rowHtml = await renderBoardSeat(files, async (host) => {
    expect(host.querySelector("[data-mobile2-seat-card]")?.getAttribute("data-mobile2-seat-state")).toBe("live");
  });
  const sheetHtml = await renderBoardSeat(files, async (host) => {
    await click(host, "[data-mobile2-seat-controls]");
    expect(host.querySelector("[data-orchestrator-rotate]")).not.toBeNull();
  });
  const rotateHtml = await renderBoardSeat(files, async (host) => {
    await click(host, "[data-mobile2-seat-controls]");
    await click(host, "[data-orchestrator-rotate]");
    await settle(4);
    expect(host.querySelector("[data-orchestrator-draft='rotate']")).not.toBeNull();
  });

  const controls: Record<string, ControlsGeometry[]> = { row: [], sheet: [], rotate: [] };
  for (const scheme of ["light", "dark"] as const) {
    const row = await withPage(rowHtml, "orchestrator-row", scheme, (page) => measureControls(page, scheme));
    controls.row!.push(row);
    expect(row.scrollWidth).toBeLessThanOrEqual(390);
    /* The entry point: a 44px target on the row, inside the viewport, right
       after the chip that opens the seat's conversation. */
    expect(row.rowControls).not.toBeNull();
    expect(row.rowControls!.width).toBeGreaterThanOrEqual(44);
    expect(row.rowControls!.height).toBeGreaterThanOrEqual(44);
    expect(row.rowControls!.left).toBeGreaterThanOrEqual(0);
    expect(row.rowControls!.right).toBeLessThanOrEqual(390);
    expect(row.rowOpen!.right).toBeLessThanOrEqual(row.rowControls!.left + 1);
    /* What #419's budget asked of the pin — «do not eat the surface you lead»
       — moved with the seat (mobile v2 §3.4, §4.1). The card is the board's
       first card, not a row on the conversation screen, so what it must not do
       is push the board's own first row past the fold. */
    expect(row.cardBox).not.toBeNull();
    expect(row.cardBox!.top).toBeGreaterThanOrEqual(0);
    expect(row.cardBox!.right).toBeLessThanOrEqual(390);
    expect(row.firstRowBottom).toBeGreaterThan(row.cardBox!.bottom);
    expect(row.firstRowBottom).toBeLessThanOrEqual(844);

    const sheet = await withPage(sheetHtml, "orchestrator-sheet-live", scheme, (page) => measureControls(page, scheme));
    controls.sheet!.push(sheet);
    expect(sheet.sheet).not.toBeNull();
    expect(sheet.sheet!.rotate).not.toBeNull();
    expect(sheet.sheet!.rotate!.height).toBeGreaterThanOrEqual(44);
    expect(sheet.sheet!.rotate!.left).toBeGreaterThanOrEqual(0);
    expect(sheet.sheet!.rotate!.right).toBeLessThanOrEqual(390);
    expect(sheet.sheet!.rotate!.bottom).toBeLessThanOrEqual(844);
    expect(sheet.sheet!.identityText).toContain("opus");
    expect(sheet.sheet!.identityText).toContain("spare");
    /* The meter and its words read what REMAINS (README §5): 24 % used is
       76 % left. */
    expect(sheet.sheet!.contextLeft).toBe("76");
    expect(sheet.sheet!.predecessor).toBe(true);
    expect(sheet.sheet!.mandateView).toBe(true);

    const rotate = await withPage(rotateHtml, "orchestrator-sheet-rotate", scheme, (page) => measureControls(page, scheme));
    controls.rotate!.push(rotate);
    expect(rotate.rotateDraft).not.toBeNull();
    for (const control of [rotate.rotateDraft!.confirm, rotate.rotateDraft!.cancel]) {
      expect(control).not.toBeNull();
      expect(control!.height).toBeGreaterThanOrEqual(44);
      expect(control!.left).toBeGreaterThanOrEqual(0);
      expect(control!.right).toBeLessThanOrEqual(390);
      expect(control!.bottom).toBeLessThanOrEqual(844);
    }
    /* The mandate is on screen in the draft's own scroller. (What it and the
       pickers are PREFILLED with is a property React writes, which static
       markup does not carry — the DOM suite pins the prefill.) */
    expect(rotate.rotateDraft!.mandate).not.toBeNull();
    expect(rotate.rotateDraft!.mandate!.top).toBeLessThan(rotate.rotateDraft!.scrollerBottom);
  }

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "geometry.json"),
    JSON.stringify({ viewport: VIEWPORT, "rename-editor": editors, "orchestrator-controls": controls }, null, 2),
  );
});
