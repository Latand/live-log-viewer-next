/**
 * The queue above the input, measured inside the container that clips it (#1629).
 *
 * WHY A SECOND CAPTURE. The sibling `capture-issue-1629-queue-panel.ts` renders
 * the panel alone on a page, so nothing above or below it can be wrong: it
 * reads four rows and never meets the composer's form or the pane's
 * `overflow-hidden`. The defect this file exists for lived exactly there. The
 * composer form is `shrink-0`, so an unbounded queue grew the form instead of
 * itself: at sixteen queued rows the conversation's feed collapsed to zero and
 * the textarea and send control were laid out BELOW the pane's bottom edge and
 * clipped away, leaving no way to type or send. At 128 rows the input sat some
 * six thousand pixels past it.
 *
 * So this renders the real `ComposerBar` — with the real `NativeQueuePanel` in
 * its queue slot and the real `useComposer` behind it — inside the two
 * container contracts that actually surround it in the app: `BranchPane`'s
 * clipping pane and `TmuxComposer`'s desktop form. Those two class strings are
 * READ OUT OF THE SOURCE at run time and asserted to still be there, so this
 * fixture cannot quietly drift away from what the app assembles.
 *
 * At 4, 16 and 128 rows, at composer and phone widths, and once with a long
 * message and unresolved hand-offs present, it measures that the input and the
 * send control are inside the pane, that the conversation keeps usable height,
 * that the queue's own header control needs no scrolling, and that every row —
 * including the last — can be brought into view and its controls reached.
 *
 * Then it proves the reading can go red: the cap is removed from the panel in
 * the page, and separately the rows are made to overflow visibly, and a run
 * where either still reads as "usable" exits non-zero.
 *
 * WHAT IT IS NOT. A statically rendered composition, not the assembled
 * conversation: it establishes that these components in these containers lay
 * out correctly, and nothing about the surrounding board.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out.
 */
import fs from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";

import { ComposerBar } from "../src/components/ComposerBar";
import { useComposer } from "../src/hooks/useComposer";
import { NativeQueuePanel } from "../src/components/NativeQueuePanel";
import { projectNativeQueue } from "../src/components/nativeQueueView";
import type { NativeQueueRecord } from "../src/lib/runtime/nativeQueueContracts";
import { translate, type TFunction } from "../src/lib/i18n";
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

const t: TFunction = (key, params) => translate("en", key as never, params as never);

/**
 * The two containers, taken from the app rather than retyped.
 *
 * A fixture that hard-codes its own wrapper proves only that the fixture is
 * consistent. These are asserted to still appear in the components that own
 * them, so a change to either surface fails this capture instead of shipping.
 */
function containerContracts(): { pane: string; form: string } {
  const pane = "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border";
  const form = "flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 ";
  const paneSource = fs.readFileSync(path.join(repoRoot, "src/components/BranchPane.tsx"), "utf8");
  const formSource = fs.readFileSync(path.join(repoRoot, "src/components/TmuxComposer.tsx"), "utf8");
  if (!paneSource.includes(pane)) throw new Error("BranchPane no longer uses the pane contract this fixture reproduces");
  if (!formSource.includes(form)) throw new Error("TmuxComposer no longer uses the desktop form contract this fixture reproduces");
  return { pane, form: `${form}py-2` };
}

function stylesheet(): string {
  const cssDir = path.join(repoRoot, ".next", "static", "css");
  let names: string[] = [];
  try { names = fs.readdirSync(cssDir).filter((name) => name.endsWith(".css")); }
  catch { throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first"); }
  if (names.length === 0) throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  return names.map((name) => fs.readFileSync(path.join(cssDir, name), "utf8")).join("\n");
}

const LONG = "Rebase the branch onto main, rerun the focused suites for the queue and the composer, and then write the evidence table into the pull request body with the exact counts from the run rather than the ones the description already claims.";

function record(index: number, text: string): NativeQueueRecord {
  return {
    entryId: `e${index}`,
    conversationId: "conversation_height",
    binding: { threadId: "thread-height", accountId: null },
    clientUserMessageId: `client-${index}`,
    nativeSubmissionId: `native-${index}`,
    revision: 1,
    versions: [{ revision: 1, operationId: `op-${index}`, text, images: [], contentDigest: `d-${index}` }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
  } as NativeQueueRecord;
}

interface Case { name: string; rows: number; width: number; long: boolean; unresolved: number }

function panelHtml(scenario: Case): string {
  const { pane, form } = containerContracts();
  const entries = Array.from({ length: scenario.rows }, (_, index) =>
    record(index, scenario.long && index === 0 ? LONG : `Queued instruction ${index + 1}: run the focused check.`));
  const items = entries.map((entry) => ({
    id: entry.nativeSubmissionId,
    clientUserMessageId: entry.clientUserMessageId,
    input: [{ type: "text", text: entry.versions[0]!.text }],
  }));
  const view = projectNativeQueue({
    entries,
    native: { threadId: "thread-height", items, stale: false },
    turn: "idle",
  } as never);
  const queue = createElement(NativeQueuePanel, {
    view,
    loading: false,
    error: null,
    thread: { model: "gpt-6-astra", effort: "high" },
    cardId: "conversation_height",
    unresolved: Array.from({ length: scenario.unresolved }, (_, index) => ({
      key: `unresolved-${index}`,
      text: `A message whose admission was never answered (${index + 1})`,
      imageCount: 0,
    })),
    onReplay: () => undefined,
    mintKey: () => "capture",
    submit: async () => ({ ok: true }),
    onRefresh: () => undefined,
    t,
  } as never);
  /* The composer's own state comes from the composer's own hook, so the bar has
     the rows and controls the app gives it rather than a stub that happens to
     satisfy the type. A hook needs a component, so the bar is one. */
  const Bar = () => {
    const composer = useComposer({ initialText: () => "A new instruction", persistText: () => undefined, submit: () => undefined } as never);
    return createElement(ComposerBar, {
      composer,
      placeholder: "Prompt",
      textareaAriaLabel: "Prompt",
      imageAriaLabel: "Add images",
      leftSlot: null,
      sendLabelIdle: "Send",
      sendLabelRecording: "Stop",
      sendIdleClassName: "bg-accent",
      imageDisabled: true,
      queuePanel: queue,
    } as never);
  };
  return renderToStaticMarkup(createElement("section", { id: "pane", className: pane },
    createElement("header", { className: "shrink-0 px-2 py-2 text-ui text-secondary" }, "Fixture conversation"),
    createElement("div", { id: "feed", className: "min-h-0 flex-1 overflow-y-auto px-2" },
      Array.from({ length: 60 }, (_, index) => createElement("p", { key: index, className: "text-ui text-primary" }, `Existing conversation line ${index + 1}`))),
    createElement("form", { className: form }, createElement(Bar))));
}

interface Reading {
  inputInsidePane: boolean;
  sendInsidePane: boolean;
  feedHeight: number;
  panelHeight: number;
  queueStartVisible: boolean;
  rowsReachable: boolean;
  lastRowControlsInsidePane: boolean;
  pageScrolls: boolean;
}

const READ = () => {
  const pane = document.querySelector("#pane")!.getBoundingClientRect();
  const feed = document.querySelector("#feed")!.getBoundingClientRect();
  const input = document.querySelector("textarea")!.getBoundingClientRect();
  const send = document.querySelector('[data-testid="composer-send"], form button[type="submit"]')?.getBoundingClientRect()
    ?? document.querySelector("form button:last-of-type")!.getBoundingClientRect();
  const panel = document.querySelector('[data-testid="native-queue-panel"]')!.getBoundingClientRect();
  const start = document.querySelector('[data-testid="native-queue-start"]')?.getBoundingClientRect() ?? null;
  const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
  const inside = (box: DOMRect) => box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
  /* A MISSING SCROLLER IS A READING, not a crash. If the rows list is gone the
     bound went with it, and that has to come back as a failed measurement the
     run reports rather than a stack trace nobody can compare. */
  if (!list) {
    return {
      inputInsidePane: inside(input), sendInsidePane: inside(send),
      feedHeight: Math.round(feed.height), panelHeight: Math.round(panel.height),
      queueStartVisible: start ? inside(start) : false,
      rowsReachable: false, lastRowControlsInsidePane: false,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  }
  /* EVERY ROW HAS TO BE REACHABLE, which for an overflowing list means it
     scrolls. Scrolling it to the end and measuring the last row's own control is
     what proves the far end is not simply clipped away. */
  list.scrollTop = list.scrollHeight;
  const rowNodes = [...list.querySelectorAll('[data-testid="native-queue-row"]')];
  const lastControl = rowNodes.at(-1)?.querySelector("button")?.getBoundingClientRect() ?? null;
  const reachable = list.scrollHeight <= list.clientHeight + 1
    || Math.abs(list.scrollTop + list.clientHeight - list.scrollHeight) <= 2;
  list.scrollTop = 0;
  return {
    inputInsidePane: inside(input),
    sendInsidePane: inside(send),
    feedHeight: Math.round(feed.height),
    panelHeight: Math.round(panel.height),
    queueStartVisible: start ? inside(start) : false,
    rowsReachable: reachable,
    lastRowControlsInsidePane: lastControl ? inside(lastControl) : false,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
  };
};

/** The conversation has to keep enough room to still be a conversation. */
const MIN_FEED_PX = 120;

function holds(reading: Reading): boolean {
  return reading.inputInsidePane && reading.sendInsidePane
    && reading.feedHeight >= MIN_FEED_PX
    && reading.queueStartVisible && reading.rowsReachable
    && reading.lastRowControlsInsidePane && !reading.pageScrolls;
}

const CASES: Case[] = [
  { name: "desktop-4", rows: 4, width: 620, long: false, unresolved: 0 },
  { name: "desktop-16", rows: 16, width: 620, long: false, unresolved: 0 },
  { name: "desktop-128", rows: 128, width: 620, long: false, unresolved: 0 },
  { name: "desktop-128-long-and-unresolved", rows: 128, width: 620, long: true, unresolved: 3 },
  { name: "narrow-4", rows: 4, width: 390, long: false, unresolved: 0 },
  { name: "narrow-16", rows: 16, width: 390, long: false, unresolved: 0 },
  { name: "narrow-128", rows: 128, width: 390, long: true, unresolved: 3 },
];

async function main(): Promise<number> {
  const css = stylesheet();
  const measurements: Record<string, unknown> = {};
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"] });
    const verdicts: [string, boolean][] = [];
    for (const scenario of CASES) {
      const context = await browser.newContext({
        viewport: { width: scenario.width + 48, height: 840 },
        colorScheme: "dark",
      });
      const view = await context.newPage();
      await view.setContent(
        `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;padding:24px;background:var(--color-canvas)}#pane{width:${scenario.width}px;height:760px}</style>
</head><body>${panelHtml(scenario)}</body></html>`,
        { waitUntil: "load" },
      );
      const reading = await view.evaluate(READ) as Reading;
      measurements[scenario.name] = reading;
      try { await view.screenshot({ path: path.join(OUT_DIR, `${scenario.name}.png`) }); } catch { /* a frame is for a human */ }
      verdicts.push([`${scenario.name}: composer reachable, conversation keeps room, every row reachable`, holds(reading)]);
      await context.close();
    }

    /* RED. The bound is what makes all of the above true, so both halves of it
       are taken away in the page and the same reading has to fail. */
    const context = await browser.newContext({ viewport: { width: 668, height: 840 }, colorScheme: "dark" });
    const red = await context.newPage();
    const worst: Case = { name: "red", rows: 128, width: 620, long: false, unresolved: 0 };
    const load = async () => red.setContent(
      `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;padding:24px;background:var(--color-canvas)}#pane{width:620px;height:760px}</style>
</head><body>${panelHtml(worst)}</body></html>`, { waitUntil: "load" });

    await load();
    await red.evaluate(() => {
      const found = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
      if (found) found.style.maxHeight = "none";
    });
    const uncapped = await red.evaluate(READ) as Reading;
    measurements.redUncapped = uncapped;
    try { await red.screenshot({ path: path.join(OUT_DIR, "red-uncapped.png") }); } catch { /* frame only */ }

    await load();
    await red.evaluate(() => {
      const list = document.querySelector('[data-testid="native-queue-rows"]') as HTMLElement | null;
      if (list) list.style.overflowY = "visible";
    });
    const unscrolled = await red.evaluate(READ) as Reading;
    measurements.redUnscrolled = unscrolled;
    await context.close();

    verdicts.push(["RED: removing the panel's cap is caught", !holds(uncapped)]);
    verdicts.push(["RED: letting the rows overflow instead of scrolling is caught", !holds(unscrolled)]);

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
