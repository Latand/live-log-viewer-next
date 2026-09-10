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
 *   - that its text is legible: non-zero size, and a WCAG contrast ratio against
 *     what is painted behind it, measured in the theme the app ships;
 *   - that it is NOT the failure treatment — a different foreground colour from
 *     the error slot, and no retry control beside it;
 *   - that a real failure takes the slot back, so the operator is not told what
 *     might happen next while reading what already did.
 *
 * Then it proves the reading can go red: the same measurements are taken against
 * a page where the notice has been removed from the DOM by hand, one where it has
 * been given the failure's own colour, and one where it has been dimmed towards
 * its own background — which keeps its size, its slot and a colour distinct from
 * the error, so only the contrast measurement catches it. A run where any of the
 * three still reads as "a legible, distinct notice" exits non-zero.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out. Nothing is served from the operator's
 * state, nothing is deployed, and no path from this machine reaches a frame.
 */
import fs from "node:fs";
import zlib from "node:zlib";
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

/**
 * The page the panel is measured on.
 *
 * `data-theme="dark"` is the app's OWN dark switch (`styles/tokens.css`), which
 * keys on that attribute and on `prefers-color-scheme` — `class="dark"` selects
 * nothing. Getting it wrong is not cosmetic: the panel then rendered light-mode
 * text tokens over a hard-coded dark background, and every colour measured here
 * and every frame captured described a theme the app never ships. The background
 * is the canvas token for the same reason, and the browser context sets
 * `colorScheme: "dark"` so the media-query half of the switch agrees with the
 * attribute half.
 */
function page(body: string, css: string): string {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>body{margin:0;background:var(--color-canvas);padding:24px;}
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
  /** WCAG contrast ratio of the notice text against what is painted behind it. */
  contrast: number;
  /** The composited background the ratio was taken against, as painted. */
  behind: string;
  /** Every background between the text and the page, outermost last. Kept so a
      reader can see WHICH layers the composite was built from. */
  layers: string[];
  distinctFromError: boolean;
  hasRetryBeside: boolean;
}

/** The floor the notice has to clear to count as readable. WCAG AA for text at
    this size is 4.5:1; the shipped dark treatment clears it several times over,
    so a run near this number should be read as a regression. */
const MIN_CONTRAST = 4.5;

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
      colour: "", fontSizePx: 0, contrast: 0, behind: "", layers: [],
      distinctFromError: false, hasRetryBeside: false,
    };
  }
  const text = notice.querySelector("p") as HTMLElement;
  const box = notice.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const lineBox = line?.getBoundingClientRect();
  const style = getComputedStyle(text);
  /* WHAT IS ACTUALLY PAINTED BEHIND THE GLYPHS. Reading `document.body` gave
     the page's own canvas, which is a whole layer stack away: the panel is
     `bg-raised/70` and the notice itself `bg-warning/5`, so the pixels behind
     the text are those two composited over the canvas — RGB(33,31,33) where the
     body is RGB(16,16,20). Measuring the body published 9.32:1 for a notice that
     is 8.04:1, and passed a grey at 4.94:1 that is really 4.26:1, under a 4.5
     floor. A contrast check that reads the wrong background is worse than none:
     it is a green light with a number beside it.

     The compositing is done BY THE BROWSER, on a canvas. Tailwind emits these
     tokens as `oklab(... / .7)`, and hand-parsing colour spaces here is how the
     next wrong number gets published; `fillStyle` accepts whatever the computed
     style says and `source-over` is exactly the alpha rule the compositor used. */
  const stack: string[] = [];
  for (let node: HTMLElement | null = text; node; node = node.parentElement) {
    stack.push(getComputedStyle(node).backgroundColor);
  }
  const surface = document.createElement("canvas");
  surface.width = 1; surface.height = 1;
  const ink = surface.getContext("2d", { willReadFrequently: true })!;
  /* The initial canvas a browser paints a page onto, so a fully transparent
     stack still composites against something real. */
  ink.fillStyle = "#ffffff";
  ink.fillRect(0, 0, 1, 1);
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    ink.fillStyle = stack[index]!;
    ink.fillRect(0, 0, 1, 1);
  }
  const painted = ink.getImageData(0, 0, 1, 1).data;
  const behind = `rgb(${painted[0]}, ${painted[1]}, ${painted[2]})`;
  const channel = (value: string) => {
    const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    const linear = parts.slice(0, 3).map((raw) => {
      const unit = raw / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const front = channel(style.color);
  const back = channel(behind);
  const ratio = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
  return {
    present: true,
    visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.opacity !== "0",
    belowLastLine: lineBox ? box.top >= lineBox.bottom : false,
    insidePanel: box.top >= panelBox.top - 1 && box.bottom <= panelBox.bottom + 1,
    colour: style.color,
    fontSizePx: Number.parseFloat(style.fontSize),
    contrast: Math.round(ratio * 100) / 100,
    behind,
    layers: stack,
    distinctFromError: errorColour === null ? true : style.color !== errorColour,
    hasRetryBeside: notice.querySelector('[data-testid="voice-retry"]') !== null,
  };
};

function holds(reading: Reading): boolean {
  return reading.present && reading.visible && reading.belowLastLine && reading.insidePanel
    && reading.fontSizePx >= 10 && reading.contrast >= MIN_CONTRAST
    && reading.distinctFromError && !reading.hasRetryBeside;
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

/**
 * One pixel out of a real PNG, so the composite can be checked against paint.
 *
 * A 1x1 screenshot is a single IDAT of one filtered scanline, which is small
 * enough to read here and is the only way this script can see what Chromium
 * actually put on screen rather than what it computed. A frame it cannot decode
 * fails the run, because the whole point of the sample is that nobody has to
 * take the composite on trust.
 */
function decodeSinglePixel(png: Buffer): string {
  let offset = 8;
  const parts: Buffer[] = [];
  let filtered: Buffer | null = null;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += length + 12;
  }
  if (!parts.length) throw new Error("the screenshot carried no image data");
  filtered = zlib.inflateSync(Buffer.concat(parts));
  /* Byte 0 is the scanline's filter type; for one pixel every filter reduces to
     the raw bytes, since there is nothing to its left or above it. */
  const [red, green, blue] = [filtered[1]!, filtered[2]!, filtered[3]!];
  return `rgb(${red}, ${green}, ${blue})`;
}

async function main(): Promise<number> {
  const css = stylesheet();
  let browser: Browser | undefined;
  const measurements: Record<string, unknown> = {};
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
    });
    const context = await browser.newContext({
      viewport: { width: 620, height: 520 },
      reducedMotion: "no-preference",
      colorScheme: "dark",
    });
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

    /* AND THE ONE THE OLD READING COULD NOT SEE. A notice dimmed towards its own
       background keeps its size, its slot and a colour that is still not the
       error's — every check this script used to make — and becomes unreadable.
       Only the contrast measurement catches it. */
    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    await view.evaluate(() => {
      const text = document.querySelector('[data-testid="voice-notice"] p') as HTMLElement | null;
      if (text) text.style.color = "rgb(40, 36, 28)";
    });
    const dimmed = await view.evaluate(READ, errorColour) as Reading;
    await frame(view, "red-dimmed");
    measurements.redDimmed = dimmed;

    /* THE BOUNDARY, which is where a wrong background actually costs something.
       This grey sits just under the 4.5 floor against the pixels really painted
       behind it (4.26:1) and just over it against the page canvas (4.94:1). The
       reading that measured the body passed it. It has to fail. */
    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    await view.evaluate(() => {
      const text = document.querySelector('[data-testid="voice-notice"] p') as HTMLElement | null;
      if (text) text.style.color = "rgb(130, 130, 130)";
    });
    const boundary = await view.evaluate(READ, errorColour) as Reading;
    await frame(view, "red-boundary");
    measurements.redBoundary = boundary;

    /* AND A CHECK ON THE CHECK. The composite is only worth trusting if it
       agrees with the pixels Chromium actually painted, so one pixel of the
       notice's own background is read back out of a real screenshot and the two
       must match. A composite that drifts from the frame fails the run instead
       of publishing a number nobody sampled. */
    await view.setContent(page(panelHtml({ notice: NOTICE, error: null }), css), { waitUntil: "load" });
    const spot = await view.evaluate(() => {
      const notice = document.querySelector('[data-testid="voice-notice"]') as HTMLElement;
      const box = notice.getBoundingClientRect();
      return { x: Math.round(box.right - 3), y: Math.round(box.top + box.height / 2) };
    });
    const pixel = await view.screenshot({ clip: { x: spot.x, y: spot.y, width: 1, height: 1 } });
    const sampled = decodeSinglePixel(pixel);
    const composited = (await view.evaluate(READ, errorColour) as Reading).behind;
    measurements.paintedPixel = { sampled, composited, at: spot };

    const verdicts = [
      ["a live call shows a legible notice, distinct from the failure slot", holds(live)],
      ["a failure takes the slot back", !both.present],
      ["RED: removing the notice is caught", !holds(removed)],
      ["RED: giving it the failure's colour is caught", !holds(indistinct)],
      ["RED: dimming it towards its own background is caught", !holds(dimmed)],
      ["RED: a grey under the floor against the PAINTED background is caught", !holds(boundary)],
      ["the composited background equals the pixel Chromium painted", sampled === composited],
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
