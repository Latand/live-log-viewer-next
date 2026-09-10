/**
 * Rendered acceptance for #1614, in a real browser against the production
 * build, at the scale the operator reported:
 *
 *   bun run build && bun scripts/capture-issue-1614-board.ts
 *
 * Serves the production build against a purpose-built synthetic home under the
 * temp root — its own HOME, XDG dirs, TMPDIR, viewer state dir and provider
 * homes — so nothing here reads or writes the operator's live state, and no
 * real path appears in any frame. Nothing is deployed.
 *
 * The board is seeded with the reported corpus: ~390 tasks, of which a handful
 * hold agents, and ~680 conversations. Then, at 100% and 160%, in the select
 * AND hand tools, it measures what render-string tests cannot:
 *
 *   - how many bands a 390-task board draws, and how many tasks the task list
 *     still holds (nothing may be deleted or archived);
 *   - the width of an empty band against the width of the canvas;
 *   - the hit target of Details, «+ Agent», the status pill and «Remove from
 *     board»: `elementFromPoint` at each control's own centre must resolve to
 *     that control, in both tools and at both scales;
 *   - a real pointer click, dispatched by the browser at those coordinates,
 *     and the effect it produced in the running app;
 *   - the interaction cost at this scale: the time from the click to the
 *     board's next painted frame, and the long tasks the main thread ran.
 *
 * It then proves it can go red. Each defect class is reintroduced on the live
 * page — a band stretched back to the canvas width, a control returned to the
 * disabled/pointer-events-none state the hand tool used to give it — and the
 * audit must flag it. A run where the mutated board still passes exits
 * non-zero, so a green run means the audit could actually see a defect.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { CONVERSATION_LIST_PAGE_SIZE } from "@/components/ConversationList";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "BOARD_CAPTURE_DIR",
  prefix: "llv-issue-1614",
  raw: process.env.BOARD_CAPTURE_DIR,
  repoRoot,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");

/** The reported scale. */
const CONVERSATIONS = 680;
const TASKS = 390;
/** Tasks that actually hold an agent — the bands that must survive everything. */
const STAFFED = 6;
/** Tasks whose agent ran once and whose conversation the board no longer draws
    — the 319 of the operator's 385 empty bands that a history-based rule keeps
    and a membership-based one removes. */
const HISTORICAL = 300;
const PROJECT_NAME = "board";

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const line = (record: Record<string, unknown>) => JSON.stringify(record) + "\n";

function conversationFile(index: number): { file: string; uuid: string } {
  const cwd = path.join(HOME, "Projects", PROJECT_NAME);
  const folder = path.join(HOME, ".claude/projects", projectSlug(cwd));
  fs.mkdirSync(folder, { recursive: true });
  const uuid = `${String(index + 1).padStart(8, "0")}-2222-4222-8222-222222222222`;
  return { file: path.join(folder, `${uuid}.jsonl`), uuid };
}

/**
 * The corpus. The first {@link STAFFED} conversations are made distinctly the
 * freshest, because the board draws a bounded window of the most recent cards
 * per project: a staffed task whose conversation fell outside that window would
 * be a different (and also correct) case — a durable association with nothing
 * on screen — and this capture wants both, not one by accident.
 */
function seedConversations(): string[] {
  const cwd = path.join(HOME, "Projects", PROJECT_NAME);
  fs.mkdirSync(cwd, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    const { file, uuid } = conversationFile(index);
    const stamp = "2100-01-02T09:00:00.000Z";
    const title = `Agent ${index} keeps watch over area ${index}`;
    fs.writeFileSync(
      file,
      line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
      + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${title} — recorded.` }] } }),
      "utf8",
    );
    const ageMs = index < STAFFED ? 60_000 + index * 1_000 : (4 * 3600 * 1000) + index * 1_000;
    fs.utimesSync(file, new Date(stamp), new Date(Date.now() - ageMs));
    paths.push(file);
  }
  return paths;
}

/** One more conversation, written while the browser is watching: a real scan
    update for the agent list to survive (see `walkAgentList`). */
function seedOneMoreConversation(): void {
  const { file, uuid } = conversationFile(CONVERSATIONS);
  const cwd = path.join(HOME, "Projects", PROJECT_NAME);
  const stamp = "2100-01-02T09:00:00.000Z";
  const title = "Agent arriving mid-scroll";
  fs.writeFileSync(
    file,
    line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
    + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${title} — recorded.` }] } }),
    "utf8",
  );
}

function seedHome(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
}

/**
 * The task corpus, written straight into the state file the way a board that
 * has been in use for months holds it. The reported board is not a few hundred
 * never-launched tasks: of 385 empty bands, 319 carried an assignment row
 * pointing at a conversation the board no longer draws, and only 66 had no row
 * at all. Reading the row alone leaves those 319 on the canvas, so the corpus
 * seeded here has the same shape —
 *
 *   - {@link STAFFED} tasks assigned to conversations inside the board's own
 *     window, whose bands hold real members;
 *   - {@link HISTORICAL} tasks assigned to conversations that exist on disk but
 *     sit far outside that window, so the board draws none of them — the
 *     historical link that must not keep an empty band;
 *   - the rest with no assignment at all.
 *
 * No `migrations` key — the running server's own one-time migration is what
 * must decide their board membership.
 */
function seedTasks(project: string, conversations: string[]): void {
  const tasks = Array.from({ length: TASKS }, (_, index) => {
    const staffed = index < STAFFED;
    const historical = !staffed && index < STAFFED + HISTORICAL;
    /* The board draws a bounded window of the most recent cards per project, so
       a staffed task points at a conversation from the START of the corpus —
       the freshest, the part the window holds — and its band therefore has real
       members. A historical task points at the OLDEST end, which the window
       does not reach: the row is intact, the transcript is intact, and the
       board has nothing to draw for it. */
    const held = staffed ? conversations[index]! : conversations[conversations.length - 1 - index]!;
    const created = new Date(Date.UTC(2100, 0, 1, 0, index % 60, 0)).toISOString();
    return {
      id: `task-${String(index).padStart(4, "0")}-4000-8000-a00000000000`,
      project,
      status: !staffed && index % 4 === 3 ? "done" : "assigned",
      text: staffed
        ? `Staffed task ${index}\nAn agent is on this one.`
        : historical
          ? `Historical task ${index}\nAn agent ran on this months ago; the board no longer carries it.`
          : `Untouched task ${index}\nRecorded months ago and never launched.`,
      placement: "unplaced",
      /* Path-keyed, with no conversation id: the shape a spawn records before
         the scanner has attributed a Viewer conversation to it. An id the
         scanner does not know would resolve to nothing — `resolve()` in the
         workflow projection does not fall back to the path once an id is set. */
      assignments: staffed || historical
        ? [{ path: held, conversationId: null, panePid: null, state: "delivered", error: null, at: created }]
        : [],
      createdAt: created,
      updatedAt: created,
    };
  });
  fs.writeFileSync(path.join(STATE_DIR, "tasks.json"), JSON.stringify({ tasks }, null, 2) + "\n", "utf8");
}

/**
 * The server's environment. Every variable that decides where the Viewer reads
 * and writes is overridden to the synthetic home, and every stray `LLV_*` the
 * caller happened to export is dropped, so this run cannot reach the
 * operator's state. The rest of the environment is inherited because
 * `bun --bun` needs it: handed a minimal env it fails module resolution with
 * "Expected CommonJS module to have a function wrapper" before serving a byte.
 */
function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const config = path.join(HOME, ".config");
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("LLV_") || name.startsWith("__NEXT_PRIVATE")) delete inherited[name];
  }
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

/**
 * The Viewer is served under Bun in production (`package.json`'s own start
 * command, and the image's CMD). Two ways to get this wrong, both of which
 * answer 500 on every route rather than failing at boot:
 *
 *   - `bunx next start` hands the server to Node, where the SQLite state
 *     stores refuse to load and the instrumentation hook crash-loops;
 *   - a Bun older than the pin in the Dockerfile cannot load Next's own
 *     compiled `app-page.runtime.prod.js` or the middleware bundle
 *     ("Expected CommonJS module to have a function wrapper").
 *
 * So the capture serves under the very interpreter that is running it: run
 * this script with the pinned Bun and the evidence is taken under it too.
 * `scripts/verify-viewer-runtime.ts` is the check that says whether a given
 * interpreter can serve this build at all.
 */
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
    try {
      if ((await fetch(`${url}/api/files`)).ok) return;
    } catch { /* still booting */ }
    await Bun.sleep(400);
  }
  throw new Error("production server did not become ready");
}

interface FilesPayload {
  files?: { path?: string; project?: string }[];
  tasks?: {
    id: string;
    project: string;
    board?: string;
    assignments: { path?: string | null; conversationId?: string | null }[];
  }[];
  scan?: { durationMs?: number };
}

/**
 * Waits for the scan to settle.
 *
 * Two different numbers, deliberately: the board draws a bounded window of
 * cards per project (`schemeWindowConfig`), while the catalog serves the whole
 * corpus behind a cursor. So the board is waited on by its own window being
 * full and the seeded tasks being visible, and the catalog's 680 are counted
 * from the endpoint that actually serves them.
 */
async function waitForBoard(baseUrl: string, expectTasks: boolean): Promise<FilesPayload> {
  const deadline = Date.now() + 180_000;
  let last = 0;
  while (Date.now() < deadline) {
    const payload = await (await fetch(`${baseUrl}/api/files`)).json() as FilesPayload;
    last = (payload.files ?? []).length;
    if (last > 0 && (!expectTasks || (payload.tasks ?? []).length > 0)) return payload;
    await Bun.sleep(2_000);
  }
  throw new Error(`scan never produced a board window; last saw ${last} cards`);
}

/** The catalog's own total, from the endpoint the agent list pages through. */
async function catalogTotal(baseUrl: string, project: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/conversations?limit=1&project=${encodeURIComponent(project)}`);
  const page = await response.json() as { total?: number };
  return page.total ?? 0;
}

async function stop(server: ChildProcess | null): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (server.exitCode === null && Date.now() < deadline) await Bun.sleep(200);
  if (server.exitCode === null) server.kill("SIGKILL");
}

/* ------------------------------------------------------------------------- */
/* In-page audit                                                              */
/* ------------------------------------------------------------------------- */

interface ControlProbe {
  band: string;
  control: string;
  /** The control's own centre, in viewport coordinates. */
  x: number; y: number; width: number; height: number;
  /** What a pointer at that centre actually reaches. */
  hit: string;
  hitsSelf: boolean;
  /** True when the occluder is visible, interactive board chrome that floats
      above the canvas by design (the tool palette, the edge-chip nav). */
  occludedByChrome: boolean;
  disabled: boolean;
  pointerEvents: string;
}

interface BoardAudit {
  bands: number;
  /** Bands drawn for a recorded task — the population this issue is about. */
  taskBands: number;
  /** Task bands showing `0 conversations`: the ones that filled the board. */
  emptyTaskBands: number;
  canvasWidth: number;
  emptyBandWidths: number[];
  staffedBandWidths: number[];
  widestBand: number;
  fullWidthBands: number;
  probes: ControlProbe[];
  deadControls: ControlProbe[];
  wrongHitControls: ControlProbe[];
  chromeOccludedControls: ControlProbe[];
  zoomPercent: string;
  tool: string;
}

/** Runs inside the page. Kept self-contained: playwright serializes it. */
function auditBoard(): BoardAudit {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]');
  if (!viewport) throw new Error("no board viewport");
  const canvas = viewport.getBoundingClientRect();
  const bandNodes = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]"));

  const describe = (element: Element | null): string => {
    if (!element) return "none";
    const named = element.closest<HTMLElement>("[data-scheme-band-details], [data-scheme-band-status], [data-scheme-band-add], [data-scheme-band-remove], [data-scheme-band-title]");
    if (named) {
      for (const attribute of ["data-scheme-band-details", "data-scheme-band-status", "data-scheme-band-add", "data-scheme-band-remove", "data-scheme-band-title"]) {
        if (named.hasAttribute(attribute)) return attribute;
      }
    }
    const band = element.closest<HTMLElement>("[data-scheme-band]");
    return band ? "band-surface" : element.tagName.toLowerCase();
  };

  const isTaskBand = (band: HTMLElement) => band.getAttribute("data-scheme-band-origin") === "task";
  const isEmpty = (band: HTMLElement) => /0 conversations/.test(band.querySelector("[data-scheme-band-counts]")?.textContent ?? "");

  const probes: ControlProbe[] = [];
  for (const band of bandNodes.slice(0, 24)) {
    const id = band.getAttribute("data-scheme-band") ?? "?";
    for (const selector of ["[data-scheme-band-details]", "[data-scheme-band-status]", "[data-scheme-band-add]", "[data-scheme-band-remove]"]) {
      const control = band.querySelector<HTMLElement>(selector);
      if (!control) continue;
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      /* Only points actually inside the visible board can be clicked at all. */
      if (x < canvas.left || x > canvas.right || y < canvas.top || y > canvas.bottom) continue;
      const hitElement = document.elementFromPoint(x, y);
      const hitsSelf = Boolean(hitElement && control.contains(hitElement));
      /* Chrome that floats above the board on purpose is not this issue's
         defect: the operator can see it and moves the canvas. What must never
         happen is a control covered by something invisible or decorative. */
      const occludedByChrome = !hitsSelf && Boolean(
        hitElement?.closest("[data-scheme-ui]") && !hitElement.closest("[data-scheme-band]"),
      );
      probes.push({
        band: id,
        control: selector.replace(/[[\]]/g, ""),
        x, y, width: rect.width, height: rect.height,
        hit: describe(hitElement),
        hitsSelf,
        occludedByChrome,
        disabled: (control as HTMLButtonElement).disabled === true,
        pointerEvents: getComputedStyle(control).pointerEvents,
      });
    }
  }

  const widthOf = (band: HTMLElement) => band.getBoundingClientRect().width;
  const emptyBandWidths: number[] = [];
  const staffedBandWidths: number[] = [];
  for (const band of bandNodes) (isEmpty(band) ? emptyBandWidths : staffedBandWidths).push(widthOf(band));
  const widths = bandNodes.map(widthOf);
  const zoomLabel = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-ui] *"))
    .map((node) => node.textContent ?? "").find((text) => /^\d+%$/.test(text.trim())) ?? "?";
  const pressedTool = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-ui] button"))
    .find((button) => button.getAttribute("aria-pressed") === "true" || button.getAttribute("data-active") === "true");

  return {
    bands: bandNodes.length,
    taskBands: bandNodes.filter(isTaskBand).length,
    emptyTaskBands: bandNodes.filter((band) => isTaskBand(band) && isEmpty(band)).length,
    canvasWidth: canvas.width,
    emptyBandWidths,
    staffedBandWidths,
    widestBand: widths.length ? Math.max(...widths) : 0,
    /* The reported defect: a band as wide as the canvas it sits on. */
    fullWidthBands: widths.filter((width) => width >= canvas.width - 56).length,
    probes,
    deadControls: probes.filter((probe) => probe.disabled || probe.pointerEvents === "none"),
    wrongHitControls: probes.filter((probe) => !probe.hitsSelf && !probe.occludedByChrome),
    chromeOccludedControls: probes.filter((probe) => probe.occludedByChrome),
    zoomPercent: zoomLabel.trim(),
    tool: pressedTool?.getAttribute("title") ?? "?",
  };
}

/* --- deliberate defects, so the audit is shown going red ------------------- */

/** Stretch every band back across the canvas — the pre-fix geometry. */
function reintroduceFullWidthBands(): void {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]');
  const width = viewport ? viewport.getBoundingClientRect().width : 1440;
  for (const band of Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]"))) {
    band.style.width = `${width}px`;
  }
}

/** Put the band controls back in the state the hand tool used to give them. */
function reintroduceDeadControls(): void {
  for (const control of Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band-details], [data-scheme-band-status], [data-scheme-band-add], [data-scheme-band-remove]"))) {
    (control as HTMLButtonElement).disabled = true;
    control.style.pointerEvents = "none";
  }
}

/** Lay a transparent sheet over the header, so every control hits it instead. */
function reintroduceOverlappedControls(): void {
  for (const band of Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]"))) {
    const shim = document.createElement("div");
    shim.setAttribute("data-audit", "overlap-shim");
    shim.style.cssText = "position:absolute;inset:0;background:transparent;pointer-events:auto;z-index:99;";
    band.appendChild(shim);
  }
}

/* ------------------------------------------------------------------------- */

interface Interaction {
  control: string;
  clicked: boolean;
  /** Milliseconds from the real click to the board's next painted frame. */
  responseMs: number;
  longTasksMs: number;
  effect: string;
}

const seedInit = (seed: { project: string; z: number; tool: string; y: number }) => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
  localStorage.setItem("llvSchemeMode", seed.tool);
  sessionStorage.setItem(`llvCam:${seed.project}`, JSON.stringify({ x: 0, y: seed.y, z: seed.z }));
};

async function openBoard(browser: Browser, baseUrl: string, project: string, zoom: number, tool: string, cameraY = 0): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "no-preference" });
  await context.addInitScript(seedInit, { project, z: zoom, tool, y: cameraY });
  const page = await context.newPage();
  /* The app opens on Overview; the board lives behind the project hash route. */
  await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
  /* Let the board settle at the requested camera before anything is measured. */
  await page.waitForTimeout(2_500);
  return page;
}

/**
 * A real click, by the browser, at the control's own centre — then the cost of
 * it: the time until the board paints again, and the long tasks the main
 * thread ran while doing so.
 */
async function clickAndMeasure(page: Page, probe: ControlProbe, effect: () => Promise<string>): Promise<Interaction> {
  await page.evaluate(() => {
    const store = globalThis as unknown as { __llvLongTasks?: number; __llvObserver?: PerformanceObserver };
    store.__llvLongTasks = 0;
    store.__llvObserver?.disconnect();
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.__llvLongTasks = (store.__llvLongTasks ?? 0) + entry.duration;
      });
      observer.observe({ entryTypes: ["longtask"] });
      store.__llvObserver = observer;
    } catch { /* long tasks unsupported */ }
  });
  const started = Date.now();
  await page.mouse.click(probe.x, probe.y);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const responseMs = Date.now() - started;
  const longTasksMs = await page.evaluate(() => (globalThis as unknown as { __llvLongTasks?: number }).__llvLongTasks ?? 0);
  return { control: probe.control, clicked: true, responseMs, longTasksMs, effect: await effect() };
}

/**
 * The cost of moving the board, measured without touching a control — so the
 * SAME measurement can be taken on a build whose controls cannot be reached at
 * all. Twelve wheel-zoom steps over the canvas, then: wall time, the frames the
 * page actually painted in that window, and the main-thread long tasks it ran.
 * This is the number requirement 5 is about, and it is what says whether the
 * reported lag reproduces at this scale.
 */
interface CanvasCost {
  bands: number;
  steps: number;
  elapsedMs: number;
  frames: number;
  longTasksMs: number;
  longTaskCount: number;
  worstLongTaskMs: number;
}

async function measureCanvasCost(page: Page, bands: number): Promise<CanvasCost> {
  await page.evaluate(() => {
    const store = globalThis as unknown as { __llvCost?: { long: number; count: number; worst: number; frames: number }; __llvObs?: PerformanceObserver; __llvRaf?: number };
    store.__llvCost = { long: 0, count: 0, worst: 0, frames: 0 };
    store.__llvObs?.disconnect();
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.__llvCost!.long += entry.duration;
          store.__llvCost!.count += 1;
          store.__llvCost!.worst = Math.max(store.__llvCost!.worst, entry.duration);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      store.__llvObs = observer;
    } catch { /* long tasks unsupported */ }
    const tick = () => { store.__llvCost!.frames += 1; store.__llvRaf = requestAnimationFrame(tick); };
    store.__llvRaf = requestAnimationFrame(tick);
  });
  const steps = 12;
  const started = Date.now();
  await page.mouse.move(700, 500);
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, step % 2 === 0 ? -220 : 220);
    await page.keyboard.up("Control");
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const elapsedMs = Date.now() - started;
  const cost = await page.evaluate(() => {
    const store = globalThis as unknown as { __llvCost?: { long: number; count: number; worst: number; frames: number }; __llvObs?: PerformanceObserver; __llvRaf?: number };
    if (store.__llvRaf) cancelAnimationFrame(store.__llvRaf);
    store.__llvObs?.disconnect();
    return store.__llvCost ?? { long: 0, count: 0, worst: 0, frames: 0 };
  });
  return { bands, steps, elapsedMs, frames: cost.frames, longTasksMs: Math.round(cost.long), longTaskCount: cost.count, worstLongTaskMs: Math.round(cost.worst) };
}

/* ------------------------------------------------------------------------- */
/* Requirement 4: the desktop agent list, walked the way an operator walks it  */
/* ------------------------------------------------------------------------- */

/**
 * Counting the catalog endpoint's `total` says nothing about whether an
 * operator can reach a single row of it. This is the whole journey, in the
 * browser: find the board/list switch, hit-test it, click it, read the first
 * page, scroll — with the wheel, not a button — until it has loaded several
 * more, hold it through a real scan update, open an agent from it, come back.
 *
 * The switch is here because it is where the journey used to end: the
 * dashboard floated it at the board's own top-left corner, under the tool
 * palette, so `elementFromPoint` at the centre of «conversations» returned the
 * task tool and the click created a task instead of opening the list.
 */
interface SwitchProbe {
  found: boolean;
  x: number; y: number; width: number; height: number;
  hit: string;
  hitsSelf: boolean;
  disabled: boolean;
  pointerEvents: string;
}

interface ListJourney {
  pageSize: number;
  catalogTotal: number;
  switchOnBoard: SwitchProbe;
  switchOnList: SwitchProbe;
  firstPage: number;
  scrollSteps: number[];
  /** Rows the list holds after the same scroll is repeated post-reload. */
  deepRows: number;
  usedFallbackButton: boolean;
  filesUpdatesObserved: number;
  afterUpdate: number;
  opened: { path: string; hitsSelf: boolean; hashMatched: boolean; onScreen: boolean };
  afterReopen: number;
  /** The board is still one click away at the end of the round trip. */
  boardCameBack: boolean;
  redChecks: Record<string, boolean>;
}

/** Runs inside the page: the switch, and what a pointer at its centre reaches. */
function probeViewSwitch(label: string): SwitchProbe {
  const empty = { found: false, x: 0, y: 0, width: 0, height: 0, hit: "none", hitsSelf: false, disabled: true, pointerEvents: "none" };
  const button = document.querySelector<HTMLElement>(`button[aria-pressed][aria-label="${label}"]`);
  if (!button) return empty;
  const rect = button.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return empty;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  const named = hit?.closest("[aria-label]");
  return {
    found: true,
    x, y, width: rect.width, height: rect.height,
    hit: named?.getAttribute("aria-label") ?? hit?.tagName.toLowerCase() ?? "none",
    hitsSelf: Boolean(hit && button.contains(hit)),
    disabled: (button as HTMLButtonElement).disabled === true,
    pointerEvents: getComputedStyle(button).pointerEvents,
  };
}

const countListRows = () => document.querySelectorAll("[data-conversation-list-row]").length;

/** Lay a transparent sheet over the switch — the shape of the reported defect,
    where the tool palette was drawn over it. The probe must see it. */
function reintroduceCoveredViewSwitch(label: string): void {
  const button = document.querySelector<HTMLElement>(`button[aria-pressed][aria-label="${label}"]`);
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const shim = document.createElement("div");
  shim.setAttribute("data-audit", "switch-shim");
  shim.setAttribute("aria-label", "audit shim");
  shim.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:transparent;pointer-events:auto;z-index:9999;`;
  document.body.appendChild(shim);
}

/** Cut the list back to one page and take the sentinel away — a list that
    cannot page, which is what requirement 4 says must not ship. */
function reintroduceUnpaginatedList(pageSize: number): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-conversation-list-row]"));
  for (const row of rows.slice(pageSize)) row.remove();
  document.querySelector("[data-conversation-list-sentinel]")?.remove();
}

/** Waits for an in-page predicate, polling; returns the last value it read. */
async function waitForValue<T>(page: Page, read: () => T, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await page.evaluate(read);
  while (!accept(last) && Date.now() < deadline) {
    await page.waitForTimeout(250);
    last = await page.evaluate(read);
  }
  return last;
}

async function walkAgentList(browser: Browser, baseUrl: string, project: string, catalogEntries: number, onNewConversation: () => void): Promise<ListJourney> {
  const page = await openBoard(browser, baseUrl, project, 1, "select");
  const redChecks: Record<string, boolean> = {};
  try {
    /* 1. The switch, on the board, where it used to be unreachable. */
    const switchOnBoard = await page.evaluate(probeViewSwitch, "conversations");
    /* The probe must be able to see an occluded switch, or its verdict is
       worth nothing — so cover it, re-probe, and uncover. */
    await page.evaluate(reintroduceCoveredViewSwitch, "conversations");
    redChecks.coveredViewSwitch = !(await page.evaluate(probeViewSwitch, "conversations")).hitsSelf;
    await page.evaluate(() => document.querySelector('[data-audit="switch-shim"]')?.remove());

    /* 2. A real click at its own centre — no synthetic DOM event. */
    await page.mouse.click(switchOnBoard.x, switchOnBoard.y);
    await page.waitForSelector("[data-conversation-list-rows]", { timeout: 60_000 });
    const firstPage = await waitForValue(page, countListRows, (rows) => rows >= CONVERSATION_LIST_PAGE_SIZE);
    const switchOnList = await page.evaluate(probeViewSwitch, "conversations");

    /* 3. Infinite scroll: the wheel over the list, three times, each waiting
          for the sentinel to bring the next page. The fallback button is never
          touched — the point is that it does not have to be. */
    const scrollSteps: number[] = [];
    let seen = firstPage;
    for (let step = 0; step < 3; step += 1) {
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-conversation-list-scroll]");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await page.mouse.move(800, 600);
      await page.mouse.wheel(0, 4_000);
      const grown = await waitForValue(page, countListRows, (rows) => rows > seen);
      scrollSteps.push(grown);
      seen = grown;
    }
    const usedFallbackButton = false;

    /* Same red question for pagination: a list cut back to one page with no
       sentinel must not read as a list that paged. */
    await page.evaluate(reintroduceUnpaginatedList, CONVERSATION_LIST_PAGE_SIZE);
    redChecks.unpaginatedList = (await page.evaluate(countListRows)) <= CONVERSATION_LIST_PAGE_SIZE;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-conversation-list-rows]", { timeout: 60_000 });
    await waitForValue(page, countListRows, (rows) => rows >= CONVERSATION_LIST_PAGE_SIZE);
    /* Back to where the scroll had got to, so the update below is judged
       against a list that really is several pages deep. */
    for (let step = 0; step < 3; step += 1) {
      const before = await page.evaluate(countListRows);
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-conversation-list-scroll]");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await page.mouse.wheel(0, 4_000);
      await waitForValue(page, countListRows, (rows) => rows > before);
    }
    const deep = await page.evaluate(countListRows);

    /* 4. Hold it through a real update. A new conversation lands on disk, the
          scan picks it up, and the poll delivers it — the exact moment the
          list used to throw away every page it had loaded and start again at
          one, because the catalog hook had no scope to keep them under. */
    await page.evaluate(() => {
      const store = globalThis as unknown as { __llvFiles?: number; fetch: typeof fetch };
      store.__llvFiles = 0;
      const original = store.fetch;
      store.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/files")) store.__llvFiles = (store.__llvFiles ?? 0) + 1;
        return original(input, init);
      }) as typeof fetch;
    });
    onNewConversation();
    const filesUpdatesObserved = await waitForValue(
      page,
      () => (globalThis as unknown as { __llvFiles?: number }).__llvFiles ?? 0,
      (count) => count >= 2,
      60_000,
    );
    const afterUpdate = await page.evaluate(countListRows);

    /* 5. Open an agent from the list, by clicking its row. */
    const rowProbe = await page.evaluate(() => {
      /* A row scrolled out of the list's own viewport cannot be clicked and
         must not be judged as if it could — the list scrolls under the app
         header, so "inside the window" is not the same as "inside the list". */
      const scroller = document.querySelector<HTMLElement>("[data-conversation-list-scroll]");
      const view = scroller?.getBoundingClientRect();
      if (!view) return null;
      for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-conversation-list-row]"))) {
        const button = row.querySelector<HTMLElement>("button");
        if (!button) continue;
        const rect = button.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top < view.top || rect.bottom > view.bottom || rect.left < view.left || rect.right > view.right) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          path: row.getAttribute("data-conversation-list-row") ?? "",
          title: (button.getAttribute("aria-label") ?? "").replace(/^Open /, ""),
          x, y,
          hitsSelf: Boolean(hit && button.contains(hit)),
        };
      }
      return null;
    });
    if (!rowProbe) throw new Error("the agent list drew no row on screen to open");
    await page.mouse.click(rowProbe.x, rowProbe.y);
    await page.waitForTimeout(3_000);
    /* Opened means: this conversation is the one the URL now names, and its
       card is on the board — not merely that the click was accepted. */
    const opened = await page.evaluate((probe: { path: string; title: string }) => ({
      hash: location.hash,
      hashMatched: location.hash.startsWith("#c=") || decodeURIComponent(location.hash).includes(probe.path),
      onScreen: Boolean(document.querySelector(`[data-scheme-node="${CSS.escape(probe.path)}"]`))
        || Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-node]"))
          .some((node) => (node.textContent ?? "").includes(probe.title.slice(0, 24))),
    }), rowProbe);

    /* 6. And back to the list — the switch has to be reachable from wherever
          opening an agent left the operator, and the list has to still be the
          list they had scrolled. */
    const switchBack = await waitForValue(
      page,
      () => {
        const button = document.querySelector<HTMLElement>('button[aria-pressed][aria-label="conversations"]');
        if (!button) return { x: 0, y: 0, ready: false };
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, ready: rect.width > 0 };
      },
      (probe) => probe.ready,
      30_000,
    );
    if (switchBack.ready) {
      await page.mouse.click(switchBack.x, switchBack.y);
      await page.waitForSelector("[data-conversation-list-rows]", { timeout: 60_000 });
    }
    const afterReopen = await waitForValue(page, countListRows, (rows) => rows > CONVERSATION_LIST_PAGE_SIZE, 15_000);

    await page.screenshot({ path: path.join(OUT_DIR, "1614-agent-list.png") });

    /* And out again through the same switch. The view mode is durable, so a
       journey that ended in the list would leave every later step — and the
       operator's next visit — opening on the list. */
    const backToBoard = await page.evaluate(probeViewSwitch, "scheme");
    if (backToBoard.found) await page.mouse.click(backToBoard.x, backToBoard.y);
    const boardCameBack = await waitForValue(page, () => document.querySelectorAll("[data-scheme-band]").length, (bands) => bands > 0, 60_000) > 0;

    return {
      pageSize: CONVERSATION_LIST_PAGE_SIZE,
      catalogTotal: catalogEntries,
      switchOnBoard, switchOnList,
      firstPage,
      scrollSteps,
      deepRows: deep,
      boardCameBack,
      usedFallbackButton,
      filesUpdatesObserved,
      afterUpdate,
      opened: { path: rowProbe.path, hitsSelf: rowProbe.hitsSelf, ...opened },
      afterReopen,
      redChecks,
    };
  } finally {
    await page.context().close();
  }
}

/* ------------------------------------------------------------------------- */
/* The camera the migration leaves behind                                      */
/* ------------------------------------------------------------------------- */

/**
 * The board is per-project and its camera is remembered per project, so the
 * first board opened after the one-time migration is opened by a camera saved
 * against the board as it was. The operator's own was
 * `{x:0,y:-25239.92,z:1.6}` — 25 000px down a band stack that hiding 384 empty
 * tasks had just shortened. Restored as saved, it frames a part of the world
 * that no longer exists: an empty canvas, with no hint that the board is up
 * there somewhere.
 *
 * Measured here from the operator's exact stored value, as a timeline from the
 * board's first painted frame. Both halves of the verdict come out of it: the
 * framing the saved camera actually produces — which is what the measurement
 * has to be able to report, and does, as zero bands on screen — and the board
 * coming back a moment later. Nothing is mutated by hand; band geometry on
 * this board is screen-constant, so a transform injected under a layout that
 * was computed for another camera would describe a board that cannot exist.
 */
interface CameraFraming {
  atMs: number;
  camera: { x: number; y: number; z: number };
  bandsDrawn: number;
  bandsOnScreen: number;
}

interface CameraRecovery {
  savedCamera: { x: number; y: number; z: number };
  /** The framing the board opened with, at its first painted frame. */
  opened: CameraFraming;
  /** The framing it settled on. */
  settled: CameraFraming;
  recoveredWithinMs: number | null;
  restoredSaved: boolean;
  /** The measurement reported a framing showing nothing — it can see the class
      of defect it is here to judge. */
  redCheckOffWorld: boolean;
}

/** Runs inside the page: samples the camera and what it frames, from the first
    painted frame until the board holds one framing. */
function sampleFraming(windowMs: number): Promise<CameraFraming[]> {
  return new Promise<CameraFraming[]>((resolve) => {
    const samples: CameraFraming[] = [];
    const started = performance.now();
    const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]');
    if (!viewport) { resolve(samples); return; }
    const tick = () => {
      const canvas = viewport.getBoundingClientRect();
      const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement | undefined;
      const parsed = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world?.style.transform ?? "");
      const bands = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]"));
      const onScreen = bands.filter((band) => {
        const rect = band.getBoundingClientRect();
        return rect.bottom > canvas.top && rect.top < canvas.bottom && rect.right > canvas.left && rect.left < canvas.right;
      }).length;
      samples.push({
        atMs: Math.round(performance.now() - started),
        camera: parsed ? { x: Number(parsed[1]), y: Number(parsed[2]), z: Number(parsed[3]) } : { x: 0, y: 0, z: 0 },
        bandsDrawn: bands.length,
        bandsOnScreen: onScreen,
      });
      if (performance.now() - started < windowMs) setTimeout(tick, 50);
      else resolve(samples);
    };
    tick();
  });
}

async function recoverOffWorldCamera(browser: Browser, baseUrl: string, project: string): Promise<CameraRecovery> {
  /* The operator's own stored value, byte for byte. */
  const savedCamera = { x: 0, y: -25239.92, z: 1.6 };
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "no-preference" });
  await context.addInitScript((camera: { project: string; value: { x: number; y: number; z: number } }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("llv_lang", "en");
    localStorage.setItem("llvSound", "0");
    localStorage.setItem("llvSchemeMode", "select");
    sessionStorage.setItem(`llvCam:${camera.project}`, JSON.stringify(camera.value));
  }, { project, value: savedCamera });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
    const samples = await page.evaluate(sampleFraming, 4_000);
    if (!samples.length) throw new Error("the board drew no viewport to measure");
    const opened = samples[0]!;
    const settled = samples[samples.length - 1]!;
    const recovered = samples.find((sample) => sample.bandsOnScreen > 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "1614-camera-after-migration.png") });
    return {
      savedCamera,
      opened, settled,
      recoveredWithinMs: recovered ? recovered.atMs : null,
      restoredSaved: Math.abs(settled.camera.y - savedCamera.y) < 1 && Math.abs(settled.camera.z - savedCamera.z) < 0.001,
      redCheckOffWorld: samples.some((sample) => sample.bandsDrawn > 0 && sample.bandsOnScreen === 0),
    };
  } finally {
    await context.close();
  }
}

interface Measurement {
  zoom: number;
  tool: string;
  audit: BoardAudit;
  canvasCost: CanvasCost;
  interactions: Interaction[];
  redChecks: Record<string, boolean>;
}

const failures: string[] = [];
const must = (condition: boolean, message: string) => { if (!condition) failures.push(message); };

async function main(): Promise<void> {
  const port = demoPort(process.env.BOARD_CAPTURE_PORT, 3058, "BOARD_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const measurements: Measurement[] = [];
  let scale: Record<string, unknown> = {};

  try {
    seedHome();
    console.log(`serving under ${CAPTURE_BUN}`);
    const conversations = seedConversations();
    console.log(`seeded ${conversations.length} conversations under the synthetic home`);
    console.log(`output: ${OUT_DIR}`);

    /* First boot learns the project key the scanner assigns this corpus. */
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const scanned = await waitForBoard(baseUrl, false);
    const project = scanned.files?.[0]?.project;
    if (!project) throw new Error("scan produced no project key");
    console.log(`project key: ${project}; scan duration ${scanned.scan?.durationMs ?? "?"} ms`);
    await stop(server);
    server = null;

    /* The task corpus, and a second boot whose first read runs the one-time
       migration over it — the real code path, not a simulated one. */
    seedTasks(project, conversations);
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const withTasks = await waitForBoard(baseUrl, true);
    const tasks = withTasks.tasks ?? [];
    const catalogEntries = await catalogTotal(baseUrl, project);
    const hiddenTasks = tasks.filter((task) => task.board === "hidden");
    const withAssignments = tasks.filter((task) => task.assignments.length > 0);
    const boardPaths = new Set((withTasks.files ?? []).map((file) => file.path ?? ""));
    /* Membership as the board itself resolves it: an assignment that still
       names a conversation the board carries. */
    const holdingMembers = tasks.filter((task) =>
      task.assignments.some((assignment) => assignment.path && boardPaths.has(assignment.path)));
    const historicalHidden = hiddenTasks.filter((task) => task.assignments.length > 0);
    scale = {
      catalogEntries,
      boardWindowCards: (withTasks.files ?? []).length,
      tasksInList: tasks.length,
      tasksHiddenByMigration: hiddenTasks.length,
      tasksHoldingAgents: holdingMembers.length,
      tasksWithAssignmentRows: withAssignments.length,
      tasksHiddenDespiteAnAssignmentRow: historicalHidden.length,
      scanDurationMs: withTasks.scan?.durationMs ?? null,
    };
    console.log("scale:", JSON.stringify(scale));
    /* Nothing may be lost: the list still holds every task that was seeded, and
       no assignment was deleted to make the board look emptier. */
    must(tasks.length === TASKS, `task list holds ${tasks.length} of ${TASKS} tasks — the migration must never remove one`);
    must(withAssignments.length === STAFFED + HISTORICAL,
      `${withAssignments.length} tasks still carry an assignment row, expected ${STAFFED + HISTORICAL}`);
    /* The migration writes a PREFERENCE, for every task that predates it — it
       decides nothing about membership, because neither the assignment row nor
       the scanner's file list can tell a drawn card from an archived one. So
       every legacy row carries the flag afterwards, including the staffed ones,
       and what keeps a band is the board's own answer (asserted below: exactly
       the staffed tasks still draw one). */
    must(hiddenTasks.length === TASKS, `migration flagged ${hiddenTasks.length} of ${TASKS} legacy tasks`);
    /* The finding this corpus exists for: 300 tasks whose agent ran once and
       whose conversation the board no longer draws. A rule that read the
       assignment row — or the scanner's file list — leaves every one of them on
       the canvas as an empty band. */
    must(historicalHidden.length === STAFFED + HISTORICAL,
      `only ${historicalHidden.length} of ${STAFFED + HISTORICAL} tasks with an assignment row carry the preference`);
    must(holdingMembers.length === STAFFED, `${holdingMembers.length} tasks name a conversation the board window carries, expected ${STAFFED}`);
    must(catalogEntries >= CONVERSATIONS, `catalog served ${catalogEntries} entries, expected at least ${CONVERSATIONS}`);

    const executablePath = process.env.CHROME_BIN
      ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    for (const zoom of [1, 1.6]) {
      for (const tool of ["select", "hand"]) {
        const page = await openBoard(browser, baseUrl, project, zoom, tool);
        const label = `${Math.round(zoom * 100)}-${tool}`;
        await page.screenshot({ path: path.join(OUT_DIR, `1614-board-${label}.png`) });
        const audit = await page.evaluate(auditBoard);
        console.log(`${label}: ${audit.bands} bands, canvas ${Math.round(audit.canvasWidth)}px, ${audit.probes.length} control probes`);

        /* Item 1: out of 390 recorded tasks the board draws only the ones that
           hold an agent. Bands derived from a conversation with no task are a
           different population (#1586) and are not counted here. */
        must(audit.bands > 0, `${label}: the board drew no bands at all`);
        must(audit.taskBands === STAFFED, `${label}: ${audit.taskBands} task bands drawn from ${TASKS} tasks, expected ${STAFFED}`);
        must(audit.emptyTaskBands === 0, `${label}: ${audit.emptyTaskBands} empty task band(s) are still on the board`);
        /* Item 2: no band rules a line across the canvas. */
        must(audit.fullWidthBands === 0, `${label}: ${audit.fullWidthBands} band(s) span the whole canvas`);
        must(audit.widestBand <= audit.canvasWidth, `${label}: a band is wider than the canvas`);
        /* Item 3: every control is live and owns its own centre, in BOTH tools. */
        must(audit.probes.length >= 3, `${label}: only ${audit.probes.length} band controls were reachable on screen`);
        must(audit.deadControls.length === 0, `${label}: ${audit.deadControls.length} band control(s) are disabled or take no pointer events`);
        must(audit.wrongHitControls.length === 0, `${label}: ${audit.wrongHitControls.length} band control(s) are covered by something invisible at their own centre (${audit.wrongHitControls.map((probe) => `${probe.control}->${probe.hit}`).join(", ")})`);
        /* Every kind of control must be reachable SOMEWHERE on this screen —
           otherwise "no wrong hits" could be satisfied by a board where the
           chrome happens to cover them all. */
        for (const kind of ["data-scheme-band-details", "data-scheme-band-status", "data-scheme-band-add"]) {
          must(audit.probes.some((probe) => probe.control === kind && probe.hitsSelf), `${label}: no ${kind} control on screen receives a pointer at its own centre`);
        }
        if (audit.chromeOccludedControls.length) {
          console.log(`${label}: ${audit.chromeOccludedControls.length} control(s) sit under floating chrome (${audit.chromeOccludedControls.map((probe) => probe.hit).join(", ")}) — visible, by design, not judged`);
        }

        /* A real click, and the cost of it at this scale. */
        const interactions: Interaction[] = [];
        const statusProbe = audit.probes.find((probe) => probe.control === "data-scheme-band-status" && probe.hitsSelf);
        if (statusProbe) {
          const before = await page.evaluate((band: string) => document.querySelector(`[data-scheme-band="${band}"] [data-scheme-band-status]`)?.getAttribute("data-scheme-band-status") ?? "?", statusProbe.band);
          interactions.push(await clickAndMeasure(page, statusProbe, async () => {
            await page.waitForTimeout(600);
            const after = await page.evaluate((band: string) => document.querySelector(`[data-scheme-band="${band}"] [data-scheme-band-status]`)?.getAttribute("data-scheme-band-status") ?? "?", statusProbe.band);
            return `status ${before} -> ${after}`;
          }));
          /* Editable on the board: the click actually moved the status. */
          const moved = interactions.at(-1)!.effect;
          must(!moved.endsWith(`${before} -> ${before}`), `${label}: the status pill did not change the status (${moved})`);
        }
        const addProbe = audit.probes.find((probe) => probe.control === "data-scheme-band-add" && probe.hitsSelf);
        if (addProbe) {
          interactions.push(await clickAndMeasure(page, addProbe, async () => {
            await page.waitForTimeout(900);
            /* «+ Agent» must open a draft carrying the band's own task, not a
               bare new-task default. */
            return page.evaluate(() => {
              const draft = document.querySelector<HTMLElement>('[data-scheme-node^="draft::"]');
              if (!draft) return "no draft";
              const text = Array.from(draft.querySelectorAll<HTMLTextAreaElement>("textarea")).map((area) => area.value).find((value) => value.trim()) ?? "";
              return text.trim() ? `draft seeded: ${text.slice(0, 60)}` : "draft empty";
            });
          }));
          const opened = interactions.at(-1)!.effect;
          must(opened !== "no draft", `${label}: + Agent opened nothing`);
          must(opened.startsWith("draft seeded"), `${label}: + Agent opened a draft with no task context (${opened})`);
        }
        for (const interaction of interactions) {
          console.log(`${label}: ${interaction.control} responded in ${interaction.responseMs} ms (long tasks ${Math.round(interaction.longTasksMs)} ms) — ${interaction.effect}`);
        }

        /* What it costs to move this board. Taken after the clicks, because
           zooming moves the camera out from under the coordinates the audit
           measured — and it needs no control, so the same measurement can be
           taken on a build whose controls cannot be reached at all. */
        const canvasCost = await measureCanvasCost(page, audit.bands);
        console.log(`${label}: canvas cost over ${canvasCost.steps} zoom steps — ${canvasCost.elapsedMs} ms wall, ${canvasCost.frames} frames (${(canvasCost.frames / (canvasCost.elapsedMs / 1000)).toFixed(1)} fps), long tasks ${canvasCost.longTasksMs} ms in ${canvasCost.longTaskCount} (worst ${canvasCost.worstLongTaskMs} ms), ${canvasCost.bands} bands`);

        /* The audit must be able to see each defect class it claims to judge. */
        const redChecks: Record<string, boolean> = {};
        await page.evaluate(reintroduceFullWidthBands);
        redChecks.fullWidthBands = (await page.evaluate(auditBoard)).fullWidthBands > 0;
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
        await page.waitForTimeout(1_500);
        await page.evaluate(reintroduceDeadControls);
        redChecks.deadControls = (await page.evaluate(auditBoard)).deadControls.length > 0;
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
        await page.waitForTimeout(1_500);
        await page.evaluate(reintroduceOverlappedControls);
        redChecks.overlappedControls = (await page.evaluate(auditBoard)).wrongHitControls.length > 0;
        for (const [name, red] of Object.entries(redChecks)) {
          must(red, `${label}: the audit did NOT flag a deliberately reintroduced ${name} defect — it cannot judge that class`);
          if (red) console.log(`${label}: red self-check for ${name} went red as required`);
        }

        measurements.push({ zoom, tool, audit, canvasCost, interactions, redChecks });
        await page.context().close();
      }
    }

    /* The camera the migration leaves behind, from the operator's own value. */
    const cameraRecovery = await recoverOffWorldCamera(browser, baseUrl, project);
    console.log("camera after migration:", JSON.stringify(cameraRecovery));
    must(cameraRecovery.settled.bandsOnScreen > 0,
      `the board stayed on an empty canvas: ${cameraRecovery.settled.bandsDrawn} bands drawn, none of them on screen, at camera ${JSON.stringify(cameraRecovery.settled.camera)}`);
    must(!cameraRecovery.restoredSaved, "the saved pre-migration camera was left in place on the shortened board");
    must(cameraRecovery.recoveredWithinMs !== null && cameraRecovery.recoveredWithinMs < 2_000,
      `the board took ${cameraRecovery.recoveredWithinMs ?? "forever"} ms to frame anything`);
    /* If this ever fails because the board no longer passes through the saved
       camera's framing at all, the measurement needs a new way to be shown
       going red — not a relaxed assertion. */
    must(cameraRecovery.redCheckOffWorld,
      "the framing measurement never reported a framing with nothing on screen — it cannot judge that class");

    /* Requirement 4: the agent list, walked rather than counted. */
    const listJourney = await walkAgentList(browser, baseUrl, project, catalogEntries, seedOneMoreConversation);
    console.log("agent list:", JSON.stringify(listJourney));
    must(listJourney.switchOnBoard.found, "the board draws no board/list switch at all");
    must(listJourney.switchOnBoard.hitsSelf,
      `the board/list switch does not receive a pointer at its own centre — a click there reaches ${listJourney.switchOnBoard.hit}`);
    must(!listJourney.switchOnBoard.disabled && listJourney.switchOnBoard.pointerEvents !== "none", "the board/list switch is inert");
    must(listJourney.firstPage === CONVERSATION_LIST_PAGE_SIZE,
      `the list's first page drew ${listJourney.firstPage} rows, expected ${CONVERSATION_LIST_PAGE_SIZE}`);
    must(listJourney.scrollSteps.every((rows, index) => rows > (index === 0 ? listJourney.firstPage : listJourney.scrollSteps[index - 1]!)),
      `scrolling did not load further pages: ${listJourney.scrollSteps.join(" → ")}`);
    must(!listJourney.usedFallbackButton, "the list only paged because the fallback button was pressed");
    const deepest = listJourney.deepRows;
    must(deepest > CONVERSATION_LIST_PAGE_SIZE * 2, `scrolling reached only ${deepest} rows`);
    must(listJourney.filesUpdatesObserved >= 2, `no scan update reached the page (${listJourney.filesUpdatesObserved} observed)`);
    must(listJourney.afterUpdate >= deepest,
      `a scan update cut the list back from ${deepest} rows to ${listJourney.afterUpdate}`);
    must(listJourney.opened.hitsSelf, "an agent row does not receive a pointer at its own centre");
    must(listJourney.opened.hashMatched && listJourney.opened.onScreen, "clicking an agent row did not open that conversation");
    must(listJourney.afterReopen >= deepest,
      `reopening the list after opening an agent restarted it at ${listJourney.afterReopen} rows, from ${deepest}`);
    must(listJourney.boardCameBack, "the switch did not bring the board back, so the round trip is one-way");
    for (const [name, red] of Object.entries(listJourney.redChecks)) {
      must(red, `the agent-list audit did NOT flag a deliberately reintroduced ${name} defect — it cannot judge that class`);
    }

    /* Reversibility, through the surfaces the operator actually uses: a hidden
       task put back on the board draws a compact band, that band offers to
       take it off again, and the click that does so is a flag write — the task
       is still in the list afterwards, with its text and history intact. */
    /* A task the board draws nothing for — one of the historical links, not one
       of the staffed rows: restoring a band that holds a conversation is a
       different case, and its «Remove from board» is deliberately absent. */
    const restoreId = tasks.find((task) =>
      task.board === "hidden" && !holdingMembers.some((held) => held.id === task.id))?.id;
    if (!restoreId) {
      /* No task carries the flag: this build has no board-membership concept,
         so there is nothing to restore and nothing to reverse. Recorded as a
         failure rather than thrown, so the rest of the report still lands. */
      must(false, "no task carries a board flag — board membership is not implemented in this build");
    } else {
    const restore = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(restoreId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: "shown" }),
    });
    must(restore.ok, `restoring a hidden task answered ${restore.status}`);
    await Bun.sleep(3_000);

    let page = await openBoard(browser, baseUrl, project, 1, "hand");
    await page.waitForSelector(`[data-scheme-band-task="${restoreId}"]`, { timeout: 60_000 });
    /* A restored empty task ranks below every working band, so its band sits
       far down the stack. Read its world position, park the camera on it
       through the board's own persisted camera, and reload — a control off
       screen cannot be clicked and must not be judged as if it could. */
    const worldTop = await page.evaluate((id: string) =>
      parseFloat(document.querySelector<HTMLElement>(`[data-scheme-band-task="${id}"]`)?.style.top ?? "0"), restoreId);
    await page.context().close();
    page = await openBoard(browser, baseUrl, project, 1, "hand", -worldTop + 140);
    await page.waitForSelector(`[data-scheme-band-task="${restoreId}"]`, { timeout: 60_000 });
    const restored = await page.evaluate((id: string) => {
      const band = document.querySelector<HTMLElement>(`[data-scheme-band-task="${id}"]`)!;
      const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
      const remove = band.querySelector<HTMLElement>("[data-scheme-band-remove]");
      const rect = remove?.getBoundingClientRect();
      return {
        width: band.getBoundingClientRect().width,
        canvasWidth: viewport.getBoundingClientRect().width,
        hasRemove: Boolean(remove),
        removeDisabled: (remove as HTMLButtonElement | null)?.disabled ?? true,
        x: rect ? rect.left + rect.width / 2 : 0,
        y: rect ? rect.top + rect.height / 2 : 0,
        hitsSelf: Boolean(rect && remove!.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))),
      };
    }, restoreId);
    console.log("restored band:", JSON.stringify(restored));
    /* The restored band is an EMPTY one — the exact shape that used to rule a
       line across the canvas. It must be compact, and its control must be live
       on the hand tool. */
    must(restored.width < restored.canvasWidth - 56, `a restored empty band is ${Math.round(restored.width)}px wide on a ${Math.round(restored.canvasWidth)}px canvas`);
    must(restored.hasRemove && !restored.removeDisabled, "the restored empty band offered no live «Remove from board» control");
    must(restored.hitsSelf, "«Remove from board» does not receive a pointer at its own centre");
    await page.screenshot({ path: path.join(OUT_DIR, "1614-restored-empty-band.png") });
    if (restored.hasRemove) {
      await page.mouse.click(restored.x, restored.y);
      await Bun.sleep(3_000);
      const after = await (await fetch(`${baseUrl}/api/files`)).json() as FilesPayload;
      const row = (after.tasks ?? []).find((task) => task.id === restoreId);
      must(Boolean(row), "«Remove from board» removed the task from the task list — it must only set a flag");
      must(row?.board === "hidden", `«Remove from board» left the task at board=${row?.board ?? "?"}`);
      must((after.tasks ?? []).length === TASKS, `the task list holds ${(after.tasks ?? []).length} of ${TASKS} tasks after a remove`);
      /* The write must also DO something. This band's task carries an
         assignment row — the shape that used to be offered this control and
         then have its write overridden by the board — so the band has to
         actually leave the canvas the operator is looking at. */
      must(row!.assignments.length > 0, "the restore case no longer exercises a task with an assignment row");
      const bandGone = await page.evaluate(async (id: string) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (!document.querySelector(`[data-scheme-band-task="${id}"]`)) return true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
      }, restoreId);
      must(bandGone, "«Remove from board» wrote the flag and the band stayed on the board — an accepted, ignored write");
      console.log(`remove-from-board: task still listed, board=${row?.board}, list still holds ${(after.tasks ?? []).length} tasks`);
    }
    await page.context().close();
    }

    fs.writeFileSync(
      path.join(OUT_DIR, "measurements.json"),
      JSON.stringify({ scale, measurements, cameraRecovery, listJourney, failures }, null, 2) + "\n", "utf8",
    );
    console.log(`measurements: ${path.join(OUT_DIR, "measurements.json")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }

  if (failures.length) {
    process.exitCode = 1;
    console.error(`#1614 acceptance FAILED:\n  ${failures.join("\n  ")}`);
  } else {
    console.log("#1614 acceptance passed at 100% and 160%, in both tools, and every red self-check went red.");
  }
}

await main();
