/**
 * Rendered acceptance for the board geometry defects reported on 2026-09-10
 * (huge nearly empty task frame, squiggle review-loop arcs, cards that do not
 * scale with the camera, a click that flies past the clicked card, a wheel
 * that dies over band controls and collapsed cards), in a real browser against
 * the production build:
 *
 *   bun run build && bun scripts/capture-board-geometry.ts
 *
 * Every reading is taken from the live DOM, and every input goes through
 * Playwright's Chromium input pipeline — real pointer clicks, real wheel,
 * real Control+wheel for the pinch path, real keyboard for the zoom keys, a
 * real viewport resize and a real reload for the restore path — at a wide and
 * a narrow viewport and at overview / intermediate / near zoom. One probe per
 * camera mutation path: wheel/pinch, toolbar, absolute 100%, fit current, fit
 * all, click-to-open, keyboard navigation, resize, restore. Every check is one
 * that reads red on the base commit and green on the fix — a negative control,
 * never a screenshot gallery.
 *
 * Everything runs against a synthetic home under the temp root: its own HOME,
 * XDG dirs, TMPDIR, viewer state dir and provider homes. Nothing here touches
 * the operator's live state and no real path appears in a frame.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({ envName: "BOARD_CAPTURE_DIR", prefix: "llv-issue-1641", raw: process.env.BOARD_CAPTURE_DIR, repoRoot });
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");
const PROJECT_NAME = "harbor";
const REPO_DIR = path.join(HOME, "Projects", PROJECT_NAME);

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/* Band chrome sizes mirrored from taskBands BAND, for the overview allowance,
   and the two band framings the fit buttons land on. */
const BAND_HEADER = 48;
const BAND_PAD = 16;
const BAND_ROWGAP = 32;
const BAND_FIT_CURRENT_Z = 0.58;
const BAND_FIT_ALL_Z = 0.2;

interface Seeded { path: string; title: string; busy: boolean }
interface SeededTask { id: string; title: string; members: Seeded[] }

/** Invented corpus: five tasks; the first holds a finished implement→review
    loop (implementer + two reviewer rounds) so the board draws a round deck
    and its cycle arcs inside a band. */
const TASKS: { title: string; roles: string[]; busy: number[] }[] = [
  { title: "Fix delivery recovery after a lost acknowledgement", roles: ["implementer", "helper", "helper"], busy: [1, 2] },
  { title: "Repair board zoom and connector geometry", roles: ["builder", "reviewer", "critic", "designer", "scribe"], busy: [0, 1] },
  { title: "Release notes for the September train", roles: ["writer", "editor"], busy: [] },
  { title: "Voice boundary refuses to guess", roles: ["builder", "reviewer", "tester", "tester", "tester", "auditor"], busy: [0] },
  { title: "Docs for the runtime host succession", roles: ["writer", "reviewer", "editor"], busy: [] },
];

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, HOME: path.join(BASE, "git-home"), GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.invalid", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.invalid" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function writeConversation(folder: string, id: string, title: string, body: string, busy: boolean, stamp: string): string {
  const lines: unknown[] = [
    { type: "user", uuid: `${id}-u1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "user", content: `${title}.` } },
    { type: "assistant", uuid: `${id}-a1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: body }] } },
  ];
  if (busy) lines.push({ type: "user", uuid: `${id}-u2`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "user", content: "Continue with the next step." } });
  else lines.push({ type: "result", subtype: "success", uuid: `${id}-r1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, is_error: false, duration_ms: 1200, num_turns: 1, result: body });
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function seedHome(): { tasks: SeededTask[]; reviewers: Seeded[] } {
  for (const dir of [REPO_DIR, OUT_DIR, path.join(BASE, "git-home"), path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), path.join(BASE, "tmux"), STATE_DIR, path.join(HOME, ".codex/sessions")]) fs.mkdirSync(dir, { recursive: true });
  git(REPO_DIR, "init", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# harbor\n", "utf8");
  git(REPO_DIR, "add", "README.md");
  git(REPO_DIR, "commit", "-m", "harbor: first commit");
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const tasks: SeededTask[] = [];
  let serial = 0;
  for (const [index, spec] of TASKS.entries()) {
    const members: Seeded[] = [];
    for (const [slot, role] of spec.roles.entries()) {
      serial += 1;
      const id = `${String(serial).padStart(8, "0")}-1641-4000-8000-000000000000`;
      const title = `${role}: ${spec.title.toLowerCase()}`;
      const busy = spec.busy.includes(slot);
      const stamp = `2100-01-02T1${index % 9}:${String(10 + slot).padStart(2, "0")}:05.000Z`;
      const body = `Working on it: ${title}. ` + "The transcript carries enough lines to make a reader scroll. ".repeat(400);
      members.push({ path: writeConversation(folder, id, title, body, busy, stamp), title, busy });
    }
    tasks.push({ id: `task-1641-${String(index).padStart(2, "0")}`, title: spec.title, members });
  }
  /* Two reviewer rounds for the first task's implementer. */
  const reviewers: Seeded[] = [];
  for (const round of [1, 2]) {
    serial += 1;
    const id = `${String(serial).padStart(8, "0")}-1641-4000-8000-000000000000`;
    const title = `reviewer round ${round}: fix delivery recovery`;
    reviewers.push({ path: writeConversation(folder, id, title, `Round ${round} review. ` + "Finding text. ".repeat(30), false, `2100-01-02T12:${String(20 + round)}:05.000Z`), title, busy: false });
  }
  return { tasks, reviewers };
}

function seedState(project: string, tasks: SeededTask[], reviewers: Seeded[]): void {
  const rows = tasks.map((task, index) => ({
    id: task.id,
    project,
    status: "assigned",
    text: `${task.title}\nInvented fixture task ${index + 1} for the geometry capture.`,
    placement: "unplaced",
    assignments: [...task.members, ...(index === 0 ? reviewers : [])].map((member) => ({ path: member.path, conversationId: null, panePid: null, state: "delivered", error: null, at: `2100-01-02T10:00:${String(index).padStart(2, "0")}.000Z` })),
    createdAt: `2100-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2100-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  fs.writeFileSync(path.join(STATE_DIR, "tasks.json"), JSON.stringify({ tasks: rows }, null, 2) + "\n", "utf8");
  const implementer = tasks[0]!.members[0]!;
  const round = (n: number, reviewer: Seeded, verdict: "REQUEST_CHANGES" | "APPROVE", findingsCount: number) => ({
    n, reviewerPath: reviewer.path, reviewerConversationId: null, reviewerBindingId: `binding-${n}`, reviewerRole: { engine: "claude", model: "opus", effort: "high" },
    accountId: null, attemptedAccounts: [], autoRetryCount: 0, sessionId: null, reviewerPid: null, reviewerIdentity: null, reviewerPane: null,
    findingsPath: null, triggeredBy: "marker", readyNote: null, reviewHeadSha: "0".repeat(40), verdict, findingsCount,
    startedAt: `2100-01-02T12:${String(20 + n)}:00.000Z`, spawnStartedAt: null, launchId: null, launchLeaseUntil: null, relayStartedAt: null,
    relayRetryCount: 0, relayDeliveryAttempt: 0, relayDeliveryTransport: null, relayRetryAt: null, relayRetryRequiresIdempotency: false,
    relayDelivery: null, relayPendingSettlement: null, relayHold: null, reviewedAt: `2100-01-02T12:${String(20 + n)}:30.000Z`, terminalAt: `2100-01-02T12:${String(20 + n)}:30.000Z`, relayedAt: null, error: null,
  });
  const flows = [{
    id: "flow-1641-review",
    template: "implement-review-loop",
    project,
    cwd: REPO_DIR,
    implementerPath: implementer.path,
    implementerConversationId: null,
    roles: { implementer: { engine: "claude", model: "opus", effort: "high" }, reviewer: { engine: "claude", model: "opus", effort: "high" } },
    reviewerFallback: null,
    baseRef: "0".repeat(40),
    headRef: null,
    targetSha: null,
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "approved",
    pausedState: null,
    stateDetail: null,
    rounds: [round(1, reviewers[0]!, "REQUEST_CHANGES", 2), round(2, reviewers[1]!, "APPROVE", 3)],
    createdAt: "2100-01-02T12:20:00.000Z",
    closedAt: null,
  }];
  fs.writeFileSync(path.join(STATE_DIR, "flows.json"), JSON.stringify({ schemaVersion: 3, flows }, null, 2) + "\n", "utf8");
}

function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const config = path.join(HOME, ".config");
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) if (name.startsWith("LLV_") || name.startsWith("__NEXT_PRIVATE")) delete inherited[name];
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
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

const CAPTURE_BUN = process.env.BOARD_CAPTURE_BUN?.trim() || process.execPath;

function startServer(port: number): ChildProcess {
  return spawn(CAPTURE_BUN, ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot, env: buildEnvironment(port), stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try { if ((await fetch(`${url}/api/files`)).ok) return; } catch { /* booting */ }
    await Bun.sleep(400);
  }
  throw new Error("production server did not become ready");
}

interface FilesPayload { files?: { path?: string; project?: string }[]; tasks?: { id: string }[] }

async function waitForBoard(baseUrl: string, expectTasks: boolean): Promise<{ project: string; cards: number }> {
  const deadline = Date.now() + 180_000;
  let cards = 0;
  while (Date.now() < deadline) {
    const payload = await (await fetch(`${baseUrl}/api/files`)).json() as FilesPayload;
    const files = payload.files ?? [];
    cards = files.length;
    const project = files.find((file) => file.project)?.project;
    if (project && cards > 0 && (!expectTasks || (payload.tasks ?? []).length > 0)) return { project, cards };
    await Bun.sleep(2_000);
  }
  throw new Error(`scan never produced a board window; last saw ${cards} cards`);
}

async function stop(server: ChildProcess | null): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (server.exitCode === null && Date.now() < deadline) await Bun.sleep(200);
  if (server.exitCode === null) server.kill("SIGKILL");
}

const seedInit = () => {
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
  localStorage.setItem("llvSchemeMode", "select");
};

/* ------------------------------------------------------------------------- */
/* In-page readings                                                           */
/* ------------------------------------------------------------------------- */

interface Rect { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }
interface Reading {
  camera: { x: number; y: number; z: number };
  canvas: Rect;
  /** The world box (the transformed layer) in board pixels. */
  world: { w: number; h: number };
  bands: { id: string; task: string | null; rect: Rect; paintedBottom: number; paintedRight: number; members: number }[];
  nodes: { key: string; presentation: string | null; rect: Rect; band: string | null }[];
  decks: { key: string; shell: Rect; painted: Rect | null; expanded: boolean }[];
  /** The ⟳ flow hubs on the board, as painted. */
  hubs: { flow: string; rect: Rect }[];
  /** Every connector path drawn in the world: endpoints, bbox and a screen-
      space sampling along it, so "on the connector" can be measured. */
  paths: { start: Pt; end: Pt; bbox: Rect; closed: boolean; samples: Pt[] }[];
}

/** Runs inside the page. Screen coordinates are relative to the board canvas. */
function readBoard(): Reading {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
  const canvasRect = viewport.getBoundingClientRect();
  const rel = (r: DOMRect): Rect => ({ x: r.x - canvasRect.x, y: r.y - canvasRect.y, w: r.width, h: r.height });
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  const m = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([\d.e+-]+)\)/.exec(world.style.transform)!;
  const camera = { x: parseFloat(m[1]!), y: parseFloat(m[2]!), z: parseFloat(m[3]!) };
  const toScreen = (wx: number, wy: number): Pt => ({ x: camera.x + wx * camera.z, y: camera.y + wy * camera.z });
  const nodeEls = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-node]"));
  const nodes = nodeEls.map((el) => ({ key: el.getAttribute("data-scheme-node")!, presentation: el.getAttribute("data-scheme-node-presentation"), rect: rel(el.getBoundingClientRect()), band: null as string | null }));
  const decks = nodeEls.filter((el) => el.getAttribute("data-scheme-node")!.startsWith("deck::")).map((el) => {
    const chip = el.querySelector<HTMLElement>("[data-review-deck-collapsed]");
    return { key: el.getAttribute("data-scheme-node")!, shell: rel(el.getBoundingClientRect()), painted: chip ? rel(chip.getBoundingClientRect()) : null, expanded: Boolean(el.querySelector("[data-review-deck-collapse]")) };
  });
  const bands = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]")).map((band) => {
    const rect = rel(band.getBoundingClientRect());
    const bandId = band.getAttribute("data-scheme-band");
    /* What the band visibly holds: every node shell inside its box (a collapsed
       deck counted at its chip, never the shell it reserves), plus the mirror
       tiles and the «+ Agent» add row — every painted surface, so an empty
       frame below the content cannot hide behind an uncounted control. */
    let paintedBottom = rect.y;
    let paintedRight = rect.x;
    let members = 0;
    for (const node of nodes) {
      const inside = node.rect.x >= rect.x - 1 && node.rect.x + node.rect.w <= rect.x + rect.w + 1 && node.rect.y >= rect.y - 1 && node.rect.y + node.rect.h <= rect.y + rect.h + 1;
      if (!inside) continue;
      node.band = bandId;
      members += 1;
      const deck = decks.find((entry) => entry.key === node.key);
      const painted = deck?.painted ?? node.rect;
      paintedBottom = Math.max(paintedBottom, painted.y + painted.h);
      paintedRight = Math.max(paintedRight, painted.x + painted.w);
    }
    for (const el of Array.from(band.querySelectorAll<HTMLElement>("[data-scheme-band-add], [data-scheme-mirror], [data-scheme-continuation]"))) {
      const r = rel(el.getBoundingClientRect());
      if (r.w <= 0 || r.h <= 0) continue;
      paintedBottom = Math.max(paintedBottom, r.y + r.h);
      paintedRight = Math.max(paintedRight, r.x + r.w);
    }
    return { id: bandId!, task: band.getAttribute("data-scheme-band-task"), rect, paintedBottom, paintedRight, members };
  });
  /* The ⟳ hub buttons: by their data attribute, or — on a build predating it —
     by the glyph they carry, so the base commit can be measured too. */
  const hubEls = Array.from(document.querySelectorAll<HTMLElement>("[data-flow-hub]"));
  const hubs = (hubEls.length ? hubEls : Array.from(document.querySelectorAll<HTMLElement>("button[data-scheme-ui]")).filter((el) => (el.textContent ?? "").includes("⟳")))
    .map((el) => ({ flow: el.getAttribute("data-flow-hub") ?? "", rect: rel(el.getBoundingClientRect()) }));
  const paths: Reading["paths"] = [];
  for (const svg of Array.from(world.querySelectorAll("svg"))) {
    for (const el of Array.from(svg.querySelectorAll<SVGPathElement>("path"))) {
      const d = el.getAttribute("d") ?? "";
      const numbers = d.replace(/[A-Za-z,]/g, " ").trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
      if (numbers.length < 4) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const samples: Pt[] = [];
      try {
        const length = el.getTotalLength();
        for (let i = 0; i <= 80; i += 1) {
          const point = el.getPointAtLength((length * i) / 80);
          samples.push(toScreen(point.x, point.y));
        }
      } catch { /* not a measurable path */ }
      paths.push({ start: toScreen(numbers[0]!, numbers[1]!), end: toScreen(numbers[numbers.length - 2]!, numbers[numbers.length - 1]!), bbox: rel(box), closed: /z\s*$/i.test(d), samples });
    }
  }
  return { camera, canvas: { x: 0, y: 0, w: canvasRect.width, h: canvasRect.height }, world: { w: world.offsetWidth, h: world.offsetHeight }, bands, nodes, decks, hubs, paths };
}

const read = (page: Page) => page.evaluate(readBoard);

async function canvasPoint(page: Page, fx: number, fy: number): Promise<Pt> {
  return page.evaluate(([fx, fy]) => {
    const box = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
    return { x: box.x + box.width * fx, y: box.y + box.height * fy };
  }, [fx, fy] as const);
}

/** Control+wheel through Chromium's real input pipeline — the event a trackpad
    pinch delivers — with the pointer at `at`, repeated until the camera reads
    within 1% of the target. */
async function zoomTo(page: Page, target: number, at: Pt): Promise<number> {
  await page.mouse.move(at.x, at.y);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = (await read(page)).camera.z;
    if (Math.abs(current - target) / target < 0.01) return current;
    const deltaY = -Math.log(target / current) / 0.0022;
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, deltaY);
    await page.keyboard.up("Control");
    await page.waitForTimeout(250);
  }
  return (await read(page)).camera.z;
}

/** A point inside both the element and the board viewport, or null. */
async function visiblePoint(page: Page, selector: string): Promise<Pt | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    const canvas = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, canvas.left + 2), right = Math.min(r.right, canvas.right - 2);
    const top = Math.max(r.top, canvas.top + 2), bottom = Math.min(r.bottom, canvas.bottom - 2);
    if (right - left < 4 || bottom - top < 4) return null;
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }, selector);
}

/** The first element matching the selector whose centre lands inside the board
    viewport — DOM order may put an off-screen match first. */
async function firstVisiblePoint(page: Page, selector: string): Promise<Pt | null> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, canvas.left + 2), right = Math.min(r.right, canvas.right - 2);
      const top = Math.max(r.top, canvas.top + 2), bottom = Math.min(r.bottom, canvas.bottom - 2);
      if (right - left < 4 || bottom - top < 4) continue;
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    }
    return null;
  }, selector);
}

/** A plain wheel at a screen point; reports how the camera, the nearest
    conversation feed and any generic scroll box under the pointer answered. */
async function wheelAt(page: Page, at: Pt, deltaY = 240): Promise<{ cameraDy: number; feedDy: number; scrollerDy: number }> {
  const scrollTops = () => page.evaluate(([x, y]) => {
    const feeds = Array.from(document.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")).map((el) => el.scrollTop);
    /* The generic scroll box under the pointer, found without any selector the
       board could special-case: the nearest ancestor that overflows vertically
       in an auto/scroll container. */
    let scroller = 0;
    for (let el = document.elementFromPoint(x, y) as HTMLElement | null; el; el = el.parentElement) {
      if (el.hasAttribute("data-log-feed-scroller")) break;
      const overflowY = getComputedStyle(el).overflowY;
      if (el.scrollHeight > el.clientHeight + 1 && (overflowY === "auto" || overflowY === "scroll")) { scroller = el.scrollTop; break; }
    }
    return { feeds, scroller };
  }, [at.x, at.y] as const);
  const before = await scrollTops();
  const cam0 = (await read(page)).camera;
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(350);
  const cam1 = (await read(page)).camera;
  const after = await scrollTops();
  const feedDy = Math.max(0, ...after.feeds.map((v, i) => Math.abs(v - (before.feeds[i] ?? 0))));
  return { cameraDy: cam1.y - cam0.y, feedDy, scrollerDy: Math.abs(after.scroller - before.scroller) };
}

/** A real click at the centre of a toolbar control. Playwright's own `click`
    scrolls the target into view first, and the board viewport answers any
    scroll by resetting itself (a focused runtime control must never scroll the
    camera's origin), so the two fight; the mouse click needs no scrolling. The
    browser's own hit test decides who receives it — the element under the
    point is recorded so an intercepting overlay would show in the report. */
async function clickControl(page: Page, selector: string): Promise<string | null> {
  const target = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitIsTarget: hit === el || el.contains(hit), hit: hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute("aria-label") ? `[${hit.getAttribute("aria-label")}]` : ""}` : "none" };
  }, selector);
  if (!target) return `no control matches ${selector}`;
  await page.mouse.click(target.x, target.y);
  return target.hitIsTarget ? null : `${selector} is covered by ${target.hit}`;
}

/** The shell's attention island covers the board toolbar's right end at narrow
    desktop widths (#1643) — a shell defect, not board geometry. A toolbar probe
    it covers is recorded under this key and the same camera path is proven
    through its keyboard equivalent instead, so the cover is never silent and
    never counted as a geometry failure. */
const ATTENTION_COVER = /\[\d+ waiting\]/;

/** Hands keyboard focus back to the page. A toolbar button keeps focus after
    a real click and the board's zoom keys defer to a focused control, exactly
    as they defer to a focused input; the probes press keys as an operator
    whose focus is on the board, not on the button they just clicked. */
const blurActive = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Plain wheel (real input) downward from the current position until the
    first element matching the selector has a point inside the board viewport.
    A surface outside the viewport is virtualized to a zero rect, so it cannot
    be steered at: the search walks down in steps shorter than the viewport and
    reads the real rect once the surface is drawn. */
async function bringSelectorOnScreen(page: Page, selector: string): Promise<Pt | null> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const point = await firstVisiblePoint(page, selector);
    /* Visible AND the browser's own hit test agrees — a control that has just
       entered at the bottom of the viewport can sit under the minimap, and a
       click there would drive the camera instead of the control. */
    if (point && await page.evaluate(([x, y, sel]) => { const hit = document.elementFromPoint(x, y); const el = document.querySelector(sel); return Boolean(hit && el && (hit === el || el.contains(hit))); }, [point.x, point.y, selector] as const)) return point;
    const target = await page.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      const canvas = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return r.top + r.height / 2 - (canvas.top + canvas.height / 2);
    }, selector);
    const at = await canvasPoint(page, 0.02, 0.5);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, target === null ? 250 : Math.max(-500, Math.min(500, target)));
    await page.waitForTimeout(150);
  }
  return null;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const inside = (pt: Pt, rc: Rect) => pt.x >= rc.x && pt.x <= rc.x + rc.w && pt.y >= rc.y && pt.y <= rc.y + rc.h;
const overlaps = (a: Rect, b: Rect, slack = 0) => a.x + slack < b.x + b.w && b.x + slack < a.x + a.w && a.y + slack < b.y + b.h && b.y + slack < a.y + a.h;

/* ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const { tasks, reviewers } = seedHome();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = 3_000 + (process.pid % 900);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim() };
  try {
    /* The project key is the scan's own. A throwaway boot names it; the
       state (tasks and the review flow) is then written and the server booted
       again on a fresh state directory, so the flow is present at first read. */
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const { project } = await waitForBoard(baseUrl, false);
    await stop(server);
    server = null;
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    seedState(project, tasks, reviewers);
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, true);
    await Bun.sleep(4_000);
    const flowsLoaded = ((await (await fetch(`${baseUrl}/api/files`)).json()) as { flows?: unknown[] }).flows?.length ?? 0;
    must(flowsLoaded === 1, `the server loaded ${flowsLoaded} flows; the review loop is not on the board`);
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    const scannedPaths = ((await (await fetch(`${baseUrl}/api/files`)).json()) as FilesPayload).files!.map((file) => file.path!);
    const scanned = (seeded: string) => scannedPaths.find((candidate) => candidate === seeded || candidate.endsWith(path.basename(seeded))) ?? seeded;
    const implementer = scanned(tasks[0]!.members[0]!.path);
    const sibling = scanned(tasks[1]!.members[2]!.path);
    const sibling2 = scanned(tasks[1]!.members[0]!.path);

    for (const viewportSize of [{ width: 1400, height: 900, tag: "wide" }, { width: 830, height: 600, tag: "narrow" }]) {
      const context = await browser.newContext({ viewport: { width: viewportSize.width, height: viewportSize.height }, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
      await page.waitForTimeout(2_500);
      const tag = viewportSize.tag;
      const frames: Record<string, unknown> = {};
      const center = await canvasPoint(page, 0.5, 0.5);

      /** The document rule of the band board: whenever the band stack fits the
          viewport horizontally, the camera's left edge is the viewport's — no
          dead canvas beside the bands. Asserted after every camera path. */
      const documentRule = (r: Reading, label: string) => {
        if (r.world.w * r.camera.z <= r.canvas.w + 0.5) must(near(r.camera.x, 0, 1), `${label}: the band stack fits the viewport but the camera sits at x=${r.camera.x.toFixed(1)} — ${Math.round(Math.abs(r.camera.x))}px of dead canvas beside the bands`);
        else must(r.camera.x <= 0.5 && r.camera.x + r.world.w * r.camera.z >= r.canvas.w - 0.5, `${label}: the band stack is wider than the viewport yet the camera shows past its edge (x=${r.camera.x.toFixed(1)}, stack ${Math.round(r.world.w * r.camera.z)}px in ${r.canvas.w}px)`);
      };

      /** Plain wheel (real input) until the flow band's header sits under the toolbar. */
      const panToBand = async (taskId: string) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const bands = (await read(page)).bands;
          const band = bands.find((entry) => entry.task === taskId);
          if (!band) return false;
          const delta = band.rect.y - 72;
          if (Math.abs(delta) < 3) return true;
          const at = await canvasPoint(page, 0.02, 0.5);
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(0, Math.max(-600, Math.min(600, delta)));
          await page.waitForTimeout(160);
        }
        return false;
      };
      const flowTask = tasks[0]!.id;
      const arcChecks = (r: Reading, label: string) => {
        const flowBand = r.bands.find((band) => band.task === flowTask);
        if (!flowBand) { must(false, `${label}: the review-loop task has no band`); return; }
        /* 1. The frame is as tall as what it holds. */
        const overhang = flowBand.rect.y + flowBand.rect.h - flowBand.paintedBottom;
        must(overhang <= 72 * r.camera.z + 8, `${label}: the review-loop band hangs ${Math.round(overhang)}px below its last painted surface (band ${Math.round(flowBand.rect.h)}px tall, ${flowBand.members} surfaces)`);
        /* 2. The review connector attaches to the ACTUAL cards. It used to be
              drawn at fixed board-pixel offsets that landed nowhere near the
              band's cards, leaving a squiggle in the empty space. Now its two
              endpoints touch the implementer card and the reviewer deck as they
              are placed — including when the deck wrapped to a later row — and
              nothing dangles below the band's content. */
        const deck = r.decks[0];
        const impl = r.nodes.find((node) => node.key === implementer);
        if (!deck || !impl) { must(false, `${label}: deck or implementer not found (deck ${Boolean(deck)}, implementer ${Boolean(impl)})`); return; }
        const deckBox = deck.painted ?? deck.shell;
        const nearRect = (pt: Pt, rc: Rect, tol = 22) => pt.x >= rc.x - tol && pt.x <= rc.x + rc.w + tol && pt.y >= rc.y - tol && pt.y <= rc.y + rc.h + tol;
        /* Both endpoints must be on screen to judge attachment; a band taller
           than the viewport pushes the reviewer deck past the fold, where it is
           virtualized to a stale rect. Wrapped-row attachment is proven at that
           density by the unit test instead. */
        const onScreen = (rc: Rect) => rc.x + rc.w > 4 && rc.x < r.canvas.w - 4 && rc.y + rc.h > 4 && rc.y < r.canvas.h - 4;
        if (onScreen(impl.rect) && onScreen(deckBox)) {
          const connector = r.paths.find((p) => !p.closed && ((nearRect(p.start, impl.rect) && nearRect(p.end, deckBox)) || (nearRect(p.start, deckBox) && nearRect(p.end, impl.rect))));
          must(connector !== undefined, `${label}: no review connector runs between the implementer card and its reviewer deck (impl at ${Math.round(impl.rect.x)},${Math.round(impl.rect.y)}, deck at ${Math.round(deckBox.x)},${Math.round(deckBox.y)})`);
          /* 3. The ⟳ hub — the clickable face of the same relationship — sits
                ON that connector, and covers no card but the two it joins. The
                free board's corridor formula put it level with arcs that are
                not drawn here: straddling the deck chip on a wide board, inside
                an unrelated helper card once the deck wrapped on a narrow one. */
          const hub = r.hubs[0];
          if (!hub) must(false, `${label}: the review loop has no ⟳ hub on the board`);
          else if (connector) {
            const hubCenter = { x: hub.rect.x + hub.rect.w / 2, y: hub.rect.y + hub.rect.h / 2 };
            const gap = Math.min(...connector.samples.map((pt) => Math.hypot(pt.x - hubCenter.x, pt.y - hubCenter.y)));
            must(gap <= 4 + 3 * r.camera.z, `${label}: the ⟳ hub sits ${Math.round(gap)}px off the review connector`);
            const covered = r.nodes.filter((node) => node.key !== impl.key && node.key !== deck.key && node.rect.w > 0 && onScreen(node.rect) && overlaps(hub.rect, node.rect, 1));
            must(covered.length === 0, `${label}: the ⟳ hub covers ${covered.length} card(s) that are not its endpoints (hub at ${Math.round(hubCenter.x)},${Math.round(hubCenter.y)}; first ${covered[0]?.key.slice(-24)})`);
          }
        }
        const strandMargin = 24 * r.camera.z + 12;
        const stranded = r.paths.filter((p) => p.bbox.y > flowBand.paintedBottom + strandMargin && p.bbox.y < flowBand.rect.y + flowBand.rect.h);
        must(stranded.length === 0, `${label}: ${stranded.length} connector path(s) dangle below the band's content (paintedBottom ${Math.round(flowBand.paintedBottom)}, band bottom ${Math.round(flowBand.rect.y + flowBand.rect.h)})`);
        for (const p of r.paths.filter((path) => !path.closed && path.bbox.h > 4 && path.bbox.w > 4)) {
          const reach = Math.hypot(p.end.x - p.start.x, p.end.y - p.start.y);
          must(p.bbox.w <= Math.abs(p.end.x - p.start.x) + reach * 0.6 + 40, `${label}: a connector folds back on itself (endpoints ${Math.round(Math.abs(p.end.x - p.start.x))}px apart, bbox ${Math.round(p.bbox.w)}px wide)`);
        }
        must(deck.painted === null || deck.shell.h <= deck.painted.h + 1, `${label}: the collapsed deck reserves ${Math.round(deck.shell.h)}px for a ${Math.round(deck.painted?.h ?? 0)}px chip`);
        must(r.bands.every((band) => band.rect.x + band.rect.w <= r.canvas.w + 1), `${label}: a band runs past the right edge of the viewport`);
        documentRule(r, label);
      };

      /* ---- Near zoom, nothing selected: the operator's screenshot. */
      await zoomTo(page, 1, center);
      await page.keyboard.press("Escape");
      must(await panToBand(flowTask), `${tag}: the review-loop band could not be brought under the toolbar at 100%`);
      await page.waitForTimeout(300);
      let r = await read(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${tag}-near.png`) });
      frames.near = { camera: r.camera, band: r.bands.find((band) => band.task === flowTask), decks: r.decks, hubs: r.hubs, arcs: r.paths.filter((p) => !p.closed).slice(0, 12).map(({ samples: _samples, ...rest }) => rest) };
      arcChecks(r, `${tag} near`);

      /* ---- Deck disclosure, both directions, on the settled (terminal) deck.
              A manual expand must re-open the deck's full footprint in its
              band — the band grows and nothing overlaps — and the collapse
              that follows must hand the chip height back. The toggle is a real
              click on the chip and on the deck's fold control; the layout
              hears it through the deck-disclosure event. */
      {
        const before = r;
        const deckKey = before.decks[0]?.key;
        const bandNodes = (reading: Reading) => reading.nodes.filter((node) => node.band === (reading.bands.find((band) => band.task === flowTask)?.id ?? "") && node.rect.w > 0 && node.rect.h > 0);
        const noOverlap = (reading: Reading, label: string) => {
          const list = bandNodes(reading);
          for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) must(!overlaps(list[i]!.rect, list[j]!.rect, 2), `${label}: ${list[i]!.key.slice(-20)} overlaps ${list[j]!.key.slice(-20)} after a deck toggle`);
        };
        /* On the narrow board the review band is taller than the viewport at
           100%, so the chip is wheeled into view first. */
        const chip = await bringSelectorOnScreen(page, "[data-review-deck-collapsed]");
        r = await read(page);
        if (!chip || !deckKey) must(false, `${tag}: the collapsed deck chip could not be brought on screen to expand`);
        else {
          await page.mouse.click(chip.x, chip.y);
          await page.waitForTimeout(1_500);
          const expanded = await read(page);
          await page.screenshot({ path: path.join(OUT_DIR, `${tag}-deck-expanded.png`) });
          const deckNow = expanded.decks.find((entry) => entry.key === deckKey);
          const bandNow = expanded.bands.find((band) => band.task === flowTask);
          const bandBefore = before.bands.find((band) => band.task === flowTask)!;
          must(deckNow?.expanded === true, `${tag}: clicking the chip did not expand the deck`);
          must((deckNow?.shell.h ?? 0) > 300 * expanded.camera.z, `${tag}: the expanded deck reserves only ${Math.round(deckNow?.shell.h ?? 0)}px — the band did not re-open its footprint`);
          must((bandNow?.rect.h ?? 0) > bandBefore.rect.h + 200 * expanded.camera.z, `${tag}: the band grew from ${Math.round(bandBefore.rect.h)} to ${Math.round(bandNow?.rect.h ?? 0)}px on expand — the deck does not fit`);
          must(deckNow !== undefined && bandNow !== undefined && deckNow.shell.y + deckNow.shell.h <= bandNow.rect.y + bandNow.rect.h + 1, `${tag}: the expanded deck spills below its band`);
          noOverlap(expanded, `${tag} deck expanded`);
          documentRule(expanded, `${tag} deck expanded`);
          const fold = await bringSelectorOnScreen(page, "[data-review-deck-collapse]");
          if (!fold) must(false, `${tag}: the expanded deck's fold control is not on screen`);
          else {
            await page.mouse.click(fold.x, fold.y);
            await page.waitForTimeout(1_600);
            const collapsed = await read(page);
            const deckBack = collapsed.decks.find((entry) => entry.key === deckKey);
            const bandBack = collapsed.bands.find((band) => band.task === flowTask);
            must(deckBack?.painted !== null && deckBack !== undefined && deckBack.shell.h <= deckBack.painted!.h + 1, `${tag}: after collapsing again the deck reserves ${Math.round(deckBack?.shell.h ?? 0)}px for its chip`);
            must(near(bandBack?.rect.h ?? 0, bandBefore.rect.h, 2), `${tag}: the band did not return to ${Math.round(bandBefore.rect.h)}px after collapse (now ${Math.round(bandBack?.rect.h ?? 0)})`);
            noOverlap(collapsed, `${tag} deck collapsed`);
          }
          frames.disclosure = { bandBefore: bandBefore.rect.h, bandExpanded: bandNow?.rect.h, deckExpanded: deckNow?.shell.h };
        }
        await panToBand(flowTask);
        r = await read(page);
        arcChecks(r, `${tag} near after disclosure round-trip`);
      }

      /* ---- The implementer opened: the reader sits where the tile was. */
      const implTile = await visiblePoint(page, `[data-scheme-node="${implementer}"]`);
      must(implTile !== null, `${tag}: the implementer tile is not on screen at 100%`);
      if (implTile) { await page.mouse.click(implTile.x, implTile.y); await page.waitForTimeout(1_500); }
      r = await read(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${tag}-near-selected.png`) });
      frames.nearSelected = { camera: r.camera, band: r.bands.find((band) => band.task === flowTask), decks: r.decks, node: r.nodes.find((node) => node.key === implementer) };
      arcChecks(r, `${tag} near selected`);

      /* ---- Physical card scaling within one presentation mode. The operator's
         actual complaint: a card must change size when the zoom changes. Two
         intermediate zooms (0.8 → 0.4), both showing summary tiles, so the
         presentation is fixed and only the camera moves. On screen every card
         must halve, and the review deck must scale by the identical factor —
         one coherent geometry, cards AND frames AND connectors together. */
      await page.keyboard.press("Escape");
      await zoomTo(page, 0.8, center);
      await page.waitForTimeout(500);
      r = await read(page);
      const tileAtBig = r.nodes.filter((node) => node.presentation === "summary" && node.rect.w > 0).map((node) => ({ key: node.key, w: node.rect.w }));
      const deckAtBig = r.decks[0]?.shell.w ?? 0;
      const bandWBig = r.bands.find((b) => b.task === flowTask)?.rect.w ?? 0;
      await zoomTo(page, 0.4, center);
      await page.waitForTimeout(600);
      r = await read(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${tag}-intermediate.png`) });
      const tileAtSmall = r.nodes.filter((node) => node.presentation === "summary");
      const ratios = tileAtBig.map((tile) => { const now = tileAtSmall.find((node) => node.key === tile.key); return now && now.rect.w > 0 ? now.rect.w / tile.w : null; }).filter((v): v is number => v !== null);
      const deckRatio = r.decks[0] && deckAtBig ? r.decks[0].shell.w / deckAtBig : null;
      const bandRatio = bandWBig ? (r.bands.find((b) => b.task === flowTask)?.rect.w ?? 0) / bandWBig : null;
      const tileR = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
      frames.intermediate = { from: 0.8, to: 0.4, tileRatios: ratios, deckRatio, bandRatio };
      /* Physical: on screen the card halves (0.4 / 0.8 = 0.5). The base build,
         which divided sizes by the zoom, held the tiles constant (ratio ~1). */
      must(tileR !== null && near(tileR, 0.5, 0.06), `${tag}: a summary tile scaled ${tileR?.toFixed(2)}× on screen between 80% and 40% zoom — cards do not follow the camera`);
      must(ratios.length > 0 && Math.max(...ratios) - Math.min(...ratios) < 0.06, `${tag}: sibling tiles scaled unevenly (${ratios.map((v) => v.toFixed(2)).join(", ")}×)`);
      /* Coherent: the deck and the band frame scale by the same factor. */
      if (deckRatio !== null && tileR !== null) must(near(deckRatio, tileR, 0.08), `${tag}: the deck scaled ${deckRatio.toFixed(2)}× while its tiles scaled ${tileR.toFixed(2)}× — two coordinate systems in one band`);
      if (bandRatio !== null && tileR !== null) must(near(bandRatio, tileR, 0.08), `${tag}: the band frame scaled ${bandRatio.toFixed(2)}× while its cards scaled ${tileR.toFixed(2)}×`);
      documentRule(r, `${tag} after pinch zoom`);

      /* ---- Every other camera mutation path, each through real input, each
              scaling the cards by exactly the camera's own factor and each
              landing on the document rule: the toolbar buttons (a real click),
              absolute 100% (the «1» key), fit current («0»), fit all (Shift+0),
              and the zoom keys. */
      const tilesOf = (reading: Reading) => reading.nodes.filter((node) => node.presentation === "summary" && node.rect.w > 0);
      const scaledLike = (before: Reading, after: Reading, label: string) => {
        const pairs = tilesOf(before).map((node) => { const now = after.nodes.find((entry) => entry.key === node.key); return now && now.rect.w > 0 ? now.rect.w / node.rect.w : null; }).filter((v): v is number => v !== null);
        const tile = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null;
        const cameraRatio = after.camera.z / before.camera.z;
        (frames as Record<string, unknown>)[`path_${label}`] = { from: before.camera, to: after.camera, tileRatios: pairs, cameraRatio };
        must(tile !== null && near(tile, cameraRatio, 0.06), `${tag} ${label}: the camera went ${before.camera.z.toFixed(2)}→${after.camera.z.toFixed(2)} (×${cameraRatio.toFixed(2)}) but tiles scaled ${tile?.toFixed(2)}×`);
        documentRule(after, `${tag} ${label}`);
      };
      const shellCovered: string[] = [];
      const mutate = async (label: string, act: () => Promise<string | null | void>) => {
        const before = await read(page);
        const covered = await act();
        if (covered && ATTENTION_COVER.test(covered)) { shellCovered.push(`${label}: ${covered}`); return before; }
        if (covered) must(false, `${tag} ${label}: ${covered}`);
        await page.waitForTimeout(600);
        const after = await read(page);
        scaledLike(before, after, label);
        return after;
      };
      await mutate("toolbar zoom in", () => clickControl(page, '[aria-label="Zoom in (+)"]'));
      await mutate("toolbar zoom out", () => clickControl(page, '[aria-label="Zoom out (−)"]'));
      await blurActive(page);
      let after = await mutate("absolute 100% (1)", () => page.keyboard.press("1"));
      must(near(after.camera.z, 1, 0.001), `${tag}: the «1» key left the camera at ${after.camera.z.toFixed(3)}`);
      after = await mutate("fit current (0)", () => page.keyboard.press("0"));
      must(near(after.camera.z, BAND_FIT_CURRENT_Z, 0.001) && near(after.camera.y, 0, 1), `${tag}: fit current framed z=${after.camera.z.toFixed(2)} y=${after.camera.y.toFixed(0)}`);
      await mutate("zoom key +", () => page.keyboard.press("+"));
      await mutate("zoom key -", () => page.keyboard.press("-"));
      /* Fit all drops to the chip presentation on purpose, so the tile ratio
         does not apply; the camera and the document rule do. */
      {
        const covered = await clickControl(page, '[aria-label^="Fit all content"]');
        if (covered && ATTENTION_COVER.test(covered)) { shellCovered.push(`fit all: ${covered}`); await blurActive(page); await page.keyboard.press("Shift+0"); }
        else if (covered) must(false, `${tag} fit all: ${covered}`);
      }
      await page.waitForTimeout(600);
      after = await read(page);
      must(near(after.camera.z, BAND_FIT_ALL_Z, 0.001) && near(after.camera.y, 0, 1), `${tag}: fit all framed z=${after.camera.z.toFixed(2)} y=${after.camera.y.toFixed(0)}`);
      documentRule(after, `${tag} fit all`);
      frames.shellCoveredToolbar = shellCovered;

      /* ---- Overview: still one geometry. */
      await zoomTo(page, 0.15, center);
      await page.waitForTimeout(600);
      r = await read(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${tag}-overview.png`) });
      frames.overview = { camera: r.camera, bands: r.bands.map((band) => ({ id: band.id, h: band.rect.h, members: band.members, overhang: band.rect.y + band.rect.h - band.paintedBottom })) };
      /* The band chrome (header + pads + one row gap) scales with the camera,
         so the allowance does too; a regression that reserved a full deck box
         would add ~810 × zoom on top and blow past it. Only bands fully inside
         the viewport are judged — a virtualized off-screen band reports no
         members and a meaningless painted bottom. */
      const chrome = (BAND_HEADER + BAND_PAD * 3 + BAND_ROWGAP) * r.camera.z + 4;
      must(r.bands.filter((band) => band.members > 0 && band.rect.y >= 0 && band.rect.y + band.rect.h <= r.canvas.h).every((band) => band.rect.y + band.rect.h - band.paintedBottom <= chrome), `${tag} overview: a band hangs far below its content`);
      documentRule(r, `${tag} overview`);

      /* ---- Click-to-open frames the EXACT clicked conversation, from every
              zoom entry and on a repeat open. A click must land the operator on
              the card they clicked, opened as its reader, framed the way the
              camera promised — head near the top, whole when it fits, inside
              the viewport across — and settled once. */
      /** Wheel the conversation's surface to the middle of the viewport. A
          surface outside the viewport is virtualized to a zero rect and gives
          no direction, so the search first returns to the top of the stack
          and then walks down in steps shorter than the viewport. */
      const bringOnScreen = async (key: string): Promise<Pt | null> => {
        const at = await canvasPoint(page, 0.02, 0.5);
        const measurable = async () => { const node = (await read(page)).nodes.find((entry) => entry.key === key); return Boolean(node && node.rect.h > 0 && node.rect.w > 0); };
        if (!(await measurable())) {
          await page.mouse.move(at.x, at.y);
          for (let up = 0; up < 6 && (await read(page)).camera.y < -1; up += 1) { await page.mouse.wheel(0, -2_000); await page.waitForTimeout(120); }
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const reading = await read(page);
          const node = reading.nodes.find((entry) => entry.key === key);
          if (node && node.rect.h > 0 && node.rect.w > 0) {
            const delta = node.rect.y + node.rect.h / 2 - reading.canvas.h / 2;
            if (Math.abs(delta) < 50) {
              return (await visiblePoint(page, `[data-scheme-chip="${key}"]`))
                ?? (await visiblePoint(page, `[data-scheme-summary="${key}"]`))
                ?? (await visiblePoint(page, `[data-scheme-node="${key}"]`));
            }
          }
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(0, node && node.rect.h > 0 ? Math.max(-500, Math.min(500, node.rect.y + node.rect.h / 2 - reading.canvas.h / 2)) : 300);
          await page.waitForTimeout(150);
        }
        return null;
      };
      /** The framing an open promises (`centredCamera`): the reader's head
          near the top — at 8% of the viewport plus the 40px title allowance —
          or centred when the whole pane is short enough for that. */
      const framedCheck = (reading: Reading, key: string, label: string) => {
        const node = reading.nodes.find((entry) => entry.key === key);
        must(node !== undefined && node.presentation === "native", `${label}: the clicked conversation opened as ${node?.presentation ?? "nothing"}, not as its reader`);
        if (!node) return;
        const expectedTop = Math.min(reading.canvas.h / 2, reading.canvas.h * 0.08 + 40 * reading.camera.z);
        must(near(node.rect.y, expectedTop, 4), `${label}: the opened reader's top sits at ${Math.round(node.rect.y)}px, promised ${Math.round(expectedTop)}px (camera y ${reading.camera.y.toFixed(1)}, z ${reading.camera.z.toFixed(2)})`);
        if (node.rect.h <= reading.canvas.h - expectedTop) must(node.rect.y + node.rect.h <= reading.canvas.h + 1, `${label}: the opened reader fits the viewport (${Math.round(node.rect.h)}px tall) but its bottom is ${Math.round(node.rect.y + node.rect.h - reading.canvas.h)}px below the fold`);
        if (node.rect.w <= reading.canvas.w) must(node.rect.x >= -1 && node.rect.x + node.rect.w <= reading.canvas.w + 1, `${label}: the opened reader runs off the side of the viewport (x ${Math.round(node.rect.x)}, w ${Math.round(node.rect.w)} in ${reading.canvas.w})`);
        must(node.rect.w * node.rect.h > 0.18 * reading.canvas.w * reading.canvas.h, `${label}: the opened conversation covers ${Math.round(100 * node.rect.w * node.rect.h / (reading.canvas.w * reading.canvas.h))}% of the viewport`);
        documentRule(reading, label);
      };
      const openAndVerify = async (entryZoom: number, key: string, label: string) => {
        await page.keyboard.press("Escape");
        await zoomTo(page, entryZoom, center);
        await page.waitForTimeout(300);
        const point = await bringOnScreen(key);
        must(point !== null, `${tag} ${label}: could not bring ${key.slice(-24)} on screen at ${Math.round(entryZoom * 100)}%`);
        if (!point) return;
        await page.mouse.click(point.x, point.y);
        await page.waitForTimeout(1_000);
        const settled1 = await read(page);
        await page.waitForTimeout(700);
        const settled2 = await read(page);
        const node = settled2.nodes.find((entry) => entry.key === key);
        (frames as Record<string, unknown>)[`click_${label}`] = { entryZoom, after: settled2.camera, node: node ? { presentation: node.presentation, rect: node.rect } : null };
        framedCheck(settled2, key, `${tag} ${label}`);
        /* And the camera has settled — one framing, not a drift. */
        must(near(settled1.camera.y, settled2.camera.y, 1.5) && near(settled1.camera.z, settled2.camera.z, 0.001), `${tag} ${label}: the camera kept moving after the click settled (${settled1.camera.y.toFixed(0)}→${settled2.camera.y.toFixed(0)}, z ${settled1.camera.z.toFixed(2)}→${settled2.camera.z.toFixed(2)})`);
      };
      await openAndVerify(0.15, sibling, "overview-entry");
      await openAndVerify(0.5, sibling, "intermediate-entry");
      await openAndVerify(0.95, sibling, "near-entry");
      /* Repeat opens: a different card, then back — each frames its own exact
         conversation, never the one opened before. */
      await openAndVerify(0.5, sibling2, "repeat-other");
      await openAndVerify(0.5, sibling, "repeat-back");
      await page.screenshot({ path: path.join(OUT_DIR, `${tag}-after-click.png`) });

      /* ---- Keyboard navigation from the open reader: an Arrow hands the
              selection ring to a neighbouring surface (on the band board the
              band itself is one) and glides the camera — the spatial-nav
              framing path. Down, because an open reader spans its row and has
              nothing to its right on the narrow board. The nav must have
              consumed the key, and the camera it settled on obeys the rule. */
      {
        const announced = () => page.evaluate(() => document.querySelector("[aria-live]")?.textContent ?? "");
        const before = await read(page);
        const said = await announced();
        await blurActive(page);
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(900);
        const moved = await read(page);
        const saidNow = await announced();
        (frames as Record<string, unknown>).arrowNav = { from: before.camera, to: moved.camera, announced: saidNow.slice(0, 80) };
        must(saidNow !== said || moved.nodes.find((node) => node.presentation === "native")?.key !== sibling, `${tag} arrow nav: ArrowDown moved nothing (live region "${saidNow.slice(0, 60)}")`);
        documentRule(moved, `${tag} arrow nav`);
      }

      /* ---- A resize with a reader open: the anchor keeps the reader's
              vertical place, the document rule keeps the band stack on the
              viewport's left edge, and the reader stays inside the narrower
              viewport instead of being pushed past its right edge. */
      {
        await page.keyboard.press("Escape");
        await openAndVerify(0.5, sibling, "before-resize");
        const before = await read(page);
        /* A real resize kept on the desktop side of the shell's mobile
           breakpoint (a width OR height below it replaces the board with the
           phone surface): the wide viewport shrinks on both axes, the narrow
           one — already at the breakpoint on both — widens. This probes the
           camera's resize path, not the shell's. */
        const smaller = tag === "wide"
          ? { width: Math.round(viewportSize.width * 0.82), height: Math.round(viewportSize.height * 0.82) }
          : { width: 1000, height: viewportSize.height };
        await page.setViewportSize(smaller);
        await page.waitForSelector('[aria-label^="Agent board"]', { timeout: 30_000 });
        await page.waitForTimeout(1_200);
        const resized = await read(page);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-after-resize.png`) });
        const reader = resized.nodes.find((node) => node.key === sibling);
        (frames as Record<string, unknown>).resize = { from: before.camera, to: resized.camera, canvas: resized.canvas, reader: reader?.rect ?? null };
        documentRule(resized, `${tag} after resize`);
        must(reader !== undefined && reader.presentation === "native" && reader.rect.x >= -1 && (reader.rect.w > resized.canvas.w || reader.rect.x + reader.rect.w <= resized.canvas.w + 1), `${tag} after resize: the open reader runs ${reader ? Math.round(reader.rect.x + reader.rect.w - resized.canvas.w) : 0}px past the right edge of the ${resized.canvas.w}px viewport`);
        must(reader !== undefined && reader.rect.y >= -1 && reader.rect.y + Math.min(reader.rect.h, 140) <= resized.canvas.h + 1, `${tag} after resize: the open reader's head left the viewport (y ${reader ? Math.round(reader.rect.y) : 0})`);
        await page.setViewportSize({ width: viewportSize.width, height: viewportSize.height });
        await page.waitForTimeout(1_000);
      }

      /* ---- Restore: a reload puts the saved camera back exactly, and the
              restored camera obeys the document rule. */
      {
        await page.keyboard.press("Escape");
        await zoomTo(page, 0.7, center);
        await page.waitForTimeout(700);
        const before = await read(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
        await page.waitForTimeout(2_500);
        const restored = await read(page);
        /* Two legitimate outcomes. The shell may reopen the conversation it
           had open (the URL names it): the board then mounts with a focus
           standing and owes that conversation its framing (#1625), which is
           the catalog-open path. Otherwise the saved camera comes back exactly
           as it was. Either way the document rule holds. */
        const reopened = restored.nodes.find((node) => node.presentation === "native");
        (frames as Record<string, unknown>).restore = { before: before.camera, after: restored.camera, reopened: reopened?.key.slice(-24) ?? null };
        if (reopened) framedCheck(restored, reopened.key, `${tag} restore (reopened conversation)`);
        else must(near(restored.camera.z, before.camera.z, 0.001) && near(restored.camera.y, before.camera.y, 1) && near(restored.camera.x, before.camera.x, 1), `${tag} restore: the reload framed z=${restored.camera.z.toFixed(2)} (${restored.camera.x.toFixed(0)},${restored.camera.y.toFixed(0)}) instead of z=${before.camera.z.toFixed(2)} (${before.camera.x.toFixed(0)},${before.camera.y.toFixed(0)})`);
        documentRule(restored, `${tag} restore`);
      }

      /* ---- Wheel routing, through Chromium's input pipeline.

         The board pans over everything but a scroll container it can hand the
         wheel to. Pan probes run with the reader CLOSED and the board at an
         intermediate scale, so every band control is short and on screen; the
         feed probe then opens a reader and scrolls its text; a generic scroll
         box — no selector the board knows — keeps the wheel too. */
      const wheel: Record<string, { cameraDy: number; feedDy: number; scrollerDy: number }> = {};
      const panTopMemberBand = async () => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const bands = (await read(page)).bands.filter((entry) => entry.members > 0);
          if (!bands.length) return false;
          const top = bands.reduce((a, b) => (a.rect.y < b.rect.y ? a : b));
          const delta = top.rect.y - 88;
          if (Math.abs(delta) < 4) return true;
          const at = await canvasPoint(page, 0.02, 0.5);
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(0, Math.max(-600, Math.min(600, delta)));
          await page.waitForTimeout(150);
        }
        return true;
      };
      await page.keyboard.press("Escape");
      await zoomTo(page, 0.5, center);
      const bandBackground = async () => {
        const reading = await read(page);
        const band = reading.bands.find((entry) => entry.members > 0 && entry.rect.y + 40 >= 0 && entry.rect.y + 80 < reading.canvas.h);
        if (!band) return null;
        const c = await canvasPoint(page, 0, 0);
        return { x: c.x + band.rect.x + 6, y: c.y + Math.min(band.rect.y + band.rect.h - 12, band.rect.y + 120) };
      };
      const panProbes: [string, () => Promise<Pt | null>][] = [
        ["band background", bandBackground],
        ["Details", () => firstVisiblePoint(page, "[data-scheme-band-details]")],
        ["+ Agent", () => firstVisiblePoint(page, "[data-scheme-band-add]")],
        ["collapsed card", () => firstVisiblePoint(page, "[data-scheme-summary]")],
      ];
      for (const [name, locate] of panProbes) {
        await panTopMemberBand();
        const at = await locate();
        if (!at) { wheel[name] = { cameraDy: Number.NaN, feedDy: Number.NaN, scrollerDy: Number.NaN }; must(false, `${tag}: wheel probe "${name}" has no target on screen`); continue; }
        wheel[name] = await wheelAt(page, at);
      }
      /* A generic scroll box inside a card — injected with no data attribute
         the board could recognise, the shape of any bounded panel a card may
         grow — keeps the wheel for its own content. */
      {
        await panTopMemberBand();
        const injected = await page.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
          const host = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-summary]")).find((el) => { const r = el.getBoundingClientRect(); return r.top > canvas.top + 4 && r.bottom < canvas.bottom - 4 && r.width > 60; });
          if (!host) return null;
          const box = document.createElement("div");
          box.id = "llv-geometry-probe-scroller";
          box.style.cssText = "position:absolute;left:8px;top:40px;width:120px;height:60px;overflow-y:auto;background:rgba(0,0,0,.04)";
          const filler = document.createElement("div");
          filler.style.height = "600px";
          box.appendChild(filler);
          host.appendChild(box);
          const r = box.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (!injected) { wheel["generic scroll box"] = { cameraDy: Number.NaN, feedDy: Number.NaN, scrollerDy: Number.NaN }; must(false, `${tag}: no summary tile on screen to host the generic scroll box`); }
        else wheel["generic scroll box"] = await wheelAt(page, injected);
        await page.evaluate(() => document.getElementById("llv-geometry-probe-scroller")?.remove());
      }

      /* The open reader keeps the wheel for its own text. Near zoom so the
         selected conversation is its native reader; the wheel scrolls UP, away
         from the feed's pinned tail, and the camera must not move. */
      await zoomTo(page, 1, center);
      await panTopMemberBand();
      const summary = await firstVisiblePoint(page, "[data-scheme-summary]");
      if (summary) { await page.mouse.click(summary.x, summary.y); await page.waitForTimeout(1_400); }
      let feed: Pt | null = null;
      for (let pan = 0; pan < 24 && !feed; pan += 1) {
        feed = await firstVisiblePoint(page, '[data-scheme-node-presentation="native"] [data-log-feed-scroller]');
        if (feed) break;
        const at = await canvasPoint(page, 0.02, 0.5);
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(150);
      }
      if (!feed) { wheel["open reader feed"] = { cameraDy: Number.NaN, feedDy: Number.NaN, scrollerDy: Number.NaN }; must(false, `${tag}: the open reader's feed is not on screen`); }
      else wheel["open reader feed"] = await wheelAt(page, feed, -300);
      frames.wheel = wheel;
      for (const name of ["band background", "Details", "+ Agent", "collapsed card"]) {
        const got = wheel[name]!;
        must(got.cameraDy < -100, `${tag}: a wheel over ${name} moved the camera ${Math.round(got.cameraDy)}px — the board did not pan`);
      }
      must(wheel["generic scroll box"]!.scrollerDy > 20 && Math.abs(wheel["generic scroll box"]!.cameraDy) < 1, `${tag}: a wheel over a generic scroll box scrolled it ${Math.round(wheel["generic scroll box"]!.scrollerDy)}px and moved the camera ${Math.round(wheel["generic scroll box"]!.cameraDy)}px`);
      must(wheel["open reader feed"]!.feedDy > 20 && Math.abs(wheel["open reader feed"]!.cameraDy) < 1, `${tag}: a wheel over the open reader's text scrolled the feed ${Math.round(wheel["open reader feed"]!.feedDy)}px and moved the camera ${Math.round(wheel["open reader feed"]!.cameraDy)}px`);

      report[tag] = frames;
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "measurements.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`measurements: ${path.join(OUT_DIR, "measurements.json")}`);
  console.log(`frames: ${OUT_DIR}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`board geometry acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("board geometry acceptance passed at wide and narrow viewports across overview, intermediate and near zoom, on every camera mutation path.");
  }
}

await main();
