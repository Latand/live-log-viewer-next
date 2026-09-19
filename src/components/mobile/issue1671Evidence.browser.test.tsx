import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import postcss from "postcss";

import { translate } from "@/lib/i18n";

/*
 * Browser evidence for #1671 at phone width, in both colour schemes, against
 * the production stylesheet and the real Viewer (`issue1671Evidence.fixture.tsx`):
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx
 *
 * happy-dom has no compositor, so what only a browser can settle is settled
 * here with real touch input — CDP `Input.dispatchTouchEvent`, so the row's
 * `touch-action: pan-y` meets Chromium's own gesture recognizer:
 *
 *   - a vertical drag that starts on a row scrolls the board and opens nothing;
 *   - a horizontal drag reveals a tray whose buttons are at least 44 px, sit
 *     beside the card and inside the phone;
 *   - a lane hidden since its last round stays off the board, and a lane that
 *     parked again after its Hide is back in Needs you and in the badge;
 *     hidden again, it stays off both once the server answers, in every
 *     painted frame, although the server keeps a lane's first Hide instant;
 *   - Hide takes the row and the bar's count on the tap, Restore brings both
 *     back, and a hide the server refuses puts both back and says why;
 *   - Close lane takes the row on the tap and sends nothing once Restore
 *     cancelled it; a close that has gone out keeps its row gone until the
 *     server answers, and a second close inside the window keeps the first gone;
 *   - a long-press opens the actions sheet and not the lane under the finger;
 *   - a conversation's Close writes only the board, and Reopen round-trips;
 *   - «All conversations» appends the feed's rows first with no request, then
 *     project pages, in identical rows, with no search field, no repeats and
 *     no superseded round.
 *
 * Measurements go to `evidence/issue-1671/geometry.json`; frames to
 * `.artifacts/issue-1671/`, which is not committed.
 */

const browserTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1671");
const EVIDENCE = path.resolve("evidence/issue-1671");
/** The fixture's running conversation, under its managed account's home. */
const runningPath = (account: string) => `/state/agent-log-viewer/shared/accounts/claude/${account}/projects/atlas/running.jsonl`;
const RUNNING_PATH = runningPath("spare");
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }] as const;
const SCHEMES = ["light", "dark"] as const;

type Point = [number, number];
interface Rect { x: number; y: number; width: number; height: number }
interface Recorded {
  catalogRequests: string[];
  pipelinePatches: Array<{ id: string; action: string }>;
  closesAnswered: string[];
  hidesAnswered: Array<{ id: string; action: string; dismissedAt: string | null }>;
  boardMutations: Array<{ kind: string; path?: string }>;
  refuseNextPipelinePatch: boolean;
  pipelineAnswerDelayMs: number;
}

const pause = (page: Page, ms = 300) => page.waitForTimeout(ms);
const along = (from: Point, to: Point, steps = 12): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);

async function touch(cdp: CDPSession, points: Point[], stepMs = 16): Promise<void> {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first![0], y: first![1] }] });
  for (const [x, y] of rest) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const rectOf = (page: Page, selector: string) => page.evaluate((sel): Rect | null => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);

async function centre(page: Page, selector: string): Promise<Point> {
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), selector);
  await pause(page, 250);
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing at ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/* A tap where the target already is. Scrolling first would be the operator
   moving the list, which puts an open tray away before the tap lands. */
async function tap(page: Page, cdp: CDPSession, selector: string): Promise<void> {
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing to tap at ${selector}`);
  await touch(cdp, [[box.x + box.width / 2, box.y + box.height / 2]]);
}

async function swipeLeft(page: Page, cdp: CDPSession, selector: string, width: number): Promise<void> {
  const [, y] = await centre(page, selector);
  await touch(cdp, along([width - 40, y], [width - 250, y + 3]));
  await pause(page, 350);
}

/* The target's rect once two reads 120 ms apart agree: nothing above it is
   still arriving, so a tap measured now lands where it was measured. */
async function stableRect(page: Page, selector: string): Promise<Rect> {
  let last = await rectOf(page, selector);
  for (let i = 0; i < 25; i += 1) {
    await pause(page, 120);
    const next = await rectOf(page, selector);
    if (last && next && Math.abs(next.y - last.y) < 0.5 && Math.abs(next.height - last.height) < 0.5) return next;
    last = next;
  }
  throw new Error(`${selector} never stopped moving`);
}

async function run(context: BrowserContext, base: string, viewport: { width: number; height: number }, scheme: "light" | "dark") {
  const key = `${viewport.width}-${scheme}`;
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${key}-${name}.png`) });
  const lane = (i: number) => `[data-mobile2-board] [data-mobile2-swipe-row="pipeline:lane-${i}"]`;
  const count = (selector: string) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  const badge = async () => Number(await page.evaluate(() => document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? "NaN"));
  const receipt = () => page.evaluate(() => document.querySelector("[data-mobile2-receipt]")?.textContent ?? "");
  const recorded = () => page.evaluate(() => structuredClone((window as unknown as { evidence: Recorded }).evidence));
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  await page.goto(`${base}/#p=atlas`);
  await page.waitForSelector(lane(9), { timeout: 20_000 });
  await pause(page, 800);
  const queued = await badge();
  await shot("board");

  /* 0. A Hide covers the decision it saw: the lane hidden since its last round
     stays off the board, the lane that parked again after its Hide is back,
     and the badge counts every lane Needs you lists. */
  const laneRow = (id: string) => `[data-mobile2-board] [data-mobile2-swipe-row="pipeline:${id}"]`;
  const hideDecision = {
    stillHidden: await count(laneRow("lane-hidden")),
    parkedAgain: await count(laneRow("lane-parked-again")),
    listedLanes: await count('[data-mobile2-board] [data-mobile2-swipe-row^="pipeline:"]'),
  };
  check("a lane hidden since its last round stays off the board", hideDecision.stillHidden === 0);
  check("a lane that parked again after its Hide is back in Needs you", hideDecision.parkedAgain === 1);
  check("the badge counts every lane Needs you lists", hideDecision.listedLanes === queued);

  /* 1. A vertical drag that starts on a row scrolls the board and opens nothing. */
  const startY = viewport.height - 220;
  const startedOn = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[data-mobile2-swipe-row]")?.getAttribute("data-mobile2-swipe-row") ?? null, [viewport.width / 2, startY]);
  await touch(cdp, along([viewport.width / 2, startY], [viewport.width / 2 + 6, startY - 320], 14));
  await pause(page, 700);
  const vertical = {
    startedOn,
    scrollTop: await page.evaluate(() => (document.querySelector("[data-mobile2-board]") as HTMLElement).scrollTop),
    openRows: await count("[data-mobile2-swipe-open]"),
  };
  check("a vertical drag starts on a row", startedOn !== null);
  check("a vertical drag scrolls the board", vertical.scrollTop > 40);
  check("a vertical drag opens no row", vertical.openRows === 0);
  await page.evaluate(() => { (document.querySelector("[data-mobile2-board]") as HTMLElement).scrollTop = 0; });
  await pause(page);

  /* 2. A horizontal drag reveals the tray beside the card, at touch size. */
  await swipeLeft(page, cdp, lane(0), viewport.width);
  const tray = await page.evaluate((sel) => {
    const row = document.querySelector(sel)!;
    const card = row.querySelector("[data-mobile2-swipe-card]")!.getBoundingClientRect();
    return {
      open: row.getAttribute("data-mobile2-swipe-open"),
      touchAction: getComputedStyle(row).touchAction,
      cardLeft: card.left, cardRight: card.right,
      opacity: getComputedStyle(row.querySelector("[data-mobile2-swipe-tray]")!).opacity,
      buttons: [...row.querySelectorAll("[data-mobile2-swipe-action]")].map((button) => {
        const r = button.getBoundingClientRect();
        return { key: button.getAttribute("data-mobile2-swipe-action"), label: button.getAttribute("aria-label"), x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    };
  }, lane(0));
  await shot("tray");
  check("the tray opens", tray.open === "true" && tray.opacity === "1");
  check("the row keeps vertical panning to the browser", tray.touchAction === "pan-y");
  check("the tray holds Hide and Close lane", tray.buttons.map((button) => button.key).join() === "hide,closeLane");
  check("tray buttons are at least 44 px", tray.buttons.every((button) => button.width >= 44 && button.height >= 44));
  check("tray buttons sit beside the card", tray.buttons.every((button) => button.x >= tray.cardRight - 0.5));
  check("tray buttons stay inside the phone", tray.buttons.every((button) => button.x + button.width <= viewport.width + 0.5));

  /* 3. Hide takes the row and the count on the tap; Restore brings both back. */
  await tap(page, cdp, `${lane(0)} [data-mobile2-swipe-action="hide"]`);
  await pause(page, 120);
  const hide = {
    rowGone: (await count(lane(0))) === 0,
    badge: await badge(),
    receipt: await receipt(),
    receiptBox: await rectOf(page, "[data-mobile2-receipt]"),
    dockBox: await rectOf(page, "[data-mobile2-board-dock]"),
    patches: (await recorded()).pipelinePatches,
  };
  await shot("hidden");
  check("Hide takes the row on the tap", hide.rowGone);
  check("Hide takes the bar's count on the tap", hide.badge === queued - 1);
  check("Hide sends dismiss", hide.patches.at(-1)?.action === "dismiss");
  check("the receipt names the lane", hide.receipt.includes(TASK_0));
  check("the receipt sits above the dock", !hide.receiptBox || !hide.dockBox || hide.receiptBox.y + hide.receiptBox.height <= hide.dockBox.y + 0.5);
  await tap(page, cdp, '[data-mobile2-receipt-undo="restore"]');
  await page.waitForSelector(lane(0), { timeout: 5_000 });
  await pause(page, 200);
  const restored = { badge: await badge(), patches: (await recorded()).pipelinePatches };
  check("Restore brings the row and the count back", restored.badge === queued && restored.patches.at(-1)?.action === "undismiss");

  /* 4. A hide the server refuses puts the row and the count back, and says why. */
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.refuseNextPipelinePatch = true; });
  await swipeLeft(page, cdp, lane(1), viewport.width);
  await tap(page, cdp, `${lane(1)} [data-mobile2-swipe-action="hide"]`);
  await pause(page, 80);
  const refusedAtOnce = { rowGone: (await count(lane(1))) === 0, badge: await badge() };
  await page.waitForSelector(lane(1), { timeout: 5_000 });
  await pause(page, 250);
  const refused = { ...refusedAtOnce, badgeAfter: await badge(), receipt: await receipt() };
  await shot("refused");
  check("a refused hide still leaves on the tap", refused.rowGone && refused.badge === queued - 1);
  check("a refused hide comes back and says why", refused.badgeAfter === queued && refused.receipt.includes("refused by the evidence fixture"));

  /* 5. Close lane goes on the tap and sends nothing once Restore cancelled it. */
  await swipeLeft(page, cdp, lane(2), viewport.width);
  const sentBefore = (await recorded()).pipelinePatches.length;
  await tap(page, cdp, `${lane(2)} [data-mobile2-swipe-action="closeLane"]`);
  await pause(page, 150);
  const closeLane = { rowGone: (await count(lane(2))) === 0, badge: await badge(), receipt: await receipt() };
  await shot("close-lane");
  await tap(page, cdp, '[data-mobile2-receipt-undo="restore"]');
  await page.waitForSelector(lane(2), { timeout: 5_000 });
  /* Past the receipt's window: a cancelled close is never sent late. */
  await pause(page, 4_400);
  const closeLaneAfter = { badge: await badge(), sent: (await recorded()).pipelinePatches.length - sentBefore };
  check("Close lane takes the row and the count on the tap", closeLane.rowGone && closeLane.badge === queued - 1);
  check("Close lane's receipt says the lane closed", closeLane.receipt.includes(translate("en", "mobile2.pipeline.archived")));
  check("a cancelled Close lane sends nothing", closeLaneAfter.sent === 0 && closeLaneAfter.badge === queued);

  /* 5b. A Close lane that has gone out stays gone until the server answers it,
     and a second Close lane inside the first one's window keeps the first gone.
     The fixture answers a close after 2.5 s, as a close stopping hosts does. */
  const sentBeforeCloses = (await recorded()).pipelinePatches.length;
  const closesSent = async () => (await recorded()).pipelinePatches.slice(sentBeforeCloses).map((patch) => patch.id);
  const closes = async () => ({ first: await count(lane(4)), second: await count(lane(5)), badge: await badge() });
  await swipeLeft(page, cdp, lane(4), viewport.width);
  await tap(page, cdp, `${lane(4)} [data-mobile2-swipe-action="closeLane"]`);
  await pause(page, 150);
  await swipeLeft(page, cdp, lane(5), viewport.width);
  await tap(page, cdp, `${lane(5)} [data-mobile2-swipe-action="closeLane"]`);
  const secondTapAt = Date.now();
  await pause(page, 150);
  const successive = { ...(await closes()), sent: await closesSent() };
  /* Past the second receipt's window, while its close is still out. */
  await pause(page, 4_300);
  const inFlight = { ...(await closes()), sinceSecondTapMs: Date.now() - secondTapAt, sent: await closesSent(), answered: [...(await recorded()).closesAnswered] };
  await shot("close-in-flight");
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.closesAnswered.length >= 2, undefined, { timeout: 10_000 });
  await pause(page, 300);
  const answered = { ...(await closes()), answered: [...(await recorded()).closesAnswered] };
  check("a second Close lane inside the window keeps the first lane gone while its close is out", successive.first === 0 && successive.second === 0 && successive.badge === queued - 2 && successive.sent.join() === "lane-4");
  check("a Close lane whose window ran out stays gone while the server answers", inFlight.first === 0 && inFlight.second === 0 && inFlight.badge === queued - 2 && inFlight.sent.join() === "lane-4,lane-5" && !inFlight.answered.includes("lane-5"));
  check("answered closes stay gone", answered.first === 0 && answered.second === 0 && answered.badge === queued - 2);

  /* 5c. A lane hidden before that parked again hides again. The fixture keeps
     a lane's first Hide instant through a later dismiss, as the engine does,
     and holds each answer 400 ms. Every frame painted from the tap until both
     answers have landed is sampled for the row and the count. */
  const parkedAgain = laneRow("lane-parked-again");
  const badgeBeforeRehide = await badge();
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.pipelineAnswerDelayMs = 400; });
  await swipeLeft(page, cdp, parkedAgain, viewport.width);
  const sentBeforeRehide = (await recorded()).pipelinePatches.length;
  await tap(page, cdp, `${parkedAgain} [data-mobile2-swipe-action="hide"]`);
  await page.evaluate((sel) => {
    const sampler = window as unknown as { rehideFrames: Array<{ row: boolean; badge: string | null }>; rehideSampling: boolean };
    sampler.rehideFrames = [];
    sampler.rehideSampling = true;
    const sample = () => {
      sampler.rehideFrames.push({
        row: document.querySelector(sel) !== null,
        badge: document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? null,
      });
      if (sampler.rehideSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, parkedAgain);
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.hidesAnswered.filter((answer) => answer.id === "lane-parked-again").length >= 2, undefined, { timeout: 5_000 }).catch(() => undefined);
  await pause(page, 600);
  const rehideFrames = await page.evaluate(() => {
    const sampler = window as unknown as { rehideFrames: Array<{ row: boolean; badge: string | null }>; rehideSampling: boolean };
    sampler.rehideSampling = false;
    return sampler.rehideFrames;
  });
  await page.evaluate(() => { (window as unknown as { evidence: Recorded }).evidence.pipelineAnswerDelayMs = 0; });
  const rehideAnswers = (await recorded()).hidesAnswered.filter((answer) => answer.id === "lane-parked-again");
  const rehide = {
    sent: (await recorded()).pipelinePatches.slice(sentBeforeRehide).map((patch) => `${patch.id}:${patch.action}`),
    answers: rehideAnswers,
    answeredDismissAgeMs: rehideAnswers.at(-1)?.dismissedAt ? Date.now() - Date.parse(rehideAnswers.at(-1)!.dismissedAt!) : null,
    frames: rehideFrames.length,
    framesWithRow: rehideFrames.filter((frame) => frame.row).length,
    badges: [...new Set(rehideFrames.map((frame) => frame.badge))],
    rowAfter: await count(parkedAgain),
    badgeBefore: badgeBeforeRehide,
    badgeAfter: await badge(),
  };
  await shot("rehidden");
  check("hiding a lane that parked again clears its old Hide, then sends the new one", rehide.sent.join() === "lane-parked-again:undismiss,lane-parked-again:dismiss");
  check("the new Hide is stamped now, after the round that parked the lane again", rehide.answeredDismissAgeMs !== null && rehide.answeredDismissAgeMs < 60_000);
  check("no painted frame shows the re-hidden row or its count while the answers land", rehide.frames >= 10 && rehide.framesWithRow === 0 && rehide.badges.join() === String(badgeBeforeRehide - 1));
  check("the re-hidden lane stays off Needs you and the badge once answered", rehide.rowAfter === 0 && rehide.badgeAfter === badgeBeforeRehide - 1);

  /* 6. A long-press opens the actions sheet and not the lane under the finger. */
  const [pressX, pressY] = await centre(page, lane(3));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pressX, y: pressY }] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pause(page, 450);
  const longPress = await page.evaluate(() => {
    const sheet = document.querySelector('[data-mobile2-sheet="row"]');
    return {
      sheet: sheet !== null,
      rows: sheet ? [...sheet.querySelectorAll("[data-mobile2-row-action]")].map((row) => ({ key: row.getAttribute("data-mobile2-row-action"), height: row.getBoundingClientRect().height })) : [],
      pipelineScreen: document.querySelector('[data-mobile2-screen="pipeline"]') !== null,
    };
  });
  await shot("long-press");
  check("a long-press opens the actions sheet", longPress.sheet && longPress.rows.map((row) => row.key).join() === "hide,closeLane");
  check("the sheet's rows are at least 44 px", longPress.rows.every((row) => row.height >= 44));
  check("a long-press does not open the lane", !longPress.pipelineScreen);
  await page.evaluate(() => (document.querySelector('[data-mobile2-sheet="row"] [data-mobile2-close]') as HTMLElement | null)?.click());
  await pause(page, 450);

  /* 7. A conversation's Close writes only the board, and Reopen round-trips. */
  const running = `[data-mobile2-board] [data-mobile2-swipe-row="conversation:${RUNNING_PATH}"]`;
  await swipeLeft(page, cdp, running, viewport.width);
  const conversationTray = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-mobile2-swipe-action]`)].map((button) => button.getAttribute("aria-label")), running);
  await shot("conversation-tray");
  await tap(page, cdp, `${running} [data-mobile2-swipe-action="close"]`);
  await pause(page, 150);
  const conversationGone = (await count(running)) === 0;
  await page.waitForFunction(() => (window as unknown as { evidence: Recorded }).evidence.boardMutations.some((mutation) => mutation.kind === "close"), undefined, { timeout: 5_000 });
  await shot("conversation-closed");
  await tap(page, cdp, '[data-mobile2-receipt-undo="reopen"]');
  const reopened = await page.waitForSelector(running, { timeout: 5_000 }).then(() => true, () => false);
  const conversationClose = {
    tray: conversationTray, rowGone: conversationGone, reopened,
    boardScreen: await count('[data-mobile2-screen="board"]'),
    mutations: (await recorded()).boardMutations.map((mutation) => mutation.kind),
    pipelineWrites: (await recorded()).pipelinePatches.length - sentBefore,
  };
  check("a conversation's tray holds Close card only", conversationTray.length === 1 && String(conversationTray[0]).startsWith(translate("en", "mobile2.chat.menuClose")));
  check("Close card takes the row on the tap", conversationClose.rowGone);
  check("Reopen brings the conversation back to the board", conversationClose.reopened && conversationClose.boardScreen === 1);

  /* 8. «All conversations» appends the same rows: the feed's first, then pages.
     The tap waits for the list above the row to stop moving: a banner that
     arrived between measuring and touching once moved the row out from under
     the finger, and the tap expanded nothing. */
  const toggle = '[data-mobile2-row="catalog"]';
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), toggle);
  const toggleBox = await stableRect(page, toggle);
  const banners = await count("[data-mobile2-banner]");
  await touch(cdp, [[toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2]]);
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", toggle, { timeout: 5_000 }).catch(() => undefined);
  await pause(page, 250);
  check("no banner stands over the list when the catalog row is tapped", banners === 0);
  const rowsSelector = '[data-mobile2-board] [data-mobile2-row="conversation"][data-catalog-path]';
  const expanded = await page.evaluate((sel) => ({
    rows: document.querySelectorAll(sel).length,
    requests: (window as unknown as { evidence: Recorded }).evidence.catalogRequests.length,
    toggle: document.querySelector('[data-mobile2-row="catalog"]')?.textContent ?? "",
  }), rowsSelector);
  await shot("expanded");
  /* The reader keeps scrolling: a page lands below the fold, and the next one
     loads only once the list's end is in reach again. The first page carries
     the superseded round, which gets no row, so twenty stored rows take two
     pages. A list that stops loading fails the checks below. */
  const scrolledStoredRows = () => page.evaluate((sel) => {
    const scroller = document.querySelector("[data-mobile2-board]") as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
    return [...document.querySelectorAll<HTMLElement>(sel)].filter((row) => row.dataset.catalogPath?.startsWith("/repo/history-")).length;
  }, rowsSelector);
  for (let i = 0; i < 50 && (await scrolledStoredRows()) < 20; i += 1) await pause(page, 200);
  await pause(page, 500);
  const appended = await page.evaluate((sel) => {
    const rows = [...document.querySelectorAll<HTMLElement>(sel)];
    const paths = rows.map((row) => row.dataset.catalogPath ?? "");
    const scroller = document.querySelector("[data-mobile2-board]")!;
    return {
      rows: rows.length,
      unique: new Set(paths).size,
      stored: paths.filter((item) => item.startsWith("/repo/history-")).length,
      superseded: paths.includes("/repo/superseded-round.jsonl"),
      rowStyles: new Set(rows.map((row) => row.className)).size,
      heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
      requests: (window as unknown as { evidence: Recorded }).evidence.catalogRequests,
      searchFields: document.querySelectorAll('input[type="search"]').length,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      boardOverflow: scroller.scrollWidth > scroller.clientWidth,
    };
  }, rowsSelector);
  await shot("appended");
  check("expanding appends the feed's thirty rows with no request", expanded.rows === 30 && expanded.requests === 0);
  check("the expanded row reads Show fewer", expanded.toggle.includes(translate("en", "mobile2.board.showFewer")));
  check("catalog pages append below the feed's rows", appended.stored >= 20);
  check("a superseded round the stored catalog lists gets no row", !appended.superseded);
  check("no row appears twice", appended.unique === appended.rows);
  check("every appended row is the same row", appended.rowStyles === 1 && appended.heights.length === 1);
  check("catalog requests are this project's pages with no query",appended.requests.length > 0 && appended.requests.every((query) => query.includes("project=atlas") && query.includes("limit=20") && !/[?&]q=/.test(query)));
  check("no search field anywhere", appended.searchFields === 0);
  check("nothing overflows the phone sideways", !appended.pageOverflow && !appended.boardOverflow);
  check("no page errors", pageErrors.length === 0);

  await page.close();
  return {
    key, viewport, scheme, queued, hideDecision, vertical, tray, hide, restored, refused, closeLane: { ...closeLane, ...closeLaneAfter },
    closes: { successive, inFlight, answered }, rehide, longPress, conversationClose, banners, expanded, appended, pageErrors, failures,
  };
}

const TASK_0 = "Fast conversation switching";

/** The fixture page, bundled and served: one setup both cases below run on. */
async function serveFixture(): Promise<{ base: string; stop: () => void }> {
  fs.mkdirSync(OUT, { recursive: true });
  const build = await Bun.build({
    entrypoints: [path.resolve("src/components/mobile/issue1671Evidence.fixture.tsx")],
    target: "browser",
    outdir: path.join(OUT, "bundle"),
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const entry = build.outputs.find((output) => output.kind === "entry-point")!.path;
  const css = await postcss([tailwind()]).process(fs.readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/app.js") return new Response(Bun.file(entry), { headers: { "content-type": "text/javascript" } });
      if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const launchChromium = () => chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

browserTest("#1671 at phone width: real touches on the real Viewer, in both schemes", async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: Awaited<ReturnType<typeof run>>[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        try {
          results.push(await run(context, fixtureBase, viewport, scheme));
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(EVIDENCE, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((result) => result.failures.length > 0);
  if (failed.length) throw new Error(JSON.stringify(failed.map((result) => ({ key: result.key, failures: result.failures, pageErrors: result.pageErrors })), null, 2));
}, 300_000);

/*
 * #1795 — the runtime pill's sheet, on the same real Viewer, at the two phone
 * surfaces the operator reached it from and at a desktop viewport:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1795"
 *
 * happy-dom lays nothing out, so the defect the operator photographed — the
 * sheet rendered INSIDE the conversation pane, its grab bar, title and most of
 * the Model group above the visible area, the feed's down button floating over
 * it — is a browser question. Each surface records the chain of ancestors that
 * establish a containing block for `position: fixed` between the pill and the
 * document, then measures the open sheet against the viewport, hit-tests the
 * controls that were unreachable, re-taps the row the conversation already
 * runs on, and reads the account the surface names. The desktop case is here
 * rather than in a driver of its own because it is the same control: the
 * popover the sheet is the phone's face of.
 *
 * Readings go to `evidence/issue-1795/runtime-sheet.json`; frames to
 * `.artifacts/issue-1795/`, which is not committed.
 */
const SHEET_OUT = path.resolve(".artifacts/issue-1795");
/* Both phone widths, the short one the critique rendered at, and a 15-character
   account id — the width that took the model and its tier down with it. */
const SHEET_CASES = [
  { viewport: { width: 390, height: 844 }, account: "spare" },
  { viewport: { width: 430, height: 932 }, account: "spare" },
  { viewport: { width: 390, height: 600 }, account: "spare" },
  { viewport: { width: 390, height: 844 }, account: "review-relief-2" },
] as const;
const SHEET_EVIDENCE = path.resolve("evidence/issue-1795");

interface Containing { tag: string; marks: string[]; reasons: string[]; rect: Rect }

/** Every ancestor of `selector` that makes `position: fixed` resolve against
    itself instead of the viewport, nearest first. */
const containingBlocks = (page: Page, selector: string) => page.evaluate((sel): Containing[] => {
  const chain: Containing[] = [];
  const start = document.querySelector(sel);
  for (let node = start?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const reasons: string[] = [];
    if (style.transform !== "none") reasons.push(`transform: ${style.transform}`);
    if (style.perspective !== "none") reasons.push(`perspective: ${style.perspective}`);
    if (style.filter !== "none") reasons.push(`filter: ${style.filter}`);
    if (style.backdropFilter && style.backdropFilter !== "none") reasons.push(`backdrop-filter: ${style.backdropFilter}`);
    if (/paint|layout|strict|content/.test(style.contain ?? "")) reasons.push(`contain: ${style.contain}`);
    if ((style.containerType ?? "normal") !== "normal") reasons.push(`container-type: ${style.containerType}`);
    if ((style.contentVisibility ?? "visible") !== "visible") reasons.push(`content-visibility: ${style.contentVisibility}`);
    if (/transform|filter|perspective|contain/.test(style.willChange ?? "")) reasons.push(`will-change: ${style.willChange}`);
    if (!reasons.length) continue;
    const box = node.getBoundingClientRect();
    chain.push({
      tag: node.tagName.toLowerCase(),
      marks: [...node.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-")),
      reasons,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
  return chain;
}, selector);

/** What the operator can actually see and hit: the box, whether it is inside
    the viewport, and what the topmost element at its centre belongs to. */
const reachable = (page: Page, selector: string, within: string) => page.evaluate(([sel, root]): null | (Rect & { inside: boolean; hitOwn: boolean }) => {
  const element = document.querySelector(sel!);
  const container = document.querySelector(root!);
  if (!element || !container) return null;
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 0.5 && box.right <= innerWidth + 0.5,
    hitOwn: top !== null && (container.contains(top) || element.contains(top) || element === top),
  };
}, [selector, within] as const);

/** The switcher row that opens the board lane's review round, whose pane the
    deck mounts on its own perspective stage. */
const REVIEW_ROW_PREFIX = translate("en", "mobile2.chat.reviewOf", { title: "" }).trim();

/** What the bar's meta line actually says, cell by cell, and whether any cell
    is showing less than its text — the line the account was crowding out. */
const headerReading = (page: Page) => page.evaluate(() => {
  const cell = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      text: element.textContent ?? "",
      width: Math.round(box.width * 10) / 10,
      /* Chromium rounds a truncating box down by up to a pixel. */
      cut: element.scrollWidth > element.clientWidth + 1,
    };
  };
  const line = document.querySelector("[data-mobile2-chat-state]")?.parentElement ?? null;
  return {
    line: line ? { width: Math.round(line.getBoundingClientRect().width * 10) / 10, text: line.textContent ?? "" } : null,
    state: cell("[data-mobile2-chat-state]"),
    model: cell("[data-mobile2-chat-model]"),
    account: cell("[data-mobile2-chat-account]"),
    title: cell("[data-mobile2-title-text]"),
  };
});

async function sheetSurface(
  context: BrowserContext,
  base: string,
  surface: "pane-on-board" | "conversation-view" | "round-deck-on-board",
  account = "spare",
) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const shot = (name: string) => page.screenshot({ path: path.join(SHEET_OUT, `${surface}-${name}.png`) });
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const recorded = () => page.evaluate(() => structuredClone((window as unknown as { evidence: { runtimeRequests: unknown[]; accountSelects: unknown[] } }).evidence));

  if (surface === "pane-on-board" || surface === "round-deck-on-board") {
    /* Exactly the operator's route: the board, then the conversation opened
       from it, which the board mounts inside its own shell. */
    await page.goto(`${base}/?account=${account}${surface === "round-deck-on-board" ? "&deck=1" : ""}#p=atlas`);
    const row = `[data-mobile2-board] [data-mobile2-swipe-row="conversation:${runningPath(account)}"]`;
    await page.waitForSelector(row, { timeout: 20_000 });
    await pause(page, 600);
    /* The row is below the fold under ten parked lanes: scroll to it, then tap
       where it now is. */
    await touch(cdp, [await centre(page, row)]);
    if (surface === "round-deck-on-board") {
      /* …and from there into the lane's review round, through the bar's own
         switcher. THIS is the pane the operator photographed: the round deck
         lays its front card on a perspective stage, and a perspective is a
         containing block for every `fixed` descendant under it. */
      await pause(page, 800);
      await touch(cdp, [await centre(page, "[data-mobile2-chat-title]")]);
      await pause(page, 800);
      const at = await page.evaluate((prefix) => {
        const row = [...document.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").startsWith(prefix!));
        if (!row) return null;
        const box = row.getBoundingClientRect();
        return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
      }, REVIEW_ROW_PREFIX);
      if (!at) throw new Error("no review round in the switcher");
      await touch(cdp, [at]);
      await pause(page, 900);
    }
  } else {
    /* The conversation on its own, deep-linked, with no board under it. */
    await page.goto(`${base}/?account=${account}#c=conversation_running`);
  }
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);

  /* What `fixed` is measured against here, with the sheet still closed. */
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* …and what the bar says while nothing covers it. */
  const header = await headerReading(page);
  await shot("header");
  check("the header names the state, the model with its tier, and the account", Boolean(header.state && header.model && header.account));
  check("the state phrase is whole", header.state?.cut === false);
  check("the model and its tier are whole", header.model?.cut === false);
  check("the account the conversation runs on is the one it names", (header.account?.text ?? "").includes(account));
  /* An ordinary account id has to be READABLE, not merely present in the DOM:
     `@ spare` rendered as `@ s…` and the first evidence pass called that a pass
     because it read textContent (#1795, second critique). */
  if (account.length <= 8) check("the account is shown whole, not cut to a letter", header.account?.cut === false);
  /* A long one yields, and still shows more than an ellipsis. */
  else check("a long account id still shows its head", (header.account?.width ?? 0) >= 60);
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  await shot("sheet");

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    const backdrop = sheet?.parentElement ?? null;
    if (!sheet || !backdrop) return null;
    const box = backdrop.getBoundingClientRect();
    const card = sheet.getBoundingClientRect();
    return {
      portalledToBody: backdrop.parentElement === document.body,
      backdrop: { x: box.x, y: box.y, width: box.width, height: box.height },
      card: { x: card.x, y: card.y, width: card.width, height: card.height },
      viewport: { width: innerWidth, height: innerHeight },
      coversViewport: box.top <= 0.5 && box.left <= 0.5 && box.width >= innerWidth - 0.5 && box.height >= innerHeight - 0.5,
      scrollsInsideItself: sheet.scrollHeight <= sheet.clientHeight || getComputedStyle(sheet).overflowY === "auto",
    };
  });
  /* The feed behind it: rows the sheet has to cover, and the down button that
     floated over the sheet in the operator's screenshot. */
  const behind = await page.evaluate(() => {
    const feed = document.querySelector("[data-log-feed-scroller]");
    return {
      /* The scroller's own count of transcript lines it holds. */
      feedLines: Number(feed?.getAttribute("data-tail-line-count") ?? "0"),
      feedScrollable: feed ? feed.scrollHeight > feed.clientHeight + 1 : false,
      downButton: document.querySelectorAll("[data-feed-jump], [data-log-feed-down]").length,
    };
  });
  const title = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const close = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  const accounts = await reachable(page, "[data-runtime-sheet-accounts]", "[data-runtime-sheet]");
  const firstModelRow = await reachable(page, "[data-runtime-sheet] [role=\"radiogroup\"] [data-runtime-sheet-row]", "[data-runtime-sheet]");
  const accountRows = await page.evaluate(() => [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
    id: row.getAttribute("data-runtime-sheet-account"),
    state: row.getAttribute("data-runtime-account-state"),
    next: row.getAttribute("data-runtime-account-next"),
    disabled: (row as HTMLButtonElement).disabled,
  })));
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");

  if (surface === "round-deck-on-board") {
    /* The surface only means something while the pane it opens in still has
       the containing block that clipped the sheet. */
    check("the round deck still lays its pane on a containing block", ancestors.some((node) => node.reasons.some((reason) => reason.startsWith("perspective"))));
  }
  check("the sheet is portalled to the document body", geometry?.portalledToBody === true);
  check("the sheet covers the whole viewport from this surface", geometry?.coversViewport === true);
  check("the sheet scrolls inside itself", geometry?.scrollsInsideItself === true);
  check("its title is on screen and nothing floats over it", Boolean(title?.inside && title.hitOwn));
  check("its close control is on screen and hittable", Boolean(close?.inside && close.hitOwn));
  check("the account group is on screen", Boolean(accounts?.inside && accounts.hitOwn));
  check("the first model row is on screen", Boolean(firstModelRow?.inside && firstModelRow.hitOwn));
  /* The feed behind the sheet is a real one, so the hit tests above are taken
     over transcript rows rather than an empty pane. */
  check("the transcript behind the sheet has content", behind.feedLines > 0);
  /* Scroll the sheet's own groups to the bottom: the title and the way out are
     a sticky row, so neither leaves with them. */
  await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    if (sheet) sheet.scrollTop = sheet.scrollHeight;
  });
  await pause(page, 300);
  const scrolledTitle = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const scrolledClose = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  await shot("scrolled");
  check("the title stays in the sheet after its groups are scrolled", Boolean(scrolledTitle?.inside && scrolledTitle.hitOwn));
  check("the close control stays in the sheet after its groups are scrolled", Boolean(scrolledClose?.inside && scrolledClose.hitOwn));
  check("the account the conversation runs on is named", namesAccount.includes(account));
  check("the account it runs on is the marked row, and holds the next message until another is picked",
    accountRows.some((row) => row.id === account && row.state === "current" && row.next === "true" && row.disabled));
  check("another authenticated account is a one-tap select", accountRows.some((row) => row.id === "relief" && row.state === "ready" && !row.disabled));
  check("a signed-out account keeps its sign-in row", accountRows.some((row) => row.id === "dormant" && row.state === "needs-sign-in"));

  /* Re-tap the reasoning tier the conversation already runs on. */
  const checkedTier = "[data-runtime-sheet-row][aria-checked=\"true\"]";
  const beforeReselect = await recorded();
  await tap(page, cdp, checkedTier);
  await pause(page, 500);
  const afterReselect = await recorded();
  const sheetGone = await page.evaluate(() => document.querySelector("[data-runtime-sheet]") === null);
  check("re-selecting what it already runs on sends no reconfigure", afterReselect.runtimeRequests.length === beforeReselect.runtimeRequests.length);
  check("re-selecting what it already runs on closes the sheet", sheetGone);

  /* …and a row that IS a change still goes out, so the guard is equality. */
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  const changed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-runtime-sheet-row]")] as HTMLButtonElement[];
    const row = rows.find((candidate) => candidate.getAttribute("aria-checked") === "false");
    row?.setAttribute("data-evidence-change", "1");
    return row?.textContent ?? "";
  });
  await tap(page, cdp, "[data-evidence-change]");
  await pause(page, 600);
  const afterChange = await recorded();
  check("a real change still sends its reconfigure", afterChange.runtimeRequests.length > afterReselect.runtimeRequests.length);
  await shot("after-change");

  /* Picking another account has to SHOW: one select leaves, and the mark for
     where the next message goes moves onto the row that was tapped, while the
     row naming where the conversation RUNS stays where it was (critique P1). */
  const readyRow = "[data-runtime-sheet-account][data-runtime-account-state=\"ready\"]";
  const pickedId = await page.evaluate((sel) => document.querySelector(sel!)?.getAttribute("data-runtime-sheet-account") ?? "", readyRow);
  await touch(cdp, [await centre(page, readyRow)]);
  await pause(page, 700);
  const afterPick = await recorded();
  const picked = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
      id: row.getAttribute("data-runtime-sheet-account"),
      state: row.getAttribute("data-runtime-account-state"),
      next: row.getAttribute("data-runtime-account-next"),
      disabled: (row as HTMLButtonElement).disabled,
    })),
    head: document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "",
  }));
  await shot("after-account-pick");
  check("picking an account sends exactly one select", afterPick.accountSelects.length === 1);
  check("the picked account is marked as the one the next message uses",
    picked.rows.some((row) => row.id === pickedId && row.next === "true" && row.disabled));
  check("no other row claims the next message",
    picked.rows.filter((row) => row.next === "true").length === 1);
  check("the account the conversation runs on still says so",
    picked.head.includes(account) && picked.rows.some((row) => row.state === "current"));

  check("no page errors", pageErrors.length === 0);

  await page.close();
  return {
    surface, account, viewportAccountPick: { pickedId, ...picked, selects: afterPick.accountSelects },
    ancestors, header, behind, geometry, title, close, scrolledTitle, scrolledClose, accounts, firstModelRow, accountRows, namesAccount,
    changedTo: changed, pageErrors, failures,
  };
}

async function popoverSurface(context: BrowserContext, base: string) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  await page.goto(`${base}/#c=conversation_running`);
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* The desktop board is taller than the window; bring the pane's composer row
     into view before clicking where it now is. */
  await page.evaluate(() => document.querySelector("[data-runtime-pill]")?.scrollIntoView({ block: "center", inline: "center" }));
  await pause(page, 500);
  await page.mouse.click(...(await page.evaluate(() => {
    const box = document.querySelector("[data-runtime-pill]")!.getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
  })));
  await pause(page, 400);
  await page.screenshot({ path: path.join(SHEET_OUT, "desktop-popover.png") });
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent ?? "");
  const popover = await reachable(page, "[data-runtime-popover]", "[data-runtime-popover]");
  check("the popover is open and on screen", Boolean(popover?.inside && popover.hitOwn));
  check("the popover names the account the conversation runs on", namesAccount.includes("spare"));
  check("no page errors", pageErrors.length === 0);
  await page.close();
  return { surface: "desktop-popover", ancestors, popover, namesAccount, pageErrors, failures };
}

browserTest("#1795: the runtime sheet covers the phone from every surface, closes, ignores a re-tap, and names the account", async () => {
  fs.mkdirSync(SHEET_OUT, { recursive: true });
  fs.mkdirSync(SHEET_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: { surface: string; failures: string[]; pageErrors: string[] }[] = [];
  try {
    for (const { viewport, account } of SHEET_CASES) {
      for (const surface of ["pane-on-board", "round-deck-on-board", "conversation-view"] as const) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        try {
          const result = await sheetSurface(context, fixtureBase, surface, account);
          results.push({ viewport, ...result });
          if (result.failures.length) failures.push({ surface: `${viewport.width}x${viewport.height}-${account}-${surface}`, failures: result.failures, pageErrors: result.pageErrors });
        } finally {
          await context.close();
        }
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1_280, height: 900 }, colorScheme: "dark" });
    try {
      const result = await popoverSurface(desktop, fixtureBase);
      results.push({ viewport: { width: 1_280, height: 900 }, ...result });
      if (result.failures.length) failures.push({ surface: "1280-popover", failures: result.failures, pageErrors: result.pageErrors });
    } finally {
      await desktop.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(SHEET_EVIDENCE, "runtime-sheet.json"), `${JSON.stringify(results, null, 2)}\n`);
  if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
}, 300_000);

/*
 * #1846 — a pick on the phone, on the same real Viewer with the running conversation on a structured host
 * (`&runtime=structured`), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846"
 *
 * The sheet's row for another account is tapped and the sheet closed; the title line must then name the
 * account the next message goes to whole, the running account yielding first, and the model with its tier
 * stays whole on the line under it. The pick sends the conversation's reconfigure and never an engine select.
 *
 * Readings go to `evidence/issue-1846/phone-header.json`; frames to `.artifacts/issue-1846/`.
 */
const PICK_OUT = path.resolve(".artifacts/issue-1846");
const PICK_EVIDENCE = path.resolve("evidence/issue-1846");
const PICK_CASES = [
  { account: "spare", next: "relief" },
  { account: "review-relief-2", next: "production-backup-7" },
] as const;

browserTest("#1846: a pick on the phone names the next account whole on the title line", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 390, height: 844 };
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await headerReading(page);
          await tap(page, cdp, "[data-runtime-pill]");
          await page.waitForSelector(`[data-runtime-sheet-account="${next}"]`, { timeout: 10_000 });
          await pause(page, 300);
          await tap(page, cdp, `[data-runtime-sheet-account="${next}"]`);
          await pause(page, 100);
          const sheetLine = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-sheet.png`) });
          await tap(page, cdp, "[data-runtime-sheet-close]");
          await pause(page, 400);
          const after = await headerReading(page);
          const parts = await page.evaluate(() => {
            const cell = (selector: string) => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const box = element.getBoundingClientRect();
              /* The text's own width, unrounded: scrollWidth rounds, and hid a cut of under a pixel that still drew an ellipsis. */
              const range = document.createRange();
              range.selectNodeContents(element);
              const need = range.getBoundingClientRect().width;
              const tag = document.querySelector("[data-mobile2-chat-account]")!.getBoundingClientRect();
              return {
                text: element.textContent ?? "",
                width: Math.round(box.width * 10) / 10,
                need: Math.round(need * 10) / 10,
                cut: need > box.width + 0.1,
                /* On the tag's one line, or wrapped below it where the tag clips it. */
                shown: box.top >= tag.top - 0.5 && box.bottom <= tag.bottom + 0.5 && box.width > 0,
              };
            };
            return { runs: cell("[data-mobile2-chat-account-runs]"), to: cell("[data-mobile2-chat-account-to]") };
          });
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-header.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, sheetLine, after, parts, sent, pageErrors });
          if (!sheetLine.includes(account) || !sheetLine.includes(next)) fail(`the sheet names both accounts: ${sheetLine}`);
          if (parts.to?.text !== `→ ${next}`) fail(`the title line names the next account: ${JSON.stringify(parts.to)}`);
          /* The title keeps at least 6rem (critique round 4), so a next id longer than the room left draws its head
             and yields its tail; one that fits is whole. */
          if (parts.to?.shown !== true) fail(`the next account is on the line: ${JSON.stringify(parts.to)}`);
          if (next.length <= 8 && parts.to?.cut !== false) fail(`a short next account is whole: ${JSON.stringify(parts.to)}`);
          if (parts.to?.cut && parts.to.width < 80) fail(`the next account shows a readable head: ${JSON.stringify(parts.to)}`);
          if ((after.title?.width ?? 0) < 95.5) fail(`the title keeps its 6rem: ${JSON.stringify(after.title)}`);
          /* The running account is either whole beside it or not drawn at all — never a sliver. */
          if (parts.runs?.shown && parts.runs.cut) fail(`the running account shows cut: ${JSON.stringify(parts.runs)}`);
          if (account.length <= 8 && !parts.runs?.shown) fail(`short ids both fit: ${JSON.stringify(parts.runs)}`);
          if (after.model?.cut !== false) fail(`the model and its tier are whole: ${JSON.stringify(after.model)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "phone-header.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1846 at 1280x900 on the deck surface this fixture offers (`&deck=1`, the running conversation as a review
 * round), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846 desktop"
 *
 * The pick is made in the runtime pill's Account panel. On a desktop board the conversation opens in a
 * kanban reader, which replaces the conversation pane's own header, so the pane's «@ A → B» badge is not
 * mounted; the reading records that, and reads the header chip the reader does draw, and the pill's mark,
 * for what each draws against its text.
 *
 * Readings go to `evidence/issue-1846/desktop-deck.json`; frames to `.artifacts/issue-1846/`.
 */
browserTest("#1846 desktop: the deck surface's account chip at 1280 px names the pick whole", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const reading = (page: Page, selector: string) => page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const overflowing = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({ text: node.textContent ?? "", width: node.clientWidth, need: node.scrollWidth }));
    const pane = element.closest("[data-kanban-reader]")?.getBoundingClientRect() ?? null;
    return {
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      width: Math.round(box.width * 10) / 10,
      paneWidth: pane ? Math.round(pane.width * 10) / 10 : null,
      insidePane: pane ? box.left >= pane.left - 0.5 && box.right <= pane.right + 0.5 : null,
      overflowing,
    };
  }, selector);
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 1_280, height: 900 };
        const context = await browser.newContext({ viewport, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `desktop-${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured&deck=1#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.locator("[data-runtime-pill]").first().evaluate((element) => { element.scrollIntoView({ block: "center" }); (element as HTMLElement).click(); });
          await page.waitForSelector('[data-runtime-row="submenu"][data-runtime-value="account"]', { timeout: 5_000 });
          /* Clicked in the page: the reader's composer sits under the portalled popover's hit box in this frame. */
          await page.locator('[data-runtime-row="submenu"][data-runtime-value="account"]').evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`, { timeout: 5_000 });
          await page.locator(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`).evaluate((element) => (element as HTMLElement).click());
          await pause(page, 400);
          const chip = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          const mark = await reading(page, "[data-runtime-pill-next-account]");
          const paneBadges = await page.evaluate(() => document.querySelectorAll("[data-conversation-account-chip]").length);
          await page.screenshot({ path: path.join(PICK_OUT, `${key}.png`) });
          /* The narrow pane: the same reader held to 426 px, the width a board column gives its reader. */
          await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>("[data-kanban-reader]");
            if (pane) { pane.style.width = "426px"; pane.style.maxWidth = "426px"; }
          });
          await pause(page, 200);
          const narrow = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.screenshot({ path: path.join(PICK_OUT, `${key}-narrow.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, chip, narrow, mark, paneBadges, sent, pageErrors });
          if (narrow?.paneWidth !== 426) fail(`the narrow pane is 426 px: ${JSON.stringify(narrow)}`);
          if (narrow?.insidePane === false) fail(`in the narrow pane the chip leaves it: ${JSON.stringify(narrow)}`);
          if (!chip?.text.includes(next)) fail(`the reader's header chip names the next account: ${JSON.stringify(chip)}`);
          if (chip?.insidePane === false) fail(`the chip leaves its pane: ${JSON.stringify(chip)}`);
          if (!mark?.text.includes(next)) fail(`the pill carries the pick: ${JSON.stringify(mark)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "desktop-deck.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);
