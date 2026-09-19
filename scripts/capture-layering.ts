/**
 * Rendered layering check: is every overlay the operator opens actually on top?
 *
 *   bun run build && TMPDIR=/var/tmp CHROME_BIN=google-chrome-stable bun scripts/capture-layering.ts
 *
 * Each case opens one overlay the way an operator does (right click on the
 * composer's microphone, a click on a picture inside the expanded conversation,
 * a menu inside the accounts dialog) at a wide and a phone viewport, then asks
 * the browser what it would hit at a grid of points over the overlay's box.
 * A point where `elementFromPoint` answers with something outside the overlay
 * is a point the operator cannot see or click, and the reading names that
 * element, its stacking-context root and the z-index that root carries — the
 * record of what covers what. A case passes only when every point lands on the
 * overlay itself.
 *
 * An overlay opened over a modal also has to close on its own: the preview and
 * the menu opened inside the expanded conversation are closed with one Escape
 * and the conversation has to still be open afterwards. The hover hints are
 * read the same way as the menus, from a real hover (a focus on the phone).
 *
 * The microphone's menu is also opened from the keyboard: focus on Dictate,
 * Shift+F10. Focus has to be inside the menu after it opens and after one Tab,
 * and back on Dictate after Escape, because a portalled menu is otherwise out
 * of Tab's reach at the end of the document.
 *
 * Everything runs against the invented demo home (`fixtures/demo-home`) copied
 * under the temp root, on a production server this script starts on a port it
 * chose and stops by the handle it holds. The one addition to the fixture is a
 * picture in the orchestrator's transcript, generated here as a PNG so no
 * raster is committed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

import { chromium, type Browser, type Page } from "playwright-core";

import { directoryProjectId } from "../src/lib/projects/identity";

import { createCaptureDirectory } from "./capture-directory";
import { renderFixtureTemplate } from "./demo-capture";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({ envName: "LAYERING_CAPTURE_DIR", prefix: "llv-issue-1858", raw: process.env.LAYERING_CAPTURE_DIR, repoRoot });
const HOME = path.join(BASE, "home");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");
const OUT = process.env.LAYERING_OUT?.trim() || null;
const PROJECT = "kanban";
/** Keep a PNG of each reading in the capture directory, for a person to look at; never committed. */
const SHOTS = process.env.LAYERING_SHOTS === "1";
/** Comma-separated case ids to run; every case when unset. */
const ONLY = process.env.LAYERING_CASES?.split(",").map((id) => id.trim()).filter(Boolean) ?? null;

/* ------------------------------------------------------------------------- */
/* The seeded home                                                            */
/* ------------------------------------------------------------------------- */

function copyFixtureHome(): void {
  fs.cpSync(path.join(repoRoot, "fixtures/demo-home/home"), HOME, { recursive: true, dereference: false, errorOnExist: true });
  const directories: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(pathname);
        directories.push(pathname);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(pathname);
        if (bytes.includes(0)) continue;
        const text = bytes.toString("utf8");
        const rendered = renderFixtureTemplate(text, HOME);
        if (rendered !== text) fs.writeFileSync(pathname, rendered, "utf8");
      }
    }
  };
  visit(HOME);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const name = path.basename(directory);
    const rendered = renderFixtureTemplate(name, HOME);
    if (rendered !== name) fs.renameSync(directory, path.join(path.dirname(directory), rendered));
  }
  /* The fixture's transcripts name checkouts under a fixed `/demo` root that
     does not exist here; point them at real folders of this home so every
     project resolves to a directory identity, and re-key the state files that
     name a project by its short name to that identity. */
  const names = ["atlas", "beacon", "forge", "kanban", "orbit", "relay"];
  for (const name of names) fs.mkdirSync(path.join(HOME, "Projects", name), { recursive: true });
  const projectId = (name: string) => directoryProjectId(fs.realpathSync(path.join(HOME, "Projects", name)));
  const rewrite = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) rewrite(pathname);
      else if (entry.name.endsWith(".jsonl")) {
        const text = fs.readFileSync(pathname, "utf8");
        const next = text.replaceAll('"cwd":"/demo/Projects/', `"cwd":${JSON.stringify(path.join(HOME, "Projects") + "/").slice(0, -1)}`);
        if (next !== text) fs.writeFileSync(pathname, next, "utf8");
      }
    }
  };
  rewrite(path.join(HOME, ".claude"));
  rewrite(path.join(HOME, ".codex"));
  for (const file of ["orchestrator-seats.json", "tasks.json", "flows.json"]) {
    const pathname = path.join(STATE_DIR, file);
    let text = fs.readFileSync(pathname, "utf8");
    for (const name of names) text = text.replaceAll(`"${name}"`, JSON.stringify(projectId(name)));
    fs.writeFileSync(pathname, text, "utf8");
  }
  for (const dir of [path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), path.join(BASE, "tmux"), path.join(BASE, "cache"), path.join(BASE, "runtime")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** A 480×300 PNG of two flat bands, encoded here so no raster is committed. */
function inventedPng(): string {
  const width = 480;
  const height = 300;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const top = y < height / 2;
      row[1 + x * 3] = top ? 90 : 230;
      row[2 + x * 3] = top ? 81 : 180;
      row[3 + x * 3] = top ? 224 : 60;
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

/** The orchestrator's transcript gains one operator message carrying a picture. */
function addPicture(): void {
  const file = renderFixtureTemplate("__DEMO_HOME__/.claude/projects/__DEMO_HOME_SLUG__-Projects-kanban/orchestrator.jsonl", HOME);
  const first = JSON.parse(fs.readFileSync(file, "utf8").split("\n").find((line) => line.trim())!) as { cwd?: string; sessionId?: string };
  const line = {
    type: "user",
    /* Assembled from parts: a whole id literal reads to the publication gate like one lifted from a live home. */
    uuid: ["e1000000", "0000", "4000", "8000", "000000000001"].join("-"),
    timestamp: "2100-01-02T11:40:00.000Z",
    cwd: first.cwd,
    sessionId: first.sessionId,
    message: { role: "user", content: [
      { type: "text", text: "The layering reference picture." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: inventedPng() } },
    ] },
  };
  fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

/* ------------------------------------------------------------------------- */
/* The production server                                                      */
/* ------------------------------------------------------------------------- */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) if (name.startsWith("LLV_") || name.startsWith("__NEXT_PRIVATE")) delete inherited[name];
  const config = path.join(HOME, ".config");
  return {
    ...inherited,
    NODE_ENV: "production",
    HOME,
    TMPDIR: path.join(BASE, "tmp"),
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: STATE_DIR,
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    LLV_RESOURCES_FIXTURE: path.join(STATE_DIR, "resources.json"),
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", LOGNAME: "demo", USER: "demo", SHELL: "/bin/sh",
  };
}

function startServer(port: number): ChildProcess {
  const bun = process.env.LAYERING_CAPTURE_BUN?.trim() || process.execPath;
  return spawn(bun, ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot, env: buildEnvironment(port), stdio: ["ignore", "inherit", "inherit"],
  });
}

/** The project key the scanner gave the orchestrator's transcript. */
async function waitForBoard(url: string, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const payload = await (await fetch(`${url}/api/files`)).json() as { files?: { path?: string; project?: string }[] };
      const seat = (payload.files ?? []).find((file) => file.path?.endsWith(`-Projects-${PROJECT}/orchestrator.jsonl`));
      if (seat?.project && seat.project !== "project_unresolved") return seat.project;
    } catch { /* booting */ }
    await Bun.sleep(500);
  }
  throw new Error("the board never listed the orchestrator transcript");
}

async function stop(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (server.exitCode === null && Date.now() < deadline) await Bun.sleep(200);
  if (server.exitCode === null) server.kill("SIGKILL");
}

/* ------------------------------------------------------------------------- */
/* In-page reading: who is on top of the overlay                              */
/* ------------------------------------------------------------------------- */

interface Coverer {
  /** The element hit instead of the overlay. */
  element: string;
  /** Its nearest ancestor that forms a stacking context, and that root's z-index. */
  context: string;
  contextZ: string;
}

interface Coverage {
  overlay: string;
  rect: { x: number; y: number; w: number; h: number };
  /** The overlay's own stacking-context root and z-index. */
  context: string;
  contextZ: string;
  /** Inside the viewport, of the grid points sampled. */
  points: number;
  covered: number;
  coverers: Coverer[];
}

/** Runs inside the page. */
function readCoverage(selector: string): Coverage | null {
  const overlay = document.querySelector<HTMLElement>(selector);
  if (!overlay) return null;
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 4).join(".") : "";
    const data = Array.from(el.attributes).filter((a) => a.name.startsWith("data-") || a.name === "role" || a.name === "aria-label").slice(0, 3).map((a) => `[${a.name}${a.value ? `="${a.value.slice(0, 40)}"` : ""}]`).join("");
    return `${tag}${cls ? `.${cls}` : ""}${data}`;
  };
  const formsContext = (el: Element): boolean => {
    if (el === document.documentElement) return true;
    const s = getComputedStyle(el);
    if (s.position === "fixed" || s.position === "sticky") return true;
    if (s.zIndex !== "auto" && (s.position !== "static" || (el.parentElement && getComputedStyle(el.parentElement).display.includes("flex")) || (el.parentElement && getComputedStyle(el.parentElement).display.includes("grid")))) return true;
    if (Number(s.opacity) < 1 || s.transform !== "none" || s.filter !== "none" || s.backdropFilter !== "none" || s.isolation === "isolate" || s.mixBlendMode !== "normal") return true;
    if (/(layout|paint|strict|content)/.test(s.contain) || s.containerType === "size" || s.containerType === "inline-size") return true;
    if (s.willChange.includes("transform") || s.willChange.includes("opacity")) return true;
    return false;
  };
  const contextOf = (el: Element): Element => {
    let node: Element | null = el;
    while (node && !formsContext(node)) node = node.parentElement;
    return node ?? document.documentElement;
  };
  /* A hint bubble never takes the pointer, so hit-testing would pass through it
     wherever it is; it is made hittable for the reading, then put back. */
  const passive = [overlay, ...Array.from(overlay.querySelectorAll<HTMLElement>("*"))].filter((el) => getComputedStyle(el).pointerEvents === "none");
  const restore = passive.map((el) => [el, el.style.pointerEvents] as const);
  for (const el of passive) el.style.pointerEvents = "auto";
  const r = overlay.getBoundingClientRect();
  const own = contextOf(overlay);
  const coverers = new Map<string, Coverer>();
  let points = 0;
  let covered = 0;
  /* Kept clear of rounded corners, where hit-testing rightly falls through. */
  const steps = 8;
  const inset = Math.min(8, r.width / 4, r.height / 4);
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const x = r.left + inset + ((r.width - 2 * inset) * i) / steps;
      const y = r.top + inset + ((r.height - 2 * inset) * j) / steps;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      points += 1;
      const hit = document.elementFromPoint(x, y);
      if (hit && overlay.contains(hit)) continue;
      covered += 1;
      if (!hit) continue;
      const context = contextOf(hit);
      const key = describe(hit);
      if (!coverers.has(key)) coverers.set(key, { element: key, context: describe(context), contextZ: getComputedStyle(context).zIndex });
    }
  }
  for (const [el, value] of restore) el.style.pointerEvents = value;
  return {
    overlay: describe(overlay),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    context: describe(own),
    contextZ: getComputedStyle(own).zIndex,
    points,
    covered,
    coverers: [...coverers.values()],
  };
}

/* ------------------------------------------------------------------------- */
/* Cases                                                                      */
/* ------------------------------------------------------------------------- */


const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "390x844", width: 390, height: 844, mobile: true },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

async function openBoard(browser: Browser, baseUrl: string, project: string, viewport: Viewport): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    hasTouch: viewport.mobile,
    isMobile: viewport.mobile,
  });
  await context.addInitScript(() => {
    localStorage.setItem("llv_lang", "en");
    localStorage.setItem("llvSound", "0");
  });
  const page = await context.newPage();
  /* The composer asks for the microphone only on a press; the menu is a read. */
  await page.route("**/api/transcribe/backend", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ backend: "local", lockedByEnv: false, options: [
      { id: "local", available: true, keyPath: "~/.config/stt/local" },
      { id: "chatgpt", available: true, keyPath: "~/.config/stt/chatgpt" },
      { id: "elevenlabs", available: false, keyPath: "~/.config/stt/elevenlabs" },
      { id: "soniox", available: false, keyPath: "~/.config/stt/soniox" },
    ] }),
  }));
  await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded" });
  /* The board is up once the orchestrator's conversation is on it. */
  await page.getByText("Ready in kanban").first().waitFor({ state: "attached", timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  return page;
}

const MIC_MENU = '[role="menu"][aria-label="Transcription method"]';
const LIGHTBOX = '[role="dialog"][aria-modal="true"][aria-label^="image"]';
const PICTURE = 'img[alt^="image"]';
const ACCOUNTS_DIALOG = '[role="dialog"][aria-label="Claude accounts"]';

const coverage = (page: Page, selector: string) => page.evaluate(readCoverage, selector);

/** Opens the orchestrator conversation's reader inside its board card. */
async function dockOrchestrator(page: Page, steps: string[]): Promise<string> {
  await page.locator('button.tile[aria-label^="Kanban orchestrator,"]').first().click({ timeout: 10_000 });
  steps.push("clicked the orchestrator's tile on its board card");
  const reader = ".column [data-reader-path]";
  await page.locator(reader).first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(800);
  return reader;
}

/** Expands the docked reader into the full-window reader, the board's conversation modal. */
async function expandOrchestrator(page: Page, steps: string[]): Promise<string> {
  const reader = await dockOrchestrator(page, steps);
  await page.locator(`${reader} button[aria-label="Open as a full pane"]`).first().click();
  steps.push("opened the reader as a full pane (the expanded conversation modal)");
  await page.locator(".reader-full").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(600);
  return ".reader-full";
}

/** On the phone, a conversation opens in the full-screen focus view. */
async function openOnPhone(page: Page, steps: string[], opener: string, what: string): Promise<void> {
  await page.locator(`button[aria-label="${opener}"]`).first().click({ timeout: 10_000 });
  steps.push(`tapped ${what}`);
  await page.locator('button[aria-label="Dictate"]').first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(800);
}

async function rightClickMic(page: Page, scope: string, steps: string[], where: string): Promise<void> {
  const mic = page.locator(`${scope} button[aria-label="Dictate"]`).first();
  await mic.scrollIntoViewIfNeeded();
  /* The same contextmenu event a right click, or a long press on a phone, delivers. */
  await mic.dispatchEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  steps.push(`opened the microphone's menu (contextmenu) on ${where}`);
  /* Options arrive from the transcription route; the menu is read once they are in. */
  await page.locator(`${MIC_MENU} [role="menuitemradio"]`).first().waitFor({ state: "visible", timeout: 10_000 });
}

/** One Escape press, as the operator's keyboard delivers it to the page. */
async function pressEscape(page: Page, steps: string[], what: string): Promise<void> {
  await page.keyboard.press("Escape");
  steps.push(`pressed Escape once to close ${what}`);
  await page.waitForTimeout(400);
}

/** Whether the surface the overlay was opened from is still open. */
async function stillOpen(page: Page, host: string): Promise<boolean> {
  return page.locator(host).first().isVisible().catch(() => false);
}

/** Clicks the picture, then closes the preview with one Escape and reads what
    is on top afterwards: the picture again, inside the conversation it was
    opened from, which must still be open. */
async function previewPicture(page: Page, scope: string, steps: string[], host: string): Promise<Opened> {
  const picture = page.locator(`${scope} ${PICTURE}`).first();
  await picture.scrollIntoViewIfNeeded();
  const box = await picture.boundingBox();
  if (!box) throw new Error("the picture has no box");
  /* A real pointer click at the picture's centre: whatever is on top there receives it. */
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  steps.push("clicked the picture");
  return {
    selector: LIGHTBOX,
    after: async () => {
      await pressEscape(page, steps, "the preview");
      const closed = (await page.locator(LIGHTBOX).count()) === 0;
      const keptOpen = await stillOpen(page, host);
      return { closed, keptOpen, host: keptOpen ? await coverage(page, `${scope} ${PICTURE}`) : null };
    },
  };
}

/** Escape closed the overlay (`closed`) and left the surface it was opened from open
    (`keptOpen`); `host`, when read, is what is on top of the opener afterwards. */
interface After { closed: boolean; keptOpen: boolean; host?: Coverage | null; keyboard?: KeyboardReach }
/** Where focus was at each step of the keyboard path through the microphone's menu. */
interface KeyboardReach {
  /** document.activeElement, described, right after Shift+F10 and the options loading. */
  afterOpen: string;
  afterOpenInside: boolean;
  /** …after one Tab. */
  afterTab: string;
  afterTabInside: boolean;
  /** …after Escape: it has to be the Dictate button it was opened from. */
  afterEscape: string;
  returnedToDictate: boolean;
}
interface Opened { selector: string; after?: () => Promise<After>; note?: string }
type Step = (page: Page, steps: string[]) => Promise<Opened>;

/** The accounts dialog, and a menu inside it when it holds one. */
async function accountsDialog(page: Page, steps: string[]): Promise<Opened> {
  const inside = await page.locator(`${ACCOUNTS_DIALOG} [aria-haspopup="menu"], ${ACCOUNTS_DIALOG} [aria-haspopup="true"], ${ACCOUNTS_DIALOG} [aria-haspopup="listbox"]`).count();
  if (inside === 0) {
    return { selector: ACCOUNTS_DIALOG, note: "The accounts dialog holds no control that opens a menu at this head (no aria-haspopup menu, listbox or true inside it); the reading is the dialog itself over the board." };
  }
  await page.locator(`${ACCOUNTS_DIALOG} [aria-haspopup]`).first().click();
  steps.push("opened the menu inside the accounts dialog");
  return { selector: '[role="menu"], [role="listbox"]' };
}

/** Closes the microphone's menu with one Escape; the conversation it was opened in stays. */
function micMenuEscape(page: Page, steps: string[], host: string): Opened {
  return {
    selector: MIC_MENU,
    after: async () => {
      await pressEscape(page, steps, "the microphone's menu");
      return { closed: (await page.locator(MIC_MENU).count()) === 0, keptOpen: await stillOpen(page, host) };
    },
  };
}

/** Where focus is: whether it is inside the microphone's menu, whether it is on
    the Dictate button, and a short description. Runs inside the page. */
function readFocus(menu: string): { inside: boolean; dictate: boolean; element: string } {
  const el = document.activeElement as HTMLElement | null;
  const label = el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 40) ?? "";
  return {
    inside: Boolean(el && document.querySelector(menu)?.contains(el)),
    dictate: el?.getAttribute("aria-label") === "Dictate",
    element: el ? `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role="${el.getAttribute("role")}"]` : ""} "${label}"` : "none",
  };
}

/** Opens the microphone's menu from the keyboard (focus on Dictate, Shift+F10),
    requires focus inside it after opening and after one Tab, then closes it
    with Escape and requires focus back on Dictate with the host still open. */
async function micMenuFromKeyboard(page: Page, scope: string, steps: string[], where: string, host: string): Promise<Opened> {
  const mic = page.locator(`${scope} button[aria-label="Dictate"]`).first();
  await mic.scrollIntoViewIfNeeded();
  await mic.focus();
  steps.push(`focused Dictate on ${where}`);
  await page.keyboard.press("Shift+F10");
  steps.push("pressed Shift+F10");
  await page.locator(`${MIC_MENU} [role="menuitemradio"]`).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(300);
  const opened = await page.evaluate(readFocus, MIC_MENU);
  await page.keyboard.press("Tab");
  steps.push("pressed Tab once");
  const tabbed = await page.evaluate(readFocus, MIC_MENU);
  return {
    selector: MIC_MENU,
    after: async () => {
      await pressEscape(page, steps, "the microphone's menu");
      const escaped = await page.evaluate(readFocus, MIC_MENU);
      return {
        closed: (await page.locator(MIC_MENU).count()) === 0,
        keptOpen: await stillOpen(page, host),
        keyboard: {
          afterOpen: opened.element,
          afterOpenInside: opened.inside,
          afterTab: tabbed.element,
          afterTabInside: tabbed.inside,
          afterEscape: escaped.element,
          returnedToDictate: escaped.dictate,
        },
      };
    },
  };
}

/** Rests the pointer on a composer control (focuses it on a phone) and reads its hint bubble. */
async function hintOf(page: Page, scope: string, label: string, steps: string[], where: string, touch: boolean): Promise<Opened> {
  const control = page.locator(`${scope} button[aria-label="${label}"]`).first();
  await control.scrollIntoViewIfNeeded();
  if (touch) {
    await control.focus();
    steps.push(`focused "${label}" on ${where}`);
  } else {
    await control.hover();
    steps.push(`rested the pointer on "${label}" on ${where}`);
  }
  const probe = await page.waitForFunction((text) => {
    const bubble = Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).find((el) => el.textContent?.trim() === text && el.getBoundingClientRect().width > 0);
    if (!bubble) return false;
    bubble.setAttribute("data-layering-probe", "");
    return true;
  }, label, { timeout: 5_000 });
  await probe.dispose();
  return { selector: "[data-layering-probe]" };
}

const PHONE_CONVERSATION = 'button[aria-label="Dictate"]';

const CASES: Record<string, { desktop: Step; phone: Step }> = {
  /* Symptom 1: the dropdown under the composer row and the role chip. */
  "mic-menu-orchestrator": {
    desktop: async (page, steps) => {
      await rightClickMic(page, "section.seat", steps, "the orchestrator seat above the board");
      return { selector: MIC_MENU };
    },
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation");
      await rightClickMic(page, "body", steps, "the orchestrator's conversation");
      return { selector: MIC_MENU };
    },
  },
  "mic-menu-docked-conversation": {
    desktop: async (page, steps) => {
      const reader = await dockOrchestrator(page, steps);
      await rightClickMic(page, reader, steps, "the reader docked in its board card");
      return { selector: MIC_MENU };
    },
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open Ship the review evidence for the readiness board and keep the verdict linked.", "a task's conversation from the board");
      await rightClickMic(page, "body", steps, "the task's conversation");
      return { selector: MIC_MENU };
    },
  },
  /* A menu opened inside a modal lands above it. */
  "mic-menu-in-expanded-conversation": {
    desktop: async (page, steps) => {
      const full = await expandOrchestrator(page, steps);
      await rightClickMic(page, full, steps, "the expanded conversation");
      return micMenuEscape(page, steps, full);
    },
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation (full screen on a phone)");
      await rightClickMic(page, "body", steps, "the full-screen conversation");
      return micMenuEscape(page, steps, PHONE_CONVERSATION);
    },
  },
  /* The portalled menu stays reachable from the keyboard. */
  "mic-menu-keyboard-orchestrator": {
    desktop: async (page, steps) => micMenuFromKeyboard(page, "section.seat", steps, "the orchestrator seat above the board", "section.seat"),
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation");
      return micMenuFromKeyboard(page, "body", steps, "the orchestrator's conversation", PHONE_CONVERSATION);
    },
  },
  "mic-menu-keyboard-in-expanded-conversation": {
    desktop: async (page, steps) => {
      const full = await expandOrchestrator(page, steps);
      return micMenuFromKeyboard(page, full, steps, "the expanded conversation", full);
    },
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation (full screen on a phone)");
      return micMenuFromKeyboard(page, "body", steps, "the full-screen conversation", PHONE_CONVERSATION);
    },
  },
  /* Symptom 2: the picture opens behind the expanded conversation. */
  "image-preview-from-expanded-conversation": {
    desktop: async (page, steps) => {
      const full = await expandOrchestrator(page, steps);
      return previewPicture(page, full, steps, full);
    },
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation (full screen on a phone)");
      return previewPicture(page, "body", steps, PHONE_CONVERSATION);
    },
  },
  /* The tooltip layer: hover hints on the composer's edge controls, whole and on top. */
  "composer-hint-orchestrator": {
    desktop: async (page, steps) => hintOf(page, "section.seat", "Launch the agent", steps, "the orchestrator seat's composer", false),
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open the orchestrator's conversation — finished", "the orchestrator's conversation");
      return hintOf(page, "body", "Add files or images", steps, "the orchestrator's conversation", true);
    },
  },
  "composer-hint-in-expanded-conversation": {
    desktop: async (page, steps) => hintOf(page, await expandOrchestrator(page, steps), "Launch the agent", steps, "the expanded conversation's composer", false),
    phone: async (page, steps) => {
      await openOnPhone(page, steps, "Open Ship the review evidence for the readiness board and keep the verdict linked.", "a task's conversation from the board");
      return hintOf(page, "body", "Add files or images", steps, "the task's conversation", true);
    },
  },
  "menu-inside-accounts-dialog": {
    desktop: async (page, steps) => {
      await page.locator('button[aria-label="Claude accounts — switch or add"]').first().click();
      steps.push("opened the Claude accounts dialog from the limits footer");
      await page.locator(ACCOUNTS_DIALOG).waitFor({ state: "visible", timeout: 10_000 });
      return accountsDialog(page, steps);
    },
    phone: async (page, steps) => {
      await page.locator('button[aria-label="More actions"]').first().click();
      await page.getByText("Accounts & limits", { exact: true }).first().click({ timeout: 10_000 });
      steps.push("opened Accounts & limits from More actions");
      await page.getByText("Add a Claude account").first().waitFor({ state: "visible", timeout: 10_000 });
      /* The accounts screen's own header menu. */
      const before = await page.locator('[role="menu"], [role="dialog"]').count();
      await page.locator('button[aria-label="More actions"]').last().click();
      steps.push("opened the accounts screen's own More actions menu");
      await page.waitForFunction((count) => document.querySelectorAll('[role="menu"], [role="dialog"]').length > count, before, { timeout: 10_000 });
      await page.waitForTimeout(500);
      const menu = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"]')).filter((el) => el.getBoundingClientRect().height > 0);
        const last = all.at(-1);
        if (!last) return null;
        last.setAttribute("data-layering-probe", "");
        return last.getAttribute("aria-label");
      });
      return { selector: "[data-layering-probe]", note: `The phone's accounts screen is a full screen; the menu read is the one its header opens (${menu ?? "unnamed"}).` };
    },
  },
};

interface CaseResult {
  id: string;
  viewport: string;
  ok: boolean;
  steps: string[];
  coverage: Coverage | null;
  after?: After;
  note?: string;
  error?: string;
}

async function runCase(browser: Browser, baseUrl: string, project: string, viewport: Viewport, id: string, step: Step): Promise<CaseResult> {
  const page = await openBoard(browser, baseUrl, project, viewport);
  const steps: string[] = [];
  try {
    const { selector, after, note } = await step(page, steps);
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    const reading = await coverage(page, selector);
    if (SHOTS) await page.screenshot({ path: path.join(BASE, `${id}-${viewport.name}.png`) });
    const afterReading = after ? await after() : undefined;
    const ok = Boolean(reading && reading.points > 0 && reading.covered === 0)
      && (afterReading === undefined || (afterReading.closed && afterReading.keptOpen
        && (afterReading.host === undefined || Boolean(afterReading.host && afterReading.host.covered === 0))
        && (afterReading.keyboard === undefined
          || (afterReading.keyboard.afterOpenInside && afterReading.keyboard.afterTabInside && afterReading.keyboard.returnedToDictate))));
    return { id, viewport: viewport.name, ok, steps, coverage: reading, ...(afterReading ? { after: afterReading } : {}), ...(note ? { note } : {}) };
  } catch (error) {
    if (SHOTS) await page.screenshot({ path: path.join(BASE, `${id}-${viewport.name}-error.png`) }).catch(() => undefined);
    return { id, viewport: viewport.name, ok: false, steps, coverage: null, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  } finally {
    await page.context().close();
  }
}

async function main(): Promise<void> {
  copyFixtureHome();
  addPicture();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const results: CaseResult[] = [];
  try {
    server = startServer(port);
    console.log(`server pid ${server.pid} on ${port}`);
    const project = await waitForBoard(baseUrl, server);
    console.log(`project ${project}`);
    browser = await chromium.launch({ executablePath: Bun.which(process.env.CHROME_BIN || "google-chrome-stable") ?? undefined, headless: true });
    for (const viewport of VIEWPORTS) {
      for (const [id, runner] of Object.entries(CASES)) {
        if (ONLY && !ONLY.includes(id)) continue;
        const result = await runCase(browser, baseUrl, project, viewport, id, viewport.mobile ? runner.phone : runner.desktop);
        console.log(`${result.ok ? "PASS" : "FAIL"} ${id} ${viewport.name}${result.error ? ` — ${result.error}` : ""}`);
        results.push(result);
      }
    }
  } finally {
    await browser?.close();
    await stop(server);
  }
  const record = {
    generatedBy: "scripts/capture-layering.ts",
    head: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim(),
    viewports: VIEWPORTS.map((v) => v.name),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
  /* The seeded home's path is the capture directory's, which varies per run. */
  const text = JSON.stringify(record, null, 2).replaceAll(BASE, "$CAPTURE");
  if (OUT) fs.writeFileSync(path.resolve(repoRoot, OUT), text + "\n", "utf8");
  console.log(text);
  console.log(`capture dir ${BASE}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (import.meta.main) await main();

export { readCoverage };
