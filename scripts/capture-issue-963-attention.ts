/**
 * Rendered verification of the #963 attention island, in a real browser:
 *
 *   bun scripts/capture-issue-963-attention.ts
 *
 * Serves the production build against a purpose-built synthetic home under
 * /tmp (never the operator's live state, and no real home path anywhere in
 * the frames), then drives the real Viewer through the island's states:
 * zero, one item, many items, the queue popover, the needs-me filter, an
 * off-viewport Next landing, a cross-project Next landing, and the 390px
 * arrangement.
 *
 * Attention items are REAL pending questions: each transcript tails an
 * unanswered AskUserQuestion and a live holder process keeps it open for
 * writing, so the scanner attributes a running pid and the production
 * pendingQuestion path lights up with no stubs anywhere. States progress by
 * writing more transcripts into the same polled home mid-run.
 *
 * Shots land outside the repository (in a fresh
 * <ATTENTION_CAPTURE_DIR>/<unique-run>/out directory) for direct
 * inspection; the committed evidence under
 * docs/acceptance/attention-island/ consists of deterministic redacted
 * placeholders (scripts/generate-privacy-placeholders.ts) that record each
 * live capture's SHA-256, per the publication policy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "ATTENTION_CAPTURE_DIR",
  prefix: "llv-issue-963",
  raw: process.env.ATTENTION_CAPTURE_DIR,
  repoRoot,
});
const HOME = path.join(BASE, "home");
const FIXED_ISO = "2100-01-02T12:00:00.000Z";

const OUT_DIR = path.join(BASE, "out");

/** Claude's own project folder name: the cwd with every separator flattened. */
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const PROJECTS = ["atlas", "orbit", "forge"] as const;
type ProjectName = (typeof PROJECTS)[number];

let sessionCounter = 0;

function transcriptPath(project: ProjectName): string {
  sessionCounter += 1;
  const id = `${String(sessionCounter).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const folder = path.join(HOME, ".claude/projects", projectSlug(path.join(HOME, "Projects", project)));
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, `${id}.jsonl`);
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record) + "\n";
}

/** A settled conversation: asked, answered, done. Never enters the queue. */
function writeSettled(project: ProjectName, title: string, stamp: string): void {
  const cwd = path.join(HOME, "Projects", project);
  const file = transcriptPath(project);
  const uuid = path.basename(file, ".jsonl");
  fs.writeFileSync(
    file,
    line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
    + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${title} — done, the checkout is clean.` }] } }),
    "utf8",
  );
  fs.utimesSync(file, new Date(FIXED_ISO), new Date(stamp));
}

/** A conversation blocked on a real unanswered AskUserQuestion. */
function writeQuestion(project: ProjectName, title: string, header: string, question: string, askedAt: string): string {
  const cwd = path.join(HOME, "Projects", project);
  const file = transcriptPath(project);
  const uuid = path.basename(file, ".jsonl");
  fs.writeFileSync(
    file,
    line({ type: "user", uuid: `${uuid}-u`, timestamp: askedAt, cwd, message: { role: "user", content: `${title}.` } })
    + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: askedAt, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "One decision remains before this continues." }] } })
    + line({ type: "assistant", uuid: `${uuid}-q`, timestamp: askedAt, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `tool-${uuid}`, name: "AskUserQuestion", input: { questions: [{ header, question, multiSelect: false, options: [
      { label: "Ship it (Recommended)", description: "Take the prepared default." },
      { label: "Hold for review", description: "Wait for a second pass." },
    ] }] } }] } }),
    "utf8",
  );
  fs.utimesSync(file, new Date(FIXED_ISO), new Date(askedAt));
  return file;
}

const holders: ChildProcess[] = [];

/** A live process holding the transcript open for writing, so the scanner
    attributes a running pid to it — the same trick the demo fixture uses. */
function holdOpen(file: string): void {
  const holderScript = path.join(BASE, "holder.cjs");
  if (!fs.existsSync(holderScript)) {
    fs.writeFileSync(holderScript, 'const fs = require("node:fs"); fs.openSync(process.argv[2], "a"); setInterval(() => {}, 60_000);\n', "utf8");
  }
  const holder = spawn(process.execPath, [holderScript, file], {
    cwd: HOME,
    env: { NODE_ENV: "production", PATH: process.env.PATH, HOME },
    stdio: "ignore",
  });
  holders.push(holder);
}

function seedHome(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  for (const project of PROJECTS) fs.mkdirSync(path.join(HOME, "Projects", project), { recursive: true });

  /* The quiet baseline: settled work in every project, an empty queue. */
  writeSettled("atlas", "Wire the capture fixture", "2100-01-02T09:05:00.000Z");
  writeSettled("atlas", "Polish the overview cards", "2100-01-02T09:10:00.000Z");
  writeSettled("atlas", "Tighten the board legend", "2100-01-02T09:15:00.000Z");
  writeSettled("atlas", "Refresh the reviewer notes", "2100-01-02T09:20:00.000Z");
  writeSettled("atlas", "Split the media pass", "2100-01-02T09:25:00.000Z");
  writeSettled("atlas", "Stage the release notes", "2100-01-02T09:30:00.000Z");
  writeSettled("orbit", "Audit the rollout summary", "2100-01-02T09:35:00.000Z");
  writeSettled("forge", "Rebuild the sample deck", "2100-01-02T09:40:00.000Z");
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

/** Pin the clock and silence the live churn, exactly as the demo stills do. */
const seedInit = () => {
  const captureTime = Date.parse("2100-01-02T12:00:00.000Z");
  const NativeDate = Date;
  class CaptureDate extends NativeDate {
    constructor(...args: unknown[]) {
      super(...((args.length ? args : [captureTime]) as []));
    }
    static now() { return captureTime; }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
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

/** The freshly polled queue size, straight from the production API. A plain
    poll rides the 5-minute ordinary-refresh cadence, so the wait pins the
    just-written path: a pinned request forces a scan (#950) and the shared
    snapshot adopts it — the same mechanism a deep link uses. */
async function waitForQueueSize(baseUrl: string, expected: number, pinPath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(pinPath)}`);
    const payload = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ path?: string; activity?: string; proc?: string; pid?: number; pendingQuestion?: unknown }> };
    const size = (payload.files ?? []).filter((file) => file.pendingQuestion).length;
    if (size === expected) return;
    last = (payload.files ?? []).map((file) => ({ path: path.basename(file.path ?? ""), activity: file.activity, proc: file.proc, pid: file.pid, pq: Boolean(file.pendingQuestion) }));
    await Bun.sleep(1_500);
  }
  throw new Error(`queue never reached ${expected} pending questions; last scan: ${JSON.stringify(last)}`);
}

const islandText = (page: Page) =>
  page.evaluate(() => document.querySelector("[data-attention-island]")?.textContent ?? null);

async function waitForIslandCount(page: Page, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = await islandText(page);
    if (text !== null && text.includes(String(count))) return;
    await page.waitForTimeout(400);
  }
  throw new Error(`island never showed the count ${count} (last: ${await islandText(page)})`);
}

async function openPage(browser: Browser, baseUrl: string, viewport: { width: number; height: number }, hash = ""): Promise<Page> {
  const context = await browser.newContext({ viewport, reducedMotion: "no-preference" });
  await context.addInitScript(seedInit);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector("[data-attention-island]", { timeout: 60_000 });
  return page;
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT_DIR, name) });
  console.log(`captured ${name}`);
};

async function main(): Promise<void> {
  const port = demoPort(process.env.ATTENTION_CAPTURE_PORT, 3049, "ATTENTION_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedHome();

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const browser = await chromium.launch({ headless: true });
  const desktop = { width: 1280, height: 800 };
  const mobile = { width: 390, height: 844 };
  try {
    await waitForServer(baseUrl, server);

    /* ---- zero: present, muted, quiet ---- */
    let page = await openPage(browser, baseUrl, desktop);
    await page.waitForSelector("[data-attention-zero]", { timeout: 30_000 });
    await shot(page, "963-desktop-zero.png");
    await page.context().close();

    page = await openPage(browser, baseUrl, mobile);
    await page.waitForSelector("[data-attention-zero]", { timeout: 30_000 });
    await shot(page, "963-mobile-zero.png");
    await page.context().close();

    /* ---- one item ---- */
    const firstQuestion = writeQuestion("atlas", "Choose the hero framing", "Hero frame", "Choose the hero framing for the README", "2100-01-02T10:05:00.000Z");
    holdOpen(firstQuestion);
    await waitForQueueSize(baseUrl, 1, firstQuestion);
    page = await openPage(browser, baseUrl, desktop);
    await waitForIslandCount(page, 1);
    await shot(page, "963-desktop-one.png");
    await page.context().close();

    /* ---- many items, across projects ---- */
    const secondQuestion = writeQuestion("atlas", "Pick the capture order", "Capture order", "Which capture runs first", "2100-01-02T10:20:00.000Z");
    holdOpen(secondQuestion);
    const orbitQuestion = writeQuestion("orbit", "Approve the rollout window", "Rollout window", "Approve the proposed rollout window", "2100-01-02T10:40:00.000Z");
    holdOpen(orbitQuestion);
    const forgeQuestion = writeQuestion("forge", "Confirm the deck template", "Deck template", "Confirm the sample deck template", "2100-01-02T10:50:00.000Z");
    holdOpen(forgeQuestion);
    await waitForQueueSize(baseUrl, 4, forgeQuestion);

    page = await openPage(browser, baseUrl, desktop);
    await waitForIslandCount(page, 4);
    await shot(page, "963-desktop-many.png");

    /* ---- queue open ---- */
    await page.click("[data-attention-count]");
    await page.waitForSelector("text=Waiting on you", { timeout: 15_000 });
    await shot(page, "963-desktop-queue-open.png");
    await page.context().close();

    /* ---- filter enabled, inside the busiest project ---- */
    const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ project?: string; path?: string }> };
    const atlasProject = scanned.files?.find((file) => file.path?.includes("-Projects-atlas"))?.project;
    if (!atlasProject) throw new Error("atlas project id not found in the scan");

    page = await openPage(browser, baseUrl, desktop, `#p=${encodeURIComponent(atlasProject)}`);
    await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
    await waitForIslandCount(page, 4);
    await page.click("[data-attention-filter]");
    await shot(page, "963-desktop-filter.png");
    await page.click("[data-attention-filter]");

    /* ---- off-viewport Next landing: zoom until cards overflow, then Next ---- */
    for (let step = 0; step < 6; step += 1) {
      const zoom = page.locator('button[title^="Zoom in"]').first();
      if (!(await zoom.count())) break;
      await zoom.click();
      await page.waitForTimeout(250);
    }
    await page.click("[data-attention-next]");
    await page.waitForTimeout(1_500);
    await shot(page, "963-desktop-next-landing.png");

    /* ---- cross-project Next landing: cycle until the queue leaves atlas ---- */
    await page.click("[data-attention-next]");
    await page.waitForTimeout(1_000);
    await page.click("[data-attention-next]");
    await page.waitForTimeout(2_000);
    const landedProject = await page.evaluate(() => location.hash);
    console.log(`cross-project landing hash: ${landedProject}`);
    await shot(page, "963-desktop-cross-project.png");
    await page.context().close();

    /* ---- 390px: island in the header, then the queue sheet ---- */
    page = await openPage(browser, baseUrl, mobile);
    await waitForIslandCount(page, 4);
    await shot(page, "963-mobile-many.png");
    await page.click("[data-attention-count]");
    await page.waitForSelector("text=Waiting on you", { timeout: 15_000 });
    await shot(page, "963-mobile-queue-sheet.png");
    await page.context().close();
  } finally {
    for (const holder of holders) holder.kill("SIGKILL");
    server.kill("SIGTERM");
    await Bun.sleep(1_000);
    if (server.exitCode === null) server.kill("SIGKILL");
    await browser.close();
  }
}

if (import.meta.main) await main();
