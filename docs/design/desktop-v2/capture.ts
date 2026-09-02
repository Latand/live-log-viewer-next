/**
 * Renders the desktop-v2 prototype's key screens to PNGs and runs the headless
 * gates that make each frame an acceptance check:
 *
 *   bun docs/design/desktop-v2/capture.ts
 *   DESKTOP_V2_ONLY=yard,chat-waiting bun docs/design/desktop-v2/capture.ts
 *   DESKTOP_V2_WIDTHS=1440 bun docs/design/desktop-v2/capture.ts
 *   DESKTOP_V2_COLLECT=1 …   keep going after a failing frame, report all at the end
 *
 * Output lands in docs/design/desktop-v2/out/<frame>/<scheme>/<screen>.png,
 * which the directory's own .gitignore keeps out of the repository: a browser
 * render is not byte-deterministic, so it carries no privacy-manifest
 * provenance and the publication gate refuses committed rasters (#1447).
 *
 * The pattern is docs/design/mobile-v2/capture.ts: playwright over the locally
 * installed Chromium, one context per colour scheme and frame (1280×800,
 * 1440×900, 1920×1080), and on every frame:
 *
 *   - nothing scrolls sideways: the document, the rail, the stage, the feed,
 *     the inspector, the accounts columns and the dialog keep scrollWidth ≤
 *     clientWidth;
 *   - every visible control is at least 44 × 44 px on screen — on the board
 *     that includes the yard tiles and the block nodes at the camera's zoom,
 *     which is why the camera never goes below the zoom at which a tile is
 *     44 px tall;
 *   - no two visible controls' rects intersect; a receipt covers no control;
 *   - the requested scheme applied (the canvas colour differs);
 *   - the bench never shows inside a frame-sized viewport;
 *   - focus is never on the body;
 *   - the composer's Tab order is field → chip → attach → mic → send slot;
 *   - a dialog takes focus on open, Tab wraps inside it, Escape closes it and
 *     returns focus to the control that opened it;
 *   - no ALL-CAPS label anywhere, no banned phrase.
 *
 * The board gates, on every board frame:
 *
 *   - the auto layout overlaps nothing: no two clusters intersect, and a
 *     pinned cluster keeps exactly the place it was put;
 *   - at yard altitude the block content is hidden and every tile is one
 *     control; at block altitude every node is one control;
 *   - the corner map draws one rect per cluster and a viewport frame;
 *   - clusters that need the operator sort first (their keycaps are 1..k).
 *
 * After the matrix, headless flows click through the design: pan by drag is
 * transform-only (a MutationObserver sees no DOM change while panning — the
 * "no reflow" promise), Ctrl+wheel zooms and the altitude flips with
 * hysteresis, a keycap glides the camera onto its cluster, n / N walk the
 * queue, Enter lifts and Esc lowers, a drag pins a cluster and the packer
 * flows around it and Release restores the auto layout, the inspector's
 * answer / skip / pause / archive / edit-stage actions land with their inverse
 * in a receipt, the chat's settings sheet is one level with every group
 * visible and Esc returns focus to the chip, the send slot flips between Stop
 * and Send, the question card answers on click, and every account row opens
 * a detail with the chart and the pace line.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

interface Screen { id: string; hash: string; title: string; scenario?: string; query?: string; w?: string[] }

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
const BANNED = ["Waiting on you", "waiting for your answer", "Agent is waiting", "live tail", "REQUEST_CHANGES", "Are you sure", "confirm", "Working dir", "STAGE PROMPT", "NEEDS YOU"];

const only = (process.env.DESKTOP_V2_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const widths = (process.env.DESKTOP_V2_WIDTHS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const collect = process.env.DESKTOP_V2_COLLECT === "1";
const failures: string[] = [];
function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!collect) throw err instanceof Error ? err : new Error(message);
  failures.push(message);
  console.error(`✗ ${message}`);
}

interface Rect { x: number; y: number; w: number; h: number }
interface Control { tag: string; label: string; rect: Rect; small: boolean; inReceipt: boolean; fw: number; fh: number }
interface Geometry {
  scrollers: { name: string; scrollWidth: number; clientWidth: number }[];
  canvas: string; benchShown: boolean; dialog: boolean; controls: Control[]; receipt: Rect | null; activeIsBody: boolean;
  caps: string[]; banned: string[]; altitude: string | null;
  clusters: { id: string; x: number; y: number; w: number; h: number; needs: boolean; key: number | null; pinned: boolean }[];
  tilesVisible: number; nodesVisible: number; mmRects: number; mmView: boolean;
}

function urlFor(screen: Screen, scheme: string, width: number): string {
  return `${pathToFileURL(INDEX).href}?scheme=${scheme}&w=${width}${screen.scenario ? `&scenario=${screen.scenario}` : ""}${screen.query ? `&${screen.query}` : ""}${screen.hash}`;
}

/* Every visible control with its rect clipped to its scroll ancestors and to
   the frame. With a dialog open only the dialog's controls count: the scrim
   owns everything else. */
async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(({ hit, banned }) => {
    const app = document.getElementById("app")!;
    const clip = (el: Element) => {
      const r = el.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      let a: Element | null = el.parentElement;
      while (a && a !== document.body) {
        const cs = getComputedStyle(a);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") { const ar = a.getBoundingClientRect(); x1 = Math.max(x1, ar.left); y1 = Math.max(y1, ar.top); x2 = Math.min(x2, ar.right); y2 = Math.min(y2, ar.bottom); }
        a = a.parentElement;
      }
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), fw: r.width, fh: r.height };
    };
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") return false; let a: Element | null = el; while (a && a !== document.body) { if (getComputedStyle(a).visibility === "hidden") return false; a = a.parentElement; } return true; };
    const dialog = app.querySelector("[data-dialog]");
    /* A lifted pane is the one live surface while it is up: the nodes under it
       are inert (pointer-events none), so only its controls count, like a dialog's. */
    const scope = dialog ?? app.querySelector("[data-lift-scope]") ?? app;
    const controls: Control[] = [];
    for (const el of scope.querySelectorAll('button, a[href], [role="button"], select, input, textarea')) {
      if (!visible(el)) continue;
      if (el.parentElement?.closest('button, a[href], [role="button"]')) continue;
      const c = clip(el);
      if (c.w <= 0 || c.h <= 0) continue;
      const app_r = app.getBoundingClientRect();
      if (c.x + c.w <= app_r.left || c.y + c.h <= app_r.top || c.x >= app_r.right || c.y >= app_r.bottom) continue;
      controls.push({ tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || "").trim().slice(0, 40), rect: { x: c.x, y: c.y, w: c.w, h: c.h }, small: c.fw < hit - 0.5 || c.fh < hit - 0.5, inReceipt: Boolean(el.closest(".receipt")), fw: c.fw, fh: c.fh });
    }
    const scrollers = [["document", document.documentElement], ["rail", app.querySelector(".rail")], ["stage", app.querySelector(".stagewrap")], ["feed", app.querySelector("[data-feed]")], ["inspector", app.querySelector(".insp-body")], ["accounts list", app.querySelector(".acc-list")], ["account detail", app.querySelector(".acc-detail")], ["dialog", dialog], ["chat", app.querySelector(".chat")], ["settings", app.querySelector(".settings")], ["bar", app.querySelector(".bar")], ["status", app.querySelector(".status")]]
      .filter(([, el]) => el)
      .map(([name, el]) => ({ name: name as string, scrollWidth: (el as HTMLElement).scrollWidth, clientWidth: (el as HTMLElement).clientWidth }));
    const rc = app.querySelector(".receipt");
    const rr = rc ? rc.getBoundingClientRect() : null;
    const bench = document.getElementById("bench");
    const text = (app as HTMLElement).innerText;
    const caps = [...new Set((text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !["JSON", "APPROVE", "PID", "HEAD", "README", "CSV", "TTL", "API", "SHA", "URL", "HTML", "MCP", "CLI", "RAM"].includes(w)))];
    const bannedHits = banned.filter((b) => text.includes(b));
    const board = app.querySelector("[data-board]");
    const proto = (window as unknown as { __proto: { model: () => { clusters: { id: string; x: number; y: number; w: number; h: number; needs: boolean; key?: number; pinned?: boolean }[] } } }).__proto;
    const model = board ? proto.model() : { clusters: [] };
    return {
      scrollers, canvas: getComputedStyle(app).backgroundColor, benchShown: Boolean(bench && !bench.hidden), dialog: Boolean(dialog), controls,
      receipt: rr ? { x: rr.left, y: rr.top, w: rr.width, h: rr.height } : null,
      activeIsBody: !document.activeElement || document.activeElement === document.body, caps, banned: bannedHits,
      altitude: board ? (board as HTMLElement).dataset.altitude ?? null : null,
      clusters: model.clusters.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, needs: c.needs, key: c.key ?? null, pinned: Boolean(c.pinned) })),
      tilesVisible: [...app.querySelectorAll(".cluster .tile")].filter((el) => getComputedStyle(el).display !== "none").length,
      nodesVisible: [...app.querySelectorAll(".cluster .node")].filter((el) => getComputedStyle(el).display !== "none" && getComputedStyle(el.parentElement!).visibility !== "hidden").length,
      mmRects: app.querySelectorAll(".minimap rect:not(.mm-bg):not(.mm-view):not(.mm-region)").length, mmView: Boolean(app.querySelector("[data-mm-view]")),
    };
  }, { hit: HIT_PX, banned: BANNED });
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const fmt = (c: Control) => `${c.tag} «${c.label}» ${Math.round(c.fw)}×${Math.round(c.fh)}@${Math.round(c.rect.x)},${Math.round(c.rect.y)}`;

function gate(label: string, g: Geometry, scheme: "dark" | "light", screen: Screen): void {
  for (const s of g.scrollers) if (s.scrollWidth > s.clientWidth + 1) throw new Error(`${label}: the ${s.name} scrolls sideways to ${s.scrollWidth}px in ${s.clientWidth}px`);
  if (g.benchShown) throw new Error(`${label}: the bench renders inside the frame`);
  const small = g.controls.filter((c) => c.small);
  if (small.length) throw new Error(`${label}: ${small.length} control(s) under the ${HIT_PX}px floor — ${small.slice(0, 6).map(fmt).join("; ")}`);
  for (let i = 0; i < g.controls.length; i++) for (let j = i + 1; j < g.controls.length; j++) {
    if (intersects(g.controls[i].rect, g.controls[j].rect)) throw new Error(`${label}: two controls overlap — ${fmt(g.controls[i])} and ${fmt(g.controls[j])}`);
  }
  if (g.receipt) { const hit = g.controls.find((c) => !c.inReceipt && intersects(g.receipt!, c.rect)); if (hit) throw new Error(`${label}: the receipt covers ${fmt(hit)}`); }
  if (g.canvas !== CANVAS[scheme]) throw new Error(`${label}: canvas is ${g.canvas}, expected the ${scheme} scheme's ${CANVAS[scheme]}`);
  if (g.activeIsBody) throw new Error(`${label}: focus is on the body`);
  if (g.caps.length) throw new Error(`${label}: ALL-CAPS label(s) ${g.caps.join(", ")}`);
  if (g.banned.length) throw new Error(`${label}: banned phrase(s) ${g.banned.join(", ")}`);
  if (g.altitude) {
    for (let i = 0; i < g.clusters.length; i++) for (let j = i + 1; j < g.clusters.length; j++) {
      const a = g.clusters[i], b = g.clusters[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) throw new Error(`${label}: clusters ${a.id} and ${b.id} overlap in the auto layout`);
    }
    if (g.altitude === "yard" && g.nodesVisible) throw new Error(`${label}: ${g.nodesVisible} block node(s) visible at yard altitude`);
    if (g.altitude === "block" && screen.hash === "#/board" && !g.nodesVisible && g.clusters.length) throw new Error(`${label}: no node visible at block altitude`);
    if (g.mmRects !== g.clusters.length || !g.mmView) throw new Error(`${label}: the corner map draws ${g.mmRects} of ${g.clusters.length} clusters (viewport ${g.mmView})`);
    const keyed = g.clusters.filter((c) => c.key !== null).sort((a, b) => a.key! - b.key!);
    let seenNonNeed = false;
    for (const c of keyed) { if (!c.needs) seenNonNeed = true; else if (seenNonNeed) throw new Error(`${label}: cluster ${c.id} needs you but is keyed after a cluster that does not`); }
    if (screen.scenario === "pinned") { const p = g.clusters.find((c) => c.id === "p2"); if (!p || !p.pinned || p.x !== 1460 || p.y !== 520) throw new Error(`${label}: the pinned cluster did not keep its place (${JSON.stringify(p)})`); }
  }
}

async function open(page: Page, screen: Screen, scheme: string, width: number): Promise<void> {
  const url = urlFor(screen, scheme, width);
  const sameDocument = page.url().split("#")[0] === url.split("#")[0];
  await page.goto(url, { waitUntil: "load" });
  if (sameDocument) await page.reload({ waitUntil: "load" });
  await page.waitForSelector('#app[data-ready="1"]', { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const hasDialog = (page: Page) => page.evaluate(() => Boolean(document.querySelector("#app [data-dialog]")));
const active = (page: Page) => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.dataset.focus ? `[${a.dataset.focus}]` : ""}${a.dataset.go ? `{${a.dataset.go}}` : ""}${a.dataset.act ? `(${a.dataset.act})` : ""}${a.dataset.board !== undefined ? "<board>" : ""}` : "none"; });
const activeInDialog = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest("#app [data-dialog]")));
const cam = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __proto: { cam: { x: number; y: number; z: number } } }).__proto.cam }));
const altitude = (page: Page) => page.evaluate(() => (document.querySelector("[data-board]") as HTMLElement | null)?.dataset.altitude ?? null);
async function expect(cond: boolean, msg: string): Promise<void> { if (!cond) throw new Error(`flow: ${msg}`); }

/* The composer's focus order and a dialog's focus contract, on the frames that have them. */
async function focusGates(page: Page, label: string): Promise<void> {
  const hasComposer = await page.evaluate(() => Boolean(document.querySelector('#app .chat .box [data-focus="field"]')));
  if (hasComposer && !(await hasDialog(page))) {
    await page.focus('#app .chat .box [data-focus="field"]');
    const order: string[] = [await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focus ?? "")];
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); order.push(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focus ?? "")); }
    const want = ["field", "chip", "attach", "mic", "send"];
    if (order.join(">") !== want.join(">")) throw new Error(`${label}: composer focus order is ${order.join(" > ")}, expected ${want.join(" > ")}`);
  }
  if (await hasDialog(page)) {
    if (!(await activeInDialog(page))) throw new Error(`${label}: the dialog opened without taking focus (active: ${await active(page)})`);
    const count = await page.evaluate(() => [...document.querySelectorAll("#app [data-dialog] button, #app [data-dialog] input, #app [data-dialog] textarea")].filter((x) => !(x as HTMLButtonElement).disabled && (x as HTMLElement).offsetParent !== null).length);
    for (let i = 0; i < count + 1; i++) { await page.keyboard.press("Tab"); if (!(await activeInDialog(page))) throw new Error(`${label}: Tab #${i + 1} left the dialog (active: ${await active(page)})`); }
    await page.keyboard.press("Escape");
    if (await hasDialog(page)) throw new Error(`${label}: Escape did not close the dialog`);
    const h = await hash(page);
    if (/\/(menu|settings|create|search|host|keys|rotate)$/.test(h)) throw new Error(`${label}: after Escape the route still names the dialog (${h})`);
    if (await page.evaluate(() => document.activeElement === document.body)) throw new Error(`${label}: after Escape the focus is on the body`);
  }
}

async function flows(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const goto = (screen: Screen | string, query = "") => open(page, typeof screen === "string" ? { id: "x", hash: screen, title: "", query } : screen, "dark", 1440);
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { fail(new Error(`${name}: ${(e as Error).message}`)); } };

  await goto("#/board");
  await step("pan is transform-only (no DOM mutation while dragging)", async () => {
    const before = await cam(page);
    const mutations = await page.evaluate(async () => {
      const board = document.querySelector("[data-board]") as HTMLElement;
      const world = board.querySelector(".world")!;
      let count = 0;
      /* Allowed while panning: the world's transform, the grid's background
         offset, the board's own class, the corner map's viewport frame and the
         bar's beacons. Anything else — a node, a cluster, a tile — is a reflow. */
      const allowed = (m: MutationRecord) => {
        const t = m.target as Element;
        if (m.type === "attributes" && (t === world || t.classList?.contains("grid") || t === board || t.hasAttribute?.("data-mm-view"))) return true;
        return Boolean(t.closest?.(".beacons"));
      };
      const mo = new MutationObserver((ms) => { for (const m of ms) if (!allowed(m)) count += 1; });
      mo.observe(board, { subtree: true, childList: true, attributes: true, characterData: true });
      const r = board.getBoundingClientRect();
      const ev = (type: string, x: number, y: number) => board.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, button: 0, pointerId: 1, isPrimary: true }));
      ev("pointerdown", 600, 400);
      for (let i = 1; i <= 30; i++) { ev("pointermove", 600 + i * 4, 400 + i * 2); await new Promise((res) => requestAnimationFrame(() => res(null))); }
      ev("pointerup", 720, 460);
      await new Promise((res) => setTimeout(res, 50));
      mo.disconnect();
      return count;
    });
    const after = await cam(page);
    await expect(Math.abs(after.x - before.x - 120) < 2 && Math.abs(after.y - before.y - 60) < 2, `camera moved by ${after.x - before.x},${after.y - before.y}, expected 120,60`);
    await expect(mutations === 0, `${mutations} DOM mutation(s) during the drag`);
  });
  await step("Ctrl+wheel zooms at the cursor and the altitude flips with hysteresis", async () => {
    await page.evaluate(() => (window as unknown as { __proto: { fitAll: (a: boolean) => void } }).__proto.fitAll(false));
    const a0 = await altitude(page); const z0 = (await cam(page)).z;
    await expect(a0 === "yard", `after fit the altitude is ${a0} at ${z0}`);
    const board = (await page.locator("[data-board]").boundingBox())!;
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120).catch(() => undefined);
    await page.mouse.move(board.x + 400, board.y + 300);
    await page.keyboard.down("Control");
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(10); }
    await page.keyboard.up("Control");
    const z1 = (await cam(page)).z; const a1 = await altitude(page);
    await expect(z1 > z0 * 1.5, `zoom did not grow: ${z0} → ${z1}`);
    await expect(a1 === "block", `at ${z1} the altitude is ${a1}`);
    await expect((await page.evaluate(() => [...document.querySelectorAll(".cluster .node")].some((el) => getComputedStyle(el.parentElement!).visibility !== "hidden"))), "no node became visible at block altitude");
  });
  await step("a keycap glides onto its cluster and opens the inspector", async () => {
    await page.focus("[data-board]");
    await page.keyboard.press("2");
    await page.waitForTimeout(100);
    const sel = await page.evaluate(() => (window as unknown as { __proto: { S: { selected: string }; model: () => { clusters: { id: string; key?: number }[] } } }).__proto);
    void sel;
    const selected = await page.evaluate(() => (window as unknown as { __proto: { S: { selected: string } } }).__proto.S.selected);
    const keyed = await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: { id: string; key?: number; x: number; y: number; w: number; h: number }[] } } }).__proto.model().clusters.find((c) => c.key === 2));
    await expect(selected === keyed!.id, `selected ${selected}, keycap 2 is ${keyed!.id}`);
    await expect(Boolean(await page.$("[data-inspector]")), "the inspector did not open");
    const c = await cam(page); const cx = (keyed!.x + keyed!.w / 2) * c.z + c.x; const cy = (keyed!.y + keyed!.h / 2) * c.z + c.y;
    const b = (await page.locator("[data-board]").boundingBox())!;
    await expect(Math.abs(cx - b.width / 2) < 40 && Math.abs(cy - b.height / 2) < 40, `the camera centre is ${Math.round(cx)},${Math.round(cy)} of ${b.width}×${b.height}`);
  });
  await step("n / N walk what needs you across clusters and conversations", async () => {
    await page.focus("[data-board]");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    const q = await page.evaluate(() => (window as unknown as { __proto: { needsQueue: (p: string) => { kind: string; conv?: string; cluster: string }[]; S: { project: string } } }).__proto.needsQueue((window as unknown as { __proto: { S: { project: string } } }).__proto.S.project));
    await expect(q.length >= 3, `queue has ${q.length}`);
    const seen: string[] = [];
    for (let i = 0; i < q.length; i++) { await page.keyboard.press("n"); await page.waitForTimeout(60); seen.push(await page.evaluate(() => { const p = (window as unknown as { __proto: { S: { lift: string | null; selected: string | null } } }).__proto.S; return p.lift ? `conv:${p.lift}` : `cluster:${p.selected}`; })); }
    const want = q.map((x) => (x.kind === "conv" ? `conv:${x.conv}` : `cluster:${x.cluster}`));
    await expect(seen.join(" ") === want.join(" "), `n walked ${seen.join(" ")}, expected ${want.join(" ")}`);
    await page.keyboard.press("N"); await page.waitForTimeout(60);
    const back = await page.evaluate(() => { const p = (window as unknown as { __proto: { S: { lift: string | null; selected: string | null } } }).__proto.S; return p.lift ? `conv:${p.lift}` : `cluster:${p.selected}`; });
    await expect(back === want[want.length - 2], `N went to ${back}, expected ${want[want.length - 2]}`);
  });
  await step("Enter lifts the selected cluster's live node, the feed is readable, Esc lowers it", async () => {
    await goto("#/board");
    await page.focus("[data-board]");
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
    const lift = await page.$(".lift");
    await expect(Boolean(lift), "no lifted pane");
    const z = (await cam(page)).z;
    await expect(z >= 1, `the lift did not bring the camera to 100 % (z ${z})`);
    const box = (await lift!.boundingBox())!;
    await expect(box.width >= 600 && box.height >= 480, `the lifted pane is ${box.width}×${box.height}`);
    await expect((await page.evaluate(() => getComputedStyle(document.querySelector(".world.receded .cluster:not(.has-lift)")!).opacity)) !== "1", "the rest of the yard did not recede");
    const a = await active(page);
    await expect(a.includes("[opt0]") || a.includes("[lift]"), `focus after lift is ${a}`);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await expect(!(await page.$(".lift")), "Esc did not lower the lift");
    await expect((await active(page)).includes("<board>"), `after Esc the focus is ${await active(page)}`);
  });
  await step("a drag pins a cluster, the packer flows around it, Release restores the auto layout", async () => {
    await goto("#/board");
    const before = await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: { id: string; x: number; y: number }[] } } }).__proto.model().clusters.map((c) => [c.id, c.x, c.y]));
    const target = await page.evaluate(() => { const c = (window as unknown as { __proto: { model: () => { clusters: { id: string; kind: string; x: number; y: number; w: number }[] } } }).__proto.model().clusters.find((x) => x.kind === "pipeline")!; return c; });
    await page.evaluate((id) => (window as unknown as { __proto: { fitCluster: (id: string, a: boolean) => void } }).__proto.fitCluster(id, false), target.id);
    const head = await page.locator(`.cluster[data-cluster="${target.id}"] .cl-head`).boundingBox();
    await page.mouse.move(head!.x + head!.width / 2, head!.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(head!.x + head!.width / 2 + i * 12, head!.y + 20 + i * 30);
    await page.mouse.up();
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => (window as unknown as { __proto: { S: { pins: Record<string, { x: number; y: number }> }; model: () => { clusters: { id: string; x: number; y: number; w: number; h: number; pinned: boolean }[] } } }).__proto);
    const pins = await page.evaluate(() => Object.keys((window as unknown as { __proto: { S: { pins: Record<string, unknown> } } }).__proto.S.pins));
    void after;
    await expect(pins.includes(target.id), `the drag did not pin ${target.id} (pins: ${pins.join(",")})`);
    const clusters = await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: { id: string; x: number; y: number; w: number; h: number; pinned: boolean }[] } } }).__proto.model().clusters);
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const a = clusters[i], b = clusters[j]; await expect(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} and ${b.id} overlap after the pin`); }
    await expect(Boolean(await page.$(".receipt")), "no receipt after the pin");
    await expect(Boolean(await page.$(`.cluster[data-cluster="${target.id}"].pinned .pinmark`)), "no pin mark on the header");
    await page.click(".receipt .link");
    await page.waitForTimeout(80);
    const restored = await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: { id: string; x: number; y: number }[] } } }).__proto.model().clusters.map((c) => [c.id, c.x, c.y]));
    await expect(JSON.stringify(restored) === JSON.stringify(before), "Release did not restore the auto layout");
  });
  await step("the inspector's actions land with their inverse in the receipt", async () => {
    await goto("#/board", "select=p2");
    await expect(Boolean(await page.$('.inspector [data-focus="answer"]')), "a parked pipeline shows no answer field");
    await page.fill('.inspector [data-focus="answer"]', "Keep restored pipelines out of the sweep.");
    await page.click('[data-act="answer:p2"]');
    await page.waitForTimeout(60);
    const st = await page.evaluate(() => (window as unknown as { __proto: { F: { pipelines: { id: string; state: string; stage: string }[] } } }).__proto.F.pipelines.find((p) => p.id === "p2"));
    await expect(st!.state === "running" && st!.stage === "build", `after Answer the record is ${st!.state} at ${st!.stage}`);
    await expect((await page.textContent(".receipt"))!.includes("Undo"), "no Undo in the receipt");
    await page.click(".receipt .link");
    await page.waitForTimeout(60);
    const back = await page.evaluate(() => (window as unknown as { __proto: { F: { pipelines: { id: string; state: string }[] } } }).__proto.F.pipelines.find((p) => p.id === "p2"));
    await expect(back!.state === "needs_decision", `Undo left the record ${back!.state}`);
    await page.click('[data-act="pause:p2"]');
    await expect((await page.textContent(".receipt"))!.includes("Resume"), "Pause receipt carries no Resume");
    await page.click(".receipt .link");
    await page.click('[data-act="edit:p2:review"]');
    await expect(Boolean(await page.$("[data-editor]")), "edit stage opened no editor");
    await expect((await active(page)).includes("[prompt]"), `the editor did not take focus (${await active(page)})`);
    await page.click('[data-act="ed:effort:max"]');
    await page.click('[data-act^="save:p2:review"]');
    const eff = await page.evaluate(() => (window as unknown as { __proto: { F: { pipelines: { id: string; stages: { id: string; effort: string }[]; revision: number }[] } } }).__proto.F.pipelines.find((p) => p.id === "p2")!.stages.find((s) => s.id === "review")!.effort);
    await expect(eff === "max", `saved effort is ${eff}`);
    await expect((await page.textContent(".receipt"))!.includes("next attempt"), "the save receipt does not say when it applies");
    await page.click('[data-act="archive:p2"]');
    await expect(!(await page.$('.cluster[data-cluster="p2"]')), "the archived cluster is still on the yard");
    await page.click(".receipt .link");
    await expect(Boolean(await page.$('.cluster[data-cluster="p2"]')), "Restore did not bring the cluster back");
  });
  await step("the backlog tray assigns a worker and the new thread joins the yard", async () => {
    await goto("#/board", "tray=1");
    const n0 = (await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: unknown[] } } }).__proto.model().clusters.length));
    await page.click('[data-act="assign:t6"]');
    await page.waitForTimeout(60);
    const n1 = (await page.evaluate(() => (window as unknown as { __proto: { model: () => { clusters: unknown[] } } }).__proto.model().clusters.length));
    await expect(n1 === n0 + 1, `clusters ${n0} → ${n1}`);
    await expect(Boolean(await page.$('.cluster[data-cluster="t:t6"]')), "no thread cluster for the task");
    await page.click(".receipt .link");
    await expect(!(await page.$('.cluster[data-cluster="t:t6"]')), "Undo did not remove the thread");
  });
  await step("the chat's settings sheet is one level, every group visible, Esc returns focus to the chip", async () => {
    await goto("#/chat/c1");
    await page.click('[data-focus="chip"]');
    await page.waitForTimeout(60);
    await expect(Boolean(await page.$(".settings[data-dialog]")), "no settings sheet");
    const groups = await page.evaluate(() => [...document.querySelectorAll(".settings .seg, .settings .alist, .settings .sess")].length);
    await expect(groups >= 5, `only ${groups} groups visible (model, reasoning, speed, account, session)`);
    await expect(!(await page.$(".settings [aria-haspopup]")), "the sheet has a submenu");
    await expect(await activeInDialog(page), "the sheet did not take focus");
    await page.click('[data-act="set:c1:effort:xhigh"]');
    await page.waitForTimeout(40);
    await expect(Boolean(await page.$(".settings[data-dialog]")), "picking a value closed the sheet");
    await page.keyboard.press("Escape");
    await expect((await active(page)).includes("[chip]"), `focus after Esc is ${await active(page)}`);
    await expect((await page.textContent('[data-focus="chip"]'))!.includes("xhigh"), "the chip does not show the new reasoning");
  });
  await step("the send slot flips: Stop while working and empty, Send when typing, the message lands", async () => {
    await goto("#/chat/c1");
    await expect((await page.textContent('[data-focus="send"]'))!.trim() === "Stop", "the slot is not Stop on a working conversation");
    await page.focus('[data-focus="field"]');
    await page.keyboard.type("Also cover the CSV branch.");
    await expect((await page.textContent('[data-focus="send"]'))!.trim() === "Send", "typing did not flip the slot to Send");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(60);
    const last = await page.evaluate(() => [...document.querySelectorAll("[data-feed] .msg.user .bubble")].pop()?.textContent);
    await expect(last === "Also cover the CSV branch.", `the last user bubble is «${last}»`);
    await expect((await active(page)).includes("[field]"), `after send the focus is ${await active(page)}`);
  });
  await step("a question answers on click and the conversation goes back to work", async () => {
    await goto("#/chat/c2");
    await expect((await active(page)).includes("[opt0]"), `the first option did not take focus (${await active(page)})`);
    await page.click('[data-focus="opt1"]');
    await page.waitForTimeout(60);
    await expect(!(await page.$(".qcard")), "the question card is still open");
    await expect((await page.textContent(".chead"))!.includes("working"), "the header does not say working");
  });
  await step("every account row opens a detail with the chart and the pace line; Switch carries Switch back", async () => {
    await goto("#/accounts");
    const ids = await page.evaluate(() => [...document.querySelectorAll(".arow[data-account]")].map((el) => (el as HTMLElement).dataset.account!));
    await expect(ids.length === 5, `${ids.length} account rows`);
    const meters = await page.evaluate(() => document.querySelectorAll(".arow[data-account] .meter").length);
    await expect(meters === ids.length * 2, `${meters} meters for ${ids.length} rows`);
    for (const id of ids) {
      await page.click(`.arow[data-account="${id}"]`);
      await page.waitForTimeout(40);
      const signedIn = await page.evaluate(() => Boolean(document.querySelector(".acc-detail .chart")));
      const quiet = await page.evaluate(() => Boolean(document.querySelector(".acc-detail .quietline")));
      await expect(signedIn || quiet, `${id}: neither a chart nor the signed-out line`);
      if (signedIn) await expect((await page.textContent(".acc-detail .pace"))!.includes("an hour"), `${id}: no burn rate`);
    }
    await page.click('.arow[data-account="cl-lab"]');
    await page.click('[data-act="switch:claude:cl-lab"]');
    await expect((await page.textContent(".receipt"))!.includes("Switch back"), "no Switch back in the receipt");
    await page.click(".receipt .link");
    const active_ = await page.evaluate(() => (window as unknown as { __proto: { F: { accounts: { claude: { id: string; active: boolean }[] } } } }).__proto.F.accounts.claude.find((a) => a.active)!.id);
    await expect(active_ === "cl-main", `after Switch back the active account is ${active_}`);
  });
  await step("the field shows every project; a tile enters its yard on that cluster", async () => {
    await goto("#/overview");
    const regions = await page.evaluate(() => document.querySelectorAll(".region").length);
    await expect(regions >= 4, `${regions} regions`);
    await page.evaluate(() => (document.querySelector('.region .cluster[data-cluster="bp1"] .tile') as HTMLElement).click());
    await page.waitForTimeout(80);
    await expect((await hash(page)) === "#/board", `after the tile click the route is ${await hash(page)}`);
    await expect((await page.textContent(".bar-title .t"))!.includes("beacon"), "the yard is not beacon's");
    await expect(Boolean(await page.$("[data-inspector]")), "the cluster is not selected in its yard");
  });
  await step("a chat's Esc returns to the yard with the node lifted where it lives", async () => {
    await goto("#/chat/c1");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    await expect((await hash(page)) === "#/board", `Esc went to ${await hash(page)}`);
  });
  await step("the page logged no error", async () => { await expect(errors.length === 0, errors.join(" | ")); });
  await ctx.close();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = process.env.CHROME_BIN;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const manifest: { frame: string; scheme: string; screen: string; file: string }[] = [];
  try {
    for (const frame of FRAMES) {
      if (widths.length && !widths.includes(frame.name)) continue;
      for (const scheme of SCHEMES) {
        const ctx = await browser.newContext({ viewport: { width: frame.width, height: frame.height }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        for (const screen of SCREENS) {
          if (only.length && !only.includes(screen.id)) continue;
          if (screen.w && !screen.w.includes(frame.name)) continue;
          const label = `${frame.name}/${scheme}/${screen.id}`;
          try {
            await open(page, screen, scheme, frame.width);
            const g = await measure(page);
            gate(label, g, scheme, screen);
            await focusGates(page, label);
            await open(page, screen, scheme, frame.width);
            const dir = path.join(OUT_DIR, frame.name, scheme);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${screen.id}.png`);
            await page.screenshot({ path: file });
            manifest.push({ frame: frame.name, scheme, screen: screen.id, file: path.relative(HERE, file) });
            if (errors.length) throw new Error(`${label}: page error ${errors.splice(0).join(" | ")}`);
            console.log(`✓ ${label}`);
          } catch (e) { fail(e); }
        }
        await ctx.close();
      }
    }
    if (!only.length) { console.log("flows:"); await flows(browser); }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), frames: manifest }, null, 2));
  if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
  console.log(`\n${manifest.length} frames → ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
