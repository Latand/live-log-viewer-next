/**
 * Rendered verification of the #771 board selection UX, in a real browser:
 *
 *   bun scripts/capture-issue-771-selection.ts
 *
 * Boots the disposable demo fixture home (the same isolated environment the demo
 * stills use — never the operator's live state), serves it from the production
 * build, and drives the real board with the locally cached Chromium. Two
 * behaviours are checked with the real CSS, real hover and real native text
 * selection that no DOM test can stand in for:
 *
 *   Gap 1 — a background drag across cards lassos them and leaves NO native
 *     text selection. A transcript is highlighted first, so the assertion also
 *     covers the clearing a background press owes.
 *   Gap 2 — the check is invisible at rest, fades in when the pointer comes near
 *     a card's top-right corner, and clicking it toggles that card in and back
 *     out of the same blue selection.
 *
 * Screenshots land outside the repository for direct inspection:
 *
 *   <out>/771-idle.png            — quiet board, no badge clutter
 *   <out>/771-lasso-active.png    — mid-drag, rect over a card, nothing highlighted
 *   <out>/771-lasso-committed.png — after release: selected, no stray highlight
 *   <out>/771-check-revealed.png  — the semi-transparent check under the pointer
 *   <out>/771-check-selected.png  — the same card selected by that click
 *   <out>/771-check-deselected.png — selection dropped by a second click
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { bootstrapDemoRuntime, demoPort } from "./demo-capture";

const OUT_DIR = process.env.SELECTION_CAPTURE_OUT_DIR ?? "/tmp/llv-issue-771";
const PROJECT = "atlas";

/** Deterministic prelude, matching the demo stills: pin the clock, drop the live
    SSE/observer churn, and clear any prior board camera/prefs. */
const seedInit = () => {
  const captureTime = Date.parse("2100-01-02T12:00:00.000Z");
  const NativeDate = Date;
  class CaptureDate extends NativeDate {
    constructor(...args: unknown[]) {
      super(...((args.length ? args : [captureTime]) as []));
    }
    static now() { return captureTime; }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/files`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** What the board published into the view slice, i.e. what the orchestrator sees. */
const selectedPaths = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('[data-lasso-selected="true"]')).map((node) => node.getAttribute("data-scheme-node")));

const nativeSelection = (page: Page) => page.evaluate(() => String(window.getSelection() ?? ""));

/** An empty-canvas point at a given height: the press that starts a lasso has to
    land on the background, not on a card, a halo header or a toolbar. */
async function backgroundPointAt(page: Page, y: number): Promise<{ x: number; y: number }> {
  const x = await page.evaluate(
    (row) => {
      const occupied = "[data-scheme-node],[data-scheme-task],[data-scheme-ui],[data-pipeline-group-header],button,a,input,textarea";
      for (let candidate = 1410; candidate > 270; candidate -= 6) {
        const element = document.elementFromPoint(candidate, row);
        if (!element) continue;
        if (element.closest(occupied)) continue;
        if (!element.closest('[aria-label^="Agent board"]')) continue;
        return candidate;
      }
      return null;
    },
    y,
  );
  must(x !== null, `found no empty canvas at y=${y}`);
  return { x: x!, y };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.SELECTION_CAPTURE_PORT, 3033, "SELECTION_CAPTURE_PORT");
  /* Reuse the demo runtime purely to materialize the disposable fixture home,
     then stop its dev server and serve the SAME home from the production build. */
  const runtime = await bootstrapDemoRuntime(repoRoot, port + 1);
  await runtime.shutdown();
  const env = { ...runtime.env, NODE_ENV: "production" as const, PORT: String(port) };
  const baseUrl = `http://127.0.0.1:${port}`;
  const outDir = path.isAbsolute(OUT_DIR) ? OUT_DIR : path.join(repoRoot, OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer(baseUrl, server);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.addInitScript(seedInit);
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.evaluate((project) => { location.hash = `#p=${project}`; }, PROJECT);
    await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
    /* Frame the whole board, then come back to 1:1 — the check and any highlighted
       text have to be judged at the zoom an operator actually reads at, not at the
       40% fit where far-zoom puts the pane feeds to sleep. */
    await page.evaluate(() => {
      const fit = Array.from(document.querySelectorAll("button")).find((button) =>
        (button.getAttribute("title") || "").startsWith("Fit all content"),
      );
      if (fit instanceof HTMLElement) fit.click();
    });
    await page.waitForTimeout(1200);
    for (let step = 0; step < 1; step += 1) {
      await page.evaluate(() => {
        const zoomIn = Array.from(document.querySelectorAll("button")).find((button) =>
          (button.getAttribute("title") || "").startsWith("Zoom in"),
        );
        if (zoomIn instanceof HTMLElement) zoomIn.click();
      });
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2400);

    const cards = await page.locator("[data-scheme-node]:not([data-scheme-node^='slot::'])").evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { path: node.getAttribute("data-scheme-node")!, x: rect.x, y: rect.y, w: rect.width, h: rect.height, bottom: rect.bottom, right: rect.right };
        })
        .filter((card) => card.w > 200 && card.h > 150 && card.y > 60 && card.x > 260 && card.right < 1420)
        .sort((a, b) => a.x - b.x),
    );
    if (cards.length < 2) {
      const all = await page.locator("[data-scheme-node]").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return `${node.getAttribute("data-scheme-node")} @ ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }),
      );
      throw new Error(`expected at least two cards with a visible top-right corner, found ${cards.length}:\n  ${all.join("\n  ")}`);
    }
    const target = cards[0]!;
    const other = cards[1]!;

    /* ── Idle: no badge clutter on a quiet board ─────────────────────────── */
    const restOpacity = await page.evaluate(
      (p) => getComputedStyle(document.querySelector(`[data-select-check="${p}"]`)!).opacity,
      target.path,
    );
    must(restOpacity === "0", `the check must be invisible at rest, computed opacity was ${restOpacity}`);
    await page.screenshot({ path: path.join(outDir, "771-idle.png") });

    /* ── Gap 1: a background drag across a card ──────────────────────────── */
    /* Highlight a transcript first: a background press owes the clearing that
       its suppressed compatibility mousedown would have done. */
    await page.evaluate((p) => {
      const shell = document.querySelector(`[data-scheme-node="${p}"]`)!;
      const range = document.createRange();
      range.selectNodeContents(shell);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, target.path);
    must((await nativeSelection(page)).length > 0, "failed to seed a native text selection inside the card");

    const mid = Math.min(target.y + target.h / 2, 860);
    const from = await backgroundPointAt(page, Math.min(target.y + 40, 860));
    const to = { x: target.x + target.w / 2, y: mid };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 10, from.y + 12, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await page.waitForTimeout(250);
    const midDragSelection = await nativeSelection(page);
    must(midDragSelection === "", `mid-drag the browser must have nothing highlighted, had ${JSON.stringify(midDragSelection.slice(0, 80))}`);
    await page.screenshot({ path: path.join(outDir, "771-lasso-active.png") });

    await page.mouse.up();
    await page.waitForTimeout(400);
    const afterDrag = await selectedPaths(page);
    must(afterDrag.includes(target.path), `the drag must select the card it crossed, selection was ${afterDrag.join(", ")}`);
    const afterDragSelection = await nativeSelection(page);
    must(afterDragSelection === "", `the gesture must end with nothing highlighted, had ${JSON.stringify(afterDragSelection.slice(0, 80))}`);
    await page.screenshot({ path: path.join(outDir, "771-lasso-committed.png") });

    /* Text selection is handed back: a real drag inside the transcript still
       highlights, so the suppression was scoped to the gesture. */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    /* Drag across a run of real transcript text, found by measuring the card's
       own text nodes — arbitrary coordinates inside a pane can land on padding. */
    const textRun = await page.evaluate((p) => {
      const shell = document.querySelector(`[data-scheme-node="${p}"]`)!;
      const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim().length < 12) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 4 || rect.top < 60 || rect.bottom > 890) continue;
        return { x: rect.x, y: rect.y + rect.height / 2, w: rect.width };
      }
      return null;
    }, target.path);
    must(textRun !== null, "found no measurable transcript text to drag across");
    await page.mouse.move(textRun!.x + 1, textRun!.y);
    await page.mouse.down();
    await page.mouse.move(textRun!.x + textRun!.w - 1, textRun!.y, { steps: 10 });
    await page.mouse.up();
    const insideText = await nativeSelection(page);
    must(insideText.length > 0, "deliberate selection inside conversation content must still work after a lasso");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    /* ── Gap 2: the hover-revealed check ────────────────────────────────── */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    must((await selectedPaths(page)).length === 0, "expected a clean board before the check gesture");

    const check = page.locator(`[data-select-check="${other.path}"]`);
    const box = (await check.boundingBox())!;
    must(box.y < other.y + 4 && box.x + box.width > other.right - 4, "the check must sit at the card's top-right corner, outside its content box");
    /* Approach the corner from empty canvas — this is the reveal. */
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const revealedOpacity = await page.evaluate(
      (p) => getComputedStyle(document.querySelector(`[data-select-check="${p}"]`)!).opacity,
      other.path,
    );
    must(revealedOpacity === "1", `hovering the corner must reveal the check, computed opacity was ${revealedOpacity}`);
    await page.screenshot({ path: path.join(outDir, "771-check-revealed.png") });
    /* A close crop of the corner, so the badge's weight against the card frame
       and its clearance from the pane's own header controls can be judged. */
    const crop = {
      x: Math.max(0, Math.round(other.x + other.w - 190)),
      y: Math.max(0, Math.round(other.y - 40)),
      width: 240,
      height: 130,
    };
    await page.screenshot({ path: path.join(outDir, "771-check-revealed-crop.png"), clip: crop });

    await check.click();
    await page.waitForTimeout(400);
    const afterCheck = await selectedPaths(page);
    must(afterCheck.length === 1 && afterCheck[0] === other.path, `the check must select exactly its own card, selection was ${afterCheck.join(", ")}`);
    must((await check.getAttribute("aria-pressed")) === "true", "a member's check must read as pressed");
    await page.screenshot({ path: path.join(outDir, "771-check-selected.png") });
    await page.screenshot({ path: path.join(outDir, "771-check-selected-crop.png"), clip: crop });
    /* The idle card next to it keeps a visible toggle while the session runs. */
    const neighbourRevealed = await page.evaluate(
      (p) => getComputedStyle(document.querySelector(`[data-select-check="${p}"]`)!).opacity,
      target.path,
    );
    must(neighbourRevealed === "1", `a running session must show every card's toggle, neighbour opacity was ${neighbourRevealed}`);

    /* The non-member's check must NOT read as disabled while the session recedes
       its card. Ancestor opacity/filter composites a whole subtree and no
       descendant can opt out, so the dim is applied to the shell's children with
       the check's zone excluded — assert exactly that, with the real cascade. */
    const dimShape = await page.evaluate((p) => {
      const shell = document.querySelector(`[data-scheme-node="${p}"]`) as HTMLElement;
      const zone = document.querySelector(`[data-select-check="${p}"]`)!.parentElement as HTMLElement;
      const content = Array.from(shell.children).find((child) => child !== zone) as HTMLElement;
      const read = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, filter: style.filter };
      };
      return { shell: read(shell), zone: read(zone), content: read(content), zoneIsChild: zone.parentElement === shell };
    }, target.path);
    must(dimShape.zoneIsChild, "the check's zone must be a direct child of the card shell for the dim exclusion to apply");
    must(dimShape.shell.opacity === "1", `the shell itself must not be faded, was ${dimShape.shell.opacity}`);
    must(dimShape.shell.filter === "none", `the shell itself must not be greyed, was ${dimShape.shell.filter}`);
    must(dimShape.zone.opacity === "1", `the check's zone must stay at full opacity, was ${dimShape.zone.opacity}`);
    must(dimShape.zone.filter === "none", `the check's zone must not be greyed, was ${dimShape.zone.filter}`);
    must(Number(dimShape.content.opacity) < 0.5, `the card content must still recede, was ${dimShape.content.opacity}`);
    must(dimShape.content.filter.includes("grayscale"), `the card content must still grey, was ${dimShape.content.filter}`);
    await page.screenshot({
      path: path.join(outDir, "771-session-nonmember-check.png"),
      clip: { x: Math.max(0, Math.round(target.x - 30)), y: Math.max(0, Math.round(target.y - 40)), width: Math.min(1400, Math.round(target.w + 70)), height: 170 },
    });

    await check.click();
    await page.waitForTimeout(400);
    const afterSecond = await selectedPaths(page);
    must(afterSecond.length === 0, `a second click must deselect, selection was ${afterSecond.join(", ")}`);
    await page.screenshot({ path: path.join(outDir, "771-check-deselected.png") });

    /* ── The selection survives a MODE SWITCH (#771 part 2) ──────────────── */
    await check.click();
    await page.waitForTimeout(400);
    must((await selectedPaths(page)).length === 1, "expected one member before the mode switch");

    /* Click the view toggle the operator clicks. The board unmounts — when it
       owned the selection in local state, that destroyed it outright. */
    const switched = await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("button[aria-pressed]")).find(
        (button) => (button.getAttribute("aria-label") ?? "") === "conversations",
      );
      if (!(tab instanceof HTMLElement)) return false;
      tab.click();
      return true;
    });
    must(switched, "found no conversations/list view tab to switch with");
    await page.waitForFunction(() => document.querySelector("[data-scheme-node]") === null, undefined, { timeout: 15_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "771-list-mode.png") });

    /* The board is gone, so read what the ORCHESTRATOR would read: ask the real
       snapshot endpoint from inside the page (it is same-origin gated), scoped to
       `selected`. This is requirement (c) end to end — the selection was made in
       scheme mode and is being asked for from list mode. */
    /* Presence is debounced (500 ms, min 500 ms gap) and the snapshot reads the
       server's presence store, so poll until the switch has been reported. */
    const askSnapshot = () =>
      page.evaluate(async () => {
        const response = await fetch("/api/agent/snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, scope: { kind: "selected" }, text: { lastMessages: 2 } }),
        });
        const body = (await response.json()) as {
          error?: string;
          view?: { mode: string; selectedPaths: string[]; visiblePaths: string[] };
          scope?: { kind: string; returnedPaths: string[] };
          conversations?: Array<{ path: string; text?: { messages: Array<{ text: string }> } }>;
        };
        return { status: response.status, body };
      });
    let published = await askSnapshot();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (published.status === 200 && published.body.view?.mode === "list" && (published.body.view?.selectedPaths.length ?? 0) > 0) break;
      await page.waitForTimeout(600);
      published = await askSnapshot();
    }
    must(published.status === 200, `the snapshot endpoint answered ${published.status}: ${JSON.stringify(published.body.error ?? published.body)}`);
    const view = published.body.view!;
    must(view.mode === "list", `expected the snapshot to see list mode, saw ${view.mode}`);
    must(view.selectedPaths.length === 1, `the selection must survive the mode switch, snapshot saw ${JSON.stringify(view.selectedPaths)}`);
    must(view.visiblePaths.length > 0, "list mode must report its visible rows");
    must(published.body.scope!.kind === "selected", `expected the selected scope, got ${published.body.scope!.kind}`);
    must(published.body.scope!.returnedPaths.length === 1, `the selected scope must resolve the member, got ${JSON.stringify(published.body.scope!.returnedPaths)}`);
    const messageCount = (published.body.conversations ?? []).reduce((total, item) => total + (item.text?.messages.length ?? 0), 0);
    must(messageCount > 0, "the selected conversation's content must come back with it");

    /* Back to the board: the same set is still there, no re-selection needed. */
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("button[aria-pressed]")).find(
        (button) => (button.getAttribute("aria-label") ?? "") === "scheme",
      );
      if (tab instanceof HTMLElement) tab.click();
    });
    await page.waitForSelector("[data-scheme-node]", { timeout: 15_000 });
    await page.waitForTimeout(800);
    const afterRoundTrip = await selectedPaths(page);
    must(afterRoundTrip.length === 1, `the selection must survive the round trip, board shows ${JSON.stringify(afterRoundTrip)}`);
    await page.screenshot({ path: path.join(outDir, "771-back-in-scheme.png") });

    console.log(
      [
        `board rendered at 1440x900 from the disposable demo home; evidence in ${outDir}`,
        `  check opacity at rest 0 → 1 on corner hover`,
        `  background drag across ${target.path}: selected it, native selection empty mid-drag and after`,
        `  transcript drag after the lasso highlighted ${insideText.trim().length} chars — selection handed back`,
        `  check on ${other.path}: click selects, second click deselects`,
        `  session dim: shell opacity ${dimShape.shell.opacity} / filter ${dimShape.shell.filter}, check zone ${dimShape.zone.opacity} / ${dimShape.zone.filter}, content ${dimShape.content.opacity} / ${dimShape.content.filter}`,
        `  mode switch: snapshot saw mode=${view.mode} selectedPaths=${view.selectedPaths.length} visiblePaths=${view.visiblePaths.length}, selected scope returned ${published.body.scope!.returnedPaths.length} conversation(s) with ${messageCount} message(s); back in scheme ${afterRoundTrip.length} member(s)`,
      ].join("\n"),
    );
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

if (import.meta.main) await main();
