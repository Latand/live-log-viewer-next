/**
 * Rendered verification of the #699 overview tap-target contract, in a real
 * browser against the production build:
 *
 *   bun scripts/capture-issue-699-overview-targets.ts
 *
 * Serves the production build against a purpose-built synthetic home under
 * /tmp (never the operator's live state, no real home path in any frame),
 * opens the Overview board at phone and desktop widths, captures frames, and
 * runs a mechanical audit of the acceptance criteria:
 *
 *   - no interactive control is nested inside another interactive control,
 *     page-wide (the invalid button-inside-button markup was the root cause);
 *   - every conversation and project target on a coarse pointer meets the
 *     44px minimum;
 *   - a probe grid over each overview card assigns every point an expected
 *     exact destination — the one target whose visible rect contains it, or
 *     an explicit no-op — and requires the element a tap would actually hit
 *     to resolve to exactly that destination. A hit on anything whose rect
 *     does not contain the tap point is a wrong destination, the precise
 *     #699 defect, and fails the audit.
 *
 * The audit then proves it can fail: it widens one conversation row's hit
 * area over the gap below it (without moving the row's visible rect) and
 * requires the re-run to go red. A run in which the mutated board still
 * passes exits non-zero, so the audit can never green-light a board it
 * cannot actually judge.
 *
 * Shots land outside the repository in a fresh
 * <OVERVIEW_CAPTURE_DIR>/<unique-run>/out directory for direct inspection.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "OVERVIEW_CAPTURE_DIR",
  prefix: "llv-issue-699",
  raw: process.env.OVERVIEW_CAPTURE_DIR,
  repoRoot,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const FIXED_ISO = "2100-01-02T12:00:00.000Z";
/** Live activity needs a just-touched transcript relative to the pinned clock. */
const LIVE_ISO = "2100-01-02T11:59:40.000Z";

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

function writeConversation(project: ProjectName, title: string, options: { live: boolean }): string {
  const cwd = path.join(HOME, "Projects", project);
  const file = transcriptPath(project);
  const uuid = path.basename(file, ".jsonl");
  const stamp = options.live ? LIVE_ISO : "2100-01-02T09:00:00.000Z";
  /* Activity derives from mtime against the server's real clock; a quiet
     conversation must be genuinely old there, not merely earlier in the
     pinned fixture day. */
  const mtime = options.live ? new Date(stamp) : new Date(Date.now() - 3 * 3600 * 1000);
  fs.writeFileSync(
    file,
    line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
    + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${title} — in progress.` }] } }),
    "utf8",
  );
  fs.utimesSync(file, new Date(FIXED_ISO), mtime);
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

  /* Two projects with live rows — the layout the near-miss defect lived in —
     plus one quiet project keeping the single-target card variant on screen. */
  holdOpen(writeConversation("atlas", "Ship the deterministic capture", { live: true }));
  holdOpen(writeConversation("atlas", "Review the scanner retirement", { live: true }));
  holdOpen(writeConversation("atlas", "Tighten the board legend", { live: true }));
  holdOpen(writeConversation("orbit", "Audit the rollout summary", { live: true }));
  writeConversation("forge", "Rebuild the sample deck", { live: false });
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

async function waitForLiveRows(baseUrl: string, expected: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const payload = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ path?: string; activity?: string }> };
    const live = (payload.files ?? []).filter((file) => file.activity === "live").length;
    if (live === expected) return;
    last = (payload.files ?? []).map((file) => ({ path: path.basename(file.path ?? ""), activity: file.activity }));
    await Bun.sleep(1_500);
  }
  throw new Error(`scan never reached ${expected} live conversations; last: ${JSON.stringify(last)}`);
}

interface AuditResult {
  nestedInteractive: string[];
  undersizedTargets: Array<{ testid: string; width: number; height: number }>;
  wrongDestinationProbes: Array<{ x: number; y: number; expected: string; actual: string }>;
  overlappingTargetProbes: Array<{ x: number; y: number; targets: string[] }>;
  probeCount: number;
  conversationRows: number;
  projectTargets: number;
}

/**
 * The acceptance, measured on the rendered DOM. A probe grid walks every
 * overview card in 4px steps. Each point's EXPECTED destination is the one
 * explicit target (conversation row or project button) whose visible rect
 * contains it, or a no-op when no target does. The ACTUAL destination is
 * whatever interactive control `elementFromPoint` — exactly what a tap hits —
 * resolves to. The two must agree per point: a no-op is always acceptable
 * where nothing visible claims the point, but any interactive hit must be the
 * exact target the operator can see under their finger. A hit on a different
 * row, the project, or any unlabelled control is the #699 wrong-destination
 * defect and is reported point by point.
 */
function auditOverview(minTarget: number): AuditResult {
  const interactiveSelector = "button, a, [role='button'], [role='link']";
  const describe = (element: Element | null): string =>
    element === null
      ? "no-op"
      : `${element.tagName}[${element.getAttribute("data-testid") ?? "?"}:${element.getAttribute("aria-label") ?? element.textContent?.slice(0, 40) ?? ""}]`;

  const nestedInteractive: AuditResult["nestedInteractive"] = [];
  for (const element of document.querySelectorAll(interactiveSelector)) {
    const ancestor = element.parentElement?.closest(interactiveSelector);
    if (ancestor) nestedInteractive.push(`${describe(element)} inside ${ancestor.tagName}`);
  }

  const targets = Array.from(document.querySelectorAll("[data-testid='overview-conversation'], [data-testid='overview-project']"));
  const undersizedTargets: AuditResult["undersizedTargets"] = [];
  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    if (rect.height < minTarget || rect.width < minTarget) {
      undersizedTargets.push({ testid: target.getAttribute("data-testid") ?? "?", width: Math.round(rect.width), height: Math.round(rect.height) });
    }
  }

  const wrongDestinationProbes: AuditResult["wrongDestinationProbes"] = [];
  const overlappingTargetProbes: AuditResult["overlappingTargetProbes"] = [];
  let probeCount = 0;
  for (const card of document.querySelectorAll("[data-testid='overview-card']")) {
    const rect = card.getBoundingClientRect();
    for (let y = rect.top + 2; y < rect.bottom - 2; y += 4) {
      for (let x = rect.left + 2; x < rect.right - 2; x += 4) {
        probeCount += 1;
        const containing = targets.filter((target) => {
          const r = target.getBoundingClientRect();
          return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        });
        if (containing.length > 1) {
          /* Two visible targets claim the same point — no single honest
             destination exists there, whatever a tap resolves to. */
          overlappingTargetProbes.push({ x: Math.round(x), y: Math.round(y), targets: containing.map(describe) });
          continue;
        }
        const expected = containing[0] ?? null;
        const hit = document.elementFromPoint(x, y);
        const control = hit?.closest(interactiveSelector) ?? null;
        if (control === null) continue; // a no-op tap is always safe
        const testid = control.getAttribute("data-testid");
        const isExplicitTarget = testid === "overview-conversation" || testid === "overview-project";
        if (!isExplicitTarget || control !== expected) {
          wrongDestinationProbes.push({ x: Math.round(x), y: Math.round(y), expected: describe(expected), actual: describe(control) });
        }
      }
    }
  }

  return {
    nestedInteractive,
    undersizedTargets,
    wrongDestinationProbes,
    overlappingTargetProbes,
    probeCount,
    conversationRows: document.querySelectorAll("[data-testid='overview-conversation']").length,
    projectTargets: document.querySelectorAll("[data-testid='overview-project']").length,
  };
}

/**
 * Widen the first conversation row's hit area 48px past its visible rect —
 * an invisible child that intercepts taps over the gap and the next row
 * without moving the row's own bounding box. This is the #699 defect class
 * reintroduced on purpose; the audit must go red on it or it proves nothing.
 */
function widenFirstRowHitArea(): void {
  const row = document.querySelector<HTMLElement>("[data-testid='overview-conversation']");
  if (!row) throw new Error("no conversation row to mutate");
  row.style.position = "relative";
  const shim = document.createElement("div");
  shim.setAttribute("data-audit", "wrong-hit-shim");
  shim.style.cssText = "position:absolute;left:0;right:0;top:100%;height:48px;background:transparent;";
  row.appendChild(shim);
}

function auditFailed(audit: AuditResult): boolean {
  return audit.nestedInteractive.length > 0
    || audit.undersizedTargets.length > 0
    || audit.wrongDestinationProbes.length > 0
    || audit.overlappingTargetProbes.length > 0
    || audit.conversationRows === 0;
}

function summarize(audit: AuditResult): string {
  return JSON.stringify({
    ...audit,
    wrongDestinationProbes: audit.wrongDestinationProbes.slice(0, 8),
    overlappingTargetProbes: audit.overlappingTargetProbes.slice(0, 8),
    wrongDestinationCount: audit.wrongDestinationProbes.length,
    overlappingTargetCount: audit.overlappingTargetProbes.length,
  }, null, 2);
}

async function openPage(browser: Browser, baseUrl: string, options: { width: number; height: number; mobile: boolean }): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    reducedMotion: "no-preference",
    ...(options.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(seedInit);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector("[data-testid='overview-card']", { timeout: 60_000 });
  return page;
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(700);
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  console.log(`captured ${file}`);
};

async function main(): Promise<void> {
  const port = demoPort(process.env.OVERVIEW_CAPTURE_PORT, 3052, "OVERVIEW_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  /* Every resource — transcript holders, the production server, the browser —
     is acquired inside this try, so a failure at any acquisition step (a
     missing Chromium most likely) still releases everything before exit. */
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  let failed = false;
  try {
    seedHome();
    console.log(`screenshots: ${OUT_DIR}`);

    server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: repoRoot,
      env: buildEnvironment(port),
      stdio: ["ignore", "inherit", "inherit"],
    });
    const executablePath = process.env.CHROME_BIN
      ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    await waitForServer(baseUrl, server);
    await waitForLiveRows(baseUrl, 4);

    for (const [name, options, minTarget] of [
      ["699-phone-overview.png", { width: 390, height: 844, mobile: true }, 44],
      ["699-desktop-overview.png", { width: 1280, height: 800, mobile: false }, 0],
    ] as const) {
      const page = await openPage(browser, baseUrl, options);
      await shot(page, name);
      const audit = await page.evaluate(auditOverview, minTarget);
      console.log(`${name} audit:`, summarize(audit));
      if (auditFailed(audit)) {
        failed = true;
        console.error(`${name}: acceptance audit FAILED`);
      }

      /* Self-check: the audit must detect a wrong-hit area it is shown. */
      await page.evaluate(widenFirstRowHitArea);
      const mutated = await page.evaluate(auditOverview, minTarget);
      if (mutated.wrongDestinationProbes.length === 0) {
        failed = true;
        console.error(`${name}: audit did NOT flag a deliberately widened hit area — it cannot detect the #699 defect`);
      } else {
        console.log(`${name}: widened-hit-area self-check went red as required (${mutated.wrongDestinationProbes.length} wrong-destination probes)`);
      }
      await page.context().close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server?.kill("SIGTERM");
    for (const holder of holders) holder.kill("SIGTERM");
  }
  if (failed) {
    process.exitCode = 1;
    console.error("#699 acceptance audit failed — see the frames and audit output above.");
  } else {
    console.log("#699 acceptance audit passed at both widths, and the self-check proved the audit goes red on a widened hit area.");
  }
}

await main();
