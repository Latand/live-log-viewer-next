/**
 * Renders the mobile-v2 prototype's key screens to PNGs, locally, and runs
 * the headless gates that make each frame an acceptance check:
 *
 *   bun docs/design/mobile-v2/capture.ts
 *   MOBILE_V2_ONLY=board,chat-keyboard bun docs/design/mobile-v2/capture.ts
 *
 * Output lands in docs/design/mobile-v2/out/<frame>/<scheme>/<screen>.png,
 * which the directory's own .gitignore keeps out of the repository: a browser
 * render is not byte-deterministic, so it carries no privacy-manifest
 * provenance and the publication gate refuses committed rasters. The
 * orchestrator runs this to produce pictures for the operator.
 *
 * The pattern is scripts/capture-issue-979-mobile-orchestrator.ts: playwright
 * over the locally installed Chrome, one emulated phone context per colour
 * scheme and frame, and gates on every frame:
 *
 *   - the document never scrolls sideways (the #353 contract);
 *   - every visible control is at least 44 × 44 px (design-system rule 8);
 *   - no two visible controls' rects intersect, and a receipt never covers a
 *     control (critique round 1, P2-5 / P2-6);
 *   - the bar's title cell keeps ≥ 190 px at 390 (critique §5, the bar budget);
 *   - with the keyboard open, the composer's send control sits above the
 *     keyboard and the field sits below the bar (the #983 budget);
 *   - the scheme actually applied (the canvas colour differs between the two);
 *   - the bench never shows inside a phone-sized viewport (landscape included).
 *
 * After the matrix, a set of headless flows checks the navigation contract
 * (P1-1), the receipt anatomy (P2-6), the composer slot (P1-4), the answer
 * path (P2-7), the sign-in row (P2-8), the sheet drag and Next (P3-9), and the
 * vocabulary (P2-11). The prototype is static — no server, no build step —
 * so the page is opened from a file: URL; the screen list is the same
 * screens.js the page uses.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

interface Screen { id: string; hash: string; title: string; scenario?: string }

const HERE = import.meta.dir;
const OUT_DIR = path.join(HERE, "out");
const INDEX = path.join(HERE, "prototype", "index.html");
const require = createRequire(import.meta.url);
const SCREENS = require("./prototype/screens.js") as Screen[];

const FRAMES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;
/* P3-1: a landscape phone gets the shell, never the bench; the keyboard
   frame is not budgeted in landscape, so kb screens are skipped there. */
const LANDSCAPE = { name: "844x390", width: 844, height: 390 } as const;
const LANDSCAPE_SCREENS = ["board", "board-attention", "chat-working", "pipeline"];
const SCHEMES = ["dark", "light"] as const;
/* An iOS keyboard's share of a 390×844 phone (#983) — the prototype's `.kb`
   block reserves exactly this. */
const KEYBOARD_PX = 336;
const HIT_PX = 44;
const BAR_PX = 52;
const TITLE_MIN_PX = 190;
const CANVAS = { light: "rgb(243, 243, 246)", dark: "rgb(16, 16, 20)" } as const;
/* P2-11: one phrase per state, the product's words, no instructions in the UI. */
const BANNED_WORDS = ["Waiting on you", "waiting for your answer", "Agent is waiting", "live tail", "polling stands by", "REQUEST_CHANGES", "confirm", "Swipe the title bar", "Working dir"];

const only = (process.env.MOBILE_V2_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface Rect { x: number; y: number; w: number; h: number }
interface Control { tag: string; label: string; rect: Rect }
interface Geometry {
  scrollWidth: number;
  innerWidth: number;
  canvas: string;
  benchShown: boolean;
  controls: Control[];
  title: { w: number } | null;
  send: { bottom: number } | null;
  field: { top: number } | null;
  toast: Rect | null;
  scrollY: number;
}

function urlFor(screen: Screen, scheme: string): string {
  return `${pathToFileURL(INDEX).href}?scheme=${scheme}${screen.scenario ? `&scenario=${screen.scenario}` : ""}${screen.hash}`;
}

/* Every visible control with its rect clipped to its scroll ancestors and to
   the phone, so a row scrolled under the dock is not counted as overlapping
   it. With a sheet open only the sheet's controls count: the scrim covers
   everything else. */
async function measure(page: Page): Promise<Geometry> {
  return page.evaluate((hit) => {
    const phone = document.getElementById("phone")!;
    const clip = (el: Element) => {
      let r = el.getBoundingClientRect();
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
    const sheet = phone.querySelector(".sheet");
    const scope = sheet ?? phone;
    const controls: { tag: string; label: string; rect: { x: number; y: number; w: number; h: number }; full: { w: number; h: number } }[] = [];
    for (const el of scope.querySelectorAll('button, a[href], [role="button"], select')) {
      if (!visible(el)) continue;
      const c = clip(el);
      if (c.w <= 0 || c.h <= 0) continue;
      controls.push({ tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), rect: { x: c.x, y: c.y, w: c.w, h: c.h }, full: c.full });
    }
    const sendEl = [...phone.querySelectorAll(".box .send")].find(visible);
    const field = phone.querySelector(".box textarea");
    const title = phone.querySelector(".bar .title");
    const toastEl = phone.querySelector(".toast");
    const tr = toastEl ? toastEl.getBoundingClientRect() : null;
    const bench = document.getElementById("bench");
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      canvas: getComputedStyle(phone).backgroundColor,
      benchShown: Boolean(bench && getComputedStyle(bench).display !== "none"),
      controls: controls.map((c) => ({ tag: c.tag, label: c.label, rect: c.rect, small: c.full.w < hit - 0.5 || c.full.h < hit - 0.5 })) as never,
      title: title ? { w: Math.round(title.getBoundingClientRect().width) } : null,
      send: sendEl ? { bottom: Math.round(sendEl.getBoundingClientRect().bottom) } : null,
      field: field ? { top: Math.round(field.getBoundingClientRect().top) } : null,
      toast: tr ? { x: tr.left, y: tr.top, w: tr.width, h: tr.height } : null,
      scrollY: Math.round(window.scrollY),
    };
  }, HIT_PX);
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const fmt = (c: Control) => `${c.tag} «${c.label}» ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}@${Math.round(c.rect.x)},${Math.round(c.rect.y)}`;

function gate(label: string, g: Geometry, opts: { scheme: "dark" | "light"; keyboard: boolean; height: number; width: number; landscape?: boolean }): void {
  if (g.scrollWidth > g.innerWidth) throw new Error(`${label}: the document scrolls to ${g.scrollWidth}px at ${g.innerWidth}px`);
  if (g.benchShown) throw new Error(`${label}: the bench renders inside a ${opts.width}×${opts.height} viewport`);
  const small = g.controls.filter((c) => (c as Control & { small: boolean }).small);
  if (small.length) throw new Error(`${label}: ${small.length} control(s) under the ${HIT_PX}px floor — ${small.slice(0, 6).map(fmt).join("; ")}`);
  for (let i = 0; i < g.controls.length; i++) {
    for (let j = i + 1; j < g.controls.length; j++) {
      if (intersects(g.controls[i].rect, g.controls[j].rect)) throw new Error(`${label}: two controls overlap — ${fmt(g.controls[i])} and ${fmt(g.controls[j])}`);
    }
  }
  if (g.toast) {
    const hit = g.controls.find((c) => !c.label.match(/^(Respawn|Reopen|Restore|Retry stage|Switch back)$/) && intersects(g.toast!, c.rect));
    if (hit) throw new Error(`${label}: the receipt covers ${fmt(hit)}`);
  }
  if (g.canvas !== CANVAS[opts.scheme]) throw new Error(`${label}: canvas is ${g.canvas}, expected the ${opts.scheme} scheme's ${CANVAS[opts.scheme]}`);
  if (g.title && !opts.landscape && g.title.w < TITLE_MIN_PX) throw new Error(`${label}: the bar's title cell is ${g.title.w}px, under the ${TITLE_MIN_PX}px budget`);
  if (opts.keyboard) {
    const visibleBottom = opts.height - KEYBOARD_PX;
    if (!g.send || !g.field) throw new Error(`${label}: the keyboard frame has no composer to measure`);
    if (g.send.bottom > visibleBottom) throw new Error(`${label}: with the keyboard open the send control ends at ${g.send.bottom}px, under the keyboard at ${visibleBottom}px`);
    if (g.field.top < BAR_PX) throw new Error(`${label}: the composer field starts at ${g.field.top}px, above the ${BAR_PX}px bar`);
    if (g.scrollY !== 0) throw new Error(`${label}: the window scrolled to ${g.scrollY}px to reach the field`);
  }
}

async function open(page: Page, screen: Screen, scheme: string): Promise<void> {
  const url = urlFor(screen, scheme);
  const sameDocument = page.url().split("#")[0] === url.split("#")[0];
  await page.goto(url, { waitUntil: "load" });
  /* A hash-only goto is a same-document navigation; reload so every screen
     and every flow starts from the untouched fixture. */
  if (sameDocument) await page.reload({ waitUntil: "load" });
  await page.waitForSelector('#phone[data-ready="1"]', { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const hasSheet = (page: Page) => page.evaluate(() => Boolean(document.querySelector("#phone .scrim")));
async function expect(cond: boolean, msg: string): Promise<void> { if (!cond) throw new Error(`flow: ${msg}`); }

/* A synthetic horizontal swipe on the bar (the gesture the prototype binds). */
async function swipeBar(page: Page, dir: "left" | "right"): Promise<void> {
  await page.evaluate((d) => {
    const bar = document.querySelector("#phone .bar")!;
    const r = bar.getBoundingClientRect();
    const x0 = d === "left" ? r.right - 20 : r.left + 20;
    const x1 = d === "left" ? r.left + 20 : r.right - 20;
    const y = r.top + r.height / 2;
    const touch = (x: number) => new Touch({ identifier: 1, target: bar, clientX: x, clientY: y });
    bar.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(x0)], changedTouches: [touch(x0)], bubbles: true }));
    bar.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(x1)], bubbles: true }));
  }, dir);
  await page.waitForTimeout(30);
}

async function flows(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const at = (h: string, scenario?: string) => open(page, { id: "flow", hash: h, title: "", scenario }, "dark");
  try {
    /* P1-1: pipeline → stage conversation → ‹ returns to the pipeline. */
    await at("#/pipeline/p1");
    await page.click('#phone .stg[data-go="#/chat/c1"]');
    await expect((await hash(page)) === "#/chat/c1", "stage row did not open its conversation");
    await page.click('#phone .bar [data-act="back"]');
    await page.waitForTimeout(60);
    await expect((await hash(page)) === "#/pipeline/p1", `‹ from a stage conversation landed on ${await hash(page)}, not the pipeline`);
    /* P1-1: board → ⋯ → Accounts → browser back ends on the board, no sheet. */
    await at("#/board");
    await page.click('#phone .bar [data-go="#/board/menu"]');
    await page.click('#phone .sheet [data-go="#/accounts"]');
    await expect((await hash(page)) === "#/accounts", "menu row did not open Accounts");
    await page.goBack();
    await page.waitForTimeout(60);
    await expect((await hash(page)) === "#/board" && !(await hasSheet(page)), `browser back from Accounts landed on ${await hash(page)} with sheet=${await hasSheet(page)}`);
    /* P1-1: ⋯ on Pipelines opens over Pipelines and closes back onto it. */
    await at("#/pipelines");
    await page.click('#phone .bar [data-go="#/pipelines/menu"]');
    await expect(await hasSheet(page), "⋯ on Pipelines opened no sheet");
    await page.click('#phone .sheet .shead [data-go="#/pipelines"]');
    await expect((await hash(page)) === "#/pipelines" && !(await hasSheet(page)), "closing the menu did not return to Pipelines");
    /* P1-1: ⚠ from a conversation → close returns to it with its scroll. */
    await at("#/chat/c1");
    await page.evaluate(() => { const f = document.querySelector("#phone .feed")!; f.scrollTop = 40; });
    await page.click('#phone .bar .attn');
    await expect(await hasSheet(page), "⚠ opened no sheet");
    await page.click('#phone .sheet .shead [data-go="#/chat/c1"]');
    const st = await page.evaluate(() => (document.querySelector("#phone .feed") as HTMLElement).scrollTop);
    await expect((await hash(page)) === "#/chat/c1" && st === 40, `closing ⚠ landed on ${await hash(page)} at scrollTop ${st}`);
    /* P1-1: the swipe walks the switcher's order minus Recent and bumps at the end. */
    await at("#/chat/orch/switch");
    const order = await page.evaluate(() => [...document.querySelectorAll('#phone .sheet .mrow[data-go^="#/chat/"]')].filter((r) => (r as HTMLElement).dataset.section !== "recent").map((r) => (r as HTMLElement).dataset.go));
    await at("#/chat/orch");
    const walked = [await hash(page)];
    for (let i = 0; i < order.length + 2; i++) { await swipeBar(page, "left"); const h = await hash(page); if (h === walked[walked.length - 1]) break; walked.push(h); }
    await expect(JSON.stringify(walked) === JSON.stringify(order), `swipe walked ${walked.join(" → ")} but the switcher lists ${order.join(" → ")}`);
    const bumped = await page.evaluate(() => document.querySelector("#phone .bar .title")!.classList.contains("bump-r"));
    await expect(bumped, "the last swipe did not bump");
    /* P3-9: Next from the first queue item lands on the second. */
    await at("#/chat/c2");
    await page.click('#phone .bar .attn');
    await page.click('#phone .sheet [data-act="next"]');
    await expect((await hash(page)) === "#/chat/c6", `Next from the first queue item went to ${await hash(page)}`);
    /* P1-2: Next reaches the pipeline decision, and the badge counts it. */
    await at("#/chat/c6");
    await page.click('#phone .bar .attn');
    await page.click('#phone .sheet [data-act="next"]');
    await expect((await hash(page)) === "#/pipeline/p2", `Next past the last conversation went to ${await hash(page)}, not the pipeline`);
    await at("#/board");
    const badge = await page.evaluate(() => document.querySelector("#phone .bar .attn span")!.textContent!.trim());
    await expect(badge === "3", `the badge reads ${badge}, expected 3 (two conversations, one pipeline)`);
    const needRows = await page.evaluate(() => document.querySelectorAll('#phone .row.wait[data-go^="#/pipeline/"]').length);
    await expect(needRows === 1, "the pipeline decision is not a Needs you row");
    /* P3-9: a sheet closes on an 80 px downward drag of its handle. */
    await at("#/board/menu");
    await page.evaluate(() => {
      const grab = document.querySelector("#phone .sheet .grab")!;
      const r = grab.getBoundingClientRect();
      const touch = (y: number) => new Touch({ identifier: 1, target: grab, clientX: r.left + 10, clientY: y });
      grab.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(r.top)], changedTouches: [touch(r.top)], bubbles: true }));
      grab.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(r.top + 120)], changedTouches: [touch(r.top + 120)], bubbles: true }));
      grab.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(r.top + 120)], bubbles: true }));
    });
    await page.waitForTimeout(30);
    await expect(!(await hasSheet(page)) && (await hash(page)) === "#/board", "an 80 px drag did not close the sheet");
    /* P1-4: Stop sits in the send slot while working; typing flips it to send. */
    await at("#/chat/c1");
    const stopShown = await page.evaluate(() => { const s = document.querySelector("#phone .box .send.stop") as HTMLElement | null; return Boolean(s && s.offsetParent !== null); });
    await expect(stopShown, "a working conversation does not show Stop in the send slot");
    await page.type("#phone .box textarea", "keep going");
    const flipped = await page.evaluate(() => { const s = document.querySelector("#phone .box .send.stop") as HTMLElement | null; const b = document.querySelector("#phone .box .sendbtn") as HTMLElement | null; return Boolean(s && s.offsetParent === null && b && b.offsetParent !== null && !b.classList.contains("off")); });
    await expect(flipped, "typing did not flip Stop into Send");
    await expect(!(await page.evaluate(() => Boolean(document.querySelector("#phone .status")))), "a status row is still rendered");
    /* P2-6: Kill's receipt carries Respawn, covers no control, and Respawn works. */
    await at("#/chat/c1/menu");
    await page.click('#phone .sheet [data-act="kill:c1"]');
    await page.waitForTimeout(30);
    const g = await measure(page);
    await expect(Boolean(g.toast), "Kill produced no receipt");
    gate("flow/kill-receipt", g, { scheme: "dark", keyboard: false, height: 844, width: 390 });
    await page.click('#phone .toast [data-act="undo"]');
    const respawned = await page.evaluate(() => !document.querySelector('#phone .box .send[data-act^="respawn"]'));
    await expect(respawned, "Respawn from the receipt did not restore the conversation");
    /* P2-7: a chip sends, the reply is the user's bubble, the question folds. */
    await at("#/chat/c2");
    await page.click('#phone .chips button');
    const answered = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll("#phone .mu .bubble")].map((b) => b.textContent);
      return { bubble: bubbles[bubbles.length - 1], folded: Boolean(document.querySelector("#phone .qf")), card: Boolean(document.querySelector("#phone .q:not(.quiet)")) };
    });
    await expect(answered.bubble === "NDJSON" && answered.folded && !answered.card, `chip tap gave ${JSON.stringify(answered)}`);
    await page.click('#phone .qf .tb');
    await expect(await page.evaluate(() => document.querySelectorAll("#phone .q.quiet .opt").length === 3), "the folded question did not expand to its options");
    /* P2-8: a needs-sign-in row does not become active. */
    await at("#/accounts");
    await page.click('#phone [data-act="signIn:claude:cl-second"]');
    const acct = await page.evaluate(() => ({ toast: document.querySelector("#phone .toast")?.textContent ?? "", activeFirst: document.querySelector("#phone .acct:not(.off) .t")!.textContent!.includes("Main") }));
    await expect(acct.toast.includes("sign-in") && acct.activeFirst, `sign-in row gave ${JSON.stringify(acct)}`);
    /* P1-3: the states render with their words. */
    await at("#/board", "noseat");
    await expect(await page.evaluate(() => document.querySelector("#phone .seat .create") !== null && !document.querySelector("#phone .seat .meter")), "no-seat card still shows seat detail");
    await at("#/chat/c1", "offline");
    const off = await page.evaluate(() => ({ banner: document.querySelector("#phone .banner.info b")?.textContent ?? "", meta: document.querySelector("#phone .bar .sub")?.textContent ?? "", slot: document.querySelector("#phone .box .send")?.textContent?.trim() ?? "" }));
    await expect(off.banner.startsWith("Offline") && off.meta.includes("offline") && off.slot === "Queue", `offline renders ${JSON.stringify(off)}`);
    await at("#/chat/c1", "arrival");
    await expect(await page.evaluate(() => Boolean(document.querySelector("#phone .banner:not(.info)"))), "an arrival shows no banner over the conversation");
    await at("#/board", "arrival");
    await expect(await page.evaluate(() => !document.querySelector("#phone .banner")), "the board shows an arrival banner");
    await expect(errors.length === 0, `console errors: ${errors.join(" | ")}`);
    console.log("flows: navigation, receipts, composer slot, answer path, sign-in, states — green");
  } finally {
    await context.close();
  }
}

function vocabulary(): void {
  const dir = path.join(HERE, "prototype");
  for (const file of fs.readdirSync(dir)) {
    /* Comments explain the rules; the check is about what the phone says. */
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
  if (!screens.length) throw new Error(`MOBILE_V2_ONLY matched no screen (known: ${SCREENS.map((s) => s.id).join(", ")})`);
  const manifest: { frame: string; scheme: string; id: string; title: string; file: string }[] = [];
  try {
    const frames: { name: string; width: number; height: number; landscape?: boolean; schemes: readonly ("dark" | "light")[]; screens: Screen[] }[] = [
      ...FRAMES.map((f) => ({ ...f, schemes: SCHEMES, screens })),
      { ...LANDSCAPE, landscape: true, schemes: ["dark"], screens: screens.filter((s) => LANDSCAPE_SCREENS.includes(s.id)) },
    ];
    for (const frame of frames) {
      for (const scheme of frame.schemes) {
        const context = await browser.newContext({
          viewport: { width: frame.width, height: frame.height },
          colorScheme: scheme,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        const dir = path.join(OUT_DIR, frame.name, scheme);
        fs.mkdirSync(dir, { recursive: true });
        for (const screen of frame.screens) {
          const label = `${screen.id}/${frame.name}/${scheme}`;
          await open(page, screen, scheme);
          const geometry = await measure(page);
          gate(label, geometry, { scheme, keyboard: screen.hash.endsWith("/kb"), height: frame.height, width: frame.width, landscape: frame.landscape });
          if (errors.length) throw new Error(`${label}: console error — ${errors.join(" | ")}`);
          const file = path.join(dir, `${screen.id}.png`);
          await page.screenshot({ path: file, animations: "disabled" });
          manifest.push({ frame: frame.name, scheme, id: screen.id, title: screen.title, file: path.relative(HERE, file) });
          console.log(`${path.relative(HERE, file)}  → ${screen.title}`);
        }
        await context.close();
      }
    }
    if (!only.length) await flows(browser);
    fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), frames: manifest }, null, 2) + "\n");
    console.log(`\n${manifest.length} frames → ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
