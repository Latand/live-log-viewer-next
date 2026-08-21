/**
 * Real-browser evidence for issue #1086 — the Telegram Daily Report surface,
 * at desktop (1440×900) and phone (390×844) widths:
 *
 *   bun run build && bun evidence/issue-1086/drive.ts
 *
 * PRODUCTION-SHAPED, the issue-1059 pattern this continues: the exact current
 * build is served with `next start` over a synthetic /tmp home (never the
 * operator's state, never ports 8898/8899), and the mocked seams are
 * `/api/telegram` and `/api/telegram/reports` — every state is a fulfilled
 * payload, so no capture ever touches a real Telegram account or launches a
 * real report run. Chats, groups and report text are invented fixtures.
 *
 * What the checks prove (issue #1086 acceptance):
 *  - the report section renders inside the EXISTING Telegram flyout/sheet, with
 *    no new navigation: disabled, enabled with schedule + Run now, the group
 *    source picker, the operator-editable analyst prompt, the history list,
 *    one rendered report, and a failed row that states its reason in a
 *    sentence;
 *  - a live run shows as `running` and Run now is disabled while it runs;
 *  - no report body is present in the page until the operator opens one;
 *  - the phone never grows a horizontal scrollbar with the sheet open, and the
 *    Telegram row keeps its 44px tap target.
 *
 * Output: `.artifacts/issue-1086/` in the worktree — the PNGs plus
 * `report-states.json` (booleans only). That directory is untracked and
 * gitignored: this repository is public and its publication gate admits raster
 * only with deterministic-generator provenance, so a browser capture is never
 * committed. No absolute path and no identity appears in the JSON.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { createCaptureDirectory } from "../../scripts/capture-directory";
import { demoPort } from "../../scripts/demo-capture";

import type { TelegramStatusPayload } from "@/lib/telegram/contracts";
import type { TelegramReportRow, TelegramReportsPayload } from "@/lib/telegram/reportContracts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const BASE = createCaptureDirectory({
  envName: "TG_REPORT_CAPTURE_DIR",
  prefix: "llv-issue-1086",
  raw: process.env.TG_REPORT_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
/* Panel crops beside the full-page shots. */
const PANEL_DIR = path.join(BASE, "panels");
/* Where a reviewer looks: an untracked directory in the worktree, so the UI
   critique stage can open the captures without them entering a commit. */
const ARTIFACTS_DIR = path.join(REPO_ROOT, ".artifacts", "issue-1086");
const REPO_DIR = path.join(HOME, "Projects", "atlas");
const CAPTURE_MS = Date.parse("2100-01-02T12:00:00.000Z");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const sessionUuid = (id: string) => [id, "0000", "4000", "8000", "000000000000"].join("-");

function seedHome(): void {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const uuid = sessionUuid("00001086");
  const stamp = new Date(CAPTURE_MS - 3 * 60_000).toISOString();
  const lines = [
    { type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd: REPO_DIR, message: { role: "user", content: "Run the Atlas board." } },
    { type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd: REPO_DIR, message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: "On it." }] } },
  ];
  fs.writeFileSync(path.join(folder, `${uuid}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
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

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/api/files`)).ok) return;
    } catch { /* still booting */ }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

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

/* Fixture identities and chats: invented, and the only ones any capture sees. */
const IDENTITY = { name: "Account A", username: "account_a" };
const GROUPS = [
  { id: "-1001000000001", title: "Atlas team room" },
  { id: "-1001000000002", title: "Release planning" },
  { id: "-1001000000003", title: "Design review" },
];
const REPORT_TEXT = [
  "#daily_report",
  "",
  "⏳ Awaiting your reply",
  "[1] Contact A asked yesterday evening whether the Atlas rollout still lands on Thursday, and has had no answer for fourteen hours. https://t.me/c/1000000001/482",
  "[2] Contact B sent the signed contract scan and asked you to confirm you received it. https://t.me/c/1000000002/91",
  "",
  "📌 You promised",
  "[3] You told the release planning group you would post the migration checklist before the end of the week; nothing has been posted there since.",
  "",
  "🐙 Proposed issues",
  "[4] Retry the connector health check after a restart — Contact A described the connector dropping once during a long read, and the run gave no visible reason.",
  "",
  "📅 Proposed calendar items",
  "[5] Design review on Thursday at 15:00, proposed by Contact C in the design review group. https://t.me/c/1000000003/57",
  "",
  "👀 Worth attention",
  "[6] The release planning group is still waiting on a decision about the staging window; two people asked about it and nobody answered.",
].join("\n");

const telegramPayload: TelegramStatusPayload = {
  phase: "connected",
  login: null,
  identity: IDENTITY,
  credentialRef: "credential-ref-placeholder",
  lastHealthCheckAt: "2100-01-02T11:56:00.000Z",
  error: null,
  credentialsConfigured: true,
};

function row(over: Partial<TelegramReportRow>): TelegramReportRow {
  return {
    id: "report-fixture-0001",
    trigger: "scheduled",
    startedAt: "2100-01-02T08:00:00.000Z",
    finishedAt: "2100-01-02T08:04:00.000Z",
    windowStart: "2100-01-01T08:00:00.000Z",
    windowEnd: "2100-01-02T08:00:00.000Z",
    status: "ok",
    errorCode: null,
    conversationId: "conversation_placeholder",
    hasReport: true,
    promptVersion: "v1",
    ...over,
  };
}

const ENABLED = {
  settings: {
    enabled: true,
    time: "10:00",
    groups: [{ id: GROUPS[0].id, title: GROUPS[0].title, mode: "full" as const }],
    promptIsDefault: true,
  },
  nextRunAt: "2100-01-03T08:00:00.000Z",
};

/* A synthetic brief for the editor capture — the shape an operator's own
   prompt takes, with placeholder names and a placeholder tag. */
const PROMPT_FIXTURE = [
  "Write one report on my Telegram for this window, in English.",
  "",
  "First line of the file is exactly:",
  "",
  "#report_tag",
  "",
  "Then, only the sections that have content:",
  "⏳ Awaiting your reply · 📌 You promised · 🐙 Proposed issues · 📅 Proposed calendar items · 👀 Worth attention",
  "",
  "Number the proposals [1], [2], [3] so I can answer \"do 2\". Full sentences, no jargon.",
].join("\n");

const HISTORY: TelegramReportRow[] = [
  row({ id: "report-fixture-0001" }),
  row({ id: "report-fixture-0002", startedAt: "2100-01-01T08:00:00.000Z", finishedAt: "2100-01-01T08:02:00.000Z", status: "quiet", hasReport: false }),
  row({
    id: "report-fixture-0003",
    startedAt: "2099-12-31T08:00:00.000Z",
    finishedAt: "2099-12-31T08:31:00.000Z",
    status: "failed",
    errorCode: "run_ended_without_report",
    hasReport: false,
  }),
];

interface StateSpec {
  id: string;
  reports: TelegramReportsPayload;
  /** Panel interaction to perform after opening. */
  act?: "sources" | "open-report" | "prompt";
  expectText: string[];
  absentText?: string[];
}

const STATES: StateSpec[] = [
  {
    id: "settings-disabled",
    reports: { settings: { enabled: false, time: "10:00", groups: [], promptIsDefault: true }, history: [], nextRunAt: null },
    expectText: ["Daily report", "Enable daily report"],
    absentText: ["Run now"],
  },
  {
    id: "settings-enabled",
    reports: { ...ENABLED, history: [] },
    expectText: ["Run now", "Kyiv time", "Sources: active private dialogs + 1 group", "No runs yet.", "Next 10:00"],
  },
  {
    id: "sources-picker",
    reports: { ...ENABLED, history: [] },
    act: "sources",
    expectText: ["Load my groups", "Light", "Full", GROUPS[1].title],
  },
  {
    id: "prompt-editor",
    reports: { ...ENABLED, settings: { ...ENABLED.settings, promptIsDefault: false }, history: [] },
    act: "prompt",
    expectText: ["Report prompt", "Save prompt", "Reset to default", "The Viewer always adds the window"],
  },
  {
    id: "history",
    reports: { ...ENABLED, history: HISTORY },
    expectText: ["24 h", "report", "quiet", "failed", "The run ended before it wrote a report."],
  },
  {
    id: "running",
    reports: { ...ENABLED, history: [row({ id: "report-fixture-0004", status: "running", finishedAt: null, hasReport: false }), ...HISTORY] },
    expectText: ["Running…", "running"],
  },
  {
    id: "report",
    reports: { ...ENABLED, history: HISTORY },
    act: "open-report",
    expectText: ["#daily_report", "⏳ Awaiting your reply", "[1] Contact A asked", "Back"],
  },
];

interface Check {
  state: string;
  viewport: "desktop" | "phone";
  rendered: boolean;
  reportBodyPresentBeforeOpening: boolean;
  runNowDisabledWhileRunning: boolean | null;
  rowTapTargetPx: number;
  horizontalOverflow: boolean;
}

async function openPanel(page: Page, viewport: "desktop" | "phone"): Promise<void> {
  if (viewport === "phone") {
    await page.click('button[aria-label="Open project list"]');
    await page.waitForTimeout(300);
  }
  await page.click('button[aria-label="Telegram connection"]');
  await page.waitForSelector('div[role="dialog"][aria-label="Telegram"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function captureState(
  context: BrowserContext,
  baseUrl: string,
  state: StateSpec,
  viewport: "desktop" | "phone",
): Promise<Check> {
  const page = await context.newPage();
  await page.route("**/api/telegram", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telegram: telegramPayload }) }));
  await page.route("**/api/telegram?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telegram: telegramPayload }) }));
  await page.route("**/api/telegram/reports**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { action?: string };
      if (body.action === "groups") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ groups: GROUPS }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reports: state.reports }) });
    }
    if (url.searchParams.get("prompt") === "1") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ prompt: PROMPT_FIXTURE, defaultPrompt: PROMPT_FIXTURE }),
      });
    }
    if (url.searchParams.get("report")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ report: REPORT_TEXT }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reports: state.reports }) });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await openPanel(page, viewport);

  const beforeOpening = await page.evaluate(() => document.documentElement.outerHTML.includes("Awaiting your reply"));
  if (state.act === "sources") {
    await page.click('div[role="dialog"][aria-label="Telegram"] >> text=Groups');
    await page.waitForTimeout(200);
    await page.click('div[role="dialog"][aria-label="Telegram"] >> text=Load my groups');
    await page.waitForTimeout(400);
  }
  if (state.act === "prompt") {
    /* Exact text: the summary line beside the button also starts with
       "Prompt", and a substring match would grab that span. */
    await page.click('div[role="dialog"][aria-label="Telegram"] >> button >> text="Prompt"');
    await page.waitForSelector('div[role="dialog"][aria-label="Telegram"] textarea', { timeout: 10_000 });
    await page.waitForTimeout(300);
  }
  if (state.act === "open-report") {
    await page.click('div[role="dialog"][aria-label="Telegram"] >> text=Open >> nth=0');
    await page.waitForTimeout(400);
  }

  const seen = await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"][aria-label="Telegram"]');
    const row = document.querySelector('button[aria-label="Telegram connection"]');
    const buttons = [...(dialog?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    const runNow = buttons.find((button) => (button.textContent ?? "").startsWith("Running"));
    return {
      text: dialog?.textContent ?? "",
      runNowDisabled: runNow ? runNow.disabled : null,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });

  for (const text of state.expectText) {
    if (!seen.text.includes(text)) throw new Error(`${state.id}/${viewport}: panel is missing "${text}"`);
  }
  for (const text of state.absentText ?? []) {
    if (seen.text.includes(text)) throw new Error(`${state.id}/${viewport}: panel unexpectedly shows "${text}"`);
  }
  if (viewport === "phone" && seen.scrollWidth > seen.innerWidth) {
    throw new Error(`${state.id}/${viewport}: the document scrolls to ${seen.scrollWidth}px at ${seen.innerWidth}px`);
  }
  if (viewport === "phone" && seen.rowHeight < 44) {
    throw new Error(`${state.id}/${viewport}: the Telegram row tap target is ${seen.rowHeight}px, under the 44px floor`);
  }
  if (state.id === "running" && seen.runNowDisabled !== true) {
    throw new Error(`${state.id}/${viewport}: Run now must be disabled while a run is live`);
  }

  const shot = path.join(OUT_DIR, `1086-${state.id}-${viewport}.png`);
  await page.screenshot({ path: shot });
  await page.locator('div[role="dialog"][aria-label="Telegram"]')
    .screenshot({ path: path.join(PANEL_DIR, `${state.id}-${viewport === "desktop" ? "desktop" : "mobile-390"}.png`) });
  console.log(`${shot}`);
  await page.close();
  return {
    state: state.id,
    viewport,
    rendered: true,
    /* The list payload carries no report text; the body appears only after
       the operator opens a row. */
    reportBodyPresentBeforeOpening: beforeOpening,
    runNowDisabledWhileRunning: state.id === "running" ? seen.runNowDisabled : null,
    rowTapTargetPx: seen.rowHeight,
    horizontalOverflow: seen.scrollWidth > seen.innerWidth,
  };
}

async function main(): Promise<void> {
  const port = demoPort(process.env.TG_REPORT_CAPTURE_PORT, 4186, "TG_REPORT_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedHome();
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const checks: Check[] = [];
  try {
    await waitForServer(baseUrl, server);
    for (const viewport of ["desktop", "phone"] as const) {
      const context = await browser.newContext({
        viewport: viewport === "desktop" ? DESKTOP : PHONE,
        colorScheme: "dark",
        timezoneId: "UTC",
        deviceScaleFactor: 2,
        ...(viewport === "phone" ? { isMobile: true, hasTouch: true } : {}),
      });
      await context.addInitScript(seedInit);
      for (const state of STATES) checks.push(await captureState(context, baseUrl, state, viewport));
      await context.close();
    }
    for (const dir of [OUT_DIR, PANEL_DIR]) {
      for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(ARTIFACTS_DIR, name));
    }
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "report-states.json"),
      JSON.stringify({ issue: 1086, capturedAt: "2100-01-02T12:00:00.000Z", identityFixture: "Account A", checks }, null, 2) + "\n",
    );
    console.log(`screenshots: .artifacts/issue-1086/ (${fs.readdirSync(ARTIFACTS_DIR).filter((name) => name.endsWith(".png")).length} png)`);
    console.log(`evidence: .artifacts/issue-1086/report-states.json (${checks.length} checks)`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

if (import.meta.main) await main();
