/**
 * Renders the desktop-v2 prototype's key screens to PNGs, locally, and runs
 * the headless gates that make each frame an acceptance check:
 *
 *   bun docs/design/desktop-v2/capture.ts
 *   DESKTOP_V2_ONLY=board,pipeline-edit-stage bun docs/design/desktop-v2/capture.ts
 *   DESKTOP_V2_WIDTHS=1440 bun docs/design/desktop-v2/capture.ts
 *
 * Output lands in docs/design/desktop-v2/out/<frame>/<scheme>/<screen>.png,
 * which the directory's own .gitignore keeps out of the repository: a browser
 * render is not byte-deterministic, so it carries no privacy-manifest
 * provenance and the publication gate refuses committed rasters. The
 * orchestrator runs this to produce pictures for the operator.
 *
 * The pattern is docs/design/mobile-v2/capture.ts and the #979 recipe:
 * playwright over the locally installed Chrome, one context per colour scheme
 * and frame (1280×800, 1440×900, 1920×1080), and gates on every frame:
 *
 *   - nothing scrolls sideways: the document, the rail, the column, the
 *     stage, the pinned pane and the feed all keep scrollWidth ≤ clientWidth;
 *   - every visible control is at least 44 × 44 px (the issue's floor; visual
 *     weight is smaller inside the target where the design system asks);
 *   - no two visible controls' rects intersect, and a receipt never covers a
 *     control (with a dialog open only the dialog's controls count: the scrim
 *     or the click-away layer owns everything else);
 *   - the scheme actually applied (the canvas colour differs between the two);
 *   - the bench never shows inside a frame-sized viewport;
 *   - keyboard focus order: in the composer Tab walks field → model chip →
 *     attach → dictate → send slot; a dialog takes focus on open, Tab wraps
 *     inside it, Escape closes it and returns focus to the control that
 *     opened it.
 *
 * After the matrix, headless flows click through the design: the column's
 * arrow keys and Enter, the single-key map (n N / o m a p t c [ ?), the
 * after-start pipeline editing story (edit-stage for the next attempt and
 * with restart, set-edge, note, rerun refused while unsettled then allowed
 * with stopCurrent, add-stage, remove-stage with undo, answer on a parked
 * stage, completed → edit → re-run), the receipts with their inverse action,
 * the arrival banner's seen stamp, the split pane's width rule, and the
 * vocabulary. The prototype is static — no server, no build step — so the page
 * is opened from a file: URL; the screen list is the same screens.js the page
 * uses.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

interface Screen { id: string; hash: string; title: string; scenario?: string; w?: string[] }

const HERE = import.meta.dir;
const OUT_DIR = path.join(HERE, "out");
const INDEX = path.join(HERE, "prototype", "index.html");
const require = createRequire(import.meta.url);
const SCREENS = require("./prototype/screens.js") as Screen[];

const FRAMES = [
  { name: "1280", width: 1280, height: 800 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;
const SCHEMES = ["dark", "light"] as const;
const HIT_PX = 44;
const CANVAS = { light: "rgb(243, 243, 246)", dark: "rgb(16, 16, 20)" } as const;
/* One phrase per state, the product's words, no instructions and no confirmations in the UI. */
const BANNED_WORDS = ["Waiting on you", "waiting for your answer", "Agent is waiting", "live tail", "polling stands by", "REQUEST_CHANGES", "Are you sure", "confirm", "Swipe", "Working dir"];

const only = (process.env.DESKTOP_V2_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/* DESKTOP_V2_COLLECT=1 keeps rendering after a failing frame and reports every
   failure at the end (still exiting 1), so one run names all the work. */
const collect = process.env.DESKTOP_V2_COLLECT === "1";
const failures: string[] = [];
function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!collect) throw err instanceof Error ? err : new Error(message);
  failures.push(message);
  console.error(`✗ ${message}`);
}
const widths = (process.env.DESKTOP_V2_WIDTHS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface Rect { x: number; y: number; w: number; h: number }
interface Control { tag: string; label: string; rect: Rect; small: boolean }
interface Geometry {
  scrollers: { name: string; scrollWidth: number; clientWidth: number }[];
  innerWidth: number;
  canvas: string;
  benchShown: boolean;
  dialog: boolean;
  controls: Control[];
  toast: Rect | null;
}

function urlFor(screen: Screen, scheme: string, width: number): string {
  const [hash, query] = screen.hash.split("?");
  return `${pathToFileURL(INDEX).href}?scheme=${scheme}&w=${width}${screen.scenario ? `&scenario=${screen.scenario}` : ""}${query ? `&${query}` : ""}${hash}`;
}

/* Every visible control with its rect clipped to its scroll ancestors and to
   the frame, so a row scrolled under the status bar is not counted as
   overlapping it. With a dialog open only the dialog's controls count. */
async function measure(page: Page): Promise<Geometry> {
  return page.evaluate((hit) => {
    const app = document.getElementById("app")!;
    const clip = (el: Element) => {
      const r = el.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      let a: Element | null = el.parentElement;
      while (a && a !== document.body) {
        const cs = getComputedStyle(a);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
          const ar = a.getBoundingClientRect();
          x1 = Math.max(x1, ar.left); y1 = Math.max(y1, ar.top); x2 = Math.min(x2, ar.right); y2 = Math.min(y2, ar.bottom);
        }
        a = a.parentElement;
      }
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), full: { w: r.width, h: r.height } };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const dialog = app.querySelector("[data-dialog]");
    const scope = dialog ?? app;
    const controls: { tag: string; label: string; rect: Rect; small: boolean }[] = [];
    for (const el of scope.querySelectorAll('button, a[href], [role="button"], select, input, textarea')) {
      if (!visible(el)) continue;
      if (el.parentElement?.closest('button, a[href], [role="button"]')) continue;
      const c = clip(el);
      if (c.w <= 0 || c.h <= 0) continue;
      controls.push({ tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || "").trim().slice(0, 40), rect: { x: c.x, y: c.y, w: c.w, h: c.h }, small: c.full.w < hit - 0.5 || c.full.h < hit - 0.5 });
    }
    const scrollers = [["document", document.documentElement], ["rail", app.querySelector(".rail")], ["column", app.querySelector(".col")], ["stage", app.querySelector(".stage")], ["pin", app.querySelector(".pin")], ["feed", app.querySelector(".stage .feed")], ["dialog", dialog]]
      .filter(([, el]) => el)
      .map(([name, el]) => ({ name: name as string, scrollWidth: (el as HTMLElement).scrollWidth, clientWidth: (el as HTMLElement).clientWidth }));
    const toastEl = app.querySelector(".receipt");
    const tr = toastEl ? toastEl.getBoundingClientRect() : null;
    const bench = document.getElementById("bench");
    return {
      scrollers,
      innerWidth,
      canvas: getComputedStyle(app).backgroundColor,
      benchShown: Boolean(bench && getComputedStyle(bench).display !== "none"),
      dialog: Boolean(dialog),
      controls,
      toast: tr ? { x: tr.left, y: tr.top, w: tr.width, h: tr.height } : null,
    };
  }, HIT_PX);
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const fmt = (c: Control) => `${c.tag} «${c.label}» ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}@${Math.round(c.rect.x)},${Math.round(c.rect.y)}`;

function gate(label: string, g: Geometry, scheme: "dark" | "light"): void {
  for (const s of g.scrollers) if (s.scrollWidth > s.clientWidth + 1) throw new Error(`${label}: the ${s.name} scrolls sideways to ${s.scrollWidth}px in ${s.clientWidth}px`);
  if (g.benchShown) throw new Error(`${label}: the bench renders inside the frame`);
  const small = g.controls.filter((c) => c.small);
  if (small.length) throw new Error(`${label}: ${small.length} control(s) under the ${HIT_PX}px floor — ${small.slice(0, 6).map(fmt).join("; ")}`);
  for (let i = 0; i < g.controls.length; i++) for (let j = i + 1; j < g.controls.length; j++) {
    if (intersects(g.controls[i].rect, g.controls[j].rect)) throw new Error(`${label}: two controls overlap — ${fmt(g.controls[i])} and ${fmt(g.controls[j])}`);
  }
  if (g.toast) {
    const hit = g.controls.find((c) => !/^(Respawn|Reopen|Restore|Retry stage|Switch back|Undo|Pause|Resume|Stop|Open successor|Unpin)$/.test(c.label) && intersects(g.toast!, c.rect));
    if (hit) throw new Error(`${label}: the receipt covers ${fmt(hit)}`);
  }
  if (g.canvas !== CANVAS[scheme]) throw new Error(`${label}: canvas is ${g.canvas}, expected the ${scheme} scheme's ${CANVAS[scheme]}`);
}

async function open(page: Page, screen: Screen, scheme: string, width: number): Promise<void> {
  const url = urlFor(screen, scheme, width);
  const sameDocument = page.url().split("#")[0] === url.split("#")[0];
  await page.goto(url, { waitUntil: "load" });
  if (sameDocument) await page.reload({ waitUntil: "load" });
  await page.waitForSelector('#app[data-ready="1"]', { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(screen.scenario === "arrival" ? 900 : 120);
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const hasDialog = (page: Page) => page.evaluate(() => Boolean(document.querySelector("#app [data-dialog]")));
const active = (page: Page) => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.dataset.focus ? `[${a.dataset.focus}]` : ""}${a.dataset.go ? `{${a.dataset.go}}` : ""}${a.dataset.act ? `(${a.dataset.act})` : ""}` : "none"; });
const activeInDialog = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest("#app [data-dialog]")));
async function expect(cond: boolean, msg: string): Promise<void> { if (!cond) throw new Error(`flow: ${msg}`); }

/* The composer's focus order and a dialog's focus contract, measured on the
   frames that have them. */
async function focusGates(page: Page, label: string, screen: Screen): Promise<void> {
  const hasComposer = await page.evaluate(() => Boolean(document.querySelector('#app .stage .box [data-focus="field"]')));
  if (hasComposer && !(await hasDialog(page))) {
    await page.focus('#app .stage .box [data-focus="field"]');
    const order: string[] = [await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focus ?? "")];
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); order.push(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focus ?? "")); }
    const want = ["field", "chip", "attach", "mic", "send"];
    if (order.join(">") !== want.join(">")) throw new Error(`${label}: composer focus order is ${order.join(" > ")}, expected ${want.join(" > ")}`);
  }
  if (await hasDialog(page)) {
    if (!(await activeInDialog(page))) throw new Error(`${label}: the dialog opened without taking focus (active: ${await active(page)})`);
    const count = await page.evaluate(() => [...document.querySelectorAll("#app [data-dialog] button, #app [data-dialog] input, #app [data-dialog] textarea, #app [data-dialog] select")].filter((x) => !(x as HTMLButtonElement).disabled && (x as HTMLElement).offsetParent !== null).length);
    for (let i = 0; i < count + 1; i++) { await page.keyboard.press("Tab"); if (!(await activeInDialog(page))) throw new Error(`${label}: Tab #${i + 1} left the dialog (active: ${await active(page)})`); }
    await page.keyboard.press("Escape");
    if (await hasDialog(page)) throw new Error(`${label}: Escape did not close the dialog`);
    const h = await hash(page);
    if (/\/(menu|model|details|create|search|host|keys|new-agent|new-pipeline|rotate)$/.test(h) || /\/add\/\d+$/.test(h)) throw new Error(`${label}: after Escape the route still names the dialog (${h})`);
    void screen;
  }
}

async function flows(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const at = (h: string, scenario?: string, width = 1440) => open(page, { id: "flow", hash: h, title: "", scenario }, "dark", width);
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? "", sel);
  const count = (sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  try {
    /* Column keyboard: ↓ ↓ Enter opens the highlighted row. */
    await at("#/board");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    const target = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.go ?? "");
    await expect(target.startsWith("#/"), `↓ ↓ did not land on a column row (active: ${await active(page)})`);
    await page.keyboard.press("Enter");
    await expect((await hash(page)) === target, `Enter opened ${await hash(page)}, not ${target}`);
    /* The filter: typing narrows, Enter opens the first match, Escape clears. */
    await at("#/board");
    await page.focus('#app [data-focus="filter"]');
    await page.keyboard.type("export");
    const rows = await count("#app .col-body [data-row]");
    await expect(rows === 2, `filtering «export» left ${rows} rows, expected the conversation and its pipeline`);
    await page.keyboard.press("Enter");
    await expect((await hash(page)) === "#/chat/c2", `Enter on the filter opened ${await hash(page)}`);
    /* n / N walk Needs you in the column's order; the queue holds both kinds. */
    await at("#/board");
    const queue = await page.evaluate(() => (window as unknown as { __proto: { attention: () => { go: string }[] } }).__proto.attention().map((a) => a.go));
    await expect(queue.length === 3 && queue.includes("#/pipeline/p2"), `the queue is ${queue.join(", ")}`);
    await page.keyboard.press("n"); await expect((await hash(page)) === queue[0], `n went to ${await hash(page)}`);
    await page.keyboard.press("n"); await expect((await hash(page)) === queue[1], `second n went to ${await hash(page)}`);
    await page.keyboard.press("n"); await expect((await hash(page)) === queue[2], `third n went to ${await hash(page)}, not the pipeline decision`);
    await page.keyboard.press("N"); await expect((await hash(page)) === queue[1], `N went to ${await hash(page)}`);
    /* Single keys: / o m a p t c [ ? */
    await at("#/board");
    await page.keyboard.press("/"); await expect(await hasDialog(page) && (await active(page)).includes("search"), `/ did not open search with the field focused (${await active(page)})`);
    await page.keyboard.type("export");
    await expect((await count("#app .search-rows .mrow")) >= 1, "search rows did not render");
    await page.keyboard.press("Escape"); await expect(!(await hasDialog(page)), "Escape did not close search");
    await page.keyboard.press("o"); await expect((await hash(page)) === "#/chat/orch", `o went to ${await hash(page)}`);
    await page.keyboard.press("m"); await expect(await page.evaluate(() => Boolean(document.querySelector("#app [data-map]"))), "m did not show the map");
    await page.keyboard.press("m"); await expect(!(await page.evaluate(() => Boolean(document.querySelector("#app [data-map]")))), "m did not return to the list");
    await page.keyboard.press("a"); await expect((await hash(page)) === "#/accounts", `a went to ${await hash(page)}`);
    await page.keyboard.press("p"); await expect((await hash(page)) === "#/pipelines", `p went to ${await hash(page)}`);
    await page.keyboard.press("t"); await expect((await hash(page)) === "#/tasks", `t went to ${await hash(page)}`);
    await page.keyboard.press("c"); await expect(await hasDialog(page), "c did not open the create menu"); await page.keyboard.press("Escape");
    await page.keyboard.press("["); await expect(await page.evaluate(() => document.getElementById("app")!.dataset.rail === "0"), "[ did not collapse the rail");
    gate("flow/rail-collapsed", await measure(page), "dark");
    await page.keyboard.press("[");
    await page.keyboard.press("?"); await expect(await hasDialog(page), "? did not open the shortcuts"); await page.keyboard.press("Escape");
    /* Escape from the composer returns to the column; a dialog's trigger gets focus back. */
    await at("#/chat/c1");
    await page.focus('#app .stage .box [data-focus="field"]');
    await page.keyboard.press("Escape");
    await expect((await active(page)).includes("{#/chat/c1}") || (await active(page)).includes("[filter]"), `Escape from the composer landed on ${await active(page)}`);
    await page.click('#app .chat-head [data-go="#/chat/c1/menu"]');
    await expect(await hasDialog(page) && await activeInDialog(page), "the conversation menu did not take focus");
    await page.keyboard.press("Escape");
    await expect((await active(page)).includes("{#/chat/c1/menu}"), `focus did not return to the menu trigger (${await active(page)})`);
    /* Stop sits in the send slot while working; typing flips it to send; Enter sends. */
    await at("#/chat/c1");
    await expect(await page.evaluate(() => Boolean(document.querySelector("#app .stage .box .send.stop"))), "a working conversation does not show Stop in the send slot");
    await page.focus('#app .stage .box [data-focus="field"]');
    await page.keyboard.type("keep going");
    await expect(await page.evaluate(() => { const s = document.querySelector("#app .stage .box .send"); return Boolean(s) && !s!.classList.contains("stop") && !s!.classList.contains("off"); }), "typing did not flip Stop into Send");
    await page.keyboard.press("Enter");
    const last = await page.evaluate(() => { const b = [...document.querySelectorAll("#app .stage .mu .bubble")]; return b[b.length - 1]?.textContent ?? ""; });
    await expect(last === "keep going", `Enter did not send (last bubble: ${last})`);
    /* Answer path: an option sends, the card folds, the row leaves Needs you. */
    await at("#/chat/c2");
    await page.click('#app .stage .q .opt[data-act="answer:c2:0"]');
    await expect(await page.evaluate(() => Boolean(document.querySelector("#app .stage .qf")) && !document.querySelector("#app .stage .q:not(.quiet)")), "the answered question did not fold");
    await expect((await count('#app .col-body .sec[data-sec="needs"] [data-go="#/chat/c2"]')) === 0, "the answered conversation is still in Needs you");
    /* Kill from the menu acts on the click; the receipt carries Respawn and covers nothing. */
    await at("#/chat/c1/menu");
    await page.click('#app [data-dialog] [data-act="kill:c1"]');
    await page.waitForTimeout(30);
    const g = await measure(page);
    await expect(Boolean(g.toast), "Kill produced no receipt");
    gate("flow/kill-receipt", g, "dark");
    await expect(await page.evaluate(() => Boolean(document.querySelector("#app .stage .box .send.respawn"))), "a killed conversation does not show Respawn in the slot");
    await page.click('#app .receipt [data-act="undo"]');
    await expect(await page.evaluate(() => !document.querySelector("#app .stage .box .send.respawn")), "Respawn from the receipt did not restore the conversation");
    /* Close card → board with a receipt that covers nothing; Reopen restores. */
    await at("#/chat/c3/menu");
    await page.click('#app [data-dialog] [data-act="close:c3"]');
    await page.waitForTimeout(30);
    await expect((await hash(page)) === "#/board" && !(await hasDialog(page)), `Close card landed on ${await hash(page)}`);
    gate("flow/close-receipt", await measure(page), "dark");
    await page.click('#app .receipt [data-act="undo"]');
    await expect((await hash(page)) === "#/chat/c3", `Reopen landed on ${await hash(page)}`);
    /* Pipeline editing after start (automation v2 §3.3 payloads). */
    await at("#/pipeline/p1/stage/review");
    const rev0 = Number((await text("#app .pipe-head .sub")).match(/rev (\d+)/)?.[1] ?? 0);
    await page.click('#app .editor [data-act="ed:effort:max"]');
    await page.click('#app .editor [data-act^="pa:editStage:p1:review"]');
    await page.waitForTimeout(30);
    const r1 = await text("#app .receipt");
    await expect(r1.includes("applies from attempt 1") && r1.includes(`rev ${rev0 + 1}`), `edit-stage on a stage without attempts gave «${r1}»`);
    gate("flow/edit-stage", await measure(page), "dark");
    await expect((await text('#app .stg[data-stage="review"] .cfg')).includes("max"), "the stage card does not show the saved reasoning");
    /* Running stage: Save is pending-next-attempt; Restart stops and starts. */
    await at("#/pipeline/p1/stage/build");
    await expect(await page.evaluate(() => (document.querySelector('#app .editor [data-act^="pa:rerun:p1:build"]') as HTMLButtonElement).disabled), "re-run is enabled while attempt 1 is unsettled");
    await page.click('#app .editor [data-act="ed:effort:xhigh"]');
    await page.click('#app .editor [data-act^="pa:editStage:p1:build"]');
    await page.waitForTimeout(30);
    const r2 = await text("#app .receipt");
    await expect(r2.includes("applies from attempt 2"), `edit-stage on a running stage gave «${r2}»`);
    await expect((await text('#app .stg[data-stage="build"]')).includes("edit pending"), "the running stage card does not show the pending edit");
    await page.click('#app .editor [data-act="ed:stopCurrent:toggle"]');
    await expect(!(await page.evaluate(() => (document.querySelector('#app .editor [data-act^="pa:rerun:p1:build"]') as HTMLButtonElement).disabled)), "re-run stays disabled after ticking Stop first");
    await page.click('#app .editor [data-act^="pa:rerun:p1:build"]');
    await page.waitForTimeout(30);
    const r3 = await text("#app .receipt");
    await expect(r3.includes("Attempt 2 of build started") && r3.includes("stopCurrent"), `rerun with stopCurrent gave «${r3}»`);
    await expect((await text('#app .stg[data-stage="build"]')).includes("2 attempts"), "the stage card does not count the new attempt");
    /* Restart now on the running attempt. */
    await at("#/pipeline/p1/stage/build");
    await page.click('#app .editor [data-act^="pa:editRestart:p1:build"]');
    await page.waitForTimeout(30);
    const r4 = await text("#app .receipt");
    await expect(r4.includes("restarted") && r4.includes("attempt 2 of build"), `restart gave «${r4}»`);
    /* set-edge with a new round budget; note for the next attempt. */
    await at("#/pipeline/p2/stage/review");
    await page.fill('#app .editor [data-act="ed:maxRounds"]', "5");
    await page.click('#app .editor [data-act^="pa:setEdge:p2:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .receipt")).includes("Edges saved"), "set-edge produced no receipt");
    await expect((await text("#app .stages")).includes("×5"), "the fail edge does not show the new budget");
    await page.fill('#app .editor [data-act="ed:note"]', "Keep the archive collection out of this lane.");
    await page.click('#app .editor [data-act^="pa:note:p2:review"]');
    await page.waitForTimeout(30);
    await expect((await text('#app .stg[data-stage="review"]')).includes("1 note"), "the note did not land on the stage card");
    /* Answer on a parked stage creates the next attempt and clears the findings. */
    await at("#/pipeline/p2");
    await page.fill('#app [data-act="answerField"]', "Use the fake-timer clock; the sweep runs in the controller cycle.");
    await page.click('#app [data-act="pa:answer:p2"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .receipt")).includes("attempt 3 of review started"), `answer gave «${await text("#app .receipt")}»`);
    await expect((await count("#app .findings")) === 0, "the findings block is still there after the answer");
    await expect((await text('#app .col-body [data-go="#/pipeline/p2"] .badge')).includes("running"), "the column row does not read running");
    /* add-stage after start, then remove it with undo. */
    await at("#/pipeline/p1/add/3");
    await page.fill('#app .editor [data-act="ed:id"]', "verify-2");
    await page.click('#app .editor [data-act^="pa:addStage:p1:3"]');
    await page.waitForTimeout(30);
    await expect((await hash(page)) === "#/pipeline/p1/stage/verify-2" && (await count("#app .stg")) === 6, `add-stage landed on ${await hash(page)} with ${await count("#app .stg")} stages`);
    gate("flow/add-stage", await measure(page), "dark");
    await page.click('#app .editor [data-act^="pa:removeStage:p1:verify-2"]');
    await page.waitForTimeout(30);
    await expect((await count("#app .stg")) === 5, "remove-stage did not remove the stage");
    await page.click('#app .receipt [data-act="undo"]');
    await expect((await count("#app .stg")) === 6, "Undo did not restore the stage");
    /* Completed: edit first, then re-run reopens it. */
    await at("#/pipeline/p4/stage/review");
    await page.click('#app .editor [data-act^="pa:editStage:p4:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .receipt")).includes("applies from attempt 2"), "edit on a completed pipeline was not accepted");
    await page.click('#app .editor [data-act^="pa:rerun:p4:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .pipe-head .sub")).includes("running"), "re-run did not reopen the completed pipeline");
    /* Draft: Start creates attempt 1. */
    await at("#/pipeline/p3");
    await page.click('#app [data-act="pa:start:p3"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .pipe-head .sub")).includes("running") && (await text('#app .stg[data-stage="build"]')).includes("1 attempt"), "Start did not create attempt 1");
    /* Arrival: the banner opens the decision and stamps it seen; back shows no banner. */
    await at("#/chat/c1", "arrival");
    await expect(await page.evaluate(() => Boolean(document.querySelector('#app [data-banner="arrival"]'))), "an arrival in another project shows no banner");
    await page.click('#app [data-banner="arrival"] .open');
    await expect((await hash(page)) === "#/chat/k1" && !(await page.evaluate(() => document.querySelector("#app [data-banner]"))), `the banner landed on ${await hash(page)} with a banner still showing`);
    await page.goBack(); await page.waitForTimeout(60);
    await expect((await hash(page)) === "#/chat/c1" && !(await page.evaluate(() => document.querySelector('#app [data-banner="arrival"]'))), "a seen decision was announced again after back");
    /* Split: at 1920 the seat pins beside; at 1280 the control is absent. */
    await page.setViewportSize({ width: 1920, height: 1080 });
    await at("#/chat/c2", "split", 1920);
    await expect(await page.evaluate(() => document.getElementById("app")!.dataset.pin === "1" && Boolean(document.querySelector("#app .pin .chat")) && Boolean(document.querySelector("#app .stage .chat"))), "the split did not render two panes at 1920");
    gate("flow/split-1920", await measure(page), "dark");
    await page.setViewportSize({ width: 1280, height: 800 });
    await at("#/chat/c2", "split", 1280);
    await expect(await page.evaluate(() => document.getElementById("app")!.dataset.pin === "0" && !document.querySelector('#app [data-act^="pin:"]')), "the split or its control renders at 1280");
    await page.setViewportSize({ width: 1440, height: 900 });
    /* Offline: the slot is Queue and a send is held. */
    await at("#/chat/c1", "offline");
    const off = await page.evaluate(() => ({ banner: document.querySelector('#app [data-banner="offline"]') !== null, slot: document.querySelector("#app .stage .box .send")?.textContent?.trim() ?? "", status: document.querySelector("#app .statusbar .sb")?.textContent ?? "" }));
    await expect(off.banner && off.slot === "Queue" && off.status.includes("offline"), `offline renders ${JSON.stringify(off)}`);
    /* Limit: the chip warns, the model popover offers the ready account and routes the not-signed-in one to sign-in. */
    await at("#/chat/c1/model", "limit");
    await page.click('#app [data-dialog] [data-act="signIn:claude:cl-second"]');
    await expect((await text("#app .receipt")).includes("sign-in") && (await hasDialog(page)), "the sign-in row closed the popover or took over");
    await page.click('#app [data-dialog] [data-act="md:c1:account:cl-lab"]');
    await expect(!(await hasDialog(page)) && (await text("#app .stage .box .chip")).startsWith("Opus · high"), `choosing the ready account gave «${await text("#app .stage .box .chip")}»`);
    /* No seat: the seat row invites and o opens the create draft. */
    await at("#/board", "noseat");
    await expect(await page.evaluate(() => Boolean(document.querySelector('#app .seat[data-seat="none"] [data-create]'))), "no-seat board does not invite");
    await page.keyboard.press("o");
    await expect((await hash(page)) === "#/seat/rotate" && (await text("#app [data-dialog] h2")).startsWith("Create"), `o with no seat opened ${await hash(page)}`);
    await page.click('#app [data-dialog] [data-orchestrator-primary]');
    await expect((await hash(page)) === "#/seat" && (await count('#app .seat[data-seat="live"]')) === 1, "Create orchestrator did not seat one");
    /* Crowded: every Needs-you row ends inside the first screen. */
    await at("#/board", "crowded");
    const needBottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#app .col-body .sec[data-sec="needs"] [data-row]')].map((r) => r.getBoundingClientRect().bottom)));
    await expect(needBottom < 900, `with thirty conversations the last Needs-you row ends at ${needBottom}px`);
    gate("flow/crowded", await measure(page), "dark");
    await expect(errors.length === 0, `console errors: ${errors.join(" | ")}`);
    console.log("flows: column keys, filter, n/N queue, single-key map, focus return, composer slot, answer path, kill/close receipts, edit-stage (next attempt, restart), set-edge, note, rerun refused/allowed, answer, add/remove/undo, completed reopen, draft start, arrival seen stamp, split width rule, offline, limit sign-in, no seat, crowded — green");
  } finally {
    await context.close();
  }
}

function vocabulary(): void {
  const dir = path.join(HERE, "prototype");
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const w of BANNED_WORDS) if (text.includes(w)) throw new Error(`vocabulary: prototype/${file} still says «${w}»`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(INDEX)) throw new Error(`prototype entry not found: ${INDEX}`);
  vocabulary();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const screens = only.length ? SCREENS.filter((s) => only.includes(s.id)) : SCREENS;
  if (!screens.length) throw new Error(`DESKTOP_V2_ONLY matched no screen (known: ${SCREENS.map((s) => s.id).join(", ")})`);
  const manifest: { frame: string; scheme: string; id: string; title: string; file: string }[] = [];
  try {
    for (const frame of FRAMES.filter((f) => !widths.length || widths.includes(f.name))) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width: frame.width, height: frame.height }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        const dir = path.join(OUT_DIR, frame.name, scheme);
        fs.mkdirSync(dir, { recursive: true });
        for (const screen of screens) {
          if (screen.w && !screen.w.includes(frame.name)) continue;
          const label = `${frame.name}/${scheme}/${screen.id}`;
          await open(page, screen, scheme, frame.width);
          const file = path.join(dir, `${screen.id}.png`);
          try {
            gate(label, await measure(page), scheme);
            await page.screenshot({ path: file });
            await focusGates(page, label, screen);
            if (errors.length) throw new Error(`${label}: console errors — ${errors.splice(0).join(" | ")}`);
          } catch (err) { fail(err); }
          manifest.push({ frame: frame.name, scheme, id: screen.id, title: screen.title, file: path.relative(OUT_DIR, file) });
        }
        await context.close();
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`${manifest.length} frames → ${OUT_DIR}`);
    if (!only.length && !widths.length) { try { await flows(browser); } catch (err) { fail(err); } }
    else console.log("flows skipped (a subset was requested)");
    if (failures.length) throw new Error(`${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
