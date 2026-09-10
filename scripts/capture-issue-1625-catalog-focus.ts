/**
 * Rendered acceptance for #1625, in a real browser against the production
 * build:
 *
 *   bun run build && bun scripts/capture-issue-1625-catalog-focus.ts
 *
 * The question is the operator's own: after clicking a row in the desktop agent
 * catalog, is the conversation they asked for ON SCREEN and readable? The
 * earlier rendered acceptance (#1614) opened whichever row the list happened to
 * draw first — a recent agent in the top band, under no layout pressure — and
 * asked only whether a node for it existed anywhere in the DOM. Both of those
 * pass while the reported defect is live, so this capture opens the shape that
 * actually failed: a HISTORICAL conversation, outside the board's own window,
 * belonging to a COMPLETED pipeline, whose task band sits far down a long stack
 * of preceding bands.
 *
 * It measures, in the page, at the real production build:
 *
 *   - the first open: the requested node's rectangle against the board
 *     viewport, and whether its own title is rendered inside it;
 *   - the repeat open, after the operator has gone back to the list;
 *   - that a manual pan afterwards is RESPECTED — the camera is read again
 *     after more than one scanner poll, and must not have crept back.
 *
 * Then it proves the audit can go red: the same reading is taken against a page
 * where the defect has been reintroduced by hand (the world pushed so the node
 * leaves the viewport, and the node removed outright). A run where either of
 * those still reads as "shown" exits non-zero.
 *
 * Everything is served against a purpose-built synthetic home under the temp
 * root — its own HOME, XDG dirs, TMPDIR, viewer state dir and provider homes —
 * so nothing here reads or writes the operator's live state, and no real path
 * appears in any frame. Nothing is deployed.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "BOARD_CAPTURE_DIR",
  prefix: "llv-issue-1625",
  raw: process.env.BOARD_CAPTURE_DIR,
  repoRoot,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");

/** Conversations on disk. The board draws a bounded window of the freshest. */
const CONVERSATIONS = 260;
/** Task bands. The requested conversation's band must have many above it. */
const TASKS = 15;
/** Members each staffed band holds, so the stack is genuinely tall. */
const PER_BAND = 5;
const PROJECT_NAME = "catalog";
/** The row this capture opens, named so it can be found in the catalog. */
const TARGET_TITLE = "Folded pipeline builder from the archive";

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const line = (record: Record<string, unknown>) => JSON.stringify(record) + "\n";

function conversationFile(index: number): { file: string; uuid: string } {
  const cwd = path.join(HOME, "Projects", PROJECT_NAME);
  const folder = path.join(HOME, ".claude/projects", projectSlug(cwd));
  fs.mkdirSync(folder, { recursive: true });
  const uuid = `${String(index + 1).padStart(8, "0")}-3333-4333-8333-333333333333`;
  return { file: path.join(folder, `${uuid}.jsonl`), uuid };
}

interface Seeded { file: string; uuid: string; title: string }

/**
 * The corpus. The freshest {@link TASKS} × {@link PER_BAND} conversations are
 * what the board's window draws, so their task bands hold real members and the
 * stack is tall. The LAST conversation written is deliberately the oldest one
 * on disk: it is outside that window, which is what makes opening it from the
 * catalog an ephemeral admission rather than a jump to a card already drawn.
 */
function seedConversations(): Seeded[] {
  const cwd = path.join(HOME, "Projects", PROJECT_NAME);
  fs.mkdirSync(cwd, { recursive: true });
  const seeded: Seeded[] = [];
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    const { file, uuid } = conversationFile(index);
    const stamp = "2100-01-02T09:00:00.000Z";
    const last = index === CONVERSATIONS - 1;
    const title = last ? TARGET_TITLE : `Agent ${index} watching area ${index}`;
    const body = last
      ? "Recorded months ago by a pipeline that has since finished. Every line of it has to be readable once it is opened from the catalog."
      : `${title} — recorded.`;
    fs.writeFileSync(
      file,
      line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
      + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: body }] } }),
      "utf8",
    );
    /* Fresh at the front, and the target far older than anything else. */
    const ageMs = last ? 400 * 24 * 3600 * 1000 : 60_000 + index * 60_000;
    fs.utimesSync(file, new Date(stamp), new Date(Date.now() - ageMs));
    seeded.push({ file, uuid, title });
  }
  return seeded;
}

function seedHome(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
}

/**
 * The task corpus: {@link TASKS} assigned tasks, each holding a run of fresh
 * conversations, plus — created FIRST, so it ranks below every other band — the
 * one task whose only assignment is the archived target. That band is drawn
 * empty until the catalog admits its conversation, and it sits at the bottom of
 * the stack, thousands of world pixels from the framing the board opens on.
 */
function seedTasks(project: string, conversations: Seeded[]): string {
  const targetTaskId = "task-0000-4000-8000-b00000000000";
  const target = conversations[conversations.length - 1]!;
  const tasks: unknown[] = [{
    id: targetTaskId,
    project,
    status: "assigned",
    text: "Archived pipeline task\nIts agent finished long ago; the board draws nothing for it until the catalog opens it.",
    placement: "unplaced",
    assignments: [{ path: target.file, conversationId: null, panePid: null, state: "delivered", error: null, at: "2100-01-01T00:00:00.000Z" }],
    createdAt: "2100-01-01T00:00:00.000Z",
    updatedAt: "2100-01-01T00:00:00.000Z",
  }];
  for (let index = 0; index < TASKS; index += 1) {
    const created = new Date(Date.UTC(2100, 0, 2, 0, index % 60, 0)).toISOString();
    const held = conversations.slice(index * PER_BAND, index * PER_BAND + PER_BAND);
    tasks.push({
      id: `task-${String(index + 1).padStart(4, "0")}-4000-8000-b00000000000`,
      project,
      status: "assigned",
      text: `Staffed task ${index}\nAgents are on this one.`,
      placement: "unplaced",
      assignments: held.map((entry) => ({ path: entry.file, conversationId: null, panePid: null, state: "delivered", error: null, at: created })),
      createdAt: created,
      updatedAt: created,
    });
  }
  fs.writeFileSync(path.join(STATE_DIR, "tasks.json"), JSON.stringify({ tasks }, null, 2) + "\n", "utf8");
  return targetTaskId;
}

/** A finished two-stage pipeline whose implement stage IS the target: the
    folded, completed membership the reported opens both had. */
function seedPipeline(project: string, targetTaskId: string, conversations: Seeded[]): void {
  const target = conversations[conversations.length - 1]!;
  const reviewer = conversations[conversations.length - 2]!;
  const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
  const attempt = (roleId: string, entry: Seeded) => ({
    n: 1,
    state: "passed",
    effectiveRole: role(roleId),
    launchId: `launch-${roleId}`,
    conversationId: null,
    sessionId: entry.uuid,
    agentPath: entry.file,
    paneId: null,
    flowId: null,
    startedAt: "2100-01-01T00:00:00.000Z",
    completedAt: "2100-01-01T01:00:00.000Z",
    input: null,
    activatedBy: null,
    output: "done",
    verdict: { status: "pass" },
    error: null,
  });
  const stage = (id: string, next: string | null, roleId: string) => ({
    id, kind: "run", role: { roleId }, engine: "claude", model: "opus",
    effort: "high", access: "read-write", prompt: "Finished work.", next, onFail: null, effectiveRole: role(roleId),
  });
  const pipelines = [{
    id: "archived",
    task: "Archived pipeline task",
    taskIds: [targetTaskId],
    spec: "Finished long ago.",
    project,
    repoDir: path.join(HOME, "Projects", PROJECT_NAME),
    worktreeDir: path.join(HOME, "Projects", `${PROJECT_NAME}-archived`),
    branch: "pipeline/archived",
    baseBranch: "main",
    baseRef: "0".repeat(40),
    lastPassedCommit: "0".repeat(40),
    stages: [stage("implement", "review", "builder"), stage("review", null, "reviewer")],
    runs: [
      { stageId: "implement", attempts: [attempt("builder", target)] },
      { stageId: "review", attempts: [attempt("reviewer", reviewer)] },
    ],
    cursor: null,
    state: "completed",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2100-01-01T00:00:00.000Z",
    closedAt: "2100-01-01T02:00:00.000Z",
  }];
  fs.writeFileSync(path.join(STATE_DIR, "pipelines.json"), JSON.stringify({ schemaVersion: 5, pipelines }, null, 2) + "\n", "utf8");
}

/**
 * The server's environment: every variable that decides where the Viewer reads
 * and writes points at the synthetic home, and every stray `LLV_*` the caller
 * exported is dropped, so this run cannot reach the operator's state. The rest
 * is inherited because `bun --bun` needs it.
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

/** Served under the interpreter running this script — the pinned Bun, which is
    the only one that can load this build's compiled server modules. */
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

/* ------------------------------------------------------------------------- */
/* In-page reading: is the requested conversation shown?                      */
/* ------------------------------------------------------------------------- */

interface Shown {
  /** The node exists in the board's DOM at all. */
  present: boolean;
  /** Its rectangle, in viewport coordinates. */
  top: number; left: number; right: number; bottom: number;
  /** The board viewport it is measured against. */
  canvas: { top: number; left: number; width: number; height: number };
  /** On screen with enough of its head visible to read. */
  shown: boolean;
  /** Its own title, rendered inside the node — content, not just a rectangle. */
  titleRendered: boolean;
  presentation: string;
  camera: string;
}

/** Runs inside the page; playwright serializes it, so it stays self-contained. */
function readShown(probe: { path: string; title: string }): Shown {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]');
  const empty = {
    present: false, top: 0, left: 0, right: 0, bottom: 0,
    canvas: { top: 0, left: 0, width: 0, height: 0 },
    shown: false, titleRendered: false, presentation: "none", camera: "",
  };
  if (!viewport) return empty;
  const canvasRect = viewport.getBoundingClientRect();
  const canvas = { top: canvasRect.top, left: canvasRect.left, width: canvasRect.width, height: canvasRect.height };
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale("));
  const camera = (world as HTMLElement | undefined)?.style.transform ?? "";
  const node = Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-node]"))
    .find((candidate) => candidate.getAttribute("data-scheme-node") === probe.path);
  if (!node) return { ...empty, canvas, camera };
  const rect = node.getBoundingClientRect();
  /* Enough of the head — the title row and the lines under it — inside the
     board's own viewport to be read. A pane taller than the canvas is shown
     when its top is inside it; one pushed past an edge is not. */
  const head = Math.min(rect.height, 120);
  const shown = rect.top >= canvasRect.top
    && rect.top + head <= canvasRect.bottom
    && rect.left < canvasRect.right
    && rect.right > canvasRect.left;
  return {
    present: true,
    top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom,
    canvas,
    shown,
    titleRendered: (node.textContent ?? "").includes(probe.title.slice(0, 24)),
    presentation: node.getAttribute("data-scheme-node-presentation") ?? "?",
    camera,
  };
}

/* --- deliberate defects, so the reading is shown going red ----------------- */

/** Push the world down so the requested node leaves the viewport — the reported
    geometry, reintroduced by hand. */
function reintroduceOffscreenTarget(): void {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]');
  const world = viewport && Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale("));
  if (world) (world as HTMLElement).style.transform += " translateY(4000px)";
}

/** Take the node away outright: the state where the board drew nothing for the
    requested path at all. */
function reintroduceMissingTarget(path: string): void {
  Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-node]"))
    .find((candidate) => candidate.getAttribute("data-scheme-node") === path)
    ?.remove();
}

const seedInit = (seed: { project: string }) => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
  localStorage.setItem("llvSchemeMode", "select");
  /* No saved camera: the first open is the one the operator reported first. */
  void seed;
};

const countListRows = () => document.querySelectorAll("[data-conversation-list-row]").length;

/** Scrolls the catalog until the row for `title` is drawn, then returns the
    point at its own centre — a row the list has not paged to cannot be clicked
    and must not be judged as if it could. */
async function findCatalogRow(page: Page, title: string): Promise<{ x: number; y: number; path: string; pages: number }> {
  const deadline = Date.now() + 120_000;
  let pages = 0;
  while (Date.now() < deadline) {
    const found = await page.evaluate((wanted: string) => {
      const scroller = document.querySelector<HTMLElement>("[data-conversation-list-scroll]");
      const view = scroller?.getBoundingClientRect();
      if (!view) return null;
      for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-conversation-list-row]"))) {
        const button = row.querySelector<HTMLElement>("button");
        if (!button || !(button.getAttribute("aria-label") ?? "").includes(wanted)) continue;
        button.scrollIntoView({ block: "center" });
        const rect = button.getBoundingClientRect();
        const fresh = scroller!.getBoundingClientRect();
        if (rect.top < fresh.top || rect.bottom > fresh.bottom) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, path: row.getAttribute("data-conversation-list-row") ?? "" };
      }
      return null;
    }, title);
    if (found) return { ...found, pages };
    const before = await page.evaluate(countListRows);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-conversation-list-scroll]");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.mouse.move(800, 600);
    await page.mouse.wheel(0, 4_000);
    await page.waitForTimeout(1_200);
    const after = await page.evaluate(countListRows);
    pages += 1;
    if (after === before && pages > 40) break;
  }
  throw new Error(`the catalog never drew a row for "${title}"`);
}

async function clickViewSwitch(page: Page, label: string): Promise<void> {
  const probe = await page.evaluate((wanted: string) => {
    const button = document.querySelector<HTMLElement>(`button[aria-pressed][aria-label="${wanted}"]`);
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, label);
  if (!probe) throw new Error(`no «${label}» view switch`);
  await page.mouse.click(probe.x, probe.y);
}

/** One catalog open, end to end: switch to the list, page to the archived row,
    click it, and read what the board did about it. */
async function openFromCatalog(page: Page, title: string): Promise<{ probe: { x: number; y: number; path: string; pages: number }; shown: Shown }> {
  await clickViewSwitch(page, "conversations");
  await page.waitForSelector("[data-conversation-list-rows]", { timeout: 120_000 });
  const probe = await findCatalogRow(page, title);
  await page.mouse.click(probe.x, probe.y);
  await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
  /* Long enough for the band projection to settle at the real camera and
     viewport — the very interval the defect lived in — and then some. */
  await page.waitForTimeout(6_000);
  const shown = await page.evaluate(readShown, { path: probe.path, title });
  return { probe, shown };
}

/* ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  seedHome();
  const conversations = seedConversations();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };

  const port = 3_000 + (process.pid % 900);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = {};
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    /* The project key is the scan's own, so the corpus is written once the
       server has named it, and the scan is then waited on again for the tasks
       and the pipeline that were just written under it. */
    const { project } = await waitForBoard(baseUrl, false);
    const targetTaskId = seedTasks(project, conversations);
    seedPipeline(project, targetTaskId, conversations);
    const { cards } = await waitForBoard(baseUrl, true);
    await Bun.sleep(6_000);
    report.corpus = { conversations: CONVERSATIONS, tasks: TASKS + 1, boardWindowCards: cards, project };

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "no-preference" });
    await context.addInitScript(seedInit, { project });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
    await page.waitForTimeout(3_000);

    const bands = await page.evaluate(() => document.querySelectorAll("[data-scheme-band]").length);
    report.bands = bands;
    must(bands >= 12, `the board drew ${bands} bands — too few for the layout pressure this issue is about`);

    /* 1. Opened from a board that is already on screen. */
    const first = await openFromCatalog(page, TARGET_TITLE);
    report.firstOpen = first;
    await page.screenshot({ path: path.join(OUT_DIR, "1625-first-open.png") });
    must(first.shown.present, "the first catalog open drew no node for the requested conversation");
    must(first.shown.shown, `the first catalog open left the requested conversation off screen (top ${Math.round(first.shown.top)}, canvas ${Math.round(first.shown.canvas.top)}..${Math.round(first.shown.canvas.top + first.shown.canvas.height)})`);
    must(first.shown.titleRendered, "the requested conversation is on screen but its own content is not rendered in it");

    /* The reading has to be able to go red, or its verdict is worth nothing. */
    await page.evaluate(reintroduceOffscreenTarget);
    const offscreen = await page.evaluate(readShown, { path: first.probe.path, title: TARGET_TITLE });
    must(!offscreen.shown, "the audit did NOT flag a requested conversation pushed out of the viewport — it cannot see that defect");
    await page.evaluate(reintroduceMissingTarget, first.probe.path);
    const missing = await page.evaluate(readShown, { path: first.probe.path, title: TARGET_TITLE });
    must(!missing.present && !missing.shown, "the audit did NOT flag a requested conversation with no node at all");
    report.redChecks = { offscreen: !offscreen.shown, missing: !missing.present };
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-scheme-band]", { timeout: 120_000 });
    await page.waitForTimeout(3_000);

    /* 2. The same row again, this time from a freshly loaded tab: the list
          unmounts and the board MOUNTS with the request already standing,
          which is the catalog remount the operator reported. */
    const repeat = await openFromCatalog(page, TARGET_TITLE);
    report.repeatOpen = repeat;
    await page.screenshot({ path: path.join(OUT_DIR, "1625-repeat-open.png") });
    must(repeat.shown.present && repeat.shown.shown, `the repeat catalog open left the requested conversation off screen (top ${Math.round(repeat.shown.top)})`);
    must(repeat.shown.titleRendered, "the repeat open put the node on screen without its content");

    /* 3. And the operator's own pan wins from there. The camera is read again
          after more than one scanner poll (10s), so a rule that re-armed on a
          poll would show up as the camera creeping back. */
    const parked = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
      const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale("))!;
      return (world as HTMLElement).style.transform;
    });
    /* Over the canvas gutter, clear of any pane: a wheel inside a scrolling
       conversation feed scrolls the feed and never reaches the camera, which
       would leave this case silently unexercised. */
    const gutter = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!.getBoundingClientRect();
      return { x: canvas.left + 10, y: canvas.top + canvas.height / 2 };
    });
    await page.mouse.move(gutter.x, gutter.y);
    await page.mouse.wheel(0, 5_000);
    await page.waitForTimeout(1_500);
    const panned = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
      const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale("))!;
      return (world as HTMLElement).style.transform;
    });
    await page.waitForTimeout(25_000);
    const afterPolls = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
      const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale("))!;
      return (world as HTMLElement).style.transform;
    });
    report.pan = { parked, panned, afterPolls };
    await page.screenshot({ path: path.join(OUT_DIR, "1625-after-pan.png") });
    must(panned !== parked, "the wheel did not move the camera, so the pan case was never exercised");
    must(afterPolls === panned, `the camera moved on its own after the pan: ${panned} then ${afterPolls}`);

    await page.context().close();
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
    console.error(`#1625 acceptance FAILED:\n  ${failures.join("\n  ")}`);
  } else {
    console.log("#1625 acceptance passed: the requested conversation is on screen and readable on the first and the repeat catalog open, a later pan is respected, and both red self-checks went red.");
  }
}

await main();
