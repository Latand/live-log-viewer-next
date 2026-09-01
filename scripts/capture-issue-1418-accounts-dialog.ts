/**
 * Rendered verification of the accounts dialog after #1418 / #1373 / #1358, in
 * a real browser: the desktop flyout at 1280×860 and the phone sheet at 390×844.
 *
 *   bun run build && bun scripts/capture-issue-1418-accounts-dialog.ts
 *
 * The production build is served against a synthetic home under the temp root
 * — never the operator's live state, and every account is invented: on the
 * Codex side "Main" (pro, headroom), "Account A" (pro, exhausted, holding one
 * reset credit) and "Account C" (prolite, active); on the Claude side "Main"
 * (max, reporting a flagship weekly bucket) and "Account B" (pro, none). The
 * account controller is disabled so the seeded readings stay, and the Codex
 * binary is a stub that exits, so the card actions exercise the routes end to
 * end and land on their failure notices without any provider call.
 *
 * Every shot also CHECKS what it shows: no 'Bound to' chip anywhere, one
 * limits block per card with both actions, the reset control enabled only on
 * the card that holds a credit, the flagship row present only on the account
 * that reports a bucket, 44px targets and a viewport-bound sheet on the phone,
 * and no horizontal scroll. Shots land in
 * <tmp>/llv-issue-1418-latest/out/1418-<surface>-<engine>.png and are never
 * committed: the privacy gate refuses rasters.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "ACCOUNTS_CAPTURE_DIR",
  prefix: "llv-issue-1418",
  raw: process.env.ACCOUNTS_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const HOME = path.join(BASE, "home");
const CONFIG = path.join(HOME, ".config");
const STATE = path.join(CONFIG, "agent-log-viewer", "state");
const OUT_DIR = path.join(BASE, "out");
const CODEX_STUB = path.join(BASE, "bin", "codex");
const DESKTOP = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };
const DAY = 86_400;

const codexTrigger = 'button[aria-label="Codex accounts — switch or add"]';
const claudeTrigger = 'button[aria-label="Claude accounts — switch or add"]';
const dialogFor = (engine: "Codex" | "Claude") => `[role="dialog"][aria-label="${engine} accounts"]`;

function seedEnvironment(): void {
  process.env.HOME = HOME;
  process.env.XDG_CONFIG_HOME = CONFIG;
  process.env.LLV_STATE_DIR = STATE;
  process.env.LLV_CLAUDE_HOME = path.join(HOME, ".claude");
  process.env.LLV_CODEX_HOME = path.join(HOME, ".codex");
}

/* The accounts and their readings are written through the same modules the
   Viewer uses, after the environment points them at the synthetic home. */
async function seedHome(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmux"), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.dirname(CODEX_STUB), { recursive: true });
  fs.writeFileSync(CODEX_STUB, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, ".codex", "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), "{}", { mode: 0o600 });

  const { createManagedCodexAccount, setActiveCodexAccount } = await import("@/lib/accounts/codex");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const { agentRegistry } = await import("@/lib/agent/registry");

  const codexA = createManagedCodexAccount("Account A");
  fs.writeFileSync(path.join(codexA.home, "auth.json"), "{}", { mode: 0o600 });
  const codexC = createManagedCodexAccount("Account C");
  fs.writeFileSync(path.join(codexC.home, "auth.json"), "{}", { mode: 0o600 });
  setActiveCodexAccount(codexC.id);
  const claudeB = createManagedClaudeAccount("Account B");
  fs.writeFileSync(path.join(claudeB.home, ".credentials.json"), "{}", { mode: 0o600 });

  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const at = now.toISOString();
  const live = { source: "live" as const, reason: null, staleSince: null };
  const window = (usedPercent: number, resetsAt: number, windowMinutes: number) => ({ usedPercent, resetsAt, windowMinutes });
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [
      {
        engine: "codex", accountId: "default", authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(8, nowS + 3 * 3_600, 300), weekly: window(39, nowS + 3 * DAY, 10_080), plan: "pro", capturedAt: nowS },
        resetCredits: { availableCount: 0, expiresAt: null },
      },
      {
        engine: "codex", accountId: codexA.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: null, weekly: window(100, nowS + 5 * DAY, 10_080), plan: "pro", capturedAt: nowS },
        resetCredits: { availableCount: 1, expiresAt: nowS + 20 * DAY },
      },
      {
        engine: "codex", accountId: codexC.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(20, nowS + 2 * 3_600, 300), weekly: window(83, nowS + 2 * DAY, 10_080), plan: "prolite", capturedAt: nowS },
        resetCredits: { availableCount: 0, expiresAt: null },
      },
    ],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
  agentRegistry().recordQuotaEvaluation({
    engine: "claude",
    observations: [
      {
        engine: "claude", accountId: "default", authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: {
          session: window(12, nowS + 3_600, 300),
          weekly: window(40, nowS + 4 * DAY, 10_080),
          flagship: { ...window(63, nowS + 4 * DAY, 10_080), tier: "opus" },
          plan: "max", capturedAt: nowS,
        },
      },
      {
        engine: "claude", accountId: claudeB.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(5, nowS + 2 * 3_600, 300), weekly: window(70, nowS + 6 * DAY, 10_080), plan: "pro", capturedAt: nowS },
      },
    ],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
}

function serverEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME,
    TMPDIR: path.join(BASE, "tmp"),
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: CONFIG,
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: STATE,
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    LLV_CODEX_BINARY: CODEX_STUB,
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
    } catch {
      /* still booting */
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

interface DialogFacts {
  boundChips: number;
  boundText: boolean;
  cards: number;
  refreshButtons: number;
  resetButtons: number;
  resetEnabled: string[];
  flagshipRows: string[];
  minTarget: number;
  bottom: number;
  viewport: number;
  scrollWidth: number;
  innerWidth: number;
}

async function dialogFacts(page: Page, engine: "Codex" | "Claude"): Promise<DialogFacts> {
  return page.evaluate((selector) => {
    const dialog = document.querySelector(selector)!;
    const targets = [...dialog.querySelectorAll<HTMLButtonElement>("[data-account-refresh-limits], [data-account-use-reset], button[aria-label^='Copy the agent command'], button[aria-label^='Remove']")];
    return {
      boundChips: dialog.querySelectorAll("[data-account-projects]").length,
      boundText: (dialog.textContent ?? "").includes("Bound to"),
      cards: dialog.querySelectorAll("[data-account-limits]").length,
      refreshButtons: dialog.querySelectorAll("[data-account-refresh-limits]").length,
      resetButtons: dialog.querySelectorAll("[data-account-use-reset]").length,
      resetEnabled: [...dialog.querySelectorAll<HTMLButtonElement>("[data-account-use-reset]")].filter((button) => !button.disabled).map((button) => button.getAttribute("data-account-use-reset")!),
      flagshipRows: [...dialog.querySelectorAll("[data-limit-row='flagship']")].map((row) => row.closest("[data-account-limits]")!.getAttribute("data-account-limits")!),
      minTarget: Math.min(...targets.map((button) => Math.round(button.getBoundingClientRect().height))),
      bottom: Math.round(dialog.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, dialogFor(engine));
}

function checkDialog(surface: string, engine: "Codex" | "Claude", facts: DialogFacts): void {
  const where = `${surface} ${engine}`;
  if (facts.boundChips > 0 || facts.boundText) throw new Error(`${where}: a 'Bound to' chip is still on a card`);
  if (facts.cards === 0) throw new Error(`${where}: no card rendered a limits block`);
  if (facts.refreshButtons !== facts.cards) throw new Error(`${where}: ${facts.refreshButtons} refresh actions for ${facts.cards} limits blocks`);
  if (engine === "Codex") {
    if (facts.resetButtons !== facts.cards) throw new Error(`${where}: ${facts.resetButtons} reset controls for ${facts.cards} cards`);
    if (facts.resetEnabled.join() !== "account-a") throw new Error(`${where}: the reset control is enabled on [${facts.resetEnabled.join(", ")}], expected only the account holding a credit`);
    if (facts.flagshipRows.length) throw new Error(`${where}: a Codex card drew a flagship row`);
  } else {
    if (facts.resetButtons !== 0) throw new Error(`${where}: a Claude card drew a reset control`);
    if (facts.flagshipRows.join() !== "default") throw new Error(`${where}: flagship rows on [${facts.flagshipRows.join(", ")}], expected only the account reporting a bucket`);
  }
  if (facts.scrollWidth > facts.innerWidth) throw new Error(`${where}: the document scrolls to ${facts.scrollWidth}px at ${facts.innerWidth}px`);
  if (facts.bottom > facts.viewport) throw new Error(`${where}: the dialog ends at ${facts.bottom}px, past the ${facts.viewport}px viewport`);
  if (surface === "phone" && facts.minTarget < 44) throw new Error(`${where}: a card action is ${facts.minTarget}px tall, under the 44px floor`);
}

async function openDialog(page: Page, engine: "Codex" | "Claude"): Promise<void> {
  await page.click(engine === "Codex" ? codexTrigger : claudeTrigger);
  await page.waitForSelector(dialogFor(engine));
  await page.waitForTimeout(250);
}

async function closeDialog(page: Page, engine: "Codex" | "Claude"): Promise<void> {
  await page.click(`${dialogFor(engine)} button[aria-label="Close"]`);
  await page.waitForSelector(dialogFor(engine), { state: "detached" });
}

async function shoot(page: Page, engine: "Codex" | "Claude", surface: "desktop" | "phone", suffix = ""): Promise<void> {
  const file = path.join(OUT_DIR, `1418-${surface}-${engine.toLowerCase()}${suffix}.png`);
  if (surface === "desktop") await page.locator(dialogFor(engine)).screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`  ${path.basename(file)}`);
}

async function main(): Promise<void> {
  const port = demoPort(process.env.ACCOUNTS_CAPTURE_PORT, 4418, "ACCOUNTS_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedEnvironment();
  await seedHome();
  /* `package.json`'s own start command: `bunx next start` hands the server to
     node, where the instrumentation hook dies on "SQLite state stores require
     the Bun runtime" and every request 500s. */
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: serverEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    await waitForServer(baseUrl, server);
    console.log(`screenshots: ${OUT_DIR}`);

    const desktop = await browser.newPage({ viewport: DESKTOP });
    await desktop.goto(baseUrl, { waitUntil: "networkidle" });
    await desktop.waitForSelector(codexTrigger);
    for (const engine of ["Codex", "Claude"] as const) {
      await openDialog(desktop, engine);
      checkDialog("desktop", engine, await dialogFacts(desktop, engine));
      await shoot(desktop, engine, "desktop");
      if (engine === "Codex") {
        /* The actions fire on the first click — no confirm step — and reach the
           route: with the stub binary the live read fails, so the card lands on
           its failure notice, which is the wiring proven end to end. */
        await desktop.click('[data-account-refresh-limits="account-a"]');
        await desktop.waitForSelector(`${dialogFor(engine)} .text-danger:has-text("Could not re-read limits for Account A")`, { timeout: 30_000 });
        await shoot(desktop, engine, "desktop", "-refresh-failed");
        const confirm = await desktop.locator(`${dialogFor(engine)} button:has-text("Confirm")`).count();
        if (confirm) throw new Error("desktop Codex: a confirmation control appeared for a limits action");
      }
      await closeDialog(desktop, engine);
    }
    await desktop.close();

    const phone = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.goto(baseUrl, { waitUntil: "networkidle" });
    await phone.click('button[aria-label="Open project list"]');
    await phone.waitForSelector(codexTrigger);
    for (const engine of ["Codex", "Claude"] as const) {
      await openDialog(phone, engine);
      checkDialog("phone", engine, await dialogFacts(phone, engine));
      await shoot(phone, engine, "phone");
      await closeDialog(phone, engine);
    }
    await phone.close();
    console.log("accounts dialog: desktop flyout and phone sheet verified");
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
