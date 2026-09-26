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
 * the panel's header clear of the island, a real Tab from ⋯ landing on the
 * island, and the open ⋯ menu and accounts panel painted above the island and
 * its toast — at 2540, 1850 and 1280 px in en and
 * uk, light and dark, under a 21-character project name — and the phone's 52 px
 * bar in the same four.
 *
 * With BOARD_CAPTURE_CASE=seats, seat-placement or columns-wide it measures
 * the orchestrator seat's own place (#1841) on a home with two projects, a
 * live seat, two seats it replaced (each with its task and notes) and product
 * tasks over the four columns: no seat band on any column, the Previous seats
 * popover with one Notes row open, inside the viewport and clear of the head
 * controls; the top strip, the side panel and the side rail with the board
 * growing by what they free and the header toggle's dot in the seat's colour;
 * the popover under its control in the strip and at the side, the side seat
 * leaving the columns scrolling at 1280; and a shelf taking the wide share with
 * the workspace's tile grid, pinned through work in Assigned and a reload,
 * while the Overview keeps its own shares — at 1440 and 1280 in en and uk,
 * light and dark, and the phone's Previous seats row (drawn as the tick row),
 * list with the live seat first, and notes at 390 × 844.
 *
 * With BOARD_CAPTURE_CASE=account-removal it drives the accounts dialog's
 * removal answers (#1857) on the same seeded accounts, with every DELETE
 * answered by a stub at the network layer so no account is removed anywhere:
 * the armed row, the row in flight, the longest refusal, `archive_unavailable`
 * with its path, a refusal on the last row after the list was scrolled by hand
 * (the block and its buttons must sit inside the list), the summary with all
 * six lines, the summary with a sign-in
 * file left behind, and the clean-up result with names that need a look — at
 * 1440 and 1280 in en and uk, light and dark — and the phone at 390 × 844 for
 * the refusal and the summary. Nothing is clamped or clipped, the path keeps
 * its account id visible, the blocks stay inside the panel, and the phone's
 * targets are 44 px.
 *
 * With BOARD_CAPTURE_CASE=file-preview it opens the file links agents write
 * in the preview on a seeded home: the `#f=<report>%23<anchor>` link to a long
 * HTML report with relative CSS, an image and a script (which probes what the
 * sandbox lets it reach), its source view and its new-tab page; a long
 * markdown guide with a wide table, at its top and at an anchor; a source
 * file at a `:line`; and a path that does not exist — at 1280 × 800 and
 * 390 × 844, measuring sideways overflow and clipped controls. It also runs
 * the report's ES module (with a relative import and a scoped fetch) in the
 * frame and the new tab, lands a dotted element id, follows a relative
 * markdown link after a Source/Rendered round trip, and follows a link to the
 * Viewer's own non-loopback host (`viewer.example`, mapped to loopback).
 * Relative links with a percent-encoded fragment (Unicode and ASCII) land on
 * their markdown heading or HTML element id, and a sibling `retry.ts:180` /
 * `retry.ts:180:5` link opens the file at that line.
 *
 * With BOARD_CAPTURE_CASE=resources it renders the resources footer (#2110,
 * #1817) from a fixture served through LLV_RESOURCES_FIXTURE: a session table
 * a failed refresh fell back on four days ago, and the same table current,
 * each beside Delegatus's own processes. The rail footer and its open panel at
 * 1280 × 800 in en and uk, light and dark, and the phone's projects sheet with
 * the footer at its foot and the panel open at 390 × 844. It requires the
 * Delegatus line in the footer, the stale mark and banner only on the stale
 * table, the stale text still in the frame with the list scrolled to its end
 * and a stale tag on every row, a Delegatus section with every process and no
 * control in it, the panel inside the viewport with nothing overflowing
 * sideways, and 44 px targets on the phone.
 *
 * With BOARD_CAPTURE_CASE=activity it renders the activity dashboard
 * (docs/design/activity-dashboard-v2.md) on a home seeded with the design's
 * invented, uneven work: thirteen projects with a long tail, ten of them git
 * repositories whose Claude transcripts the Viewer's own scan indexes (the
 * agent axis), a request ledger and this host's own export for the whole
 * month, a stage host holding two projects whose export stops two days back,
 * a heavy Monday, an empty weekend with night runs, a workday with agent work
 * and no input (the probable-missing-source flag), and `hosts.json` and
 * `settings.json` with two billable projects. At 1440 × 900 it captures 7
 * days (en and uk, and 1280 × 800 in uk), 30 days, Today, a project open with
 * its breakdowns, the drawer, the day, hour and Agents tooltips, Today with
 * the stage host unread for three hours, the same home with none of your
 * input read, and a home with no data at all; the phone at 390 × 844 keeps
 * the prototype's layout. It also filters the page to one project
 * (`?project=`): every project, one project chosen (en and uk), the header's
 * picker open, and the phone with one project chosen, and requires the
 * server's scoped totals to equal that project's row. On the phone it arrives
 * the way the operator does, by ⋯ → Activity from the Overview's board and a
 * project's, at 390 × 844 and 430 × 932 in en and uk, light and dark: the tap
 * has to load /activity, the page has to fit, its range, view and Board
 * controls have to take a 44 px thumb, and Board and Back have to return to a
 * board with no menu over it. It checks sideways overflow, the 7-day page ending
 * inside 900 px, the trust chip and the Rhythm legend on one line, cut text,
 * tooltips inside the viewport, and the marks on the unread and flagged days.
 * With ACTIVITY_RENDER_DIR set, the images are copied there.
 *
 * With BOARD_CAPTURE_CASE=lightbox it walks the full-screen image viewer
 * through one conversation's 26 invented pictures (#2144): inbox attachments,
 * markdown images and pictures a tool showed its agent, interleaved. It opens
 * the newest picture, steps ← to the first and → back to the last, and counts
 * every image request the page makes, per step: nothing beyond the shown
 * picture and its neighbours, and nothing fetched twice. On the desktop it
 * also puts the other 25 pictures above rows the feed never mounts, collects
 * garbage and waits out the pictures' 60 s freshness before walking back, so
 * a picture the viewer stopped holding would have to be downloaded again.
 * Real clicks, a real drag and real taps check that the dimmed backdrop closes
 * the viewer while a click on the picture or a pan that ends off it does not;
 * it renders the viewer mid-gallery at 1440 × 900 and 390 × 844.
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

import { nestProcessTempUnder } from "../src/lib/tempDirs";
import { createTailscaleStub, STUB_DNS_NAME } from "../src/test-helpers/tailscaleStub";

import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
/* The commit the record was captured from. A `git archive` export has no repository, so the caller
   names it in BOARD_CAPTURE_COMMIT; inside a checkout it is HEAD. */
const captureCommit = () => process.env.BOARD_CAPTURE_COMMIT?.trim()
  || Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
const BASE = createCaptureDirectory({ envName: "BOARD_CAPTURE_DIR", prefix: "llv-issue-1641", raw: process.env.BOARD_CAPTURE_DIR, repoRoot });
/* Playwright makes its browser profile and artifacts under the temp root at launch and removes
   them on close. A run killed before it closes leaves them, so they are made inside this run's
   directory, which the Viewer's sweeper removes once it is stale (#1957). */
nestProcessTempUnder(BASE);
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

/* ------------------------------------------------------------------------- */
/* Case: the first-run setup guide (#1876, slices 1 and 2)                   */
/* ------------------------------------------------------------------------- */

/*
 * BOARD_CAPTURE_CASE=onboarding runs this case instead of the geometry probes:
 *
 *   bun run build && TMPDIR=/var/tmp CHROME_BIN=google-chrome-stable \
 *     BOARD_CAPTURE_CASE=onboarding bun scripts/capture-board-geometry.ts
 *
 * One production server on a port the OS assigned, over a seeded home with one
 * invented Claude transcript and a Claude credential file, and no Codex at all.
 * Every combination of 1440×900, 1280×900 and 390×844, light and dark, English
 * and Ukrainian starts from a first run and walks the slice's states: the guide
 * opening by itself, one engine connected and one not installed, the mapping
 * with the refusal banner and the very-heavy nudge, the move to Claude and its
 * undo, a row an update reset and its Restore (model sizing §5), Codex
 * installed and signed out with the sign-in open, neither engine
 * connected, the menu rows, the mapping opened alone, and a dismissal that
 * keeps the guide shut on reload. Slice 2 adds the Check step: before a run,
 * running, passed, the pass a new install ends on (no orchestrator, so row 5
 * is skipped), a pass whose cleanup could not finish, a poll that lands while
 * the cleanup is still running, stopped, a start the server refuses, and each
 * of the thirteen failures at its row, with the machine detail opened on the
 * last one, the check's answers served from records so no agent is spawned. Each capture is measured in the live DOM:
 * the dialog inside the viewport, no horizontal overflow, no clipped role
 * label (the two longest Ukrainian ones by name) or footer button, and 44 px
 * targets on the phone.
 */

type OnboardingViewport = { width: number; height: number; tag: string; phone: boolean };

const ONBOARDING_VIEWPORTS: readonly OnboardingViewport[] = [
  { width: 1440, height: 900, tag: "desktop-1440", phone: false },
  { width: 1280, height: 900, tag: "desktop-1280", phone: false },
  { width: 390, height: 844, tag: "phone-390", phone: true },
];

const BIN_DIR = path.join(HOME, ".bun", "bin");
const CLAUDE_CREDENTIALS = path.join(HOME, ".claude", ".credentials.json");
const CODEX_CREDENTIALS = path.join(HOME, ".codex", "auth.json");

function fakeCli(name: "claude" | "codex", present: boolean): void {
  const file = path.join(BIN_DIR, name);
  if (!present) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} 0.0.0 (capture stub)"\n`, { mode: 0o755 });
}

function claudeSignedIn(present: boolean): void {
  if (present) fs.writeFileSync(CLAUDE_CREDENTIALS, "{}\n", { mode: 0o600 });
  else fs.rmSync(CLAUDE_CREDENTIALS, { force: true });
}

function codexSignedIn(present: boolean): void {
  if (present) fs.writeFileSync(CODEX_CREDENTIALS, "{}\n", { mode: 0o600 });
  else fs.rmSync(CODEX_CREDENTIALS, { force: true });
}

/* Quota readings the seeded home cannot produce without a live account: the
   accounts read is answered by the server and each account gains a fresh
   session and weekly window before the page sees it. */
const SEEDED_LIMITS = {
  state: "fresh",
  session: { usedPercent: 41, resetsAt: "2100-01-02T15:00:00.000Z", windowMinutes: 300, observedAt: "2100-01-02T10:00:00.000Z" },
  weekly: { usedPercent: 78, resetsAt: "2100-01-06T10:00:00.000Z", windowMinutes: 10_080, observedAt: "2100-01-02T10:00:00.000Z" },
  checkedAt: "2100-01-02T10:00:00.000Z",
};

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Everything the case asserts is read here, in the page. */
function measureOnboarding(phone: boolean) {
  const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const dialog = document.querySelector<HTMLElement>("[data-onboarding-dialog]");
  if (!dialog) return null;
  const scroller = Array.from(dialog.querySelectorAll<HTMLElement>("div")).find((el) => getComputedStyle(el).overflowY === "auto") ?? null;
  const clipped = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
  const roleLabels = Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-row] span[title]")).map((el) => ({ text: el.textContent ?? "", clipped: clipped(el), w: Math.round(el.getBoundingClientRect().width) }));
  const footer = dialog.querySelector("footer");
  const footerButtons = footer ? Array.from(footer.querySelectorAll<HTMLElement>("button")).map((el) => ({ text: el.textContent ?? "", clipped: clipped(el), inside: el.getBoundingClientRect().right <= footer.getBoundingClientRect().right + 0.5 })) : [];
  const rows = Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-row]"));
  /* The chip's top against the role name's top: a card whose chip floats
     between two lines reads well above zero. */
  const chipOffsets = rows.map((row) => {
    const chip = row.querySelector("[data-cost-class]");
    const name = row.querySelector("span[title]");
    return chip && name ? Math.round(chip.getBoundingClientRect().top - name.getBoundingClientRect().top) : 0;
  });
  const legend = dialog.querySelector("[data-mapping-legend]");
  const segments = Array.from(dialog.querySelectorAll<HTMLElement>("[role=radiogroup]")).map((el) => {
    const cell = el.parentElement!.getBoundingClientRect();
    return { overflow: Math.round(el.getBoundingClientRect().right - cell.right) };
  });
  const smallTargets = phone
    ? Array.from(dialog.querySelectorAll<HTMLElement>("button, select")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 43.5;
    }).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}" ${Math.round(el.getBoundingClientRect().height)}px`)
    : [];
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dialog: rect(dialog),
    scroller: scroller ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth } : null,
    documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    roleLabels,
    footerButtons,
    segmentOverflow: Math.max(0, ...segments.map((segment) => segment.overflow)),
    smallTargets,
    engines: Object.fromEntries(Array.from(dialog.querySelectorAll<HTMLElement>("[data-onboarding-engine]")).map((el) => [el.dataset.onboardingEngine!, el.dataset.engineState!])),
    blockedRows: dialog.querySelectorAll("[data-mapping-blocked]").length,
    banner: dialog.querySelector("[data-mapping-banner]")?.textContent ?? null,
    receipt: dialog.querySelector("[data-mapping-receipt]")?.textContent ?? null,
    nudges: dialog.querySelectorAll("[data-mapping-nudge]").length,
    costClasses: Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-row]")).map((row) => `${row.dataset.mappingRow}=${row.querySelector<HTMLElement>("[data-cost-class]")?.dataset.costClass}`),
    heading: dialog.querySelector("h2")?.textContent ?? null,
    /* Rows without a nudge line: the one-line rhythm the headroom must keep. */
    plainRowHeights: rows.filter((row) => !row.querySelector("[data-mapping-nudge]")).map((row) => Math.round(row.getBoundingClientRect().height)),
    chipOffsets,
    headrooms: Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-headroom]")).map((el) => ({ text: el.textContent ?? "", h: Math.round(el.getBoundingClientRect().height) })),
    changedRows: dialog.querySelectorAll("[data-mapping-reset]").length,
    /* A row an update set back to its default (docs/design/model-sizing-tiers.md §5). */
    retired: Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-retired]")).map((el) => ({ row: el.dataset.mappingRetired!, text: el.textContent ?? "", clipped: clipped(el), w: Math.round(el.getBoundingClientRect().width) })),
    legendFirst: legend && rows[0] ? legend.getBoundingClientRect().top < rows[0].getBoundingClientRect().top : false,
    modelSelectWidths: Array.from(dialog.querySelectorAll<HTMLElement>("[data-mapping-row] select")).filter((_, index) => index % 2 === 0).map((el) => Math.round(el.getBoundingClientRect().width)),
    selectedSegmentRing: Array.from(dialog.querySelectorAll<HTMLElement>("[role=radio][aria-checked=true]")).slice(0, 1).map((el) => getComputedStyle(el).boxShadow)[0] ?? null,
    enginesStepMark: dialog.querySelector<HTMLElement>('[data-onboarding-step="engines"] [data-step-mark]')?.dataset.stepMark ?? null,
    /* Slice 3: every control whose label no longer fits its box, by name. */
    clippedControls: Array.from(dialog.querySelectorAll<HTMLElement>("button, a, label, select")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible";
    }).map((el) => (el.textContent ?? "").trim().slice(0, 50)),
    accounts: Object.fromEntries(Array.from(dialog.querySelectorAll<HTMLElement>("[data-onboarding-engine]")).map((el) => [el.dataset.onboardingEngine!, {
      header: el.querySelector("[data-onboarding-engine-header]")?.textContent ?? null,
      rows: el.querySelectorAll("[data-mobile2-account]").length,
      addRow: el.querySelector("[data-mobile2-account-add]") !== null,
    }])),
    filledButtons: Array.from(dialog.querySelectorAll<HTMLElement>("button")).filter((el) => el.classList.contains("bg-accent") && el.getBoundingClientRect().width > 0).map((el) => (el.textContent ?? "").trim()),
    /* The phone pager lays every page out side by side; only the page on screen competes for the eye. */
    filledOnScreen: Array.from(dialog.querySelectorAll<HTMLElement>("button")).filter((el) => {
      const r = el.getBoundingClientRect();
      return el.classList.contains("bg-accent") && r.width > 0 && r.left >= -1 && r.right <= window.innerWidth + 1;
    }).map((el) => (el.textContent ?? "").trim()),
    /* The band sits inside the phone's horizontal pager: on screen means inside the viewport's width. */
    tourBandOnScreen: (() => {
      const band = dialog.querySelector("[data-tour-start]");
      if (!band) return null;
      const r = band.getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    })(),
    tourStartInView: (() => {
      const band = dialog.querySelector("[data-tour-start]");
      const body = band?.closest<HTMLElement>(".overflow-y-auto");
      if (!band || !body) return null;
      return band.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1;
    })(),
    /* The links under the band, measured by their glyphs: a link cut by the footer reads as broken. */
    tourLinksInView: (() => {
      const links = Array.from(dialog.querySelectorAll<HTMLElement>("[data-tour-links] a"));
      const body = links[0]?.closest<HTMLElement>(".overflow-y-auto");
      if (links.length === 0 || !body) return null;
      const bottom = body.getBoundingClientRect().bottom;
      return links.every((link) => link.getBoundingClientRect().bottom <= bottom + 1);
    })(),
    stepCounter: dialog.querySelector("footer span")?.textContent ?? dialog.querySelector("[data-onboarding-step-list-toggle]")?.textContent ?? null,
    phone: dialog.querySelector("[data-phone-state]") ? {
      state: dialog.querySelector<HTMLElement>("[data-phone-state]")!.dataset.phoneState ?? null,
      text: dialog.querySelector("[data-phone-state]")!.textContent ?? "",
      links: Array.from(dialog.querySelectorAll("[data-phone-state] a")).map((el) => el.getAttribute("href")),
      buttons: Array.from(dialog.querySelectorAll<HTMLElement>("[data-phone-state] button")).map((el) => (el.textContent ?? "").trim()),
      failure: dialog.querySelector<HTMLElement>("[data-phone-failure]")?.dataset.phoneFailure ?? null,
      link: dialog.querySelector<HTMLInputElement>("[data-phone-link]")?.value ?? null,
      qr: dialog.querySelector("[data-phone-state] img") !== null,
    } : null,
    voice: dialog.querySelector("[data-onboarding-voice]") ? {
      selected: dialog.querySelector<HTMLElement>("[data-voice-backend][data-selected]")?.dataset.voiceBackend ?? null,
      result: dialog.querySelector("[data-voice-check-result]")?.textContent ?? null,
      tone: dialog.querySelector<HTMLElement>("[data-voice-check-result]")?.dataset.tone ?? null,
      keyField: dialog.querySelector("[data-voice-key-field] input") !== null,
      skip: dialog.querySelector("[data-voice-skip]") !== null,
      html: dialog.querySelector("[data-onboarding-voice]")!.innerHTML,
    } : null,
    tour: dialog.querySelector("[data-onboarding-tour]") ? {
      cardTops: Array.from(dialog.querySelectorAll<HTMLElement>("[data-tour-card]")).map((el) => Math.round(el.getBoundingClientRect().top)),
      pictures: dialog.querySelectorAll("[data-tour-card] svg").length,
      start: dialog.querySelector("[data-tour-start]") !== null,
      create: dialog.querySelector("[data-tour-create]")?.textContent ?? null,
      projects: Array.from(dialog.querySelectorAll<HTMLOptionElement>("[data-tour-project] option")).map((el) => el.textContent ?? ""),
    } : null,
    /* The Check step (slice 2): row states, the open failure and its block. */
    health: dialog.querySelector("[data-health-check]") ? {
      state: dialog.querySelector<HTMLElement>("[data-health-check]")!.dataset.healthCheck ?? null,
      rows: Array.from(dialog.querySelectorAll<HTMLElement>("[data-health-row]")).map((el) => `${el.dataset.healthRow}=${el.dataset.healthState}`),
      failure: dialog.querySelector<HTMLElement>("[data-health-failure]")?.dataset.healthFailure ?? null,
      failureText: dialog.querySelector("[data-health-failure] p")?.textContent ?? null,
      action: dialog.querySelector<HTMLElement>("[data-health-action]")?.dataset.healthAction ?? null,
      summary: dialog.querySelector<HTMLElement>("[data-health-summary]")?.dataset.healthSummary ?? null,
      summaryText: dialog.querySelector("[data-health-summary]")?.textContent ?? null,
      lead: dialog.querySelector("[data-health-lead]")?.textContent ?? null,
      detailsOpen: dialog.querySelector("[data-health-details]") !== null,
      /* Anything inside the failure block wider than the block itself. */
      failureOverflow: (() => {
        const block = dialog.querySelector<HTMLElement>("[data-health-failure]");
        if (!block) return 0;
        const edge = block.getBoundingClientRect().right;
        return Math.max(0, ...Array.from(block.querySelectorAll<HTMLElement>("*")).map((el) => Math.round(el.getBoundingClientRect().right - edge)));
      })(),
      rowLabelsClipped: Array.from(dialog.querySelectorAll<HTMLElement>("[data-health-row] span.flex-1")).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ""),
      /* Lines each row label takes: a note beside the longest label used to
         push it to three on a phone (#1876). */
      rowLines: Array.from(dialog.querySelectorAll<HTMLElement>("[data-health-row]")).map((el) => {
        const label = el.querySelector<HTMLElement>("span.flex-1");
        const height = label ? parseFloat(getComputedStyle(label).lineHeight) : 0;
        return { id: el.dataset.healthRow ?? "", lines: label && height ? Math.round(label.getBoundingClientRect().height / height) : 0 };
      }),
      note: dialog.querySelector("[data-health-note]")?.textContent ?? null,
      cleanupProblem: dialog.querySelector("[data-health-cleanup-problem]")?.textContent ?? null,
      cleaning: dialog.querySelector("[data-health-cleaning]")?.textContent ?? null,
      startFailed: dialog.querySelector("[data-health-start-failed]")?.textContent ?? null,
      /* Everything the failure block paints, for stray markdown marks. */
      failureAll: dialog.querySelector("[data-health-failure]")?.textContent ?? null,
      actionLabel: dialog.querySelector("[data-health-action]")?.textContent ?? null,
      /* Filled accent buttons on screen, the footer's included: one at a time. */
      filledAccents: Array.from(dialog.querySelectorAll<HTMLElement>("button")).filter((el) => el.classList.contains("bg-accent")).map((el) => el.dataset.onboardingPrimary !== undefined ? "footer" : el.dataset.healthStart !== undefined ? "start" : el.textContent ?? ""),
      startFilled: (() => {
        const start = dialog.querySelector<HTMLElement>("[data-health-start]");
        return start ? getComputedStyle(start).backgroundColor === getComputedStyle(dialog.querySelector<HTMLElement>("[data-onboarding-primary]") ?? start).backgroundColor : null;
      })(),
      /* Whether an element sits inside the visible rect of the body that scrolls it, at rest. */
      inView: (() => {
        const visible = (selector: string) => {
          const el = dialog.querySelector<HTMLElement>(selector);
          if (!el) return null;
          let box: HTMLElement | null = el.parentElement;
          while (box && box !== dialog && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
          const outer = (box ?? dialog).getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          return rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1;
        };
        return { start: visible("[data-health-start]"), summary: visible("[data-health-summary]"), details: visible("[data-health-details]") };
      })(),
    } : null,
  };
}

/* The Check step's states for the capture (#1876 slice 2). The server's
   health check spawns real agents, so the capture serves its answers from
   these records instead: each state renders exactly as a real run's record
   would, and no quota is spent. */
const HEALTH_RUNTIME = { engine: "claude", model: "haiku", effort: "low" };
const HEALTH_ROW_IDS = ["spawn", "delivery", "report", "wake", "filing"] as const;
const HEALTH_FAILURES: readonly { code: string; row: typeof HEALTH_ROW_IDS[number]; params?: Record<string, string>; agentPath?: string; accountId?: string; name?: string }[] = [
  { code: "CLI_MISSING", row: "spawn", params: { engine: "Claude", bin: "claude" } },
  { code: "ENGINE_NOT_CONNECTED", row: "spawn", params: { engine: "Claude", bin: "claude" } },
  { code: "ACCOUNT_EXHAUSTED", row: "spawn", params: { engine: "Claude", bin: "claude", time: "2100-01-02T15:00:00.000Z" }, accountId: "account-a" },
  { code: "SPAWN_TIMEOUT", row: "spawn", params: { engine: "Claude", bin: "claude" } },
  { code: "SPAWN_TIMEOUT", row: "spawn", params: { engine: "Claude", bin: "claude" }, agentPath: "/var/tmp/health-stage.jsonl", name: "spawn-timeout-agent" },
  { code: "DELIVERY_FAILED", row: "delivery" },
  { code: "MCP_UNREACHABLE", row: "report" },
  { code: "REPORT_TIMEOUT", row: "report", agentPath: "/var/tmp/health-stage.jsonl" },
  { code: "TICK_OFF", row: "wake" },
  { code: "WAKE_NOT_OWED", row: "wake" },
  { code: "WAKE_UNDELIVERED", row: "wake" },
  { code: "SEAT_MISFILED", row: "filing", params: { project: "harbor" } },
  /* Both reach the step with no params at all: the seat record that could not
     be read, and the whole-run bound tripping while row 1 is still open. */
  { code: "SEAT_UNREADABLE", row: "filing" },
  { code: "RUN_BOUND", row: "spawn", params: { engine: "Claude", bin: "claude" } },
];

/* "noSeat" is the pass a new install ends on: it has no orchestrator, so row 5
   is skipped with its note. "cleanupProblem" is a pass whose cleanup could not
   finish, and "cleaning" is the same pass on a poll that landed between the run
   settling and the end of cleanup. */
type HealthState = "idle" | "running" | "passed" | "noSeat" | "cleanupProblem" | "cleaning" | "stopped" | { failed: typeof HEALTH_FAILURES[number] };

function healthAnswer(state: HealthState): unknown {
  if (state === "idle") return { runtime: HEALTH_RUNTIME, run: null };
  const at = (seconds: number) => new Date(Date.parse("2100-01-02T10:00:00.000Z") + seconds * 1000).toISOString();
  const failedAt = typeof state === "object" ? HEALTH_ROW_IDS.indexOf(state.failed.row) : -1;
  const passed = state === "passed" || state === "noSeat" || state === "cleanupProblem" || state === "cleaning";
  const rows = HEALTH_ROW_IDS.map((id, index) => {
    const rowState = passed ? (state === "noSeat" && id === "filing" ? "skipped" : "passed")
      : state === "running" ? (index < 2 ? "passed" : index === 2 ? "running" : "waiting")
        : state === "stopped" ? (index < 1 ? "passed" : "waiting")
          : index < failedAt ? "passed" : index === failedAt ? "failed" : "waiting";
    const failure = rowState === "failed" && typeof state === "object"
      ? { code: state.failed.code, params: state.failed.params ?? {}, detail: `${state.failed.code.toLowerCase()}: the recorded machine detail for this row, as the server redacted it, long enough to wrap on a phone`, agentPath: state.failed.agentPath ?? null, accountId: state.failed.accountId ?? null }
      : null;
    return { id, state: rowState, startedAt: rowState === "waiting" || rowState === "skipped" ? null : at(index * 9), finishedAt: rowState === "passed" || rowState === "failed" ? at(index * 9 + 8) : null, failure, note: rowState === "skipped" ? "no-seat" : null };
  });
  const runState = typeof state === "object" ? "failed" : passed ? "passed" : state;
  /* What a cleanup that could not finish reports, as the server redacted it. */
  const problems = state === "cleanupProblem" ? ["worktree: device or resource busy", "task card: the board did not answer"] : [];
  return {
    runtime: HEALTH_RUNTIME,
    run: { id: "capture1", state: runState, startedAt: at(0), finishedAt: runState === "running" ? null : at(50), runtime: HEALTH_RUNTIME, rows, cleanup: { done: runState !== "running" && state !== "cleaning", problems }, version: "0.0.0" },
  };
}

async function captureOnboarding(): Promise<void> {
  const providerOnly = process.env.BOARD_CAPTURE_CASE === "provider-account";
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  for (const dir of [REPO_DIR, OUT_DIR, BIN_DIR, path.join(HOME, ".claude"), path.join(BASE, "git-home"), path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), path.join(BASE, "tmux"), STATE_DIR, path.join(HOME, ".codex/sessions")]) fs.mkdirSync(dir, { recursive: true });
  git(REPO_DIR, "init", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# harbor\n", "utf8");
  git(REPO_DIR, "add", "README.md");
  git(REPO_DIR, "commit", "-m", "harbor: first commit");
  /* A transcript the user made before ever opening the Viewer: the guide must
     still open, because transcripts are not Viewer state. */
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  writeConversation(folder, `${"1".padStart(8, "0")}-1876-4000-8000-000000000000`, "Tidy the harbor README", "Done: the README now names the project.", false, "2100-01-02T10:00:05.000Z");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const report: Record<string, unknown> = { commit: captureCommit(), case: providerOnly ? "provider-account" : "onboarding" };
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const tailscale = createTailscaleStub({ root: BASE });
  const resetInstall = async (codexInstalled: boolean) => {
    fs.rmSync(path.join(STATE_DIR, "onboarding.json"), { force: true });
    fs.rmSync(path.join(STATE_DIR, "role-presets.json"), { force: true });
    claudeSignedIn(true);
    /* Codex holds a credential while its command is missing: the card must
       still read Not installed, and its roles stay blocked (#1876 P1). */
    codexSignedIn(true);
    fakeCli("claude", true);
    fakeCli("codex", codexInstalled);
    await fetch(`${baseUrl}/api/accounts/cli`);
  };
  try {
    fakeCli("claude", true);
    claudeSignedIn(true);
    server = spawn(CAPTURE_BUN, ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: repoRoot,
      /* PATH without the operator's own bin directories: which CLI is
         installed is decided by the stubs under the seeded home alone. */
      /* The stand-in tailscale comes first, so the phone step never reads or
         changes the operator's own tailnet (#1876 slice 3). */
      env: { ...buildEnvironment(port), PATH: `${tailscale.dir}:/usr/bin:/bin`, HOSTNAME: "127.0.0.1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    const first = await (await fetch(`${baseUrl}/api/onboarding`)).json() as { marker: unknown };
    must(first.marker === null, `a first run with only engine transcripts answered marker ${JSON.stringify(first.marker)}; the guide would not open`);
    report.firstRunMarker = first.marker;
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    for (const viewport of (providerOnly ? ONBOARDING_VIEWPORTS.filter((item) => item.width === 1280 || item.width === 390) : ONBOARDING_VIEWPORTS)) {
      for (const colorScheme of (providerOnly ? ["light"] : ["light", "dark"]) as Array<"light" | "dark">) {
        for (const locale of ["en", "uk"] as const) {
          const tag = `${viewport.tag}-${colorScheme}-${locale}`;
          const frames: Record<string, unknown> = {};
          await resetInstall(false);
          /* The page adopts the language the server keeps over the browser's
             own (docs/design/orchestrator-reports.md §4.2), so the combination's
             language is written there as the operator's choice. */
          const localeWrite = await fetch(`${baseUrl}/api/operator/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ locale, source: "chosen" }) });
          must(localeWrite.ok, `${tag}: the interface language write answered ${localeWrite.status}`);
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme,
            reducedMotion: "reduce",
            ...(viewport.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
          });
          await context.addInitScript((lang: string) => {
            Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem("llv_lang", lang);
            localStorage.setItem("llvSound", "0");
          }, locale);
          const page = await context.newPage();
          if (providerOnly) await page.route("**/api/accounts", async (route) => {
            const response = await route.fetch();
            const body = await response.json() as { claude?: { accounts?: Record<string, unknown>[] } };
            body.claude?.accounts?.push({
              id: "provider-fixture", label: "Provider", kind: "managed", authPresent: true,
              auth: { state: "authenticated", method: "provider", email: null, plan: null, checkedAt: null },
              loginPending: false, loginState: "authenticated", attemptState: null, deviceAuth: null,
              limits: { state: "unavailable", session: null, weekly: null, tiers: [], checkedAt: null },
              provider: { baseUrl: "https://opencode.ai/zen/go", model: "fixture-large", smallFastModel: "fixture-small" },
            });
            await route.fulfill({ response, json: body });
          });
          const shot = async (name: string, check: (reading: NonNullable<ReturnType<typeof measureOnboarding>>) => void) => {
            await page.waitForTimeout(350);
            const reading = await page.evaluate(measureOnboarding, viewport.phone);
            if (!reading) { must(false, `${tag} ${name}: the dialog is not on screen`); return; }
            frames[name] = reading;
            await page.screenshot({ path: path.join(OUT_DIR, `${tag}-${name}.png`) });
            const d = reading.dialog;
            must(d.x >= 0 && d.y >= 0 && d.x + d.w <= reading.viewport.w && d.y + d.h <= reading.viewport.h, `${tag} ${name}: dialog ${JSON.stringify(d)} leaves the ${reading.viewport.w}×${reading.viewport.h} viewport`);
            must(!reading.scroller || reading.scroller.scrollWidth <= reading.scroller.clientWidth + 1, `${tag} ${name}: the body overflows sideways (${reading.scroller?.scrollWidth} > ${reading.scroller?.clientWidth})`);
            must(reading.documentOverflowX <= 0, `${tag} ${name}: the page scrolls sideways by ${reading.documentOverflowX}px`);
            for (const label of reading.roleLabels) must(!label.clipped, `${tag} ${name}: role label "${label.text}" is clipped at ${label.w}px`);
            for (const button of reading.footerButtons) must(!button.clipped && button.inside, `${tag} ${name}: footer button "${button.text}" is clipped or outside the footer`);
            must(reading.segmentOverflow <= 0, `${tag} ${name}: an engine control overflows its cell by ${reading.segmentOverflow}px`);
            if (providerOnly) report[`${tag}:${name}:otherSmallTargets`] = reading.smallTargets;
            else must(reading.smallTargets.length === 0, `${tag} ${name}: targets under 44px: ${reading.smallTargets.join("; ")}`);
            check(reading);
          };

          /* #2166 moved Agents under "Later, any time", outside Continue and
             Back, and a reload reopens the guide on the next numbered step:
             the walk opens the step it measures by name. On the phone the
             step list sits behind its toggle. */
          const openStep = async (step: string) => {
            await page.waitForSelector("[data-onboarding-dialog]", { timeout: 60_000 });
            if (viewport.phone && !(await page.$(`[data-onboarding-step="${step}"]`))) await page.click("[data-onboarding-step-list-toggle]");
            await page.click(`[data-onboarding-step="${step}"]`);
          };

          try {
            /* 1. First run: the guide opens by itself on the Engines step. */
            await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
            await page.waitForSelector('[data-onboarding-engine="codex"][data-engine-state="missing"]', { timeout: 60_000 });
            await page.waitForSelector('[data-onboarding-engine="claude"][data-engine-state="connected"]', { timeout: 60_000 });
            await shot("engines-one-connected", (r) => {
              must(r.engines.claude === "connected" && r.engines.codex === "missing", `${tag}: with a Codex credential and no Codex command the engines read ${JSON.stringify(r.engines)}`);
            });

            if (providerOnly) {
              const selector = '[data-onboarding-accounts="claude"] [data-claude-provider-editor="new"]';
              await page.locator(`${selector} button`).first().click();
              await page.locator(`${selector} input`).first().waitFor();
              await page.locator(`${selector} input`).last().scrollIntoViewIfNeeded();
              await shot("engines-provider-form", () => {});
              const geometry = await page.locator(selector).evaluate((node) => ({
                fields: [...node.querySelectorAll("input,button")].map((field) => {
                  const rect = field.getBoundingClientRect();
                  return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
                }),
                overflow: node.scrollWidth - node.clientWidth,
              }));
              must(geometry.overflow <= 1 && geometry.fields.every((field) => field.width >= 44 && (viewport.phone ? field.height >= 44 : field.height >= 24) && field.left >= 0 && field.right <= viewport.width + 1), `${tag}: provider controls overflow or collapse: ${JSON.stringify(geometry)}`);
              await page.locator(`${selector} button`).first().click();
              const edit = '[data-onboarding-accounts="claude"] [data-claude-provider-editor="provider-fixture"]';
              await page.locator(`${edit} button`).first().click();
              await page.locator(`${edit} input`).last().scrollIntoViewIfNeeded();
              await shot("engines-provider-edit", () => {});
              const editGeometry = await page.locator(edit).evaluate((node) => ({
                fields: [...node.querySelectorAll("input,button")].map((field) => {
                  const rect = field.getBoundingClientRect();
                  return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
                }),
                overflow: node.scrollWidth - node.clientWidth,
              }));
              must(editGeometry.overflow <= 1 && editGeometry.fields.every((field) => field.width >= 44 && (viewport.phone ? field.height >= 44 : field.height >= 24) && field.left >= 0 && field.right <= viewport.width + 1), `${tag}: provider edit controls overflow or collapse: ${JSON.stringify(editGeometry)}`);
              report[tag] = frames;
              await context.close();
              continue;
            }

            /* 2. The mapping: six roles and two variants sit on Codex, which is not connected. */
            await openStep("agents");
            await page.waitForSelector("[data-mapping-banner]", { timeout: 30_000 });
            await page.click('[data-mapping-group="rare"] button[aria-expanded]');
            await page.waitForSelector('[data-mapping-row="deployer"]');
            await shot("agents-blocked", (r) => {
              /* Eight rows ship on Codex: builder, fix rounds, reviewer, small-change reviewer, verifier, cleaner, prod-auditor, deployer. */
              must(r.blockedRows === 8, `${tag}: ${r.blockedRows} blocked rows, expected the eight Codex rows`);
              must(r.nudges >= 1, `${tag}: no very-heavy nudge on the reviewer's xhigh default`);
              must(r.legendFirst, `${tag}: the cost legend comes after the first row`);
              must(r.costClasses.includes("reviewer=very-heavy") && r.costClasses.includes("cleaner=moderate"), `${tag}: cost classes ${r.costClasses.join(", ")}`);
              /* Ten rows, and the small-change builder, docs builder and small-change reviewer (docs/design/model-sizing-tiers.md §1). */
              must(r.roleLabels.length === 13, `${tag}: ${r.roleLabels.length} role rows rendered, expected 13`);
            });

            /* 3. "Move them to Claude", then its receipt and every row changed. */
            await page.click("[data-mapping-move]");
            await page.waitForSelector("[data-mapping-receipt]", { timeout: 30_000 });
            await shot("agents-moved", (r) => {
              must(r.blockedRows === 0 && r.banner === null, `${tag}: after the move ${r.blockedRows} rows are still blocked`);
            });
            const moved = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "role-presets.json"), "utf8")) as { overrides: Record<string, { config?: { engine: string }; variants?: Record<string, { engine: string }> }> };
            must(moved.overrides.reviewer?.config?.engine === "claude" && moved.overrides.builder?.variants?.["apply-fixes"]?.engine === "claude", `${tag}: the stored mapping after the move is ${JSON.stringify(moved.overrides)}`);
            await page.click("[data-mapping-receipt] button");
            await page.waitForSelector("[data-mapping-banner]", { timeout: 30_000 });
            /* The banner is back as soon as the answer lands; the file behind
               it is written by the server, so the read waits for it rather
               than racing it. */
            let undone = { overrides: {} as Record<string, unknown> };
            const undoneBy = Date.now() + 10_000;
            do {
              undone = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "role-presets.json"), "utf8")) as { overrides: Record<string, unknown> };
              if (Object.keys(undone.overrides).length === 0) break;
              await page.waitForTimeout(100);
            } while (Date.now() < undoneBy);
            must(Object.keys(undone.overrides).length === 0, `${tag}: undo left ${JSON.stringify(undone.overrides)}`);

            /* 3b. Both engines connected, with quota readings: the headroom sits
               in the cost cell and the rows keep their rhythm. Then one changed
               row, then its reset. */
            fakeCli("codex", true);
            await fetch(`${baseUrl}/api/accounts/cli`);
            await page.route("**/api/accounts", async (route) => {
              const response = await route.fetch();
              const body = await response.json() as Record<string, { accounts?: Record<string, unknown>[] }>;
              for (const engine of ["claude", "codex"]) for (const account of body[engine]?.accounts ?? []) account.limits = SEEDED_LIMITS;
              await route.fulfill({ response, json: body });
            });
            await page.reload({ waitUntil: "domcontentloaded" });
            await openStep("agents");
            await page.waitForSelector("[data-mapping-headroom]", { timeout: 60_000 });
            await page.click('[data-mapping-group="rare"] button[aria-expanded]');
            await page.waitForSelector('[data-mapping-row="deployer"]');
            await shot("agents-headroom", (r) => {
              must(r.blockedRows === 0 && r.banner === null, `${tag}: both engines connected and ${r.blockedRows} rows still blocked`);
              must(r.headrooms.length >= 7, `${tag}: ${r.headrooms.length} headroom lines with quota readings`);
              for (const line of r.headrooms) must(line.h <= 17, `${tag}: headroom "${line.text}" wraps (${line.h}px)`);
              if (!viewport.phone) {
                const tallest = Math.max(...r.plainRowHeights);
                must(tallest <= 52, `${tag}: a mapping row with a headroom line is ${tallest}px tall`);
              }
              must(Boolean(r.selectedSegmentRing && r.selectedSegmentRing !== "none"), `${tag}: the selected engine segment has no ring`);
            });
            await page.locator('[data-mapping-row="reviewer"] select').nth(1).selectOption("high");
            await page.waitForSelector('[data-mapping-reset="reviewer"]');
            await page.locator('[data-mapping-row="reviewer"]').scrollIntoViewIfNeeded();
            await shot("agents-changed", (r) => {
              must(r.changedRows === 1, `${tag}: ${r.changedRows} changed rows after one change`);
              if (viewport.phone) for (const offset of r.chipOffsets) must(offset <= 6, `${tag}: a card's cost chip sits ${offset}px below its role name`);
            });
            await page.click('[data-mapping-reset="reviewer"]');
            await page.waitForSelector('[data-mapping-reset="reviewer"]', { state: "detached" });

            /* 3c. An update reset a stale row (docs/design/model-sizing-tiers.md
               §5): the row says what it was, and Restore puts it back through
               the ordinary mapping write, which clears the notice. */
            const retirementId = "2026-09-builder-frontend-opus-xhigh";
            const presetsFile = path.join(STATE_DIR, "role-presets.json");
            fs.writeFileSync(presetsFile, JSON.stringify({ schemaVersion: 1, overrides: {}, retirements: { [retirementId]: { at: "2100-01-02T10:00:00.000Z", reset: { row: "builder:frontend", from: { engine: "claude", model: "opus", effort: "xhigh" } } } } }));
            await page.reload({ waitUntil: "domcontentloaded" });
            await openStep("agents");
            await page.waitForSelector('[data-mapping-retired="builder:frontend"]', { timeout: 60_000 });
            await page.locator('[data-mapping-row="builder:frontend"]').scrollIntoViewIfNeeded();
            await shot("agents-reset", (r) => {
              must(r.retired.length === 1 && r.retired[0]!.row === "builder:frontend", `${tag}: reset lines ${JSON.stringify(r.retired)}`);
              for (const line of r.retired) must(!line.clipped, `${tag}: the reset line "${line.text}" is clipped at ${line.w}px`);
            });
            await page.click('[data-mapping-restore="builder:frontend"]');
            await page.waitForSelector('[data-mapping-retired="builder:frontend"]', { state: "detached" });
            /* The row turns "changed" as the write leaves; the file lands when
               the server answers, so the read waits for it. */
            type StoredPresets = { overrides: { builder?: { variants?: { frontend?: { effort: string } } } }; retirements?: Record<string, { reset?: unknown }> };
            let restored = JSON.parse(fs.readFileSync(presetsFile, "utf8")) as StoredPresets;
            for (const restoredBy = Date.now() + 10_000; Date.now() < restoredBy && restored.overrides.builder?.variants?.frontend === undefined;) {
              await page.waitForTimeout(100);
              restored = JSON.parse(fs.readFileSync(presetsFile, "utf8")) as StoredPresets;
            }
            must(restored.overrides.builder?.variants?.frontend?.effort === "xhigh" && restored.retirements?.[retirementId] !== undefined && restored.retirements[retirementId]!.reset === undefined, `${tag}: after Restore the stored mapping is ${JSON.stringify(restored)}`);
            fs.writeFileSync(presetsFile, JSON.stringify({ schemaVersion: 1, overrides: {} }));
            await page.unroute("**/api/accounts");
            codexSignedIn(false);
            fakeCli("codex", false);
            await fetch(`${baseUrl}/api/accounts/cli`);
            await page.reload({ waitUntil: "domcontentloaded" });
            await openStep("agents");
            await page.waitForSelector("[data-mapping-banner]", { timeout: 60_000 });

            /* 4. Codex installed and signed out; its sign-in opens in place. */
            fakeCli("codex", true);
            await openStep("engines");
            await page.click('[data-onboarding-engine="codex"] button');
            await page.waitForSelector('[data-onboarding-engine="codex"][data-engine-state="signed-out"]', { timeout: 30_000 });
            /* Slice 3: the card is the account list, with the add row always there. */
            await page.waitForSelector('[data-onboarding-accounts="codex"] [data-mobile2-account-add="codex"]');
            await shot("engines-sign-in", (r) => {
              must(r.engines.codex === "signed-out", `${tag}: codex reads ${r.engines.codex} after the install`);
              must(r.accounts.codex?.addRow === true, `${tag}: a signed-out Codex card offers no Add row`);
            });

            /* 5. Neither engine connected: both steps say so. A reload reopens
               the unfinished guide by itself, on the step after the last done. */
            claudeSignedIn(false);
            fakeCli("codex", false);
            await fetch(`${baseUrl}/api/accounts/cli`);
            await page.reload({ waitUntil: "domcontentloaded" });
            await openStep("agents");
            await page.waitForSelector("[data-agent-mapping] [data-mapping-row]", { timeout: 60_000 });
            await shot("agents-neither", (r) => {
              must(r.roleLabels.length > 0 && r.blockedRows === r.roleLabels.length, `${tag}: with no engine ${r.blockedRows} of ${r.roleLabels.length} rendered rows are blocked, expected every one`);
            });
            await openStep("engines");
            await page.waitForSelector("[data-onboarding-engines-note]");
            await shot("engines-neither", (r) => {
              must(r.engines.claude !== "connected" && r.engines.codex === "missing", `${tag}: engines read ${JSON.stringify(r.engines)} with nothing signed in`);
            });
            if (!viewport.phone) {
              await page.click('[data-onboarding-step="agents"]');
              await page.waitForSelector("[data-agent-mapping] [data-mapping-row]");
              const mark = await page.$eval('[data-onboarding-step="engines"] [data-step-mark]', (el) => (el as HTMLElement).dataset.stepMark);
              must(mark === "warn", `${tag}: with no engine the visited Engines step shows ${mark}, expected the warning mark`);
            }
            claudeSignedIn(true);

            /* 6. Close, finish later: the marker says dismissed and a reload stays shut. */
            await page.keyboard.press("Escape");
            await page.waitForSelector("[data-onboarding-dialog]", { state: "detached" });
            const marker = await (await fetch(`${baseUrl}/api/onboarding`)).json() as { marker: { dismissedAt: string | null } | null };
            must(Boolean(marker.marker?.dismissedAt), `${tag}: Escape did not record a dismissal`);
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.waitForTimeout(3_000);
            must(await page.$("[data-onboarding-dialog]") === null, `${tag}: the dismissed guide reopened by itself`);

            /* 7. The menu row opens the mapping alone. */
            if (viewport.phone) {
              await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 60_000 });
              await page.click('[data-mobile2-open="menu"]');
              await page.waitForSelector('[data-testid="menu-agent-mapping"]');
              await page.screenshot({ path: path.join(OUT_DIR, `${tag}-menu.png`) });
              await page.click('[data-testid="menu-agent-mapping"]');
            } else {
              await page.click("[data-rail-menu]");
              await page.waitForSelector("[data-rail-menu-agent-mapping]");
              await page.screenshot({ path: path.join(OUT_DIR, `${tag}-menu.png`) });
              await page.click("[data-rail-menu-agent-mapping]");
            }
            await page.waitForSelector('[data-onboarding-dialog="mapping"] [data-mapping-row]', { timeout: 30_000 });
            await shot("mapping-alone", (r) => {
              must(r.heading === null && r.roleLabels.length >= 7, `${tag}: the mapping surface read heading=${r.heading}, ${r.roleLabels.length} rows`);
              if (!viewport.phone) for (const width of r.modelSelectWidths) must(width <= 221, `${tag}: a model select stretches to ${width}px on the standalone mapping`);
            });

            /* 8. The guide from the menu, walked to its end: Open the board completes it. */
            await page.keyboard.press("Escape");
            await page.waitForSelector("[data-onboarding-dialog]", { state: "detached" });
            if (viewport.phone) {
              await page.click('[data-mobile2-open="menu"]');
              await page.waitForSelector('[data-testid="menu-setup-guide"]');
              await page.click('[data-testid="menu-setup-guide"]');
            } else {
              await page.click("[data-rail-menu]");
              await page.waitForSelector("[data-rail-menu-setup-guide]");
              await page.click("[data-rail-menu-setup-guide]");
            }
            await page.waitForSelector('[data-onboarding-dialog="guide"]');
            /* The guide reopens on the first step not yet done; go to Agents by the step list. */
            await openStep("agents");
            await page.waitForSelector("[data-agent-mapping] [data-mapping-row]");
            await shot("finish", () => {});

            /* 9. The Check step, one frame per state its run can be in. */
            let health: unknown = healthAnswer("idle");
            /* A start the server refuses, when a frame asks for one; every GET
               answers the state being captured. */
            let healthStart: { status: number; json: unknown } | null = null;
            await page.route("**/api/onboarding/health*", (route) => route.request().method() === "POST" && healthStart
              ? route.fulfill({ status: healthStart.status, json: healthStart.json })
              : route.fulfill({ json: health }));
            await page.click("[data-onboarding-primary]");
            /* `within` tells two frames of the same run state apart, so a frame is
               never shot before its own answer has rendered. */
            const checkFrame = async (name: string, answer: unknown, expectState: string, check: (reading: NonNullable<ReturnType<typeof measureOnboarding>>) => void, within?: string) => {
              health = answer;
              await openStep("agents");
              await page.waitForSelector("[data-agent-mapping]");
              await openStep("check");
              await page.waitForSelector(`[data-health-check="${expectState}"]${within ? ` ${within}` : ""}`, { timeout: 30_000 });
              await shot(name, (r) => {
                must(r.health !== null && r.health.rows.length === 5, `${tag} ${name}: the check shows ${r.health?.rows.length ?? 0} rows`);
                must((r.health?.failureOverflow ?? 0) <= 0, `${tag} ${name}: the failure block overflows by ${r.health?.failureOverflow}px`);
                must((r.health?.rowLabelsClipped.length ?? 0) === 0, `${tag} ${name}: clipped row labels ${r.health?.rowLabelsClipped.join(", ")}`);
                /* One accent while the step waits on the user, none while it runs. */
                const accents = expectState === "running" ? 0 : 1;
                must(r.health?.filledAccents.length === accents, `${tag} ${name}: ${r.health?.filledAccents.length} filled accent buttons (${r.health?.filledAccents.join(", ")}), expected ${accents}`);
                const tall = (r.health?.rowLines ?? []).filter((entry) => entry.lines > 2);
                must(tall.length === 0, `${tag} ${name}: row labels over two lines: ${tall.map((entry) => `${entry.id}=${entry.lines}`).join(", ")}`);
                check(r);
              });
            };
            await checkFrame("check-idle", healthAnswer("idle"), "idle", (r) => {
              must(Boolean(r.health?.lead?.includes("Haiku")), `${tag}: the check's lead does not name the model: ${r.health?.lead}`);
              must(r.health?.filledAccents[0] === "start", `${tag}: before a run the accent is on ${r.health?.filledAccents[0]}`);
            });
            await checkFrame("check-running", healthAnswer("running"), "running", (r) => {
              must(r.health?.rows.join(" ") === "spawn=passed delivery=passed report=running wake=waiting filing=waiting", `${tag}: running rows ${r.health?.rows.join(" ")}`);
              /* Nothing is filled while it runs: the brightest control on a
                 two-minute wait would otherwise be the one that leaves. */
              must(r.health?.filledAccents.length === 0, `${tag}: while the check runs the accent is on ${r.health?.filledAccents.join(", ")}`);
            });
            await checkFrame("check-passed", healthAnswer("passed"), "passed", (r) => {
              must(r.health?.summary === "passed", `${tag}: a passed run shows summary ${r.health?.summary}`);
              must(r.health?.filledAccents[0] === "footer", `${tag}: after a pass the accent is on ${r.health?.filledAccents[0]}, not Open the board`);
            });
            /* The pass a new install ends on: no orchestrator, so row 5 is skipped. */
            await checkFrame("check-passed-no-seat", healthAnswer("noSeat"), "passed", (r) => {
              must(r.health?.rows.join(" ") === "spawn=passed delivery=passed report=passed wake=passed filing=skipped", `${tag}: the no-orchestrator pass shows ${r.health?.rows.join(" ")}`);
              must(Boolean(r.health?.note), `${tag}: the skipped row carries no note`);
              const filing = r.health?.rowLines.find((entry) => entry.id === "filing");
              must(filing?.lines === 1, `${tag}: the longest row label takes ${filing?.lines} lines beside its note`);
            }, "[data-health-note]");
            await checkFrame("check-cleanup-problem", healthAnswer("cleanupProblem"), "passed", (r) => {
              must(Boolean(r.health?.cleanupProblem), `${tag}: a cleanup that could not finish says nothing`);
              must(/next time|наступного разу/.test(r.health?.cleanupProblem ?? ""), `${tag}: the cleanup line gives no next step: ${r.health?.cleanupProblem}`);
            }, "[data-health-cleanup-problem]");
            /* Between the run settling and the end of cleanup: every poll that
               lands in that window shows this line. */
            await checkFrame("check-cleaning", healthAnswer("cleaning"), "passed", (r) => {
              must(Boolean(r.health?.cleaning), `${tag}: a run still cleaning up says nothing`);
              must(r.health?.cleanupProblem === null, `${tag}: a cleanup still running already reports a problem`);
            }, "[data-health-cleaning]");
            await checkFrame("check-stopped", healthAnswer("stopped"), "stopped", (r) => {
              must(r.health?.summary === "stopped", `${tag}: a stopped run shows summary ${r.health?.summary}`);
              must(r.health!.rows.slice(1).every((entry) => entry.endsWith("=notRun")), `${tag}: after Stop the rows that never ran read ${r.health?.rows.join(" ")}`);
            });
            /* A start the server refuses (no engine connected): the step says so
               where it would have shown a run. */
            health = healthAnswer("idle");
            healthStart = { status: 409, json: { error: "Connect an engine first: no engine can start an agent on this machine.", code: "NO_ENGINE" } };
            await openStep("agents");
            await page.waitForSelector("[data-agent-mapping]");
            await openStep("check");
            await page.waitForSelector('[data-health-check="idle"]');
            await page.click("[data-health-start]");
            await page.waitForSelector("[data-health-start-failed]");
            await shot("check-start-refused", (r) => {
              must(Boolean(r.health?.startFailed), `${tag}: a refused start says nothing`);
              must(!r.health!.startFailed!.includes("{"), `${tag}: the refusal line paints a placeholder: ${r.health?.startFailed}`);
              must(r.health?.rows.length === 5, `${tag}: a refused start left ${r.health?.rows.length ?? 0} rows`);
              /* A refusal the step has its own sentence for is read in the
                 interface language, never as the server's English one. */
              const own = locale === "uk" ? "Спершу підключіть рушій (крок 1)." : "Connect an engine first (step 1).";
              must(r.health?.startFailed === own, `${tag}: the refusal reads "${r.health?.startFailed}", expected "${own}"`);
            });
            healthStart = null;

            for (const failed of HEALTH_FAILURES) {
              const code = failed.code;
              await checkFrame(`check-${failed.name ?? code.toLowerCase().replace(/_/g, "-")}`, healthAnswer({ failed }), "failed", (r) => {
                must(r.health?.failure === code, `${tag}: expected failure ${code}, the step shows ${r.health?.failure}`);
                /* The whole block, not its first paragraph: the sentence that
                   says what to do carries `{bin}` and is the one that was left
                   unsubstituted. */
                must(Boolean(r.health?.failureText) && !r.health!.failureAll!.includes("{"), `${tag} ${code}: unfilled sentence "${r.health?.failureAll}"`);
                must(!r.health!.failureAll!.includes("`"), `${tag} ${code}: markdown backticks painted in "${r.health?.failureAll}"`);
                const index = HEALTH_ROW_IDS.indexOf(failed.row);
                must(r.health!.rows.slice(index + 1).every((entry) => entry.endsWith("=waiting")), `${tag} ${code}: rows after the failure are not waiting: ${r.health?.rows.join(" ")}`);
                must(r.health?.summary === "failed", `${tag} ${code}: no failed footer line`);
                must(r.health?.filledAccents[0] === "start", `${tag} ${code}: after a failure the accent is on ${r.health?.filledAccents[0]}, not Run it again`);
                /* At rest, the failure leaves the button that runs the check again in view. */
                must(r.health?.inView.start === true && r.health?.inView.summary === true, `${tag} ${code}: Run it again ${r.health?.inView.start ? "in view" : "below the fold"}, footer line ${r.health?.inView.summary ? "in view" : "below the fold"}`);
                /* "Open the agent" sentences only beside the button that opens it. */
                const namesAgent = /open the agent|відкрийте (картку )?агента/i.test(r.health!.failureAll!);
                must(!namesAgent || r.health?.actionLabel === (locale === "uk" ? "Відкрити агента" : "Open the agent"), `${tag} ${code}: the sentence names the agent beside "${r.health?.actionLabel}"`);
                if (code === "TICK_OFF") must(r.health?.action === null, `${tag}: TICK_OFF offers ${r.health?.action}`);
                if (index === 0) must(!/rows before it|попередні кроки/.test(r.health!.failureAll! + (r.health?.summaryText ?? "")), `${tag} ${code}: a first-row failure says the rows before it passed`);
              });
            }
            /* The machine detail, opened, on the longest sentence pair. */
            await page.click("[data-health-failure] button[aria-expanded]");
            await page.waitForSelector("[data-health-details]");
            await page.waitForTimeout(400);
            await shot("check-details", (r) => {
              must(Boolean(r.health?.detailsOpen), `${tag}: Show details did not open`);
              must(r.health?.inView.details === true, `${tag}: the opened details sit below the fold`);
              /* The detail opens above the controls: the button that runs the check again stays whole. */
              must(r.health?.inView.start === true, `${tag}: with the detail open, Run it again sits below the fold`);
            });
            health = healthAnswer("idle");
            await openStep("agents");
            await openStep("check");
            await page.waitForSelector('[data-health-check="idle"]');
            await page.click("[data-onboarding-primary]");
            await page.waitForSelector("[data-onboarding-dialog]", { state: "detached" });
            await page.unroute("**/api/onboarding/health*");
            const finished = await (await fetch(`${baseUrl}/api/onboarding`)).json() as { marker: { completedAt: string | null } | null };
            must(Boolean(finished.marker?.completedAt), `${tag}: Open the board did not record a completed guide`);

            /* 10. Slice 3 (#1876, #2004): the guide from the menu again, walked
               through its three new steps and the account list. Phone access
               runs against the stand-in tailscale; live dictation answers are
               served here so no key reaches a provider. */
            const uk = locale === "uk";
            const openGuide = async (row: "setup-guide" | "dictation") => {
              if (viewport.phone) {
                await page.click('[data-mobile2-open="menu"]');
                await page.waitForSelector(`[data-testid="menu-${row}"]`);
                if (row === "dictation") await page.screenshot({ path: path.join(OUT_DIR, `${tag}-menu-slice3.png`) });
                await page.click(`[data-testid="menu-${row}"]`);
              } else {
                await page.click("[data-rail-menu]");
                await page.waitForSelector(`[data-rail-menu-${row}]`);
                if (row === "dictation") await page.screenshot({ path: path.join(OUT_DIR, `${tag}-menu-slice3.png`) });
                await page.click(`[data-rail-menu-${row}]`);
              }
            };
            const revisit = async (id: string) => {
              await openStep(id === "agents" ? "engines" : "agents");
              await openStep(id);
            };
            const common = (name: string, r: NonNullable<ReturnType<typeof measureOnboarding>>) => {
              must(r.clippedControls.length === 0, `${tag} ${name}: clipped controls ${r.clippedControls.join(" | ")}`);
            };
            await page.route("**/api/accounts", async (route) => {
              const response = await route.fetch();
              const body = await response.json() as Record<string, { accounts?: Record<string, unknown>[]; active?: string }>;
              const claude = body.claude;
              const first = claude?.accounts?.[0];
              if (claude && first) {
                claude.accounts = [
                  { ...first, limits: SEEDED_LIMITS },
                  { ...first, id: `${String(first.id)}-lab`, label: "Lab", limits: SEEDED_LIMITS },
                  { ...first, id: `${String(first.id)}-spare`, label: "Spare", authPresent: false, authHealth: "signed_out", limits: undefined },
                ];
              }
              await route.fulfill({ response, json: body });
            });
            /* The accounts store reads once per page: reload so the three rows land. */
            await page.reload({ waitUntil: "domcontentloaded" });
            if (viewport.phone) await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 60_000 });
            else await page.waitForSelector("[data-rail-menu]", { timeout: 60_000 });
            await openGuide("setup-guide");
            await page.waitForSelector('[data-onboarding-dialog="guide"]');
            await openStep("engines");
            await page.waitForFunction(() => document.querySelectorAll('[data-onboarding-engine="claude"] [data-mobile2-account]').length === 3, undefined, { timeout: 30_000 });
            await shot("engines-three-accounts", (r) => {
              common("engines-three-accounts", r);
              must(r.accounts.claude?.rows === 3 && r.accounts.claude.addRow, `${tag}: the Claude card lists ${r.accounts.claude?.rows} accounts, add row ${r.accounts.claude?.addRow}`);
              must(/^(3 accounts|Акаунтів: 3)/.test(r.accounts.claude?.header ?? ""), `${tag}: the Claude header reads "${r.accounts.claude?.header}"`);
              must(/(6|з 6)/.test(r.stepCounter ?? ""), `${tag}: the step counter reads "${r.stepCounter}"`);
            });
            await page.unroute("**/api/accounts");

            /* Phone: every state Tailscale can be in. Not installed is served
               here, since the stand-in is always on the server's PATH. */
            const phoneFrame = async (name: string, expectState: string, check: (reading: NonNullable<ReturnType<typeof measureOnboarding>>) => void, selector?: string) => {
              await revisit("phone");
              await page.waitForSelector(selector ?? `[data-phone-state="${expectState}"]`, { timeout: 30_000 });
              await shot(name, (r) => {
                common(name, r);
                must(r.phone?.state === expectState, `${tag} ${name}: the step shows ${r.phone?.state}`);
                must(!/sudo|--tailscale|bunx/.test(r.phone?.text ?? "") || r.phone?.failure === "OPERATOR_RIGHTS", `${tag} ${name}: a terminal command on the step: ${r.phone?.text}`);
                check(r);
              });
            };
            const sentenceOnly = (name: string) => (r: NonNullable<ReturnType<typeof measureOnboarding>>) => {
              must(r.phone?.links.length === 1 && r.phone.buttons.length === 0, `${tag} ${name}: ${r.phone?.links.length} links and buttons ${JSON.stringify(r.phone?.buttons)}; one sentence and one link expected`);
            };
            await page.route("**/api/access", (route) => route.fulfill({ json: { tailnetUrl: null, phone: { state: "missing", dnsName: null, viewerPort: port, servingPort: null, persisted: false }, phoneError: null } }));
            await phoneFrame("phone-missing", "missing", sentenceOnly("phone-missing"));
            await page.unroute("**/api/access");
            tailscale.setStatus({ BackendState: "NeedsLogin" });
            await phoneFrame("phone-needs-login", "needs-login", sentenceOnly("phone-needs-login"));
            tailscale.setStatus({ BackendState: "Running", Self: { DNSName: "" } });
            await phoneFrame("phone-no-dns", "no-dns", sentenceOnly("phone-no-dns"));
            tailscale.setStatus({ BackendState: "Running", Self: { DNSName: `${STUB_DNS_NAME}.` } });
            tailscale.setServing(null);
            tailscale.setServeMode("ok");
            await phoneFrame("phone-ready", "ready", (r) => {
              must(r.phone?.buttons[0] === (uk ? "Увімкнути доступ із телефона" : "Turn on phone access"), `${tag}: the ready step's button reads ${JSON.stringify(r.phone?.buttons)}`);
              must(r.filledButtons.length === 1, `${tag}: ${r.filledButtons.length} filled buttons on the ready step (${r.filledButtons.join(", ")})`);
            });
            tailscale.setServing(3000);
            await phoneFrame("phone-serving-other", "serving-other", (r) => {
              must((r.phone?.text ?? "").includes("3000"), `${tag}: the serving-other title does not name the port`);
              must(r.phone?.buttons[0] === (uk ? "Перенаправити на Viewer" : "Point it at the Viewer"), `${tag}: serving-other button ${JSON.stringify(r.phone?.buttons)}`);
            });
            /* A mapping an earlier run left on this Viewer's port while this
               process gates on nothing: the tailnet reaches it open. */
            tailscale.setServing(port);
            await phoneFrame("phone-exposed", "exposed", (r) => {
              must(r.phone?.buttons[0] === (uk ? "Увімкнути доступ із телефона" : "Turn on phone access"), `${tag}: the exposed step's button reads ${JSON.stringify(r.phone?.buttons)}`);
              must(r.filledButtons.length === 1, `${tag}: ${r.filledButtons.length} filled buttons on the exposed step (${r.filledButtons.join(", ")})`);
            });
            tailscale.setServing(null);
            await revisit("phone");
            await page.waitForSelector('[data-phone-state="ready"]');
            /* The press in flight, held at the network until its frame is taken,
               then answered by the server with the operator right missing. */
            tailscale.setServeMode("operator");
            let releasePress: () => void = () => {};
            const held = new Promise<void>((resolve) => { releasePress = resolve; });
            await page.route("**/api/access/phone", async (route) => { await held; await route.continue(); });
            await page.click("[data-phone-enable]");
            await page.waitForSelector("[data-phone-enable][disabled]");
            await shot("phone-busy", (r) => {
              common("phone-busy", r);
              must(/Turning on|Вмикаю/.test(r.phone?.buttons[0] ?? ""), `${tag}: the pressed button reads ${r.phone?.buttons[0]}`);
            });
            releasePress();
            await page.waitForSelector('[data-phone-failure="OPERATOR_RIGHTS"]', { timeout: 30_000 });
            await page.unroute("**/api/access/phone");
            const failureFrame = async (code: string, prepare: () => void, undo: () => void, open = false) => {
              prepare();
              await page.click("[data-phone-enable]");
              await page.waitForSelector(`[data-phone-failure="${code}"]`, { timeout: 30_000 });
              if (open) await page.click("[data-phone-failure] summary");
              await page.locator("[data-phone-failure]").scrollIntoViewIfNeeded();
              await shot(`phone-failure-${code.toLowerCase().replace(/_/g, "-")}${open ? "-details" : ""}`, (r) => {
                common(code, r);
                must(r.phone?.failure === code, `${tag}: expected ${code}, the step shows ${r.phone?.failure}`);
                must(!(r.phone?.text ?? "").includes("{"), `${tag} ${code}: unfilled sentence ${r.phone?.text}`);
              });
              undo();
              must(!fs.existsSync(path.join(HOME, ".config", "agent-log-viewer", "phone-access")) || fs.statSync(path.join(HOME, ".config", "agent-log-viewer", "phone-access")).isDirectory(), `${tag} ${code}: a failed press left the choice remembered`);
            };
            await page.locator("[data-phone-failure]").scrollIntoViewIfNeeded();
            await shot("phone-failure-operator-rights", (r) => {
              common("operator", r);
              must(r.phone?.failure === "OPERATOR_RIGHTS" && (r.phone.text).includes("sudo tailscale set --operator=$USER"), `${tag}: the operator failure reads ${r.phone?.text}`);
            });
            await failureFrame("SERVE_FAILED", () => tailscale.setServeMode("fail"), () => {}, true);
            await failureFrame("VERIFY_FAILED", () => tailscale.setServeMode("noverify"), () => {});
            await failureFrame("TIMEOUT", () => tailscale.setServeMode("hang"), () => {});
            const configDir = path.join(HOME, ".config", "agent-log-viewer");
            const flagPath = path.join(configDir, "phone-access");
            const tokenPath = path.join(configDir, "token");
            await failureFrame("PERSIST_FAILED", () => { tailscale.setServeMode("ok"); fs.mkdirSync(flagPath, { recursive: true }); }, () => fs.rmSync(flagPath, { recursive: true, force: true }));
            await failureFrame("TOKEN_WRITE_FAILED", () => { fs.rmSync(tokenPath, { force: true }); fs.mkdirSync(tokenPath, { recursive: true }); }, () => fs.rmSync(tokenPath, { recursive: true, force: true }));
            /* The one press, for real: remembered, published with --bg, verified,
               re-bound — the running production server now asks every
               connection for the key, and this tab kept its cookie. */
            tailscale.setServeMode("ok");
            await page.click("[data-phone-enable]");
            await page.waitForSelector('[data-phone-state="serving"] img', { timeout: 30_000 });
            await shot("phone-serving", (r) => {
              common("phone-serving", r);
              must(Boolean(r.phone?.qr) && (r.phone?.link ?? "").startsWith(`https://${STUB_DNS_NAME}/?k=`), `${tag}: serving shows qr=${r.phone?.qr} link=${r.phone?.link?.slice(0, 40)}`);
            });
            must(fs.readFileSync(flagPath, "utf8") === "tailscale\n", `${tag}: the choice was not remembered`);
            must(tailscale.calls().includes(`serve --bg ${port}`), `${tag}: the stand-in never saw serve --bg ${port}`);
            const gated = await fetch(`${baseUrl}/api/onboarding`);
            must(gated.status === 403, `${tag}: after the press a request without the key answered ${gated.status}; the running server did not re-bind its gate`);
            const keyed = await fetch(`${baseUrl}/api/onboarding`, { headers: { authorization: `Bearer ${fs.readFileSync(tokenPath, "utf8").trim()}` } });
            must(keyed.status === 200, `${tag}: with the key the server answered ${keyed.status}`);
            report[`${tag}-gate`] = { withoutKey: gated.status, withKey: keyed.status };
            await page.click("[data-phone-disable]");
            await page.waitForSelector('[data-phone-state="ready"]', { timeout: 30_000 });
            const lifted = await fetch(`${baseUrl}/api/onboarding`);
            must(lifted.status === 200 && !fs.existsSync(flagPath), `${tag}: after Turn off the server answered ${lifted.status} and the flag ${fs.existsSync(flagPath) ? "stayed" : "went"}`);

            /* Voice: each backend, a saved key, and each check sentence. */
            const voiceFrame = async (name: string, check: (reading: NonNullable<ReturnType<typeof measureOnboarding>>) => void) => {
              await shot(name, (r) => { common(name, r); check(r); });
            };
            const choose = async (id: string) => {
              await page.click(`[data-voice-backend="${id}"] input[type=radio]`);
              await page.waitForSelector(`[data-voice-backend="${id}"][data-selected]`);
            };
            const check = async (answer?: { status: number; json: unknown }) => {
              if (answer) await page.route("**/api/transcribe/token", (route) => route.fulfill(answer));
              await page.click("[data-voice-check]");
              await page.waitForSelector("[data-voice-check-result]", { timeout: 30_000 });
              if (answer) await page.unroute("**/api/transcribe/token");
            };
            await revisit("voice");
            await page.waitForSelector("[data-onboarding-voice]", { timeout: 30_000 });
            await voiceFrame("voice-local", (r) => must(r.voice?.selected === "local" && r.voice.skip, `${tag}: the voice step opens on ${r.voice?.selected}, skip ${r.voice?.skip}`));
            await check();
            await voiceFrame("voice-check-local", (r) => must(r.voice?.tone === "danger" && Boolean(r.voice.result), `${tag}: local check says ${r.voice?.result}`));
            await choose("chatgpt");
            await check();
            await voiceFrame("voice-chatgpt", (r) => must(Boolean(r.voice?.result), `${tag}: chatgpt check says nothing`));
            await choose("elevenlabs");
            await check();
            await voiceFrame("voice-elevenlabs-no-key", (r) => must(r.voice?.keyField === true && /ElevenLabs/.test(r.voice.result ?? ""), `${tag}: elevenlabs without a key reads ${r.voice?.result}`));
            await choose("soniox");
            const fakeKey = ["capture", "placeholder", "not", "a", "real", "value"].join("-");
            await page.fill("[data-voice-key-field] input", fakeKey);
            await voiceFrame("voice-soniox-key-field", (r) => must(r.voice?.keyField === true, `${tag}: soniox shows no key field`));
            await page.click("[data-voice-key-save]");
            await page.waitForSelector('[data-voice-key-note="saved"]', { timeout: 30_000 });
            await voiceFrame("voice-key-saved", (r) => {
              must(!(r.voice?.html ?? "").includes(fakeKey), `${tag}: the saved key is still in the page`);
              must(r.voice?.skip === false, `${tag}: Keep the local default is offered with soniox selected`);
            });
            const keyFile = path.join(configDir, "soniox-api-key");
            must(fs.readFileSync(keyFile, "utf8") === `${fakeKey}\n` && (fs.statSync(keyFile).mode & 0o777) === 0o600, `${tag}: the key file is not the key at mode 600`);
            await check({ status: 200, json: { token: "served-by-the-capture", provider: "soniox" } });
            await voiceFrame("voice-check-live-ok", (r) => must(r.voice?.tone === "success", `${tag}: live ok reads ${r.voice?.result}`));
            await check({ status: 502, json: { error: "Soniox token: HTTP 401" } });
            await voiceFrame("voice-check-live-refused", (r) => must(r.voice?.tone === "danger" && /401/.test(r.voice.result ?? ""), `${tag}: refused reads ${r.voice?.result}`));
            fs.rmSync(keyFile, { force: true });
            await choose("local");

            /* Tour: four cards in one row on the desktop, the pager on the phone,
               and Create handing over to the orchestrator draft. */
            await revisit("tour");
            await page.waitForSelector("[data-onboarding-tour]", { timeout: 30_000 });
            await shot("tour", (r) => {
              common("tour", r);
              must(r.tour?.pictures === 4 && r.tour.start, `${tag}: the tour draws ${r.tour?.pictures} pictures, start band ${r.tour?.start}`);
              if (!viewport.phone) must(new Set(r.tour?.cardTops).size === 1, `${tag}: the four cards are not in one row (${r.tour?.cardTops.join(", ")})`);
              must((r.tour?.projects ?? []).includes(PROJECT_NAME), `${tag}: the project select lists ${JSON.stringify(r.tour?.projects)}`);
              if (!viewport.phone) must(r.filledButtons.length === 1, `${tag}: ${r.filledButtons.length} filled buttons on the tour (${r.filledButtons.join(", ")})`);
            });
            if (viewport.phone) {
              /* Every pager page, since pages 2–4 carry the longest bodies on a 358 px page. */
              for (let page_ = 2; page_ <= 4; page_ += 1) {
                await page.click("[data-onboarding-primary]");
                await page.waitForTimeout(400);
                await shot(`tour-page-${page_}`, (r) => {
                  common(`tour-page-${page_}`, r);
                  must(r.filledOnScreen.length === 1, `${tag}: ${r.filledOnScreen.length} filled buttons on tour page ${page_} (${r.filledOnScreen.join(", ")})`);
                });
              }
              await page.click("[data-onboarding-primary]");
              await page.waitForTimeout(600);
              await shot("tour-start", (r) => {
                common("tour-start", r);
                must(r.tourBandOnScreen === true, `${tag}: four presses of Continue did not page the tour to its Start here band`);
                /* On the last page Continue turns nothing: the band's button is the one fill. */
                must(r.filledOnScreen.length === 1, `${tag}: ${r.filledOnScreen.length} filled buttons on the tour's last page (${r.filledOnScreen.join(", ")})`);
              });
            } else {
              /* The first action is on screen without scrolling. */
              await shot("tour-start", (r) => {
                common("tour-start", r);
                must(r.tourStartInView === true, `${tag}: the Start here band is below the fold`);
                must(r.tourLinksInView === true, `${tag}: the tour's links are cut by the footer`);
              });
            }
            await page.click('[data-tour-effort="medium"]');
            await page.click("[data-tour-create]");
            await page.waitForSelector("[data-onboarding-dialog]", { state: "detached" });
            await page.waitForTimeout(1_500);
            await page.screenshot({ path: path.join(OUT_DIR, `${tag}-tour-created.png`) });
            if (!viewport.phone) {
              /* The dock's draft shows what Create will launch without a drag. */
              const choices = await page.evaluate(() => {
                const block = document.querySelector("[data-orchestrator-launch-choices]");
                const scroller = block?.closest(".overflow-y-auto");
                if (!block || !scroller) return null;
                /* The last row, Reasoning, holds the model and effort the tour chose. */
                const reasoning = block.firstElementChild?.lastElementChild ?? block;
                const a = reasoning.getBoundingClientRect();
                const b = scroller.getBoundingClientRect();
                return { inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, top: a.top, bottom: a.bottom, viewTop: b.top, viewBottom: b.bottom };
              });
              must(choices?.inView === true, `${tag}: the draft's Reasoning row is out of view after the hand-off (${JSON.stringify(choices)})`);
            }
            const prefill = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("llvOrchestratorDraft:"))));
            const values = Object.entries(prefill).map(([key, value]) => `${key.split(":").at(-1)}=${value}`).sort();
            must(values.includes("effort=medium") && values.includes("model=opus") && values.includes("engine=claude"), `${tag}: the tour left the draft at ${values.join(", ")}`);
            report[`${tag}-tour-prefill`] = values;
            /* The draft the hand-off opened is a sheet on the phone; a reload
               returns to the board with it closed. */
            await page.reload({ waitUntil: "domcontentloaded" });
            if (viewport.phone) await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 60_000 });
            else await page.waitForSelector("[data-rail-menu]", { timeout: 60_000 });

            /* The Dictation menu row opens the Voice step alone. */
            await openGuide("dictation");
            await page.waitForSelector('[data-onboarding-dialog="voice"] [data-onboarding-voice]', { timeout: 30_000 });
            await shot("voice-alone", (r) => {
              common("voice-alone", r);
              must(r.footerButtons.length === 0 && r.voice !== null, `${tag}: the Dictation row shows footer ${r.footerButtons.length}, voice ${r.voice !== null}`);
            });
            await page.keyboard.press("Escape");
            await page.waitForSelector("[data-onboarding-dialog]", { state: "detached" });
            /* Closing writes the dismissal after the dialog is gone; wait for it,
               or it lands after the next combination has reset the marker. */
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const settled = await (await fetch(`${baseUrl}/api/onboarding`)).json() as { marker: { dismissedAt: string | null } | null };
              if (settled.marker?.dismissedAt) break;
              await page.waitForTimeout(100);
            }

          } catch (error) {
            /* One combination failing is recorded with a frame of where it stood, and the others still run. */
            await page.screenshot({ path: path.join(OUT_DIR, `${tag}-error.png`) }).catch(() => {});
            const marker = await fetch(`${baseUrl}/api/onboarding`).then((response) => response.text()).catch((reason: unknown) => String(reason));
            failures.push(`${tag}: stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)} (marker ${marker.slice(0, 300)})`);
          }
          report[tag] = frames;
          await context.close();
        }
      }
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
    console.error(`onboarding acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log(providerOnly ? "provider account form rendered at 1280 and 390 in English and Ukrainian." : "onboarding acceptance passed at 1440, 1280 and 390, light and dark, English and Ukrainian.");
  }
}

async function main(): Promise<void> {
  if (process.env.BOARD_CAPTURE_CASE === "onboarding" || process.env.BOARD_CAPTURE_CASE === "provider-account") {
    await captureOnboarding();
    return;
  }
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

/**
 * Runs inside the page: whether an open surface (the ⋯ menu, or the Claude accounts panel) is
 * the topmost paint at every point of a grid over it, and whether the attention island (or its
 * toast) overlaps it at all — the island sat later in the same stacking context and once
 * painted over the menu's right end.
 */
function readOnTop(which: string) {
  const element = which === "menu"
    ? document.querySelector("[data-bar-more-menu]")
    : [...document.querySelectorAll('[role="dialog"]')].find((node) => /Claude/.test(node.getAttribute("aria-label") ?? "")) ?? null;
  if (!element) return { found: false, points: 0, covered: [] as string[], overlapsIsland: false };
  const r = element.getBoundingClientRect();
  const covered: string[] = [];
  let points = 0;
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) {
    const x = r.x + 3 + ((r.width - 6) * i) / 7;
    const y = r.y + 3 + ((r.height - 6) * j) / 7;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    points += 1;
    const top = document.elementFromPoint(x, y);
    if (top && !element.contains(top)) covered.push(`${Math.round(x)},${Math.round(y)} ${top.tagName.toLowerCase()}${top.closest("[data-attention-island], [data-attention-toast]") ? " (island)" : ""}`);
  }
  /* The toast is drawn outside the island's own element, so both are measured. */
  const boxes = [...document.querySelectorAll("[data-attention-island], [data-attention-island] *, [data-attention-toast], [data-attention-toast] *")]
    .map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
  const overlapsIsland = boxes.some((box) => box.x < r.x + r.width && box.x + box.width > r.x && box.y < r.y + r.height && box.y + box.height > r.y);
  return { found: true, points, covered, overlapsIsland };
}

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
      /* The island is drawn after ⋯, so a real Tab from ⋯ lands on it before anything in the board. */
      await page.focus("[data-kanban-board] header.bar [data-bar-more]");
      await page.keyboard.press("Tab");
      const tabAfterMore = await page.evaluate(() => {
        const active = document.activeElement;
        return { inIsland: Boolean(active?.closest("[data-attention-island]")), label: active?.getAttribute("aria-label") ?? active?.textContent?.replace(/\s+/g, " ").trim() ?? "" };
      });
      must(tabAfterMore.inIsland, `${tag}: Tab from ⋯ lands on «${tabAfterMore.label}», not the island`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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
      const accountsOnTop = await page.evaluate(readOnTop, "accounts");
      must(accountsOnTop.found && accountsOnTop.covered.length === 0, `${tag}: the accounts panel is painted over at ${accountsOnTop.covered.slice(0, 3).join("; ")}`);
      report[`${tag}:accountsOnTop`] = accountsOnTop;
      await page.keyboard.press("Escape");
      await page.mouse.click(width / 2, 600);
      await page.waitForTimeout(200);

      /* The ⋯ menu on this busy project: Archive and Delete stand down while agents run, and no rule dangles. */
      await page.click("[data-bar-more]");
      await page.waitForSelector("[data-bar-more-menu]");
      /* Narrow, the account rows arrive with their own read of the project's bindings. */
      if (!wide) await page.waitForSelector('[data-bar-more-menu] [data-account-switch-engine="codex"]', { timeout: 15_000 }).catch(() => {});
      menu = await page.evaluate(readMenu);
      const menuOnTop = await page.evaluate(readOnTop, "menu");
      must(menuOnTop.found && menuOnTop.covered.length === 0, `${tag}: the ⋯ menu is painted over at ${menuOnTop.covered.slice(0, 3).join("; ")}`);
      report[`${tag}:menuOnTop`] = menuOnTop;
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
      report[tag] = { ...reading, gaps, islandClearance, tabAfterMore, hover: { before, hovered }, menu, accountsPanel: panel ? { rect: panel.rect } : null, conversations: { switchRect: list.switchRect, texts: list.texts, name: list.name, find: listTexts, islandClearance: listClearance }, tasksOpen: { bar: open.bar, wrap: open.wrap, overflow: open.overflow, islandClearance: openClearance, toast: open.toast, panelUnderToast: underToast, panel: taskPanel } };
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

/* ------------------------------------------------------------------------- */
/* The account removal dialog's answers (#1857, docs/design/ui-batch-2026-09 §5) */
/* ------------------------------------------------------------------------- */

interface RemovalReading {
  found: boolean;
  rect: Rect | null;
  panel: Rect | null;
  text: string;
  /** Text boxes that cut their content: a clamp, an ellipsis or hidden overflow that bites. */
  clipped: string[];
  /** The archive path's account id, and whether its whole box is painted inside the block. */
  pathId: { text: string; visible: boolean } | null;
  /** The displayed path, home folded to `~`. */
  pathShown: string | null;
  /** Buttons inside the block, for the phone's 44 px rule. */
  targets: { name: string; w: number; h: number }[];
  /** For a last-row refusal: the block and its buttons against the scrolling list. */
  fold?: unknown;
}

/** Runs inside the page: one removal block (row line, refusal or card) against its surface. */
function readRemoval(selector: string): RemovalReading {
  const box = (element: Element | null): Rect | null => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const element = document.querySelector(selector);
  const surface = element?.closest('[role="dialog"]') ?? element?.closest("[data-mobile2-accounts]") ?? null;
  if (!element) return { found: false, rect: null, panel: box(surface), text: "", clipped: [], pathId: null, pathShown: null, targets: [] };
  const clipped: string[] = [];
  for (const node of [element, ...element.querySelectorAll("*")]) {
    if (!(node instanceof HTMLElement) || node.closest("[data-archive-path]") && !node.hasAttribute("data-archive-path-id")) continue;
    if (!node.textContent?.trim()) continue;
    const style = getComputedStyle(node);
    const hides = style.overflowX !== "visible" || style.overflowY !== "visible";
    const clamp = style.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none") clipped.push(`${node.tagName}: line-clamp ${clamp}`);
    if (style.textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth + 1) clipped.push(`${node.tagName}: ellipsis «${node.textContent.trim().slice(0, 40)}»`);
    if (hides && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)) clipped.push(`${node.tagName}: overflow «${node.textContent.trim().slice(0, 40)}»`);
  }
  const id = element.querySelector("[data-archive-path-id]");
  const idBox = id?.getBoundingClientRect();
  const blockBox = element.getBoundingClientRect();
  const pathId = id && idBox ? { text: id.textContent ?? "", visible: idBox.width > 0 && idBox.left >= blockBox.left - 0.5 && idBox.right <= blockBox.right + 0.5 && (id as HTMLElement).scrollWidth <= (id as HTMLElement).clientWidth + 1 } : null;
  const shown = element.querySelector("[data-archive-path] > span[title]");
  return {
    found: true,
    rect: box(element),
    panel: box(surface),
    text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
    clipped,
    pathId,
    pathShown: shown?.textContent ?? null,
    targets: [...element.querySelectorAll("button")].map((button) => {
      const r = button.getBoundingClientRect();
      return { name: button.getAttribute("aria-label") || button.textContent?.trim() || "", w: r.width, h: r.height };
    }),
  };
}

/** Composed rather than written out: an archive path under an invented home, so the `~` fold is exercised. */
const inventedArchive = (id: string) => ["", "home", "demo", ".config", "agent-log-viewer", "shared", "claude", "retired", id].join("/");

type Answer = { status: number; body: unknown };

async function accountRemovalMain(): Promise<void> {
  const { tasks, reviewers } = seedHome();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { commit: captureCommit() };
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const { project } = await waitForBoard(baseUrl, false);
    await stop(server);
    server = null;
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    seedState(project, tasks, reviewers);
    await seedAccounts(project);
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, true);
    await Bun.sleep(3_000);
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

    /* Every DELETE is answered here and never reaches the server; the list read drops what a
       stubbed success removed, the way the real one would. */
    const stubbed = async (context: Awaited<ReturnType<Browser["newContext"]>>) => {
      const gone = new Set<string>();
      let next: Answer | null = null;
      let hold: Promise<void> | null = null;
      const deletes: unknown[] = [];
      /* A poll still in flight when the context closes is dropped, not raised. */
      await context.route("**/api/accounts", async (route) => {
        try {
          const response = await route.fetch();
          const body = await response.json() as { claude?: { accounts?: { id: string }[] } };
          if (body.claude?.accounts) body.claude.accounts = body.claude.accounts.filter((account) => !gone.has(account.id));
          await route.fulfill({ response, json: body });
        } catch {
          /* the context is gone */
        }
      });
      await context.route("**/api/accounts/claude", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        const request = route.request().postDataJSON() as { id?: string };
        deletes.push(request);
        if (hold) await hold;
        const answer = next ?? { status: 500, body: { code: "removal_failed" } };
        if (answer.status === 200 && request.id) gone.add(request.id);
        await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
      });
      return {
        deletes,
        answer(value: Answer) { next = value; },
        holdNext(): () => void {
          let release: () => void = () => {};
          hold = new Promise<void>((resolve) => { release = () => { hold = null; resolve(); }; });
          return () => release();
        },
      };
    };
    const rowIdOf = (page: Page, label: string) => page.evaluate((name: string) => [...document.querySelectorAll("[data-account-row]")].find((row) => row.querySelector("button[aria-current], button")?.textContent?.includes(name))?.getAttribute("data-account-row") ?? null, label);
    const openPanel = async (page: Page) => {
      await page.click("[data-bar-more]");
      await page.waitForSelector("[data-bar-more-menu]");
      await page.click('[data-bar-more-menu] [data-account-switch-engine="claude"] > button');
      await page.waitForSelector('[role="dialog"] [data-account-row]');
      await page.waitForTimeout(400);
    };
    const shoot = async (page: Page, name: string) => {
      const panel = await page.evaluate(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) => /Claude/.test(element.getAttribute("aria-label") ?? ""));
        const r = dialog?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      });
      if (panel) await page.screenshot({ path: path.join(OUT_DIR, `removal-${name}.png`), clip: { x: Math.max(0, panel.x - 8), y: Math.max(0, panel.y - 8), width: panel.w + 16, height: panel.h + 16 } });
    };
    const check = (tag: string, state: string, reading: RemovalReading, expect: { text?: string[]; phone?: boolean }) => {
      must(reading.found, `${tag} ${state}: the block is missing`);
      if (!reading.found || !reading.rect) return;
      for (const text of expect.text ?? []) must(reading.text.includes(text), `${tag} ${state}: «${text}» is not in «${reading.text.slice(0, 160)}»`);
      must(reading.clipped.length === 0, `${tag} ${state}: text is cut: ${reading.clipped.join("; ")}`);
      if (reading.panel) must(reading.rect.x >= reading.panel.x - 0.5 && reading.rect.x + reading.rect.w <= reading.panel.x + reading.panel.w + 0.5, `${tag} ${state}: the block runs outside the panel (${JSON.stringify(reading.rect)} in ${JSON.stringify(reading.panel)})`);
      if (expect.phone) for (const target of reading.targets) must(target.w >= 44 && target.h >= 44, `${tag} ${state}: «${target.name}» is ${target.w}×${target.h}`);
    };

    const cases = [1440, 1280].flatMap((width) => (["en", "uk"] as const).flatMap((lang) => (["light", "dark"] as const).map((colorScheme) => ({ width, lang, colorScheme }))));
    for (const { width, lang, colorScheme } of cases) {
      const tag = `${width}-${lang}-${colorScheme}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
      const stub = await stubbed(context);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-kanban-board] header.bar", { timeout: 120_000 });
      await page.waitForTimeout(1_500);
      await openPanel(page);
      const idB = await rowIdOf(page, "Account B");
      const idC = await rowIdOf(page, "Account C");
      must(idB !== null && idC !== null, `${tag}: the seeded rows are missing`);
      if (!idB || !idC) { await context.close(); continue; }
      const readings: Record<string, RemovalReading> = {};
      const arm = async (id: string) => {
        await page.click(`[data-account-remove="${id}"]`);
        await page.waitForSelector(`[data-account-remove-armed="${id}"]`);
      };
      const confirm = (id: string) => page.click(`[data-account-remove-confirm="${id}"]`);

      /* Armed, then in flight behind a held answer that turns out to be the longest refusal. */
      await arm(idB);
      readings.armed = await page.evaluate(readRemoval, `[data-account-remove-armed="${idB}"]`);
      check(tag, "armed", readings.armed, { text: [lang === "uk" ? "спільного архіву" : "shared archive"] });
      await shoot(page, `${tag}-armed`);
      const release = stub.holdNext();
      stub.answer({ status: 409, body: { code: "account_removal_blocked", blockers: ["current_conversations"] } });
      await confirm(idB);
      await page.waitForSelector(`[data-account-row="${idB}"][aria-busy="true"]`);
      readings.inFlight = await page.evaluate(readRemoval, `[data-account-row="${idB}"]`);
      check(tag, "in flight", readings.inFlight, { text: [lang === "uk" ? "Видалення…" : "Removing…"] });
      const dimmed = await page.evaluate((id: string) => getComputedStyle(document.querySelector(`[data-account-row="${id}"]`)!).opacity, idB);
      must(Number(dimmed) < 0.7, `${tag} in flight: the row's opacity is ${dimmed}`);
      await shoot(page, `${tag}-in-flight`);
      release();
      await page.waitForSelector(`[data-account-row="${idB}"] [data-account-refusal="${idB}"]`);
      await page.waitForTimeout(300);
      readings.refusal = await page.evaluate(readRemoval, `[data-account-refusal="${idB}"]`);
      check(tag, "longest refusal", readings.refusal, { text: [lang === "uk" ? "Нічого не змінено." : "Nothing was changed."] });
      await shoot(page, `${tag}-refusal`);

      /* archive_unavailable, with its path. */
      stub.answer({ status: 409, body: { code: "archive_unavailable", archive: inventedArchive(idB) } });
      await arm(idB);
      await confirm(idB);
      await page.waitForSelector(`[data-account-refusal="${idB}"] [data-archive-path]`);
      await page.waitForTimeout(300);
      readings.archive = await page.evaluate(readRemoval, `[data-account-refusal="${idB}"]`);
      check(tag, "archive_unavailable", readings.archive, {});
      must(readings.archive.pathId?.text === idB && readings.archive.pathId.visible, `${tag} archive_unavailable: the path's account id is ${JSON.stringify(readings.archive.pathId)}`);
      must(readings.archive.pathShown?.startsWith("~/") ?? false, `${tag} archive_unavailable: the path reads «${readings.archive.pathShown}»`);
      await shoot(page, `${tag}-archive`);

      /* The last row, scrolled to by hand and clicked with the mouse where it is painted, so nothing
         scrolls for the driver: the refusal has to bring its own block, action button included, into the list. */
      const lastRow = async (reasons: string[], answer: Answer, expectAction: string | null) => {
        const state = `last row ${reasons.join("+")}`;
        await page.evaluate((id: string) => {
          const row = document.querySelector(`[data-account-row="${id}"]`)!;
          let area = row.parentElement;
          while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
          if (area) area.scrollTop = area.scrollHeight;
        }, idC);
        await page.waitForTimeout(200);
        const clickPainted = async (selector: string) => {
          const r = await page.evaluate((sel: string) => {
            const b = document.querySelector(sel)!.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }, selector);
          await page.mouse.click(r.x, r.y);
        };
        stub.answer(answer);
        await clickPainted(`[data-account-remove="${idC}"]`);
        await page.waitForSelector(`[data-account-remove-armed="${idC}"]`);
        await clickPainted(`[data-account-remove-confirm="${idC}"]`);
        await page.waitForSelector(`[data-account-row="${idC}"] [data-account-refusal="${idC}"]`);
        await page.waitForTimeout(400);
        const reading = await page.evaluate(readRemoval, `[data-account-refusal="${idC}"]`);
        check(tag, state, reading, {});
        const fold = await page.evaluate((id: string) => {
          const block = document.querySelector(`[data-account-refusal="${id}"]`)!;
          let area = block.parentElement;
          while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
          const a = area!.getBoundingClientRect();
          const b = block.getBoundingClientRect();
          const buttons = [...block.querySelectorAll("button")].map((button) => {
            const r = button.getBoundingClientRect();
            return { name: button.getAttribute("aria-label") || button.textContent?.trim() || "", inside: r.top >= a.top - 0.5 && r.bottom <= a.bottom + 0.5 };
          });
          return { area: { top: a.top, bottom: a.bottom }, block: { top: b.top, bottom: b.bottom }, inside: b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5, buttons };
        }, idC);
        must(fold.inside, `${tag} ${state}: the block (${fold.block.top}–${fold.block.bottom}) is not inside the list (${fold.area.top}–${fold.area.bottom})`);
        for (const button of fold.buttons) must(button.inside, `${tag} ${state}: «${button.name}» is below the list's fold`);
        if (expectAction) must(fold.buttons.some((button) => button.name === expectAction), `${tag} ${state}: no «${expectAction}» button`);
        reading.fold = fold;
        return reading;
      };
      readings.lastFailed = await lastRow(["removal_failed"], { status: 500, body: { code: "removal_failed", errno: "EACCES" } }, lang === "uk" ? "Спробувати ще раз" : "Try again");
      readings.lastBlockers = await lastRow(["live_sessions", "login_pending", "current_conversations"], { status: 409, body: { code: "account_removal_blocked", blockers: ["live_sessions", "login_pending", "current_conversations"] } }, null);
      await shoot(page, `${tag}-last-row`);

      /* The full summary: every line above zero. */
      stub.answer({ status: 200, body: { removed: { id: idB }, cleanupPending: false, moved: { archive: inventedArchive(idB), files: 1284, bytes: 2_100_000_000 }, conversationsRewritten: 37, pinsCleared: 2, deliveriesDropped: 1, migrationsSettled: 1 } });
      await arm(idB);
      await confirm(idB);
      await page.waitForSelector('[data-account-removal-card="removed"]');
      await page.waitForTimeout(600);
      readings.summary = await page.evaluate(readRemoval, '[data-account-removal-card="removed"]');
      check(tag, "summary", readings.summary, {});
      must((await page.evaluate(() => document.querySelectorAll('[data-account-removal-card="removed"] dt').length)) === 6, `${tag} summary: not six lines`);
      must(readings.summary.pathId?.text === idB && readings.summary.pathId.visible, `${tag} summary: the path's account id is ${JSON.stringify(readings.summary.pathId)}`);
      must(await page.evaluate((id: string) => document.querySelector(`[data-account-row="${id}"]`) === null, idB), `${tag} summary: the removed row is still listed`);
      await shoot(page, `${tag}-summary`);

      /* A sign-in file left in the archive, and its clean-up. */
      stub.answer({ status: 200, body: { removed: { id: idC }, cleanupPending: true, moved: { archive: inventedArchive(idC), files: 3, bytes: 812_000 }, conversationsRewritten: 0, pinsCleared: 0, deliveriesDropped: 0, migrationsSettled: 0 } });
      await arm(idC);
      await confirm(idC);
      await page.waitForSelector('[data-account-removal-credential="pending"]');
      await page.waitForTimeout(300);
      readings.pending = await page.evaluate(readRemoval, '[data-account-removal-card="removed"]');
      check(tag, "cleanupPending", readings.pending, {});
      must((await page.evaluate(() => document.querySelectorAll('[data-account-removal-card="removed"] dt').length)) === 2, `${tag} cleanupPending: a clean removal draws more than its two lines`);
      await shoot(page, `${tag}-pending`);
      stub.answer({ status: 200, body: { removed: [], unresolved: [] } });
      await page.click('[data-account-removal-credential="pending"] button');
      await page.waitForSelector('[data-account-removal-credential="deleted"]');

      /* The clean-up result, with names that need a look. */
      stub.answer({ status: 200, body: { removed: ["claude-f1", "claude-f2", "claude-f3"], archived: [{ id: "claude-r1", files: 300, bytes: 60_000_000 }, { id: "claude-r3", files: 112, bytes: 36_000_000 }], unresolved: ["claude-r2.lock", "claude-x1", "claude-x2", "claude-x3", "claude-x4", "claude-x5", "claude-x6"] } });
      await page.click("[data-account-cleanup]");
      await page.waitForSelector('[data-account-removal-card="cleanup"]');
      await page.waitForTimeout(300);
      readings.cleanup = await page.evaluate(readRemoval, '[data-account-removal-card="cleanup"]');
      check(tag, "clean-up", readings.cleanup, { text: ["claude-r2.lock", "+2"] });
      await shoot(page, `${tag}-cleanup`);
      must(stub.deletes.every((body) => !(body as { force?: unknown }).force), `${tag}: a DELETE carried a force flag`);
      report[tag] = { readings, deletes: stub.deletes.length };
      await context.close();
    }

    /* The phone has no footer slot and no remove control of its own: the removal starts at desktop
       width behind a held answer, the window narrows to the phone, and the answer lands on the
       phone's accounts screen. */
    for (const lang of ["en", "uk"] as const) for (const colorScheme of ["light", "dark"] as const) {
      for (const kind of ["refusal", "summary"] as const) {
        const tag = `390-${lang}-${colorScheme}-${kind}`;
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, colorScheme, reducedMotion: "reduce" });
        await context.addInitScript(seedInit);
        await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
        const stub = await stubbed(context);
        const page = await context.newPage();
        await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await page.waitForSelector("[data-kanban-board] header.bar", { timeout: 120_000 });
        await page.waitForTimeout(1_500);
        await openPanel(page);
        const id = await rowIdOf(page, "Account B");
        if (!id) { must(false, `${tag}: the seeded row is missing`); await context.close(); continue; }
        stub.answer(kind === "refusal"
          ? { status: 409, body: { code: "account_removal_blocked", blockers: ["current_conversations"] } }
          : { status: 200, body: { removed: { id }, cleanupPending: true, moved: { archive: inventedArchive(id), files: 1284, bytes: 2_100_000_000 }, conversationsRewritten: 37, pinsCleared: 2, deliveriesDropped: 1, migrationsSettled: 1 } });
        const release = stub.holdNext();
        await page.click(`[data-account-remove="${id}"]`);
        await page.click(`[data-account-remove-confirm="${id}"]`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForSelector("[data-mobile2-bar]", { timeout: 60_000 });
        await page.click('[data-mobile2-bar] [data-mobile2-open="menu"]');
        await page.click('[data-mobile2-menu-row="accounts"]');
        await page.waitForSelector("[data-mobile2-accounts]");
        release();
        const selector = kind === "refusal" ? `[data-mobile2-account="${id}"] [data-account-refusal="${id}"]` : '[data-mobile2-accounts-engine="claude"] [data-account-removal-card="removed"]';
        await page.waitForSelector(selector, { timeout: 30_000 });
        await page.waitForTimeout(400);
        const reading = await page.evaluate(readRemoval, selector);
        check(tag, kind, reading, { phone: true });
        if (kind === "summary") {
          must(reading.pathId?.text === id && reading.pathId.visible, `${tag}: the path's account id is ${JSON.stringify(reading.pathId)}`);
          const leads = await page.evaluate(() => {
            const section = document.querySelector('[data-mobile2-accounts-engine="claude"]');
            const card = section?.querySelector('[data-account-removal-card="removed"]');
            const first = section?.querySelector("[data-mobile2-account]");
            return Boolean(card && first && card.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
          });
          must(leads, `${tag}: the summary does not lead the engine section`);
        } else {
          const inside = await page.evaluate((account: string) => {
            const card = document.querySelector(`[data-mobile2-account="${account}"]`)!.getBoundingClientRect();
            const block = document.querySelector(`[data-account-refusal="${account}"]`)!.getBoundingClientRect();
            return block.left >= card.left - 0.5 && block.right <= card.right + 0.5 && block.top >= card.top - 0.5 && block.bottom <= card.bottom + 0.5;
          }, id);
          must(inside, `${tag}: the refusal is not inside the account's card`);
        }
        await page.screenshot({ path: path.join(OUT_DIR, `removal-${tag}.png`), fullPage: false });
        report[tag] = reading;
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "account-removal.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`account removal measurements: ${path.join(OUT_DIR, "account-removal.json")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`account removal acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("account removal acceptance passed at 1440 and 1280 (en, uk; light, dark) and 390 × 844 (en, uk; light, dark).");
  }
}

/* ------------------------------------------------------------------------- */
/* Orchestrator seats, their placement and the wide column (#1841,           */
/* docs/design/ui-batch-2026-09 §2)                                          */
/* ------------------------------------------------------------------------- */

const SEAT_CASES = ["seats", "seat-placement", "columns-wide"] as const;
type SeatCase = (typeof SEAT_CASES)[number];
/* Composed rather than written out, like the header's sessions. */
const seatSession = (serial: number) => [String(serial).padStart(8, "0"), "1841", "4000", "8000", "0".repeat(12)].join("-");
const SEAT_STATUSES = ["assigned", "inbox", "blocked", "done", "assigned"] as const;

interface SeatSeed { id: string; path: string; title: string; notes: string }

/**
 * A live seat and two it replaced, each with the task its launch minted and
 * that task's notes, written through the Viewer's own seat module into the
 * synthetic state dir. The seats rotate at invented times, so the popover's
 * spans read the same on every run.
 */
async function seedSeats(project: string): Promise<{ live: SeatSeed; retired: SeatSeed[] }> {
  process.env.HOME = HOME;
  process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
  process.env.LLV_STATE_DIR = STATE_DIR;
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  /* Whole minutes before now, so the spans read like a working week: 13 h, then 28 h, then the live seat. */
  const minute = 60_000;
  const start = Math.floor(Date.now() / minute) * minute;
  const ago = (minutes: number) => new Date(start - minutes * minute).toISOString();
  const specs = [
    { serial: 61, title: "Orchestrator seat, launch week", notes: "Lanes: header, stage labels.\nRotated after the context filled.", from: ago(47 * 60 + 18) },
    { serial: 62, title: "Manager seat, release week", notes: "Open: the September train.\nMerged: the header.\nNext: seats out of the columns.", from: ago(19 * 60 + 18) },
    { serial: 63, title: "Orchestrator seat, board batch", notes: "Watching the seats lane and the undo lane.", from: ago(6 * 60 + 10) },
  ];
  const seeds: SeatSeed[] = specs.map((spec, index) => {
    const id = seatSession(spec.serial);
    const file = writeConversation(folder, id, `seat conversation ${index + 1}`, `Holding the seat: ${spec.title}. ` + "Board notes. ".repeat(40), false, spec.from);
    return { id, path: file, title: spec.title, notes: spec.notes };
  });
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  for (const [index, seed] of seeds.entries()) {
    const now = specs[index]!.from;
    const clientRequestId = `req_1841_${index}`;
    beginOrchestratorSeatIntent({ project, mandate: "Run the board.", clientRequestId, mode: "spawn", now });
    const done = completeOrchestratorSeatIntent({ project, clientRequestId, conversationId: seed.id, path: seed.path, engine: "claude", model: "opus", now });
    if (done.kind !== "activated") throw new Error(`seat ${index} did not activate: ${done.kind}`);
  }
  const file = path.join(STATE_DIR, "tasks.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown>[] };
  for (const [index, seed] of seeds.entries()) {
    store.tasks.push({
      id: `task-1841-seat-${index}`, project, status: "assigned", text: seed.title, details: seed.notes, placement: "unplaced",
      assignments: [{ path: seed.path, conversationId: seed.id, panePid: null, state: "delivered", error: null, at: specs[index]!.from }],
      createdAt: specs[index]!.from, updatedAt: specs[index]!.from,
    });
  }
  /* The product tasks spread over the four columns. */
  for (const [index, task] of store.tasks.entries()) if (String(task.id).startsWith("task-1641-")) task.status = SEAT_STATUSES[index % SEAT_STATUSES.length];
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", "utf8");
  return { live: seeds[2]!, retired: [seeds[1]!, seeds[0]!] };
}

/** What the board says it is NOT drawing: the hidden pill's count and the
    tasks its tray names as off the board. A seat task must appear in neither
    (#1841) — the tray is where the Overview used to list every seat. */
function readHiddenTray() {
  const pill = document.querySelector("[data-hidden-pill]");
  return {
    count: Number(pill?.getAttribute("data-count") ?? "-1"),
    tasks: [...document.querySelectorAll("[data-hidden-task]")].map((row) => row.querySelector(".title")?.textContent?.trim() ?? ""),
  };
}

/** The board as the seat cases read it. */
function readSeatBoard() {
  const box = (element: Element | null) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x * 2) / 2, y: Math.round(r.y * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2 };
  };
  const seat = document.querySelector("[data-kanban-seat]");
  const head = seat?.querySelector(".seat-head") ?? null;
  const headControls = head ? [...head.querySelectorAll("button, a, [data-orchestrator-badge]")].map((node) => ({ name: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "", rect: box(node)! })).filter((entry) => entry.rect.w > 0) : [];
  const columns = [...document.querySelectorAll<HTMLElement>(".kb .column")].map((column) => ({
    status: column.dataset.status ?? "",
    wide: column.dataset.wide ?? null,
    rect: box(column)!,
    cards: [...column.querySelectorAll(".card")].map((card) => card.querySelector(".title")?.textContent?.trim() ?? ""),
    clippedTitles: [...column.querySelectorAll<HTMLElement>(".card .title")].filter((title) => title.scrollWidth > title.clientWidth + 1).length,
    /* Conversation tiles: a wrapping grid of ~196 px tiles in the wide column. */
    tileWidths: [...column.querySelectorAll(".tile")].map((tile) => Math.round(tile.getBoundingClientRect().width)),
    /* The head holds on one line: its tallest child is no taller than one line. */
    headHeight: Math.round(column.querySelector(".col-head")?.getBoundingClientRect().height ?? 0),
    widthControls: column.querySelectorAll("[data-col-width], [data-col-pin]").length,
    /* Cards carrying a seat conversation anywhere: its title, a tile, a mirror. */
    seatCards: [...column.querySelectorAll(".card")].filter((card) => /seat conversation/.test(card.textContent ?? "")).length,
  }));
  const toggle = document.querySelector("[data-orchestrator-toggle]");
  return {
    bar: box(document.querySelector("[data-kanban-board] header.bar")),
    page: box(document.querySelector(".kb-page")),
    frame: box(document.querySelector(".board-frame")),
    seat: box(seat),
    seatPlacement: seat?.getAttribute("data-placement") ?? null,
    seatCollapsed: seat?.getAttribute("data-collapsed") ?? null,
    head: box(head),
    headKind: head?.getAttribute("data-seat-head") ?? null,
    headControls,
    rail: box(document.querySelector("[data-seat-rail]")),
    railTone: document.querySelector("[data-seat-rail-state]")?.getAttribute("data-seat-rail-state") ?? null,
    stateWord: document.querySelector(".seat-title .state")?.className ?? null,
    previousCount: document.querySelector("[data-previous-seats]")?.getAttribute("data-previous-seats") ?? null,
    previousText: document.querySelector("[data-previous-seats]")?.textContent?.trim() ?? null,
    toggleDot: toggle?.querySelector("[data-orchestrator-toggle-dot]")?.getAttribute("data-orchestrator-toggle-dot") ?? null,
    togglePressed: toggle?.getAttribute("aria-pressed") ?? null,
    columns,
    board: document.querySelector("[data-board]")?.getAttribute("data-mode") ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

function readSeatPopover() {
  const pop = document.querySelector("[data-previous-seats-popover]")?.closest(".popover") ?? null;
  if (!pop) return null;
  const r = pop.getBoundingClientRect();
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    heads: [...pop.querySelectorAll(".head")].map((node) => node.textContent?.trim() ?? ""),
    rows: [...pop.querySelectorAll<HTMLElement>("[data-seat-row]")].map((row) => ({
      current: row.dataset.seatCurrent === "1",
      title: row.querySelector(".t1 .title")?.textContent?.trim() ?? "",
      span: row.querySelector(".t2")?.textContent?.trim() ?? "",
      /* Whether the row opens its own conversation; the id itself stays out of the record. */
      opensItself: row.querySelector("a")?.getAttribute("href") === `#c=${encodeURIComponent(row.dataset.seatRow ?? "")}`,
      height: row.querySelector(".line")?.getBoundingClientRect().height ?? 0,
      notes: row.querySelector("[data-seat-notes]")?.textContent ?? null,
    })),
    openNotes: pop.querySelectorAll("[data-seat-notes]").length,
    /* How the open notes are painted (#1841 review): in dark mode the popover's
       card, a hovered row and a well sit within a few percent of each other, so
       the block has to carry an edge of its own to read as an inset. */
    notesPaint: (() => {
      const notes = pop.querySelector("[data-seat-notes]");
      if (!notes) return null;
      const style = getComputedStyle(notes);
      const row = notes.closest("[data-seat-row]")?.querySelector(".line");
      return {
        fill: style.backgroundColor,
        border: style.borderTopColor,
        borderWidth: Math.round(parseFloat(style.borderTopWidth) * 100) / 100,
        /* What the row around it paints while the pointer is on it. */
        rowHoverFill: getComputedStyle(document.documentElement).getPropertyValue("--surface-well").trim(),
        rowFill: row ? getComputedStyle(row).backgroundColor : null,
      };
    })(),
  };
}

async function seatsMain(which: SeatCase): Promise<void> {
  const { tasks, reviewers } = seedHome();
  writeQuietProject();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  /* A port this process bound itself and released, never a fixed one. */
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { commit: captureCommit(), case: which };
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    const project = await (async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const files = ((await (await fetch(`${baseUrl}/api/files`)).json()) as FilesPayload).files ?? [];
        const busy = files.find((file) => file.path?.includes(projectSlug(REPO_DIR)))?.project;
        const quiet = files.find((file) => file.path?.includes(projectSlug(QUIET_DIR)))?.project;
        if (busy && quiet) return busy;
        await Bun.sleep(2_000);
      }
      throw new Error("the two seeded projects never scanned");
    })();
    await stop(server);
    server = null;
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    seedState(project, tasks, reviewers);
    const seats = await seedSeats(project);
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, true);
    await Bun.sleep(4_000);
    const seatTitles = [seats.live.title, ...seats.retired.map((seed) => seed.title)];
    report.seeded = { productTasks: tasks.length, seats: seatTitles };
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

    /* At 1440 and 1280 the rail leaves the board under 1200 px, where it scrolls; 1920 is the grid. */
    const widths = which === "columns-wide" ? [1920, 1440, 1280] : [1440, 1280];
    const combos = widths.flatMap((width) => (["en", "uk"] as const).flatMap((lang) => (["light", "dark"] as const).map((colorScheme) => ({ width, lang, colorScheme }))));
    for (const { width, lang, colorScheme } of combos) {
      const tag = `${which}-${width}-${lang}-${colorScheme}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-kanban-board] header.bar", { timeout: 120_000 });
      await page.waitForSelector('[data-kanban-seat] [data-orchestrator-state="live"]', { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2_500);
      const base = await page.evaluate(readSeatBoard);
      const entry: Record<string, unknown> = { base };
      must(base.bar !== null && near(base.bar.h, 48, 0.5), `${tag}: the bar is ${base.bar?.h}px`);
      /* The seat bands are gone from every column; the product cards all draw. */
      const carded = base.columns.flatMap((column) => column.cards);
      must(seatTitles.every((title) => !carded.includes(title)), `${tag}: a seat card is on the board (${carded.join(" | ")})`);
      must(base.columns.every((column) => column.seatCards === 0), `${tag}: a seat conversation is drawn in ${base.columns.filter((column) => column.seatCards).map((column) => column.status).join(", ")}`);
      must(carded.length === tasks.length, `${tag}: ${carded.length} cards for ${tasks.length} product tasks (${carded.join(" | ")})`);
      must(tasks.every((task) => carded.includes(task.title)), `${tag}: ${carded.length} cards, a product task is missing`);
      must(new Set(base.columns.filter((column) => column.cards.length).map((column) => column.status)).size >= 3, `${tag}: fewer than three columns hold cards`);

      if (which === "seats") {
        must(base.previousCount === "2", `${tag}: Previous seats reads ${base.previousCount}`);
        await page.click("[data-previous-seats]");
        await page.waitForSelector("[data-previous-seats-popover]");
        await page.click('[data-seat-row] >> nth=1 >> [data-seat-notes-toggle]');
        await page.waitForTimeout(300);
        const popover = await page.evaluate(readSeatPopover);
        const head = await page.evaluate(readSeatBoard);
        entry.popover = popover;
        entry.head = head.headControls;
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });
        must(popover !== null, `${tag}: the popover did not open`);
        if (popover) {
          must(popover.rect.x >= 0 && popover.rect.y >= 0 && popover.rect.x + popover.rect.w <= width && popover.rect.y + popover.rect.h <= 900, `${tag}: the popover leaves the viewport ${JSON.stringify(popover.rect)}`);
          must(near(popover.rect.w, 340, 1), `${tag}: the popover is ${popover.rect.w}px wide`);
          must(head.seat !== null && popover.rect.x >= head.seat.x - 0.5, `${tag}: the popover starts at ${popover.rect.x}, left of the seat at ${head.seat?.x}`);
          must(popover.rows.map((row) => row.title).join("|") === [seats.live.title, ...seats.retired.map((seed) => seed.title)].join("|"), `${tag}: rows ${popover.rows.map((row) => row.title).join(" | ")}`);
          must(popover.rows[0]?.current === true && popover.rows.slice(1).every((row) => !row.current), `${tag}: the live seat is not first under Current`);
          must(popover.rows.every((row) => row.height >= 52), `${tag}: a row is under 52 px`);
          must(popover.openNotes === 1 && popover.rows[1]?.notes === seats.retired[0]!.notes, `${tag}: the Notes row reads ${popover.rows[1]?.notes}`);
          must(popover.rows.every((row) => row.opensItself), `${tag}: a row does not open its conversation`);
          must(popover.rows.slice(1).every((row) => / · /.test(row.span)), `${tag}: a previous row has no span (${popover.rows.map((row) => row.span).join(" | ")})`);
          /* The open notes read as an inset: a border of their own, in a tone
             the block is not filled with. */
          must(popover.notesPaint !== null && popover.notesPaint.borderWidth >= 1 && popover.notesPaint.border !== popover.notesPaint.fill, `${tag}: the notes paint ${JSON.stringify(popover.notesPaint)}`);
        }
        const controls = head.headControls;
        for (const [index, a] of controls.entries()) for (const b of controls.slice(index + 1)) {
          if (a.rect.x <= b.rect.x && a.rect.x + a.rect.w >= b.rect.x + b.rect.w) continue;
          if (b.rect.x <= a.rect.x && b.rect.x + b.rect.w >= a.rect.x + a.rect.w) continue;
          must(!overlaps(a.rect, b.rect, 0.5), `${tag}: seat head «${a.name}» and «${b.name}» overlap`);
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);

        /* A band the board draws for nobody is not an off-board task either:
           the hidden tray names no seat, on the project's board and on the
           Overview, which spans every project and reads every project's
           seats. */
        const tray = async (where: string) => {
          const closed = await page.evaluate(readHiddenTray);
          if (closed.count > 0) {
            await page.click("[data-hidden-pill]");
            await page.waitForTimeout(250);
          }
          const open = await page.evaluate(readHiddenTray);
          const named = seatTitles.filter((title) => open.tasks.includes(title));
          must(named.length === 0, `${tag} ${where}: the hidden tray names ${named.join(" | ")}`);
          if (closed.count > 0) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(150);
          }
          return open;
        };
        entry.hidden = await tray("board");

        await page.goto(`${baseUrl}/#p=${encodeURIComponent("__overview__")}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-kanban-board] header.bar[data-bar="overview"]', { timeout: 60_000 });
        await page.waitForTimeout(2_500);
        const overview = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-overview.png`) });
        const overviewCards = overview.columns.flatMap((column) => column.cards);
        must(overview.columns.every((column) => column.seatCards === 0), `${tag} overview: a seat conversation is drawn in ${overview.columns.filter((column) => column.seatCards).map((column) => column.status).join(", ")}`);
        must(seatTitles.every((title) => !overviewCards.includes(title)), `${tag} overview: a seat card is on the board (${overviewCards.join(" | ")})`);
        entry.overview = {
          columns: overview.columns.map((column) => ({ status: column.status, cards: column.cards, seatCards: column.seatCards })),
          hidden: await tray("overview"),
        };
      }

      if (which === "seat-placement") {
        const states: Record<string, ReturnType<typeof readSeatBoard>> = { topExpanded: base };
        await page.click("[data-seat-collapse]");
        await page.waitForTimeout(400);
        states.topCollapsed = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-top-collapsed.png`) });
        entry.popoverStrip = await (async () => {
          await page.click("[data-previous-seats]");
          await page.waitForSelector("[data-previous-seats-popover]");
          const reading = await page.evaluate(() => ({
            popoverX: Math.round(document.querySelector("[data-previous-seats-popover]")!.closest(".popover")!.getBoundingClientRect().x),
            seatX: Math.round(document.querySelector("[data-kanban-seat]")!.getBoundingClientRect().x),
          }));
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
          must(reading.popoverX >= reading.seatX, `${tag} strip: the popover starts at ${reading.popoverX}, left of the strip at ${reading.seatX}`);
          return reading;
        })();
        await page.click("[data-seat-collapse]");
        await page.waitForTimeout(300);
        await page.click("[data-seat-placement]");
        await page.waitForTimeout(600);
        states.sideExpanded = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-side.png`) });
        /* The popover under its control, not hanging over the rail. */
        const popoverIn = async (name: string) => {
          await page.click("[data-previous-seats]");
          await page.waitForSelector("[data-previous-seats-popover]");
          const reading = await page.evaluate(() => {
            const pop = document.querySelector("[data-previous-seats-popover]")!.closest(".popover")!.getBoundingClientRect();
            const seat = document.querySelector("[data-kanban-seat]")!.getBoundingClientRect();
            const control = document.querySelector("[data-previous-seats]")!.getBoundingClientRect();
            return { popoverX: Math.round(pop.x), seatX: Math.round(seat.x), controlX: Math.round(control.x), controlRight: Math.round(control.right) };
          });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
          must(reading.popoverX >= reading.seatX && (reading.popoverX === reading.controlX || Math.abs(reading.popoverX + 340 - reading.controlRight) <= 1), `${tag} ${name}: the popover starts at ${reading.popoverX}, the seat at ${reading.seatX}, the control at ${reading.controlX}–${reading.controlRight}`);
          return reading;
        };
        entry.sideFoldIcon = await page.evaluate(() => /lucide-(chevron-[a-z]+)/.exec(document.querySelector("[data-seat-collapse] svg")?.getAttribute("class") ?? "")?.[1] ?? null);
        entry.popoverSide = await popoverIn("side");
        await page.click("[data-seat-collapse]");
        await page.waitForTimeout(600);
        states.sideCollapsed = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-side-collapsed.png`) });
        entry.states = states;
        const { topExpanded, topCollapsed, sideExpanded, sideCollapsed } = states as Record<string, ReturnType<typeof readSeatBoard>>;
        must(topCollapsed!.headKind === "strip" && topCollapsed!.head !== null && near(topCollapsed!.head.h, 40, 1), `${tag}: the top strip is ${topCollapsed!.head?.h}px`);
        must(topCollapsed!.frame !== null && topExpanded!.frame !== null && topCollapsed!.frame.y < topExpanded!.frame.y - 100, `${tag}: collapsing on top freed ${(topExpanded!.frame?.y ?? 0) - (topCollapsed!.frame?.y ?? 0)}px`);
        must(sideExpanded!.seatPlacement === "side" && sideExpanded!.seat !== null && near(sideExpanded!.seat.w, 380, 1), `${tag}: the side seat is ${sideExpanded!.seat?.w}px`);
        /* Docked at the side the board keeps its columns: scrolling at 1280, never tabs. */
        must(sideExpanded!.board !== "tabs" && sideExpanded!.columns.every((column) => column.rect.w >= 200), `${tag}: beside the side seat the board is ${sideExpanded!.board} (${sideExpanded!.columns.map((column) => `${column.status} ${column.rect.w}`).join(", ")})`);
        /* The fold points left, into the rail. */
        must(entry.sideFoldIcon === "chevron-left", `${tag}: the side fold's arrow is ${entry.sideFoldIcon}`);
        /* The side head's first row holds the title and both controls. */
        const sideRow = (name: RegExp) => sideExpanded!.headControls.find((control) => name.test(control.name))?.rect.y ?? -1;
        must(sideRow(/Dock|Закріпити/) === sideRow(/(Collapse|Згорнути)/), `${tag}: at the side the fold sits on another row than the placement switch`);
        must(sideCollapsed!.seat !== null && near(sideCollapsed!.seat.w, 44, 1) && sideCollapsed!.rail !== null, `${tag}: the rail is ${sideCollapsed!.seat?.w}px`);
        /* Every head control inside the 380 px panel and clear of the others, in both placements. */
        for (const [name, state] of [["top", topExpanded!], ["side", sideExpanded!], ["top strip", topCollapsed!]] as const) {
          const controls = state.headControls;
          must(state.seat === null || controls.every((control) => control.rect.x >= state.seat!.x - 0.5 && control.rect.x + control.rect.w <= state.seat!.x + state.seat!.w + 0.5), `${tag} ${name}: a head control leaves the seat`);
          for (const [index, a] of controls.entries()) for (const b of controls.slice(index + 1)) {
            if (a.rect.x <= b.rect.x && a.rect.x + a.rect.w >= b.rect.x + b.rect.w && a.rect.y <= b.rect.y && a.rect.y + a.rect.h >= b.rect.y + b.rect.h) continue;
            if (b.rect.x <= a.rect.x && b.rect.x + b.rect.w >= a.rect.x + a.rect.w && b.rect.y <= a.rect.y && b.rect.y + b.rect.h >= a.rect.y + a.rect.h) continue;
            must(!overlaps(a.rect, b.rect, 0.5), `${tag} ${name}: seat head «${a.name}» and «${b.name}» overlap`);
          }
        }
        must(sideCollapsed!.page !== null && sideExpanded!.page !== null && near(sideCollapsed!.page.w - sideExpanded!.page.w, 336, 2), `${tag}: the board grew ${(sideCollapsed!.page?.w ?? 0) - (sideExpanded!.page?.w ?? 0)}px when the side seat collapsed`);
        for (const [name, state] of Object.entries(states)) must(state.bar !== null && near(state.bar.h, 48, 0.5), `${tag} ${name}: the bar is ${state.bar?.h}px`);
        must(sideCollapsed!.togglePressed === "false" && sideCollapsed!.toggleDot !== null && sideCollapsed!.toggleDot === sideCollapsed!.railTone, `${tag}: the toggle dot ${sideCollapsed!.toggleDot} vs the rail ${sideCollapsed!.railTone}`);
        must(topCollapsed!.toggleDot !== null && topCollapsed!.stateWord?.includes(topCollapsed!.toggleDot === "quiet" ? "quiet" : topCollapsed!.toggleDot) === true, `${tag}: the toggle dot ${topCollapsed!.toggleDot} vs the state word ${topCollapsed!.stateWord}`);
        must(topExpanded!.toggleDot === null && topExpanded!.togglePressed === "true", `${tag}: the expanded seat's toggle carries a dot or is not pressed`);
        /* Put the browser back on top and expanded for the next context. */
        await page.click("[data-seat-rail]");
        await page.click("[data-seat-placement]");
      }

      if (which === "columns-wide") {
        const share = (reading: ReturnType<typeof readSeatBoard>, status: string) => reading.columns.find((column) => column.status === status)?.rect.w ?? 0;
        const wideOnes = (reading: ReturnType<typeof readSeatBoard>) => reading.columns.filter((column) => column.wide === "1").map((column) => column.status);
        must(wideOnes(base).join() === "assigned", `${tag}: default wide ${wideOnes(base).join()}`);
        await page.click('[data-col-width="done"]');
        await page.waitForTimeout(500);
        const doneWide = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-done.png`) });
        must(wideOnes(doneWide).join() === "done", `${tag}: Done widened, wide is ${wideOnes(doneWide).join()}`);
        must(share(doneWide, "done") > share(doneWide, "assigned") + 150, `${tag}: Done ${share(doneWide, "done")}px vs Assigned ${share(doneWide, "assigned")}px`);
        must(near(share(doneWide, "done"), share(base, "assigned"), 2), `${tag}: Done took ${share(doneWide, "done")}px of Assigned's ${share(base, "assigned")}px`);
        must(doneWide.columns.find((column) => column.status === "done")!.clippedTitles === 0, `${tag}: a title in the wide column is clipped`);
        /* The wide column lays its tiles out as the workspace does: fixed tiles, not full-width rows. */
        const wideTiles = doneWide.columns.find((column) => column.status === "done")!.tileWidths;
        must(wideTiles.length > 0 && wideTiles.every((w) => w <= 200), `${tag}: the wide Done's tiles are ${wideTiles.join(", ")}px`);
        const shelfTiles = doneWide.columns.find((column) => column.status === "assigned")!;
        must(shelfTiles.tileWidths.every((w) => w <= shelfTiles.rect.w), `${tag}: a tile in the narrowed Assigned overflows it (${shelfTiles.tileWidths.join(", ")} in ${shelfTiles.rect.w})`);
        await page.click('[data-col-width="blocked"]');
        await page.waitForTimeout(300);
        await page.click('[data-col-pin="blocked"]');
        await page.waitForTimeout(300);
        /* Work in Assigned: a pinned shelf keeps the wide share. */
        await page.click('.column[data-status="assigned"] .card .title-trigger, .column[data-status="assigned"] .card').catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(400);
        const pinned = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-blocked-pinned.png`) });
        must(wideOnes(pinned).join() === "blocked", `${tag}: pinned Blocked, wide is ${wideOnes(pinned).join()}`);
        /* The shelf share: at most 264 px in the grid, the 280 px basis when the board scrolls. */
        must(share(pinned, "assigned") <= (pinned.board === "scroll" ? 280.5 : 264.5), `${tag}: Assigned kept ${share(pinned, "assigned")}px beside a pinned shelf (${pinned.board})`);
        /* The capture's init script empties storage on every load; the stored pin is put back ahead of
           the page, exactly as the browser would have kept it, so the reload reads it from storage. */
        const stored = await page.evaluate(() => localStorage.getItem("llv:kanban-wide:v1"));
        must(stored === "blocked", `${tag}: the pin stored ${stored}`);
        await context.addInitScript((value: string | null) => { if (value) localStorage.setItem("llv:kanban-wide:v1", value); }, stored);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(".kb .column", { timeout: 60_000 });
        await page.waitForTimeout(2_000);
        const reloaded = await page.evaluate(readSeatBoard);
        must(wideOnes(reloaded).join() === "blocked", `${tag}: after a reload, wide is ${wideOnes(reloaded).join()}`);
        /* The Overview keeps its fixed shares with the project's pin stored: no
           width controls, Assigned the wide one, every column head on one line. */
        await page.goto(`${baseUrl}/#p=${encodeURIComponent("__overview__")}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-kanban-board] header.bar[data-bar="overview"]', { timeout: 60_000 });
        await page.waitForTimeout(2_000);
        const overview = await page.evaluate(readSeatBoard);
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-overview.png`) });
        must(overview.columns.every((column) => column.widthControls === 0 && column.wide === null), `${tag} overview: width controls draw (${overview.columns.map((column) => `${column.status} ${column.widthControls}`).join(", ")})`);
        must(share(overview, "assigned") > share(overview, "blocked"), `${tag} overview: Assigned ${share(overview, "assigned")}px beside Blocked ${share(overview, "blocked")}px`);
        const oneLine = Math.min(...overview.columns.map((column) => column.headHeight));
        must(overview.columns.every((column) => column.headHeight <= oneLine + 1), `${tag} overview: a column head wraps (${overview.columns.map((column) => `${column.status} ${column.headHeight}`).join(", ")})`);
        entry.states = { default: base.columns, doneWide: doneWide.columns, blockedPinned: pinned.columns, reloaded: reloaded.columns, overview: overview.columns };
      }
      report[tag] = entry;
      await context.close();
    }

    if (which === "seats") {
      for (const lang of ["en", "uk"] as const) for (const colorScheme of ["light", "dark"] as const) {
        const tag = `seats-390-${lang}-${colorScheme}`;
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme, reducedMotion: "reduce" });
        await phone.addInitScript(seedInit);
        await phone.addInitScript((value: string) => localStorage.setItem("llv_lang", value), lang);
        const page = await phone.newPage();
        await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await page.waitForSelector('[data-mobile2-open="seat"]', { timeout: 120_000 });
        await page.waitForTimeout(2_500);
        /* Outside the seat card, nothing on the phone board names a seat. */
        const rows = await page.evaluate((titles: string[]) => [...document.querySelectorAll("body *")].filter((node) => node.children.length === 0
          && !node.closest('[data-mobile2-open="seat"], [data-testid="mobile-orchestrator-slot"]')
          && (titles.includes(node.textContent?.trim() ?? "") || /^seat conversation/.test(node.textContent?.trim() ?? ""))).length, seatTitles);
        must(rows === 0, `${tag}: ${rows} seat rows show on the phone board`);
        await page.click('[data-mobile2-open="seat"]');
        await page.waitForSelector("[data-mobile-previous-seats]", { timeout: 30_000 });
        const row = await page.evaluate(() => {
          const node = document.querySelector("[data-mobile-previous-seats]")!;
          const r = node.getBoundingClientRect();
          /* Drawn as the Seat tick row above it: the same inset, icon and chevron. */
          const tick = document.querySelector("[data-seat-tick-row]");
          const icon = (el: Element | null) => el?.querySelector("svg")?.getBoundingClientRect().x ?? null;
          return {
            count: node.getAttribute("data-mobile-previous-seats"), h: r.height, text: node.textContent?.trim() ?? "",
            iconX: icon(node), tickIconX: icon(tick),
            right: r.right, tickRight: tick?.getBoundingClientRect().right ?? null,
            chevron: node.querySelector("svg.lucide-chevron-right") !== null,
          };
        });
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-sheet.png`) });
        must(row.count === "2" && row.h >= 44, `${tag}: the sheet row reads ${row.count} at ${row.h}px`);
        must(row.iconX !== null && row.iconX === row.tickIconX && row.right === row.tickRight && row.chevron, `${tag}: the row's icon at ${row.iconX} vs the tick row's ${row.tickIconX}, right ${row.right} vs ${row.tickRight}, chevron ${row.chevron}`);
        await page.click("[data-mobile-previous-seats]");
        await page.waitForSelector("[data-mobile-previous-list]");
        const list = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-mobile-previous-list] [data-seat-row]")].map((node) => ({ current: node.dataset.seatCurrent === "1", h: node.getBoundingClientRect().height, text: node.textContent?.trim() ?? "", notes: node.querySelector("[data-seat-notes-toggle]")?.getBoundingClientRect().height ?? 0 })));
        const backText = await page.evaluate(() => document.querySelector("[data-mobile-previous-back]")?.textContent?.trim() ?? "");
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-list.png`) });
        /* The live seat first, under Current, then the two previous ones. */
        must(list.length === 3 && list[0]!.current && list.slice(1).every((entry) => !entry.current) && list.every((entry) => entry.h >= 56 && entry.notes >= 44), `${tag}: the list rows ${JSON.stringify(list)}`);
        must(backText === (lang === "uk" ? "Оркестратор" : "Orchestrator"), `${tag}: the back link reads «${backText}»`);
        await page.click("[data-mobile-previous-list] [data-seat-notes-toggle] >> nth=0");
        await page.waitForSelector("[data-mobile-previous-notes] [data-seat-notes]");
        await page.waitForFunction(() => !/…/.test(document.querySelector("[data-mobile-previous-notes] [data-seat-notes]")?.textContent ?? "…"), undefined, { timeout: 15_000 }).catch(() => {});
        const notes = await page.evaluate(() => document.querySelector("[data-mobile-previous-notes] [data-seat-notes]")?.textContent ?? "");
        await page.screenshot({ path: path.join(OUT_DIR, `${tag}-notes.png`) });
        /* The first row is the live seat: its notes are readable on the phone too. */
        must(notes === seats.live.notes, `${tag}: the notes screen reads «${notes}»`);
        report[tag] = { row, list, backText, notes };
        await phone.close();
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, `${which}.json`), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`${which} measurements: ${path.join(OUT_DIR, `${which}.json`)}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`${which} acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log(`${which} acceptance passed at ${which === "columns-wide" ? "1920, " : ""}1440 and 1280 (en, uk; light, dark)${which === "seats" ? " and 390 × 844" : ""}.`);
  }
}

/* ------------------------------------------------------------------------- */
/* Agent file links open in the preview: markdown, HTML report, :line        */
/* ------------------------------------------------------------------------- */

const PREVIEW_ROOT = path.join(REPO_DIR, "reports", "round-2");
const PREVIEW_REPORT = path.join(PREVIEW_ROOT, "index.html");
const PREVIEW_GUIDE = path.join(REPO_DIR, "docs", "release-guide.md");
const PREVIEW_SOURCE = path.join(REPO_DIR, "src", "delivery", "retry.ts");
const PREVIEW_MISSING = path.join(REPO_DIR, "reports", "round-3", "index.html");
const PREVIEW_LINKS = path.join(REPO_DIR, "docs", "links.md");
/** Notes beside retry.ts whose relative links carry encoded fragments and `file:line` suffixes. */
const PREVIEW_NOTES = path.join(path.dirname(PREVIEW_SOURCE), "NOTES.md");
const PREVIEW_DEEP = path.join(REPO_DIR, "docs", "deep-guide.md");
/** A non-loopback name the Viewer is served on, as over a tailnet. */
const PREVIEW_HOST = "viewer.example";

const previewSvg = (title: string, nodes: string[]) => {
  const boxes = nodes.map((label, i) => `<g transform="translate(${20 + i * 150},40)"><rect width="130" height="56" rx="10" fill="#e8f1fb" stroke="#1f5f99"/><text x="65" y="33" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#123">${label}</text></g>`).join("");
  const arrows = nodes.slice(1).map((_, i) => `<path d="M${150 + i * 150} 68 h20" stroke="#1f5f99" stroke-width="2" marker-end="url(#a)"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${nodes.length * 150 + 20}" height="130" viewBox="0 0 ${nodes.length * 150 + 20} 130"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8z" fill="#1f5f99"/></marker></defs><text x="20" y="24" font-family="sans-serif" font-size="14" font-weight="bold" fill="#123">${title}</text>${boxes}${arrows}</svg>`;
};

/** An invented report and guide the size agents really write: long sections, a table wider than a
    phone, a code block, relative CSS, images and a script, and anchors deep in the page. */
function seedFilePreview(): void {
  fs.mkdirSync(path.join(PREVIEW_ROOT, "assets"), { recursive: true });
  const section = (id: string, title: string, paragraphs: number) =>
    `<section id="${id}"><h2>${title}</h2>${Array.from({ length: paragraphs }, (_, i) => `<p>${title} — observation ${i + 1}. The banter redesign round kept the reply latency under the budget while the tone classifier moved to the second pass; every figure below comes from the replayed conversations of the round.</p>`).join("")}</section>`;
  const tableRows = Array.from({ length: 12 }, (_, i) => `<tr>${["variant-" + (i + 1), "0." + (61 + i), "0." + (44 + i), String(120 + i * 7) + " ms", String(8 + i) + "%", i % 2 ? "kept" : "dropped", "round " + ((i % 3) + 1), "classifier v" + (2 + (i % 2)), "notes on the replayed batch " + (i + 1)].map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  fs.writeFileSync(PREVIEW_REPORT, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Banter redesign — round 2</title><link rel="stylesheet" href="style.css"></head><body>
<header><h1>Banter redesign — round 2</h1><p class="lede">What changed since round 1, what the replay shows, and the decision graph for round 3.</p>
<nav><a href="#summary">Summary</a> · <a href="#metrics">Metrics</a> · <a href="#decision-graph">Decision graph</a> · <a href="#sandbox">Sandbox probe</a></nav></header>
${section("summary", "Summary", 6)}
<section id="metrics"><h2>Metrics</h2><div class="wide"><table><thead><tr><th>Variant</th><th>Precision</th><th>Recall</th><th>p95 latency</th><th>Drop rate</th><th>Outcome</th><th>Round</th><th>Classifier</th><th>Notes</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>
${section("replay", "Replay notes", 8)}
<section id="decision-graph"><h2>Decision graph</h2><p>Each node is a decision the round made; the arrows are what it unblocked.</p><img src="assets/decision-graph.svg" alt="Decision graph"><ol><li>Keep the second-pass tone classifier.</li><li>Drop the variants over the latency budget.</li><li>Replay round 3 against the same batch.</li></ol></section>
${section("next", "Next round", 5)}
<section id="appendix.1"><h2>Appendix 1 (a dotted id)</h2><p>Reached by an anchor holding a dot.</p><p id="module-status">module: waiting</p></section>
${section("closing", "Closing notes", 6)}
${section("підсумок", "Підсумок", 4)}
<section id="sandbox"><h2>Sandbox probe</h2><p>This page runs in the viewer's report frame. The script below tries to reach the viewer:</p><pre id="probe">running…</pre></section>
<script src="assets/probe.js"></script><script type="module" src="assets/module.js"></script></body></html>
`, "utf8");
  fs.writeFileSync(path.join(PREVIEW_ROOT, "style.css"), `body{font:15px/1.6 Georgia,serif;color:#1d2733;max-width:860px;margin:0 auto;padding:24px 20px 80px;background:#fff}h1{color:rgb(15,76,129);font:700 28px/1.2 system-ui,sans-serif}h2{color:rgb(15,76,129);font:700 20px/1.3 system-ui,sans-serif;border-bottom:1px solid #d5dde6;padding-bottom:4px;margin-top:36px}.lede{color:#4a5a6b}nav a{color:#1f5f99}.wide{overflow-x:auto}table{border-collapse:collapse;font:13px system-ui,sans-serif}td,th{border:1px solid #d5dde6;padding:4px 8px;white-space:nowrap}th{background:#eef3f8}img{max-width:100%}pre{background:#f4f6f8;padding:10px;border-radius:6px;white-space:pre-wrap}`, "utf8");
  fs.writeFileSync(path.join(PREVIEW_ROOT, "assets", "decision-graph.svg"), previewSvg("Round 2 → round 3", ["tone pass 2", "latency cut", "replay r3", "ship"]), "utf8");
  /* What a hostile report would try. Each probe records what the sandbox let it do. */
  fs.writeFileSync(path.join(PREVIEW_ROOT, "assets", "probe.js"), `(async () => {
  const out = { origin: self.origin, scriptRan: true };
  try { out.parentDocument = typeof parent.document.title === "string" ? "readable" : "unknown"; } catch { out.parentDocument = "blocked"; }
  try { out.cookie = document.cookie === "" ? "empty" : "readable"; } catch { out.cookie = "blocked"; }
  try { out.localStorage = localStorage.length >= 0 ? "readable" : "unknown"; } catch { out.localStorage = "blocked"; }
  try { const response = await fetch("/api/files"); out.viewerApi = "read " + response.status; } catch { out.viewerApi = "blocked"; }
  try { const response = await fetch("/api/artifact?path=" + encodeURIComponent("~/.claude.json") + "&mode=meta"); out.artifactApi = "read " + response.status; } catch { out.artifactApi = "blocked"; }
  document.body.dataset.probe = JSON.stringify(out);
  document.getElementById("probe").textContent = JSON.stringify(out, null, 2);
})();
`, "utf8");

  /* A module script is a CORS request from the frame's opaque origin, and so is its import and fetch. */
  fs.writeFileSync(path.join(PREVIEW_ROOT, "assets", "module.js"), `import { label } from "./helper.mjs";
const data = await (await fetch(new URL("./data.json", import.meta.url))).json();
document.body.dataset.module = label + ":" + data.rows;
document.getElementById("module-status").textContent = "module: " + document.body.dataset.module;
`, "utf8");
  fs.writeFileSync(path.join(PREVIEW_ROOT, "assets", "helper.mjs"), `export const label = "module-ran";\n`, "utf8");
  fs.writeFileSync(path.join(PREVIEW_ROOT, "assets", "data.json"), `{"rows": 12}\n`, "utf8");

  fs.mkdirSync(path.join(path.dirname(PREVIEW_GUIDE), "img"), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(PREVIEW_GUIDE), "img", "pipeline.svg"), previewSvg("Release train", ["freeze", "verify", "promote", "announce"]), "utf8");
  const wideHead = ["Stage", "Owner", "Gate", "Input", "Output", "Duration", "Retries", "Rollback", "Evidence", "Notes"];
  const wideRows = Array.from({ length: 9 }, (_, i) => [`stage-${i + 1}`, i % 2 ? "builder" : "reviewer", `gate ${i + 1}`, "candidate image", "signed manifest", `${4 + i} min`, String(i % 3), i % 2 ? "automatic" : "manual", `evidence/stage-${i + 1}.json`, "long free-text notes that make this column wider than a phone"]);
  const guide = [
    "# Release guide",
    "",
    "How a candidate becomes the running viewer. Read [the verification notes](verify.md#bun-runtime) first, and see the [retry code](../src/delivery/retry.ts:180) for the delivery side.",
    "",
    "![Release train](img/pipeline.svg)",
    "",
    ...Array.from({ length: 5 }, (_, s) => [
      `## Step ${s + 1}: ${["Freeze the branch", "Build the candidate", "Verify under the pinned runtime", "Promote", "Announce"][s]}`,
      "",
      ...Array.from({ length: 3 }, (_, p) => [`Paragraph ${p + 1} of step ${s + 1}. The candidate carries its own manifest, and every check below names the process it exercised, so a green result can be traced to the run that produced it.`, ""]).flat(),
      "- The gate reads the manifest, never the branch name.",
      "- A failed check stops the train:",
      "  - the candidate stays staged,",
      "  - the running viewer is untouched.",
      "1. Record the commit.",
      "2. Record the image digest.",
      "",
    ].join("\n")),
    "## Wide table",
    "",
    `| ${wideHead.join(" | ")} |`,
    `|${" --- |".repeat(wideHead.length)}`,
    ...wideRows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "## Verification script",
    "",
    "```ts",
    "export async function verifyCandidate(image: string): Promise<Verdict> {",
    "  const manifest = await readManifest(image);",
    "  for (const check of manifest.checks) {",
    "    const result = await runCheck(check, { runtime: manifest.runtime, timeoutMs: 120_000 });",
    "    if (!result.ok) return { ok: false, failed: check.name, output: result.output.slice(-4_000) };",
    "  }",
    "  return { ok: true };",
    "}",
    "```",
    "",
    "> A check that stays green against a subject that should fail is not a check.",
    "",
    ...Array.from({ length: 4 }, (_, s) => [`## Appendix ${String.fromCharCode(65 + s)}`, "", ...Array.from({ length: 4 }, (_, p) => [`Appendix paragraph ${p + 1}: the long tail of the guide, so the anchor has somewhere to scroll to.`, ""]).flat()].join("\n")),
  ].join("\n");
  fs.writeFileSync(PREVIEW_GUIDE, guide, "utf8");
  fs.writeFileSync(PREVIEW_LINKS, `# Links\n\nThe [round 2 report](http://${PREVIEW_HOST}:PORT/#f=${encodeURIComponent(PREVIEW_REPORT + "#decision-graph")}) on this Viewer's own host.\n`, "utf8");
  fs.writeFileSync(path.join(path.dirname(PREVIEW_GUIDE), "verify.md"), "# Verification\n\n## Bun runtime\n\nRun both halves under the pinned runtime.\n", "utf8");

  const filler = (title: string, count: number) => Array.from({ length: count }, (_, p) => [`${title}, paragraph ${p + 1}: enough text that the next heading sits far below the top of the preview.`, ""]).flat();
  fs.writeFileSync(PREVIEW_DEEP, ["# Deep guide", "", ...filler("Вступ", 30), "## Розділ", "", ...filler("Розділ", 6), "## Fallback plan", "", ...filler("Fallback", 30)].join("\n"), "utf8");
  const encoded = (value: string) => encodeURIComponent(value);
  fs.mkdirSync(path.dirname(PREVIEW_NOTES), { recursive: true });
  fs.writeFileSync(PREVIEW_NOTES, [
    "# Delivery notes",
    "",
    "- [Line suffix](retry.ts:180)",
    "- [Line and column](retry.ts:180:5)",
    `- [Encoded Unicode heading](../../docs/deep-guide.md#${encoded("розділ")})`,
    "- [Encoded ASCII heading](../../docs/deep-guide.md#Fallback%20plan)",
    `- [Encoded Unicode id](../../reports/round-2/index.html#${encoded("підсумок")})`,
    "- [Encoded ASCII id](../../reports/round-2/index.html#decision%2Dgraph)",
    "",
  ].join("\n"), "utf8");

  fs.mkdirSync(path.dirname(PREVIEW_SOURCE), { recursive: true });
  fs.writeFileSync(PREVIEW_SOURCE, Array.from({ length: 320 }, (_, i) => i === 179
    ? "  if (attempt > policy.maxAttempts) return { settled: false, reason: \"retry budget spent\" }; // the linked line"
    : `  const step${i + 1} = await deliver(message, { attempt: ${i % 5}, backoffMs: ${(i % 7) * 250} });`).join("\n") + "\n", "utf8");
}

/** Everything the preview case asserts, read in the page. */
function readPreview() {
  const rect = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sheet = document.querySelector<HTMLElement>("[data-artifact-preview]");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const controls = sheet ? [...sheet.querySelectorAll<HTMLElement>("button, a[href], input")].filter((el) => !el.closest("[data-md-document]") && el.getClientRects().length > 0).slice(0, 12) : [];
  const clipped = controls.map((el) => ({ label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.tagName, r: rect(el)! }))
    .filter(({ r }) => r.x < -0.5 || r.y < -0.5 || r.x + r.w > vw + 0.5 || r.y + r.h > vh + 0.5 || r.w < 1 || r.h < 1);
  const md = document.querySelector<HTMLElement>("[data-md-scroll]");
  const tableBox = document.querySelector<HTMLElement>("[data-md-document] table")?.parentElement ?? null;
  const target = document.querySelector<HTMLElement>("[data-preview-target]");
  const textScroller = target?.closest<HTMLElement>(".overflow-auto") ?? null;
  const scrollTop = md ? md.getBoundingClientRect().top : 0;
  const wide = document.querySelector<HTMLElement>('[data-md-anchor="wide-table"]');
  return {
    viewport: { w: vw, h: vh },
    state: sheet?.getAttribute("data-artifact-state") ?? null,
    kind: sheet?.getAttribute("data-artifact-kind") ?? null,
    sheet: rect(sheet),
    staleNotice: document.querySelector("[data-stale-focus-notice]")?.textContent?.trim() ?? null,
    pageOverflowX: document.documentElement.scrollWidth - vw,
    sheetOverflowX: sheet ? sheet.scrollWidth - sheet.clientWidth : null,
    controls: controls.map((el) => ({ label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.tagName, r: rect(el) })),
    clippedControls: clipped,
    frame: (() => { const f = document.querySelector("iframe[data-preview-frame]"); return f ? { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src"), r: rect(f) } : null; })(),
    openExternal: document.querySelector("[data-preview-open-external]")?.getAttribute("href") ?? null,
    markdown: md ? {
      overflowX: md.scrollWidth - md.clientWidth,
      scrollTop: md.scrollTop,
      headings: document.querySelectorAll("[data-md-document] [data-md-anchor]").length,
      tableScrollsInside: tableBox ? tableBox.scrollWidth > tableBox.clientWidth : null,
      tallestTableRow: Math.round(Math.max(0, ...[...document.querySelectorAll("[data-md-document] tr")].map((row) => row.getBoundingClientRect().height))),
      images: [...document.querySelectorAll<HTMLImageElement>("[data-md-document] img")].map((img) => ({ loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute("src") })),
      wideTableHeadingTop: wide ? Math.round(wide.getBoundingClientRect().top - scrollTop) : null,
      codeBlocks: document.querySelectorAll("[data-md-document] pre").length,
      listItems: document.querySelectorAll("[data-md-document] [data-md-list] li").length,
    } : null,
    failurePath: document.querySelector("[data-preview-failure-path]")?.textContent ?? null,
    failureText: document.querySelector("[data-artifact-preview] [role=alert]")?.textContent?.trim() ?? null,
    line: target ? {
      index: target.getAttribute("data-preview-line"),
      visible: (() => { const t = target.getBoundingClientRect(); const s = textScroller!.getBoundingClientRect(); return t.top >= s.top && t.bottom <= s.bottom; })(),
      text: target.textContent?.slice(0, 200) ?? "",
    } : null,
  };
}

type PreviewReading = ReturnType<typeof readPreview>;

async function filePreviewMain(): Promise<void> {
  seedHome();
  seedFilePreview();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = await freePort();
  SERVER_EXTRA_ENV.LLV_TS_HOST = PREVIEW_HOST;
  fs.writeFileSync(PREVIEW_LINKS, fs.readFileSync(PREVIEW_LINKS, "utf8").replace(":PORT/", `:${port}/`), "utf8");
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  /* Paths in the record are $HOME-relative: the synthetic home lives under the temp root. */
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).split(HOME).join("$HOME").split(encodeURIComponent(HOME)).join(encodeURIComponent("$HOME")));
  const report: Record<string, unknown> = { commit: captureCommit() };
  const fHash = (spelled: string) => `#f=${encodeURIComponent(spelled)}`;
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", `--host-resolver-rules=MAP ${PREVIEW_HOST} 127.0.0.1`], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const viewports = [
      { tag: "desktop", options: { viewport: { width: 1280, height: 800 } } },
      { tag: "phone", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    ] as const;
    for (const { tag, options } of viewports) {
      const phone = tag === "phone";
      const context = await browser.newContext(options);
      await context.addInitScript(seedInit);
      /* A viewer cookie the report must not be able to read. */
      await context.addCookies([{ name: "llv_probe", value: "viewer-only", url: baseUrl }]);
      const page = await context.newPage();
      const visit = async (hash: string, waitFor: string) => {
        await page.goto(`${baseUrl}/${hash}`);
        await page.waitForSelector(waitFor, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1_200);
      };
      const common = (name: string, reading: PreviewReading) => {
        must(reading.sheet !== null, `${tag} ${name}: the preview did not open (state ${reading.state}, notice «${reading.staleNotice}»)`);
        must(reading.staleNotice === null, `${tag} ${name}: a not-found notice showed: «${reading.staleNotice}»`);
        must(reading.pageOverflowX <= 0, `${tag} ${name}: the page overflows sideways by ${reading.pageOverflowX}px`);
        must((reading.sheetOverflowX ?? 0) <= 0, `${tag} ${name}: the sheet overflows sideways by ${reading.sheetOverflowX}px`);
        must(reading.clippedControls.length === 0, `${tag} ${name}: clipped controls ${JSON.stringify(reading.clippedControls)}`);
        if (phone) for (const control of reading.controls) must(!control.r || control.r.h >= 44, `${tag} ${name}: «${control.label}» is ${control.r?.h}px tall`);
      };

      /* 1. The owner's link: an HTML report with its anchor glued on as %23. */
      await visit(fHash(`${PREVIEW_REPORT}#decision-graph`), "iframe[data-preview-frame]");
      const frame = page.frames().find((candidate) => candidate.url().includes("/api/artifact/frame/")) ?? null;
      if (frame) await frame.waitForFunction(() => Boolean(document.body?.dataset.probe && document.body.dataset.module), undefined, { timeout: 15_000 }).catch(() => {});
      const html = await page.evaluate(readPreview);
      const inFrame = frame ? await frame.evaluate(() => {
        const target = document.getElementById("decision-graph");
        const img = document.querySelector<HTMLImageElement>("#decision-graph img");
        return {
          probe: JSON.parse(document.body.dataset.probe ?? "null") as Record<string, string> | null,
          module: document.body.dataset.module ?? null,
          scrollY: Math.round(window.scrollY),
          anchorTop: target ? Math.round(target.getBoundingClientRect().top) : null,
          stylesheetApplied: getComputedStyle(document.querySelector("h1")!).color,
          relativeImageLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      }) : null;
      common("html", html);
      must(html.frame !== null, `${tag} html: no report frame`);
      must(Boolean(html.frame && /allow-scripts/.test(html.frame.sandbox ?? "") && !/allow-same-origin/.test(html.frame.sandbox ?? "")), `${tag} html: frame sandbox «${html.frame?.sandbox}»`);
      must(Boolean(html.frame?.src?.endsWith("#decision-graph")), `${tag} html: frame src «${html.frame?.src}»`);
      must(inFrame !== null && inFrame.scrollY > 0 && inFrame.anchorTop !== null && Math.abs(inFrame.anchorTop) <= 4, `${tag} html: the anchor did not scroll the frame ${JSON.stringify(inFrame && { scrollY: inFrame.scrollY, anchorTop: inFrame.anchorTop })}`);
      must(inFrame?.stylesheetApplied === "rgb(15, 76, 129)", `${tag} html: relative CSS did not apply (${inFrame?.stylesheetApplied})`);
      must(Boolean(inFrame?.relativeImageLoaded), `${tag} html: the relative image did not load`);
      const probe = inFrame?.probe ?? null;
      must(probe?.scriptRan === true as unknown as string, `${tag} html: the report's relative script did not run`);
      must(probe?.origin === "null", `${tag} html: the frame's origin is «${probe?.origin}», not opaque`);
      must(inFrame?.module === "module-ran:12", `${tag} html: the report's module script, its import or its fetch did not run («${inFrame?.module}»)`);
      for (const key of ["parentDocument", "cookie", "localStorage", "viewerApi", "artifactApi"]) must(probe?.[key] === "blocked", `${tag} html: the frame reached ${key}: «${probe?.[key]}»`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-html-anchor.png`) });
      report[`${tag}-html`] = { ...html, inFrame };

      /* Open in a new tab: the same sandbox holds at the top level. */
      if (html.openExternal) {
        const tab = await context.newPage();
        const response = await tab.goto(new URL(html.openExternal, baseUrl).toString());
        await tab.waitForFunction(() => Boolean(document.body?.dataset.probe && document.body.dataset.module), undefined, { timeout: 15_000 }).catch(() => {});
        const tabProbe = await tab.evaluate(() => JSON.parse(document.body.dataset.probe ?? "null") as Record<string, string> | null);
        const tabModule = await tab.evaluate(() => document.body.dataset.module ?? null);
        must(response?.status() === 200 && tabProbe?.origin === "null" && tabProbe?.cookie === "blocked", `${tag} html: the new tab is not sandboxed ${JSON.stringify(tabProbe)}`);
        must(tabModule === "module-ran:12", `${tag} html: the module script did not run in the new tab («${tabModule}»)`);
        report[`${tag}-html-new-tab`] = { status: response?.status(), probe: tabProbe, module: tabModule };
        await tab.close();
      }

      /* The source toggle. */
      await page.click('[data-preview-mode="source"]').catch(() => {});
      await page.waitForSelector('[data-preview-line="1"]', { timeout: 15_000 }).catch(() => {});
      const htmlSource = await page.evaluate(readPreview);
      const firstLine = await page.evaluate(() => document.querySelector('[data-preview-line="0"]')?.textContent ?? "");
      common("html-source", htmlSource);
      must(htmlSource.frame === null, `${tag} html-source: the frame is still shown`);
      must(firstLine.includes("<!doctype html>"), `${tag} html-source: the source view shows «${firstLine.slice(0, 60)}»`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-html-source.png`) });

      /* An element id holding a dot, encoded into the payload. */
      await visit(fHash(`${PREVIEW_REPORT}#appendix.1`), "iframe[data-preview-frame]");
      const dotted = await page.evaluate(readPreview);
      const dottedFrame = page.frames().find((candidate) => candidate.url().includes("/api/artifact/frame/")) ?? null;
      const dottedTop = dottedFrame ? await dottedFrame.evaluate(() => { const el = document.getElementById("appendix.1"); return el ? Math.round(el.getBoundingClientRect().top) : null; }) : null;
      common("html-dotted-anchor", dotted);
      must(dotted.state === "ready" && dottedTop !== null && Math.abs(dottedTop) <= 4, `${tag} html-dotted-anchor: state ${dotted.state}, anchor top ${dottedTop}`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-html-dotted-anchor.png`) });
      report[`${tag}-html-dotted-anchor`] = { ...dotted, anchorTop: dottedTop };

      /* 2. A long markdown guide: top, then its wide-table anchor. */
      await visit(fHash(PREVIEW_GUIDE), "[data-md-document]");
      const mdTop = await page.evaluate(readPreview);
      common("markdown", mdTop);
      must(Boolean(mdTop.markdown && mdTop.markdown.headings >= 10 && mdTop.markdown.codeBlocks === 1 && mdTop.markdown.listItems >= 20), `${tag} markdown: document blocks ${JSON.stringify(mdTop.markdown)}`);
      must(Boolean(mdTop.markdown && mdTop.markdown.overflowX <= 0), `${tag} markdown: the document overflows sideways by ${mdTop.markdown?.overflowX}px`);
      must(Boolean(mdTop.markdown?.images.length && mdTop.markdown.images.every((image) => image.loaded)), `${tag} markdown: relative images ${JSON.stringify(mdTop.markdown?.images)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-markdown-top.png`) });
      report[`${tag}-markdown-top`] = mdTop;

      await visit(fHash(`${PREVIEW_GUIDE}#wide-table`), "[data-md-document]");
      const mdAnchor = await page.evaluate(readPreview);
      common("markdown-anchor", mdAnchor);
      must(Boolean(mdAnchor.markdown && mdAnchor.markdown.scrollTop > 0 && mdAnchor.markdown.wideTableHeadingTop !== null && Math.abs(mdAnchor.markdown.wideTableHeadingTop) <= 40), `${tag} markdown: the anchor did not bring its heading up ${JSON.stringify(mdAnchor.markdown && { scrollTop: mdAnchor.markdown.scrollTop, top: mdAnchor.markdown.wideTableHeadingTop })}`);
      must(Boolean(mdAnchor.markdown?.tableScrollsInside), `${tag} markdown: the wide table does not scroll inside its own box`);
      /* Squeezed to the viewport, every cell broke to one word per line and a row grew to 450 px. */
      must((mdAnchor.markdown?.tallestTableRow ?? 0) <= 80, `${tag} markdown: a table row is ${mdAnchor.markdown?.tallestTableRow}px tall`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-markdown-anchor.png`) });
      report[`${tag}-markdown-anchor`] = mdAnchor;

      /* A relative link followed after a Source/Rendered round trip lands on the next document and its anchor. */
      await visit(fHash(PREVIEW_GUIDE), "[data-md-document]");
      await page.click('[data-preview-mode="source"]');
      await page.waitForSelector('[data-preview-line="1"]', { timeout: 15_000 }).catch(() => {});
      await page.click('[data-preview-mode="rendered"]');
      await page.waitForSelector("[data-md-document]", { timeout: 15_000 }).catch(() => {});
      await page.click('[data-md-document] a:has-text("the verification notes")');
      await page.waitForSelector('[data-md-anchor="bun-runtime"]', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(600);
      const followed = await page.evaluate(readPreview);
      const followedHeading = await page.evaluate(() => document.querySelector("[data-md-document] h1")?.textContent ?? null);
      common("markdown-relative-link", followed);
      must(followed.state === "ready" && followedHeading === "Verification", `${tag} markdown-relative-link: state ${followed.state}, heading «${followedHeading}», alert «${followed.failureText}»`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-markdown-relative-link.png`) });
      report[`${tag}-markdown-relative-link`] = { ...followed, heading: followedHeading };

      /* Relative links with a percent-encoded fragment land on their heading or element id. */
      for (const [label, anchor, name] of [
        ["Encoded Unicode heading", "розділ", "markdown-encoded-unicode-fragment"],
        ["Encoded ASCII heading", "fallback-plan", "markdown-encoded-ascii-fragment"],
      ] as const) {
        /* A fresh document each time: re-entering the same hash is no navigation. */
        await page.goto("about:blank");
        await visit(fHash(PREVIEW_NOTES), "[data-md-document]");
        await page.click(`[data-md-document] a:has-text("${label}")`);
        await page.waitForSelector(`[data-md-anchor="${anchor}"]`, { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(600);
        const landed = await page.evaluate(readPreview);
        const headingTop = await page.evaluate((wanted) => {
          const heading = document.querySelector(`[data-md-anchor="${wanted}"]`);
          const scroller = document.querySelector("[data-md-scroll]");
          return heading && scroller ? Math.round(heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null;
        }, anchor);
        common(name, landed);
        must(landed.state === "ready" && Boolean(landed.markdown && landed.markdown.scrollTop > 0) && headingTop !== null && Math.abs(headingTop) <= 40, `${tag} ${name}: state ${landed.state}, scrollTop ${landed.markdown?.scrollTop}, heading top ${headingTop}`);
        await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-${name}.png`) });
        report[`${tag}-${name}`] = { ...landed, headingTop };
      }
      for (const [label, id, name] of [
        ["Encoded Unicode id", "підсумок", "html-encoded-unicode-fragment"],
        ["Encoded ASCII id", "decision-graph", "html-encoded-ascii-fragment"],
      ] as const) {
        /* A fresh document each time: re-entering the same hash is no navigation. */
        await page.goto("about:blank");
        await visit(fHash(PREVIEW_NOTES), "[data-md-document]");
        await page.click(`[data-md-document] a:has-text("${label}")`);
        await page.waitForSelector("iframe[data-preview-frame]", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1_200);
        const landed = await page.evaluate(readPreview);
        const landedFrame = page.frames().find((candidate) => candidate.url().includes("/api/artifact/frame/")) ?? null;
        const idTop = landedFrame ? await landedFrame.evaluate((wanted) => { const el = document.getElementById(wanted); return el ? { top: Math.round(el.getBoundingClientRect().top), scrollY: Math.round(window.scrollY) } : null; }, id) : null;
        common(name, landed);
        must(landed.state === "ready" && Boolean(landed.frame?.src?.endsWith(`#${encodeURIComponent(id)}`)) && idTop !== null && idTop.scrollY > 0 && Math.abs(idTop.top) <= 4, `${tag} ${name}: state ${landed.state}, frame «${landed.frame?.src}», element ${JSON.stringify(idTop)}`);
        await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-${name}.png`) });
        report[`${tag}-${name}`] = { ...landed, element: idTop };
      }

      /* A sibling file named with a :line or :line:col suffix opens at that line. */
      for (const [label, name] of [["Line suffix", "code-sibling-line"], ["Line and column", "code-sibling-line-column"]] as const) {
        /* A fresh document each time: re-entering the same hash is no navigation. */
        await page.goto("about:blank");
        await visit(fHash(PREVIEW_NOTES), "[data-md-document]");
        await page.click(`[data-md-document] a:has-text("${label}")`);
        await page.waitForSelector("[data-preview-target]", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(600);
        const sibling = await page.evaluate(readPreview);
        common(name, sibling);
        must(Boolean(sibling.line && sibling.line.index === "179" && sibling.line.visible && sibling.line.text.includes("the linked line")), `${tag} ${name}: state ${sibling.state}, line ${JSON.stringify(sibling.line)}`);
        await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-${name}.png`) });
        report[`${tag}-${name}`] = sibling;
      }

      /* A link to the Viewer's own non-loopback host opens the same anchored report as a loopback one. */
      await page.goto(`http://${PREVIEW_HOST}:${port}/${fHash(PREVIEW_LINKS)}`);
      await page.waitForSelector("[data-md-document]", { timeout: 30_000 }).catch(() => {});
      await page.click('[data-md-document] a:has-text("round 2 report")').catch(() => {});
      await page.waitForSelector("iframe[data-preview-frame]", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1_200);
      const hosted = await page.evaluate(readPreview);
      common("html-own-host", hosted);
      must(hosted.state === "ready" && Boolean(hosted.frame?.src?.endsWith("/index.html#decision-graph")), `${tag} html-own-host: state ${hosted.state}, frame «${hosted.frame?.src}», alert «${hosted.failureText}»`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-html-own-host.png`) });
      report[`${tag}-html-own-host`] = hosted;

      /* 3. Code with a :line. */
      await visit(fHash(`${PREVIEW_SOURCE}:180`), "[data-preview-target]");
      const code = await page.evaluate(readPreview);
      common("code-line", code);
      must(Boolean(code.line && code.line.index === "179" && code.line.visible && code.line.text.includes("the linked line")), `${tag} code: line ${JSON.stringify(code.line)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-code-line.png`) });
      report[`${tag}-code-line`] = code;

      /* 4. A path that does not exist. */
      await visit(fHash(`${PREVIEW_MISSING}#summary`), "[data-preview-failure-path]");
      const missing = await page.evaluate(readPreview);
      common("missing", missing);
      must(missing.state === "missing" && missing.failurePath === PREVIEW_MISSING, `${tag} missing: state ${missing.state}, path «${missing.failurePath}»`);
      await page.screenshot({ path: path.join(OUT_DIR, `preview-${tag}-missing.png`) });
      report[`${tag}-missing`] = missing;

      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "file-preview.json"), JSON.stringify(scrub(report), null, 2) + "\n", "utf8");
  console.log(`file preview measurements: ${path.join(OUT_DIR, "file-preview.json")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`file preview acceptance FAILED (${failures.length}):\n  ${scrub(failures).join("\n  ")}`);
  } else {
    console.log("file preview acceptance passed at 1280 × 800 and 390 × 844.");
  }
}

/* ------------------------------------------------------------------------- */
/* BOARD_CAPTURE_CASE=resources (#2110, #1817)                                */
/* ------------------------------------------------------------------------- */

const RESOURCES_FIXTURE = path.join(BASE, "resources.json");
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A session table and Delegatus's own processes, shaped like the machine the
    issue was reproduced on: four agent hosts, five Delegatus processes. */
function writeResourcesFixture(stale: boolean): number {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const sessionsCapturedAt = stale ? iso(4 * 86_400_000 - 45 * 60_000) : iso(40_000);
  const host = (index: number, title: string, role: string, stage: string | null, model: string, rss: number, swap: number, over: Record<string, unknown> = {}) => ({
    target: `structured:codex:0000000${index}-2110-4000-8000-000000000000`, panePid: 41_000 + index, kind: "structured",
    path: null, engine: "codex", title, project: "harbor", activity: "idle", lastActiveAt: stale ? iso(4 * 86_400_000 + index * 3_600_000) : iso(index * 1_800_000),
    cwd: `$HOME/Projects/harbor-pipeline-${index}`, rssBytes: rss, swapBytes: swap, procCount: 5,
    model, role, conversationId: null, stage, ownership: "owned", seat: false, turnBusy: false, ...over,
  });
  const processes = [
    { pid: 892_225, role: "server", name: "bun-container", rssBytes: 1.3 * GIB, swapBytes: 0, procCount: 1 },
    { pid: 921_801, role: "runtime-host", name: "main", rssBytes: 690 * MIB, swapBytes: 0, procCount: 1 },
    { pid: 894_438, role: "worker", name: "accountMigrationController.worker", rssBytes: 1.3 * GIB, swapBytes: 210 * MIB, procCount: 1 },
    { pid: 894_382, role: "worker", name: "wakatimeSync.worker", rssBytes: 980 * MIB, swapBytes: 0, procCount: 1 },
    { pid: 2_787_025, role: "worker", name: "filesResponse.worker", rssBytes: 960 * MIB, swapBytes: 0, procCount: 1 },
    { pid: 894_409, role: "worker", name: "telegram-mcp-server", rssBytes: 52 * MIB, swapBytes: 0, procCount: 1 },
  ];
  const fixture = {
    system: { ramTotal: 32 * GIB, ramAvailable: 2.8 * GIB, swapTotal: 40 * GIB, swapUsed: 17 * GIB, capturedAt: iso(0) },
    sessions: [
      host(1, "orchestrator · You are the viewer's built-in Manager for the harbor backlog", "orchestrator", null, "gpt-6-astra", 375 * MIB, 1_000 * MIB, { seat: true }),
      host(2, "Antispam tier 1: check a cheaper model against the labelled set", "builder", "jev-eval", "gpt-6-astra", 1.1 * GIB, 0, { turnBusy: true, activity: "live" }),
      host(3, "Keep one owner per repository, pull request and head delivery", "builder", "implement", "gpt-6-astra", 1_030 * MIB, 0),
      host(4, "Give an exact state for host release operations", "reviewer", "review", "gpt-6-astra", 285 * MIB, 580 * MIB),
    ],
    sessionsCapturedAt,
    sessionsStale: stale,
    viewer: {
      actionable: false, capturedAt: iso(0),
      rssBytes: processes.reduce((total, item) => total + item.rssBytes, 0),
      swapBytes: processes.reduce((total, item) => total + item.swapBytes, 0),
      procCount: processes.length,
      processes,
    },
  };
  fs.writeFileSync(RESOURCES_FIXTURE, JSON.stringify(fixture, null, 2) + "\n", "utf8");
  return processes.length;
}

function readResources() {
  const box = (element: Element | null) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const footer = document.querySelector("[data-resources-footer]");
  const panel = document.querySelector("[data-resources-panel]");
  const section = panel?.querySelector('[data-testid="resources-viewer-section"]') ?? null;
  const scroller = panel?.querySelector(".overflow-y-auto") ?? null;
  const overflowing = [...(panel?.querySelectorAll("*") ?? [])]
    .filter((element) => {
      const style = getComputedStyle(element);
      if (style.overflowX !== "visible" || style.textOverflow === "ellipsis") return false;
      return element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0;
    })
    .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    footer: box(footer),
    footerButton: box(footer?.querySelector("button[aria-expanded]") ?? null),
    viewerLine: footer?.querySelector('[data-testid="resources-viewer-line"]')?.textContent ?? null,
    staleDot: Boolean(footer?.querySelector('[data-testid="resources-stale-dot"]')),
    panel: box(panel),
    panelScrollerOverflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
    overflowing,
    staleBanner: panel?.querySelector('[data-testid="resources-sessions-stale"]')?.textContent ?? null,
    /* Where the stale text is drawn, and whether a scrolling box can take it away. */
    staleBannerBox: box(panel?.querySelector('[data-testid="resources-sessions-stale"]') ?? null),
    staleBannerScrolls: Boolean(scroller?.querySelector('[data-testid="resources-sessions-stale"]')),
    staleRowMarks: panel?.querySelectorAll('[data-testid="resource-host-row"] [data-testid="resource-row-stale"]').length ?? 0,
    scrollerAtBottom: scroller ? Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1 : null,
    hostRows: panel?.querySelectorAll('[data-testid="resource-host-row"]').length ?? 0,
    section: box(section),
    sectionText: section?.textContent ?? null,
    sectionControls: section?.querySelectorAll("button, input, select, a[href]").length ?? null,
    processRows: section?.querySelectorAll('[data-testid="resources-viewer-process"]').length ?? 0,
    /* The title is the row's identity: it must keep real width beside the chips (#2110 phone rows). */
    titleWidths: [...(panel?.querySelectorAll('[data-testid="resource-host-row"] [data-resource-title]') ?? [])].map((element) => Math.round(element.getBoundingClientRect().width)),
    /* Every control drawn inside the panel's box, none pushed past its edge. */
    controlsOutside: [...(panel?.querySelectorAll("button, select, input") ?? [])].filter((element) => {
      const r = element.getBoundingClientRect();
      const p = panel!.getBoundingClientRect();
      return r.width > 0 && (r.left < p.left - 1 || r.right > p.right + 1);
    }).map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)),
    panelTargets: [...(panel?.querySelectorAll("button, select") ?? [])].map((element) => ({
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40),
      h: Math.round(element.getBoundingClientRect().height),
    })),
  };
}

type ResourcesReading = ReturnType<typeof readResources>;

async function resourcesMain(): Promise<void> {
  seedHome();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = await freePort();
  SERVER_EXTRA_ENV.LLV_RESOURCES_FIXTURE = RESOURCES_FIXTURE;
  let processCount = writeResourcesFixture(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { commit: captureCommit() };
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    /* A home with no Viewer state opens the setup guide over everything; this
       case is about the footer, so the guide is dismissed the way its × does. */
    const dismissed = await fetch(`${baseUrl}/api/onboarding`, {
      method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ dismissed: true }),
    });
    must(dismissed.ok, `dismissing the setup guide answered ${dismissed.status}`);
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const shots = [
      ...(["en", "uk"] as const).flatMap((lang) => (["light", "dark"] as const).map((colorScheme) => ({ phone: false, lang, colorScheme, stale: true }))),
      { phone: false, lang: "en" as const, colorScheme: "light" as const, stale: false },
      { phone: true, lang: "en" as const, colorScheme: "light" as const, stale: true },
      { phone: true, lang: "en" as const, colorScheme: "dark" as const, stale: true },
      { phone: true, lang: "uk" as const, colorScheme: "light" as const, stale: true },
      { phone: true, lang: "en" as const, colorScheme: "light" as const, stale: false },
    ];
    for (const shot of shots) {
      processCount = writeResourcesFixture(shot.stale);
      const tag = `${shot.phone ? "phone" : "desktop"}-${shot.lang}-${shot.colorScheme}-${shot.stale ? "stale" : "current"}`;
      const context = await browser.newContext(shot.phone
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: shot.colorScheme, reducedMotion: "reduce" }
        : { viewport: { width: 1280, height: 800 }, colorScheme: shot.colorScheme, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), shot.lang);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`);
      if (shot.phone) {
        await page.waitForSelector('[data-mobile2-open="projects"]', { timeout: 30_000 });
        await page.click('[data-mobile2-open="projects"]');
        await page.waitForSelector('[data-mobile2-sheet="projects"]', { timeout: 10_000 });
      }
      await page.waitForSelector("[data-resources-footer]", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const closed = await page.evaluate(readResources);
      must(closed.footer !== null, `${tag}: the resources footer did not render`);
      must(Boolean(closed.viewerLine?.includes("Delegatus") && /GiB|MiB/.test(closed.viewerLine)), `${tag}: the footer's Delegatus line reads «${closed.viewerLine}»`);
      must(closed.staleDot === shot.stale, `${tag}: stale mark ${closed.staleDot} on a ${shot.stale ? "stale" : "current"} table`);
      if (shot.phone) must((closed.footerButton?.h ?? 0) >= 44, `${tag}: the footer target is ${closed.footerButton?.h}px tall`);
      if (closed.footer) {
        const pad = 8;
        const clip = shot.phone
          ? { x: 0, y: 0, width: 390, height: 844 }
          : { x: Math.max(0, closed.footer.x - pad), y: Math.max(0, closed.footer.y - 120), width: closed.footer.w + 2 * pad, height: Math.min(800 - Math.max(0, closed.footer.y - 120), closed.footer.h + 120 + pad) };
        await page.screenshot({ path: path.join(OUT_DIR, `resources-${tag}-footer.png`), clip });
      }
      await page.click("[data-resources-footer] button[aria-expanded]");
      await page.waitForSelector("[data-resources-panel]", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const open: ResourcesReading = await page.evaluate(readResources);
      must(open.panel !== null, `${tag}: the panel did not open`);
      if (open.panel) {
        must(open.panel.x >= 0 && open.panel.y >= 0 && open.panel.x + open.panel.w <= open.viewport.w && open.panel.y + open.panel.h <= open.viewport.h,
          `${tag}: panel ${JSON.stringify(open.panel)} leaves the ${open.viewport.w}×${open.viewport.h} viewport`);
      }
      must(open.pageOverflowX <= 0, `${tag}: the page overflows sideways by ${open.pageOverflowX}px`);
      must((open.panelScrollerOverflowX ?? 0) <= 0, `${tag}: the panel list overflows sideways by ${open.panelScrollerOverflowX}px`);
      must(open.overflowing.length === 0, `${tag}: overflowing elements ${JSON.stringify(open.overflowing)}`);
      must(open.hostRows === 4, `${tag}: ${open.hostRows} host rows`);
      must(shot.stale ? Boolean(open.staleBanner) : open.staleBanner === null, `${tag}: stale banner «${open.staleBanner}» on a ${shot.stale ? "stale" : "current"} table`);
      must(open.section !== null && open.processRows === processCount, `${tag}: Delegatus section with ${open.processRows} of ${processCount} processes`);
      must(open.sectionControls === 0, `${tag}: the Delegatus section carries ${open.sectionControls} controls`);
      if (shot.phone) for (const target of open.panelTargets) must(target.h >= 44, `${tag}: «${target.label}» is ${target.h}px tall`);
      must(open.titleWidths.length === 4 && open.titleWidths.every((width) => width >= 100), `${tag}: host titles are ${JSON.stringify(open.titleWidths)}px wide`);
      must(open.controlsOutside.length === 0, `${tag}: controls outside the panel ${JSON.stringify(open.controlsOutside)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `resources-${tag}-panel.png`) });
      must(open.staleRowMarks === (shot.stale ? 4 : 0), `${tag}: ${open.staleRowMarks} rows marked stale on a ${shot.stale ? "stale" : "current"} table`);
      /* The section sits below the rows; scroll the list to its end, where the
         review found the only stale mark scrolled away (#2110). */
      await page.evaluate(() => {
        const scroller = document.querySelector("[data-resources-panel] .overflow-y-auto");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await page.waitForTimeout(150);
      const scrolled: ResourcesReading = await page.evaluate(readResources);
      must(scrolled.scrollerAtBottom === true, `${tag}: the panel list did not reach its end`);
      if (shot.stale) {
        const mark = scrolled.staleBannerBox;
        must(!scrolled.staleBannerScrolls, `${tag}: the stale text sits inside the scrolling list`);
        must(mark !== null && mark.h > 0 && mark.y >= 0 && mark.y + mark.h <= scrolled.viewport.h
          && scrolled.panel !== null && mark.y >= scrolled.panel.y && mark.y + mark.h <= scrolled.panel.y + scrolled.panel.h,
          `${tag}: scrolled to the end, the stale text is at ${JSON.stringify(mark)}`);
      }
      await page.screenshot({ path: path.join(OUT_DIR, `resources-${tag}-panel-delegatus.png`) });
      report[tag] = { closed, open, scrolled };
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "resources.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`resources measurements: ${path.join(OUT_DIR, "resources.json")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`resources acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("resources acceptance passed at 1280 × 800 and 390 × 844.");
  }
}

/* ------------------------------------------------------------------------- */
/* BOARD_CAPTURE_CASE=activity: the activity dashboard                         */
/* ------------------------------------------------------------------------- */

const ACTIVITY_TZ = "Europe/Kyiv";
/* Invented projects (docs/design/activity-dashboard-v2.md, "The mockup"): ten
   with agent work, as repositories whose Claude transcripts the Viewer
   indexes, and three with your input alone, under plain keys. The stage host
   holds orchard-client and harbor-ledger; the workstation holds every
   project. */
const ACTIVITY_REPOS = ["orchard-client", "lantern-api", "harbor-ledger", "kestrel-cli", "atlas-docs", "mesa-infra", "tidewater-app", "bramble-etl", "pebble-ui", "sorrel-bot"] as const;
type ActivityRepo = typeof ACTIVITY_REPOS[number];
type ActivityProject = ActivityRepo | "fennel-site" | "cobalt-auth" | "juniper-notes";
const ACTIVITY_STAGE_PROJECTS: readonly ActivityProject[] = ["orchard-client", "harbor-ledger"];
const ACTIVITY_BILLABLE: readonly ActivityProject[] = ["orchard-client", "harbor-ledger"];

function activityRepoDir(name: ActivityRepo): string {
  return path.join(HOME, "Projects", name);
}

/** One invented Claude conversation: a user record opens each turn and
    assistant records carry it to its end. */
function writeActivityTranscript(repo: ActivityRepo, file: number, turns: Array<{ start: number; minutes: number }>): void {
  if (!turns.length) return;
  const folder = path.join(HOME, ".claude/projects", projectSlug(activityRepoDir(repo)));
  fs.mkdirSync(folder, { recursive: true });
  const id = `${String(ACTIVITY_REPOS.indexOf(repo) + 1).padStart(4, "0")}${String(file).padStart(4, "0")}-2026-4000-8000-000000000000`;
  const lines: unknown[] = [];
  for (const [index, turn] of turns.entries()) {
    const stamp = (offsetMin: number) => new Date(turn.start + offsetMin * 60_000).toISOString();
    lines.push({ type: "user", uuid: `${id}-u${index}`, timestamp: stamp(0), cwd: activityRepoDir(repo), sessionId: id, message: { role: "user", content: `Next step ${index + 1} for ${repo}.` } });
    for (let minute = 2; minute < turn.minutes; minute += 17) {
      lines.push({ type: "assistant", uuid: `${id}-a${index}-${minute}`, timestamp: stamp(minute), cwd: activityRepoDir(repo), sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `Progress on ${repo}, minute ${minute}.` }] } });
    }
    lines.push({ type: "assistant", uuid: `${id}-a${index}-end`, timestamp: stamp(turn.minutes), cwd: activityRepoDir(repo), sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `Done with step ${index + 1}.` }] } });
  }
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

/** A stretch of your input: one input every six minutes, on the workstation
    (its request ledger, or its export for terminal prompts) or the stage host
    (its export). */
type ActivitySession = [at: string, minutes: number, project: ActivityProject, host: "ws" | "stage", surface?: "phone" | "tablet" | "terminal"];
/** A stretch an agent worked. */
type ActivityRun = [at: string, minutes: number, repo: ActivityRepo];
interface ActivityPlan { sessions: ActivitySession[]; runs: ActivityRun[] }

/* The last week, uneven on purpose: a full Friday, an empty weekend with
   night runs, a heavy Monday, a workday nobody asked anything while agents
   ran (the stage host unread, the day flagged), a Wednesday read on the
   workstation alone, and today. */
const ACTIVITY_PLANS: Record<"normal" | "heavy" | "flagged" | "lower" | "saturday" | "sunday" | "today", ActivityPlan> = {
  normal: {
    sessions: [["08:10", 95, "orchard-client", "stage"], ["09:50", 70, "lantern-api", "ws"], ["11:05", 45, "harbor-ledger", "ws", "phone"], ["13:00", 110, "orchard-client", "ws"], ["15:00", 55, "kestrel-cli", "ws"], ["16:00", 50, "lantern-api", "ws", "terminal"], ["17:05", 25, "fennel-site", "ws"]],
    runs: [["00:20", 200, "lantern-api"], ["08:10", 150, "orchard-client"], ["13:00", 130, "orchard-client"], ["15:00", 70, "kestrel-cli"], ["16:00", 60, "lantern-api"], ["21:30", 120, "tidewater-app"], ["22:00", 70, "bramble-etl"]],
  },
  heavy: {
    sessions: [["07:40", 110, "orchard-client", "stage"], ["09:35", 80, "harbor-ledger", "stage"], ["11:00", 60, "lantern-api", "ws"], ["12:10", 95, "orchard-client", "ws", "phone"], ["13:50", 85, "lantern-api", "ws"], ["15:20", 60, "atlas-docs", "ws"], ["16:25", 55, "mesa-infra", "ws"], ["17:25", 50, "kestrel-cli", "ws", "terminal"], ["18:20", 40, "harbor-ledger", "ws"], ["19:05", 30, "cobalt-auth", "ws"]],
    runs: [["01:00", 210, "lantern-api"], ["07:40", 180, "orchard-client"], ["09:35", 120, "harbor-ledger"], ["12:10", 110, "orchard-client"], ["13:50", 150, "lantern-api"], ["15:20", 110, "atlas-docs"], ["16:25", 40, "mesa-infra"], ["20:00", 150, "tidewater-app"], ["22:10", 60, "pebble-ui"]],
  },
  flagged: {
    sessions: [],
    runs: [["00:30", 135, "tidewater-app"], ["10:00", 55, "kestrel-cli"]],
  },
  lower: {
    sessions: [["09:55", 55, "lantern-api", "ws"], ["11:00", 45, "kestrel-cli", "ws"], ["14:00", 60, "lantern-api", "ws"], ["15:30", 70, "lantern-api", "ws", "terminal"], ["17:00", 30, "atlas-docs", "ws"]],
    runs: [["01:00", 95, "harbor-ledger"], ["11:00", 80, "kestrel-cli"], ["14:00", 110, "lantern-api"], ["18:00", 50, "lantern-api"], ["20:10", 30, "mesa-infra"], ["22:00", 35, "sorrel-bot"]],
  },
  saturday: { sessions: [], runs: [["01:00", 240, "lantern-api"], ["11:30", 50, "orchard-client"], ["19:00", 80, "tidewater-app"]] },
  sunday: { sessions: [], runs: [["02:00", 180, "atlas-docs"], ["14:10", 40, "bramble-etl"]] },
  today: {
    sessions: [["08:40", 35, "atlas-docs", "ws"], ["09:15", 100, "orchard-client", "stage"], ["11:00", 55, "harbor-ledger", "ws"], ["13:05", 90, "orchard-client", "ws"], ["14:40", 50, "juniper-notes", "ws"], ["16:00", 80, "lantern-api", "ws"], ["18:10", 60, "orchard-client", "stage"], ["19:40", 45, "lantern-api", "ws", "phone"]],
    runs: [["02:30", 100, "atlas-docs"], ["09:00", 180, "orchard-client"], ["13:05", 120, "orchard-client"], ["16:00", 95, "lantern-api"], ["20:30", 60, "pebble-ui"]],
  },
};

/** The month behind the week: workdays of two to five stretches over a
    long tail of projects, some watched agent runs, a night run now and then. */
function generatedActivityPlan(weekday: number, seed: number): ActivityPlan {
  let state = seed >>> 0;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const runs: ActivityRun[] = [];
  if (random() < 0.6) runs.push([hhmm(30 + Math.floor(random() * 120)), 60 + Math.floor(random() * 150), pick(["lantern-api", "tidewater-app", "atlas-docs", "sorrel-bot"] as const)]);
  if (weekday === 0 || weekday === 6) return { sessions: [], runs };
  const weighted: readonly ActivityProject[] = ["orchard-client", "orchard-client", "orchard-client", "lantern-api", "lantern-api", "tidewater-app", "tidewater-app", "harbor-ledger", "kestrel-cli", "kestrel-cli", "mesa-infra", "cobalt-auth", "fennel-site", "atlas-docs"];
  const sessions: ActivitySession[] = [];
  let at = 8 * 60 + Math.floor(random() * 60);
  const count = 2 + Math.floor(random() * 4);
  for (let index = 0; index < count && at < 19 * 60; index += 1) {
    const project = pick(weighted);
    const minutes = 40 + Math.floor(random() * 80);
    const host = ACTIVITY_STAGE_PROJECTS.includes(project) && random() < 0.5 ? "stage" : "ws";
    sessions.push([hhmm(at), minutes, project, host, host === "ws" && random() < 0.2 ? "phone" : undefined]);
    if ((ACTIVITY_REPOS as readonly string[]).includes(project) && random() < 0.8) runs.push([hhmm(at), minutes + Math.floor(random() * 60), project as ActivityRepo]);
    at += minutes + 10 + Math.floor(random() * 70);
  }
  return { sessions, runs };
}

interface ActivityReading {
  width: number;
  height: number;
  scrollWidth: number;
  layout: string;
  /** The bottom of the lowest card, and whether the document scrolls. */
  pageEnd: number;
  documentScrolls: boolean;
  chip: { state: string; text: string; height: number; width: number } | null;
  legend: { text: string; height: number; width: number; right: number; cardRight: number } | null;
  header: { height: number; bottom: number } | null;
  hero: string;
  agents: string;
  split: string;
  caps: Array<{ key: string; text: string }>;
  pairs: number;
  rhythmRows: number;
  cells: Record<string, number>;
  projects: Array<{ project: string; coverage: string | null; you: string; agents: string }>;
  foldedMore: string | null;
  truncated: string[];
  tooltip: { text: string; inside: boolean } | null;
  drawer: { flags: string[]; hosts: Array<{ host: string; complete: string | null }> } | null;
  /** The project the page is scoped to, as its chip reads, and the rows drawn chosen. */
  scope: string | null;
  selected: string[];
  /** Options in the open project picker, or null when it is closed. */
  pickerOptions: number | null;
  words: number;
  /* The narrow layout's own markers. */
  tiles: number;
  days: number;
}

function readActivity(): ActivityReading {
  const root = document.querySelector<HTMLElement>("[data-activity-page]")!;
  const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null;
  const chip = document.querySelector<HTMLElement>("[data-activity-trust]");
  const legend = document.querySelector<HTMLElement>("[data-activity-legend]");
  const rhythm = document.querySelector<HTMLElement>("[data-activity-rhythm]");
  const cards = ["[data-activity-main]", "[data-activity-rhythm]", "[data-activity-projects]"].map((selector) => rect(document.querySelector(selector))?.bottom ?? 0);
  const tooltip = document.querySelector<HTMLElement>("[data-activity-tooltip]");
  const tip = rect(tooltip);
  const drawer = document.querySelector<HTMLElement>("[data-activity-drawer]");
  const cells: Record<string, number> = {};
  for (const cell of document.querySelectorAll<SVGElement>("[data-activity-cell]")) cells[cell.dataset.activityCell ?? ""] = (cells[cell.dataset.activityCell ?? ""] ?? 0) + 1;
  const visible = (element: HTMLElement) => !element.closest(".sr-only") && element.getClientRects().length > 0;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    layout: root.dataset.activityLayout ?? "narrow",
    pageEnd: Math.max(...cards),
    documentScrolls: root.scrollHeight > root.clientHeight + 1,
    chip: chip ? { state: chip.dataset.activityTrust ?? "", text: chip.textContent ?? "", height: chip.getBoundingClientRect().height, width: chip.getBoundingClientRect().width } : null,
    legend: legend ? { text: legend.textContent ?? "", height: legend.getBoundingClientRect().height, width: legend.getBoundingClientRect().width, right: legend.getBoundingClientRect().right, cardRight: rhythm?.getBoundingClientRect().right ?? 0 } : null,
    header: rect(document.querySelector("header")) ? { height: rect(document.querySelector("header"))!.height, bottom: rect(document.querySelector("header"))!.bottom } : null,
    hero: document.querySelector("[data-activity-figure=you]")?.textContent ?? "",
    agents: document.querySelector("[data-activity-agents-value]")?.textContent ?? "",
    split: document.querySelector("[data-activity-split]")?.textContent ?? "",
    caps: Array.from(document.querySelectorAll<SVGElement>("[data-activity-cap]")).map((cap) => ({ key: cap.dataset.activityCap ?? "", text: cap.textContent ?? "" })),
    pairs: document.querySelectorAll("[data-activity-pair]").length,
    rhythmRows: document.querySelectorAll("[data-activity-rhythm-row]").length,
    cells,
    projects: Array.from(document.querySelectorAll<HTMLElement>("[data-activity-projects] [data-activity-project]")).map((row) => ({
      project: row.dataset.activityProject ?? "",
      coverage: row.dataset.coverage ?? null,
      you: row.querySelector("[data-activity-project-you]")?.textContent ?? "",
      agents: row.querySelector("[data-activity-project-agents]")?.textContent ?? "",
    })),
    foldedMore: document.querySelector<HTMLElement>("[data-activity-projects-more]")?.textContent ?? null,
    /* Text cut by its box: a truncated name, a label that ran out of room. */
    truncated: Array.from(root.querySelectorAll<HTMLElement>("span, div, button, h1, h2, a"))
      .filter((element) => visible(element) && element.children.length === 0 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
      .map((element) => element.textContent ?? ""),
    tooltip: tooltip && tip ? { text: tooltip.textContent ?? "", inside: tip.left >= 0 && tip.top >= 0 && tip.right <= window.innerWidth && tip.bottom <= window.innerHeight } : null,
    drawer: drawer ? {
      flags: Array.from(drawer.querySelectorAll("[data-activity-flag]")).map((flag) => flag.textContent ?? ""),
      hosts: Array.from(drawer.querySelectorAll<HTMLElement>("[data-activity-host]")).map((host) => ({ host: host.dataset.activityHost ?? "", complete: host.dataset.complete ?? null })),
    } : null,
    scope: document.querySelector("[data-activity-scope-chip]")?.textContent ?? null,
    selected: Array.from(document.querySelectorAll<HTMLElement>("[data-activity-project][data-selected=true]")).map((row) => row.dataset.activityProject ?? ""),
    pickerOptions: document.querySelector("[data-activity-picker=open]") ? document.querySelectorAll("[data-activity-picker-option]").length : null,
    words: (root.innerText.match(/\S+/g) ?? []).length,
    tiles: document.querySelectorAll("[data-activity-tile]").length,
    days: document.querySelectorAll("[data-activity-day]").length,
  };
}

async function activityMain(): Promise<void> {
  const { zonedDays } = await import("../src/lib/activity/method");
  const { exportLines, messageId, ledgerRowKey } = await import("../src/lib/activity/humanInput");
  for (const dir of [OUT_DIR, path.join(BASE, "git-home"), path.join(BASE, "tmp"), path.join(BASE, "tmux"), STATE_DIR, path.join(HOME, ".codex/sessions")]) fs.mkdirSync(dir, { recursive: true });
  for (const repo of ACTIVITY_REPOS) {
    const dir = activityRepoDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "--initial-branch=main", ".");
    fs.writeFileSync(path.join(dir, "README.md"), `# ${repo}\n`, "utf8");
    git(dir, "add", "README.md");
    git(dir, "commit", "-m", `${repo}: first commit`);
  }
  const now = Date.now();
  /* Index 29 is today; the last week is 23-29. */
  const days = zonedDays(now, 30, ACTIVITY_TZ);
  const TODAY = 29;
  const clock = (day: number, hhmm: string) => {
    const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
    return days[day]!.start + (hh * 60 + mm) * 60_000;
  };
  const weekday = (day: number) => new Date(`${days[day]!.date}T12:00:00Z`).getUTCDay();
  const workday = (day: number) => weekday(day) >= 1 && weekday(day) <= 5;
  /* The stage host was not read the two days before today. */
  const STAGE_UNREAD = [TODAY - 2, TODAY - 1];
  const heavyDay = [TODAY - 3, TODAY - 4, TODAY - 5, TODAY - 6].find(workday) ?? TODAY - 3;
  const planOf = (day: number): ActivityPlan => {
    if (day === TODAY) return ACTIVITY_PLANS.today;
    if (weekday(day) === 6 && day >= TODAY - 6) return ACTIVITY_PLANS.saturday;
    if (weekday(day) === 0 && day >= TODAY - 6) return ACTIVITY_PLANS.sunday;
    if (day === TODAY - 2) return ACTIVITY_PLANS.flagged;
    if (day === TODAY - 1) return ACTIVITY_PLANS.lower;
    if (day === heavyDay) return ACTIVITY_PLANS.heavy;
    if (day >= TODAY - 6) return ACTIVITY_PLANS.normal;
    return generatedActivityPlan(weekday(day), 7919 * (day + 1));
  };
  const plans = days.map((_, day) => planOf(day));
  const flagDay = TODAY - 2;

  /* Agent transcripts: one per project and day in the last week, one per
     project for the month behind it. */
  let transcripts = 0;
  for (const repo of ACTIVITY_REPOS) {
    const older: Array<{ start: number; minutes: number }> = [];
    for (const [day, plan] of plans.entries()) {
      const turns = plan.runs.filter(([, , name]) => name === repo)
        .map(([at, minutes]) => ({ start: clock(day, at), minutes }))
        .filter((turn) => turn.start + turn.minutes * 60_000 < now - 60_000);
      if (day < TODAY - 6) older.push(...turns);
      else if (turns.length) {
        writeActivityTranscript(repo, day, turns);
        transcripts += 1;
      }
    }
    if (older.length) {
      writeActivityTranscript(repo, 0, older);
      transcripts += 1;
    }
  }

  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { commit: captureCommit(), case: "activity", days: { first: days[0]!.date, today: days[TODAY]!.date, flagged: days[flagDay]!.date, heavy: days[heavyDay]!.date, stageUnread: STAGE_UNREAD.map((day) => days[day]!.date) } };
  const shots: string[] = [];
  const activityDir = path.join(STATE_DIR, "activity");
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    /* The project keys the scan gave the repositories: the ledger names the same ones. */
    const keys = await (async () => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const files = ((await (await fetch(`${baseUrl}/api/files`)).json()) as FilesPayload).files ?? [];
        const of = (repo: ActivityRepo) => files.find((file) => file.path?.includes(projectSlug(activityRepoDir(repo))))?.project;
        const found = Object.fromEntries(ACTIVITY_REPOS.map((repo) => [repo, of(repo)]));
        if (ACTIVITY_REPOS.every((repo) => found[repo])) return found as Record<ActivityRepo, string>;
        await Bun.sleep(2_000);
      }
      throw new Error("the seeded repositories never scanned");
    })();
    const keyOf = (project: ActivityProject) => (keys as Record<string, string>)[project] ?? project;

    /* Your input: the workstation's request ledger, its own export (terminal
       prompts), and the stage host's export. Nothing on the flagged day, and
       nothing from the stage host while it was not read. */
    fs.mkdirSync(activityDir, { recursive: true, mode: 0o700 });
    const kinds = ["message", "message", "answer", "message", "decision", "message", "voice"] as const;
    const ledger: Array<Record<string, unknown>> = [];
    const terminal: Parameters<typeof exportLines>[1][number][] = [];
    const stage: Parameters<typeof exportLines>[1][number][] = [];
    for (const [day, plan] of plans.entries()) {
      for (const [at, minutes, project, host, surface] of plan.sessions) {
        if (host === "stage" && STAGE_UNREAD.includes(day)) continue;
        for (let offset = 0, index = 0; offset <= minutes - 10; offset += 6, index += 1) {
          const time = clock(day, at) + offset * 60_000;
          if (time >= now - 60_000) break;
          const kind = kinds[index % kinds.length]!;
          if (host === "stage") stage.push({ ids: [messageId("codex", `stage-${day}-${at}-${offset}`)], at: time, host: "stage", source: "transcripts", project: keyOf(project), kind: "message", surface: "unknown", hash: null });
          else if (surface === "terminal") terminal.push({ ids: [messageId("claude-prompt", `workstation-${day}-${at}-${offset}`)], at: time, host: "workstation", source: "transcripts", project: keyOf(project), kind: "message", surface: "terminal", hash: null });
          else ledger.push({ v: 1, key: ledgerRowKey(`seed-${ledger.length}-${time}`), at: time, kind, surface: surface ?? "desktop", project: keyOf(project) });
        }
      }
    }
    for (const entry of ledger) {
      const file = path.join(activityDir, `requests-${new Date(entry.at as number).toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    }
    const endOfToday = days[TODAY]!.end;
    /* The workstation's export reads every store there, to the end of today. */
    const localDir = path.join(activityDir, "hosts", "workstation");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, "human-input.jsonl"), exportLines({
      host: "workstation", coveredFrom: days[0]!.start - 86_400_000, coveredUntil: endOfToday, exportedAt: now, records: terminal.length + 212,
      excluded: { "agent-message": 61, "stage-template": 9, recovery: 7, notification: 22, injected: 48, unmarked: 5, duplicate: 64 },
    }, terminal));
    /* The stage host's exports: the month up to the unread days, then today. */
    const stageDir = path.join(activityDir, "hosts", "stage");
    const writeStage = (spans: Array<{ name: string; from: number; until: number }>) => {
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true });
      for (const [index, span] of spans.entries()) {
        const inside = stage.filter((input) => input.at >= span.from && input.at < span.until);
        fs.writeFileSync(path.join(stageDir, `${span.name}.jsonl`), exportLines({
          host: "stage", coveredFrom: span.from, coveredUntil: span.until, exportedAt: Math.min(span.until, now), records: inside.length + 20,
          excluded: index ? {} : { "agent-message": 14, "stage-template": 6, notification: 4, unmarked: 9, attachment: 3, duplicate: 11 },
        }, inside));
      }
    };
    writeStage([{ name: "month", from: days[0]!.start - 86_400_000, until: days[STAGE_UNREAD[0]!]!.start }, { name: "today", from: days[TODAY]!.start, until: endOfToday }]);
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation", label: "Workstation" }, hosts: [{ id: "stage", label: "Stage host", projects: ACTIVITY_STAGE_PROJECTS.map(keyOf) }] }));
    fs.writeFileSync(path.join(activityDir, "settings.json"), JSON.stringify({ v: 1, tz: ACTIVITY_TZ, billable: ACTIVITY_BILLABLE.map(keyOf) }));

    /* Wait for the Viewer's own index to carry every seeded conversation. */
    const deadline = Date.now() + 420_000;
    let indexed = 0;
    while (Date.now() < deadline) {
      const body = await (await fetch(`${baseUrl}/api/activity?range=30d`)).json() as { coverage?: { agentIndex?: string }; projects?: Array<{ conversations: number }> };
      indexed = body.coverage?.agentIndex === "ok" ? (body.projects ?? []).reduce((sum, row) => sum + row.conversations, 0) : 0;
      if (indexed >= transcripts) break;
      await Bun.sleep(3_000);
    }
    must(indexed >= transcripts, `the agent axis carries ${indexed} of ${transcripts} seeded conversations`);
    report.api7d = await (await fetch(`${baseUrl}/api/activity?range=7d`)).json();

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const capture = async (name: string, query: string, options: { lang?: "en" | "uk"; phone?: boolean; size?: [number, number]; act?: (page: Page) => Promise<void> } = {}) => {
      const [width, height] = options.phone ? [390, 844] : options.size ?? [1440, 900];
      const context = await browser!.newContext({
        viewport: { width, height },
        reducedMotion: "reduce",
        ...(options.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      await context.addInitScript(seedInit);
      await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), options.lang ?? "en");
      const page = await context.newPage();
      await page.goto(`${baseUrl}/activity?${query}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector("[data-activity-loaded]", { timeout: 120_000 });
      await page.waitForTimeout(400);
      if (options.act) {
        await options.act(page);
        await page.waitForTimeout(300);
      }
      if (options.phone) {
        const first = await page.evaluate(readActivity);
        const full = await page.evaluate(() => document.querySelector<HTMLElement>("[data-activity-page]")!.scrollHeight);
        if (full > first.height) await page.setViewportSize({ width, height: Math.min(full, 7_000) });
        await page.waitForTimeout(300);
      }
      const reading = await page.evaluate(readActivity);
      const file = path.join(OUT_DIR, `activity-${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      report[name] = reading;
      must(reading.scrollWidth <= reading.width + 1, `${name}: the page runs ${reading.scrollWidth - reading.width}px sideways`);
      if (!options.phone) {
        must(reading.layout === "desktop", `${name}: the ${reading.layout} layout at ${width}px`);
        must(reading.chip !== null && reading.chip.height <= 30, `${name}: the trust chip is ${reading.chip?.height ?? "missing"}px tall`);
        must(reading.header !== null && reading.header.height <= 36, `${name}: the header is ${reading.header?.height ?? "missing"}px tall`);
        /* One line of 11 px text is about 16.5 px; two would be 33. */
        if (reading.legend) must(reading.legend.height <= 20 && reading.legend.right <= reading.legend.cardRight, `${name}: the Rhythm legend takes ${reading.legend.height}px, right edge ${reading.legend.right} of ${reading.legend.cardRight}`);
        const cut = reading.truncated.filter((text) => text.trim());
        must(cut.length === 0, `${name}: text cut by its box: ${JSON.stringify(cut)}`);
        if (reading.tooltip) must(reading.tooltip.inside, `${name}: the tooltip leaves the viewport`);
      }
      await context.close();
      return reading;
    };
    const date = (day: number) => days[day]!.date;
    const hoverPair = (day: number) => async (page: Page) => { await page.hover(`[data-activity-pair="${date(day)}"] rect[tabindex]`); };

    /* 7 days, en and uk, and at 1280 × 800 in uk. */
    const week = await capture("desktop-7d", "range=7d");
    must(week.pairs === 7 && week.rhythmRows === 7, `7d: ${week.pairs} day pairs and ${week.rhythmRows} rhythm rows`);
    must(week.pageEnd <= 900 && !week.documentScrolls, `7d: the page ends at ${week.pageEnd}px and scrolls ${week.documentScrolls}`);
    must(week.chip?.state === "lower", `7d: the chip reads ${week.chip?.state}`);
    const capOf = (reading: ActivityReading, day: number) => reading.caps.find((cap) => cap.key === date(day))?.text ?? "";
    if (workday(flagDay)) must(capOf(week, flagDay) === "?", `7d: the flagged ${date(flagDay)} reads ${capOf(week, flagDay)}`);
    must(capOf(week, TODAY - 1).startsWith("≥"), `7d: ${date(TODAY - 1)}, the stage host unread, reads ${capOf(week, TODAY - 1)}`);
    must(week.split.includes("unclear"), `7d: the Agents split has no unclear part: ${week.split}`);
    must(week.legend?.text.startsWith("You:") === true, `7d: the Rhythm legend reads ${week.legend?.text}`);
    for (const project of ACTIVITY_STAGE_PROJECTS) must(week.projects.find((row) => row.project === keyOf(project))?.coverage === "unknown", `7d: ${project}, held by the unread stage host, reads complete`);
    must(week.projects.find((row) => row.project === keyOf("lantern-api"))?.coverage === "complete", "7d: lantern-api reads a lower bound");
    await capture("desktop-7d-uk", "range=7d", { lang: "uk" });
    const narrow = await capture("desktop-1280x800-uk", "range=7d", { lang: "uk", size: [1280, 800] });
    must(!narrow.documentScrolls, `1280 × 800 uk: the page scrolls (ends at ${narrow.pageEnd}px)`);

    /* 30 days and Today. */
    const month = await capture("desktop-30d", "range=30d");
    must(month.pairs === 30 && month.rhythmRows === 30, `30d: ${month.pairs} pairs, ${month.rhythmRows} rows`);
    must(month.pageEnd <= 900, `30d: the page ends at ${month.pageEnd}px`);
    await capture("desktop-30d-uk", "range=30d", { lang: "uk" });
    const today = await capture("desktop-today", "range=today");
    must(today.rhythmRows === 0 && today.pairs === 24, `today: ${today.pairs} hour pairs, ${today.rhythmRows} rhythm rows`);

    /* The project detail, its breakdowns, the drawer and the tooltips. */
    await capture("desktop-projects", "range=7d", {
      act: async (page) => {
        await page.click(`[data-activity-project="${keyOf("harbor-ledger")}"] > button`);
        await page.waitForSelector("[data-activity-project-details]");
        await page.click("[data-activity-more-detail]");
        await page.waitForSelector("[data-activity-breakdowns]");
      },
    });
    const drawer = await capture("desktop-drawer", "range=7d", { act: async (page) => { await page.click("[data-activity-trust]"); await page.waitForSelector("[data-activity-drawer]"); } });
    must((drawer.drawer?.flags.length ?? 0) >= (workday(flagDay) ? 2 : 1), `drawer: ${JSON.stringify(drawer.drawer?.flags)}`);
    must(drawer.drawer?.hosts.find((host) => host.host === "stage")?.complete === "false", "drawer: the stage host reads complete");
    await capture("desktop-drawer-uk", "range=7d", { lang: "uk", act: async (page) => { await page.click("[data-activity-trust]"); await page.waitForSelector("[data-activity-drawer]"); } });
    await capture("desktop-hover-lower", "range=7d", { act: hoverPair(TODAY - 1) });
    await capture("desktop-hover-heavy", "range=7d", { act: hoverPair(heavyDay) });
    await capture("desktop-hover-flagged", "range=7d", { act: hoverPair(flagDay) });
    await capture("desktop-hover-cell", "range=7d", { act: async (page) => { await page.locator(`[data-activity-rhythm-row="${date(TODAY - 1)}"] rect[data-activity-cell]`).nth(18).hover(); } });
    await capture("desktop-hover-agents", "range=7d", { act: async (page) => { await page.hover("[data-activity-figure=agents]"); } });

    /* The phone keeps the prototype's layout. */
    const phone = await capture("phone-7d", "range=7d&view=days", { phone: true });
    must(phone.layout === "narrow" && phone.tiles === 4 && phone.days === 7, `phone: ${phone.layout} layout, ${phone.tiles} tiles, ${phone.days} days`);

    /* The whole page filtered to one project: orchard-client, billable and
       held by the stage host, which was not read for two days and whose
       agents nothing pulls. The server's scoped answer is the project's row
       in its unscoped one, and the page draws that answer. */
    const orchard = keyOf("orchard-client");
    type Figures = { humanMs: number; humanHours: number; requests: number; wallMs: number; supervisedMs: number; unattendedMs: number; agentHoursMs: number; coverage: unknown; agentCoverage: unknown };
    const figures = (value: Figures) => ({ humanMs: value.humanMs, humanHours: value.humanHours, requests: value.requests, wallMs: value.wallMs, supervisedMs: value.supervisedMs, unattendedMs: value.unattendedMs, agentHoursMs: value.agentHoursMs, coverage: value.coverage, agentCoverage: value.agentCoverage });
    const unscoped = await (await fetch(`${baseUrl}/api/activity?range=7d`)).json() as { projects: Array<Figures & { project: string | null; name: string | null }> };
    const scopedApi = await (await fetch(`${baseUrl}/api/activity?range=7d&project=${encodeURIComponent(orchard)}`)).json() as { scope: { project: string; name: string | null } | null; totals: Figures };
    const orchardRow = unscoped.projects.find((row) => row.project === orchard)!;
    report.projectFilterApi = { scope: scopedApi.scope, scoped: figures(scopedApi.totals), row: figures(orchardRow) };
    must(JSON.stringify(figures(scopedApi.totals)) === JSON.stringify(figures(orchardRow)), `project filter: the scoped totals ${JSON.stringify(figures(scopedApi.totals))} are not the row ${JSON.stringify(figures(orchardRow))}`);
    must(scopedApi.scope?.project === orchard, `project filter: the answer is scoped to ${JSON.stringify(scopedApi.scope)}`);
    const rowYou = week.projects.find((row) => row.project === orchard)?.you ?? "";
    const allProjects = await capture("desktop-project-all", "range=7d");
    must(allProjects.scope === null && allProjects.selected.length === 0, `all projects: scope ${allProjects.scope}, selected ${allProjects.selected.join(",")}`);
    const scoped = await capture("desktop-project-selected", `range=7d&project=${encodeURIComponent(orchard)}`);
    must(scoped.scope === "orchard-client" && scoped.selected.join() === orchard, `one project: chip ${scoped.scope}, selected ${scoped.selected.join(",")}`);
    must(rowYou !== "" && scoped.hero.replace(/\s/g, "").includes(rowYou.replace(/\s/g, "")), `one project: the hero "${scoped.hero}" is not the row's "${rowYou}"`);
    must(scoped.agents.startsWith("≥"), `one project: its agents, missing the stage host, read "${scoped.agents}"`);
    must(scoped.chip?.state === "lower", `one project: the chip reads ${scoped.chip?.state}`);
    /* The chosen row opens, so rows may fold into "+ N more": shown and folded hold every project. */
    const listed = (reading: ActivityReading) => reading.projects.length + Number(/\d+/.exec(reading.foldedMore ?? "")?.[0] ?? 0);
    must(listed(scoped) === listed(allProjects), `one project: the list holds ${listed(scoped)} projects, not ${listed(allProjects)}`);
    const picker = await capture("desktop-project-picker", "range=7d", { act: async (page) => { await page.click("[data-activity-picker-trigger]"); await page.waitForSelector("[data-activity-picker=open]"); } });
    must((picker.pickerOptions ?? 0) >= ACTIVITY_REPOS.length, `picker: ${picker.pickerOptions} options`);
    const scopedUk = await capture("desktop-project-selected-uk", `range=7d&project=${encodeURIComponent(orchard)}`, { lang: "uk" });
    must(scopedUk.scope === "orchard-client" && scopedUk.chip?.state === "lower", `one project uk: chip ${scopedUk.scope}, trust ${scopedUk.chip?.state}`);
    const phoneScoped = await capture("phone-project-selected", `range=7d&view=projects&project=${encodeURIComponent(orchard)}`, { phone: true });
    must(phoneScoped.layout === "narrow" && phoneScoped.scope === "orchard-client" && phoneScoped.tiles === 4, `phone, one project: ${phoneScoped.layout} layout, chip ${phoneScoped.scope}, ${phoneScoped.tiles} tiles`);

    /* The phone arrives by its board menus: ⋯ → Activity on the Overview and
       on a project's board. A sheet's close pops its history entry, and a pop
       asked for after the page load cancels the load, so the tap has to land
       on /activity rather than back on the board. */
    const phoneArrivals = [
      ...([[390, 844], [430, 932]] as const).flatMap(([width, height]) => (["en", "uk"] as const).flatMap((lang) => (["light", "dark"] as const).map((colorScheme) => ({ width, height, lang, colorScheme, from: "overview" as const })))),
      ...(["en", "uk"] as const).map((lang) => ({ width: 390, height: 844, lang, colorScheme: "light" as const, from: "project" as const })),
    ];
    const arrivals: Record<string, unknown> = {};
    /* An operator who has closed the first-run guide and its walk: they
       would stand over the board. */
    const onboarding = await fetch(`${baseUrl}/api/onboarding`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ dismissed: true, walk: "skipped" }) });
    must(onboarding.ok, `phone arrivals: the guide was not dismissed (${onboarding.status})`);
    for (const arrival of phoneArrivals) {
      const name = `phone-arrive-${arrival.from}-${arrival.width}-${arrival.lang}-${arrival.colorScheme}`;
      const context = await browser.newContext({ viewport: { width: arrival.width, height: arrival.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: arrival.colorScheme, reducedMotion: "reduce" });
      try {
        await context.addInitScript(seedInit);
        await context.addInitScript((value: string) => localStorage.setItem("llv_lang", value), arrival.lang);
        const page = await context.newPage();
        const board = `${baseUrl}/${arrival.from === "project" ? `#p=${encodeURIComponent(keyOf("lantern-api"))}` : ""}`;
        await page.goto(board, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 120_000 });
        await page.waitForTimeout(800);
        await page.tap('[data-mobile2-open="menu"]');
        const row = page.locator('[data-testid="menu-activity"]');
        if (!await row.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
          must(false, `${name}: the ⋯ menu has no Activity row`);
          continue;
        }
        await row.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        if (arrival.width === 390 && arrival.colorScheme === "light") {
          const menu = path.join(OUT_DIR, `activity-${name}-menu.png`);
          await page.screenshot({ path: menu });
          shots.push(menu);
        }
        await row.tap();
        if (!await page.waitForURL(/\/activity(\?|$)/, { timeout: 15_000 }).then(() => true, () => false)) {
          must(false, `${name}: ⋯ → Activity stayed on ${page.url().replace(baseUrl, "")}`);
          continue;
        }
        await page.waitForSelector("[data-activity-loaded]", { timeout: 120_000 });
        await page.waitForTimeout(400);
        const fit = () => page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("[data-activity-page]")!;
          const targets = [...document.querySelectorAll<HTMLElement>("[data-activity-back], [data-activity-option]")].map((element) => {
            const box = element.getBoundingClientRect();
            return { target: element.dataset.activityOption ?? "back", width: Math.round(box.width), height: Math.round(box.height) };
          });
          return { width: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, root.scrollWidth), layout: root.dataset.activityLayout ?? "narrow", targets };
        });
        const landed = await fit();
        const shot = path.join(OUT_DIR, `activity-${name}.png`);
        await page.screenshot({ path: shot });
        shots.push(shot);
        /* The range and view controls, by touch: 30 days, then Projects. */
        await page.tap('[data-activity-option="30d"]');
        await page.waitForSelector('[data-activity-loaded="30d"]', { timeout: 60_000 });
        await page.tap('[data-activity-option="projects"]');
        await page.waitForSelector("section[data-activity-projects]", { timeout: 10_000 });
        await page.waitForTimeout(400);
        const projects = await fit();
        const projectsShot = path.join(OUT_DIR, `activity-${name}-projects.png`);
        await page.screenshot({ path: projectsShot });
        shots.push(projectsShot);
        for (const reading of [landed, projects]) {
          must(reading.layout === "narrow", `${name}: the ${reading.layout} layout`);
          must(reading.scrollWidth <= reading.width + 1, `${name}: the page runs ${reading.scrollWidth - reading.width}px sideways`);
          for (const target of reading.targets) must(target.height >= 44 && target.width >= 44, `${name}: ${target.target} is ${target.width} × ${target.height}`);
        }
        must(landed.targets.length === 6, `${name}: ${landed.targets.length} of Board and five range/view controls`);
        /* Back to the board, the browser's way (a range or view switch
           replaces the page's entry) and the page's own. */
        await page.goBack({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 60_000 });
        await page.waitForTimeout(600);
        const backUrl = page.url().replace(baseUrl, "");
        const sheetAfterBack = await page.evaluate(() => document.querySelector('[data-mobile2-open="menu"]')?.getAttribute("aria-expanded") === "true");
        must(`${baseUrl}${backUrl}` === board && !sheetAfterBack, `${name}: Back lands on ${backUrl} with the menu ${sheetAfterBack ? "open" : "closed"}`);
        await page.goForward({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-activity-back]", { timeout: 60_000 });
        await page.tap("[data-activity-back]");
        const boardAgain = await page.waitForURL(`${baseUrl}/`, { timeout: 15_000 }).then(() => page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 60_000 })).then(() => true, () => false);
        must(boardAgain, `${name}: Board leads to ${page.url().replace(baseUrl, "")}`);
        arrivals[name] = { landed, projects, back: backUrl, sheetAfterBack, board: boardAgain };
      } finally {
        await context.close();
      }
    }
    report.phoneArrivals = arrivals;

    /* Today with the stage host unread from 09:00 to 12:00: only once those
       hours have passed, since an hour still to come draws nothing. */
    if (clock(TODAY, "12:00") <= now) {
      writeStage([
        { name: "month", from: days[0]!.start - 86_400_000, until: days[STAGE_UNREAD[0]!]!.start },
        { name: "today-morning", from: days[TODAY]!.start, until: clock(TODAY, "09:00") },
        { name: "today-afternoon", from: clock(TODAY, "12:00"), until: endOfToday },
      ]);
      const gap = await capture("desktop-today-gap", "range=today");
      must(gap.chip?.state === "lower", `today with a gap: the chip reads ${gap.chip?.state}`);
      await capture("desktop-today-gap-uk", "range=today", { lang: "uk" });
      const gapHour = await capture("desktop-today-gap-hover", "range=today", { act: async (page) => { await page.hover(`[data-activity-pair="${clock(TODAY, "10:00")}"] rect[tabindex]`); } });
      must(gapHour.tooltip?.text.includes("not read (Stage host)") === true, `today with a gap: the 10:00 tooltip reads ${gapHour.tooltip?.text}`);
    } else {
      report.todayGap = "not captured: today's 09:00-12:00 is still to come in the capture's zone";
    }

    /* None of your input read, agent time still read. */
    fs.rmSync(activityDir, { recursive: true, force: true });
    fs.mkdirSync(activityDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(activityDir, "hosts.json"), JSON.stringify({ v: 1, local: { id: "workstation", label: "Workstation" }, hosts: [{ id: "stage", label: "Stage host", projects: ACTIVITY_STAGE_PROJECTS.map(keyOf) }] }));
    const unread = await capture("desktop-unread-7d", "range=7d");
    must(unread.chip?.state === "none" && unread.chip.text === "Your time not read", `unread: the chip reads ${unread.chip?.state} "${unread.chip?.text}"`);
    /* The stage host's agents are not read either: agent time is at least what reads. */
    must(unread.hero.includes("Unknown") && unread.agents.startsWith("≥≈"), `unread: hero ${unread.hero}, agents ${unread.agents}`);
    must(!("supervised" in unread.cells) && !("unattended" in unread.cells) && !("you" in unread.cells), `unread: cells ${JSON.stringify(unread.cells)}`);
    const unreadUk = await capture("desktop-unread-1280x800-uk", "range=7d", { lang: "uk", size: [1280, 800] });
    must(unreadUk.chip?.text === "Ваш час не прочитано", `unread uk: the chip reads "${unreadUk.chip?.text}"`);

    /* A home with no data at all. */
    await stop(server);
    server = null;
    fs.rmSync(path.join(HOME, ".claude/projects"), { recursive: true, force: true });
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const empty = await capture("desktop-empty", "range=7d");
    /* This host's ingest reads it from its first pass on, so an empty home is
       read for a few minutes of the range: the chip says a lower bound once
       that pass has run, and your time still reads Unknown. */
    must(empty.chip?.state !== "ok" && empty.hero.includes("Unknown") && !/\b0 h\b/.test(empty.hero), `empty: chip ${empty.chip?.state}, hero ${empty.hero}`);
    must(empty.caps.every((cap) => cap.text === "?"), `empty: caps ${JSON.stringify(empty.caps)}`);
    await capture("desktop-empty-uk", "range=7d", { lang: "uk" });
    const emptyPhone = await capture("phone-empty", "range=30d&view=days", { phone: true });
    must(emptyPhone.days === 30, `empty phone: ${emptyPhone.days} day rows`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).split(HOME).join("$HOME"));
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "activity.json"), JSON.stringify(scrub(report), null, 2) + "\n", "utf8");
  const target = process.env.ACTIVITY_RENDER_DIR?.trim();
  if (target) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of [...shots, path.join(OUT_DIR, "activity.json")]) fs.copyFileSync(file, path.join(target, path.basename(file)));
  }
  console.log(`activity dashboard captures: ${OUT_DIR}${target ? ` (copied to ${target})` : ""}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`activity dashboard acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("activity dashboard acceptance passed at 1440 × 900, 1280 × 800 and 390 × 844.");
  }
}

/* ------------------------------------------------------------------------- */
/* BOARD_CAPTURE_CASE=lightbox (#2144)                                        */
/* ------------------------------------------------------------------------- */

const LIGHTBOX_COUNT = 26;
const LIGHTBOX_INBOX = new Set([1, 5, 10, 15, 20, 25]);
const LIGHTBOX_TOOL = new Set([3, 8, 13, 18, 23]);
const LIGHTBOX_TOPICS = ["sign-in form", "empty inbox", "settings panel", "billing table", "error toast", "search results", "profile card", "dark theme", "export dialog", "onboarding step"];
const LIGHTBOX_SHOTS = path.join(REPO_DIR, "shots");
const LIGHTBOX_INBOX_DIR = path.join(HOME, ".config", "agent-log-viewer", "inbox");
/** The picture the renders show: a markdown image in the middle of the walk. */
const LIGHTBOX_MID = 12;
type LightboxLayout = "dense" | "spread" | "unmounted";
/** Short answers between the last picture and the rest in the `unmounted` layout: more rows
    than the 1,500 a reader mounts, few enough bytes that every picture stays in the 768 KB
    tail the feed reads. */
const LIGHTBOX_FILLER = 1_600;
const LIGHTBOX_TAIL_BYTES = 768 * 1024;

/** Invented screens, painted by the browser: a coloured frame with its number large enough to read in a render. */
async function paintLightboxPictures(browser: Browser): Promise<string[]> {
  const page = await browser.newPage();
  const pictures = await page.evaluate(([count, topics]) => Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 750;
    const g = canvas.getContext("2d")!;
    const hue = (n * 47) % 360;
    g.fillStyle = `hsl(${hue} 45% 92%)`;
    g.fillRect(0, 0, 1200, 750);
    g.fillStyle = `hsl(${hue} 55% 36%)`;
    g.fillRect(0, 0, 1200, 96);
    g.fillStyle = "#ffffff";
    for (let column = 0; column < 3; column += 1) g.fillRect(60 + column * 370, 170, 330, 470);
    g.font = "bold 44px sans-serif";
    g.fillText(`Screen ${n} · ${topics[n % topics.length]}`, 48, 64);
    g.fillStyle = `hsl(${hue} 55% 36%)`;
    g.font = "bold 240px sans-serif";
    g.textAlign = "center";
    g.fillText(String(n), 600, 500);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), [LIGHTBOX_COUNT, LIGHTBOX_TOPICS] as const);
  await page.close();
  return pictures;
}

/** One conversation drawing the 26 pictures in order. `spread` puts a long note before each
    picture, so a picture sits screens away from the next and the feed's own lazy thumbnails
    reach only the last few; `dense` has them follow one another. `unmounted` puts 1,600 short
    answers before the last picture, so the feed mounts none of the other rows and the viewer's
    own elements are the only thing on the page that loads them. `urls` collects the URL each
    picture that loads over the network is asked for by. */
function writeLightboxConversation(id: string, layout: LightboxLayout, pictures: string[], urls: Map<string, number>): string {
  const base = { cwd: REPO_DIR, sessionId: id };
  const at = (n: number, s = 0) => `2100-01-03T10:${String(n).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
  const say = (uuid: string, n: number, text: string) => ({ type: "assistant", uuid, timestamp: at(n), ...base, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text }] } });
  const lines: unknown[] = [{ type: "user", uuid: `${id}-u0`, timestamp: at(0), ...base, message: { role: "user", content: "Walk me through the redesign screens, one by one." } }];
  for (let n = 1; n <= LIGHTBOX_COUNT; n += 1) {
    const topic = LIGHTBOX_TOPICS[n % LIGHTBOX_TOPICS.length]!;
    const bytes = Buffer.from(pictures[n - 1]!, "base64");
    if (layout === "spread") lines.push(say(`${id}-n${n}`, n, `Notes before screen ${n}:\n${Array.from({ length: 120 }, (_, line) => `- Note ${line + 1} on the ${topic}: spacing, contrast and copy checked.`).join("\n")}`));
    /* Bare answers: the session's own fields ride on the other rows, and the bytes they save keep every picture in the tail. */
    if (layout === "unmounted" && n === LIGHTBOX_COUNT) for (let i = 1; i <= LIGHTBOX_FILLER; i += 1) lines.push({ type: "assistant", uuid: `${id}-f${i}`, timestamp: at(n - 1, 30), message: { role: "assistant", content: [{ type: "text", text: `Checked item ${i}.` }] } });
    if (LIGHTBOX_INBOX.has(n)) {
      const name = `img-${String(n).padStart(2, "0")}-redesign.png`;
      fs.writeFileSync(path.join(LIGHTBOX_INBOX_DIR, name), bytes);
      lines.push({ type: "user", uuid: `${id}-u${n}`, timestamp: at(n), ...base, message: { role: "user", content: `Screen ${n}, the ${topic}:\n${path.join(LIGHTBOX_INBOX_DIR, name)}` } });
      urls.set(`/api/inbox?name=${encodeURIComponent(name)}`, n);
    } else if (LIGHTBOX_TOOL.has(n)) {
      const file = path.join(LIGHTBOX_SHOTS, `capture-${n}.png`);
      lines.push({ type: "assistant", uuid: `${id}-t${n}`, timestamp: at(n), ...base, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Read", input: { file_path: file } }] } });
      lines.push({ type: "user", uuid: `${id}-r${n}`, timestamp: at(n, 1), ...base, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: pictures[n - 1] } }] }] } });
    } else {
      const file = path.join(LIGHTBOX_SHOTS, `step-${n}.png`);
      fs.writeFileSync(file, bytes);
      lines.push(say(`${id}-a${n}`, n, `Screen ${n} is the ${topic}:\n![Screen ${n}, ${topic}](${file})`));
      urls.set(`/api/image?path=${encodeURIComponent(file)}`, n);
    }
  }
  lines.push({ type: "result", subtype: "success", uuid: `${id}-done`, timestamp: at(59), ...base, is_error: false, duration_ms: 1200, num_turns: 1, result: "All screens reviewed." });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const transcript = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  const size = fs.statSync(transcript).size;
  if (size > LIGHTBOX_TAIL_BYTES) throw new Error(`the ${layout} conversation is ${size} bytes; the feed would not read its first pictures`);
  return transcript;
}

function seedLightbox(pictures: string[]): { transcripts: Record<LightboxLayout, string>; urls: Map<string, number> } {
  for (const dir of [LIGHTBOX_SHOTS, LIGHTBOX_INBOX_DIR]) fs.mkdirSync(dir, { recursive: true });
  const urls = new Map<string, number>();
  /* Session ids assembled from parts, like the other seeded ones. */
  const id = (tail: string) => ["00000026", "0000", "4000", "8000", tail.padStart(12, "0")].join("-");
  const dense = writeLightboxConversation(id("cafe"), "dense", pictures, urls);
  const spread = writeLightboxConversation(id("beef"), "spread", pictures, urls);
  const unmounted = writeLightboxConversation(id("f00d"), "unmounted", pictures, urls);
  return { transcripts: { dense, spread, unmounted }, urls };
}

/** The open viewer, read in the page. */
function readLightbox() {
  const rect = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const dialog = document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]");
  const shown = dialog?.querySelector<HTMLImageElement>("img:not([hidden])") ?? null;
  /* An inline picture's source is its whole encoding; the record keeps its length. */
  const source = (img: Element | null) => { const src = img?.getAttribute("src") ?? null; return src?.startsWith("data:") ? `data:(${src.length} chars)` : src; };
  return {
    open: dialog !== null,
    position: dialog?.querySelector("[data-lightbox-position]")?.textContent ?? null,
    src: source(shown),
    loaded: Boolean(shown && shown.complete && shown.naturalWidth > 0),
    image: rect(shown),
    /* The picture area the backdrop fills around the picture. */
    area: rect(shown?.parentElement?.parentElement ?? null),
    mounted: dialog ? [...dialog.querySelectorAll("img")].map(source) : [],
    previous: rect(dialog?.querySelector("[data-lightbox-step=previous]") ?? null),
    next: rect(dialog?.querySelector("[data-lightbox-step=next]") ?? null),
    caption: dialog?.querySelector(".truncate")?.textContent ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

async function lightboxMain(): Promise<void> {
  seedHome();
  const failures: string[] = [];
  const must = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).split(encodeURIComponent(HOME)).join(encodeURIComponent("$HOME")).split(HOME).join("$HOME"));
  const report: Record<string, unknown> = { commit: captureCommit(), pictures: LIGHTBOX_COUNT };
  try {
    /* `gc()` lets the walk drop every picture nothing holds any more. */
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--expose-gc"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const { transcripts, urls } = seedLightbox(await paintLightboxPictures(browser));
    report.networkPictures = urls.size;
    server = startServer(port);
    await waitForServer(baseUrl, server);
    await waitForBoard(baseUrl, false);
    const dismissed = await fetch(`${baseUrl}/api/onboarding`, {
      method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ dismissed: true }),
    });
    must(dismissed.ok, `dismissing the setup guide answered ${dismissed.status}`);
    const lastSrc = `/api/image?path=${encodeURIComponent(path.join(LIGHTBOX_SHOTS, `step-${LIGHTBOX_COUNT}.png`))}`;
    const thumbnail = `[data-log-feed-scroller] img[src="${lastSrc}"]`;
    const viewports = [
      { device: "desktop", phone: false, options: { viewport: { width: 1440, height: 900 } } },
      { device: "phone", phone: true, options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    ] as const;
    /* A phone's reader keeps only its last 1,000 lines while it follows the tail, fewer than
       the 1,500 rows it mounts, so there every picture the feed holds has a mounted row. */
    for (const { device, phone, options } of viewports) for (const layout of (phone ? ["dense", "spread"] : ["dense", "spread", "unmounted"]) as LightboxLayout[]) {
      const tag = `${device}-${layout}`;
      const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
      await context.addInitScript(seedInit);
      const page = await context.newPage();
      /* Every image request the page puts on the network, attributed to the
         phase it happened in. A picture the page already holds is served from
         its own memory and never reaches the network. */
      let phase = "feed";
      const requests: { phase: string; picture: number | null; url: string }[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (!/^\/api\/(image|inbox|artifact)$/.test(url.pathname)) return;
        const local = url.pathname + url.search;
        requests.push({ phase, picture: urls.get(local) ?? null, url: local });
      });
      await page.goto(`${baseUrl}/#f=${encodeURIComponent(transcripts[layout])}`);
      await page.waitForSelector(thumbnail, { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
      const feedPictures = requests.map((request) => request.picture);
      /* The pictures a mounted feed row draws. */
      const heldByFeed = (await page.evaluate(() => [...document.querySelectorAll("[data-log-feed-scroller] img")].map((img) => img.getAttribute("src") ?? "")))
        .filter((src) => /^(\/api\/(image|inbox|artifact)\?|data:image\/)/.test(src))
        .map((src) => (src.startsWith("data:") ? "inline" : urls.get(src) ?? src));
      if (layout === "unmounted") must(JSON.stringify(heldByFeed) === JSON.stringify([LIGHTBOX_COUNT]), `${tag}: the feed's mounted rows draw pictures ${JSON.stringify(heldByFeed)}`);
      const read = () => page.evaluate(readLightbox);
      const settle = async () => {
        await page.waitForFunction(() => {
          const img = document.querySelector<HTMLImageElement>("[role=dialog] img:not([hidden])");
          return Boolean(img && img.complete && img.naturalWidth > 0);
        }, undefined, { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(250);
      };

      /* Open the newest picture, walk to the first, one step past it, and back. */
      phase = "open";
      await page.locator(thumbnail).click();
      await settle();
      const opened = await read();
      const openPictures = requests.filter((request) => request.phase === "open").map((request) => request.picture);
      must(opened.open && opened.position === `${LIGHTBOX_COUNT} / ${LIGHTBOX_COUNT}`, `${tag}: the viewer opened at «${opened.position}»`);
      must(opened.next === null && opened.previous !== null, `${tag}: at the last picture the edge buttons are ${JSON.stringify({ previous: opened.previous, next: opened.next })}`);
      for (const picture of openPictures) must(picture !== null && picture >= LIGHTBOX_COUNT - 1, `${tag}: opening the last picture asked for picture ${picture}`);
      const walk: { position: string | null; loaded: boolean; mounted: number; requested: (number | null)[] }[] = [];
      const stepOnce = async (key: "ArrowLeft" | "ArrowRight", label: string) => {
        phase = label;
        const before = requests.length;
        await page.keyboard.press(key);
        await settle();
        const reading = await read();
        walk.push({ position: reading.position, loaded: reading.loaded, mounted: reading.mounted.length, requested: requests.slice(before).map((request) => request.picture) });
        return reading;
      };
      let mid: Awaited<ReturnType<typeof read>> | null = null;
      for (let n = LIGHTBOX_COUNT - 1; n >= 1; n -= 1) {
        const reading = await stepOnce("ArrowLeft", `left-to-${n}`);
        must(reading.position === `${n} / ${LIGHTBOX_COUNT}`, `${tag}: ← to ${n} shows «${reading.position}»`);
        must(reading.loaded, `${tag}: picture ${n} did not load`);
        must(reading.mounted.length >= (n === 1 ? 2 : 3), `${tag}: at ${n} the viewer holds ${reading.mounted.length} pictures`);
        /* Only the neighbour the move brought into reach may load. */
        for (const picture of walk.at(-1)!.requested) must(picture === n - 1, `${tag}: at ${n} the page asked for picture ${picture}`);
        if (n === LIGHTBOX_MID) {
          mid = reading;
          if (layout === "dense") await page.screenshot({ path: path.join(OUT_DIR, `lightbox-${device}-mid-gallery.png`) });
        }
      }
      const pastFirst = await stepOnce("ArrowLeft", "left-past-first");
      must(pastFirst.position === `1 / ${LIGHTBOX_COUNT}` && pastFirst.previous === null, `${tag}: ← at the first picture shows «${pastFirst.position}»`);
      /* Nothing but the viewer holds pictures 1 to 25 here. Collect garbage and outlast
         /api/image's 60 s freshness, so a picture the viewer let go of can only come back over
         the network (/api/inbox answers no-store). */
      let collected: boolean | null = null;
      if (layout === "unmounted") {
        const collect = () => page.evaluate(() => {
          const gc = (globalThis as { gc?: () => void }).gc;
          if (gc) { gc(); gc(); }
          return Boolean(gc);
        });
        collected = await collect();
        await page.waitForTimeout(61_000);
        collected = (await collect()) && collected;
        must(collected, `${tag}: the page could not collect garbage`);
      }
      const backFrom = requests.length;
      for (let n = 2; n <= LIGHTBOX_COUNT; n += 1) await stepOnce("ArrowRight", `right-to-${n}`);
      const pastLast = await stepOnce("ArrowRight", "right-past-last");
      must(pastLast.position === `${LIGHTBOX_COUNT} / ${LIGHTBOX_COUNT}` && pastLast.next === null, `${tag}: → at the last picture shows «${pastLast.position}»`);
      const backRequests = requests.length - backFrom;
      must(backRequests === 0, `${tag}: walking back over reached pictures made ${backRequests} image requests`);
      const perUrl = new Map<string, number>();
      for (const request of requests) perUrl.set(request.url, (perUrl.get(request.url) ?? 0) + 1);
      const refetched = [...perUrl].filter(([, count]) => count > 1);
      must(refetched.length === 0, `${tag}: fetched more than once: ${JSON.stringify(refetched)}`);
      must(mid !== null && mid.previous !== null && mid.next !== null, `${tag}: mid-gallery the edge buttons are ${JSON.stringify(mid && { previous: mid.previous, next: mid.next })}`);
      if (mid) for (const [name, box] of [["previous", mid.previous], ["next", mid.next]] as const) {
        must(Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.w <= mid.viewport.w && box.y + box.h <= mid.viewport.h), `${tag}: the ${name} button sits at ${JSON.stringify(box)}`);
        if (phone) must((box?.h ?? 0) >= 44 && (box?.w ?? 0) >= 44, `${tag}: the ${name} button is ${box?.w}×${box?.h}px`);
      }

      /* The backdrop: a click on the picture keeps it, a drag that ends off
         the picture keeps it, a still click or tap on the dimmed area closes it.
         The drag ends below the picture and carries it down, so the closing
         click lands above it. */
      let backdrop: Record<string, boolean | null> | null = null;
      if (layout === "dense") {
        const center = (box: { x: number; y: number; w: number; h: number }) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
        const now = await read();
        const picture = center(now.image!);
        const below = { x: Math.round(now.area!.x + now.area!.w / 2), y: now.area!.y + now.area!.h - 8 };
        const above = { x: below.x, y: now.area!.y + 8 };
        must(below.y > now.image!.y + now.image!.h && above.y < now.image!.y, `${tag}: no backdrop above and below the picture ${JSON.stringify({ image: now.image, area: now.area })}`);
        if (phone) await page.touchscreen.tap(picture.x, picture.y);
        else await page.mouse.click(picture.x, picture.y);
        await page.waitForTimeout(250);
        const afterPictureClick = (await read()).open;
        must(afterPictureClick, `${tag}: a ${phone ? "tap" : "click"} on the picture closed the viewer`);
        let afterPan: boolean | null = null;
        if (!phone) {
          await page.mouse.move(picture.x, picture.y);
          await page.mouse.down();
          await page.mouse.move(below.x - 40, below.y - 30, { steps: 8 });
          await page.mouse.move(below.x, below.y, { steps: 4 });
          await page.mouse.up();
          await page.waitForTimeout(250);
          afterPan = (await read()).open;
          must(afterPan, `${tag}: a pan that ended off the picture closed the viewer`);
        }
        if (phone) await page.touchscreen.tap(above.x, above.y);
        else await page.mouse.click(above.x, above.y);
        await page.waitForTimeout(250);
        const afterBackdrop = (await read()).open;
        must(!afterBackdrop, `${tag}: a ${phone ? "tap" : "click"} on the backdrop left the viewer open`);
        /* A viewer the backdrop failed to close would cover the thumbnail. */
        if (afterBackdrop) await page.keyboard.press("Escape");
        await page.locator(thumbnail).click();
        await settle();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        const afterEscape = (await read()).open;
        must(!afterEscape, `${tag}: Escape left the viewer open`);
        backdrop = { afterPictureClick, afterPan, afterBackdrop, afterEscape };
      }

      const viewing = requests.filter((request) => request.phase !== "feed");
      report[tag] = {
        requests: {
          feed: feedPictures.length,
          open: openPictures.length,
          walkingLeft: viewing.filter((request) => request.phase.startsWith("left")).length,
          walkingBack: backRequests,
          total: requests.length,
          distinctUrls: perUrl.size,
          fetchedTwice: refetched.length,
        },
        feedPictures: [...feedPictures].sort((a, b) => (a ?? 0) - (b ?? 0)),
        heldByFeed,
        collectedGarbageBeforeWalkingBack: collected,
        openPictures,
        walk,
        opened,
        midGallery: mid,
        backdrop,
        log: requests,
      };
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(server);
  }
  report.failures = failures;
  fs.writeFileSync(path.join(OUT_DIR, "lightbox.json"), JSON.stringify(scrub(report), null, 2) + "\n", "utf8");
  console.log(`lightbox measurements: ${path.join(OUT_DIR, "lightbox.json")}`);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`lightbox acceptance FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  } else {
    console.log("lightbox acceptance passed at 1440 × 900 and 390 × 844.");
  }
}

/* BOARD_CAPTURE_CASE=header runs the header bar's case (#1801), account-removal the removal dialog's (#1857), activity the activity dashboard's, instead of the camera probes. */
if (process.env.BOARD_CAPTURE_CASE === "header") await headerMain();
else if (process.env.BOARD_CAPTURE_CASE === "activity") await activityMain();
else if (process.env.BOARD_CAPTURE_CASE === "lightbox") await lightboxMain();
else if (process.env.BOARD_CAPTURE_CASE === "resources") await resourcesMain();
else if (process.env.BOARD_CAPTURE_CASE === "file-preview") await filePreviewMain();
else if (process.env.BOARD_CAPTURE_CASE === "account-removal") await accountRemovalMain();
else if ((SEAT_CASES as readonly string[]).includes(process.env.BOARD_CAPTURE_CASE ?? "")) await seatsMain(process.env.BOARD_CAPTURE_CASE as SeatCase);
else await main();
