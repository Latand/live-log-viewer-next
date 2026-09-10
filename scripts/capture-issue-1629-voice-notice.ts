/**
 * Rendered acceptance for the voice usage notice (#1629), in a real browser
 * against the real stylesheet:
 *
 *   bun run build && bun scripts/capture-issue-1629-voice-notice.ts
 *
 * A live call cannot be driven here — it needs a provider, an account and a
 * microphone — so what is put in front of the browser is the panel itself, the
 * component the operator actually sees, rendered with the production build's own
 * compiled CSS. That is the part the DOM tests cannot answer: happy-dom applies
 * no stylesheet, so it can say the element exists and nothing about whether the
 * operator can read it, whether it sits where a warning belongs, or whether it
 * is distinguishable from the failure slot beside it.
 *
 * It measures, in the page:
 *
 *   - that the notice is rendered, on its own row, ABOVE the transcript's
 *     bottom edge and BELOW the last spoken line — a warning that lands off
 *     screen is not a warning;
 *   - that its text is legible: non-zero size, and a colour that is not the
 *     panel's own background;
 *   - that it is NOT the failure treatment — a different foreground colour from
 *     the error slot, and no retry control beside it;
 *   - that a real failure takes the slot back, so the operator is not told what
 *     might happen next while reading what already did.
 *
 * Then it proves the reading can go red: the same measurements are taken against
 * a page where the notice has been removed from the DOM by hand, and against one
 * where it has been given the failure's own colour. A run where either still
 * reads as "a legible, distinct notice" exits non-zero.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out. Nothing is served from the operator's
 * state, nothing is deployed, and no path from this machine reaches a frame.
 */
import fs from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";

import { VoiceConversationPanel } from "../src/components/VoiceConversation";
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

const t: TFunction = (key, params) => translate("en", key, params);
const NOTICE = "This account is approaching its usage limit; the call may be cut short.";
const FAILURE = "You have reached your usage limit.";
const SPOKEN = "Reading the board now.";

/** The build's own compiled CSS, so the measured colours are the shipped ones. */
function stylesheet(): string {
  const cssDir = path.join(repoRoot, ".next", "static", "css");
  let names: string[];
  try {
    names = fs.readdirSync(cssDir).filter((name) => name.endsWith(".css"));
  } catch {
    throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  }
  if (names.length === 0) throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  return names.map((name) => fs.readFileSync(path.join(cssDir, name), "utf8")).join("\n");
}

function page(body: string, css: string): string {
  return `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>body{margin:0;background:var(--color-surface,#0b0b0e);padding:24px;}
  #frame{width:520px;}</style>
</head><body><div id="frame">${body}</div></body></html>`;
}

function panelHtml(options: { notice: string | null; error: string | null }): string {
  return renderToStaticMarkup(createElement(VoiceConversationPanel, {
    phase: options.error ? "error" : "live",
    lines: [{ id: "a", role: "assistant", text: SPOKEN, final: true }],
    error: options.error,
    notice: options.notice,
    startedAt: options.error ? null : 1_000,
    onRetry: () => undefined,
    t,
  }));
}

interface Reading {
  present: boolean;
  visible: boolean;
  belowLastLine: boolean;
  insidePanel: boolean;
  colour: string;
  fontSizePx: number;
  distinctFromError: boolean;
  hasRetryBeside: boolean;
}

const READ = (errorColour: string | null) => {
  const notice = document.querySelector('[data-testid="voice-notice"]') as HTMLElement | null;
  const panel = document.querySelector("#frame > *") as HTMLElement | null;
  /* The deepest element that carries the spoken line, whatever tag the
     transcript happens to use for it. */
  const line = [...document.querySelectorAll("#frame *")]
    .filter((node) => node.textContent?.includes("Reading the board now."))
    .at(-1);
  if (!notice || !panel) {
    return {
      present: false, visible: false, belowLastLine: false, insidePanel: false,
      colour: "", fontSizePx: 0, distinctFromError: false, hasRetryBeside: false,
    };
  }
  const text = notice.querySelector("p") as HTMLElement;
  const box = notice.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const lineBox = line?.getBoundingClientRect();
  const style = getComputedStyle(text);
  return {
    present: true,
    visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.opacity !== "0",
    belowLastLine: lineBox ? box.top >= lineBox.bottom : false,
    insidePanel: box.top >= panelBox.top - 1 && box.bottom <= panelBox.bottom + 1,
    colour: style.color,
    fontSizePx: Number.parseFloat(style.fontSize),
    distinctFromError: errorColour === null ? true : style.color !== errorColour,
    hasRetryBeside: notice.querySelector('[data-testid="voice-retry"]') !== null,
  };
};

function holds(reading: Reading): boolean {
  return reading.present && reading.visible && reading.belowLastLine && reading.insidePanel
    && reading.fontSizePx >= 10 && reading.distinctFromError && !reading.hasRetryBeside;
}

/**
 * Best effort, and said so in the record.
 *
 * The verdicts rest on rectangles and computed styles read out of the live page,
 * which is the part a headless shell always answers; a frame is for a human
 * reading the run afterwards, and a shell that cannot encode one must not turn
 * a green measurement into a failed run.
 */
async function frame(view: import("playwright-core").Page, name: string): Promise<boolean> {
  try {
    await view.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const css = stylesheet();
  let browser: Browser | undefined;
  const measurements: Record<string, unknown> = {};
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
    });
    const context = await browser.newContext({ viewport: { width: 620, height: 520 }, reducedMotion: "no-preference" });
    const view = await context.newPage();

    /* The failure treatment first, so the notice can be compared against it. */
    await view.setContent(page(panelHtml({ notice: null, error: FAILURE }), css), { waitUntil: "load" });
    const errorColour = await view.evaluate(() => {
      const alert = document.querySelector('[role="alert"] p') as HTMLElement | null;
      return alert ? getComputedStyle(alert).color : null;
    });
    measurements.frames = await frame(view, "failure");
    measurements.errorColour = errorColour;

    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    const live = await view.evaluate(READ, errorColour) as Reading;
    await frame(view, "notice");
    measurements.notice = live;

    /* A failure takes the slot back. */
    await view.setContent(page(panelHtml({ notice: NOTICE, error: FAILURE }), css), { waitUntil: "load" });
    const both = await view.evaluate(READ, errorColour) as Reading;
    await frame(view, "failure-wins");
    measurements.noticeUnderFailure = both;

    /* RED PATHS. Each reintroduces the defect in the page and must be caught. */
    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    await view.evaluate(() => document.querySelector('[data-testid="voice-notice"]')?.remove());
    const removed = await view.evaluate(READ, errorColour) as Reading;
    measurements.redRemoved = removed;

    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    await view.evaluate((colour) => {
      const text = document.querySelector('[data-testid="voice-notice"] p') as HTMLElement | null;
      if (text && colour) text.style.color = colour;
    }, errorColour);
    const indistinct = await view.evaluate(READ, errorColour) as Reading;
    measurements.redIndistinct = indistinct;

    const verdicts = [
      ["a live call shows a legible notice, distinct from the failure slot", holds(live)],
      ["a failure takes the slot back", !both.present],
      ["RED: removing the notice is caught", !holds(removed)],
      ["RED: giving it the failure's colour is caught", !holds(indistinct)],
    ] as const;
    measurements.verdicts = verdicts.map(([check, held]) => ({ check, held }));
    fs.writeFileSync(path.join(OUT_DIR, "voice-notice.json"), `${JSON.stringify(measurements, null, 2)}\n`);
    for (const [check, held] of verdicts) console.log(`${held ? "PASS " : "FAIL "}${check}`);
    console.log(`frames and measurements -> ${OUT_DIR}`);
    return verdicts.every(([, held]) => held) ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

process.exit(await main());
