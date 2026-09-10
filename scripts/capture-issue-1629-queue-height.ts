/**
 * The queue above the input, measured inside the conversation that holds it (#1629).
 *
 *   bun run build && bun scripts/capture-issue-1629-queue-height.ts
 *
 * WHY A SECOND CAPTURE. The sibling `capture-issue-1629-queue-panel.ts` renders
 * the panel alone on a page, so nothing above or below it can be wrong: it
 * reads four rows and never meets the composer or the pane that clips it. The
 * defect this file exists for lived exactly there. The composer's form is
 * `shrink-0`, so an unbounded queue grew the form instead of itself: the
 * conversation's feed collapsed and the textarea and the send control were laid
 * out BELOW the pane's bottom edge and clipped away, leaving no way to type or
 * send.
 *
 * So this mounts the ASSEMBLED conversation — `BranchPane` at a real phone
 * viewport, and the board's `NativeConversationPane` for a card — through
 * `capture-issue-1629-queue-conversation.fixture.tsx`, which stands in only for
 * the runtime snapshot, the queue transport, the log tail and `fetch`. The
 * pane, its header, the feed, `TmuxComposer`'s form, `ComposerBar` and
 * `NativeQueuePanel` are the app's own, so a change to any of their heights
 * fails this capture rather than shipping.
 *
 * The sizes are the ones the product actually has: the phone at 390 × 840, and
 * the board's own card heights (`src/components/scheme/layout.ts`) — a 680 px
 * child, a 780 px root, and a narrow card — at 4, 16 and 128 queued rows, with
 * wrapping messages and unanswered hand-offs present, plus a card resized down
 * while the queue is full. Each case measures that the input and the send
 * control are inside the pane and reachable, that the conversation keeps usable
 * transcript height, that the queue's own header control needs no scrolling,
 * and that every row — including the last — can be brought into view and its
 * controls pressed.
 *
 * Then it proves the reading can go red: the panel's yield and the composer's
 * budget are put back the way they were before this repair, and separately the
 * rows are made to overflow visibly, and a run where any of those still reads
 * as "usable" exits non-zero.
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
];

interface Reading {
  inputInsidePane: boolean;
  sendInsidePane: boolean;
  inputPressable: boolean;
  feedHeight: number;
  panelHeight: number;
  queueStartVisible: boolean;
  rows: number;
  rowsScrollToEnd: boolean;
  lastRowPressable: boolean;
  pageScrolls: boolean;
}

const READ = () => {
  const pane = document.querySelector("#app section")!.getBoundingClientRect();
  const feed = document.querySelector("[data-log-feed-scroller]")!.getBoundingClientRect();
  const field = document.querySelector("textarea") as HTMLTextAreaElement;
  const input = field.getBoundingClientRect();
  const send = (field.closest("form")?.querySelector('button[type="submit"]') ?? null)?.getBoundingClientRect() ?? null;
  const panel = document.querySelector('[data-testid="native-queue-panel"]')!.getBoundingClientRect();
  const start = document.querySelector('[data-testid="native-queue-start"]')?.getBoundingClientRect() ?? null;
  const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
  const inside = (box: DOMRect) => box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
  /* WHAT IS ON TOP OF THE FIELD. A control laid out inside the pane can still
     be covered by a panel that spilled over it, and a covered field takes no
     typing, so the reading asks the page who owns those pixels. */
  const over = document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2);
  const common = {
    inputInsidePane: inside(input),
    sendInsidePane: send ? inside(send) : false,
    inputPressable: over === field,
    feedHeight: Math.round(feed.height),
    panelHeight: Math.round(panel.height),
    queueStartVisible: start ? inside(start) : false,
    rows: document.querySelectorAll('[data-testid="native-queue-row"]').length,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
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

/** The conversation has to keep enough room to still be a conversation. */
const MIN_FEED_PX = 120;

function holds(reading: Reading, scenario: { rows: number }): boolean {
  return reading.inputInsidePane && reading.sendInsidePane && reading.inputPressable
    && reading.feedHeight >= MIN_FEED_PX
    && reading.queueStartVisible && reading.rows === scenario.rows
    && reading.rowsScrollToEnd && reading.lastRowPressable && !reading.pageScrolls;
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
  const query = `count=${scenario.rows}&surface=${scenario.surface}${scenario.long ? "&long=1" : ""}&unresolved=${scenario.unresolved}`;
  await view.goto(`http://queue-height.fixture/?${query}`);
  await view.locator('[data-testid="native-queue-row"]').first().waitFor({ timeout: 15000 });
  if (scenario.resizeTo) {
    await view.evaluate((height) => { (document.getElementById("app") as HTMLElement).style.height = `${height}px`; }, scenario.resizeTo);
  }
  await view.waitForTimeout(250);
  return { view, errors, close: () => context.close() };
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
      const reading = await view.evaluate(READ) as Reading;
      measurements[scenario.name] = { ...reading, errors };
      try { await view.screenshot({ path: path.join(OUT_DIR, `${scenario.name}.png`) }); } catch { /* a frame is for a human */ }
      verdicts.push([`${scenario.name}: composer reachable, conversation keeps room, every row reachable`, holds(reading, scenario) && errors.length === 0]);
      await close();
    }

    /* RED. The repair is the panel's yield and the composer's budget, so both
       are put back the way they were and the same reading has to fail — on the
       phone and on a card, the two compositions that were broken. */
    for (const scenario of CASES.filter((one) => one.name === "phone-128" || one.name === "card-child-128")) {
      const { view, close } = await open(browser, bundle, css, scenario);
      /* Exactly what this repair added, taken back off: the panel's yield on
         both surfaces — `min-h-0` AND the panel's own scroller, since a scroll
         container yields even where its minimum is automatic — and on a card
         the composer's budget, which is the one the phone's form had all
         along. */
      await view.evaluate((surface) => {
        const panel = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
        const form = document.querySelector("textarea")?.closest("form") as HTMLElement | null;
        if (panel) { panel.style.minHeight = "auto"; panel.style.overflow = "visible"; }
        if (form && surface === "card") form.style.maxHeight = "none";
      }, scenario.surface);
      const unbudgeted = await view.evaluate(READ) as Reading;
      measurements[`red-${scenario.name}-unbudgeted`] = unbudgeted;
      try { await view.screenshot({ path: path.join(OUT_DIR, `red-${scenario.name}-unbudgeted.png`) }); } catch { /* frame only */ }
      verdicts.push([`RED ${scenario.name}: the queue taking room the conversation cannot spare is caught`, !holds(unbudgeted, scenario)]);
      await close();
    }

    {
      const scenario = CASES.find((one) => one.name === "card-child-128")!;
      const { view, close } = await open(browser, bundle, css, scenario);
      await view.evaluate(() => {
        const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
        if (list) list.style.overflowY = "visible";
      });
      const unscrolled = await view.evaluate(READ) as Reading;
      measurements.redUnscrolled = unscrolled;
      verdicts.push(["RED: letting the rows overflow instead of scrolling is caught", !holds(unscrolled, scenario)]);
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
