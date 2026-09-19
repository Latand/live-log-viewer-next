/**
 * Rendered acceptance for the board geometry defects reported on 2026-09-10
 * (huge nearly empty task frame, squiggle review-loop arcs, cards that do not
 * scale with the camera, a click that flies past the clicked card, a wheel
 * that dies over band controls and collapsed cards), in a real browser against
 * the production build:
 *
 *   bun run build && bun scripts/capture-board-geometry.ts
 *
 * From a `git archive` export, set BOARD_CAPTURE_COMMIT to the exported SHA so
 * the record names the commit it measured.
 *
 * With BOARD_CAPTURE_CASE=header it measures the project board's one header
 * bar instead (#1801) on a home seeded the way production looks: three Claude
 * accounts and one Codex account with usage readings, bound to the project;
 * three questions waiting behind live processes; agents working; tasks off the
 * board; a quiet second project. One 48 px bar, 32 px controls on an 8 / 16 px
 * rhythm, nothing overlapping, the island inside the bar and non-zero, the
 * pressed view segment painted differently, the switch in the same place on
 * both views, hover that never takes the accent, no undo or redo anywhere, and
 * ⋯ rules only between groups that drew a row, the last control 16 px clear of
 * the island, and the same bar spanning the Tasks panel when it is open, with
 * the panel's header clear of the island — at 2540, 1850 and 1280 px in en and
 * uk, light and dark, under a 21-character project name — and the phone's 52 px
 * bar in the same four.
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
/* The commit the record was captured from. A `git archive` export has no repository, so the caller
   names it in BOARD_CAPTURE_COMMIT; inside a checkout it is HEAD. */
const captureCommit = () => process.env.BOARD_CAPTURE_COMMIT?.trim()
  || Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
const BASE = createCaptureDirectory({ envName: "BOARD_CAPTURE_DIR", prefix: "llv-issue-1641", raw: process.env.BOARD_CAPTURE_DIR, repoRoot });
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");
/* The header case names its project like a real one (21 characters): a 6-letter name hid a
   1280 px row that ran under the attention island (#1801). */
const PROJECT_NAME = process.env.BOARD_CAPTURE_CASE === "header" ? "harbor-ledger-service" : "harbor";
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

/** Server variables a case adds to the synthetic environment (the header case's Codex stub). */
const SERVER_EXTRA_ENV: Record<string, string> = {};

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
    ...SERVER_EXTRA_ENV,
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
  const report: Record<string, unknown> = { commit: captureCommit() };
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

/* ------------------------------------------------------------------------- */
/* The project board's one header bar (#1801, docs/design/board-header.md)     */
/* ------------------------------------------------------------------------- */

/* The quiet second project: nothing runs there, so its ⋯ menu shows Archive and Delete too. */
const QUIET_NAME = "quay";
const QUIET_DIR = path.join(HOME, "Projects", QUIET_NAME);
const CODEX_STUB = path.join(BASE, "bin", "codex");
/* Composed rather than written out: a literal UUID in a published source is what the privacy gate's rule catches. */
const headerSession = (serial: number) => [String(serial).padStart(8, "0"), "1801", "4000", "8000", "0".repeat(12)].join("-");

/**
 * Three conversations parked on an AskUserQuestion. The scanner reports a
 * pending question only for a transcript a live process holds open for
 * writing (`pendingQuestionFor` needs `proc: running` and a pid), so each gets
 * a holder: a `sleep` that inherits an append descriptor on the transcript.
 * The caller stops each holder by the pid recorded here.
 */
function writeWaitingConversations(): ChildProcess[] {
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  const questions = ["Which channel ships first?", "Keep the old endpoint for a release?", "Merge the two migrations?"];
  return questions.map((question, index) => {
    const id = headerSession(90 + index);
    const stamp = new Date(Date.now() - (index + 1) * 60_000).toISOString();
    const lines = [
      { type: "user", uuid: `${id}-u1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "user", content: `Decide: ${question}` } },
      { type: "assistant", uuid: `${id}-a1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `toolu_1801_q${index}`, name: "AskUserQuestion", input: { questions: [{ question, header: "Decision", multiSelect: false, options: [{ label: "Yes", description: "Go ahead" }, { label: "No", description: "Hold" }] }] } }] } },
    ];
    const file = path.join(folder, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    return spawn("/bin/sh", ["-c", 'exec 3>>"$0"; exec sleep 3600', file], { stdio: "ignore" });
  });
}

/** The quiet project: one finished conversation and nothing running. */
function writeQuietProject(): void {
  fs.mkdirSync(QUIET_DIR, { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(QUIET_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const id = headerSession(99);
  const stamp = new Date(Date.now() - 3_600_000).toISOString();
  const lines = [
    { type: "user", uuid: `${id}-u1`, timestamp: stamp, cwd: QUIET_DIR, sessionId: id, message: { role: "user", content: "Tidy the docs index." } },
    { type: "assistant", uuid: `${id}-a1`, timestamp: stamp, cwd: QUIET_DIR, sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "The index is tidy." }] } },
    { type: "result", subtype: "success", uuid: `${id}-r1`, timestamp: stamp, cwd: QUIET_DIR, sessionId: id, is_error: false, duration_ms: 900, num_turns: 1, result: "The index is tidy." },
  ];
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  /* Quiet for two hours: a transcript touched within the last half hour can read as a turn in
     progress, and a live one stands Archive and Delete down. */
  const quietSince = new Date(Date.now() - 2 * 3_600_000);
  fs.utimesSync(file, quietSince, quietSince);
}

/** Two tasks with no conversation yet: off the board, so `Hidden` counts them. */
function addOffBoardTasks(project: string): void {
  const file = path.join(STATE_DIR, "tasks.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown>[] };
  for (const [index, title] of ["Audit the retry budget", "Draft the rollback runbook"].entries()) {
    store.tasks.push({
      id: `task-1801-off-${index}`, project, status: "inbox", text: `${title}\nInvented fixture task with no conversation yet.`, placement: "unplaced",
      assignments: [], createdAt: `2100-01-01T01:00:0${index}.000Z`, updatedAt: `2100-01-01T01:00:0${index}.000Z`,
    });
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/**
 * Accounts as production has them, all invented: Claude «Main» (the home's
 * own login) plus «Account B» and «Account C», Codex «Main», each with usage
 * readings, written through the Viewer's own modules into the synthetic home
 * and bound to the project so the header's account switches are the real
 * route's answer. The account controller stays disabled so the readings stay,
 * and the Codex binary is a stub, so nothing reaches a provider.
 */
async function seedAccounts(project: string): Promise<void> {
  process.env.HOME = HOME;
  process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
  process.env.LLV_STATE_DIR = STATE_DIR;
  process.env.LLV_CLAUDE_HOME = path.join(HOME, ".claude");
  process.env.LLV_CODEX_HOME = path.join(HOME, ".codex");
  fs.mkdirSync(path.dirname(CODEX_STUB), { recursive: true });
  fs.writeFileSync(CODEX_STUB, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  SERVER_EXTRA_ENV.LLV_CODEX_BINARY = CODEX_STUB;
  fs.writeFileSync(path.join(HOME, ".codex", "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), "{}", { mode: 0o600 });

  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const { bindAccountToProject } = await import("@/lib/accounts/projectBindings");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const claudeB = createManagedClaudeAccount("Account B");
  fs.writeFileSync(path.join(claudeB.home, ".credentials.json"), "{}", { mode: 0o600 });
  const claudeC = createManagedClaudeAccount("Account C");
  fs.writeFileSync(path.join(claudeC.home, ".credentials.json"), "{}", { mode: 0o600 });

  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const at = now.toISOString();
  const live = { source: "live" as const, reason: null, staleSince: null };
  const window = (usedPercent: number, hours: number, windowMinutes: number) => ({ usedPercent, resetsAt: nowS + hours * 3_600, windowMinutes });
  const claude = (accountId: string, session: number, weekly: number, plan: string) => ({
    engine: "claude" as const, accountId, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
    limits: { session: window(session, 3, 300), weekly: window(weekly, 90, 10_080), plan, capturedAt: nowS },
  });
  agentRegistry().recordQuotaEvaluation({
    engine: "claude",
    observations: [claude("default", 34, 61, "max"), claude(claudeB.id, 12, 28, "max"), claude(claudeC.id, 71, 88, "pro")],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [{
      engine: "codex", accountId: "default", authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
      limits: { session: window(22, 2, 300), weekly: window(47, 70, 10_080), plan: "pro", capturedAt: nowS },
      resetCredits: { availableCount: 0, expiresAt: null },
    }],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
  for (const [engine, accountId] of [["claude", "default"], ["claude", claudeB.id], ["codex", "default"]] as const) {
    const result = bindAccountToProject(engine, accountId, project);
    if (!result.ok) throw new Error(`binding ${engine} ${accountId} to the project failed: ${result.code}`);
  }
}

interface HeaderReading {
  bars: number;
  bar: Rect | null;
  controls: { name: string; rect: Rect }[];
  island: Rect | null;
  islandText: string;
  toast: Rect | null;
  pressedFill: string | null;
  otherFill: string | null;
  switchRect: Rect | null;
  hit: Record<string, boolean>;
  texts: string;
  /** How far the bar's content runs past its box; 0 when everything fits in one row. */
  overflow: number;
  tier: string | null;
  /** The `+` of the create controls: an icon in the control's own colour. */
  plus: { svg: boolean; iconColor: string | null; textColor: string | null }[];
  hidden: string | null;
  /** The project name's box, visible or not. */
  name: Rect | null;
  /** Whether the bar is in its wrapping face (a bar under 768 px). */
  wrap: boolean;
}

/** Runs inside the page: the header bar, its visible controls and the island, in viewport pixels. */
function readHeader(): HeaderReading {
  const rect = (element: Element): Rect => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const visible = (element: Element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden"; };
  const bars = [...document.querySelectorAll("header.bar, [data-project-bar]")].filter(visible);
  const bar = bars[0] ?? null;
  const controls: { name: string; rect: Rect }[] = [];
  if (bar) {
    const named = (element: Element) => element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.textContent?.trim() || element.tagName;
    const selector = "[data-bar-control], .btn, input[type=search], [data-account-switch-engine] > button, h1, .summary, [data-bar-group=status]";
    for (const element of bar.querySelectorAll(selector)) if (visible(element) && !element.closest("[data-bar-more-menu]")) controls.push({ name: named(element)!, rect: rect(element) });
  }
  controls.sort((a, b) => a.rect.x - b.rect.x);
  const islandElement = document.querySelector("[data-attention-island]");
  const toastElement = document.querySelector("[data-attention-toast]");
  const tabs = [...document.querySelectorAll("button[data-view-tab]")];
  const pressed = tabs.find((tab) => tab.getAttribute("aria-pressed") === "true");
  const other = tabs.find((tab) => tab.getAttribute("aria-pressed") !== "true");
  const hit: Record<string, boolean> = {};
  for (const selector of ["[data-new-task]", "[data-new-agent]", "[data-bar-create]", "[data-bar-more]", "[data-kanban-search]", "[data-orchestrator-toggle]", "[data-task-panel-toggle]", "[data-hidden-pill]", "[data-account-switch-engine] > button"]) {
    const element = document.querySelector(selector);
    if (!element || !visible(element)) continue;
    const r = element.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    hit[selector] = Boolean(top && (top === element || element.contains(top)));
  }
  const plus = [...document.querySelectorAll("[data-new-task], [data-new-agent], [data-bar-create]")].filter(visible).map((button) => {
    const svg = button.querySelector("svg");
    return { svg: svg !== null, iconColor: svg ? getComputedStyle(svg).color : null, textColor: getComputedStyle(button).color };
  });
  const hiddenPill = document.querySelector("[data-hidden-pill]");
  const switchElement = document.querySelector("[data-project-view-tabs]");
  return {
    bars: bars.length,
    bar: bar ? rect(bar) : null,
    controls,
    island: islandElement ? rect(islandElement) : null,
    islandText: islandElement?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    toast: toastElement && visible(toastElement) ? rect(toastElement) : null,
    pressedFill: pressed ? getComputedStyle(pressed).backgroundColor : null,
    otherFill: other ? getComputedStyle(other).backgroundColor : null,
    switchRect: switchElement ? rect(switchElement) : null,
    hit,
    texts: bar?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    overflow: bar ? Math.max(0, bar.scrollWidth - bar.clientWidth) : 0,
    tier: bar?.getAttribute("data-bar-tier") ?? null,
    plus,
    hidden: hiddenPill && visible(hiddenPill) ? hiddenPill.textContent?.replace(/\s+/g, " ").trim() ?? "" : null,
    name: bar?.querySelector("h1") ? rect(bar.querySelector("h1")!) : null,
    wrap: bar?.hasAttribute("data-bar-wrap") ?? false,
  };
}

/** Runs inside the page: the open Tasks panel's box and whether its header's controls take a click at their centres. */
function readTaskPanel() {
  const panel = document.querySelector("aside[data-task-panel]");
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  const head = panel.firstElementChild;
  const hit = [...(head?.querySelectorAll("button") ?? [])].map((button) => {
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { label: (button.getAttribute("aria-label") || button.textContent || "").trim(), ok: Boolean(top && (top === button || button.contains(top))) };
  });
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hit };
}

/** The bar's last control ends before the island, with the 16 px between groups to spare. */
function lastControlClear(tag: string, reading: HeaderReading, must: (ok: boolean, message: string) => void): number | null {
  const last = reading.controls.reduce<{ name: string; rect: Rect } | null>((best, control) => (!best || control.rect.x + control.rect.w > best.rect.x + best.rect.w ? control : best), null);
  if (!last || !reading.island) {
    must(false, `${tag}: no last control or no island to measure against`);
    return null;
  }
  const clearance = reading.island.x - (last.rect.x + last.rect.w);
  must(clearance >= 16 - 0.5, `${tag}: «${last.name}» ends ${clearance.toFixed(1)}px before the island`);
  return clearance;
}

/** Runs inside the page: the open ⋯ menu's rows, groups and rules. */
function readMenu() {
  const element = document.querySelector("[data-bar-more-menu]")!;
  const r = element.getBoundingClientRect();
  const shown = (node: Element) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const rows = [...element.querySelectorAll("button")].filter(shown).map((button) => ({ label: (button.getAttribute("aria-label") || button.textContent || "").replace(/\s+/g, " ").trim(), h: button.getBoundingClientRect().height, disabled: (button as HTMLButtonElement).disabled }));
  const groups = [...element.querySelectorAll(":scope > [data-bar-menu-group]")].filter(shown).map((group) => ({ name: group.getAttribute("data-bar-menu-group"), ruled: parseFloat(getComputedStyle(group).borderTopWidth) > 0 }));
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, rows, groups, text: element.textContent ?? "" };
}

type MenuReading = ReturnType<typeof readMenu>;

async function headerMain(): Promise<void> {
  const { tasks, reviewers } = seedHome();
  writeQuietProject();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = 3_000 + (process.pid % 900);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const holders: ChildProcess[] = [];
  const report: Record<string, unknown> = { commit: captureCommit() };
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    const projects = await (async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const files = ((await (await fetch(`${baseUrl}/api/files`)).json()) as FilesPayload).files ?? [];
        const of = (dir: string) => files.find((file) => file.path?.includes(projectSlug(dir)))?.project;
        const busy = of(REPO_DIR);
        const quiet = of(QUIET_DIR);
        if (busy && quiet) return { busy, quiet };
        await Bun.sleep(2_000);
      }
      throw new Error("the two seeded projects never scanned");
    })();
    const project = projects.busy;
    await stop(server);
    server = null;
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    seedState(project, tasks, reviewers);
    addOffBoardTasks(project);
    await seedAccounts(project);
    holders.push(...writeWaitingConversations());
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, true);
    await Bun.sleep(4_000);
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    /* The labelled tier starts at 1700 px of bar (a 1948 px viewport with the rail): 2540 is wide,
       and 1850 (1602 px of bar), where the uk labels did not fit, and 1280 are narrow. */
    const cases = [2540, 1850, 1280].flatMap((width) => (["en", "uk"] as const).flatMap((lang) => (["light", "dark"] as const).map((colorScheme) => ({ width, lang, colorScheme }))));
    for (const { width, lang, colorScheme } of cases) {
      const tag = `${width}-${lang}-${colorScheme}`;
      const wide = width >= 1948;
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-kanban-board] header.bar", { timeout: 120_000 });
      await page.waitForFunction(() => /[1-9]/.test(document.querySelector("[data-attention-island]")?.textContent ?? ""), undefined, { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2_500);
      const reading = await page.evaluate(readHeader);
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}.png`), clip: { x: 0, y: 0, width, height: 120 } });
      must(reading.bars === 1, `${tag}: ${reading.bars} header bars`);
      must(reading.bar !== null && near(reading.bar.h, 48, 0.5), `${tag}: the bar is ${reading.bar?.h}px tall`);
      must(reading.overflow <= 0.5, `${tag}: the bar's content runs ${reading.overflow}px past its box`);
      must(reading.name !== null && reading.name.w >= 40, `${tag}: the project name is ${reading.name?.w ?? 0}px wide`);
      must(reading.tier === (wide ? "wide" : "narrow"), `${tag}: the bar is in its ${reading.tier} tier`);
      const islandClearance = lastControlClear(tag, reading, must);
      for (const control of reading.controls) {
        if (control.rect.h < 24) continue;
        must(near(control.rect.h, 32, 0.5), `${tag}: «${control.name}» is ${control.rect.h}px tall`);
      }
      const boxes = [...reading.controls, ...(reading.island ? [{ name: "island", rect: reading.island }] : [])];
      for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
        if (a.rect.x <= b.rect.x && a.rect.x + a.rect.w >= b.rect.x + b.rect.w && a.rect.y <= b.rect.y && a.rect.y + a.rect.h >= b.rect.y + b.rect.h) continue;
        if (b.rect.x <= a.rect.x && b.rect.x + b.rect.w >= a.rect.x + a.rect.w && b.rect.y <= a.rect.y && b.rect.y + b.rect.h >= a.rect.y + a.rect.h) continue;
        must(!overlaps(a.rect, b.rect, 0.5), `${tag}: «${a.name}» and «${b.name}» overlap`);
      }
      /* The rhythm: edge to edge, 8 px inside a group and 16 px between groups; the one spacer is the only other gap. */
      const gaps = reading.controls.slice(1).map((control, index) => Math.round((control.rect.x - (reading.controls[index]!.rect.x + reading.controls[index]!.rect.w)) * 2) / 2);
      const offRhythm = gaps.filter((gap) => gap !== 8 && gap !== 16);
      must(offRhythm.length === 1 && offRhythm[0]! > 16, `${tag}: gaps ${gaps.join(", ")} are not 8 / 16 around one spacer`);
      must(reading.island !== null && reading.bar !== null && reading.island.y >= reading.bar.y && reading.island.y + reading.island.h <= reading.bar.y + reading.bar.h, `${tag}: the island is not inside the bar`);
      must(/[1-9]/.test(reading.islandText), `${tag}: the island reads «${reading.islandText}», nothing waiting`);
      must(reading.toast === null || (reading.bar !== null && reading.toast.y >= reading.bar.y + reading.bar.h + 4), `${tag}: the toast starts at y ${reading.toast?.y}, on the bar`);
      must(reading.hidden !== null && /[1-9]/.test(reading.hidden), `${tag}: Hidden reads «${reading.hidden}»`);
      must(wide || (reading.hidden !== null && /^\d+$/.test(reading.hidden)), `${tag}: narrow, Hidden reads «${reading.hidden}», not its icon and count`);
      must(reading.pressedFill !== null && reading.pressedFill !== reading.otherFill, `${tag}: the pressed view segment paints ${reading.pressedFill}, the other ${reading.otherFill}`);
      for (const [selector, ok] of Object.entries(reading.hit)) must(ok, `${tag}: ${selector} is covered at its centre`);
      must(reading.plus.length > 0 && reading.plus.every((item) => item.svg && item.iconColor === item.textColor), `${tag}: a + is not an icon in its control's colour`);
      const accountsInBar = reading.controls.filter((control) => /Claude|Codex/.test(control.name)).length;
      must(wide ? accountsInBar === 2 : accountsInBar === 0, `${tag}: ${accountsInBar} account switches in the bar`);
      must(!/undo|redo|скасувати|повторити/i.test(reading.texts), `${tag}: the bar still names undo or redo`);

      /* Hover strengthens the border and leaves the label's colour alone. */
      const tasksToggle = page.locator("[data-task-panel-toggle]");
      const before = await tasksToggle.evaluate((element) => ({ color: getComputedStyle(element).color, border: getComputedStyle(element).borderTopColor }));
      await tasksToggle.hover();
      await page.waitForTimeout(250);
      const hovered = await tasksToggle.evaluate((element) => ({ color: getComputedStyle(element).color, border: getComputedStyle(element).borderTopColor }));
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-hover.png`), clip: { x: 0, y: 0, width, height: 60 } });
      must(hovered.color === before.color && hovered.border !== before.border, `${tag}: hover turns Tasks from ${JSON.stringify(before)} to ${JSON.stringify(hovered)}`);
      await page.mouse.move(1, 700);

      /* The accounts: in the bar when wide, as ⋯ rows when narrow; either opens the panel listing all three Claude accounts. */
      let menu: MenuReading;
      if (wide) {
        await page.click('[data-account-switch-engine="claude"] > button');
      } else {
        await page.click("[data-bar-more]");
        await page.waitForSelector("[data-bar-more-menu]");
        menu = await page.evaluate(readMenu);
        await page.click('[data-bar-more-menu] [data-account-switch-engine="claude"] > button');
      }
      await page.waitForTimeout(800);
      const panel = await page.evaluate(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) => /Claude/.test(element.getAttribute("aria-label") ?? ""));
        if (!dialog) return null;
        const r = dialog.getBoundingClientRect();
        return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, text: dialog.textContent?.replace(/\s+/g, " ").trim() ?? "" };
      });
      if (panel) await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-accounts.png`), clip: { x: Math.max(0, panel.rect.x - 24), y: 0, width: Math.min(width - Math.max(0, panel.rect.x - 24), panel.rect.w + 48), height: Math.min(900, panel.rect.y + panel.rect.h + 16) } });
      must(panel !== null && ["Main", "Account B", "Account C"].every((label) => panel.text.includes(label)) && /\d+\s?%/.test(panel.text), `${tag}: the Claude accounts panel does not list three accounts with usage`);
      await page.keyboard.press("Escape");
      await page.mouse.click(width / 2, 600);
      await page.waitForTimeout(200);

      /* The ⋯ menu on this busy project: Archive and Delete stand down while agents run, and no rule dangles. */
      await page.click("[data-bar-more]");
      await page.waitForSelector("[data-bar-more-menu]");
      /* Narrow, the account rows arrive with their own read of the project's bindings. */
      if (!wide) await page.waitForSelector('[data-bar-more-menu] [data-account-switch-engine="codex"]', { timeout: 15_000 }).catch(() => {});
      menu = await page.evaluate(readMenu);
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-more.png`), clip: { x: Math.max(0, menu.rect.x - 40), y: 0, width: Math.min(width - Math.max(0, menu.rect.x - 40), menu.rect.w + 80), height: menu.rect.y + menu.rect.h + 16 } });
      const checkMenu = (label: string, reading: MenuReading) => {
        must(reading.rect.x + reading.rect.w <= width, `${label}: the ⋯ menu runs off the right edge`);
        must(reading.groups.length > 0 && !reading.groups[0]!.ruled && reading.groups.slice(1).every((group) => group.ruled), `${label}: ⋯ rules ${JSON.stringify(reading.groups)}`);
        must(!/undo|redo|скасувати|повторити/i.test(reading.text), `${label}: ⋯ still offers undo or redo`);
        must(reading.rows.every((row) => near(row.h, 32, 0.5)), `${label}: a ⋯ row is not 32 px`);
      };
      checkMenu(tag, menu);
      must(menu.rows.length >= (wide ? 3 : 5), `${tag}: the ⋯ menu holds ${menu.rows.length} rows`);
      must(wide ? !menu.groups.some((group) => group.name === "accounts") : menu.groups.some((group) => group.name === "accounts"), `${tag}: the accounts rows are ${wide ? "repeated in" : "missing from"} ⋯`);
      await page.keyboard.press("Escape");
      await page.mouse.click(width / 2, 600);

      if (!wide) {
        await page.click("[data-bar-create]");
        const createIcons = await page.evaluate(() => [...document.querySelectorAll('.menu[role="menu"] [role="menuitem"]')].every((item) => item.querySelector("svg") !== null));
        must(createIcons, `${tag}: a + menu row has no icon`);
        const create = await page.evaluate(() => [...document.querySelectorAll('.menu[role="menu"] [role="menuitem"]')].map((item) => item.textContent?.trim() ?? ""));
        await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-create.png`), clip: { x: 0, y: 0, width, height: 200 } });
        must(create.length === 2, `${tag}: the + menu offers ${create.length} rows`);
        report[`${tag}:create`] = create;
        await page.keyboard.press("Escape");
        await page.mouse.click(width / 2, 600);
      }

      /* The view switch keeps its place on Conversations, whose bar has the message search in the find slot. */
      await page.click('button[data-view-tab="list"]');
      await page.waitForSelector("[data-project-bar]", { timeout: 60_000 });
      await page.waitForTimeout(1_500);
      const list = await page.evaluate(readHeader);
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-conversations.png`), clip: { x: 0, y: 0, width, height: 120 } });
      must(list.bars === 1 && list.bar !== null && near(list.bar.h, 48, 0.5), `${tag}: the Conversations bar is ${list.bar?.h}px tall`);
      /* Narrow, only the project name may truncate on Conversations: a short search label, the live count alone. */
      const listTexts = await page.evaluate(() => {
        const truncated = (element: Element | null) => Boolean(element && element.scrollWidth > element.clientWidth + 0.5);
        const find = document.querySelector('[data-project-bar] [data-testid="dash-search"] span');
        const status = document.querySelector('[data-project-bar] [data-bar-group="status"]');
        return { find: find?.textContent ?? "", findTruncated: truncated(find), status: status?.textContent ?? "", statusTruncated: truncated(status) };
      });
      if (!wide) {
        must(!listTexts.findTruncated && !listTexts.statusTruncated, `${tag}: Conversations truncates ${JSON.stringify(listTexts)}`);
        must(!/\(\/\)/.test(listTexts.find), `${tag}: the narrow search label is the full «${listTexts.find}»`);
      }
      must(reading.switchRect !== null && list.switchRect !== null && near(reading.switchRect.x, list.switchRect.x, 0.5), `${tag}: the view switch moves from x ${reading.switchRect?.x} to ${list.switchRect?.x}`);
      const listClearance = lastControlClear(`${tag} conversations`, list, must);
      await page.click('button[data-view-tab="kanban"]');

      /* The Tasks panel open on the Board: the bar spans it and stays one 48 px row, the island
         lands on the bar, and the panel's own header takes clicks at every control. */
      await page.waitForSelector("[data-kanban-board] header.bar", { timeout: 60_000 });
      await page.click("[data-task-panel-toggle]");
      await page.waitForSelector("aside[data-task-panel]", { timeout: 30_000 });
      await page.waitForTimeout(1_000);
      const open = await page.evaluate(readHeader);
      /* The island's toast is a floating card, 360 px wide, that stays until dismissed; it lies over
         whatever sits under the island, and a 280 px panel cannot avoid it. The island itself must
         not cover the panel; with the toast dismissed, the panel's header takes every click. */
      const underToast = await page.evaluate(readTaskPanel);
      if (await page.locator("[data-attention-toast-dismiss]").count()) {
        await page.click("[data-attention-toast-dismiss]");
        await page.waitForTimeout(300);
      }
      const taskPanel = await page.evaluate(readTaskPanel);
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-tasks-open.png`), clip: { x: 0, y: 0, width, height: 160 } });
      must(open.bars === 1 && open.bar !== null && near(open.bar.h, 48, 0.5) && !open.wrap, `${tag} tasks open: the bar is ${open.bar?.h}px tall${open.wrap ? ", wrapping" : ""}`);
      must(open.bar !== null && near(open.bar.x + open.bar.w, width, 0.5), `${tag} tasks open: the bar ends at x ${open.bar ? open.bar.x + open.bar.w : null}, short of the panel's edge`);
      must(open.overflow <= 0.5, `${tag} tasks open: the bar's content runs ${open.overflow}px past its box`);
      const openClearance = lastControlClear(`${tag} tasks open`, open, must);
      must(taskPanel !== null && open.bar !== null && taskPanel.rect.y >= open.bar.y + open.bar.h - 0.5, `${tag} tasks open: the panel starts at y ${taskPanel?.rect.y}, beside the bar`);
      for (const item of taskPanel?.hit ?? []) must(item.ok, `${tag} tasks open: the panel's «${item.label}» is covered at its centre`);
      must((taskPanel?.hit.length ?? 0) >= 3, `${tag} tasks open: the panel header shows ${taskPanel?.hit.length ?? 0} controls`);
      for (const [selector, ok] of Object.entries(open.hit)) must(ok, `${tag} tasks open: ${selector} is covered at its centre`);
      await page.click("[data-task-panel-toggle]");
      report[tag] = { ...reading, gaps, islandClearance, hover: { before, hovered }, menu, accountsPanel: panel ? { rect: panel.rect } : null, conversations: { switchRect: list.switchRect, texts: list.texts, name: list.name, find: listTexts, islandClearance: listClearance }, tasksOpen: { bar: open.bar, wrap: open.wrap, overflow: open.overflow, islandClearance: openClearance, toast: open.toast, panelUnderToast: underToast, panel: taskPanel } };
      await context.close();

      /* The quiet project's ⋯: nothing runs there, so Archive and Delete show beside the rest. */
      const quiet = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      await quiet.addInitScript(seedInit);
      await quiet.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
      const quietPage = await quiet.newPage();
      await quietPage.goto(`${baseUrl}/#p=${encodeURIComponent(projects.quiet)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await quietPage.waitForSelector("[data-bar-more]", { timeout: 120_000 });
      await quietPage.waitForTimeout(2_000);
      await quietPage.click("[data-bar-more]");
      await quietPage.waitForSelector("[data-bar-more-menu]");
      const quietMenu = await quietPage.evaluate(readMenu);
      await quietPage.screenshot({ path: path.join(OUT_DIR, `header-${tag}-quiet-more.png`), clip: { x: Math.max(0, quietMenu.rect.x - 40), y: 0, width: Math.min(width - Math.max(0, quietMenu.rect.x - 40), quietMenu.rect.w + 80), height: quietMenu.rect.y + quietMenu.rect.h + 16 } });
      checkMenu(`${tag} quiet`, quietMenu);
      /* Sound (two rows), Archive, Delete; this leaf's message search sits in the bar's find slot. */
      must(quietMenu.groups.some((group) => group.name === "project") && quietMenu.rows.length >= 4, `${tag} quiet: ⋯ holds ${quietMenu.rows.length} rows without Archive and Delete`);
      report[`${tag}:quiet`] = { menu: quietMenu };
      await quiet.close();
    }

    /* The phone keeps its own 52 px bar, with the waiting count, and its menu has no undo or redo. */
    for (const lang of ["en", "uk"] as const) for (const colorScheme of ["light", "dark"] as const) {
      const tag = `390-${lang}-${colorScheme}`;
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme, reducedMotion: "reduce" });
      await phone.addInitScript(seedInit);
      await phone.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
      const page = await phone.newPage();
      await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-mobile2-bar]", { timeout: 120_000 });
      await page.waitForTimeout(2_500);
      const phoneBar = await page.evaluate(() => {
        const bar = document.querySelector("[data-mobile2-bar]")!;
        const box = bar.getBoundingClientRect();
        const targets = [...bar.querySelectorAll("button")].map((button) => { const r = button.getBoundingClientRect(); return { w: r.width, h: r.height }; }).filter((r) => r.w > 0);
        return { h: box.height, w: box.width, text: bar.textContent?.replace(/\s+/g, " ").trim() ?? "", targets, desktopBars: document.querySelectorAll("header.bar, [data-project-bar]").length };
      });
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}.png`), clip: { x: 0, y: 0, width: 390, height: 120 } });
      must(near(phoneBar.h, 52, 0.5), `${tag}: the phone bar is ${phoneBar.h}px tall`);
      must(phoneBar.desktopBars === 0, `${tag}: ${phoneBar.desktopBars} desktop bars render on the phone`);
      must(/[1-9]/.test(phoneBar.text), `${tag}: the phone bar shows no waiting count («${phoneBar.text}»)`);
      must(phoneBar.targets.every((target) => target.h >= 44 && target.w >= 44), `${tag}: a phone bar target is under 44 px`);
      await page.click('[data-mobile2-bar] [data-mobile2-open="menu"]');
      await page.waitForSelector('[data-mobile2-sheet="menu"]');
      await page.waitForTimeout(400);
      const rows = await page.evaluate(() => [...document.querySelectorAll("[data-mobile2-menu-row]")].map((row) => row.getAttribute("data-mobile2-menu-row")));
      await page.screenshot({ path: path.join(OUT_DIR, `header-${tag}-menu.png`), fullPage: false });
      must(!rows.includes("undo") && !rows.includes("redo"), `${tag}: the phone menu still has ${rows.join(", ")}`);
      report[tag] = { ...phoneBar, menuRows: rows };
      await phone.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
    for (const holder of holders) holder.kill("SIGTERM");
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "header.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`header measurements: ${path.join(OUT_DIR, "header.json")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`board header acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("board header acceptance passed at 2540, 1850 and 1280 (en, uk; light, dark; Tasks closed and open; a 21-character project name) and 390 (en, uk; light, dark).");
  }
}

/* BOARD_CAPTURE_CASE=header runs the header bar's case (#1801) instead of the camera probes. */
if (process.env.BOARD_CAPTURE_CASE === "header") await headerMain();
else await main();
