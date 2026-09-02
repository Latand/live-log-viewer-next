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
 *     stage, the pinned pane, the feed, the stage graph, the kanban and each
 *     of its columns, the map, the account bodies, the editor's own scroller
 *     and the overview all keep scrollWidth ≤ clientWidth;
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
 * The rework round adds the structural gates that make each frame an
 * acceptance check for docs/design/desktop-v2/critique.md (README §11), run on
 * every frame beside the geometry ones:
 *
 *   - focus is never on the body (F5);
 *   - no `data-go` value appears twice in the column (F7);
 *   - the rail row, the column header and every overview card print the
 *     numbers one `counts(project)` computed (F6);
 *   - every stage node carries role, engine mark, model, reasoning, access and
 *     either its attempt pips or «not started», and every fail edge names its
 *     target and draws its round budget (F1);
 *   - every account row carries two meters and opens a detail (F2);
 *   - no payload hint, zoom tool or minimap survives on a stage (F19);
 *   - the composer has no permanent hint row and a pinned pane has its ⋯ (F15);
 *   - the stage is never a sentence with nothing to act on (F4);
 *   - the rail is collapsed under 1440 and expanded above it (F17);
 *   - a search snippet is clipped and never overlaps its meta column (F12);
 *   - the seat's mandate preview is three lines and Rotate is not primary (F13);
 *   - the findings title reads «attempt n · round k of m · j findings» (F18);
 *   - every task card carries a worker, a pipeline or an assign row (F3).
 *
 * After the matrix, headless flows click through the design: the column's
 * arrow keys and Enter, the focus model and the Escape bridge, the single-key
 * map (n N / o i k m a p c [ ? and 1–9), the after-start pipeline editing
 * story (edit-stage for the next attempt and with restart, set-edge with the
 * budget redrawn as pips, note, rerun refused while unsettled then allowed
 * with stopCurrent, add-stage, remove-stage with undo, answer on a parked
 * stage, completed → edit → re-run), the graph at three widths with its
 * attempt history and round fold, the account rows and one account's detail
 * with Switch, the kanban's chips and a drag between columns, the map's auto
 * layout with a pin honoured and released, the receipts with their inverse
 * action, the arrival in this project and in another, the split pane's width
 * rule, and the vocabulary. The prototype is static — no server, no build step — so the page
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
interface Control { tag: string; label: string; rect: Rect; small: boolean; inToast: boolean }
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
    const controls: { tag: string; label: string; rect: Rect; small: boolean; inToast: boolean }[] = [];
    for (const el of scope.querySelectorAll('button, a[href], [role="button"], select, input, textarea')) {
      if (!visible(el)) continue;
      if (el.parentElement?.closest('button, a[href], [role="button"]')) continue;
      const c = clip(el);
      if (c.w <= 0 || c.h <= 0) continue;
      controls.push({ tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || "").trim().slice(0, 40), rect: { x: c.x, y: c.y, w: c.w, h: c.h }, small: c.full.w < hit - 0.5 || c.full.h < hit - 0.5, inToast: Boolean(el.closest(".receipt")) });
    }
    const scrollers = [["document", document.documentElement], ["rail", app.querySelector(".rail")], ["column", app.querySelector(".col")], ["stage", app.querySelector(".stage")], ["pin", app.querySelector(".pin")], ["feed", app.querySelector(".stage .feed")], ["dialog", dialog],
      ["stage graph", app.querySelector(".graph")], ["stage body", app.querySelector(".sbody")], ["kanban", app.querySelector(".kanban")], ["map", app.querySelector(".map")], ["accounts", app.querySelector(".acc-body")], ["account detail", app.querySelector(".acc-detail")], ["editor", app.querySelector(".editor .ebody")], ["overview", app.querySelector(".ov")],
      ...[...app.querySelectorAll(".kcol .kl")].map((el, i) => [`kanban column ${i + 1}`, el] as [string, Element])]
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
    /* The receipt's own inverse action is the one control allowed inside it. */
    const hit = g.controls.find((c) => !c.inToast && intersects(g.toast!, c.rect));
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

/* Structural gates that make a frame an acceptance check for the rework, run
   on every frame beside the geometry ones. Each returns the violations it
   found, so one run names all of them. */
async function structure(page: Page, width: number, screen: Screen): Promise<string[]> {
  return page.evaluate(({ width, id, hash }) => {
    const bad: string[] = [];
    const app = document.getElementById("app")!;
    const proto = (window as unknown as { __proto: { counts: (id: string) => { needs: number; working: number; pipelines: number } } }).__proto;
    const txt = (el: Element | null) => (el as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const dialog = app.querySelector("[data-dialog]");

    /* F5: acting never drops focus to the body. */
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) bad.push("focus is on the body, not on the stage's primary target");

    /* F7: one id, one row. */
    const seen = new Map<string, number>();
    for (const el of app.querySelectorAll(".col-body [data-go]")) { const g = (el as HTMLElement).dataset.go!; seen.set(g, (seen.get(g) ?? 0) + 1); }
    for (const [g, n] of seen) if (n > 1) bad.push(`the column lists ${g} ${n} times`);

    /* F6: the rail row, the column header and the overview card print the
       numbers one function computed. */
    for (const row of app.querySelectorAll(".rail-list .prow[data-project]")) {
      const pid = (row as HTMLElement).dataset.project!;
      const n = proto.counts(pid);
      if (app.dataset.rail === "0") {
        /* Collapsed, the row is initials and the needs count as a badge. */
        const b = txt(row.querySelector(".ini b"));
        if (b !== (n.needs ? String(n.needs) : "")) bad.push(`the collapsed rail row ${pid} shows «${b}», not ${n.needs || "no"} needs`);
        continue;
      }
      const t = txt(row);
      if (n.needs && !t.includes(`${n.needs} need you`)) bad.push(`rail row ${pid} reads «${t}», not ${n.needs} need you`);
      if (n.working && !t.includes(`${n.working} working`)) bad.push(`rail row ${pid} reads «${t}», not ${n.working} working`);
    }
    const head = txt(app.querySelector(".col-head h1 small"));
    if (head && !app.querySelector(".ov")) {
      const cur = app.querySelector(".rail-list .prow.on[data-project]") as HTMLElement | null;
      if (cur) { const n = proto.counts(cur.dataset.project!); if (!head.includes(`${n.needs} need you`)) bad.push(`the column header reads «${head}», not ${n.needs} need you`); }
    }
    for (const card of app.querySelectorAll(".ov .pc .ph[data-project]")) {
      const pid = (card as HTMLElement).dataset.project!; const n = proto.counts(pid); const t = txt(card);
      if (n.needs && !t.includes(`${n.needs} need you`)) bad.push(`overview card ${pid} reads «${t}», not ${n.needs} need you`);
      if (!t.includes(`${n.working} working`)) bad.push(`overview card ${pid} reads «${t}», not ${n.working} working`);
    }

    /* F1: every node carries its whole definition, every loop names its
       target and its round budget. */
    for (const node of app.querySelectorAll(".graph .node")) {
      const t = txt(node);
      if (!node.querySelector(".l1 .role")) bad.push(`a stage node has no role`);
      if (!node.querySelector(".l2 .mark")) bad.push(`stage node «${t.slice(0, 24)}» has no engine mark`);
      for (const want of ["read-", "/"]) if (!t.includes(want)) bad.push(`stage node «${t.slice(0, 40)}» is missing «${want}»`);
      if (!/attempt|not started/.test(t)) bad.push(`stage node «${t.slice(0, 40)}» states neither its attempts nor «not started»`);
      if (!node.querySelector(".pips") && !t.includes("not started")) bad.push(`stage node «${t.slice(0, 24)}» shows no attempt pips`);
    }
    for (const loop of app.querySelectorAll(".graph .loop")) {
      const t = txt(loop.querySelector(".ll"));
      if (!/^↺ \S+/.test(t)) bad.push(`a fail edge label reads «${t}», not ↺ <target>`);
      if (!loop.querySelector(".pips i.round")) bad.push(`the fail edge «${t}» draws no round budget`);
    }
    if (app.querySelector(".graph")) {
      for (const node of app.querySelectorAll(".graph .node")) {
        const id = (node as HTMLElement).dataset.node;
        const loop = [...app.querySelectorAll(".graph .loop .ll")].some((l) => txt(l).startsWith(`↺ ${id}`));
        if (loop && !txt(node.parentElement)) bad.push(`the loop into ${id} has no node`);
      }
      const meta = txt(app.querySelector(".graph"));
      if ([...app.querySelectorAll(".graph .loop")].length && !/\d+ of \d+ rounds/.test(meta)) bad.push("no stage node states its round budget as «k of n rounds»");
    }

    /* F2: every account row, both windows. */
    const rows = [...app.querySelectorAll(".acc-body .arow:not(.add)")];
    if (rows.length) {
      const meters = app.querySelectorAll(".acc-body .arow:not(.add) .meter").length;
      if (meters !== rows.length * 2) bad.push(`${rows.length} account rows carry ${meters} meters, expected ${rows.length * 2}`);
      for (const r of rows) if (!(r as HTMLElement).dataset.go?.startsWith("#/accounts/")) bad.push(`an account row is not a target`);
    }

    /* F19: no request payloads, no zoom tools, no empty minimap. */
    const stageText = txt(app.querySelector(".stage"));
    for (const w of ["PATCH", "expectedRevision", "stageId:", "{index:"]) if (stageText.includes(w)) bad.push(`the stage still prints the payload hint «${w}»`);
    if (app.querySelector('[data-act^="zoom"]')) bad.push("the map still carries zoom tools");
    if (app.querySelector(".minimap")) bad.push("the map still carries a minimap");

    /* F15: the composer hint is in the placeholder; the pinned pane has its menu. */
    if (app.querySelector(".box .hint")) bad.push("the composer still carries a permanent hint row");
    const pin = app.querySelector(".pin");
    if (pin && !pin.querySelector('[data-go$="/menu"]')) bad.push("the pinned pane has no ⋯ menu");

    /* F4: the landing stage does work. */
    const empty = app.querySelector(".emptystage");
    if (empty && !empty.querySelector(".btn")) bad.push("the stage shows a sentence with nothing to act on");
    if (hash === "#/board" && empty) bad.push("the board's stage is a placard");

    /* F17: under 1440 the rail starts collapsed. */
    if (width < 1440 && !hash.includes("rail=") && app.dataset.rail !== "0") bad.push("at 1280 the rail is expanded by default");
    if (width >= 1440 && !hash.includes("rail=") && app.dataset.rail !== "1") bad.push("at 1440 and wider the rail is collapsed by default");

    /* F12: a search snippet never paints over the meta column. */
    for (const row of app.querySelectorAll(".srow")) {
      const snip = row.querySelector(".snip") as HTMLElement | null; const meta = row.querySelector(".sm") as HTMLElement | null;
      if (!snip || !meta) { bad.push("a search result has no snippet or no meta"); continue; }
      if (getComputedStyle(snip).overflow === "visible") bad.push("a search snippet is not clipped");
      const a = snip.getBoundingClientRect(); const b = meta.getBoundingClientRect();
      if (a.right > b.left + 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push("a search snippet overlaps its meta column");
    }

    /* F13: three faded lines of the mandate, and Rotate is not the primary. */
    const mand = app.querySelector(".seatpanel .mand .txt") as HTMLElement | null;
    if (mand) {
      const lh = parseFloat(getComputedStyle(mand).lineHeight) || 18;
      if (mand.clientHeight < lh * 2.5) bad.push(`the mandate preview shows ${Math.round(mand.clientHeight / lh)} lines, expected three`);
      const rot = app.querySelector("[data-orchestrator-rotate]");
      if (rot && rot.classList.contains("primary")) bad.push("Rotate is still the primary button on the seat");
    }

    /* F18: one vocabulary — attempt is a run, round is a traversal. */
    const findings = txt(app.querySelector(".findings h3"));
    if (findings && !/attempt \d+ · round \d+ of \d+ · \d+ findings/.test(findings)) bad.push(`the findings title reads «${findings}»`);

    /* F3: a kanban card is one thread, and its columns scroll down, not sideways. */
    for (const card of app.querySelectorAll(".kcard")) {
      if (!card.querySelector(".kchips .kchip")) bad.push(`the task card «${txt(card).slice(0, 30)}» carries no worker, pipeline or assign row`);
    }
    void id;
    return bad;
  }, { width, id: screen.id, hash: screen.hash });
}

async function flows(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const at = (h: string, scenario?: string, width = 1440) => open(page, { id: "flow", hash: h, title: "", scenario }, "dark", width);
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? "", sel);
  const count = (sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const has = (sel: string) => page.evaluate((s) => Boolean(document.querySelector(s)), sel);
  const center = async (sel: string) => page.evaluate((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) }; }, sel);
  const drag = async (from: string, to: string) => {
    const a = await center(from); const b = await center(to);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up(); await page.waitForTimeout(40);
  };
  try {
    /* Column keyboard: ↓ ↓ Enter opens the highlighted row. */
    await at("#/board");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    const target = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.go ?? "");
    await expect(target.startsWith("#/"), `↓ ↓ did not land on a column row (active: ${await active(page)})`);
    await page.keyboard.press("Enter");
    await expect((await hash(page)) === target, `Enter opened ${await hash(page)}, not ${target}`);
    /* The filter narrows the whole column; Enter opens the first match. */
    await at("#/board");
    await page.focus('#app [data-focus="filter"]');
    await page.keyboard.type("export");
    const rows = await count("#app .col-body [data-row]");
    await expect(rows === 3, `filtering «export» left ${rows} rows, expected the question, its pipeline and the finished design`);
    await page.keyboard.press("Enter");
    await expect((await hash(page)) === "#/chat/c2", `Enter on the filter opened ${await hash(page)}`);

    /* F5. The stage takes focus when it opens, and Escape is the bridge back
       to the column's current row — which is where the single keys live. */
    await at("#/board");
    const queue = await page.evaluate(() => (window as unknown as { __proto: { attention: () => { go: string }[] } }).__proto.attention().map((a) => a.go));
    await expect(queue.length === 3 && queue.includes("#/pipeline/p2"), `the queue is ${queue.join(", ")}`);
    await page.keyboard.press("n");
    await expect((await hash(page)) === queue[0], `n went to ${await hash(page)}`);
    await expect((await active(page)).includes("(answer:c2:0)"), `n landed focus on ${await active(page)}, not the first question option`);
    await page.keyboard.press("Escape");
    await expect((await active(page)) === `button{${queue[0]}}`, `Escape from the stage landed on ${await active(page)}, not the column's current row`);
    await page.keyboard.press("n");
    await expect((await hash(page)) === queue[1], `the second n went to ${await hash(page)}`);
    await expect((await active(page)) !== "none" && !(await active(page)).startsWith("body"), `the second stage opened with focus on ${await active(page)}`);
    await page.keyboard.press("Escape"); await page.keyboard.press("n");
    await expect((await hash(page)) === queue[2], `the third n went to ${await hash(page)}, not the pipeline decision`);
    await expect((await active(page)).includes("[answer]"), `the parked pipeline opened with focus on ${await active(page)}, not its Answer field`);
    await page.keyboard.press("Escape"); await page.keyboard.press("N");
    await expect((await hash(page)) === queue[1], `N went to ${await hash(page)}`);
    /* A conversation with nothing to answer opens on its composer, and the
       send slot is four Tabs away. */
    await at("#/chat/c1");
    await expect((await active(page)) === "textarea[field]", `a working conversation opened with focus on ${await active(page)}`);
    let tabs = 0;
    while (tabs < 6 && !(await active(page)).includes("[send]")) { await page.keyboard.press("Tab"); tabs += 1; }
    await expect(tabs <= 5, `the send slot is ${tabs} Tabs from the stage's focus`);
    await page.keyboard.press("Escape");
    await expect((await active(page)) === "button{#/chat/c1}", `Escape from the composer landed on ${await active(page)}`);
    await page.keyboard.press("i");
    await expect((await active(page)) === "textarea[field]", `i landed on ${await active(page)}, not the composer`);
    /* 1 picks the first question option and the row leaves Needs you. */
    await at("#/chat/c2");
    await page.keyboard.press("1");
    await expect(await has("#app .stage .qf"), "1 did not answer the question");
    await expect((await count('#app .col-body .sec[data-sec="needs"] [data-go="#/chat/c2"]')) === 0, "the answered conversation is still in Needs you");
    /* Every re-render restores the focused control by identity. */
    await at("#/chat/c1");
    await page.click('#app .stage .box [data-act="attach"]');
    await page.waitForTimeout(30);
    await expect((await active(page)).includes("(attach)"), `after a re-render focus is on ${await active(page)}, not the control that acted`);

    /* Single keys: / o k m a p c [ ? */
    await at("#/board");
    await page.keyboard.press("/"); await expect(await hasDialog(page) && (await active(page)).includes("search"), `/ did not open search with the field focused (${await active(page)})`);
    await page.keyboard.type("export");
    await expect((await count("#app .search-rows .srow")) >= 1, "search rows did not render");
    await page.keyboard.press("Escape"); await expect(!(await hasDialog(page)), "Escape did not close search");
    await page.keyboard.press("o"); await expect((await hash(page)) === "#/chat/orch", `o went to ${await hash(page)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("m"); await expect(await has("#app [data-map]"), "m did not show the map");
    await page.keyboard.press("Escape");
    await page.keyboard.press("k"); await expect(await has("#app [data-kanban]"), "k did not show the board");
    await page.keyboard.press("Escape");
    await page.keyboard.press("a"); await expect((await hash(page)) === "#/accounts", `a went to ${await hash(page)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("p"); await expect((await hash(page)) === "#/pipelines", `p went to ${await hash(page)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("c"); await expect(await hasDialog(page), "c did not open the create menu"); await page.keyboard.press("Escape");
    await page.keyboard.press("["); await expect(await page.evaluate(() => document.getElementById("app")!.dataset.rail === "0"), "[ did not collapse the rail");
    gate("flow/rail-collapsed", await measure(page), "dark");
    await page.keyboard.press("[");
    await page.keyboard.press("?"); await expect(await hasDialog(page), "? did not open the shortcuts"); await page.keyboard.press("Escape");
    /* A dialog's trigger gets focus back. */
    await at("#/chat/c1");
    await page.click('#app .chat-head [data-go="#/chat/c1/menu"]');
    await expect(await hasDialog(page) && await activeInDialog(page), "the conversation menu did not take focus");
    await page.keyboard.press("Escape");
    await expect((await active(page)).includes("{#/chat/c1/menu}"), `focus did not return to the menu trigger (${await active(page)})`);

    /* Stop sits in the send slot while working; typing flips it to send. */
    await at("#/chat/c1");
    await expect(await has("#app .stage .box .send.stop"), "a working conversation does not show Stop in the send slot");
    await page.focus('#app .stage .box [data-focus="field"]');
    await page.keyboard.type("keep going");
    await expect(await page.evaluate(() => { const s = document.querySelector("#app .stage .box .send"); return Boolean(s) && !s!.classList.contains("stop") && !s!.classList.contains("off"); }), "typing did not flip Stop into Send");
    await page.keyboard.press("Enter");
    const last = await page.evaluate(() => { const b = [...document.querySelectorAll("#app .stage .mu .bubble")]; return b[b.length - 1]?.textContent ?? ""; });
    await expect(last === "keep going", `Enter did not send (last bubble: ${last})`);
    /* Kill from the menu acts on the click; the receipt carries Respawn. */
    await at("#/chat/c1/menu");
    await page.click('#app [data-dialog] [data-act="kill:c1"]');
    await page.waitForTimeout(30);
    const g = await measure(page);
    await expect(Boolean(g.toast), "Kill produced no receipt");
    gate("flow/kill-receipt", g, "dark");
    await expect(await has("#app .stage .box .send.respawn"), "a killed conversation does not show Respawn in the slot");
    await page.click('#app .receipt [data-act="undo"]');
    await expect(!(await has("#app .stage .box .send.respawn")), "Respawn from the receipt did not restore the conversation");
    /* Close card → board with a receipt that covers nothing; Reopen restores. */
    await at("#/chat/c3/menu");
    await page.click('#app [data-dialog] [data-act="close:c3"]');
    await page.waitForTimeout(30);
    await expect((await hash(page)) === "#/board" && !(await hasDialog(page)), `Close card landed on ${await hash(page)}`);
    gate("flow/close-receipt", await measure(page), "dark");
    await page.click('#app .receipt [data-act="undo"]');
    await expect((await hash(page)) === "#/chat/c3", `Reopen landed on ${await hash(page)}`);

    /* F1 and F10. The graph is the record's shape: every stage on screen at
       every width, the attempts of a stage listed with their heads, and the
       earlier round's findings reachable without leaving the stage. */
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : width === 1440 ? 900 : 1080 });
      await at("#/pipeline/p6", undefined, width);
      const nodes = await count("#app .graph .node");
      await expect(nodes === 7, `at ${width} the long pipeline draws ${nodes} of its 7 stages`);
      const over = await page.evaluate(() => { const el = document.querySelector("#app .graph") as HTMLElement; return el.scrollWidth - el.clientWidth; });
      await expect(over <= 1, `at ${width} the graph scrolls sideways by ${over}px`);
      const loops = await count("#app .graph .loop");
      await expect(loops === 2, `at ${width} the long pipeline draws ${loops} of its 2 fail edges`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await at("#/pipeline/p2");
    await page.click('#app .graph [data-node="review"] .nhead');
    await page.waitForTimeout(30);
    const attempts = await count('#app .graph [data-node="review"] .att');
    await expect(attempts === 2, `the review node lists ${attempts} attempts, expected both`);
    await expect((await text('#app .graph [data-node="review"] .att')).includes("7be2d0"), "an attempt row does not name its head");
    await expect((await count('#app .graph [data-node="review"] .att .open')) === 2, "an attempt with a conversation has no open ›");
    await at("#/pipeline/p2");
    await expect((await text("#app .findings h3")).includes("attempt 2 · round 2 of 3 · 2 findings"), `the findings title reads «${await text("#app .findings h3")}»`);
    await page.click('#app .findings summary');
    await page.waitForTimeout(30);
    await expect((await count("#app .findings details[open] li")) === 2, "round 1's findings do not open in place");

    /* Pipeline editing after start (automation v2 §3.3). */
    await at("#/pipeline/p1/stage/review");
    const rev0 = Number((await text("#app .shead .sub")).match(/rev (\d+)/)?.[1] ?? 0);
    await page.click('#app .editor [data-act="ed:effort:max"]');
    await page.click('#app .editor [data-act^="pa:editStage:p1:review"]');
    await page.waitForTimeout(30);
    const r1 = await text("#app .receipt");
    await expect(r1.includes("applies from attempt 1") && r1.includes(`rev ${rev0 + 1}`), `edit-stage on a stage without attempts gave «${r1}»`);
    gate("flow/edit-stage", await measure(page), "dark");
    await expect((await text('#app .graph [data-node="review"] .l2')).includes("max"), "the stage node does not show the saved reasoning");
    /* Running stage: Save is pending-next-attempt; Restart stops and starts. */
    await at("#/pipeline/p1/stage/build");
    await page.click('#app .editor [data-act$=":rerun"]');
    await expect(await page.evaluate(() => (document.querySelector('#app .editor [data-act^="pa:rerun:p1:build"]') as HTMLButtonElement).disabled), "re-run is enabled while attempt 1 is unsettled");
    await page.click('#app .editor [data-act="ed:effort:xhigh"]');
    await page.click('#app .editor [data-act^="pa:editStage:p1:build"]');
    await page.waitForTimeout(30);
    const r2 = await text("#app .receipt");
    await expect(r2.includes("applies from attempt 2"), `edit-stage on a running stage gave «${r2}»`);
    await expect((await text('#app .graph [data-node="build"]')).includes("edit pending"), "the running stage node does not show the pending edit");
    await page.click('#app .editor [data-act="ed:stopCurrent:toggle"]');
    await expect(!(await page.evaluate(() => (document.querySelector('#app .editor [data-act^="pa:rerun:p1:build"]') as HTMLButtonElement).disabled)), "re-run stays disabled after ticking Stop first");
    await page.click('#app .editor [data-act^="pa:rerun:p1:build"]');
    await page.waitForTimeout(30);
    const r3 = await text("#app .receipt");
    await expect(r3.includes("Attempt 2 of build started") && r3.includes("stopCurrent"), `rerun with stopCurrent gave «${r3}»`);
    await expect((await text('#app .graph [data-node="build"]')).includes("2 attempts"), "the stage node does not count the new attempt");
    /* Restart now on the running attempt. */
    await at("#/pipeline/p1/stage/build");
    await page.click('#app .editor [data-act^="pa:editRestart:p1:build"]');
    await page.waitForTimeout(30);
    const r4 = await text("#app .receipt");
    await expect(r4.includes("restarted") && r4.includes("attempt 2 of build"), `restart gave «${r4}»`);
    /* set-edge with a new round budget; note for the next attempt. */
    await at("#/pipeline/p2/stage/review");
    await page.click('#app .editor [data-act$=":edges"]');
    await page.fill('#app .editor [data-act="ed:maxRounds"]', "5");
    await page.click('#app .editor [data-act^="pa:setEdge:p2:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .receipt")).includes("Edges saved"), "set-edge produced no receipt");
    await expect((await text('#app .graph [data-node="review"] .l2')).includes("2 of 5 rounds"), `the stage node reads «${await text('#app .graph [data-node="review"] .l2')}» after the new budget`);
    await expect((await count("#app .graph .loop .pips i.round")) === 5, "the fail edge does not draw the new budget as pips");
    await page.click('#app .editor [data-act$=":note"]');
    await page.fill('#app .editor [data-act="ed:note"]', "Keep the archive collection out of this lane.");
    await page.click('#app .editor [data-act^="pa:note:p2:review"]');
    await page.waitForTimeout(30);
    await expect((await text('#app .graph [data-node="review"]')).includes("1 note"), "the note did not land on the stage node");
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
    await expect((await hash(page)) === "#/pipeline/p1/stage/verify-2" && (await count("#app .graph .node")) === 6, `add-stage landed on ${await hash(page)} with ${await count("#app .graph .node")} stages`);
    gate("flow/add-stage", await measure(page), "dark");
    await page.click('#app .editor [data-act$=":remove"]');
    await page.click('#app .editor [data-act^="pa:removeStage:p1:verify-2"]');
    await page.waitForTimeout(30);
    await expect((await count("#app .graph .node")) === 5, "remove-stage did not remove the stage");
    await page.click('#app .receipt [data-act="undo"]');
    await expect((await count("#app .graph .node")) === 6, "Undo did not restore the stage");
    /* Completed: edit first, then re-run reopens it. */
    await at("#/pipeline/p4/stage/review");
    await page.click('#app .editor [data-act^="pa:editStage:p4:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .receipt")).includes("applies from attempt 2"), "edit on a completed pipeline was not accepted");
    await page.click('#app .editor [data-act$=":rerun"]');
    await page.click('#app .editor [data-act^="pa:rerun:p4:review"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .shead .sub")).includes("running"), "re-run did not reopen the completed pipeline");
    /* Draft: Start creates attempt 1. */
    await at("#/pipeline/p3");
    await page.click('#app [data-act="pa:start:p3"]');
    await page.waitForTimeout(30);
    await expect((await text("#app .shead .sub")).includes("running") && (await text('#app .graph [data-node="build"]')).includes("1 attempt"), "Start did not create attempt 1");

    /* F2. Every account is a row with both windows; a row opens its detail. */
    await at("#/accounts");
    const arows = await count("#app .acc-body .arow:not(.add)");
    await expect(arows === 5, `the accounts stage lists ${arows} accounts, expected all five`);
    await page.click('#app [data-go="#/accounts/claude/cl-lab"]');
    await expect((await hash(page)) === "#/accounts/claude/cl-lab", `an account row opened ${await hash(page)}`);
    await expect(await has("#app .chart") && await has("#app .pace") && await has("#app .hours"), "the account detail has no burndown, pace or hourly consumption");
    const pace = await text("#app .pace");
    await expect(/burning at [\d.]+ % per hour/.test(pace) && /(runs out at|lasts to the reset)/.test(pace), `the pace panel reads «${pace}»`);
    await page.keyboard.press("Escape");
    await expect((await hash(page)) === "#/accounts", `Escape from the account detail landed on ${await hash(page)}`);
    await expect((await active(page)) === "button{#/accounts/claude/cl-lab}", `Escape returned focus to ${await active(page)}, not the row that opened the detail`);
    await at("#/accounts/claude/cl-lab");
    await page.click('#app [data-act="switch:claude:cl-lab"]');
    await page.waitForTimeout(30);
    const sw = await text("#app .receipt");
    await expect(sw.includes("Lab") && (await text("#app .receipt .btn")).includes("Switch back"), `Switch gave «${sw}»`);
    gate("flow/account-switch", await measure(page), "dark");

    /* F3. A card is the thread: its chips open the worker and the pipeline,
       and a drag between columns changes the task's status with an Undo. */
    await at("#/kanban");
    await page.click('#app .kcard[data-task="t1"] .kchip[data-worker]');
    await expect((await hash(page)) === "#/chat/c2", `the worker chip opened ${await hash(page)}`);
    await at("#/kanban");
    await page.click('#app .kcard[data-task="t1"] .kchip[data-pipe]');
    await expect((await hash(page)) === "#/pipeline/p1", `the pipeline chip opened ${await hash(page)}`);
    await at("#/kanban");
    const beforeDone = await count('#app [data-col="done"] .kcard');
    await drag('#app .kcard[data-task="t2"] .khead', '#app [data-col="done"] .kh');
    await expect((await count('#app [data-col="done"] .kcard')) === beforeDone + 1, "dragging a card did not change its status");
    await expect((await text("#app .receipt")).includes("Moved to Done"), `the drag gave «${await text("#app .receipt")}»`);
    gate("flow/kanban-drop", await measure(page), "dark");
    await page.click('#app .receipt [data-act="undo"]');
    await expect((await count('#app [data-col="done"] .kcard')) === beforeDone, "Undo did not move the card back");
    /* F4. The landing stage does work: the kanban where there are tasks, the
       first thing that needs the operator where there are none. */
    await at("#/board");
    await expect(await has("#app [data-kanban]"), "the board's landing stage is not the kanban");
    await at("#/board", "notasks");
    await expect(await has("#app .stage .chat .box"), "a project with no tasks lands on a placard, not on work");

    /* F11 and operator item 5. The map arranges itself; a group the operator
       moves is honoured, and releasing it returns it to the arrangement. */
    await at("#/map");
    const auto = await page.evaluate(() => [...document.querySelectorAll("#app .mapitem")].map((el) => (el as HTMLElement).style.top));
    await expect(auto.every((t) => t.endsWith("px")), "the map did not arrange its groups");
    const overlap = await page.evaluate(() => {
      const rs = [...document.querySelectorAll("#app .mapitem")].map((el) => el.getBoundingClientRect());
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].left < rs[j].right - 1 && rs[j].left < rs[i].right - 1 && rs[i].top < rs[j].bottom - 1 && rs[j].top < rs[i].bottom - 1) return true;
      return false;
    });
    await expect(!overlap, "two map groups overlap in the auto layout");
    await drag('#app .mapitem[data-item="p1"] .gh', "#app .map");
    await expect(await has('#app .mapitem[data-item="p1"].pinned'), "dragging a group did not pin it");
    await expect((await text("#app .receipt")).includes("Pinned where you put it"), `the drag gave «${await text("#app .receipt")}»`);
    const flowed = await page.evaluate(() => {
      const rs = [...document.querySelectorAll("#app .mapitem")].map((el) => el.getBoundingClientRect());
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].left < rs[j].right - 1 && rs[j].left < rs[i].right - 1 && rs[i].top < rs[j].bottom - 1 && rs[j].top < rs[i].bottom - 1) return false;
      return true;
    });
    await expect(flowed, "the rest of the map did not flow around the pinned group");
    gate("flow/map-pinned", await measure(page), "dark");
    await page.click('#app .receipt [data-act="undo"]');
    await expect(!(await has("#app .mapitem.pinned")), "Release did not return the group to the auto layout");

    /* F20. A decision arriving in the current project is a new row with its
       edge and one tick of the counts — no banner, no toast. */
    await at("#/board", "arrival-here");
    await page.waitForTimeout(700);
    await expect(await has("#app .col-body .row.new"), "the arrival in this project did not appear as a new row");
    await expect(!(await has('#app [data-banner="arrival"]')), "an arrival in the current project raised a banner");
    await expect((await text("#app .col-head h1 small")).startsWith("4 need you"), `the header count reads «${await text("#app .col-head h1 small")}» after the arrival`);
    /* An arrival in another project is the one banner, and it is stamped seen. */
    await at("#/chat/c1", "arrival");
    await expect(await has('#app [data-banner="arrival"]'), "an arrival in another project shows no banner");
    await page.click('#app [data-banner="arrival"] .open');
    await expect((await hash(page)) === "#/chat/k1" && !(await has("#app [data-banner]")), `the banner landed on ${await hash(page)} with a banner still showing`);
    await page.goBack(); await page.waitForTimeout(60);
    await expect((await hash(page)) === "#/chat/c1" && !(await has('#app [data-banner="arrival"]')), "a seen decision was announced again after back");

    /* Split: at 1920 the seat pins beside; at 1280 the control is absent. */
    await page.setViewportSize({ width: 1920, height: 1080 });
    await at("#/chat/c2", "split", 1920);
    await expect(await page.evaluate(() => document.getElementById("app")!.dataset.pin === "1" && Boolean(document.querySelector("#app .pin .chat")) && Boolean(document.querySelector("#app .stage .chat"))), "the split did not render two panes at 1920");
    gate("flow/split-1920", await measure(page), "dark");
    await page.setViewportSize({ width: 1280, height: 800 });
    await at("#/chat/c2", "split", 1280);
    await expect(await page.evaluate(() => document.getElementById("app")!.dataset.pin === "0" && !document.querySelector('[data-act^="pin:"]')), "the split or its control renders at 1280");
    /* F8. At 1280 the crowded column keeps every section reachable. */
    await at("#/board", "crowded", 1280);
    const sticky = await page.evaluate(() => [...document.querySelectorAll("#app .col-body .sec-h")].every((el) => getComputedStyle(el).position === "sticky"));
    await expect(sticky, "the column's section headers do not stick");
    await page.evaluate(() => { const b = document.querySelector("#app .col-body") as HTMLElement; b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(30);
    const bottom = await page.evaluate(() => {
      const b = (document.querySelector("#app .col-body") as HTMLElement).getBoundingClientRect();
      const last = document.querySelector('#app .sec[data-sec="recent"] .sec-h')!.getBoundingClientRect();
      return last.top >= b.top - 1 && last.bottom <= b.bottom + 1;
    });
    await expect(bottom, "scrolling the crowded column to the end does not reach the last section header");
    await expect(await has('#app .sec[data-sec="recent"] .sec-h[aria-expanded="false"]'), "Recent is not folded on a column longer than one screen");
    await page.setViewportSize({ width: 1440, height: 900 });
    /* Crowded at 1440: every Needs-you row ends inside the first screen. */
    await at("#/board", "crowded");
    const needBottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#app .col-body .sec[data-sec="needs"] [data-row]')].map((r) => r.getBoundingClientRect().bottom)));
    await expect(needBottom < 900, `with thirty conversations the last Needs-you row ends at ${needBottom}px`);
    gate("flow/crowded", await measure(page), "dark");
    /* F14. Fourteen projects fit one screen; the crowned card keeps its rows. */
    await at("#/overview", "crowded");
    const ov = await page.evaluate(() => { const el = document.querySelector("#app .ov") as HTMLElement; return { over: el.scrollHeight - el.clientHeight, quiet: document.querySelectorAll("#app .quietstrip .qchip").length, crowned: document.querySelectorAll('#app .pc [data-project="atlas"]').length ? document.querySelectorAll("#app .pc")[0].querySelectorAll("[data-row]").length : 0 }; });
    await expect(ov.over <= 1, `the crowded overview scrolls by ${ov.over}px instead of showing every project`);
    await expect(ov.quiet >= 8, `the crowded overview collapses ${ov.quiet} quiet projects into the strip, expected at least eight`);
    await expect(ov.crowned >= 6, `the crowned project's card lists ${ov.crowned} rows, expected at least six`);

    /* Offline: the slot is Queue and a send is held. */
    await at("#/chat/c1", "offline");
    const off = await page.evaluate(() => ({ banner: document.querySelector('#app [data-banner="offline"]') !== null, slot: document.querySelector("#app .stage .box .send")?.textContent?.trim() ?? "", status: document.querySelector("#app .statusbar .sb")?.textContent ?? "" }));
    await expect(off.banner && off.slot === "Queue" && off.status.includes("offline"), `offline renders ${JSON.stringify(off)}`);
    /* Limit: the chip warns, the popover offers the ready account and routes the not-signed-in one to sign-in. */
    await at("#/chat/c1/model", "limit");
    await page.click('#app [data-dialog] [data-act="signIn:claude:cl-second"]');
    await expect((await text("#app .receipt")).includes("sign-in") && (await hasDialog(page)), "the sign-in row closed the popover or took over");
    await page.click('#app [data-dialog] [data-act="md:c1:account:cl-lab"]');
    await expect(!(await hasDialog(page)) && (await text("#app .stage .box .chip")).startsWith("Opus · high"), `choosing the ready account gave «${await text("#app .stage .box .chip")}»`);
    /* No seat: the seat row invites and o opens the create draft. */
    await at("#/board", "noseat");
    await expect(await has('#app .seat[data-seat="none"] [data-create]'), "no-seat board does not invite");
    await page.keyboard.press("o");
    await expect((await hash(page)) === "#/seat/rotate" && (await text("#app [data-dialog] h2")).startsWith("Create"), `o with no seat opened ${await hash(page)}`);
    await page.click('#app [data-dialog] [data-orchestrator-primary]');
    await expect((await hash(page)) === "#/seat" && (await count('#app .seat[data-seat="live"]')) === 1, "Create orchestrator did not seat one");

    await expect(errors.length === 0, `console errors: ${errors.join(" | ")}`);
    console.log("flows: column keys, filter, stage focus and the Escape bridge, n/N queue, 1–9 options, i, single-key map, focus restored by identity, composer slot, kill/close receipts, the graph at three widths, attempt history, round fold, edit-stage (next attempt, restart), set-edge budget as pips, note, rerun refused/allowed, answer, add/remove/undo, completed reopen, draft start, account rows and detail with Switch, kanban chips and drag, landing stage, map auto-layout with a pin honoured and released, arrival here and elsewhere, split width rule, crowded at 1280 and 1440, crowded overview, offline, limit sign-in, no seat — green");
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
            const violations = await structure(page, frame.width, screen);
            if (violations.length) throw new Error(`${label}: ${violations.join("; ")}`);
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
