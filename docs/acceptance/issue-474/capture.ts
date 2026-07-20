/**
 * Issue #474 visual acceptance capture — off-screen edge-agent chips.
 *
 * Boots the production build (`bun run build` first) against a disposable
 * deterministic fixture home and captures the edge-chip wayfinding surface
 * with puppeteer-core driving a cached chrome-headless-shell:
 *
 *   bun install && bun run build
 *   npx --yes @puppeteer/browsers install chrome-headless-shell@stable   # → LLV_474_CHS
 *   mkdir -p /tmp/llv-pptr && (cd /tmp/llv-pptr && bun add puppeteer-core@23.11.1)
 *   LLV_474_CHS=<shell> LLV_474_PPTR=/tmp/llv-pptr/node_modules \
 *     bun docs/acceptance/issue-474/capture.ts
 *
 * Fixture (created fresh under $TMPDIR/llv-issue-474-fixture on every run):
 *  - Five live claude conversations in project "atlas", each with a descriptive
 *    first user message of *exactly* 48 or 60 characters (both lengths present)
 *    so its chip label overflows the resting width and whichever chip surfaces
 *    proves an exact 48- or 60-character reveal. All mtimes are ~30s old so
 *    every conversation is current work and therefore an edge-navigation
 *    cluster.
 *
 * What the stills prove, in the real production build:
 *  - Desktop (1440×900), folded: reading conversations while others sit
 *    off-screen behind them — crowded clusters fold into a compact «+N» edge
 *    disclosure so navigation chips never paint over open chat content (the
 *    issue #292 anti-overlap contract). Expanding it reveals a labelled,
 *    click-to-fit list.
 *  - Desktop (1440×900), a real *visible* long chip: the board is panned until a
 *    single long-titled off-screen cluster surfaces as an on-edge chip clear of
 *    every pane. Captured at rest (title truncated behind a reserved control
 *    box) and fully revealed through keyboard focus, repeated pointer
 *    progression, and reduced-motion hover — each unfurls the whole exact 48- or
 *    60-char label inside the same button with its scrollWidth contained (no
 *    ellipsis), still inside the viewport, still clear of content. A keep-out
 *    band dropped over the chip's reveal band (standing in for the vertical
 *    agent-avatar/round stack or the composer/input) folds it into «+N» instead
 *    of letting it paint over that surface (operator overlap report).
 *  - Mobile (390×844): a real conversation is open in the phone focus view; every
 *    edge chip / off-screen landmark is gone (the wayfinding adds zero horizontal
 *    overflow), the conversation pane is horizontally contained inside 390px, and
 *    its transcript introduces no horizontal spill.
 *
 * Every assertion is mirrored to evidence.json; a failed assertion fails the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = path.resolve(import.meta.dir);
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PORT = Number(process.env.LLV_474_PORT ?? 3474);
const PPTR_DIR = process.env.LLV_474_PPTR ?? "/tmp/llv-pptr/node_modules";
const CHS = process.env.LLV_474_CHS;
if (!CHS || !fs.existsSync(CHS)) throw new Error("set LLV_474_CHS to a chrome-headless-shell binary");

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/* Titles only: a fresh session id is minted per run (randomUUID) so no
   identifier literal lives in this published harness — the disposable fixture
   home under $TMPDIR is the only place a concrete id is ever written. Each
   title is a generic engineering phrase of *exactly* 48 or 60 characters — the
   two ends of a real current-work label's length band — so whichever chip the
   board surfaces overflows its resting width and its full reveal proves an
   exact 48- or 60-character title rendering end to end. Both exact lengths are
   present, so the harness exercises each. */
const CONVERSATION_TITLES = [
  "Deterministic capture pipeline for stage builder", // 48
  "Off-screen edge navigation with a bounded progressive reveal", // 60
  "Reserved reasoning effort meter on every surface", // 48
  "In-place login recovery for accounts stuck in an error state", // 60
  "Bounded off-screen edge chip progressive reveals", // 48
];

function buildFixtureHome(): string {
  const root = path.join(os.tmpdir(), "llv-issue-474-fixture");
  fs.rmSync(root, { recursive: true, force: true });
  const home = path.join(root, "home");
  const now = Date.now();
  const cwd = "/demo/Projects/atlas";
  const claudeDir = path.join(home, ".claude/projects/-demo-Projects-atlas");
  fs.mkdirSync(claudeDir, { recursive: true });
  const at = (offsetSec: number) => new Date(now - offsetSec * 1000).toISOString();

  CONVERSATION_TITLES.forEach((title, index) => {
    const file = path.join(claudeDir, `${randomUUID()}.jsonl`);
    fs.writeFileSync(
      file,
      jsonl([
        { type: "user", uuid: randomUUID(), timestamp: at(300 + index), cwd, message: { role: "user", content: title } },
        { type: "assistant", uuid: randomUUID(), timestamp: at(60 + index), cwd, message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Working on it — this conversation stays live so it anchors an edge chip." }] } },
      ]),
    );
    const mtime = new Date(now - 30_000 - index * 1000);
    fs.utimesSync(file, mtime, mtime);
  });

  const uid = process.getuid?.() ?? 1000;
  for (const dir of [".config/agent-log-viewer/state", ".cache", "tmp", path.join("tmp", `claude-${uid}`)]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  return home;
}

function serverEnv(home: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LLV_STATE_DIR: path.join(home, ".config/agent-log-viewer/state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

async function waitForServer(child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}\n${logs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/files`);
      if (response.ok) return;
    } catch {
      /* still booting */
    }
    await Bun.sleep(250);
  }
  throw new Error(`server did not become ready\n${logs()}`);
}

type Check = { id: string; detail: string };
const checks: Check[] = [];
function check(condition: boolean, id: string, detail: string): void {
  if (!condition) throw new Error(`FAILED ${id}: ${detail}`);
  checks.push({ id, detail });
  console.log(`  ok ${id}: ${detail}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- puppeteer-core is loaded
   from an out-of-repo install by absolute path, so its types aren't in scope. */
async function placeConversations(page: any): Promise<void> {
  for (let index = 0; index < CONVERSATION_TITLES.length; index += 1) {
    await page.evaluate((idx: number) => {
      let cards = document.querySelectorAll("article.reasoning-host");
      if (cards.length === 0) {
        const opener = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Open the agent switchboard");
        (opener as HTMLElement | undefined)?.click();
      }
      cards = document.querySelectorAll("article.reasoning-host");
      (cards[idx] as HTMLElement | undefined)?.click();
    }, index);
    await Bun.sleep(550);
  }
  // Ensure the switchboard modal is closed so the board (and its edge nav) shows.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(() => Boolean(document.querySelector('input[placeholder*="Search title"]')));
    if (!open) break;
    await page.keyboard.press("Escape");
    await Bun.sleep(200);
  }
}

/* Pan the board (plain wheel = pan; hand tool so a wheel over a pane never
   scrolls it) until an off-screen cluster whose cleaned title is *exactly*
   `targetLen` characters surfaces as an on-edge chip whose reserved reveal band
   is clear of every conversation pane. Targeting the length makes the reveal
   proof deterministic across both ends of the current-work label band (48 and
   60) instead of accepting whichever long chip happens to surface. Returns a
   stable `[data-edge-chip="…"]` selector, or null if that length cannot be
   isolated. The collision geometry only shows a chip whose *fully-revealed*
   width clears content, so a surfaced chip is always safe to unfurl. */
async function surfaceLongVisibleChip(page: any, targetLen: number): Promise<string | null> {
  await page.mouse.move(720, 450);
  await page.keyboard.press("h"); // hand tool: every wheel pans, none scroll a feed
  const directions = [{ x: 320, y: 0 }, { x: -320, y: 0 }, { x: 0, y: 320 }, { x: 0, y: -320 }, { x: 320, y: 320 }, { x: -320, y: -320 }];
  for (const dir of directions) {
    for (let step = 0; step < 30; step += 1) {
      const key = await page.evaluate((len: number) => {
        for (const chip of Array.from(document.querySelectorAll("[data-edge-chip]"))) {
          const title = chip.querySelector("[data-edge-chip-title]") as HTMLElement | null;
          const rect = (chip as HTMLElement).getBoundingClientRect();
          const overflowing = title ? title.scrollWidth - title.clientWidth > 1 : false;
          const exactLength = (title?.textContent || "").length === len;
          const inBounds = rect.width > 0 && rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.top >= 0 && rect.bottom <= window.innerHeight;
          if (overflowing && exactLength && inBounds) return chip.getAttribute("data-edge-chip");
        }
        return null;
      }, targetLen);
      if (key) return `[data-edge-chip="${key}"]`;
      await page.mouse.move(720, 450);
      await page.mouse.wheel({ deltaX: dir.x, deltaY: dir.y });
      await Bun.sleep(90);
    }
  }
  return null;
}

/* The whole reveal proof for one surfaced chip: resting truncation, repeated
   pointer progression, keyboard full-reveal, and reduced-motion hover — each
   asserted to render the exact-length title in full, inside the viewport, clear
   of every conversation pane. Check ids are suffixed with the title length so a
   single run proves BOTH the 48- and the 60-character path (issue #474). */
async function proveChipReveal(page: any, sel: string, len: number, outDir: string): Promise<void> {
  // Resting: title truncated, direction control reserved beside it, in-viewport.
  const resting = await page.evaluate((selector: string) => {
    const chip = document.querySelector(selector) as HTMLElement;
    const control = chip.querySelector("[data-edge-chip-control]") as HTMLElement;
    const title = chip.querySelector("[data-edge-chip-title]") as HTMLElement;
    const cr = control.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    const br = chip.getBoundingClientRect();
    const panes = Array.from(document.querySelectorAll("header.reasoning-host")).map((p) => p.getBoundingClientRect());
    const overlapsPane = panes.some((p) => br.left < p.right && br.right > p.left && br.top < p.bottom && br.bottom > p.top);
    return {
      label: title.textContent || "",
      reveal: title.getAttribute("data-reveal"),
      truncated: title.scrollWidth - title.clientWidth > 1,
      controlBeforeTitle: cr.right <= tr.left + 1,
      inViewport: br.left >= -0.5 && br.right <= window.innerWidth + 0.5,
      width: Math.round(br.width),
      overlapsPane,
    };
  }, sel);
  check(resting.label.length === len, `desktop-chip-exact-length-${len}`, `the surfaced chip carries an exact ${resting.label.length}-character current-work title`);
  check(resting.truncated, `desktop-chip-resting-truncated-${len}`, `the resting ${len}-char chip label "${resting.label}" overflows its resting width — data-reveal ${resting.reveal}`);
  check(resting.controlBeforeTitle, `desktop-chip-control-reserved-${len}`, "the direction control sits in its own reserved box before the title — never over the label");
  check(resting.inViewport, `desktop-chip-resting-in-viewport-${len}`, `the resting pill (width ${resting.width}px) stays inside the 1440px viewport`);
  check(!resting.overlapsPane, `desktop-chip-resting-clear-${len}`, "the resting chip does not overlap any open conversation pane");
  await page.screenshot({ path: path.join(outDir, `desktop-1440-edge-chip-${len}-resting.png`) });
  console.log(`  shot desktop-1440-edge-chip-${len}-resting.png`);

  /* Progressive pointer reveal: repeated moves that reach the truncated end
     unfurl further segments (bounded, within the viewport). */
  const progressed = await page.evaluate(async (selector: string) => {
    const chip = document.querySelector(selector) as HTMLElement;
    const title = chip.querySelector("[data-edge-chip-title]") as HTMLElement;
    const settle = () => new Promise((r) => setTimeout(r, 30));
    chip.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    const reveals: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const end = title.getBoundingClientRect().right;
      chip.dispatchEvent(new PointerEvent("pointermove", { clientX: end - 4, clientY: title.getBoundingClientRect().top + 4, bubbles: true }));
      await settle();
      reveals.push(title.getAttribute("data-reveal") || "?");
    }
    return { reveals, maxRight: chip.getBoundingClientRect().right, viewport: window.innerWidth };
  }, sel);
  const advanced = progressed.reveals.some((r: string, i: number) => i > 0 && Number(r) > Number(progressed.reveals[0] ?? "0")) || progressed.reveals.includes("1");
  check(advanced, `desktop-chip-progressive-reveal-${len}`, `repeated pointer progression unfurls further segments (data-reveal steps ${JSON.stringify(progressed.reveals)})`);
  check(progressed.maxRight <= progressed.viewport + 0.5, `desktop-chip-progress-in-viewport-${len}`, `the progressively-revealed ${len}-char chip stays inside the viewport (right ${Math.round(progressed.maxRight)}px ≤ ${progressed.viewport}px)`);

  // Keyboard focus → the whole label unfurls inside the same button, still bounded.
  await page.evaluate((selector: string) => (document.querySelector(selector) as HTMLElement).focus(), sel);
  await Bun.sleep(200);
  const revealed = await page.evaluate((selector: string) => {
    const chip = document.querySelector(selector) as HTMLElement;
    const title = chip.querySelector("[data-edge-chip-title]") as HTMLElement;
    const br = chip.getBoundingClientRect();
    const panes = Array.from(document.querySelectorAll("header.reasoning-host")).map((p) => p.getBoundingClientRect());
    const overlapsPane = panes.some((p) => br.left < p.right && br.right > p.left && br.top < p.bottom && br.bottom > p.top);
    return {
      reveal: title.getAttribute("data-reveal"),
      fullyShown: title.scrollWidth - title.clientWidth <= 1,
      label: title.textContent || "",
      inViewport: br.left >= -0.5 && br.right <= window.innerWidth + 0.5,
      width: Math.round(br.width),
      overlapsPane,
    };
  }, sel);
  check(revealed.reveal === "full", `desktop-chip-focus-full-${len}`, `keyboard focus sets the ${len}-char title to its full reveal (data-reveal ${revealed.reveal})`);
  check(revealed.fullyShown, `desktop-chip-fully-revealed-${len}`, `the whole ${revealed.label.length}-char label "${revealed.label}" is visible with no ellipsis — its scrollWidth is contained within the pill once revealed`);
  check(revealed.inViewport, `desktop-chip-revealed-in-viewport-${len}`, `the fully-revealed pill (width ${revealed.width}px) stays inside the 1440px viewport`);
  check(!revealed.overlapsPane, `desktop-chip-revealed-clear-${len}`, "the fully-revealed chip still does not overlap any open conversation pane");
  await page.screenshot({ path: path.join(outDir, `desktop-1440-edge-chip-${len}-revealed.png`) });
  console.log(`  shot desktop-1440-edge-chip-${len}-revealed.png`);

  /* Reduced motion: a hover (no keyboard, no stepping) settles the whole label
     at once — still fully contained (scrollWidth ≤ pill) and inside the
     viewport. Blur first so the reveal comes from the hover alone. */
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.evaluate((selector: string) => (document.querySelector(selector) as HTMLElement).blur(), sel);
  await Bun.sleep(100);
  const reduced = await page.evaluate(async (selector: string) => {
    const chip = document.querySelector(selector) as HTMLElement;
    const title = chip.querySelector("[data-edge-chip-title]") as HTMLElement;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    chip.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    const br = chip.getBoundingClientRect();
    return {
      reveal: title.getAttribute("data-reveal"),
      fullyShown: title.scrollWidth - title.clientWidth <= 1,
      label: title.textContent || "",
      inViewport: br.left >= -0.5 && br.right <= window.innerWidth + 0.5,
    };
  }, sel);
  check(reduced.reveal === "full", `desktop-chip-reduced-motion-hover-${len}`, `reduced-motion hover reveals the whole ${len}-char label at once (data-reveal ${reduced.reveal})`);
  check(reduced.fullyShown, `desktop-chip-reduced-motion-contained-${len}`, `under reduced motion the ${reduced.label.length}-char label shows in full with its scrollWidth contained inside the pill (no ellipsis)`);
  check(reduced.inViewport, `desktop-chip-reduced-motion-in-viewport-${len}`, "the reduced-motion reveal stays inside the 1440px viewport");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.evaluate((selector: string) => (document.querySelector(selector) as HTMLElement).blur(), sel);
  await Bun.sleep(100);
}

/* The production obstacle matrix: every keep-out *class* a surfaced edge chip
   must never paint over, plus the fully-blocked-edge case that forces the «+N»
   aggregate to re-home or suppress. Each row is dropped over a freshly surfaced
   long chip's reserved reveal band as a `data-chip-keepout` surface; the board
   must fold that chip and leave every remaining chip AND every «+N» aggregate
   trigger clear of every keep-out. `fullEdge` walls the whole border the chip
   sits on, so the aggregate has no clear slot on its own edge and must re-home
   to a clear border (or suppress) without ever docking over the wall — issue
   #474 nullable / re-homed aggregate placement. Table-driven so a single run
   exercises pane, avatar-rail, round-badge and composer obstacles plus the
   fully-blocked aggregate deterministically. */
type KeepoutProbe = {
  id: string;
  detail: string;
  /** Keep-out geometry relative to the surfaced chip's box `r` and the viewport. */
  band: (r: { left: number; top: number; width: number; height: number }, vw: number, vh: number) => { left: number; top: number; width: number; height: number };
  /** Wall the entire edge the chip sits on (fully-blocked aggregate). */
  fullEdge?: boolean;
};
const KEEPOUT_PROBES: KeepoutProbe[] = [
  { id: "avatar-rail", detail: "a subagent avatar/round column poking in at the chip's edge", band: (r) => ({ left: Math.round(r.left), top: Math.round(r.top - 12), width: 44, height: Math.round(r.height + 44) }) },
  { id: "round-badge", detail: "a round/reasoning badge landing on the chip", band: (r) => ({ left: Math.round(r.left), top: Math.round(r.top), width: 40, height: 40 }) },
  { id: "composer", detail: "the composer/input band overlapping the chip", band: (r) => ({ left: Math.round(r.left - 40), top: Math.round(r.top - 6), width: 260, height: Math.round(r.height + 12) }) },
  { id: "pane", detail: "an open conversation pane overlapping the chip's reveal band", band: (r) => ({ left: Math.round(r.left - 30), top: Math.round(r.top - 30), width: 360, height: Math.round(r.height + 60) }) },
  /* Wall the whole edge the chip sits on. Anchored off the chip's own box (not
     the window border) so it walls the chip's reveal band AND the aggregate's
     docking strip regardless of any board inset — spanning the full length of
     that edge so no slot along it stays clear, forcing the «+N» aggregate to
     re-home to another border (or suppress). */
  { id: "blocked-edge", detail: "the whole edge walled — the aggregate must re-home or suppress", fullEdge: true, band: (r, vw, vh) => {
    const pad = 24;
    if (r.left <= pad) return { left: Math.round(r.left - 30), top: 0, width: 90, height: vh };
    if (r.left + r.width >= vw - pad) return { left: Math.round(r.left + r.width - 60), top: 0, width: 90, height: vh };
    return { left: 0, top: Math.round(r.top - 30), width: vw, height: Math.round(r.height + 50) };
  } },
];

async function proveObstacleMatrix(page: any, outDir: string): Promise<void> {
  for (const probe of KEEPOUT_PROBES) {
    /* Freshly surface a long chip so each probe starts from a clean board. */
    const sel = await surfaceLongVisibleChip(page, 60);
    check(Boolean(sel), `desktop-keepout-precondition-${probe.id}`, `a surfaced chip is present before the ${probe.id} keep-out is placed (${probe.detail})`);
    /* Read the surfaced chip's box + which edge it sits on, then compute this
       probe's keep-out band from it and drop the band over the reveal band. */
    const geom = await page.evaluate((selector: string) => {
      const r = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
      const edge = r.left <= 24 ? "left" : r.right >= window.innerWidth - 24 ? "right" : r.top <= 24 ? "top" : "bottom";
      return { left: r.left, top: r.top, width: r.width, height: r.height, edge, vw: window.innerWidth, vh: window.innerHeight };
    }, sel!);
    const band = probe.band(geom, geom.vw, geom.vh);
    const placed = { edge: geom.edge };
    await page.evaluate((b: { left: number; top: number; width: number; height: number }) => {
      const el = document.createElement("div");
      el.setAttribute("data-chip-keepout", "");
      el.id = "llv-474-keepout-probe";
      Object.assign(el.style, {
        position: "fixed", left: `${b.left}px`, top: `${b.top}px`,
        width: `${b.width}px`, height: `${b.height}px`, zIndex: "5", pointerEvents: "none",
      });
      document.body.appendChild(el);
    }, band);
    await Bun.sleep(500); // MutationObserver → re-measure → re-render
    const result = await page.evaluate((selector: string) => {
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const keepouts = Array.from(document.querySelectorAll("[data-chip-keepout]")) as HTMLElement[];
      const overlapsKeepout = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0) return false;
        return keepouts.some((k) => { const kr = k.getBoundingClientRect(); return kr.width > 0 && kr.height > 0 && overlaps(r, kr); });
      };
      const chips = Array.from(document.querySelectorAll("[data-edge-chip]")) as HTMLElement[];
      const anyChipOverlap = chips.some(overlapsKeepout);
      const triggerEls = Array.from(document.querySelectorAll('nav[aria-label="Off-screen work"] button')).filter((b) => /^\+\d+$/.test((b.textContent || "").trim())) as HTMLElement[];
      const triggerOverlap = triggerEls.some(overlapsKeepout);
      document.getElementById("llv-474-keepout-probe")?.remove();
      return { chipGone: !document.querySelector(selector), anyChipOverlap, triggerCount: triggerEls.length, triggerOverlap };
    }, sel!);
    check(result.chipGone, `desktop-chip-folds-off-${probe.id}`, `a chip whose reserved reveal band meets ${probe.detail} folds into its «+N» disclosure instead of painting over it`);
    check(!result.anyChipOverlap, `desktop-chip-clears-${probe.id}`, `no visible edge chip overlaps the ${probe.id} keep-out surface`);
    check(!result.triggerOverlap, `desktop-aggregate-clears-${probe.id}`, `every folded «+N» aggregate trigger (${result.triggerCount}) docks clear of the ${probe.id} keep-out`);
    if (probe.fullEdge) {
      /* The wall covers the entire blocked edge's docking strip, so a trigger
         clear of it (asserted above) is by construction not docking on the
         blocked edge. With only that one edge walled a clear border remains, so
         the aggregate must re-home there rather than suppress — a still-present,
         keyboard-reachable «+N» disclosure preserves navigation to the folded
         off-screen clusters (issue #474). */
      check(result.triggerCount >= 1, "desktop-aggregate-rehomes-off-blocked-edge", `with the ${placed.edge} edge fully walled the «+N» aggregate re-homes to a clear border and stays a keyboard-reachable disclosure (${result.triggerCount} trigger(s), all clear of the wall)`);
    }
    await Bun.sleep(400); // re-measure back to a clean board before the next probe
  }
  await page.screenshot({ path: path.join(outDir, "desktop-1440-edge-chip-keepout-clear.png") });
  console.log("  shot desktop-1440-edge-chip-keepout-clear.png");
}

async function main(): Promise<void> {
  const home = buildFixtureHome();
  console.log(`fixture home: ${home}`);

  /* The reveal proof is only meaningful if the fixture really carries exact
     48- and 60-character titles: pin that before booting anything. */
  const titleLengths = CONVERSATION_TITLES.map((title) => title.length);
  check(titleLengths.every((n) => n === 48 || n === 60), "fixture-exact-title-lengths", `every fixture title is exactly 48 or 60 characters (${JSON.stringify(titleLengths)})`);
  check(titleLengths.includes(48) && titleLengths.includes(60), "fixture-covers-48-and-60", "the fixture exercises both an exact 48- and an exact 60-character current-work title");

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: REPO_ROOT,
    env: serverEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  server.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  server.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const logs = () => chunks.join("").slice(-8000);

  const { default: puppeteer } = await import(pathToFileURL(path.join(PPTR_DIR, "puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")).href);
  const browser = await puppeteer.launch({ executablePath: CHS, args: ["--no-sandbox", "--force-color-profile=srgb"] });
  try {
    await waitForServer(server, logs);
    const base = `http://127.0.0.1:${PORT}/`;
    const noAnim = `*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }`;

    /* 1) Desktop: read conversations while the rest sit off-screen and fold into
          the "Off-screen work" navigation landmark. */
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.emulateTimezone("UTC");
      await page.goto(`${base}#p=atlas`, { waitUntil: "networkidle2", timeout: 60_000 });
      await page.addStyleTag({ content: noAnim });
      await placeConversations(page);

      await page.waitForFunction(() => Boolean(document.querySelector('nav[aria-label="Off-screen work"]')), { timeout: 30_000 });
      const nav = await page.evaluate(() => {
        const el = document.querySelector('nav[aria-label="Off-screen work"]') as HTMLElement;
        const triggers = Array.from(el.querySelectorAll("button")).filter((b) => /^\+\d+$/.test((b.textContent || "").trim()));
        return {
          pointerEvents: getComputedStyle(el).pointerEvents,
          triggerCount: triggers.length,
          firstTrigger: triggers[0]?.textContent?.trim() ?? null,
          firstTriggerAria: triggers[0]?.getAttribute("aria-label") ?? null,
          firstTriggerExpanded: triggers[0]?.getAttribute("aria-expanded") ?? null,
          offscreen: triggers.reduce((sum, t) => sum + Number((t.textContent || "+0").replace("+", "")), 0),
        };
      });
      check(nav.pointerEvents === "none", "desktop-nav-cannot-block-content", `the off-screen navigation landmark is pointer-events:${nav.pointerEvents} — only its chips take pointer input, never covering chat content (issue #292)`);
      check(nav.triggerCount >= 1, "desktop-offscreen-disclosure", `${nav.triggerCount} «+N» edge disclosure(s) present for ${nav.offscreen} off-screen current-work cluster(s)`);
      check(/^\+\d+$/.test(nav.firstTrigger ?? ""), "desktop-disclosure-count", `the edge disclosure shows its folded count "${nav.firstTrigger}"`);
      check((nav.firstTriggerAria ?? "").length > 0 && nav.firstTriggerExpanded === "false", "desktop-disclosure-a11y", `the disclosure is a collapsed, labelled control (aria-label "${nav.firstTriggerAria}", aria-expanded ${nav.firstTriggerExpanded})`);
      await page.screenshot({ path: path.join(OUT_DIR, "desktop-1440-offscreen-edge-nav.png") });
      console.log("  shot desktop-1440-offscreen-edge-nav.png");

      // Expand the disclosure: the labelled, click-to-fit off-screen list.
      await page.evaluate(() => {
        const el = document.querySelector('nav[aria-label="Off-screen work"]') as HTMLElement;
        const trigger = Array.from(el.querySelectorAll("button")).find((b) => /^\+\d+$/.test((b.textContent || "").trim()));
        (trigger as HTMLElement | undefined)?.click();
      });
      await page.waitForFunction(() => document.querySelectorAll("[data-overflow-chip]").length > 0, { timeout: 10_000 });
      const list = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("[data-overflow-chip]"));
        return {
          count: items.length,
          allButtons: items.every((i) => i.tagName === "BUTTON"),
          labels: items.map((i) => (i.textContent || "").trim()),
          expanded: document.querySelector('nav[aria-label="Off-screen work"] button[aria-expanded="true"]') !== null,
        };
      });
      check(list.count >= 1 && list.allButtons, "desktop-offscreen-list", `expanding reveals ${list.count} click-to-fit off-screen conversation button(s)`);
      check(
        list.labels.every((l: string) => CONVERSATION_TITLES.includes(l)),
        "desktop-offscreen-labels",
        `every off-screen entry carries its WHOLE cleaned title, never a truncation (${JSON.stringify(list.labels)})`,
      );
      check(list.expanded, "desktop-disclosure-expands", "the disclosure reports aria-expanded=true once opened");
      await page.screenshot({ path: path.join(OUT_DIR, "desktop-1440-offscreen-edge-nav-expanded.png") });
      console.log("  shot desktop-1440-offscreen-edge-nav-expanded.png");

      /* Close the disclosure, then prove the reveal for BOTH ends of the
         current-work label band deterministically: surface a chip whose title
         is exactly 48 characters, run the whole reveal proof (resting
         truncation, repeated pointer progression, keyboard full-reveal,
         reduced-motion hover), then do the same for an exactly 60-character
         chip. Neither is left to "whichever chip happens to surface". */
      await page.keyboard.press("Escape");
      await Bun.sleep(150);
      for (const len of [48, 60] as const) {
        const surfaced = await surfaceLongVisibleChip(page, len);
        check(Boolean(surfaced), `desktop-visible-chip-isolated-${len}`, `panned the board until an exact ${len}-character chip surfaced on an edge, clear of every conversation pane`);
        await proveChipReveal(page, surfaced!, len, OUT_DIR);
      }

      /* Table-driven obstacle matrix: pane / avatar-rail / round-badge / composer
         keep-outs each fold a surfaced chip and leave every chip + «+N» aggregate
         clear, and the fully-blocked edge forces the aggregate to re-home off it
         or suppress — never docking over the wall (issue #474). */
      await proveObstacleMatrix(page, OUT_DIR);
      await page.close();
    }

    /* 2) 390px: a real conversation is open in the phone focus view; every edge
          chip is gone, the conversation pane is contained inside 390px, and its
          transcript introduces no horizontal spill. */
    {
      /* Deep-link straight to a real fixture conversation (#c=<id> / #f=<path>):
         the phone shell opens it in the focus view — the same code path a tap on
         a conversation row takes, but deterministic. */
      const catalog = await (await fetch(`http://127.0.0.1:${PORT}/api/files`)).json();
      const atlas = (catalog.files as any[]).filter((f) => (f.cwd || f.projectRoot || "").includes("atlas") && String(f.path).endsWith(".jsonl"));
      const target = atlas[0];
      if (!target) throw new Error("no fixture conversation found in /api/files");
      const hash = target.conversationId ? `#c=${encodeURIComponent(target.conversationId)}` : `#f=${encodeURIComponent(target.path)}`;

      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.emulateTimezone("UTC");
      await page.goto(`${base}${hash}`, { waitUntil: "networkidle2", timeout: 60_000 });
      await page.addStyleTag({ content: noAnim });
      await page.waitForFunction(() => document.querySelectorAll("header.reasoning-host").length > 0, { timeout: 30_000 });
      await Bun.sleep(500);
      const mobile = await page.evaluate(() => {
        const vw = window.innerWidth;
        const host = document.querySelector("header.reasoning-host") as HTMLElement | null;
        /* The conversation pane: the nearest ancestor of the transcript header
           that clips its own overflow (the phone focus column). Its containment
           is what "the open conversation is contained" means. */
        const clipsX = (el: HTMLElement) => ["hidden", "auto", "scroll", "clip"].includes(getComputedStyle(el).overflowX);
        let pane: HTMLElement | null = host;
        for (let el = host?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
          if (clipsX(el)) { pane = el; break; }
        }
        const paneRect = pane?.getBoundingClientRect() ?? null;
        /* Any element inside the conversation pane that visibly spills past the
           viewport without being clipped by a contained scroll container. */
        let paneOverflowRight = 0;
        if (pane) {
          const clipped = (el: HTMLElement) => {
            for (let p = el.parentElement; p && p !== pane!.parentElement; p = p.parentElement) {
              if (clipsX(p) && p.getBoundingClientRect().right <= vw + 1) return true;
            }
            return false;
          };
          for (const el of Array.from(pane.querySelectorAll("*")) as HTMLElement[]) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 1 && !clipped(el)) paneOverflowRight = Math.max(paneOverflowRight, Math.round(r.right));
          }
        }
        const chips = document.querySelectorAll("[data-edge-chip]");
        return {
          chips: chips.length,
          nav: Boolean(document.querySelector('nav[aria-label="Off-screen work"]')),
          conversationOpen: Boolean(host),
          paneLeft: paneRect ? Math.round(paneRect.left) : 0,
          paneRight: paneRect ? Math.round(paneRect.right) : 0,
          paneScrollOverflow: pane ? pane.scrollWidth - pane.clientWidth : 0,
          paneOverflowRight,
          innerWidth: vw,
        };
      });
      check(mobile.conversationOpen, "mobile-conversation-open", `a real fixture conversation is open in the phone focus view (pane ${mobile.paneLeft}–${mobile.paneRight}px)`);
      check(mobile.chips === 0 && !mobile.nav, "mobile-chips-removed", `every edge chip and the off-screen navigation landmark are removed on the 390px shell (chips ${mobile.chips}, nav ${mobile.nav})`);
      check(mobile.paneLeft >= -1 && mobile.paneRight <= mobile.innerWidth + 1, "mobile-conversation-contained", `the open conversation pane is horizontally contained inside 390px (left ${mobile.paneLeft}px, right ${mobile.paneRight}px)`);
      check(mobile.paneScrollOverflow <= 1 && mobile.paneOverflowRight === 0, "mobile-content-unobstructed", `the conversation content introduces no horizontal overflow and no edge chip overlays it (pane scroll overflow ${mobile.paneScrollOverflow}px, spill ${mobile.paneOverflowRight}px)`);
      await page.screenshot({ path: path.join(OUT_DIR, "mobile-390-conversation-contained.png") });
      console.log("  shot mobile-390-conversation-contained.png");
      await page.close();
    }

    fs.writeFileSync(
      path.join(OUT_DIR, "evidence.json"),
      JSON.stringify({
        issue: 474,
        capturedAt: new Date().toISOString(),
        viewer: "production next start",
        viewport: { desktop: "1440x900", mobile: "390x844" },
        interactionSuite: "src/components/scheme/EdgeChips.hover.dom.test.tsx (continuous surface, reserved control box, bounded progressive reveal, repeated progression within viewport bounds, keyboard full-reveal, reduced motion, exact 48- and 60-character titles unfurled through focus + repeated progression + reduced-motion hover, click fit, coarse-pointer removal) + src/components/scheme/EdgeChips.dom.test.tsx (a fully blocked edge re-homes the «+N» aggregate to a clear border, keeping it a keyboard-reachable disclosure) + src/components/scheme/offscreenClusters.test.ts (measured admission: a chip is admitted only when its *measured* rendered width fits at its anchor, so a wide-glyph exact 48/60-char title folds while a title that fits is admitted with exactly its measured band reserved; a top/bottom chip pinned near a corner folds into «+N» rather than render a permanently-truncated sliver; a chip whose measured reveal band overlaps a pane / the subagent avatar/round stack / the composer/input keep-out folds instead of painting over it; overflowAnchor returns null when an edge is fully blocked and resolveOverflowPlacement re-homes the «+N» aggregate to the nearest clear border, suppressing only when the whole viewport border is blocked)",
        checks,
      }, null, 2) + "\n",
    );
    console.log(`all ${checks.length} checks passed`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await Bun.sleep(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
}

await main();
