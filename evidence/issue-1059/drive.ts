/**
 * Real-browser evidence for issue #1059 — the Telegram connection surface, at
 * desktop (1440×900) and phone (390×844) widths:
 *
 *   bun run build && bun evidence/issue-1059/drive.ts
 *
 * PRODUCTION-SHAPED, the issue-979 pattern: the exact current build is served
 * with `next start` over a synthetic /tmp home (never the operator's state,
 * never ports 8898/8899), and the ONE mocked seam is `/api/telegram` — every
 * connection state is a route-fulfilled TelegramStatusPayload, so no test or
 * capture ever touches a real Telegram account. Identities are the fixture
 * "Account A"/@account_a; the QR url is a placeholder token.
 *
 * What the checks prove (issue #1059 acceptance):
 *  - the Telegram row renders in the left-rail footer beside the account
 *    controls on desktop, and inside the project drawer on the phone, with a
 *    44px tap target there;
 *  - disconnected, awaiting_scan (client-drawn QR from the tg:// url),
 *    awaiting_password (with and without the invalid-password notice),
 *    connected (identity + last health check), expired (Reconnect, no remote
 *    logout), and error each render their explicit state;
 *  - Log out and Delete local session arm inline confirmations, and the
 *    delete confirmation states that the remote authorization may remain;
 *  - the phone never grows a horizontal scrollbar with the sheet open.
 *
 * Output: evidence/issue-1059/telegram-states.json (booleans only) plus
 * screenshots under the capture directory printed at the end. No PNG is
 * committed; no absolute path or identity appears in the JSON.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { createCaptureDirectory } from "../../scripts/capture-directory";
import { demoPort } from "../../scripts/demo-capture";

import type { TelegramStatusPayload } from "@/lib/telegram/contracts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const BASE = createCaptureDirectory({
  envName: "TG_CAPTURE_DIR",
  prefix: "llv-issue-1059",
  raw: process.env.TG_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "atlas");
const CAPTURE_MS = Date.parse("2100-01-02T12:00:00.000Z");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const sessionUuid = (id: string) => [id, "0000", "4000", "8000", "000000000000"].join("-");

function seedHome(): void {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  const uuid = sessionUuid("00001059");
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

const IDENTITY = { name: "Account A", username: "account_a" };
const CREDENTIAL_REF = "credential-ref-placeholder";
const QR_URL = "tg://login?token=" + "PLACEHOLDERTOKENPLACEHOLDERTOKEN";

function payload(over: Partial<TelegramStatusPayload>): TelegramStatusPayload {
  return {
    phase: "disconnected",
    login: null,
    identity: null,
    credentialRef: null,
      credentialsConfigured: true,
    lastHealthCheckAt: null,
    error: null,
    ...over,
  };
}

interface StateSpec {
  id: string;
  telegram: TelegramStatusPayload;
  /** Arm this destructive action after opening the panel. */
  arm?: "logout" | "delete";
  /** Panel text that must be visible for the state to count as rendered. */
  expectText: string[];
  /** Text that must be absent. */
  absentText?: string[];
  expectQr?: boolean;
  expectPasswordField?: boolean;
}

const STATES: StateSpec[] = [
  {
    id: "disconnected",
    telegram: payload({}),
    expectText: ["Not connected", "Connect Telegram", "Read-only · operator sessions only"],
  },
  {
    id: "qr",
    telegram: payload({
      phase: "awaiting_scan",
      login: { operationId: "op-capture", qr: { url: QR_URL, expiresAt: "2100-01-02T12:00:30.000Z" }, passwordError: false },
    }),
    expectText: ["Scan the QR code", "refreshes automatically", "Cancel"],
    expectQr: true,
  },
  {
    id: "password",
    telegram: payload({
      phase: "awaiting_password",
      login: { operationId: "op-capture", qr: null, passwordError: false },
    }),
    expectText: ["Password needed", "two-step verification password", "Cancel"],
    absentText: ["Wrong password"],
    expectPasswordField: true,
  },
  {
    id: "password-invalid",
    telegram: payload({
      phase: "awaiting_password",
      login: { operationId: "op-capture", qr: null, passwordError: true },
    }),
    expectText: ["Wrong password. Try again."],
    expectPasswordField: true,
  },
  {
    id: "connected",
    telegram: payload({
      phase: "connected",
      identity: IDENTITY,
      credentialRef: CREDENTIAL_REF,
      lastHealthCheckAt: "2100-01-02T11:56:00.000Z",
    }),
    expectText: ["Connected as", "Account A", "@account_a", "Checked", "Log out", "Delete local session"],
  },
  {
    id: "logout-confirm",
    telegram: payload({
      phase: "connected",
      identity: IDENTITY,
      credentialRef: CREDENTIAL_REF,
      lastHealthCheckAt: "2100-01-02T11:56:00.000Z",
    }),
    arm: "logout",
    expectText: ["Log out of Telegram and remove the local session?", "Confirm"],
  },
  {
    id: "delete-confirm",
    telegram: payload({
      phase: "connected",
      identity: IDENTITY,
      credentialRef: CREDENTIAL_REF,
      lastHealthCheckAt: "2100-01-02T11:56:00.000Z",
    }),
    arm: "delete",
    expectText: ["Delete the local session?", "may remain", "Confirm"],
  },
  {
    id: "expired",
    telegram: payload({
      phase: "expired",
      identity: IDENTITY,
      credentialRef: CREDENTIAL_REF,
      lastHealthCheckAt: "2100-01-02T11:40:00.000Z",
    }),
    expectText: ["Session expired", "Reconnect", "Delete local session"],
    absentText: ["Log out of Telegram"],
  },
  {
    id: "error",
    telegram: payload({
      phase: "error",
      identity: IDENTITY,
      credentialRef: CREDENTIAL_REF,
      lastHealthCheckAt: "2100-01-02T11:40:00.000Z",
      error: { code: "logout_failed" },
    }),
    expectText: ["Remote logout failed", "Retry", "Delete local session"],
  },
];

interface Check {
  state: string;
  viewport: "desktop" | "phone";
  rendered: boolean;
  qrDrawnClientSide: boolean | null;
  passwordFieldMasked: boolean | null;
  rowTapTargetPx: number;
  horizontalOverflow: boolean;
  sessionStringAbsent: boolean;
}

async function openPanel(page: Page, viewport: "desktop" | "phone"): Promise<void> {
  if (viewport === "phone") {
    await page.click('button[aria-label="Open project list"]');
    await page.waitForTimeout(300);
  }
  await page.click('button[aria-label="Telegram connection"]');
  await page.waitForSelector('div[role="dialog"][aria-label="Telegram"]', { timeout: 10_000 });
}

async function captureState(
  context: BrowserContext,
  baseUrl: string,
  state: StateSpec,
  viewport: "desktop" | "phone",
): Promise<Check> {
  const page = await context.newPage();
  await page.route("**/api/telegram*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telegram: state.telegram }) }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await openPanel(page, viewport);
  if (state.arm) {
    await page.click(`div[role="dialog"][aria-label="Telegram"] >> text=${state.arm === "logout" ? "Log out" : "Delete local session"}`);
    await page.waitForTimeout(200);
  }
  if (state.expectQr) {
    await page.waitForSelector('img[alt="Telegram sign-in QR code"]', { timeout: 15_000 });
  }
  await page.waitForTimeout(400);

  const seen = await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"][aria-label="Telegram"]');
    const row = document.querySelector('button[aria-label="Telegram connection"]');
    const qr = document.querySelector('img[alt="Telegram sign-in QR code"]') as HTMLImageElement | null;
    const field = dialog?.querySelector('input[type="password"]') as HTMLInputElement | null;
    return {
      text: dialog?.textContent ?? "",
      html: document.documentElement.outerHTML,
      qrSrc: qr?.src ?? null,
      passwordType: field?.type ?? null,
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
  if (state.expectQr && !(seen.qrSrc ?? "").startsWith("data:image/")) {
    throw new Error(`${state.id}/${viewport}: the QR was not drawn client-side (src ${seen.qrSrc})`);
  }
  if (viewport === "phone" && seen.scrollWidth > seen.innerWidth) {
    throw new Error(`${state.id}/${viewport}: the document scrolls to ${seen.scrollWidth}px at ${seen.innerWidth}px`);
  }
  if (viewport === "phone" && seen.rowHeight < 44) {
    throw new Error(`${state.id}/${viewport}: the Telegram row tap target is ${seen.rowHeight}px, under the 44px floor`);
  }

  const shot = path.join(OUT_DIR, `1059-${state.id}-${viewport}.png`);
  await page.screenshot({ path: shot });
  console.log(`${shot}  → ${state.telegram.phase}${state.arm ? ` (+${state.arm} confirm)` : ""}`);
  await page.close();
  return {
    state: state.id,
    viewport,
    rendered: true,
    qrDrawnClientSide: state.expectQr ? true : null,
    passwordFieldMasked: state.expectPasswordField ? seen.passwordType === "password" : null,
    rowTapTargetPx: seen.rowHeight,
    horizontalOverflow: seen.scrollWidth > seen.innerWidth,
    /* The mocked payloads never carry a session string; the rendered page must
       not either — the placeholder QR token is the only tg:// value on screen. */
    sessionStringAbsent: !seen.html.includes("sessionString"),
  };
}

async function main(): Promise<void> {
  const port = demoPort(process.env.TG_CAPTURE_PORT, 4159, "TG_CAPTURE_PORT");
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
        deviceScaleFactor: viewport === "desktop" ? 2 : 3,
        ...(viewport === "phone" ? { isMobile: true, hasTouch: true } : {}),
      });
      await context.addInitScript(seedInit);
      for (const state of STATES) checks.push(await captureState(context, baseUrl, state, viewport));
      await context.close();
    }
    fs.writeFileSync(
      path.join(import.meta.dir, "telegram-states.json"),
      JSON.stringify({ issue: 1059, capturedAt: "2100-01-02T12:00:00.000Z", identityFixture: "Account A/@account_a", checks }, null, 2) + "\n",
    );
    console.log(`screenshots: ${OUT_DIR}`);
    console.log(`evidence: evidence/issue-1059/telegram-states.json (${checks.length} checks)`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

if (import.meta.main) await main();
