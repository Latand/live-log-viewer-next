/**
 * Mobile v2 capture harness (issue #1439, lane 0).
 *
 *   bun run build && bun scripts/capture-mobile-v2.ts
 *   bun scripts/capture-mobile-v2.ts --only=board,chat-working
 *   bun scripts/capture-mobile-v2.ts --strict
 *
 * Renders the PRODUCTION build against a seeded synthetic home (the #979
 * recipe: a temp home, an invented project, transcripts written as JSONL, the
 * in-flight answers for the seat, the runtime plane and the file states) at
 * 390×844, 430×932 and 844×390, in both colour schemes, for every screen id
 * of `docs/design/mobile-v2/prototype/screens.js` — the state screens
 * (`board-noseat`, `board-degraded`, `board-crowded`, `chat-arrival`,
 * `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`) included — and
 * runs the same gates the prototype's `capture.ts` runs on every frame:
 *
 *   - overflow  the document never scrolls sideways (#353);
 *   - bench     no desktop chrome inside a phone-sized viewport, landscape too;
 *   - hit       every visible control is at least 44 × 44 px;
 *   - overlap   no two visible controls' rects intersect;
 *   - receipt   a receipt or banner covers no control outside itself;
 *   - scheme    the requested scheme actually applied (the canvas token);
 *   - title     the bar's title cell keeps ≥ 190 px in portrait;
 *   - keyboard  with a 336 px keyboard open the send control sits above it, the
 *               field sits below the bar and the window did not scroll (#983);
 *   - console   the page logged no error.
 *
 * After the matrix the §3.3 navigation flows run headless (pipeline → stage →
 * ‹ lands on the pipeline; ⋯ → Accounts → browser back lands on the board with
 * no sheet; a sheet creates no history; ⚠ from a conversation closes back onto
 * it at the same scroll offset; the bar swipe walks the switcher's order minus
 * Recent and bumps at the end; back with a sheet open pops the screen).
 *
 * ── The hook contract ────────────────────────────────────────────────────────
 * The harness drives the product through `data-mobile2-*` attributes, which
 * lanes 1–9 add as they land (today's controls are the fallback where one
 * exists). A screen counts as REACHED when its `data-mobile2-screen` /
 * `data-mobile2-sheet` root is on the page; otherwise it is captured as the
 * product renders today and the report says so.
 *
 *   data-mobile2-bar                    the one bar          data-mobile2-title   its title cell
 *   data-mobile2-back                   the bar's ‹          data-mobile2-bump    set on the title after an end-of-list swipe
 *   data-mobile2-screen="board|chat|pipelines|pipeline|accounts"
 *   data-mobile2-sheet="projects|attention|menu|host|search|seat|rotate|switch|model"
 *   data-mobile2-open="<sheet>"         a control that opens that sheet
 *   data-mobile2-close                  the sheet's × (the scrim carries it too)
 *   data-mobile2-go="<screen>"          a row that pushes that screen (accounts, pipelines, pipeline, chat)
 *   data-mobile2-section="<name>"       the switcher row's section (recent is skipped by the swipe)
 *   data-mobile2-stage                  a stage row on the pipeline screen
 *   data-mobile2-pipeline-row           a row on the pipelines list
 *   data-mobile2-feed                   the conversation's scroller
 *   data-mobile2-conversation="<id>"    on the chat screen root
 *   data-mobile2-send / data-mobile2-field / data-mobile2-receipt / data-mobile2-banner
 *
 * ── Strictness ───────────────────────────────────────────────────────────────
 * Screens the product cannot show yet render as they render today and the
 * gates report their current state: without `--strict` a red gate, an
 * unreached screen or a red flow is reported and the run still exits 0. The
 * run exits non-zero only when the harness itself failed (no build, no
 * browser, a page that never rendered a shell). `--strict` turns every red into
 * a failure; later lanes turn it on once their frames are green.
 * Integration-gated (mobile v2 lane 1, #1439): `board` and `board-degraded` mount
 * the shell but still hold lane 3/4/5 controls (focus view, question card,
 * composer), so their strict `hit` gate is deferred until those lanes land.
 *
 * ── Output ───────────────────────────────────────────────────────────────────
 * One fresh capture-owned directory per run under the temp root
 * (`MOBILE_V2_CAPTURE_DIR` selects the parent, nothing else):
 *
 *   <tmp>/llv-issue-1439-latest/out/<frame>/<scheme>/<screen>.png
 *   <tmp>/llv-issue-1439-latest/out/manifest.json   what was rendered
 *   <tmp>/llv-issue-1439-latest/out/report.json     every gate and flow verdict
 *
 * The frames live outside the repository on purpose: a browser render is not
 * byte-deterministic, so it carries no privacy-manifest provenance and the
 * publication gate refuses committed rasters. Nothing in this file names a
 * real project, account, handle, path or id.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";

/* ────────────────────────────────────────────────────────────────────────── *
 * Screens, frames, budgets                                                    *
 * ────────────────────────────────────────────────────────────────────────── */

export interface Screen { id: string; hash: string; title: string; scenario?: string }

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
/** The prototype's own list, so the harness and the picture can never disagree. */
export const SCREENS = require(path.join(REPO_ROOT, "docs/design/mobile-v2/prototype/screens.js")) as Screen[];

export const FRAMES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;
/* P3-1: a landscape phone gets the shell, never the bench; the keyboard frame
   is not budgeted in landscape, so kb screens are skipped there. */
export const LANDSCAPE = { name: "844x390", width: 844, height: 390 } as const;
export const LANDSCAPE_SCREENS = ["board", "board-attention", "chat-working", "pipeline"];
export const SCHEMES = ["dark", "light"] as const;
export type Scheme = (typeof SCHEMES)[number];
/** An iOS keyboard's share of a 390×844 phone (#983). */
export const KEYBOARD_PX = 336;
export const HIT_PX = 44;
export const BAR_PX = 52;
export const TITLE_MIN_PX = 190;
/** `--surface-canvas` from src/styles/tokens.css, light and dark. */
export const CANVAS = { light: "rgb(243, 243, 246)", dark: "rgb(16, 16, 20)" } as const;

/* ────────────────────────────────────────────────────────────────────────── *
 * Arguments                                                                   *
 * ────────────────────────────────────────────────────────────────────────── */

export interface CaptureOptions {
  /** Every red gate, unreached screen and red flow fails the run. */
  strict: boolean;
  /** Screen ids to render; empty means all. Flows run only on a full matrix. */
  only: string[];
  flows: boolean;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): CaptureOptions {
  const options: CaptureOptions = { strict: false, only: [], flows: true };
  const envOnly = (env.MOBILE_V2_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  options.only.push(...envOnly);
  for (const arg of argv) {
    if (arg === "--strict") options.strict = true;
    else if (arg === "--no-flows") options.flows = false;
    else if (arg.startsWith("--only=")) options.only.push(...arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
    else throw new Error(`unknown argument ${arg} (known: --strict, --no-flows, --only=<id,…>)`);
  }
  const unknown = options.only.filter((id) => !SCREENS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`--only names no known screen: ${unknown.join(", ")} (known: ${SCREENS.map((s) => s.id).join(", ")})`);
  if (options.only.length) options.flows = false;
  return options;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Gates — pure, so the test can turn each one red                             *
 * ────────────────────────────────────────────────────────────────────────── */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Control {
  tag: string;
  label: string;
  /** Clipped to the scroll ancestors and the viewport. */
  rect: Rect;
  /** True when the unclipped box is under the 44 px floor. */
  small: boolean;
  /** Index into `receipts` when the control lives inside that receipt. */
  inReceipt: number | null;
}
export interface Geometry {
  scrollWidth: number;
  innerWidth: number;
  canvas: string;
  /** Desktop chrome rendered: no mobile shell root on the page. */
  benchShown: boolean;
  controls: Control[];
  title: { w: number } | null;
  send: { bottom: number } | null;
  field: { top: number } | null;
  receipts: Rect[];
  scrollY: number;
  /** Bottom of the visual viewport in layout px (the keyboard's top edge once open). */
  visibleBottom: number;
}
export type GateId = "overflow" | "bench" | "hit" | "overlap" | "receipt" | "scheme" | "title" | "keyboard" | "console";
export const GATE_IDS: readonly GateId[] = ["overflow", "bench", "hit", "overlap", "receipt", "scheme", "title", "keyboard", "console"];
export interface GateFailure { gate: GateId; message: string }
export interface GateContext { scheme: Scheme; keyboard: boolean; width: number; height: number; landscape?: boolean; consoleErrors?: string[] }

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const fmt = (c: Control) => `${c.tag} «${c.label}» ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}@${Math.round(c.rect.x)},${Math.round(c.rect.y)}`;

/** Every gate the frame fails, each once, never throwing: the report lists
    them all, and `--strict` decides whether they fail the run. */
export function evaluateGates(g: Geometry, ctx: GateContext): GateFailure[] {
  const out: GateFailure[] = [];
  if (g.scrollWidth > g.innerWidth) out.push({ gate: "overflow", message: `the document scrolls to ${g.scrollWidth}px at ${g.innerWidth}px` });
  if (g.benchShown) out.push({ gate: "bench", message: `desktop chrome renders inside a ${ctx.width}×${ctx.height} viewport` });
  const small = g.controls.filter((c) => c.small);
  if (small.length) out.push({ gate: "hit", message: `${small.length} control(s) under the ${HIT_PX}px floor — ${small.slice(0, 6).map(fmt).join("; ")}` });
  const overlaps: string[] = [];
  for (let i = 0; i < g.controls.length; i++) {
    for (let j = i + 1; j < g.controls.length; j++) {
      if (intersects(g.controls[i].rect, g.controls[j].rect)) overlaps.push(`${fmt(g.controls[i])} and ${fmt(g.controls[j])}`);
    }
  }
  if (overlaps.length) out.push({ gate: "overlap", message: `${overlaps.length} pair(s) of controls overlap — ${overlaps.slice(0, 4).join("; ")}` });
  g.receipts.forEach((receipt, index) => {
    const hit = g.controls.find((c) => c.inReceipt !== index && intersects(receipt, c.rect));
    if (hit) out.push({ gate: "receipt", message: `a receipt at ${Math.round(receipt.x)},${Math.round(receipt.y)} (${Math.round(receipt.w)}×${Math.round(receipt.h)}) covers ${fmt(hit)}` });
  });
  if (g.canvas !== CANVAS[ctx.scheme]) out.push({ gate: "scheme", message: `canvas is ${g.canvas}, expected the ${ctx.scheme} scheme's ${CANVAS[ctx.scheme]}` });
  if (!ctx.landscape) {
    if (!g.title) out.push({ gate: "title", message: "no title cell on the bar to measure" });
    else if (g.title.w < TITLE_MIN_PX) out.push({ gate: "title", message: `the bar's title cell is ${g.title.w}px, under the ${TITLE_MIN_PX}px budget` });
  }
  if (ctx.keyboard) {
    const visibleBottom = ctx.height - KEYBOARD_PX;
    if (!g.send || !g.field) out.push({ gate: "keyboard", message: "the keyboard frame has no composer to measure" });
    else {
      if (g.send.bottom > visibleBottom) out.push({ gate: "keyboard", message: `with the keyboard open the send control ends at ${g.send.bottom}px, under the keyboard at ${visibleBottom}px` });
      if (g.field.top < BAR_PX) out.push({ gate: "keyboard", message: `the composer field starts at ${g.field.top}px, above the ${BAR_PX}px bar` });
      if (g.scrollY !== 0) out.push({ gate: "keyboard", message: `the window scrolled to ${g.scrollY}px to reach the field` });
    }
  }
  if (ctx.consoleErrors?.length) out.push({ gate: "console", message: `console error — ${ctx.consoleErrors.slice(0, 3).join(" | ")}` });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Report and exit code                                                        *
 * ────────────────────────────────────────────────────────────────────────── */

export interface FrameResult {
  frame: string;
  scheme: Scheme;
  id: string;
  title: string;
  file: string;
  /** The v2 root for this screen was on the page. */
  reached: boolean;
  note: string;
  gates: GateFailure[];
}
export type FlowStatus = "green" | "red" | "unreached";
export interface FlowResult { id: string; title: string; status: FlowStatus; detail: string }
export interface Summary {
  frames: number;
  red: number;
  unreached: number;
  flows: { green: number; red: number; unreached: number };
  exitCode: 0 | 1;
  lines: string[];
}

export function summarize(frames: FrameResult[], flows: FlowResult[], strict: boolean): Summary {
  const red = frames.filter((f) => f.gates.length).length;
  const unreached = frames.filter((f) => !f.reached).length;
  const count = (status: FlowStatus) => flows.filter((f) => f.status === status).length;
  const flowCounts = { green: count("green"), red: count("red"), unreached: count("unreached") };
  const lines: string[] = [];
  for (const f of frames) {
    for (const gate of f.gates) lines.push(`${f.id}/${f.frame}/${f.scheme}: [${gate.gate}] ${gate.message}`);
    if (!f.reached) lines.push(`${f.id}/${f.frame}/${f.scheme}: not reached — ${f.note}`);
  }
  for (const f of flows) if (f.status !== "green") lines.push(`flow ${f.id}: ${f.status} — ${f.detail}`);
  const perGate = GATE_IDS.map((gate) => [gate, frames.filter((f) => f.gates.some((g) => g.gate === gate)).length] as const).filter(([, n]) => n > 0);
  lines.push(`${frames.length} frames · ${red} red · ${unreached} not reached · flows ${flowCounts.green} green / ${flowCounts.red} red / ${flowCounts.unreached} not reached${perGate.length ? ` · red by gate: ${perGate.map(([g, n]) => `${g} ${n}`).join(", ")}` : ""}`);
  const failing = red > 0 || unreached > 0 || flowCounts.red > 0 || flowCounts.unreached > 0;
  const exitCode = strict && failing ? 1 : 0;
  lines.push(strict ? (exitCode ? "strict: FAIL" : "strict: green") : `not strict: reported only (rerun with --strict to fail on ${failing ? "these" : "reds"})`);
  return { frames: frames.length, red, unreached, flows: flowCounts, exitCode, lines };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Hooks — v2 first, today's control as the fallback                           *
 * ────────────────────────────────────────────────────────────────────────── */

export const HOOKS = {
  shell: '[data-mobile2-bar], [data-testid="mobile-project-header"], [data-testid="mobile-chat-shell"]',
  bar: '[data-mobile2-bar], [data-testid="mobile-project-header"]',
  title: '[data-mobile2-title], [data-testid="mobile-project-header"] h1',
  chatShell: '[data-mobile2-screen="chat"], [data-testid="mobile-chat-shell"]',
  send: '[data-mobile2-send], [data-testid="mobile-chat-shell"] form button[type="submit"]',
  field: '[data-mobile2-field], [data-testid="mobile-chat-shell"] textarea',
  receipts: "[data-mobile2-receipt], [data-mobile2-banner], [data-attention-toast]",
  sheet: '[data-mobile2-sheet], [role="dialog"], [role="menu"]',
  screen: (name: string) => `[data-mobile2-screen="${name}"]`,
  sheetOf: (name: string) => `[data-mobile2-sheet="${name}"]`,
  open: (name: string) => `[data-mobile2-open="${name}"]`,
  go: (name: string) => `[data-mobile2-go="${name}"]`,
} as const;

/** Today's control for each v2 opener, by English aria-label; used only when
    the v2 hook is absent. */
const TODAY = {
  projects: 'button[aria-label="Open project list"]',
  menu: 'button[aria-label="More actions"]',
  search: '[data-testid="dash-search"]',
  attention: 'button[aria-label$=" waiting"]',
  host: '[data-testid="mobile-shelf-trigger"]',
  seat: "[data-orchestrator-row-controls]",
  rotate: "[data-orchestrator-rotate]",
  model: '[data-testid="composer-options-toggle"]',
  chatHost: '[data-testid="mobile-details-toggle"]',
  pipelines: '[data-testid="mobile-pipeline-summary"]',
  pipelineSheet: '[data-testid="mobile-pipeline-sheet"]',
  accounts: 'button[aria-label$="accounts — switch or add"]',
} as const;

/* ────────────────────────────────────────────────────────────────────────── *
 * Measurement                                                                 *
 * ────────────────────────────────────────────────────────────────────────── */

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(({ hit, hooks }) => {
    const gcs = (el: Element) => getComputedStyle(el);
    const clip = (el: Element) => {
      const r = el.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      let a: Element | null = el.parentElement;
      while (a && a !== document.body) {
        const cs = gcs(a);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
          const ar = a.getBoundingClientRect();
          x1 = Math.max(x1, ar.left); y1 = Math.max(y1, ar.top); x2 = Math.min(x2, ar.right); y2 = Math.min(y2, ar.bottom);
        }
        a = a.parentElement;
      }
      x1 = Math.max(x1, 0); y1 = Math.max(y1, 0); x2 = Math.min(x2, window.innerWidth); y2 = Math.min(y2, window.innerHeight);
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), full: { w: r.width, h: r.height } };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = gcs(el);
      if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
      /* Screen-reader-only content is not a target. */
      if (cs.position === "absolute" && (r.width <= 1 || r.height <= 1)) return false;
      return true;
    };
    /* With a sheet or dialog open only its controls count: the scrim covers
       everything else. The topmost one wins. */
    const sheets = [...document.querySelectorAll(hooks.sheet)].filter(visible);
    const scope = sheets.length ? sheets[sheets.length - 1] : document.body;
    const receiptEls = [...document.querySelectorAll(hooks.receipts)].filter(visible);
    const controls: Geometry["controls"] = [];
    for (const el of scope.querySelectorAll('button, a[href], [role="button"], select')) {
      if (!visible(el) || el.hasAttribute("aria-hidden") || (el as HTMLElement).tabIndex < 0 && el.tagName !== "BUTTON" && el.tagName !== "A") continue;
      const c = clip(el);
      if (c.w <= 0 || c.h <= 0) continue;
      const inReceipt = receiptEls.findIndex((r) => r.contains(el));
      controls.push({
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
        rect: { x: c.x, y: c.y, w: c.w, h: c.h },
        small: c.full.w < hit - 0.5 || c.full.h < hit - 0.5,
        inReceipt: inReceipt >= 0 ? inReceipt : null,
      });
    }
    const first = (sel: string) => [...document.querySelectorAll(sel)].find(visible) ?? null;
    const title = first(hooks.title);
    const send = first(hooks.send);
    const field = first(hooks.field);
    const bodyBg = gcs(document.body).backgroundColor;
    const canvas = bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" ? bodyBg : gcs(document.documentElement).backgroundColor;
    const visual = window.visualViewport;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      canvas,
      benchShown: !document.querySelector(hooks.shell),
      controls,
      title: title ? { w: Math.round(title.getBoundingClientRect().width) } : null,
      send: send ? { bottom: Math.round(send.getBoundingClientRect().bottom) } : null,
      field: field ? { top: Math.round(field.getBoundingClientRect().top) } : null,
      receipts: receiptEls.map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }),
      scrollY: Math.round(window.scrollY),
      visibleBottom: visual ? Math.round(visual.offsetTop + visual.height) : window.innerHeight,
    };
  }, { hit: HIT_PX, hooks: { sheet: HOOKS.sheet, receipts: HOOKS.receipts, title: HOOKS.title, send: HOOKS.send, field: HOOKS.field, shell: HOOKS.shell } });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The seeded home — invented project, invented conversations                  *
 * ────────────────────────────────────────────────────────────────────────── */

const CAPTURE_MS = Date.parse("2100-01-02T14:02:00.000Z");
const CAPTURE_S = Math.floor(CAPTURE_MS / 1000);
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
/* Composed rather than written out: a literal UUID in a published source file
   is what the privacy gate's resource-identifier rule exists to catch. */
const sessionUuid = (id: string) => [id, "0000", "4000", "8000", "000000000000"].join("-");

interface Seed {
  key: string;
  title: string;
  /** Minutes before the capture instant the transcript was last written. */
  agoMinutes: number;
  reply: string;
  /** Present only in the crowded scenario. */
  crowd?: boolean;
}

/** The prototype fixture's conversations, by their ids there. */
const SEEDS: Seed[] = [
  { key: "orch", title: "Run the atlas board", agoMinutes: 0, reply: "Two lanes open: 212 on the board status projection, 218 on the export endpoint. Each gets a fresh reviewer per round." },
  { key: "c1", title: "Rebuild the board status projection", agoMinutes: 0, reply: "The projection derives held from the delivery outbox, so a lane whose message is still queued shows as working. I am adding a held precedence ahead of the running check." },
  { key: "c2", title: "Implement the export endpoint", agoMinutes: 9, reply: "Two ways to shape it. NDJSON streams row by row and matches the import path. A JSON array is one document, which the spreadsheet import expects." },
  { key: "c6", title: "Migrate accounts to the new binding", agoMinutes: 25, reply: "Plan: 1) add the binding column behind a flag, 2) backfill from the seat records, 3) flip reads, 4) drop the legacy lookup." },
  { key: "c5", title: "Fix the flaky reseat test", agoMinutes: 0, reply: "Running it ten times first to see the failure shape." },
  { key: "c9", title: "Review · Mobile redesign prototype · round 1", agoMinutes: 0, reply: "Reading the bar budget against the screenshot observations next." },
  { key: "c3", title: "Review PR 412 — accounts dialog limits", agoMinutes: 32, reply: "APPROVE. Two notes, neither blocking: the refresh button re-reads limits but does not clear a stale marker; the weekly flagship row renders even when the tier is unknown." },
  { key: "c8", title: "Review · Fast conversation switching · round 3", agoMinutes: 60, reply: "Two findings stand: switching projects remounts the board; the measured switch is 640 ms at 12 trees against a 200 ms bar." },
  { key: "c4", title: "Tail: pipeline archive TTL", agoMinutes: 120, reply: "Done. PR 418 is open with the archive sweep and its test; the reviewer approved." },
  ...Array.from({ length: 21 }, (_, i) => ({
    key: `x${i}`,
    title: `Lane ${i + 10} · ${["archive sweep", "board projection", "export rows", "reseat race", "limits dialog", "seat rotation", "catalog paging"][i % 7]}`,
    agoMinutes: 130 + i * 20,
    reply: "Done. One PR, tests by path; the reviewer approved.",
    crowd: true,
  })),
];

interface Home { base: string; home: string; repoDir: string; outDir: string }

export function seedHome(base: string): Home {
  const home = path.join(base, "home");
  const repoDir = path.join(home, "Projects", "atlas");
  const outDir = path.join(base, "out");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(base, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(home, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex/sessions"), { recursive: true });
  const claudeHome = path.join(home, ".claude");
  const folder = path.join(claudeHome, "projects", projectSlug(repoDir));
  fs.mkdirSync(folder, { recursive: true });
  /* A 0600 credentials file is what makes the Main account listed as signed
     in; it carries no token on purpose, so the limits probe stops at
     "credentials missing access token" instead of reaching the network. */
  fs.writeFileSync(path.join(claudeHome, ".credentials.json"), "{}\n", { mode: 0o600 });
  SEEDS.forEach((seed, index) => {
    const uuid = sessionUuid(`0000${(0x1439 + index).toString(16).padStart(4, "0")}`);
    const stamp = new Date(CAPTURE_MS - seed.agoMinutes * 60_000);
    const askedAt = new Date(stamp.getTime() - 60_000).toISOString();
    const lines = [
      { type: "user", uuid: `${uuid}-u`, timestamp: askedAt, cwd: repoDir, sessionId: uuid, message: { role: "user", content: `${seed.title}.` } },
      { type: "assistant", uuid: `${uuid}-a`, timestamp: stamp.toISOString(), cwd: repoDir, sessionId: uuid, message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: seed.reply }] } },
    ];
    const file = path.join(folder, `${uuid}.jsonl`);
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    fs.utimesSync(file, stamp, stamp);
  });
  return { base, home, repoDir, outDir };
}

export function buildEnvironment(home: Home, port: number): NodeJS.ProcessEnv {
  const config = path.join(home.home, ".config");
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME: home.home,
    TMPDIR: path.join(home.base, "tmp"),
    TMUX_TMPDIR: path.join(home.base, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(home.base, "cache"),
    XDG_RUNTIME_DIR: path.join(home.base, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home.home, ".claude"),
    LLV_CODEX_HOME: path.join(home.home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

export function capturePort(raw: string | undefined, fallback = 4439): number {
  const port = Number(raw ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MOBILE_V2_CAPTURE_PORT must be a valid non-privileged port");
  return port;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/api/files`)).ok) return;
    } catch {
      /* still booting */
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * In-flight answers: the file states, the seat, the pipelines, the runtime    *
 * ────────────────────────────────────────────────────────────────────────── */

type Entry = Record<string, unknown> & { path: string; title?: string; cwd?: string; project?: string; mtime?: number };

/** The prototype's `stateBits` inputs, as today's file fields. */
type ConversationState = "working" | "waiting-question" | "waiting-plan" | "returned" | "done" | "held" | "limit" | "stalled";

function statePatch(state: ConversationState, entry: Entry, pid: number): Record<string, unknown> {
  const mtime = entry.mtime ?? CAPTURE_S;
  const running = { proc: "running", pid, activity: "live", activityReason: "jsonl_turn_open", lastTurn: { startedAt: mtime * 1000 - 12 * 60_000 - 40_000, endedAt: null } };
  switch (state) {
    case "working": return running;
    case "waiting-question": return {
      ...running,
      pendingQuestion: {
        kind: "question", toolUseId: `toolu-question-${pid}`, transcriptPath: entry.path, pid, paneTarget: null, askedAt: new Date(mtime * 1000).toISOString(),
        questions: [{
          question: "Which format should the export endpoint default to?", header: "Format", multiSelect: false,
          options: [
            { label: "NDJSON", description: "streams, matches the import path", recommended: true },
            { label: "JSON array", description: "simpler for the spreadsheet import", recommended: false },
            { label: "Both, chosen by the Accept header", description: "a second serializer", recommended: false },
          ],
        }],
      },
    };
    case "waiting-plan": return {
      ...running,
      pendingQuestion: { kind: "plan", toolUseId: `toolu-plan-${pid}`, transcriptPath: entry.path, pid, paneTarget: null, askedAt: new Date(mtime * 1000).toISOString(), plan: "1) add the binding column behind a flag\n2) backfill from the seat records\n3) flip reads\n4) drop the legacy lookup" },
    };
    case "returned": return { proc: "done", pid: null, activity: "recent", lastTurn: { startedAt: mtime * 1000 - 14 * 60_000, endedAt: mtime * 1000 } };
    case "done": return { proc: null, pid: null, activity: "idle", lastTurn: { startedAt: mtime * 1000 - 25 * 60_000, endedAt: mtime * 1000 } };
    case "held": return { ...running, stuckDelivery: { since: new Date(CAPTURE_MS - 10 * 60_000).toISOString(), attempts: 2, state: "held" } };
    case "limit": return { ...running, rateLimit: { source: "account", accountId: null, window: "session", resetAt: CAPTURE_S + 2 * 3600 + 38 * 60 } };
    case "stalled": return { ...running, activity: "stalled", activityReason: "jsonl_turn_stalled", mtime: CAPTURE_S - 14 * 60 };
  }
}

const BASE_STATES: Record<string, ConversationState> = {
  orch: "working", c1: "working", c2: "waiting-question", c6: "waiting-plan", c5: "working", c9: "working", c3: "returned", c8: "returned", c4: "done",
};

export interface Scenario {
  /** A file state override for one conversation (the prototype's scenarios). */
  states?: Record<string, ConversationState>;
  /** Keep the 21 extra lanes and 7 extra pipelines. */
  crowded?: boolean;
  /** No orchestrator seat; the seat conversation is dropped too. */
  noseat?: boolean;
  /** The runtime plane is served and then loses its stream. */
  runtime?: "degraded" | "offline";
  /** A decision arrives after the first render (the c6 plan approval). */
  arrival?: boolean;
}

export const SCENARIOS: Record<string, Scenario> = {
  noseat: { noseat: true },
  degraded: { runtime: "degraded" },
  offline: { runtime: "offline" },
  held: { states: { c1: "held" } },
  limit: { states: { c1: "limit" } },
  stalled: { states: { c1: "stalled" } },
  arrival: { arrival: true },
  crowded: { crowded: true },
};

interface Discovered { projectId: string; paths: Record<string, string> }

interface Answers {
  discovered: Discovered;
  repoDir: string;
  scenario: Scenario;
  /** Flipped by the arrival driver after the first render. */
  arrived: boolean;
}

function seatAnswer(a: Answers, live: boolean) {
  if (!live) return { seat: null, pending: null, exists: true };
  const seat = {
    project: a.discovered.projectId, seatEpoch: 3, conversationId: "conversation_atlas_orchestrator", path: a.discovered.paths.orch,
    mandate: "You are the atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.", promptVersion: 3,
    predecessorConversationId: null, state: "active",
    intent: { clientRequestId: "seatreq-000001", mode: "spawn", launchId: "launch-000001", error: null },
    designatedAt: "2100-01-02T12:00:00.000Z", activatedAt: "2100-01-02T12:00:02.000Z",
  };
  return { seat, pending: null, exists: true };
}

function seatStatus(a: Answers) {
  return {
    project: a.discovered.projectId, designated: true, conversationId: "conversation_atlas_orchestrator", predecessorConversationId: "conversation_atlas_predecessor",
    engine: "claude", model: "opus", effort: "high", accountId: null, cwd: a.repoDir, transcriptPath: a.discovered.paths.orch,
    liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 },
    context: { tokens: 24_000, limit: 100_000, percent: 24, estimated: false, basis: "provider-reported usage" },
    transcriptFacts: { bytes: 4_096, messageCount: 12, toolCount: 3, compactionCount: 0 },
    rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
  };
}

const ROLE = (roleId: string, model: string, effort: string) => ({ roleId, engine: "claude", model, effort, access: "read-write", promptScaffold: null });

/** The prototype's three pipelines (and seven more when crowded), on today's shape. */
function pipelinesAnswer(a: Answers): Record<string, unknown>[] {
  const stage = (id: string, kind: "run" | "review-loop", roleId: string, next: string | null, onFail?: { to: string; maxRounds: number }) =>
    ({ id, kind, role: { roleId }, prompt: `${id} prompt`, next, onFail: onFail ?? null, access: "read-write", effectiveRole: ROLE(roleId, "opus", "high") });
  const attempt = (n: number, state: string, key: string | null, verdict: { status: string; findings?: string[] } | null, startedMin: number) => ({
    n, state, effectiveRole: ROLE("builder", "opus", "high"), launchId: null, conversationId: key ? `conversation_atlas_${key}` : null, sessionId: null,
    agentPath: key ? a.discovered.paths[key] ?? null : null, paneId: null, flowId: null,
    startedAt: new Date(CAPTURE_MS - startedMin * 60_000).toISOString(), completedAt: verdict ? new Date(CAPTURE_MS - (startedMin - 5) * 60_000).toISOString() : null,
    input: null, activatedBy: null, output: null, verdict, error: null,
  });
  const common = (id: string, task: string, createdMin: number) => ({
    id: `pipeline_atlas_${id}`, task, taskIds: [], project: a.discovered.projectId, repoDir: a.repoDir, worktreeDir: path.join(a.repoDir, "..", `atlas-${id}`),
    branch: `lane/${id}`, baseBranch: "main", baseRef: "main", lastPassedCommit: "", publishedCommit: null, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(CAPTURE_MS - createdMin * 60_000).toISOString(), closedAt: null,
  });
  const p1 = {
    ...common("p1", "Mobile redesign prototype", 40),
    stages: [stage("design", "run", "architect", "review"), stage("review", "review-loop", "reviewer", "implement", { to: "design", maxRounds: 3 }), stage("implement", "run", "builder", "merge"), stage("merge", "run", "builder", null)],
    runs: [{ stageId: "design", attempts: [attempt(1, "passed", "c1", { status: "pass" }, 38)] }, { stageId: "review", attempts: [attempt(1, "reviewing", "c9", null, 12)] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "design", attempt: 1, edge: "pass" } },
    state: "running",
  };
  const p2 = {
    ...common("p2", "Fast conversation switching", 120),
    stages: [stage("design", "run", "architect", "implement"), stage("implement", "run", "builder", "review"), stage("review", "review-loop", "reviewer", "fix", { to: "implement", maxRounds: 3 }), stage("fix", "run", "builder", "merge"), stage("merge", "run", "builder", null)],
    runs: [
      { stageId: "design", attempts: [attempt(1, "passed", null, { status: "pass" }, 118)] },
      { stageId: "implement", attempts: [attempt(1, "passed", "c5", { status: "pass" }, 100)] },
      { stageId: "review", attempts: [attempt(3, "failed", "c8", { status: "fail", findings: ["Switching projects remounts the board, so the feed cache is dropped every time.", "The measured switch is 640 ms at 12 trees; the bar is 200 ms."] }, 70)] },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } },
    state: "needs_decision", stateDetail: "review round 3 failed with 2 findings; the fail edge is exhausted",
  };
  const p3 = {
    ...common("p3", "Accounts dialog limits", 26 * 60),
    stages: [stage("design", "run", "architect", "implement"), stage("implement", "run", "builder", "review"), stage("review", "review-loop", "reviewer", "merge"), stage("merge", "run", "builder", null)],
    runs: [
      { stageId: "design", attempts: [attempt(1, "passed", null, { status: "pass" }, 25 * 60)] },
      { stageId: "implement", attempts: [attempt(1, "passed", null, { status: "pass" }, 24 * 60)] },
      { stageId: "review", attempts: [attempt(2, "passed", null, { status: "pass" }, 23 * 60)] },
      { stageId: "merge", attempts: [attempt(1, "passed", null, { status: "pass" }, 22 * 60)] },
    ],
    cursor: null, state: "completed", closedAt: new Date(CAPTURE_MS - 22 * 3600_000).toISOString(),
  };
  const list: Record<string, unknown>[] = [p1, p2, p3];
  if (a.scenario.crowded) {
    for (let i = 0; i < 7; i++) {
      const need = i < 2;
      list.push({
        ...p2, ...common(`q${i}`, `Pipeline ${i + 4} · ${["issue triage", "docs sweep", "flaky tests", "release notes", "perf pass", "audit tail", "i18n keys"][i]}`, (i + 2) * 60),
        runs: (p2.runs as { stageId: string; attempts: Record<string, unknown>[] }[]).map((run) => ({ stageId: run.stageId, attempts: run.attempts.map((at) => ({ ...at, agentPath: null, conversationId: null })) })),
        state: need ? "needs_decision" : "running",
      });
    }
  }
  return list;
}

/** Patch today's `/api/files` answer into the scenario's states. */
function patchFiles(body: { files?: Entry[]; pipelines?: unknown[] }, a: Answers): void {
  const byPath = new Map(Object.entries(a.discovered.paths).map(([key, p]) => [p, key] as const));
  const states = { ...BASE_STATES, ...(a.scenario.states ?? {}) };
  const keep: Entry[] = [];
  let pid = 4_400;
  for (const entry of body.files ?? []) {
    const key = byPath.get(entry.path);
    if (!key) { keep.push(entry); continue; }
    if (key.startsWith("x") && !a.scenario.crowded) continue;
    if (key === "orch" && a.scenario.noseat) continue;
    pid += 1;
    const state = key.startsWith("x") ? (["done", "returned", "done", "done", "working", "done", "returned", "done"] as ConversationState[])[Number(key.slice(1)) % 8] : states[key];
    if (state) {
      if (a.scenario.arrival && key === "c6" && !a.arrived) Object.assign(entry, statePatch("working", entry, pid));
      else Object.assign(entry, statePatch(state, entry, pid));
    }
    if (key === "orch") entry.ctx = { usedTokens: 24_000, windowTokens: 100_000, pct: 24, source: "transcript", confidence: "reported", observedAt: "2100-01-02T14:00:00.000Z" };
    if (key === "c1") entry.ctx = { usedTokens: 142_000, windowTokens: 200_000, pct: 71, source: "transcript", confidence: "reported", observedAt: "2100-01-02T14:00:00.000Z" };
    keep.push(entry);
  }
  body.files = keep;
  body.pipelines = pipelinesAnswer(a);
}

const RUNTIME_SNAPSHOT = {
  schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, structuredHostsEnabled: false, serverTime: "2100-01-02T14:02:00.000Z",
  runtime: { hostEpoch: 1, health: "ok" }, filesRevision: 1, sessions: [], attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [],
};

async function installAnswers(page: Page, a: Answers): Promise<{ failSnapshot: () => void }> {
  let snapshotFails = false;
  await page.route("**/api/files*", async (route: Route) => {
    /* Always a full answer: the feed's conditional request would get a 304 for
       an unchanged scan, and the state patches live on this side of it. */
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
    const response = await route.fetch({ headers });
    /* A 304 or a torn-down page answers with no body: pass it through. */
    const text = response.status() === 200 ? await response.text() : "";
    if (!text) { await route.fulfill({ response }); return; }
    const body = JSON.parse(text) as { files?: Entry[]; pipelines?: unknown[] };
    patchFiles(body, a);
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route("**/api/pipelines", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pipelines: pipelinesAnswer(a) }) }));
  await page.route("**/api/orchestrator/seat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seatAnswer(a, !a.scenario.noseat)) }));
  await page.route("**/api/orchestrator/seat?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seatAnswer(a, !a.scenario.noseat)) }));
  await page.route("**/api/orchestrator/seat/status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seatStatus(a)) }));
  if (a.scenario.runtime) {
    await page.route("**/api/runtime/snapshot*", (route) => snapshotFails ? route.abort("connectionrefused") : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNTIME_SNAPSHOT) }));
    await page.route("**/api/runtime/stream*", (route) => route.abort("connectionrefused"));
  }
  return { failSnapshot: () => { snapshotFails = true; } };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Screen drivers                                                              *
 * ────────────────────────────────────────────────────────────────────────── */

interface Reach { reached: boolean; note: string }
interface DriveContext { baseUrl: string; discovered: Discovered; answers: Answers; runtime: { failSnapshot: () => void }; height: number }

const seedInit = () => {
  Object.defineProperty(globalThis, "__llvCaptureMobileV2", { value: true });
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

async function tapFirst(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.count() && await el.isVisible()) { await el.click(); return selector; }
  }
  return null;
}

/** Today's Viewer announces the newest open decision on every load, as a
    toast; the prototype's frames carry a banner only when a decision ARRIVES
    while the operator reads something else (P2-1). The load-time one is
    dismissed so every frame starts from the same quiet state and the arrival
    screen is the one that shows the announcement. Lane 8 owns the rule. */
async function dismissLoadToast(page: Page): Promise<void> {
  const dismiss = page.locator("[data-attention-toast-dismiss]").first();
  if (await dismiss.count()) { await dismiss.click(); await page.waitForTimeout(120); }
}

async function openBoard(page: Page, ctx: DriveContext): Promise<void> {
  await page.goto(`${ctx.baseUrl}/#p=${encodeURIComponent(ctx.discovered.projectId)}`, { waitUntil: "networkidle" });
  /* The desktop root is accepted too: a landscape phone renders the bench
     today, and the bench gate is what says so — a timeout would hide it. */
  await page.waitForSelector(`${HOOKS.shell}, main`, { timeout: 20_000 });
  await settle(page, 700);
  await dismissLoadToast(page);
}

async function openChat(page: Page, ctx: DriveContext, key: string): Promise<void> {
  const transcript = ctx.discovered.paths[key];
  await page.goto(`${ctx.baseUrl}/#f=${encodeURIComponent(transcript)}`, { waitUntil: "networkidle" });
  await page.waitForSelector(`${HOOKS.chatShell}, main`, { timeout: 20_000 });
  await settle(page, 700);
  await dismissLoadToast(page);
}

/** Jump the page's fake clock in steps until the runtime pill reads the
    wanted state (or the steps run out — today's board has no pill, so the
    steps are also the budget). Each step fires the timers that came due and
    then yields real time for the fetches they started. */
async function advanceUntil(page: Page, state: string, stepMs: number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.clock.fastForward(stepMs);
    await page.waitForTimeout(250);
    if (await page.locator(`[data-connection="${state}"]`).count()) return;
  }
}

/** Take the runtime bus through reconnecting → degraded (→ offline) the way a
    phone that lost its host gets there: the stream fails, the reconnects back
    off for 15 s, the bus drops to the 10 s poll (degraded), the poll fails for
    a minute, the SSE retry fails again, and the next failing poll finds
    nothing served for 60 s (offline). */
async function driveRuntime(page: Page, ctx: DriveContext, target: "degraded" | "offline"): Promise<void> {
  await advanceUntil(page, "degraded", 8_500, 4);
  if (target === "offline") {
    ctx.runtime.failSnapshot();
    await advanceUntil(page, "offline", 20_500, 8);
  }
}

/** Open the keyboard the way #979/#983 do: focus the field and shrink the
    visual viewport through the signal the layout subscribes to. */
async function openKeyboard(page: Page): Promise<boolean> {
  const field = page.locator(HOOKS.field).first();
  if (!(await field.count())) return false;
  await field.focus();
  await page.evaluate((keyboard) => {
    const visual = window.visualViewport!;
    const full = visual.height;
    Object.defineProperty(visual, "height", { configurable: true, get: () => full - keyboard });
    visual.dispatchEvent(new Event("resize"));
  }, KEYBOARD_PX);
  await page.waitForTimeout(400);
  return true;
}

const reached = async (page: Page, selector: string, today: string): Promise<Reach> =>
  (await page.locator(selector).count()) > 0 ? { reached: true, note: "" } : { reached: false, note: today };

/** Open a sheet by its v2 opener, else by today's control; report the reach. */
async function openSheet(page: Page, name: string, today: string | null, todayNote: string): Promise<Reach> {
  const tapped = await tapFirst(page, [HOOKS.open(name), ...(today ? [today] : [])]);
  await settle(page);
  if (tapped === HOOKS.open(name) && (await page.locator(HOOKS.sheetOf(name)).count())) return { reached: true, note: "" };
  if (tapped) return { reached: false, note: `${todayNote} (today's control)` };
  return { reached: false, note: `${todayNote} — no control to open it yet` };
}

type Driver = (page: Page, ctx: DriveContext) => Promise<Reach>;

const board = (scenario?: keyof typeof SCENARIOS): Driver => async (page, ctx) => {
  await openBoard(page, ctx);
  if (scenario === "degraded") await driveRuntime(page, ctx, "degraded");
  return reached(page, HOOKS.screen("board"), "today's board: header, strip, focused pane");
};

const chat = (key: string, scenario?: keyof typeof SCENARIOS): Driver => async (page, ctx) => {
  await openChat(page, ctx, key);
  if (scenario === "offline") await driveRuntime(page, ctx, "offline");
  if (scenario === "arrival") {
    ctx.answers.arrived = true;
    /* The next files answer carries the decision; the feed re-reads on the
       product's own refresh signal (what a flow or task mutation fires), and
       the fake clock reaches the 10 s poll too. */
    await page.evaluate(() => window.dispatchEvent(new Event("llv:files-changed")));
    await page.clock.fastForward(10_500);
    await page.waitForSelector("[data-mobile2-banner], [data-attention-toast]", { timeout: 5_000 }).catch(() => undefined);
    await settle(page);
  }
  return reached(page, HOOKS.screen("chat"), "today's focus view: strip, pane header, feed, composer");
};

export const DRIVERS: Record<string, Driver> = {
  "board": board(),
  "board-attention": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "attention", TODAY.attention, "today's attention popover"); },
  "board-projects": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "projects", TODAY.projects, "today's project drawer"); },
  "board-menu": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "menu", TODAY.menu, "today's «More actions» menu"); },
  "board-host": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "host", TODAY.host, "today's hidden shelf"); },
  "board-search": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "search", TODAY.search, "today's search dialog"); },
  "board-noseat": board("noseat"),
  "board-degraded": board("degraded"),
  "board-crowded": board("crowded"),
  "seat": async (page, ctx) => { await openBoard(page, ctx); return openSheet(page, "seat", TODAY.seat, "today's orchestrator sheet"); },
  "seat-rotate": async (page, ctx) => {
    await openBoard(page, ctx);
    const seat = await openSheet(page, "seat", TODAY.seat, "today's orchestrator sheet");
    const rotate = await openSheet(page, "rotate", TODAY.rotate, "today's rotate draft");
    return rotate.reached ? rotate : { reached: false, note: `${seat.note}; ${rotate.note}` };
  },
  "chat-working": chat("c1"),
  "chat-waiting": chat("c2"),
  "chat-idle": chat("c3"),
  "chat-keyboard": async (page, ctx) => {
    await openChat(page, ctx, "c2");
    const opened = await openKeyboard(page);
    const screen = await reached(page, HOOKS.screen("chat"), "today's focus view with the keyboard open");
    return opened ? screen : { reached: false, note: "no composer field to focus" };
  },
  "chat-menu": async (page, ctx) => { await openChat(page, ctx, "c1"); return openSheet(page, "menu", TODAY.menu, "today's «More actions» menu over the conversation"); },
  "chat-switch": async (page, ctx) => { await openChat(page, ctx, "c1"); return openSheet(page, "switch", null, "today's chip strip is the switcher"); },
  "chat-model": async (page, ctx) => { await openChat(page, ctx, "c1"); return openSheet(page, "model", TODAY.model, "today's composer options row"); },
  "chat-host": async (page, ctx) => { await openChat(page, ctx, "c1"); return openSheet(page, "host", TODAY.chatHost, "today's conversation details row"); },
  "chat-orchestrator": chat("orch"),
  "chat-arrival": chat("c1", "arrival"),
  "chat-offline": chat("c1", "offline"),
  "chat-held": chat("c1"),
  "chat-limit": chat("c1"),
  "chat-stalled": chat("c1"),
  "pipelines": async (page, ctx) => {
    await openChat(page, ctx, "c5");
    const tapped = await tapFirst(page, [HOOKS.open("pipelines"), HOOKS.go("pipelines"), TODAY.pipelines]);
    await settle(page);
    if (await page.locator(HOOKS.screen("pipelines")).count()) return { reached: true, note: "" };
    return { reached: false, note: tapped ? "today's pipelines bottom sheet" : "no pipelines entry point on today's phone" };
  },
  "pipeline": async (page, ctx) => {
    await openChat(page, ctx, "c8");
    const tapped = await tapFirst(page, [HOOKS.open("pipelines"), HOOKS.go("pipelines"), TODAY.pipelines]);
    await settle(page);
    await tapFirst(page, ['[data-mobile2-pipeline-row][data-mobile2-state="needs_decision"]', "[data-mobile2-pipeline-row]"]);
    await settle(page);
    if (await page.locator(HOOKS.screen("pipeline")).count()) return { reached: true, note: "" };
    return { reached: false, note: tapped ? "today's pipelines bottom sheet from the stage conversation" : "no pipeline screen on today's phone" };
  },
  "pipeline-running": async (page, ctx) => {
    await openChat(page, ctx, "c9");
    const tapped = await tapFirst(page, [HOOKS.open("pipelines"), HOOKS.go("pipelines"), TODAY.pipelines]);
    await settle(page);
    await tapFirst(page, ['[data-mobile2-pipeline-row][data-mobile2-state="running"]', "[data-mobile2-pipeline-row]"]);
    await settle(page);
    if (await page.locator(HOOKS.screen("pipeline")).count()) return { reached: true, note: "" };
    return { reached: false, note: tapped ? "today's pipelines bottom sheet from the running stage" : "no pipeline screen on today's phone" };
  },
  "accounts": async (page, ctx) => {
    await openBoard(page, ctx);
    const menu = await tapFirst(page, [HOOKS.open("menu")]);
    if (menu) { await settle(page); await tapFirst(page, [HOOKS.go("accounts")]); await settle(page); }
    else {
      await tapFirst(page, [TODAY.projects]);
      await settle(page);
      await tapFirst(page, [TODAY.accounts]);
      await settle(page);
    }
    return reached(page, HOOKS.screen("accounts"), "today's accounts dialog from the project drawer");
  },
};

/* ────────────────────────────────────────────────────────────────────────── *
 * The §3.3 navigation flows — over an abstract page, so the test can run them *
 * ────────────────────────────────────────────────────────────────────────── */

export interface FlowPage {
  /** A fresh board. */
  board(): Promise<void>;
  /** A fresh working conversation. */
  chat(): Promise<void>;
  has(selector: string): Promise<boolean>;
  /** Taps the first visible match; false when there is none. */
  tap(selector: string): Promise<boolean>;
  attr(selector: string, name: string): Promise<string | null>;
  /** One attribute off every match, in document order. */
  list(selector: string, name: string): Promise<string[]>;
  back(): Promise<void>;
  historyLength(): Promise<number>;
  scrollTop(selector: string): Promise<number | null>;
  setScrollTop(selector: string, top: number): Promise<void>;
  swipe(selector: string, dir: "left" | "right"): Promise<void>;
}

class Unreached extends Error {}
class FlowFailure extends Error {}

const need = async (page: FlowPage, selector: string, what: string) => { if (!(await page.has(selector))) throw new Unreached(`${what} (${selector}) is not on the page`); };
const tap = async (page: FlowPage, selector: string, what: string) => { if (!(await page.tap(selector))) throw new Unreached(`${what} (${selector}) is not on the page`); };
const check = (cond: boolean, message: string) => { if (!cond) throw new FlowFailure(message); };

export interface Flow { id: string; title: string; run(page: FlowPage): Promise<void> }

export const FLOWS: Flow[] = [
  {
    id: "pipeline-stage-back",
    title: "Pipeline → stage conversation → ‹ ends on the pipeline",
    async run(page) {
      await page.board();
      await tap(page, HOOKS.go("pipelines"), "the board's pipelines row");
      await need(page, HOOKS.screen("pipelines"), "the pipelines screen");
      await tap(page, "[data-mobile2-pipeline-row]", "a pipeline row");
      await need(page, HOOKS.screen("pipeline"), "the pipeline screen");
      await tap(page, `[data-mobile2-stage]${HOOKS.go("chat")}`, "a stage row with a conversation");
      check(await page.has(HOOKS.screen("chat")), "the stage row did not open its conversation");
      await tap(page, "[data-mobile2-back]", "the bar's ‹");
      check(await page.has(HOOKS.screen("pipeline")), "‹ from a stage conversation did not land on the pipeline");
    },
  },
  {
    id: "menu-accounts-browser-back",
    title: "Board → ⋯ → Accounts → browser back ends on the board with no sheet",
    async run(page) {
      await page.board();
      await tap(page, HOOKS.open("menu"), "the bar's ⋯");
      await need(page, HOOKS.sheetOf("menu"), "the menu sheet");
      await tap(page, HOOKS.go("accounts"), "the Accounts row");
      check(await page.has(HOOKS.screen("accounts")), "the menu row did not open Accounts");
      await page.back();
      check(await page.has(HOOKS.screen("board")), "browser back from Accounts did not land on the board");
      check(!(await page.has("[data-mobile2-sheet]")), "browser back from Accounts landed on a sheet");
    },
  },
  {
    id: "sheet-creates-no-history",
    title: "A sheet opens over the screen and creates no history entry; × closes it onto the same screen",
    async run(page) {
      await page.board();
      const before = await page.historyLength();
      await tap(page, HOOKS.open("menu"), "the bar's ⋯");
      await need(page, HOOKS.sheetOf("menu"), "the menu sheet");
      check((await page.historyLength()) === before, `opening the sheet grew history from ${before} to ${await page.historyLength()}`);
      await tap(page, "[data-mobile2-close]", "the sheet's ×");
      check(!(await page.has("[data-mobile2-sheet]")) && (await page.has(HOOKS.screen("board"))), "closing the sheet did not return to the board");
    },
  },
  {
    id: "attention-close-keeps-scroll",
    title: "⚠ from a conversation → close returns to it at the same scroll offset",
    async run(page) {
      await page.chat();
      await need(page, "[data-mobile2-feed]", "the feed");
      await page.setScrollTop("[data-mobile2-feed]", 40);
      await tap(page, HOOKS.open("attention"), "the bar's ⚠");
      await need(page, HOOKS.sheetOf("attention"), "the Needs you sheet");
      await tap(page, "[data-mobile2-close]", "the sheet's ×");
      check(await page.has(HOOKS.screen("chat")), "closing ⚠ did not return to the conversation");
      const top = await page.scrollTop("[data-mobile2-feed]");
      check(top === 40, `closing ⚠ returned to the conversation at scrollTop ${top}, not 40`);
    },
  },
  {
    id: "swipe-walks-switcher",
    title: "The bar swipe walks the switcher's order minus Recent and bumps at the end",
    async run(page) {
      await page.chat();
      await tap(page, HOOKS.open("switch"), "the title cell");
      await need(page, HOOKS.sheetOf("switch"), "the switcher sheet");
      const rows = await page.list(`${HOOKS.sheetOf("switch")} [data-mobile2-go="chat"]`, "data-mobile2-conversation");
      const sections = await page.list(`${HOOKS.sheetOf("switch")} [data-mobile2-go="chat"]`, "data-mobile2-section");
      const order = rows.filter((_, i) => sections[i] !== "recent");
      check(order.length > 1, "the switcher lists fewer than two conversations outside Recent");
      await tap(page, "[data-mobile2-close]", "the sheet's ×");
      const start = await page.attr(HOOKS.screen("chat"), "data-mobile2-conversation");
      const startIndex = order.indexOf(start ?? "");
      check(startIndex >= 0, `the open conversation ${start} is not in the switcher's order`);
      const walked = [start];
      for (let i = 0; i < order.length + 1; i++) {
        await page.swipe("[data-mobile2-bar]", "left");
        const now = await page.attr(HOOKS.screen("chat"), "data-mobile2-conversation");
        if (now === walked[walked.length - 1]) break;
        walked.push(now);
      }
      const expected = order.slice(startIndex);
      check(JSON.stringify(walked) === JSON.stringify(expected), `the swipe walked ${walked.join(" → ")} but the switcher lists ${expected.join(" → ")}`);
      check(await page.has("[data-mobile2-bump]"), "the last swipe did not bump");
    },
  },
  {
    id: "back-with-sheet-pops-screen",
    title: "A back gesture with a sheet open pops the screen underneath and takes the sheet with it",
    async run(page) {
      await page.board();
      await tap(page, HOOKS.go("pipelines"), "the board's pipelines row");
      await need(page, HOOKS.screen("pipelines"), "the pipelines screen");
      await tap(page, HOOKS.open("menu"), "the bar's ⋯");
      await need(page, HOOKS.sheetOf("menu"), "the menu sheet");
      await page.back();
      check(await page.has(HOOKS.screen("board")), "back with a sheet open did not pop to the board");
      check(!(await page.has("[data-mobile2-sheet]")), "back with a sheet open left a sheet on the page");
    },
  },
];

export async function runFlows(page: FlowPage, flows: Flow[] = FLOWS): Promise<FlowResult[]> {
  const results: FlowResult[] = [];
  for (const flow of flows) {
    try {
      await flow.run(page);
      results.push({ id: flow.id, title: flow.title, status: "green", detail: "" });
    } catch (error) {
      if (error instanceof Unreached) results.push({ id: flow.id, title: flow.title, status: "unreached", detail: error.message });
      else if (error instanceof FlowFailure) results.push({ id: flow.id, title: flow.title, status: "red", detail: error.message });
      else results.push({ id: flow.id, title: flow.title, status: "red", detail: `harness error: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return results;
}

function playwrightFlowPage(page: Page, ctx: DriveContext): FlowPage {
  const first = (selector: string) => page.locator(selector).first();
  return {
    board: () => openBoard(page, ctx),
    chat: () => openChat(page, ctx, "c1"),
    has: async (selector) => (await page.locator(selector).count()) > 0,
    tap: async (selector) => {
      const el = first(selector);
      if (!(await el.count()) || !(await el.isVisible())) return false;
      await el.click();
      await settle(page, 250);
      return true;
    },
    attr: (selector, name) => first(selector).getAttribute(name).catch(() => null),
    list: (selector, name) => page.locator(selector).evaluateAll((els, attribute) => els.map((el) => el.getAttribute(attribute) ?? ""), name),
    back: async () => { await page.goBack(); await settle(page, 250); },
    historyLength: () => page.evaluate(() => history.length),
    scrollTop: (selector) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? (el as HTMLElement).scrollTop : null; }, selector),
    setScrollTop: (selector, top) => page.evaluate(({ sel, t }) => { const el = document.querySelector(sel); if (el) (el as HTMLElement).scrollTop = t; }, { sel: selector, t: top }),
    swipe: async (selector, dir) => {
      await page.evaluate(({ sel, d }) => {
        const bar = document.querySelector(sel);
        if (!bar) return;
        const r = bar.getBoundingClientRect();
        const x0 = d === "left" ? r.right - 20 : r.left + 20;
        const x1 = d === "left" ? r.left + 20 : r.right - 20;
        const y = r.top + r.height / 2;
        const touch = (x: number) => new Touch({ identifier: 1, target: bar, clientX: x, clientY: y });
        bar.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(x0)], changedTouches: [touch(x0)], bubbles: true }));
        bar.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(x1)], changedTouches: [touch(x1)], bubbles: true }));
        bar.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(x1)], bubbles: true }));
      }, { sel: selector, d: dir });
      await settle(page, 250);
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The run                                                                     *
 * ────────────────────────────────────────────────────────────────────────── */

async function discover(baseUrl: string, home: Home): Promise<Discovered> {
  const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Entry[] };
  const owned = (scanned.files ?? []).filter((file) => file.cwd === home.repoDir);
  const projectId = owned[0]?.project ?? "";
  const paths: Record<string, string> = {};
  for (const seed of SEEDS) {
    const hit = owned.find((file) => (file.title ?? "").startsWith(seed.title.slice(0, 24)));
    if (hit) paths[seed.key] = hit.path;
  }
  const missing = SEEDS.filter((seed) => !paths[seed.key]).map((seed) => seed.key);
  if (!projectId || missing.length) throw new Error(`the seeded project did not scan (project ${projectId || "?"}, missing ${missing.join(", ") || "nothing"})`);
  return { projectId, paths };
}

async function newContext(browser: Browser, frame: { width: number; height: number }, scheme: Scheme, projectId: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: frame, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
  await context.addInitScript(seedInit);
  await context.addInitScript(`localStorage.setItem("llvProject", ${JSON.stringify(projectId)});`);
  return context;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  const base = createCaptureDirectory({ envName: "MOBILE_V2_CAPTURE_DIR", prefix: "llv-issue-1439", raw: process.env.MOBILE_V2_CAPTURE_DIR, repoRoot: REPO_ROOT });
  const home = seedHome(base);
  const port = capturePort(process.env.MOBILE_V2_CAPTURE_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!fs.existsSync(path.join(REPO_ROOT, ".next", "BUILD_ID"))) throw new Error("no production build: run `bun run build` first");
  /* `bun --bun`: under node the instrumentation hook dies on the SQLite state
     stores and every request answers 500. */
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: buildEnvironment(home, port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const frames: FrameResult[] = [];
  let flows: FlowResult[] = [];
  try {
    await waitForServer(baseUrl, server);
    const discovered = await discover(baseUrl, home);
    console.log(`frames: ${home.outDir}`);
    const screens = options.only.length ? SCREENS.filter((s) => options.only.includes(s.id)) : SCREENS;
    const matrix: { name: string; width: number; height: number; landscape?: boolean; schemes: readonly Scheme[]; screens: Screen[] }[] = [
      ...FRAMES.map((f) => ({ ...f, schemes: SCHEMES, screens })),
      { ...LANDSCAPE, landscape: true, schemes: ["dark"] as const, screens: screens.filter((s) => LANDSCAPE_SCREENS.includes(s.id)) },
    ];
    for (const frame of matrix) {
      for (const scheme of frame.schemes) {
        const context = await newContext(browser, frame, scheme, discovered.projectId);
        const dir = path.join(home.outDir, frame.name, scheme);
        fs.mkdirSync(dir, { recursive: true });
        for (const screen of frame.screens) {
          const label = `${screen.id}/${frame.name}/${scheme}`;
          const scenario = screen.scenario ? SCENARIOS[screen.scenario] ?? {} : {};
          const answers: Answers = { discovered, repoDir: home.repoDir, scenario, arrived: false };
          const page = await context.newPage();
          const consoleErrors: string[] = [];
          page.on("pageerror", (e) => consoleErrors.push(String(e)));
          /* A 503 on the runtime snapshot is the plane saying it is absent, not a
             page error; the browser's resource-load line for it is noise. */
          page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
          await page.clock.install({ time: CAPTURE_MS });
          const runtime = await installAnswers(page, answers);
          const ctx: DriveContext = { baseUrl, discovered, answers, runtime, height: frame.height };
          let reach: Reach;
          try {
            reach = await DRIVERS[screen.id](page, ctx);
          } catch (error) {
            reach = { reached: false, note: `driver failed: ${error instanceof Error ? error.message : String(error)}` };
          }
          const geometry = await measure(page);
          const keyboard = screen.hash.endsWith("/kb");
          const gates = evaluateGates(geometry, { scheme, keyboard, width: frame.width, height: frame.height, landscape: frame.landscape, consoleErrors });
          const file = path.join(dir, `${screen.id}.png`);
          await page.screenshot({ path: file, animations: "disabled" });
          await page.close();
          frames.push({ frame: frame.name, scheme, id: screen.id, title: screen.title, file: path.relative(home.outDir, file), reached: reach.reached, note: reach.note, gates });
          console.log(`${path.relative(home.outDir, file)}  ${gates.length ? `✕ ${gates.map((g) => g.gate).join(",")}` : "✓"}${reach.reached ? "" : "  (not reached)"}  → ${screen.title}`);
        }
        await context.close();
      }
    }
    if (options.flows) {
      const context = await newContext(browser, FRAMES[0], "dark", discovered.projectId);
      const page = await context.newPage();
      await page.clock.install({ time: CAPTURE_MS });
      const answers: Answers = { discovered, repoDir: home.repoDir, scenario: {}, arrived: false };
      const runtime = await installAnswers(page, answers);
      flows = await runFlows(playwrightFlowPage(page, { baseUrl, discovered, answers, runtime, height: FRAMES[0].height }));
      await context.close();
      for (const flow of flows) console.log(`flow ${flow.id}: ${flow.status}${flow.detail ? ` — ${flow.detail}` : ""}`);
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
  const summary = summarize(frames, flows, options.strict);
  fs.writeFileSync(path.join(home.outDir, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), frames: frames.map(({ gates: _gates, ...rest }) => rest) }, null, 2) + "\n");
  fs.writeFileSync(path.join(home.outDir, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), strict: options.strict, hooks: HOOKS, frames, flows, summary: { ...summary, lines: undefined } }, null, 2) + "\n");
  console.log(`\n${summary.lines.join("\n")}\n\nreport: ${path.join(home.outDir, "report.json")}`);
  process.exitCode = summary.exitCode;
}

/* Guarded so the gates, flows and fixtures above can be imported by the test
   without launching a browser. */
if (import.meta.main) await main();
