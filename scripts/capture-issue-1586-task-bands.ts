/**
 * Rendered verification of the task-centered board (#1586) in a real browser:
 *
 *   bun scripts/capture-issue-1586-task-bands.ts
 *
 * Serves the production build against a purpose-built synthetic home under the
 * temp root (never the operator's live state, no real home path in any frame),
 * seeds one project with invented tasks and Claude transcripts, then drives the
 * real board with the locally cached Chromium.
 *
 * Two fixture densities × three desktop viewports × six zoom frames × two
 * themes, plus two phone viewports and a dock-open capture. Every frame lands
 * in <out>/ for direct inspection. Alongside the frames the run measures, and
 * asserts, what the screenshots alone cannot prove:
 *
 *   - one full-width band per task, stacked, never side by side;
 *   - the working task ranks above idle tasks;
 *   - the selected conversation's header keeps its screen position through
 *     wheel zoom, toolbar zoom, the overview/near crossings and a viewport
 *     resize (≤ 2 px per step, ≤ 4 px over 20 forward/reverse cycles);
 *   - the band-local «+ Agent» is reachable in the densest band.
 *
 * The measurements are written as evidence JSON (relative paths only) so the
 * PR can carry them; the PNGs stay local because the publication gate accepts
 * only deterministic, reproducible rasters.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const BASE = createCaptureDirectory({
  envName: "BANDS_CAPTURE_DIR",
  prefix: "llv-issue-1586",
  raw: process.env.BANDS_CAPTURE_DIR,
  repoRoot: path.resolve(import.meta.dir, ".."),
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "harbor");
const EVIDENCE_OUT = process.env.BANDS_EVIDENCE_OUT ?? path.resolve(import.meta.dir, "../docs/design/task-centered-board/evidence.json");

type Density = "six" | "dense";
const DENSITY = (process.env.BANDS_DENSITY as Density | undefined) ?? "dense";
const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];
const PHONES = [
  { name: "375x812", width: 375, height: 812 },
  { name: "390x844", width: 390, height: 844 },
];
const ZOOMS = [0.07, 0.21, 0.22, 0.4, 0.58, 1];
const THEMES: ("light" | "dark")[] = ["light", "dark"];

const TASK_TITLES = [
  "Restore search results", "Simplify export settings", "Repair old links", "Trim the launch copy", "Group directory projects",
  "Shrink the replay envelope", "Seat the successor cleanly", "Stabilize the board camera", "Retire the legacy transport", "Document the handoff",
  "Verify the review loop", "Collapse quiet branches", "Audit the accounts dialog", "Speed up the catalog", "Flatten the minimap",
  "Rename stage panes", "Fold orchestrator tools", "Align pipeline zoom", "Install session snapshots", "Fence rejected receipts",
  "Recover designated successors", "Make handoffs durable", "Reduce polling churn", "Check the mobile focus view", "Publish the design notes",
];
const AGENT_ROLES = ["Investigate", "Implement", "Review", "Verify", "Document", "Measure", "Refactor", "Check examples"];

/** Claude's own project folder name: the cwd with every separator flattened. */
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: path.join(BASE, "git-home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
};

interface SeededConversation { path: string; title: string; busy: boolean }
interface SeededTask { id: string; title: string; conversations: SeededConversation[]; status: "assigned" | "done" | "inbox" }

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Six tasks / twelve conversations, or twenty-five tasks / one hundred
    conversations including a 24-member band and a conversation shared by two
    tasks. Working evidence comes from the transcript tail: an open user turn
    is busy, a closing assistant message is idle. */
function seedHome(density: Density): { tasks: SeededTask[]; conversations: SeededConversation[] } {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "git-home"), { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmux"), { recursive: true });
  const state = path.join(HOME, ".config/agent-log-viewer/state");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  git(REPO_DIR, "init", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# harbor\n", "utf8");
  git(REPO_DIR, "add", "README.md");
  git(REPO_DIR, "commit", "-m", "harbor: first commit");

  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const taskCount = density === "six" ? 6 : 25;
  const sizes = density === "six" ? [3, 2, 2, 2, 2, 1] : [24, 8, 6, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1];
  const conversations: SeededConversation[] = [];
  const tasks: SeededTask[] = [];
  let serial = 0;
  for (let index = 0; index < taskCount; index += 1) {
    const members: SeededConversation[] = [];
    for (let slot = 0; slot < sizes[index]!; slot += 1) {
      serial += 1;
      const id = `${String(serial).padStart(8, "0")}-1586-4000-8000-000000000000`;
      const role = AGENT_ROLES[slot % AGENT_ROLES.length]!;
      const title = `${role}: ${TASK_TITLES[index]!.toLowerCase()}`;
      /* Tasks 0, 1 and 4 have working agents (the first two members); the
         rest are idle, so the ranking has something to prove. */
      const busy = (index === 0 || index === 1 || index === 4) && slot < 2;
      const stamp = `2100-01-02T1${index % 9}:${String(10 + slot).padStart(2, "0")}:05.000Z`;
      const lines: unknown[] = [
        { type: "user", uuid: `${id}-u1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "user", content: `${title}.` } },
        { type: "assistant", uuid: `${id}-a1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `Working on it: ${title}.` }] } },
      ];
      /* A closed Claude turn ends on a `result` record; an open one ends on the
         operator's next message with no answer yet. */
      if (busy) lines.push({ type: "user", uuid: `${id}-u2`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, message: { role: "user", content: "Continue with the next step." } });
      else lines.push({ type: "result", subtype: "success", uuid: `${id}-r1`, timestamp: stamp, cwd: REPO_DIR, sessionId: id, is_error: false, duration_ms: 1200, num_turns: 1, result: `Working on it: ${title}.` });
      const file = path.join(folder, `${id}.jsonl`);
      fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
      members.push({ path: file, title, busy });
    }
    conversations.push(...members);
    tasks.push({ id: `task-1586-${String(index).padStart(2, "0")}`, title: TASK_TITLES[index]!, conversations: members, status: index === taskCount - 1 ? "done" : "assigned" });
  }
  /* One conversation linked to two tasks: the first member of task 1 also
     belongs to task 2 (a mirror in the later-created band). */
  tasks[2]!.conversations.push(tasks[1]!.conversations[0]!);
  const rows = tasks.map((task, index) => ({
    id: task.id,
    project: "",
    status: task.status,
    text: `${task.title}\nInvented fixture task ${index + 1} for the band capture.`,
    placement: "unplaced",
    assignments: task.conversations.map((conversation) => ({ path: conversation.path, conversationId: null, panePid: null, state: "delivered", error: null, at: `2100-01-02T10:00:${String(index).padStart(2, "0")}.000Z` })),
    createdAt: `2100-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2100-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  fs.writeFileSync(path.join(state, "tasks.pending.json"), JSON.stringify({ tasks: rows }, null, 2), "utf8");
  return { tasks, conversations };
}

function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const config = path.join(HOME, ".config");
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME,
    TMPDIR: path.join(BASE, "tmp"),
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

const seedInit = () => {
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
  localStorage.setItem("llvSchemeMode", "select");
};

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/files`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

/** The tasks file is written with the project key the scanner derived, which
    the fixture cannot know before the server names it. */
async function bindTasksToProject(baseUrl: string, state: string): Promise<{ projectId: string; paths: string[] }> {
  const response = await fetch(`${baseUrl}/api/files`);
  const body = (await response.json()) as { files?: { path: string; project: string }[] } | { path: string; project: string }[];
  const files = Array.isArray(body) ? body : body.files ?? [];
  must(files.length > 0, "the scanner listed no conversations");
  const projectId = files[0]!.project;
  const pending = JSON.parse(fs.readFileSync(path.join(state, "tasks.pending.json"), "utf8")) as { tasks: { project: string }[] };
  for (const task of pending.tasks) task.project = projectId;
  fs.writeFileSync(path.join(state, "tasks.json"), JSON.stringify(pending, null, 2) + "\n", "utf8");
  return { projectId, paths: files.map((file) => file.path) };
}

interface Rect { x: number; y: number; width: number; height: number }
interface BandRecord { id: string; task: string | null; working: number; rect: Rect }

const bandRects = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.querySelector('[aria-label^="Agent board"]')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>("[data-scheme-band]")).map((band) => {
      const rect = band.getBoundingClientRect();
      return {
        id: band.getAttribute("data-scheme-band")!,
        task: band.getAttribute("data-scheme-band-task"),
        working: Number(band.getAttribute("data-scheme-band-working") ?? 0),
        rect: { x: rect.x - viewport.x, y: rect.y - viewport.y, width: rect.width, height: rect.height },
      } satisfies BandRecord;
    }).sort((a, b) => a.rect.y - b.rect.y);
  });

const cameraZoom = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.querySelector('[aria-label^="Agent board"]')!;
    const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
    return parseFloat(/scale\(([\d.e+-]+)\)/.exec(world.style.transform)![1]!);
  });

/** Plain wheel pans; used to bring the first band under the toolbar after a
    zoom so every frame shows content rather than the pointer-anchored gap. */
async function panToFirstBand(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bands = await bandRects(page);
    if (!bands.length) return;
    const delta = bands[0]!.rect.y - 72;
    if (Math.abs(delta) < 2) return;
    await page.evaluate((deltaY) => {
      const viewport = document.querySelector('[aria-label^="Agent board"]')! as HTMLElement;
      const box = viewport.getBoundingClientRect();
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: false, bubbles: true, cancelable: true, clientX: box.x + box.width * 0.6, clientY: box.y + box.height * 0.6 }));
    }, delta);
    await page.waitForTimeout(120);
  }
}

/** Ctrl+wheel exactly like a trackpad pinch: the camera's own handler reads it. */
async function zoomTo(page: Page, target: number): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await cameraZoom(page);
    if (Math.abs(current - target) / target < 0.005) return current;
    const deltaY = -Math.log(target / current) / 0.0022;
    await page.evaluate((delta) => {
      const viewport = document.querySelector('[aria-label^="Agent board"]')! as HTMLElement;
      const box = viewport.getBoundingClientRect();
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true, clientX: box.x + box.width * 0.6, clientY: box.y + box.height * 0.6 }));
    }, deltaY);
    await page.waitForTimeout(120);
  }
  return cameraZoom(page);
}

/** Live screen rect of the selected shell. A dormant (hidden) shell reports a
    zero rect and stale attributes, so it is refused rather than measured. */
const selectedHeader = (page: Page, nodePath: string) =>
  page.evaluate((target) => {
    const viewport = document.querySelector('[aria-label^="Agent board"]')!.getBoundingClientRect();
    const shell = document.querySelector<HTMLElement>(`[data-scheme-node="${target}"]`);
    if (!shell) return null;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x - viewport.x, y: rect.y - viewport.y, w: rect.width, h: rect.height, presentation: shell.getAttribute("data-scheme-node-presentation") };
  }, nodePath);

async function selectNode(page: Page, nodePath: string): Promise<void> {
  await page.evaluate((target) => {
    const shell = document.querySelector<HTMLElement>(`[data-scheme-node="${target}"]`)!;
    shell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 9, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 9, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 }));
  }, nodePath);
  await page.waitForTimeout(150);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.BANDS_CAPTURE_PORT, 3059, "BANDS_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  const seeded = seedHome(DENSITY);
  console.log(`screenshots: ${OUT_DIR}`);

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const browser = await chromium.launch({ headless: true });
  const evidence: Record<string, unknown> = { density: DENSITY, tasks: seeded.tasks.length, conversations: seeded.conversations.length, frames: [] as unknown[], anchor: [] as unknown[] };
  try {
    await waitForServer(baseUrl, server);
    const state = path.join(HOME, ".config/agent-log-viewer/state");
    const { projectId, paths } = await bindTasksToProject(baseUrl, state);
    must(paths.length === seeded.conversations.length, `scanner listed ${paths.length} of ${seeded.conversations.length} transcripts`);
    /* The scanner picks the tasks file up on its next poll. */
    await Bun.sleep(1500);
    const scannedPath = (seededPath: string) => paths.find((candidate) => candidate === seededPath || candidate.endsWith(path.basename(seededPath))) ?? seededPath;
    const denseTask = seeded.tasks[0]!;
    /* Second row of the densest (top) band: on screen at 58% after the pan,
       so the measured shell is live, never a dormant hidden one. */
    const anchorNode = scannedPath(seeded.tasks[0]!.conversations[3]!.path);

    const frames = evidence.frames as unknown[];
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme });
        await page.addInitScript(seedInit);
        await page.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "networkidle", timeout: 90_000 });
        await page.waitForSelector("[data-scheme-band]", { timeout: 60_000 });
        await page.waitForTimeout(600);
        for (const zoom of ZOOMS) {
          const actual = await zoomTo(page, zoom);
          await panToFirstBand(page);
          await page.waitForTimeout(250);
          const bands = await bandRects(page);
          const file = `${DENSITY}-${theme}-${viewport.name}-z${Math.round(zoom * 100)}.png`;
          await page.screenshot({ path: path.join(OUT_DIR, file) });
          /* Full width, stacked, never side by side; working tasks first. */
          const canvas = await page.evaluate(() => { const box = document.querySelector('[aria-label^="Agent board"]')!.getBoundingClientRect(); return { width: box.width, height: box.height }; });
          for (let index = 1; index < bands.length; index += 1) {
            must(bands[index]!.rect.y >= bands[index - 1]!.rect.y + bands[index - 1]!.rect.height - 0.5, `${file}: bands overlap vertically`);
            must(Math.abs(bands[index]!.rect.x - bands[0]!.rect.x) < 0.5 && Math.abs(bands[index]!.rect.width - bands[0]!.rect.width) < 0.5, `${file}: bands are not the same width`);
            must(bands[index]!.working <= bands[index - 1]!.working, `${file}: an idle band ranks above a working one`);
          }
          const gutter = canvas.width < 1024 ? 16 : 24;
          must(Math.abs(bands[0]!.rect.width - (canvas.width - 2 * gutter)) < 1, `${file}: band width ${bands[0]!.rect.width} is not the available width ${canvas.width - 2 * gutter}`);
          frames.push({ file, theme, viewport: viewport.name, zoom: actual, availableWidth: canvas.width, bands: bands.length, firstBands: bands.slice(0, 4) });
        }
        /* Anchor proof at 1440 light only; the geometry is viewport-independent. */
        if (viewport.name === "1440x900" && theme === "light") {
          await zoomTo(page, 0.58);
          await panToFirstBand(page);
          await page.waitForTimeout(200);
          await selectNode(page, anchorNode);
          const start = await selectedHeader(page, anchorNode);
          must(start !== null, "anchor node is not visible on the board");
          must(start!.presentation === "native", `anchor starts as ${start!.presentation}, expected the selected reader to be native at 58%`);
          /* Both axes hold at every step, mode crossings and resizes included. */
          const record = (label: string, after: { x: number; y: number; w: number; h: number; presentation: string | null } | null, zoom: number) => {
            must(after !== null, `${label}: anchor node vanished`);
            const drift = Math.hypot(after!.x - start!.x, after!.y - start!.y);
            (evidence.anchor as unknown[]).push({ label, zoom, drift: Number(drift.toFixed(3)), presentation: after!.presentation, size: { w: Number(after!.w.toFixed(1)), h: Number(after!.h.toFixed(1)) }, before: { x: start!.x, y: start!.y }, after: { x: after!.x, y: after!.y } });
            must(drift <= 2, `${label}: selected header drifted ${drift.toFixed(2)}px`);
          };
          const seen = new Set<string>();
          for (const zoom of [0.4, 0.22, 0.21, 0.07, 0.24, 0.58, 0.81, 0.84, 1, 0.58]) {
            const actual = await zoomTo(page, zoom);
            await page.waitForTimeout(200);
            const after = await selectedHeader(page, anchorNode);
            if (after) seen.add(after.presentation ?? "none");
            record(`wheel to ${Math.round(zoom * 100)}%`, after, actual);
            await page.screenshot({ path: path.join(OUT_DIR, `${DENSITY}-anchor-z${Math.round(zoom * 100)}.png`) });
          }
          must(seen.has("chip") && seen.has("native"), `anchor pass crossed presentations ${[...seen].join(",")}; expected chip and native`);
          evidence.anchorPresentations = [...seen];
          const zoomIn = page.locator('button[title^="Zoom in"]').first();
          const zoomOut = page.locator('button[title^="Zoom out"]').first();
          for (let cycle = 0; cycle < 20; cycle += 1) {
            await zoomOut.click();
            await page.waitForTimeout(80);
            record(`toolbar out ${cycle}`, await selectedHeader(page, anchorNode), await cameraZoom(page));
            await zoomIn.click();
            await page.waitForTimeout(80);
            record(`toolbar in ${cycle}`, await selectedHeader(page, anchorNode), await cameraZoom(page));
          }
          const end = await selectedHeader(page, anchorNode);
          const cumulative = Math.hypot(end!.x - start!.x, end!.y - start!.y);
          must(cumulative <= 4, `cumulative drift ${cumulative.toFixed(2)}px over 20 cycles`);
          evidence.cumulativeDrift = Number(cumulative.toFixed(3));
          /* Viewport resize reflows every band: the anchor holds. */
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.waitForTimeout(400);
          record("viewport 1440→1280", await selectedHeader(page, anchorNode), await cameraZoom(page));
          await page.screenshot({ path: path.join(OUT_DIR, `${DENSITY}-anchor-resized-1280.png`) });
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.waitForTimeout(400);
          record("viewport 1280→1440", await selectedHeader(page, anchorNode), await cameraZoom(page));
          /* The densest band keeps its local «+ Agent» reachable. */
          const add = page.locator(`[data-scheme-band-task="${denseTask.id}"] [data-scheme-band-add]`).first();
          must((await add.count()) === 1, "dense band has no local +Agent");
          await add.scrollIntoViewIfNeeded().catch(() => undefined);
          const addBox = await add.boundingBox();
          must(addBox !== null && addBox.height >= 20, "dense band +Agent has no box");
          evidence.denseAddAgent = { task: denseTask.id, members: denseTask.conversations.length, box: addBox };
          /* Orchestrator dock open at 21/58/100%. */
          const dock = page.locator('button[aria-label*="rchestrator"]').first();
          if (await dock.count()) {
            await dock.click();
            await page.waitForTimeout(500);
            for (const zoom of [0.21, 0.58, 1]) {
              await zoomTo(page, zoom);
              await panToFirstBand(page);
              await page.waitForTimeout(200);
              await page.screenshot({ path: path.join(OUT_DIR, `${DENSITY}-dock-open-z${Math.round(zoom * 100)}.png`) });
              const bands = await bandRects(page);
              const canvas = await page.evaluate(() => document.querySelector('[aria-label^="Agent board"]')!.getBoundingClientRect().width);
              frames.push({ file: `${DENSITY}-dock-open-z${Math.round(zoom * 100)}.png`, dock: true, zoom, availableWidth: canvas, bandWidth: bands[0]?.rect.width ?? null });
            }
          }
        }
        await page.close();
      }
    }
    for (const phone of PHONES) {
      const page = await browser.newPage({ viewport: { width: phone.width, height: phone.height }, colorScheme: "light", isMobile: true, hasTouch: true });
      await page.addInitScript(seedInit);
      await page.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "networkidle", timeout: 90_000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT_DIR, `${DENSITY}-phone-${phone.name}.png`) });
      frames.push({ file: `${DENSITY}-phone-${phone.name}.png`, viewport: phone.name, bands: await page.locator("[data-scheme-band]").count() });
      await page.close();
    }
    fs.mkdirSync(path.dirname(EVIDENCE_OUT), { recursive: true });
    fs.writeFileSync(EVIDENCE_OUT, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(`evidence: ${EVIDENCE_OUT}`);
    console.log(`frames: ${(evidence.frames as unknown[]).length}, anchor records: ${(evidence.anchor as unknown[]).length}, cumulative drift: ${String(evidence.cumulativeDrift)}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
