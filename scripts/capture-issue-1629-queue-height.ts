/**
 * Everything above the input, measured inside the conversation that holds it (#1629).
 *
 *   bun run build && bun scripts/capture-issue-1629-queue-height.ts
 *
 * WHY A SECOND CAPTURE. The sibling `capture-issue-1629-queue-panel.ts` renders
 * the queue panel alone on a page, so nothing above or below it can be wrong: it
 * reads four rows and never meets the composer or the pane that clips it. The
 * defect this file exists for lived exactly there. The composer's form is
 * `shrink-0`, so an unbounded queue grew the form instead of itself: the
 * conversation's feed collapsed and the textarea and the send control were laid
 * out BELOW the pane's bottom edge and clipped away, leaving no way to type or
 * send.
 *
 * And then twice more, one sibling at a time. A repair that bounded the queue
 * left a docked call to push Send out; a repair that bounded the call left the
 * receipt list — six deliveries with no terminal answer, and every control that
 * settles one — at zero height below the pane, while the input, Send and 133px
 * of transcript all read as correct. So what this capture measures is not a
 * height per panel. It is ONE CONTRACT: the composer's box is a share of the
 * conversation, the surfaces above the input share ONE region inside it that
 * yields and scrolls as one, the input unit never yields and is pinned to the
 * box's bottom edge, and the draft's own ceiling reserves the region's room out
 * of the same budget.
 *
 * So this mounts the ASSEMBLED conversation — `BranchPane` at a real phone
 * viewport, and the board's `NativeConversationPane` for a card — through
 * `capture-issue-1629-queue-conversation.fixture.tsx`, which stands in only for
 * the runtime snapshot, the queue transport, the log tail and `fetch`. The
 * pane, its header, the feed, `TmuxComposer`'s form, `ComposerBar`,
 * `NativeQueuePanel` and the Voice panel are the app's own, so a change to any
 * of their heights fails this capture rather than shipping.
 *
 * The sizes are the ones the product actually has: the phone at 390 × 840, and
 * the board's own card heights (`src/components/scheme/layout.ts`) — a 680 px
 * child, a 780 px root, a narrow card and the 600 × 500 card the last review
 * reproduced the collapse in — at 4, 16 and 128 queued rows, with wrapping
 * messages, unanswered hand-offs, unresolved receipts, a live call and a
 * twenty-line draft in every combination that contends for the same budget,
 * plus cards resized down while all of it is up.
 *
 * Each case reads, in the assembled product and never in a reconstruction:
 *
 *  - the input and the send control are inside the pane and take a press;
 *  - the conversation keeps usable transcript height and the page never scrolls;
 *  - the input unit is pinned to its box, so nothing can push it out;
 *  - EVERY surface in the region is inside the pane with a window it can be used
 *    through — the call, the queue, the sends awaiting an answer, the receipts;
 *  - EVERY control on them answers a pointer and the keyboard: the queue's
 *    Start, its header count, its first and last row, the replay of an
 *    unanswered hand-off, the receipt disclosure and — opened with a real click
 *    — each recovery action behind it, the call's mute and the call control;
 *  - a wheel moves the queue and leaves the composer's box and the page behind
 *    the card alone;
 *  - a keyboard walk out of the field reaches the region behind it and the send
 *    controls ahead of it, and everything it lands on can be seen.
 *
 * Then it proves the reading can go red. Every part of the contract is taken
 * back off, one at a time, on the composition it was written for — the budget,
 * the region's yield, its scroller, its even division, the draft's reserve, the
 * pinned input, the rows' own scroller and the wheel's containment — and a run
 * where any of those still reads as "usable" exits non-zero.
 *
 * WHAT IT IS NOT. This is one conversation in a browser with injected data. It
 * establishes that these components at these sizes lay out correctly, and
 * nothing about a negotiated host or the surrounding board.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out.
 */
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { cardComposerCeiling, mobileComposerCeiling } from "@/lib/composerScroll";

import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "BOARD_CAPTURE_DIR",
  prefix: "llv-issue-1629",
  raw: process.env.BOARD_CAPTURE_DIR,
  repoRoot,
});
const OUT_DIR = path.join(BASE, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

async function fixtureBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [path.join(repoRoot, "scripts/capture-issue-1629-queue-conversation.fixture.tsx")],
    outdir: path.join(BASE, "browser"),
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new Error(`the conversation fixture did not build: ${built.logs.join("\n")}`);
  const output = built.outputs[0];
  if (!output) throw new Error("the conversation fixture built nothing");
  return fs.readFileSync(output.path, "utf8");
}

function stylesheet(): string {
  const cssDir = path.join(repoRoot, ".next", "static", "css");
  let names: string[] = [];
  try { names = fs.readdirSync(cssDir).filter((name) => name.endsWith(".css")); }
  catch { throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first"); }
  if (names.length === 0) throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  return names.map((name) => fs.readFileSync(path.join(cssDir, name), "utf8")).join("\n");
}

interface Case {
  name: string;
  /** `phone` mounts `BranchPane` at a phone viewport, which is the only way to
      get the phone composer: a phone-width desktop render is a different form
      with a different budget. `card` mounts the board's conversation pane. */
  surface: "phone" | "card";
  pane: { width: number; height: number };
  viewport: { width: number; height: number };
  rows: number;
  long: boolean;
  unresolved: number;
  /** Shrink the card to this height after it has laid out once. */
  resizeTo?: number;
  /** Type a twenty-line draft into the real field, through the real input
      handler, so the composer's own autosize decides the field's height the way
      it does for an operator writing a long instruction. */
  draft?: "long";
  /** Deliveries with no terminal answer, stacked under the input. */
  receipts?: number;
  /** A live call docked above the composer, panel and all. */
  voice?: boolean;
  /** A conversation whose host advertises no queue: nothing here can yield, so
      the budget has to fit what is left on its own. */
  noQueue?: boolean;
}

const CASES: Case[] = [
  { name: "phone-4", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 4, long: false, unresolved: 0 },
  { name: "phone-16", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 16, long: false, unresolved: 0 },
  { name: "phone-128", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 128, long: false, unresolved: 0 },
  { name: "phone-128-long-and-unresolved", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 128, long: true, unresolved: 3 },
  { name: "phone-short-128", surface: "phone", pane: { width: 342, height: 552 }, viewport: { width: 390, height: 600 }, rows: 128, long: false, unresolved: 0 },
  { name: "card-child-4", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 4, long: false, unresolved: 0 },
  { name: "card-child-16", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 16, long: false, unresolved: 0 },
  { name: "card-child-128", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: false, unresolved: 0 },
  { name: "card-child-128-long-and-unresolved", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3 },
  { name: "card-stage-128", surface: "card", pane: { width: 600, height: 620 }, viewport: { width: 720, height: 1080 }, rows: 128, long: false, unresolved: 0 },
  { name: "card-root-128", surface: "card", pane: { width: 600, height: 780 }, viewport: { width: 720, height: 1080 }, rows: 128, long: false, unresolved: 0 },
  { name: "card-narrow-128-long", surface: "card", pane: { width: 390, height: 760 }, viewport: { width: 720, height: 840 }, rows: 128, long: true, unresolved: 3 },
  { name: "card-child-128-resized-to-500", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3, resizeTo: 500 },
  /* A DRAFT THAT GREW. The field autosizes, and on the phone it used to grow
     into the whole box: the queue above it collapsed to a border with a
     zero-height interior, and Send landed past the pane. */
  { name: "phone-128-long-draft", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 128, long: true, unresolved: 3, draft: "long" },
  { name: "phone-4-long-draft", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 4, long: false, unresolved: 0, draft: "long" },
  { name: "card-child-128-long-draft", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3, draft: "long" },
  /* A CALL DOCKED ABOVE THE COMPOSER, with no queue in the form at all — the
     composition where nothing could yield and the budget clipped Send instead.
     With receipts under the input, and on the smallest card the board makes. */
  { name: "card-child-voice-long-draft", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 0, long: false, unresolved: 0, draft: "long", voice: true, noQueue: true },
  { name: "card-child-voice-receipts-long-draft", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 0, long: false, unresolved: 0, draft: "long", voice: true, receipts: 6, noQueue: true },
  { name: "card-small-voice-receipts", surface: "card", pane: { width: 600, height: 500 }, viewport: { width: 720, height: 1080 }, rows: 0, long: false, unresolved: 0, voice: true, receipts: 6, noQueue: true },
  { name: "card-small-voice-receipts-long-draft", surface: "card", pane: { width: 600, height: 500 }, viewport: { width: 720, height: 1080 }, rows: 0, long: false, unresolved: 0, draft: "long", voice: true, receipts: 6, noQueue: true },
  { name: "phone-voice-receipts-long-draft", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 0, long: false, unresolved: 0, draft: "long", voice: true, receipts: 6, noQueue: true },
  /* And both at once: a call and a queue dividing one budget with a grown
     draft, which is the whole contention this bound arbitrates. */
  { name: "card-child-voice-queue-long-draft", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3, draft: "long", voice: true, receipts: 6 },
  { name: "phone-voice-queue-long-draft", surface: "phone", pane: { width: 342, height: 760 }, viewport: { width: 390, height: 840 }, rows: 16, long: false, unresolved: 0, draft: "long", voice: true },
  /* EVERYTHING AT ONCE ON THE SMALLEST CARD, and the same composition resized
     down to it — the two compositions the final independent review reproduced
     the collapse in: a live call, 128 rows with three unanswered hand-offs, six
     unresolved receipts and a twenty-line draft, in 500 px of conversation. */
  { name: "card-small-voice-queue-receipts-long-draft", surface: "card", pane: { width: 600, height: 500 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3, draft: "long", voice: true, receipts: 6 },
  { name: "card-voice-queue-receipts-resized-to-500", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 128, long: true, unresolved: 3, draft: "long", voice: true, receipts: 6, resizeTo: 500 },
  /* AND THE ROOM HANDED BACK. No call, no queue, no receipt: the region is not
     there at all and the field keeps the whole cap it has always had. */
  { name: "card-child-empty-long-draft", surface: "card", pane: { width: 600, height: 680 }, viewport: { width: 720, height: 1080 }, rows: 0, long: false, unresolved: 0, draft: "long", noQueue: true },
];

/** Twenty lines, typed into the field the way an operator writes a long
    instruction — long enough that the field reaches its ceiling on every
    surface here and has to stop. */
const LONG_DRAFT = Array.from({ length: 20 }, (_, index) => `Long instruction line ${index + 1} with enough text to wrap`).join("\n");

interface SurfaceReading {
  id: string;
  present: boolean;
  /** The window the region hands this surface: what the operator sees of it
      before scrolling anything. A surface squeezed to nothing still reports a
      rect — only its window says whether anything in it can be seen. */
  window: number;
  /** And what it has to show inside that window. */
  content: number;
  /** Laid out inside the conversation rather than past its bottom edge, which
      is where a receipt list with every recovery control in it went. */
  insidePane: boolean;
}

interface ControlReading {
  id: string;
  present: boolean;
  /** A readout — the queue's own count beside its Start — is asked to be
      visible where it is, never to take focus. */
  readout?: boolean;
  /** Its own scrollports brought it into view and the pixels at its centre are
      the control itself — the pointer route an operator actually has. */
  pointer: boolean;
  /** Focused through the keyboard, and visible where the focus landed. A
      focused control nobody can see is the failure this reading exists for. */
  keyboard: boolean;
  /** Playwright's own actionability check: visible, stable, and the hit target
      at its centre. Run for the surface-level controls. */
  clickable: boolean;
}

interface Reading {
  inputInsidePane: boolean;
  sendInsidePane: boolean;
  inputPressable: boolean;
  sendPressable: boolean;
  feedHeight: number;
  fieldHeight: number;
  /** The accessory region: ONE budget and ONE scrollport over the call, the
      queue, the sends awaiting an answer and the receipts of the ones that
      failed. */
  regionPresent: boolean;
  regionWindow: number;
  surfaces: SurfaceReading[];
  panelPresent: boolean;
  /** The queue panel's own scrollport, kept as its own reading because a panel
      squeezed to its borders reports a height and an interior of zero. */
  panelInterior: number;
  voicePresent: boolean;
  voiceInterior: number;
  queueStartVisible: boolean;
  rows: number;
  rowsScrollToEnd: boolean;
  lastRowPressable: boolean;
  pageScrolls: boolean;
  /** The input unit is pinned to the bottom edge of its box, so a composition
      the budget cannot fit is scrolled through rather than laid out past the
      pane. */
  inputPinned: boolean;
}

const READ = () => {
  const pane = document.querySelector("#app section")!.getBoundingClientRect();
  const feed = document.querySelector("[data-log-feed-scroller]")!.getBoundingClientRect();
  const field = document.querySelector("textarea") as HTMLTextAreaElement;
  const input = field.getBoundingClientRect();
  const form = field.closest("form");
  const sendControl = form?.querySelector('button[type="submit"]') ?? null;
  const send = sendControl?.getBoundingClientRect() ?? null;
  const panelNode = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
  const start = document.querySelector('[data-testid="native-queue-start"]')?.getBoundingClientRect() ?? null;
  const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
  const dock = document.querySelector('[data-testid="voice-dock-slot"]') as HTMLElement | null;
  const region = document.querySelector('[data-testid="composer-accessories"]') as HTMLElement | null;
  const unit = document.querySelector('[data-testid="composer-input-unit"]') as HTMLElement | null;
  const inside = (box: DOMRect) => box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
  /* WHAT IS ON TOP OF THE FIELD. A control laid out inside the pane can still
     be covered by a panel that spilled over it, and a covered field takes no
     typing, so the reading asks the page who owns those pixels. Send is asked
     the same question: a submit control the operator cannot hit is a composer
     with no way to send. */
  const over = document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2);
  const onSend = send ? document.elementFromPoint(send.x + send.width / 2, send.y + send.height / 2) : null;
  /* EVERY SURFACE IN THE REGION, measured the same way: what the operator can
     see of it, what it has to show, and whether it is inside the conversation
     at all. One list, because they share one budget — reading them one at a
     time is how two repairs in a row each fixed a sibling and left the next to
     collapse. */
  const surfaces = ["voice-dock-slot", "native-queue-panel", "composer-deliveries", "composer-receipts"].map((id) => {
    const node = region?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    const visible = node !== null && node.getClientRects().length > 0;
    return {
      id,
      present: visible,
      window: visible ? node.clientHeight : 0,
      content: visible ? node.scrollHeight : 0,
      insidePane: visible ? inside(node.getBoundingClientRect()) : true,
    };
  });
  const common = {
    inputInsidePane: inside(input),
    sendInsidePane: send ? inside(send) : false,
    inputPressable: over === field,
    sendPressable: Boolean(sendControl && onSend && sendControl.contains(onSend)),
    feedHeight: Math.round(feed.height),
    fieldHeight: Math.round(input.height),
    regionPresent: region !== null,
    regionWindow: region ? region.clientHeight : 0,
    surfaces,
    panelPresent: panelNode !== null,
    panelInterior: panelNode ? panelNode.clientHeight : 0,
    voicePresent: Boolean(dock?.querySelector('[aria-label="Voice conversation"]')),
    voiceInterior: dock ? dock.clientHeight : 0,
    queueStartVisible: start ? inside(start) : false,
    rows: document.querySelectorAll('[data-testid="native-queue-row"]').length,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    inputPinned: unit !== null && getComputedStyle(unit).position === "sticky",
  };
  /* A MISSING SCROLLER IS A READING. If the rows list is gone the bound went
     with it, and that has to come back as a failed measurement the run reports
     rather than a stack trace nobody can compare. */
  if (!list) return { ...common, rowsScrollToEnd: false, lastRowPressable: false };
  /* EVERY ROW HAS TO BE REACHABLE, which for an overflowing list means it
     scrolls. The list is taken to its end, and then the last row's own control
     is brought into view and pressed where it lands: together those say the far
     end is reachable rather than clipped away. */
  list.scrollTop = list.scrollHeight;
  const scrolled = list.scrollHeight <= list.clientHeight + 1
    || Math.abs(list.scrollTop + list.clientHeight - list.scrollHeight) <= 2;
  const lastRow = [...list.querySelectorAll('[data-testid="native-queue-row"]')].at(-1) ?? null;
  const lastControl = lastRow?.querySelector("button") ?? null;
  lastControl?.scrollIntoView({ block: "nearest" });
  const control = lastControl?.getBoundingClientRect() ?? null;
  const pressable = control !== null
    && document.elementFromPoint(control.x + control.width / 2, control.y + control.height / 2)?.closest("button") === lastControl
    && inside(control);
  list.scrollTop = 0;
  return { ...common, rowsScrollToEnd: scrolled, lastRowPressable: pressable };
};

/** Bring one control into view through its OWN scrollports and ask the page who
    owns the pixels at its centre, then ask the same after the keyboard put the
    focus on it. This is the route an operator has: scroll the thing the control
    is in, then press it — never a scroll of the page, which these panes do not
    have. */
const REACH = (selector: string) => {
  const node = document.querySelector(selector) as HTMLElement | null;
  if (!node) return { present: false, pointer: false, keyboard: false };
  const pane = document.querySelector("#app section")!.getBoundingClientRect();
  /* SEEN WHERE IT IS. A control smaller than the window it is in has to be
     inside the conversation whole and own the pixels at its middle. A surface
     taller than its window — a call's transcript inside a squeezed slot — is
     clipped by that window, so its own middle can belong to whatever is painted
     under the clip; what it owes instead is a readable slice of itself, which is
     what sampling down the visible span asks for. The keyboard walk below reads
     visibility the same way. */
  const hits = () => {
    const box = node.getBoundingClientRect();
    const top = Math.max(box.top, pane.top);
    const bottom = Math.min(box.bottom, pane.bottom);
    if (bottom - top < Math.min(24, box.height)) return false;
    return [0.1, 0.3, 0.5, 0.7, 0.9].some((share) => {
      const at = document.elementFromPoint(box.x + box.width / 2, top + (bottom - top) * share);
      return Boolean(at && (node.contains(at) || at.contains(node)));
    });
  };
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
  const pointer = hits();
  node.focus();
  const keyboard = document.activeElement === node && hits();
  return { present: true, pointer, keyboard };
};

/** The conversation has to keep enough room to still be a conversation. */
const MIN_FEED_PX = 120;
/** And a surface in the region has to keep enough of a window to be used
    through: a control row the operator can see and press, with its own scroller
    for the rest. Below this a panel is a border with nothing inside it — a
    2 px queue, a 0 px receipt list — which is what the collapse this capture
    exists for looked like. */
const MIN_SURFACE_WINDOW_PX = 32;
/** A surface ALONE in the region gets the whole accessory window: its header
    row with the surface-level control and a row readable under it. */
const MIN_SOLE_SURFACE_WINDOW_PX = 88;

function holds(reading: Reading, scenario: Case, controls: ControlReading[]): boolean {
  /* The two controls with no alternative come first, on every composition:
     something to type in, and something to press. */
  const composerUsable = reading.inputInsidePane && reading.sendInsidePane
    && reading.inputPressable && reading.sendPressable
    && reading.feedHeight >= MIN_FEED_PX && !reading.pageScrolls && reading.inputPinned;
  /* THEN EVERY SURFACE THE COMPOSER GAINED, under one rule rather than one rule
     each: inside the conversation, with a window it can be used through, and
     the whole region divided between however many of them there are. */
  const present = reading.surfaces.filter((surface) => surface.present);
  const sole = present.length === 1;
  const surfacesUsable = present.every((surface) => surface.insidePane
    && surface.window >= (sole ? MIN_SOLE_SURFACE_WINDOW_PX : MIN_SURFACE_WINDOW_PX));
  /* AND EVERY CONTROL ON THEM, by pointer and by keyboard. A visible Send over
     a queue whose Start cannot be pressed is exactly the reading that passed
     while the defect shipped. */
  const controlsUsable = controls.every((control) => control.present && control.pointer
    && (control.readout || (control.keyboard && control.clickable)));
  /* A call that is up shows a panel, however squeezed the composition is. */
  const voiceUsable = !scenario.voice || reading.voicePresent;
  if (scenario.noQueue) return composerUsable && surfacesUsable && controlsUsable && voiceUsable && !reading.panelPresent;
  return composerUsable && surfacesUsable && controlsUsable && voiceUsable
    && reading.panelPresent
    && reading.queueStartVisible && reading.rows === scenario.rows
    && reading.rowsScrollToEnd && reading.lastRowPressable;
}

function page(css: string, scenario: Case): string {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;padding:24px;background:var(--color-canvas)}#app{display:flex;width:${scenario.pane.width}px;height:${scenario.pane.height}px}</style>
</head><body><div id="app"></div><script type="module" src="/conversation.js"></script></body></html>`;
}

async function open(browser: Browser, bundle: string, css: string, scenario: Case): Promise<{ view: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: scenario.viewport, colorScheme: "dark" });
  const view = await context.newPage();
  const errors: string[] = [];
  view.on("pageerror", (error) => errors.push(String(error)));
  await view.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/conversation.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: page(css, scenario) });
    return route.abort();
  });
  const query = `count=${scenario.rows}&surface=${scenario.surface}${scenario.long ? "&long=1" : ""}&unresolved=${scenario.unresolved}`
    + `&receipts=${scenario.receipts ?? 0}${scenario.voice ? "&voice=1" : ""}${scenario.noQueue ? "&noqueue=1" : ""}`;
  await view.goto(`http://queue-height.fixture/?${query}`);
  await view.locator("textarea").first().waitFor({ timeout: 15000 });
  if (!scenario.noQueue) await view.locator('[data-testid="native-queue-row"]').first().waitFor({ timeout: 15000 });
  /* The call panel is portalled in by its Viewer-level owner, so it arrives
     after the composer does. */
  if (scenario.voice) await view.locator('[aria-label="Voice conversation"]').first().waitFor({ timeout: 15000 });
  /* TYPED THROUGH THE FIELD. The height comes from the composer's own autosize
     running on a real input event, the way it does for an operator writing a
     long instruction; a draft dropped into storage skips that path. */
  if (scenario.draft === "long") {
    await view.locator("textarea").first().fill(LONG_DRAFT);
    await view.waitForTimeout(150);
  }
  if (scenario.resizeTo) {
    await view.evaluate((height) => { (document.getElementById("app") as HTMLElement).style.height = `${height}px`; }, scenario.resizeTo);
  }
  await view.waitForTimeout(250);
  return { view, errors, close: () => context.close() };
}

/** EVERY CONTROL THE COMPOSITION DREW, probed the way an operator reaches it:
    scroll the surface it is in, press it where it lands, and then put the
    keyboard on it and ask again. The receipts are opened first — their recovery
    actions live behind a disclosure, and a disclosure nobody can open is a
    recovery route nobody has. */
async function probeControls(view: Page, scenario: Case): Promise<ControlReading[]> {
  const readings: ControlReading[] = [];
  const probe = async (id: string, selector: string, readout = false) => {
    const locator = view.locator(selector).first();
    if (await locator.count() === 0) {
      readings.push({ id, present: false, pointer: false, keyboard: false, clickable: false });
      return;
    }
    const reach = await view.evaluate(REACH, selector);
    if (readout) {
      readings.push({ id, readout, ...reach, clickable: false });
      return;
    }
    let clickable = false;
    try { await locator.click({ trial: true, timeout: 2000 }); clickable = true; } catch { clickable = false; }
    readings.push({ id, ...reach, clickable });
  };

  if (scenario.voice) {
    /* The call's own controls: muting is in the panel's header, and the control
       that starts and ends the call is a cell of the composer's tools row, so a
       squeezed panel still leaves the call controllable. */
    await probe("call mute", '[data-testid="voice-mic-toggle"]');
    await probe("call control", '[data-testid="voice-call-button"]');
  }
  if (!scenario.noQueue) {
    await probe("queue start", '[data-testid="native-queue-start"]');
    /* The header's own readout: the count that says how much is in the queue,
       which has to be readable in whatever window the region gave the panel. */
    await probe("queue count", '[data-testid="native-queue-count"]', true);
    await probe("queue first row edit", '[data-testid="native-queue-rows"] > li:first-child [data-testid="native-queue-edit"]');
    await probe("queue last row delete", '[data-testid="native-queue-rows"] > li:last-child [data-testid="native-queue-delete"]');
    if (scenario.unresolved) await probe("queue hand-off replay", '[data-testid="native-queue-unresolved-retry"]');
  }
  if (scenario.receipts) {
    await probe("receipt disclosure", '[data-testid="composer-receipts"] summary');
    /* Opened with a real pointer press, which is the only way its recovery
       actions exist at all. */
    await view.locator('[data-testid="composer-receipts"] summary').first().click({ timeout: 2000 });
    await view.waitForTimeout(120);
    await probe("receipt retry", "[data-receipt-uncertain-retry]");
    await probe("receipt discard", "[data-receipt-discard]");
    await probe("receipt dismiss", "[data-receipt-dismiss]");
  }
  return readings;
}

/** THE WHEEL, over the surface an operator would put it over. The rows move,
    and nothing outside them does — not the composer's box, not the page behind
    the card. The page is made scrollable for the duration, because a gesture
    that escapes a scroller escapes to whatever CAN scroll, and a page that
    cannot proves nothing. */
async function probeWheel(view: Page): Promise<{ overflows: boolean; queueMoved: boolean; boxStill: boolean; pageStill: boolean }> {
  await view.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "wheel-probe-spacer";
    spacer.style.height = "2000px";
    document.body.appendChild(spacer);
  });
  const read = () => view.evaluate(() => ({
    form: (document.querySelector("textarea")!.closest("form") as HTMLElement).scrollTop,
    page: document.scrollingElement?.scrollTop ?? 0,
  }));
  const before = await read();
  /* Aimed where the queue actually IS: the middle of what the region left
     visible of it, which for a squeezed panel is not the middle of its box. */
  const target = await view.evaluate(() => {
    const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
    const panel = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
    if (!list || !panel) return null;
    const rows = list.getBoundingClientRect();
    const window = panel.getBoundingClientRect();
    const top = Math.max(rows.top, window.top);
    const bottom = Math.min(rows.bottom, window.bottom);
    if (bottom - top < 4) return null;
    return {
      x: rows.x + rows.width / 2,
      y: (top + bottom) / 2,
      overflows: list.scrollHeight > list.clientHeight + 1 || panel.scrollHeight > panel.clientHeight + 1,
    };
  });
  let moved = false;
  if (target) {
    await view.mouse.move(target.x, target.y);
    await view.mouse.wheel(0, 400);
    await view.waitForTimeout(80);
    moved = await view.evaluate(() => {
      const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement;
      const panel = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement;
      return list.scrollTop > 0 || panel.scrollTop > 0;
    });
    /* And again past the end, which is where containment is the only thing left
       holding the gesture. */
    await view.evaluate(() => {
      for (const id of ["native-queue-rows", "native-queue-panel"]) {
        const node = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
        node.scrollTop = node.scrollHeight;
      }
    });
    await view.mouse.wheel(0, 400);
    await view.waitForTimeout(80);
  }
  /* The same gesture over the region itself, which is the scroller the whole
     composition shares. */
  const region = await view.locator('[data-testid="composer-accessories"]').first().boundingBox();
  if (region) {
    await view.mouse.move(region.x + region.width / 2, region.y + Math.min(region.height / 2, 12));
    await view.mouse.wheel(0, 400);
    await view.waitForTimeout(80);
  }
  const after = await read();
  await view.evaluate(() => {
    const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
    if (list) list.scrollTop = 0;
    document.getElementById("wheel-probe-spacer")?.remove();
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  });
  return { overflows: target?.overflows ?? false, queueMoved: moved, boxStill: after.form === before.form, pageStill: after.page === before.page };
}

/** THE KEYBOARD, walking out of the field in both directions: backwards into
    the region above it, forwards through the controls that send. Whatever the
    walk lands on inside the composer has to be visible where it landed — a
    focus ring on a control nobody can see is the exact failure this repair is
    about, and it is what the final independent review found the keyboard doing
    to a receipt list of zero height. The walk stops where it leaves the
    composer: the feed and the pane header have their own scroll and their own
    rules. */
interface KeyboardWalk {
  visited: number;
  allVisible: boolean;
  reachedRegion: boolean;
  /** Whatever was focused and could not be seen, named for the evidence. */
  offenders: string[];
}

async function walk(view: Page, key: "Tab" | "Shift+Tab", steps: number): Promise<KeyboardWalk> {
  await view.locator("textarea").first().focus();
  const result: KeyboardWalk = { visited: 0, allVisible: true, reachedRegion: false, offenders: [] };
  for (let step = 0; step < steps; step += 1) {
    await view.keyboard.press(key);
    const landed = await view.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      if (!active.closest("form")) return null;
      const pane = document.querySelector("#app section")!.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      /* SEEN WHERE THE FOCUS LANDED, measured on what the conversation shows of
         it: a control smaller than its window has to be inside it whole, and a
         scroller taller than its window — a call's transcript in a squeezed
         slot — has to have a readable slice of itself in view with its own
         pixels at the middle of that slice. Both are "the operator can see what
         they just focused"; neither is satisfied by a rect below the pane. */
      const top = Math.max(box.top, pane.top);
      const bottom = Math.min(box.bottom, pane.bottom);
      const shown = bottom - top;
      const owns = shown >= Math.min(24, box.height) && [0.1, 0.3, 0.5, 0.7, 0.9].some((share) => {
        const at = document.elementFromPoint(box.x + box.width / 2, top + shown * share);
        return Boolean(at && (active.contains(at) || at.contains(active)));
      });
      return {
        name: active.getAttribute("data-testid") ?? active.getAttribute("aria-label") ?? active.tagName.toLowerCase(),
        visible: owns,
        inRegion: Boolean(active.closest('[data-testid="composer-accessories"]')),
      };
    });
    if (!landed) break;
    result.visited += 1;
    if (!landed.visible) { result.allVisible = false; result.offenders.push(landed.name); }
    if (landed.inRegion) result.reachedRegion = true;
  }
  return result;
}

async function probeKeyboard(view: Page): Promise<{ backward: KeyboardWalk; forward: KeyboardWalk }> {
  return { backward: await walk(view, "Shift+Tab", 8), forward: await walk(view, "Tab", 4) };
}

async function main(): Promise<number> {
  const css = stylesheet();
  const bundle = await fixtureBundle();
  const measurements: Record<string, unknown> = {};
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"] });
    const verdicts: [string, boolean][] = [];
    for (const scenario of CASES) {
      const { view, errors, close } = await open(browser, bundle, css, scenario);
      /* The frame first: the reading below scrolls the queue to its far end and
         opens the receipts, and a frame taken after that shows neither the
         layout nor the state the operator opens on. */
      try { await view.screenshot({ path: path.join(OUT_DIR, `${scenario.name}.png`) }); } catch { /* a frame is for a human */ }
      const reading = await view.evaluate(READ) as Reading;
      const wheel = scenario.noQueue ? null : await probeWheel(view);
      const keyboard = await probeKeyboard(view);
      const controls = await probeControls(view, scenario);
      /* And a frame of the recovery route itself, with the receipts open. */
      if (scenario.receipts) {
        try { await view.screenshot({ path: path.join(OUT_DIR, `${scenario.name}-receipts-open.png`) }); } catch { /* frame only */ }
      }
      measurements[scenario.name] = { ...reading, controls, wheel, keyboard, errors };
      /* A queue with nothing to scroll cannot be asked to move; one that
         overflows has to, and neither may take the box or the page with it. */
      /* The keyboard: everything the walk lands on inside the composer is
         visible, the controls that send are always ahead of the field, and the
         region is behind it exactly when it has something in it. */
      const inTheRegion = reading.surfaces.some((surface) => surface.present);
      const keyboardHolds = keyboard.backward.allVisible && keyboard.forward.allVisible
        && keyboard.forward.visited > 0 && keyboard.backward.reachedRegion === inTheRegion;
      const gestures = (wheel === null || ((wheel.queueMoved || !wheel.overflows) && wheel.boxStill && wheel.pageStill))
        && keyboardHolds;
      verdicts.push([
        `${scenario.name}: input and Send reachable, every surface has a window, every control answers pointer and keyboard`,
        holds(reading, scenario, controls) && gestures && errors.length === 0,
      ]);
      await close();
    }

    /* RED. Every part of the contract, taken back off one at a time, on the
       composition it was written for — a reading that still says "usable" with
       one of them missing is a reading that would have passed the defect. */

    /* The panel's yield and the card's budget: the first repair. */
    for (const scenario of CASES.filter((one) => one.name === "phone-128" || one.name === "card-child-128")) {
      const { view, close } = await open(browser, bundle, css, scenario);
      /* The composer's budget and the panel's own ceiling, both taken off: an
         unbounded queue grows the form instead of itself, and the conversation
         above it is what pays — which is where this whole repair started. */
      await view.evaluate(() => {
        const panel = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
        const region = document.querySelector('[data-testid="composer-accessories"]') as HTMLElement | null;
        const form = document.querySelector("textarea")?.closest("form") as HTMLElement | null;
        if (panel) { panel.style.maxHeight = "none"; panel.style.overflow = "visible"; }
        if (region) { region.style.minHeight = "auto"; region.style.overflow = "visible"; }
        if (form) form.style.maxHeight = "none";
      });
      const unbudgeted = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements[`red-${scenario.name}-unbudgeted`] = { ...unbudgeted, controls };
      try { await view.screenshot({ path: path.join(OUT_DIR, `red-${scenario.name}-unbudgeted.png`) }); } catch { /* frame only */ }
      verdicts.push([`RED ${scenario.name}: the queue taking room the conversation cannot spare is caught`, !holds(unbudgeted, scenario, controls)]);
      await close();
    }

    /* THE REGION'S RESERVE. The field's ceiling is what keeps a window open on
       every surface beside it; put the ceiling back to the fixed cap it had
       before the region existed and the same composition loses those windows —
       this is the control the final independent review ran by hand, in reverse.
       The height comes from the product's own function, so the control cannot
       drift away from the behaviour it stands for — and on a card it is that
       function's UNMEASURED answer, the fixed cap, which is also what the
       composer falls back to when it cannot measure the conversation it is in.
       A card whose box never got measured is therefore this same failure. */
    for (const name of ["phone-128-long-draft", "card-small-voice-queue-receipts-long-draft", "card-small-voice-receipts-long-draft"]) {
      const scenario = CASES.find((one) => one.name === name)!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate((height) => {
        const field = document.querySelector("textarea") as HTMLTextAreaElement | null;
        if (field) field.style.height = `${height}px`;
      }, scenario.surface === "phone" ? mobileComposerCeiling(840, 840) : cardComposerCeiling(scenario.resizeTo ?? scenario.pane.height, 0));
      const unreserved = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements[`red-${name}-unreserved`] = { ...unreserved, controls };
      try { await view.screenshot({ path: path.join(OUT_DIR, `red-${name}-unreserved.png`) }); } catch { /* frame only */ }
      verdicts.push([`RED ${name}: a field that grows into the region's room is caught`, !holds(unreserved, scenario, controls)]);
      await close();
    }

    /* THE REGION'S OWN YIELD AND SCROLL. Without them the surfaces are laid out
       at full height inside a bounded box, which puts the ones nearest the input
       past the pane's bottom edge — a receipt list 0 px tall below the
       conversation, with every recovery control in it. */
    for (const name of ["card-small-voice-receipts-long-draft", "card-child-voice-queue-long-draft"]) {
      const scenario = CASES.find((one) => one.name === name)!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate(() => {
        const region = document.querySelector('[data-testid="composer-accessories"]') as HTMLElement | null;
        if (region) { region.style.minHeight = "auto"; region.style.overflow = "visible"; }
      });
      const unyielding = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements[`red-${name}-unyielding`] = { ...unyielding, controls };
      try { await view.screenshot({ path: path.join(OUT_DIR, `red-${name}-unyielding.png`) }); } catch { /* frame only */ }
      verdicts.push([`RED ${name}: a region that cannot yield taking the composer's room is caught`, !holds(unyielding, scenario, controls)]);
      await close();
    }

    /* THE FAIR DIVISION INSIDE THE REGION. A flex column shrinks its children in
       proportion to how much they have to show, so a 128-row queue leaves six
       receipt chips a sliver of a window; the grid hands every surface an equal
       share and stops at its content. */
    {
      const scenario = CASES.find((one) => one.name === "card-small-voice-queue-receipts-long-draft")!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate(() => {
        const region = document.querySelector('[data-testid="composer-accessories"]') as HTMLElement | null;
        if (region) { region.style.display = "flex"; region.style.flexDirection = "column"; }
      });
      const unfair = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements["red-proportional-region"] = { ...unfair, controls };
      try { await view.screenshot({ path: path.join(OUT_DIR, "red-proportional-region.png") }); } catch { /* frame only */ }
      verdicts.push(["RED: dividing the region in proportion instead of evenly is caught", !holds(unfair, scenario, controls)]);
      await close();
    }

    /* THE PINNED INPUT. It is what makes a composition the budget cannot fit a
       scroll rather than a clip: unpin it while the field is back at its old
       ceiling, and Send is laid out below the pane again. */
    {
      const scenario = CASES.find((one) => one.name === "card-small-voice-queue-receipts-long-draft")!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate((height) => {
        const unit = document.querySelector('[data-testid="composer-input-unit"]') as HTMLElement | null;
        const field = document.querySelector("textarea") as HTMLTextAreaElement | null;
        const region = document.querySelector('[data-testid="composer-accessories"]') as HTMLElement | null;
        if (unit) unit.style.position = "static";
        if (region) region.style.minHeight = "auto";
        if (field) field.style.height = `${height}px`;
      }, cardComposerCeiling(0, 0));
      const unpinned = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements["red-unpinned-input"] = { ...unpinned, controls };
      try { await view.screenshot({ path: path.join(OUT_DIR, "red-unpinned-input.png") }); } catch { /* frame only */ }
      verdicts.push(["RED: an input unit that is not pinned to its box being pushed out is caught", !holds(unpinned, scenario, controls)]);
      await close();
    }

    /* THE ROWS' OWN SCROLLER, which is what keeps the far end of a long queue
       reachable inside whatever window the region gave the panel. */
    {
      const scenario = CASES.find((one) => one.name === "card-child-128")!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate(() => {
        const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
        if (list) list.style.overflowY = "visible";
      });
      const unscrolled = await view.evaluate(READ) as Reading;
      const controls = await probeControls(view, scenario);
      measurements.redUnscrolled = { ...unscrolled, controls };
      verdicts.push(["RED: letting the rows overflow instead of scrolling is caught", !holds(unscrolled, scenario, controls)]);
      await close();
    }

    /* AND THE CONTAINMENT the wheel reading depends on: without it the gesture
       at the list's end reaches whatever is behind the composer. */
    {
      const scenario = CASES.find((one) => one.name === "card-child-128-long-draft")!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate(() => {
        for (const node of document.querySelectorAll('[data-testid="native-queue-rows"],[data-testid="native-queue-panel"],[data-testid="composer-accessories"]')) {
          (node as HTMLElement).style.overscrollBehavior = "auto";
        }
        /* Including the composer's own box, which is the last containment
           between the queue and the board behind the card. */
        const form = document.querySelector("textarea")?.closest("form") as HTMLElement | null;
        if (form) form.style.overscrollBehavior = "auto";
      });
      const leaked = await probeWheel(view);
      measurements.redWheelLeak = leaked;
      verdicts.push(["RED: a wheel escaping the queue to the page behind it is caught", !(leaked.boxStill && leaked.pageStill)]);
      await close();
    }

    measurements.verdicts = verdicts.map(([check, held]) => ({ check, held }));
    fs.writeFileSync(path.join(OUT_DIR, "queue-height.json"), `${JSON.stringify(measurements, null, 2)}\n`);
    for (const [check, held] of verdicts) console.log(`${held ? "PASS " : "FAIL "}${check}`);
    console.log(`frames and measurements -> ${OUT_DIR}`);
    return verdicts.every(([, held]) => held) ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

process.exit(await main());
