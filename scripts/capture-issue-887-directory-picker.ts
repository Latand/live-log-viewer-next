/**
 * Rendered verification of the #887 working-directory picker, in a real browser:
 *
 *   bun scripts/capture-issue-887-directory-picker.ts
 *
 * Serves the production build against a purpose-built synthetic home under
 * /tmp (never the operator's live state, and no real home path anywhere in the
 * frames), then drives the real board with the locally cached Chromium.
 *
 * The home holds one project whose transcripts sit in sibling worktrees that
 * differ only near the end of their paths — the case the old `<datalist>` and a
 * head-truncating control both destroy. Everything the picker lists is what the
 * production /api/spawn route suggests for that home; nothing is stubbed except
 * the launch POST, which is fulfilled with a receipt so no agent is ever
 * spawned by a screenshot run.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/887-desktop-closed.png        — the chosen directory, closed, legible
 *   <out>/887-desktop-open.png          — every known directory, one click, no typing
 *   <out>/887-desktop-similar.png       — two near-identical paths, told apart
 *   <out>/887-desktop-filtered.png      — a long list narrowed by a filter
 *   <out>/887-desktop-keyboard.png      — keyboard-only travel, highlight visible
 *   <out>/887-desktop-keyboard-done.png — what the keyboard committed
 *   <out>/887-desktop-freetext.png      — a path that is in no list, offered
 *   <out>/887-desktop-launch-ready.png  — directory plain to read beside the prompt
 *   <out>/887-desktop-launched.png      — the launch, with no confirmation asked
 *   <out>/887-mobile-closed.png         — 396 px, closed
 *   <out>/887-mobile-open.png           — 396 px, open, 44 px rows
 *   <out>/887-mobile-filtered.png       — 396 px, filtered
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { demoPort } from "./demo-capture";

const BASE = process.env.PICKER_CAPTURE_DIR ?? "/tmp/llv-issue-887";
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "atlas");

/** Real directories on disk, because the route only suggests a cwd it can stat.
    Two of them differ only in their last segment — the pair the closed control
    and the list both have to keep apart. */
const WORKTREES = [
  ".worktrees/pipeline-887-directory-picker",
  ".worktrees/pipeline-887-directory-picker-followup",
  ".worktrees/pipeline-902-replay-envelope",
  ".worktrees/pipeline-904-successor-seat",
  ".worktrees/pipeline-899-directory-projects",
  ".claude/worktrees/spike-launch-copy",
];
const CHECKOUTS = [REPO_DIR, ...WORKTREES.map((relative) => path.join(REPO_DIR, relative))];
/* Inside the repository but not a checkout of its own, so it is never
   suggested — the path only reaches the draft by being typed. */
const FREE_TEXT_DIR = path.join(REPO_DIR, "vendor/atlas-protocol/tools");

const TITLES = [
  "Trim the launch copy",
  "Drop the working-directory confirmation",
  "Follow up on the directory picker",
  "Shrink the replay envelope",
  "Seat the successor outside the server cwd",
  "Group directory-derived projects",
  "Spike the launch copy rewrite",
];

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Claude's own project folder name: the cwd with every separator flattened. */
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** Neutral git identity: the fixture must not inherit the host's. */
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: path.join(BASE, "git-home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
};

function seedHome(): void {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(FREE_TEXT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "git-home"), { recursive: true });
  /* The claude-tasks root follows os.tmpdir(); materializing the fixture's own
     one keeps the scanner off the host's real background-task directory. */
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  /* Real worktrees of a real repository: that is what makes the sibling
     checkouts group as one project, and what the route suggests together. */
  git(REPO_DIR, "init", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# atlas\n", "utf8");
  git(REPO_DIR, "add", "README.md");
  git(REPO_DIR, "commit", "-m", "atlas: first commit");
  for (const relative of WORKTREES) {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, relative)), { recursive: true });
    git(REPO_DIR, "worktree", "add", "-b", path.basename(relative), relative, "main");
  }
  CHECKOUTS.forEach((cwd, index) => {
    const folder = path.join(HOME, ".claude/projects", projectSlug(cwd));
    fs.mkdirSync(folder, { recursive: true });
    const id = `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`;
    const stamp = `2100-01-02T1${index}:10:05.000Z`;
    const lines = [
      { type: "user", uuid: `${id}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${TITLES[index]}.` } },
      { type: "assistant", uuid: `${id}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${TITLES[index]} — done, and the checkout is clean.` }] } },
    ];
    fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  });
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
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    USER: "demo",
    LOGNAME: "demo",
    SHELL: "/bin/sh",
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

const triggerValue = (page: Page) =>
  page.evaluate(() => document.querySelector("[data-directory-trigger]")?.getAttribute("data-directory-value") ?? null);
const optionValues = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll("[data-directory-option]")).map((row) => row.getAttribute("data-directory-option")!));
const activeOption = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-directory-active="true"]')?.getAttribute("data-directory-option") ?? null);
/** The draft pane's own rect, so a shot frames the control and not the board. */
const draftClip = async (page: Page) => {
  const box = await page.evaluate(() => {
    const pane = document.querySelector('[aria-label="Draft of a new agent conversation"]');
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    return { x: Math.max(rect.x - 16, 0), y: Math.max(rect.y - 16, 0), width: rect.width + 32, height: rect.height + 32 };
  });
  if (!box) return undefined;
  const viewport = page.viewportSize()!;
  return {
    x: box.x,
    y: box.y,
    width: Math.min(box.width, viewport.width - box.x),
    height: Math.min(box.height, viewport.height - box.y),
  };
};

async function openDraft(page: Page, baseUrl: string, projectId: string): Promise<void> {
  await page.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "networkidle", timeout: 90_000 });
  /* The board on desktop, MobileFocusView on a phone: wait for whichever
     surface this viewport gets. */
  await page.waitForSelector('[data-scheme-node], button[aria-haspopup="menu"]', { timeout: 60_000 });
  const create = page.locator('[aria-label="New conversation with an agent"]').first();
  if (await create.count()) {
    await create.click();
  } else {
    await page.locator('button[aria-haspopup="menu"]').first().click();
    await page.locator('[role="menuitem"]').first().click();
  }
  await page.waitForSelector("[data-directory-trigger]", { timeout: 30_000 });
  /* On the board (desktop), zoom until the draft is drawn at the size an
     operator actually reads it at — a fit-all view proves nothing about
     legibility — then wheel the camera so the strip clears the app header.
     The phone surface has neither control and needs neither. */
  const zoomable = await page.locator('button[title^="Zoom in"]').count();
  if (zoomable) {
    for (let step = 0; step < 8; step += 1) {
      const width = await page.evaluate(() => document.querySelector("[data-directory-trigger]")?.getBoundingClientRect().width ?? 0);
      if (width > 520) break;
      await page.locator('button[title^="Zoom in"]').first().click();
      await page.waitForTimeout(400);
    }
    for (let step = 0; step < 8; step += 1) {
      const top = await page.evaluate(() => document.querySelector('[aria-label="Draft of a new agent conversation"]')?.getBoundingClientRect().y ?? 0);
      if (top >= 96 && top <= 180) break;
      await page.mouse.move(720, 600);
      await page.mouse.wheel(0, Math.round(top - 130));
      await page.waitForTimeout(300);
    }
  }
  await page.waitForTimeout(600);
}

const clickTrigger = (page: Page) => page.locator("[data-directory-trigger]").first().click();
const typeFilter = async (page: Page, text: string) => {
  await page.locator('input[role="combobox"]').first().fill(text);
  await page.waitForTimeout(200);
};

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.PICKER_CAPTURE_PORT, 3047, "PICKER_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedHome();

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer(baseUrl, server);

    /* The board addresses a project by the id the scanner derived for the
       repository, so ask it rather than assuming the folder name. */
    const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ project?: string; cwd?: string }> };
    const projectId = scanned.files?.find((file) => file.cwd === REPO_DIR)?.project ?? "";
    must(Boolean(projectId), `no scanned project owns ${REPO_DIR}`);

    /* The route's own suggestions for this home, before any browser runs. */
    const suggested = await (await fetch(`${baseUrl}/api/spawn?project=${projectId}`)).json() as { dirs?: string[] };
    must((suggested.dirs?.length ?? 0) >= 6, `the route suggested ${suggested.dirs?.length ?? 0} directories, expected the seeded checkouts`);

    /* ── Desktop ─────────────────────────────────────────────────────────── */
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
    const launches: Array<Record<string, unknown>> = [];
    await page.route("**/api/spawn*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      /* Fulfilled, never forwarded: a screenshot run must not boot an agent. */
      launches.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, state: "starting", launched: false, path: null, launchId: "launch-887", conversationId: "conversation_887" }),
      });
    });
    await page.addInitScript(seedInit);
    await openDraft(page, baseUrl, projectId);

    const initial = await triggerValue(page);
    must(Boolean(initial), "the draft opened with no directory on the trigger");
    must(!(await page.locator('p[role="alert"]').count()), "a confirmation banner is still rendered");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-closed.png"), clip: await draftClip(page) });

    await clickTrigger(page);
    const listed = await optionValues(page);
    must(listed.length >= 6, `the open list showed ${listed.length} directories, expected every known one`);
    const siblings = listed.filter((dir) => dir.includes("pipeline-887-directory-picker"));
    must(siblings.length === 2, "the two near-identical checkouts are missing from the list");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-open.png"), clip: await draftClip(page) });

    /* The pair that shares everything but its tail, framed on its own. */
    const pairClip = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-directory-option]"))
        .filter((row) => row.getAttribute("data-directory-option")!.includes("pipeline-887-directory-picker"))
        .map((row) => row.getBoundingClientRect());
      if (rows.length !== 2) return null;
      const top = Math.min(...rows.map((rect) => rect.y)) - 8;
      const bottom = Math.max(...rows.map((rect) => rect.bottom)) + 8;
      return { x: Math.max(rows[0].x - 8, 0), y: Math.max(top, 0), width: rows[0].width + 16, height: bottom - top };
    });
    must(pairClip !== null, "could not frame the two near-identical rows");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-similar.png"), clip: pairClip! });

    await typeFilter(page, "887 follow");
    const filtered = await optionValues(page);
    must(filtered.length < listed.length, "the filter did not narrow the list");
    must(filtered.some((dir) => dir.endsWith("pipeline-887-directory-picker-followup")), "the filter dropped the row it should have kept");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-filtered.png"), clip: await draftClip(page) });
    await page.keyboard.press("Escape");
    must((await triggerValue(page)) === initial, "Escape changed the directory");

    /* ── Keyboard only: tab travel to the control, then travel and commit ── */
    /* Start from the prompt, where an operator's hands already are, and walk
       backwards: the control has to be reachable by tab travel, not only by a
       pointer. */
    await page.locator('textarea[aria-label="First prompt text"]').first().click();
    let focused = false;
    for (let step = 0; step < 30 && !focused; step += 1) {
      await page.keyboard.press("Shift+Tab");
      focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-directory-trigger") ?? false);
    }
    must(focused, "tab travel never reached the directory control");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    const highlighted = await activeOption(page);
    must(Boolean(highlighted) && highlighted !== initial, "the keyboard highlight never moved");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-keyboard.png"), clip: await draftClip(page) });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    must((await triggerValue(page)) === highlighted, "Enter did not commit the highlighted directory");
    must(await page.evaluate(() => document.activeElement?.hasAttribute("data-directory-trigger") ?? false), "focus was lost after committing");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-keyboard-done.png"), clip: await draftClip(page) });

    /* ── Free text: a path that is in no list ────────────────────────────── */
    await clickTrigger(page);
    await typeFilter(page, FREE_TEXT_DIR);
    const offered = await optionValues(page);
    must(offered.includes(FREE_TEXT_DIR), "the typed path was not offered");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-freetext.png"), clip: await draftClip(page) });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    must((await triggerValue(page)) === FREE_TEXT_DIR, "the typed path was not committed verbatim");

    /* ── The launch itself ───────────────────────────────────────────────── */
    await page.locator('textarea[aria-label="First prompt text"]').first().fill("Read the launch copy and rewrite the directory row.");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-launch-ready.png"), clip: await draftClip(page) });
    await page.locator('[aria-label="Launch the agent"]').first().click();
    await page.waitForTimeout(1200);
    must(launches.length === 1, `the launch was blocked: ${launches.length} spawn requests`);
    must(launches[0].cwd === FREE_TEXT_DIR, `the launch used ${String(launches[0].cwd)}, not the chosen directory`);
    must(!(await page.locator('p[role="alert"]').count()), "a confirmation banner appeared at launch time");
    await page.screenshot({ path: path.join(OUT_DIR, "887-desktop-launched.png"), clip: await draftClip(page) });
    await page.close();

    /* ── 396 px phone ────────────────────────────────────────────────────── */
    const phone = await browser.newPage({ viewport: { width: 396, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    await phone.addInitScript(seedInit);
    await openDraft(phone, baseUrl, projectId);
    await phone.screenshot({ path: path.join(OUT_DIR, "887-mobile-closed.png") });
    const touchTarget = await phone.evaluate(() => document.querySelector("[data-directory-trigger]")!.getBoundingClientRect().height);
    must(touchTarget >= 44, `the phone trigger is ${touchTarget}px tall, under the 44px floor`);
    await clickTrigger(phone);
    await phone.waitForTimeout(300);
    const rowHeight = await phone.evaluate(() => document.querySelector("[data-directory-option]")!.getBoundingClientRect().height);
    must(rowHeight >= 44, `the phone rows are ${rowHeight}px tall, under the 44px floor`);
    await phone.screenshot({ path: path.join(OUT_DIR, "887-mobile-open.png") });
    await typeFilter(phone, "902");
    await phone.screenshot({ path: path.join(OUT_DIR, "887-mobile-filtered.png") });
    await phone.close();

    console.log(`screenshots: ${OUT_DIR}`);
    console.log(`suggested directories: ${(suggested.dirs ?? []).length}`);
    console.log(`launch payload cwd: ${String(launches[0].cwd)}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
