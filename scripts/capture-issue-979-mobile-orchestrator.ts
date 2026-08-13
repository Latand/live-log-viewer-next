/**
 * Rendered verification of the #979 phone orchestrator surface, in a real
 * browser at 390×844:
 *
 *   bun run build && bun scripts/capture-issue-979-mobile-orchestrator.ts
 *
 * Slice C's requirement is a pinned row that is always FIRST and a create sheet
 * usable with one thumb — claims about geometry, which only a real engine can
 * settle. So the production build is served against a purpose-built synthetic
 * home under /tmp (never the operator's live state, and no real home path in
 * any frame), the phone viewport is emulated, and each seat state is driven by
 * answering the seat route in flight. Everything else is the production render.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/979-<state>-<scheme>.png
 *
 * Every shot also CHECKS what it is showing: the row keeps its 44px target and
 * sits left of the first conversation chip, the phone never grows a horizontal
 * scrollbar (#353), and the sheet's confirm control stays inside the viewport.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { PERSISTENT_CHROME } from "@/components/mobile/chatBudget";

import { resolveCaptureRoot } from "./capture-issue-963-attention";
import { demoPort } from "./demo-capture";

/**
 * The capture root is deleted WHOLESALE before every run, so the override is
 * validated by the same rule #963's review put behind its own cleanup: a
 * dedicated `llv-`-prefixed child directory that owns nothing else — never the
 * filesystem root, the home directory, a bare temp root, or the repository.
 * A typo'd `ORCH_CAPTURE_DIR` must fail here, before anything is removed.
 */
export function resolveOrchCaptureRoot(raw: string | undefined, repo?: string): string {
  const base = path.resolve(raw ?? "/tmp/llv-issue-979");
  try {
    resolveCaptureRoot(base, repo);
  } catch {
    throw new Error(`ORCH_CAPTURE_DIR must be a dedicated «llv-» child directory that owns nothing else, got ${base}`);
  }
  return base;
}

const BASE = resolveOrchCaptureRoot(process.env.ORCH_CAPTURE_DIR);
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "atlas");
const CAPTURE_MS = Date.parse("2100-01-02T12:00:00.000Z");
const PHONE = { width: 390, height: 844 };
/* An iOS keyboard's own share of a 390×844 phone — the layout viewport keeps
   its full height there and only the VISUAL viewport shrinks (#983). */
const KEYBOARD_PX = 336;

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/* Composed rather than written out: a literal UUID in a published source file
   is what the privacy gate's resource-identifier rule exists to catch, and it
   cannot tell a synthetic fixture id from a real one. */
const sessionUuid = (id: string) => [id, "0000", "4000", "8000", "000000000000"].join("-");

const SESSIONS = [
  { id: "00000979", title: "Run the Atlas board", agoMinutes: 3 },
  { id: "00000980", title: "Implement the export endpoint", agoMinutes: 12 },
];

function seedHome(): void {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  for (const session of SESSIONS) {
    const uuid = sessionUuid(session.id);
    const stamp = new Date(CAPTURE_MS - session.agoMinutes * 60_000).toISOString();
    const lines = [
      { type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd: REPO_DIR, message: { role: "user", content: `${session.title}.` } },
      { type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd: REPO_DIR, message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: `${session.title} — on it. Two lanes open, one review round pending.` }] } },
    ];
    fs.writeFileSync(path.join(folder, `${uuid}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  }
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
    } catch {
      /* still booting */
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

interface SeatAnswer {
  seat: Record<string, unknown> | null;
  pending: Record<string, unknown> | null;
  exists: boolean;
}

function seat(transcriptPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas",
    seatEpoch: 3,
    conversationId: "conversation_atlas_orchestrator",
    path: transcriptPath,
    mandate: "You run the Atlas board.",
    promptVersion: 3,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "seatreq-000001", mode: "spawn", launchId: "launch-000001", error: null },
    designatedAt: "2100-01-02T11:00:00.000Z",
    activatedAt: "2100-01-02T11:00:02.000Z",
    ...overrides,
  };
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

/** What the phone must still be true of, whatever state is on screen. */
async function checkPhoneGeometry(page: Page, state: string): Promise<{ row: number; strip: number; button: number }> {
  const geometry = await page.evaluate(() => {
    const row = document.querySelector("[data-orchestrator-row]");
    const button = document.querySelector("[data-orchestrator-row-open]");
    const chip = document.querySelector(".overflow-x-auto button");
    const rowRect = row?.getBoundingClientRect();
    const chipRect = chip?.getBoundingClientRect();
    const stripRect = row?.parentElement?.getBoundingClientRect();
    return {
      row: rowRect ? Math.round(rowRect.height) : 0,
      left: rowRect ? Math.round(rowRect.left) : -1,
      chips: document.querySelectorAll(".overflow-x-auto button").length,
      chipLeft: chipRect ? Math.round(chipRect.left) : Number.POSITIVE_INFINITY,
      strip: stripRect ? Math.round(stripRect.height) : 0,
      button: button ? Math.round(button.getBoundingClientRect().height) : 0,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  if (geometry.button < 44) throw new Error(`${state}: the row's tap target is ${geometry.button}px, under the 44px floor`);
  /* «Before the first chip» means nothing without a chip to be before: a strip
     that rendered none would otherwise pass this check by default. */
  if (geometry.chips === 0) throw new Error(`${state}: the strip drew no conversation chips, so the pin's position proves nothing`);
  if (geometry.left >= geometry.chipLeft) throw new Error(`${state}: the pinned row starts at ${geometry.left}px, not before the first chip at ${geometry.chipLeft}px`);
  /* The chat-first budget (issue #419): the pin rides the strip row that
     `chatBudget` already counts, so it must not push that row past the height
     the transcript's 60% share is computed against. */
  if (geometry.strip > PERSISTENT_CHROME.focusStrip) {
    throw new Error(`${state}: the strip is ${geometry.strip}px, past the ${PERSISTENT_CHROME.focusStrip}px the chat budget reserves for it`);
  }
  /* The mobile overflow contract (#353): the document itself never scrolls
     sideways — only the chip strip inside it does. */
  if (geometry.scrollWidth > geometry.innerWidth) throw new Error(`${state}: the document scrolls to ${geometry.scrollWidth}px at ${geometry.innerWidth}px`);
  return { row: geometry.row, strip: geometry.strip, button: geometry.button };
}

async function checkSheetReach(page: Page, state: string): Promise<void> {
  const reach = await page.evaluate(() => {
    const confirm = document.querySelector("[data-orchestrator-confirm]");
    const rect = confirm?.getBoundingClientRect();
    return {
      height: rect ? Math.round(rect.height) : 0,
      bottom: rect ? Math.round(rect.bottom) : 0,
      viewport: window.innerHeight,
    };
  });
  if (reach.height < 44) throw new Error(`${state}: the sheet's primary action is ${reach.height}px tall`);
  if (reach.bottom > reach.viewport) throw new Error(`${state}: the sheet's primary action ends at ${reach.bottom}px, past the ${reach.viewport}px viewport`);
}

/**
 * The check that actually settles slice C's keyboard claim: the sheet holds a
 * large textarea and will be used with the keyboard OPEN, and iOS Safari's
 * keyboard leaves `window.innerHeight` at the full 844px while shrinking only
 * `visualViewport` — the exact path #983 repaired for the focus root. So the
 * mandate field is focused for real and the visual viewport is shrunk through
 * the very signal `useKeyboardInset` subscribes to (a `resize` on
 * `visualViewport`), then the confirm control is measured against what the
 * operator can SEE rather than against the layout viewport it sits behind.
 *
 * A sheet that ignored the signal reads bottom 844 against a visible 508 and
 * fails here; so does one that reached its confirm by scrolling the window.
 */
async function checkSheetKeyboardReach(page: Page, state: string): Promise<void> {
  await page.focus("[data-orchestrator-mandate]");
  await page.evaluate((keyboard) => {
    const visual = window.visualViewport!;
    const full = visual.height;
    Object.defineProperty(visual, "height", { configurable: true, get: () => full - keyboard });
    visual.dispatchEvent(new Event("resize"));
  }, KEYBOARD_PX);
  await page.waitForTimeout(300);
  const reach = await page.evaluate(() => {
    const visual = window.visualViewport!;
    const sheet = document.querySelector('[data-testid="mobile-orchestrator-sheet"]')!;
    const confirm = document.querySelector("[data-orchestrator-confirm]")!;
    const body = sheet.querySelector(".overflow-y-auto")!;
    const rect = confirm.getBoundingClientRect();
    return {
      focused: document.activeElement?.hasAttribute("data-orchestrator-mandate") ?? false,
      inset: Math.round(parseFloat(getComputedStyle(sheet.parentElement!).paddingBottom) || 0),
      bottom: Math.round(rect.bottom),
      visibleBottom: Math.round(visual.offsetTop + visual.height),
      layout: window.innerHeight,
      windowScroll: Math.round(window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
      bodyScrolls: getComputedStyle(body).overflowY,
    };
  });
  if (!reach.focused) throw new Error(`${state}: the mandate field never took focus, so the keyboard case was not exercised`);
  if (reach.inset < KEYBOARD_PX - 1) throw new Error(`${state}: the sheet reserved ${reach.inset}px for a ${KEYBOARD_PX}px keyboard`);
  if (reach.bottom > reach.visibleBottom) {
    throw new Error(`${state}: with the keyboard open the confirm ends at ${reach.bottom}px, under the keyboard — only ${reach.visibleBottom}px of the ${reach.layout}px viewport is visible`);
  }
  /* #983's other half: the browser must never have to scroll the WINDOW to
     reach the focused field — the sheet's own body is the one scroller. */
  if (reach.windowScroll !== 0) throw new Error(`${state}: the window scrolled to ${reach.windowScroll}px to reach the field`);
  if (reach.documentHeight > reach.layout) throw new Error(`${state}: the document grew to ${reach.documentHeight}px past the ${reach.layout}px viewport`);
  if (reach.bodyScrolls !== "auto" && reach.bodyScrolls !== "scroll") {
    throw new Error(`${state}: the sheet's body is not the scroller (overflow-y: ${reach.bodyScrolls})`);
  }
}

async function main(): Promise<void> {
  const port = demoPort(process.env.ORCH_CAPTURE_PORT, 4979, "ORCH_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  const repoRoot = path.resolve(import.meta.dir, "..");
  seedHome();
  /* `package.json`'s own start command: `bunx next start` hands the server to
     node, where the instrumentation hook dies on "SQLite state stores require
     the Bun runtime" and every request 500s. */
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    await waitForServer(baseUrl, server);
    const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: { project?: string; cwd?: string; path?: string; title?: string }[] };
    const owned = (scanned.files ?? []).filter((file) => file.cwd === REPO_DIR);
    const projectId = owned[0]?.project ?? "";
    const transcriptPath = owned.find((file) => (file.title ?? "").includes("Run the Atlas board"))?.path ?? "";
    if (!projectId || !transcriptPath) throw new Error("the seeded project did not scan");

    /* A seeded transcript has no process behind it, so a hosted state has to
       say so — otherwise every capture is the `resumable` one. */
    const hosted = { proc: "running", pid: 4_979 };
    const overLimit = { ctx: { usedTokens: 142_000, windowTokens: 200_000, pct: 71, source: "transcript", confidence: "reported", observedAt: "2100-01-02T11:59:00.000Z" } };
    const failedIntent = { clientRequestId: "seatreq-000003", mode: "spawn", launchId: null, error: "orchestrator cwd could not be resolved — pass cwd explicitly or set LLV_ORCHESTRATOR_CWD" };
    const states: { id: string; answer: SeatAnswer; patch?: Record<string, unknown>; open?: "row" | "marker"; edit?: boolean }[] = [
      { id: "row-draft", answer: { seat: null, pending: null, exists: true } },
      { id: "sheet-draft", answer: { seat: null, pending: null, exists: true }, open: "row" },
      { id: "sheet-draft-edited", answer: { seat: null, pending: null, exists: true }, open: "row", edit: true },
      {
        id: "row-creating",
        answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-000002", mode: "spawn", launchId: "launch-000002", error: null } }), exists: true },
      },
      {
        id: "sheet-creating",
        answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-000002", mode: "spawn", launchId: "launch-000002", error: null } }), exists: true },
        open: "row",
      },
      { id: "row-intent-error", answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: failedIntent }), exists: true } },
      { id: "sheet-intent-error", answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: failedIntent }), exists: true }, open: "row" },
      { id: "row-live", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: hosted },
      { id: "row-live-resumable", answer: { seat: seat(transcriptPath), pending: null, exists: true } },
      { id: "row-live-rotation", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: { ...hosted, ...overLimit } },
      {
        id: "row-transition-error",
        answer: { seat: seat(transcriptPath), pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: failedIntent }), exists: true },
        patch: hosted,
      },
      {
        id: "sheet-live-transition-error",
        answer: { seat: seat(transcriptPath), pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: failedIntent }), exists: true },
        patch: hosted,
        open: "marker",
      },
    ];

    for (const scheme of ["dark", "light"] as const) {
      for (const state of states) {
        const context = await browser.newContext({
          viewport: PHONE,
          colorScheme: scheme,
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        });
        await context.addInitScript(seedInit);
        await context.addInitScript(`localStorage.setItem("llvProject", ${JSON.stringify(projectId)});`);
        const page: Page = await context.newPage();
        await page.route("**/api/orchestrator/seat*", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.answer) }));
        if (state.patch) {
          const patch = state.patch;
          await page.route("**/api/files*", async (route) => {
            const response = await route.fetch();
            const body = await response.json() as { files?: Record<string, unknown>[] };
            for (const file of body.files ?? []) {
              if (file.path === transcriptPath) Object.assign(file, patch);
            }
            await route.fulfill({ response, body: JSON.stringify(body) });
          });
        }
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await page.waitForSelector("[data-orchestrator-row]", { timeout: 20_000 });
        const rowState = await page.getAttribute("[data-orchestrator-row]", "data-orchestrator-row-state");
        const geometry = await checkPhoneGeometry(page, `${state.id}/${scheme}`);
        if (state.open) {
          await page.click(state.open === "marker" ? "[data-orchestrator-row-transition-open]" : "[data-orchestrator-row-open]");
          await page.waitForSelector('[data-testid="mobile-orchestrator-sheet"]', { timeout: 10_000 });
          if (state.edit) {
            await page.fill("[data-orchestrator-mandate]", "You are the Atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.\n\n## What you do\n- one lane per issue, one owner per file\n- a fresh reviewer every round\n- merge only on APPROVE with green gates\n- never deploy red");
          }
          await page.waitForTimeout(400);
          await checkSheetReach(page, `${state.id}/${scheme}`);
          /* Every sheet that carries the mandate textarea is a sheet the
             operator types into, so each one is measured with the keyboard up
             and keeps its own frame as the evidence. */
          if (await page.$("[data-orchestrator-mandate]")) {
            await checkSheetKeyboardReach(page, `${state.id}/${scheme}`);
            const typing = path.join(OUT_DIR, `979-${state.id}-keyboard-${scheme}.png`);
            await page.screenshot({ path: typing });
            console.log(`${typing}  → confirm above a ${KEYBOARD_PX}px keyboard`);
            await page.evaluate(() => {
              const visual = window.visualViewport as unknown as Record<string, unknown>;
              delete visual.height;
              window.visualViewport!.dispatchEvent(new Event("resize"));
            });
            await page.waitForTimeout(200);
          }
        }
        await page.waitForTimeout(500);
        const shot = path.join(OUT_DIR, `979-${state.id}-${scheme}.png`);
        await page.screenshot({ path: shot });
        console.log(`${shot}  → ${rowState}  row ${geometry.row}px · strip ${geometry.strip}px · target ${geometry.button}px`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

/* Guarded so the resolver above can be imported by its own test without
   launching a browser and erasing the capture root. */
if (import.meta.main) await main();
