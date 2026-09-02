/**
 * Renders the mobile-v2 prototype's key screens to PNGs, locally:
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
 * scheme and frame, and geometry gates on every frame, so each frame doubles as an
 * acceptance check:
 *
 *   - the document never scrolls sideways (the #353 contract);
 *   - every visible control is at least 44 × 44 px (design-system rule 8);
 *   - with the keyboard open, the composer's send control sits above the
 *     keyboard and the field sits below the bar (the #983 budget);
 *   - the scheme actually applied (the canvas colour differs between the two).
 *
 * The prototype is static — no server, no build step — so the page is opened
 * from a file: URL; the screen list is the same screens.js the page uses.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Page } from "playwright-core";

interface Screen { id: string; hash: string; title: string }

const HERE = import.meta.dir;
const OUT_DIR = path.join(HERE, "out");
const INDEX = path.join(HERE, "prototype", "index.html");
const require = createRequire(import.meta.url);
const SCREENS = require("./prototype/screens.js") as Screen[];

const FRAMES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;
const SCHEMES = ["dark", "light"] as const;
/* An iOS keyboard's share of a 390×844 phone (#983) — the prototype's `.kb`
   block reserves exactly this. */
const KEYBOARD_PX = 336;
const HIT_PX = 44;
const BAR_PX = 52;
const CANVAS = { light: "rgb(243, 243, 246)", dark: "rgb(16, 16, 20)" } as const;

const only = (process.env.MOBILE_V2_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface Geometry {
  scrollWidth: number;
  innerWidth: number;
  canvas: string;
  small: { tag: string; label: string; w: number; h: number }[];
  send: { bottom: number } | null;
  field: { top: number } | null;
  scrollY: number;
}

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate((hit) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const small: Geometry["small"] = [];
    for (const el of document.querySelectorAll('#phone button, #phone a[href], #phone [role="button"], #phone select')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < hit - 0.5 || r.width < hit - 0.5) {
        small.push({ tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    const send = document.querySelector("#phone .box .send");
    const field = document.querySelector("#phone .box textarea");
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      canvas: getComputedStyle(document.getElementById("phone")!).backgroundColor,
      small,
      send: send ? { bottom: Math.round(send.getBoundingClientRect().bottom) } : null,
      field: field ? { top: Math.round(field.getBoundingClientRect().top) } : null,
      scrollY: Math.round(window.scrollY),
    };
  }, HIT_PX);
}

function gate(label: string, g: Geometry, opts: { scheme: "dark" | "light"; keyboard: boolean; height: number }): void {
  if (g.scrollWidth > g.innerWidth) throw new Error(`${label}: the document scrolls to ${g.scrollWidth}px at ${g.innerWidth}px`);
  if (g.small.length) {
    const list = g.small.slice(0, 6).map((s) => `${s.tag} «${s.label}» ${s.w}×${s.h}`).join("; ");
    throw new Error(`${label}: ${g.small.length} control(s) under the ${HIT_PX}px floor — ${list}`);
  }
  if (g.canvas !== CANVAS[opts.scheme]) throw new Error(`${label}: canvas is ${g.canvas}, expected the ${opts.scheme} scheme's ${CANVAS[opts.scheme]}`);
  if (opts.keyboard) {
    const visibleBottom = opts.height - KEYBOARD_PX;
    if (!g.send || !g.field) throw new Error(`${label}: the keyboard frame has no composer to measure`);
    if (g.send.bottom > visibleBottom) throw new Error(`${label}: with the keyboard open the send control ends at ${g.send.bottom}px, under the keyboard at ${visibleBottom}px`);
    if (g.field.top < BAR_PX) throw new Error(`${label}: the composer field starts at ${g.field.top}px, above the ${BAR_PX}px bar`);
    if (g.scrollY !== 0) throw new Error(`${label}: the window scrolled to ${g.scrollY}px to reach the field`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(INDEX)) throw new Error(`prototype entry not found: ${INDEX}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const screens = only.length ? SCREENS.filter((s) => only.includes(s.id)) : SCREENS;
  if (!screens.length) throw new Error(`MOBILE_V2_ONLY matched no screen (known: ${SCREENS.map((s) => s.id).join(", ")})`);
  const manifest: { frame: string; scheme: string; id: string; title: string; file: string }[] = [];
  try {
    for (const frame of FRAMES) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({
          viewport: { width: frame.width, height: frame.height },
          colorScheme: scheme,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const dir = path.join(OUT_DIR, frame.name, scheme);
        fs.mkdirSync(dir, { recursive: true });
        for (const screen of screens) {
          const label = `${screen.id}/${frame.name}/${scheme}`;
          const url = `${pathToFileURL(INDEX).href}?scheme=${scheme}${screen.hash}`;
          await page.goto(url, { waitUntil: "load" });
          await page.waitForSelector('#phone[data-ready="1"]', { timeout: 10_000 });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(120);
          const geometry = await measure(page);
          gate(label, geometry, { scheme, keyboard: screen.hash.endsWith("/kb"), height: frame.height });
          const file = path.join(dir, `${screen.id}.png`);
          await page.screenshot({ path: file, animations: "disabled" });
          manifest.push({ frame: frame.name, scheme, id: screen.id, title: screen.title, file: path.relative(HERE, file) });
          console.log(`${path.relative(HERE, file)}  → ${screen.title}`);
        }
        await context.close();
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), frames: manifest }, null, 2) + "\n");
    console.log(`\n${manifest.length} frames → ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
