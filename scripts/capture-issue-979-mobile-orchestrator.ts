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
 * Each run allocates its own directory under the temp root (`ORCH_CAPTURE_DIR`
 * selects the parent, nothing else), so shots land outside the repository and
 * no run can overwrite another's:
 *
 *   <tmp>/llv-issue-979-latest/out/979-<state>-<scheme>.png
 *
 * Every shot also CHECKS what it is showing: the card keeps its 44px target and
 * leads the surface it sits on, the phone never grows a horizontal scrollbar
 * (#353), and the sheet's confirm control stays inside the viewport.
 *
 * Issue #1347 adds the seat's CONTROLS to the same run: a live card's second
 * target (the ⚙, measured like the card's own), the sheet it opens with Rotate
 * inside the viewport, and the rotate draft — which carries the mandate
 * textarea, so it is measured with the keyboard open exactly as the create
 * draft is.
 *
 * Mobile v2 lane 6 moved the subject and this script moved with it. Two claims
 * were written against a surface that no longer exists — the pin sitting left
 * of the first conversation chip, and the strip row's 56 px ceiling — because
 * lane 3 removed the strip and its chips outright, which left the chip check
 * failing on `chips === 0`. Both are re-expressed against what the seat is
 * now: the FIRST CARD on the board (README §4.1), ahead of every conversation
 * row and not pushing the board's own first row past the fold. The two claims
 * the lane's acceptance names — Rotate stays reachable, the mandate stays
 * above the fold with the keyboard open — are unchanged and still measured
 * live.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

/* One fresh capture-owned directory per run, allocated by the shared module
   (#996): an override only selects the PARENT, and a typo'd `ORCH_CAPTURE_DIR`
   is refused by name before anything is written — nothing here ever clears a
   directory it did not create. The stable `-latest` symlink is what keeps the
   frames findable now that each run's leaf is randomised. */
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "ORCH_CAPTURE_DIR",
  prefix: "llv-issue-979",
  raw: process.env.ORCH_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
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
async function checkPhoneGeometry(page: Page, state: string): Promise<{ card: number; firstRow: number; button: number }> {
  const geometry = await page.evaluate(() => {
    const card = document.querySelector("[data-mobile2-seat-card]");
    const button = document.querySelector("[data-mobile2-seat-open]");
    const controls = document.querySelector("[data-mobile2-seat-controls]");
    /* What the seat leads: the board's own sections. The first row is the one
       the card must be ahead of, and must not push off the screen. */
    const rows = [...document.querySelectorAll("[data-mobile2-row]")];
    const cardRect = card?.getBoundingClientRect();
    const firstRowRect = rows[0]?.getBoundingClientRect();
    const controlsRect = controls?.getBoundingClientRect();
    return {
      card: cardRect ? Math.round(cardRect.height) : 0,
      cardTop: cardRect ? Math.round(cardRect.top) : -1,
      cardRight: cardRect ? Math.round(cardRect.right) : -1,
      rows: rows.length,
      firstRowTop: firstRowRect ? Math.round(firstRowRect.top) : -1,
      firstRowBottom: firstRowRect ? Math.round(firstRowRect.bottom) : -1,
      button: button ? Math.round(button.getBoundingClientRect().height) : 0,
      controls: controlsRect ? { height: Math.round(controlsRect.height), width: Math.round(controlsRect.width), left: Math.round(controlsRect.left), right: Math.round(controlsRect.right) } : null,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
  if (geometry.button < 44) throw new Error(`${state}: the card's tap target is ${geometry.button}px, under the 44px floor`);
  if (geometry.cardTop < 0 || geometry.cardRight > geometry.innerWidth) {
    throw new Error(`${state}: the seat card sits at ${geometry.cardTop}…${geometry.cardRight}px, outside the ${geometry.innerWidth}px viewport`);
  }
  /* The seat's controls (#1347): a live card's second target is held to the
     same bar as its first — a phone target, inside the viewport. */
  if (geometry.controls) {
    if (geometry.controls.height < 44 || geometry.controls.width < 44) {
      throw new Error(`${state}: the controls entry point is ${geometry.controls.width}×${geometry.controls.height}px, under the 44px floor`);
    }
    if (geometry.controls.right > geometry.innerWidth) throw new Error(`${state}: the controls entry point ends at ${geometry.controls.right}px, past the ${geometry.innerWidth}px viewport`);
  }
  /* «The seat is first» means nothing without a row to be first of: a board
     that drew none would otherwise pass this check by default (README §4.1,
     PRD #976 decision 5). */
  if (geometry.rows === 0) throw new Error(`${state}: the board drew no rows, so the card's position proves nothing`);
  if (geometry.cardTop >= geometry.firstRowTop) {
    throw new Error(`${state}: the seat card starts at ${geometry.cardTop}px, not before the board's first row at ${geometry.firstRowTop}px`);
  }
  /* What #419's budget asked of the pin — «do not eat the surface you lead» —
     moved with the seat (mobile v2 §3.4, §4.1): it is a card on the board now,
     so what it must not do is push the board's own first row past the fold. */
  if (geometry.firstRowBottom > geometry.innerHeight) {
    throw new Error(`${state}: the seat card is ${geometry.card}px and pushes the board's first row to ${geometry.firstRowBottom}px, past the ${geometry.innerHeight}px fold`);
  }
  /* The mobile overflow contract (#353): the document never scrolls sideways. */
  if (geometry.scrollWidth > geometry.innerWidth) throw new Error(`${state}: the document scrolls to ${geometry.scrollWidth}px at ${geometry.innerWidth}px`);
  return { card: geometry.card, firstRow: geometry.firstRowBottom, button: geometry.button };
}

/** Rotate on the live sheet (#1347): a phone target, inside the viewport. */
async function checkRotateReach(page: Page, state: string): Promise<void> {
  const reach = await page.evaluate(() => {
    const rotate = document.querySelector("[data-orchestrator-rotate]");
    const rect = rotate?.getBoundingClientRect();
    return {
      present: Boolean(rotate),
      height: rect ? Math.round(rect.height) : 0,
      right: rect ? Math.round(rect.right) : 0,
      bottom: rect ? Math.round(rect.bottom) : 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      identity: Boolean(document.querySelector("[data-orchestrator-incumbent]")),
    };
  });
  if (!reach.present) throw new Error(`${state}: the live sheet offers no Rotate control`);
  if (!reach.identity) throw new Error(`${state}: the live sheet does not name the incumbent`);
  if (reach.height < 44) throw new Error(`${state}: Rotate is ${reach.height}px tall`);
  if (reach.right > reach.viewportWidth || reach.bottom > reach.viewportHeight) {
    throw new Error(`${state}: Rotate ends at ${reach.right}×${reach.bottom}px, outside the ${reach.viewportWidth}×${reach.viewportHeight}px viewport`);
  }
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
 *
 * Reaching the confirm was never the whole claim, though (#1004): the field
 * being typed INTO has to be on screen too. The body scroller keeps its own
 * fold — an intent error's card plus engine/account/reasoning can fill it
 * entirely and clip the mandate away below — so the focused field is measured
 * against the nearer of the two edges that can hide it, the scroller's bottom
 * and the keyboard's top, and against the scroller's top edge that a reveal
 * could overshoot past.
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
    const field = document.querySelector("[data-orchestrator-mandate]")!;
    const rect = confirm.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const fieldStyle = getComputedStyle(field);
    return {
      focused: document.activeElement?.hasAttribute("data-orchestrator-mandate") ?? false,
      inset: Math.round(parseFloat(getComputedStyle(sheet.parentElement!).paddingBottom) || 0),
      bottom: Math.round(rect.bottom),
      visibleBottom: Math.round(visual.offsetTop + visual.height),
      layout: window.innerHeight,
      windowScroll: Math.round(window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
      bodyScrolls: getComputedStyle(body).overflowY,
      fieldTop: Math.round(fieldRect.top),
      /* Chrome resolves a unitless line-height to px here; the font size is the
         fallback for a `normal` that does not parse, and still measures a line. */
      fieldLine: Math.round(parseFloat(fieldStyle.lineHeight) || parseFloat(fieldStyle.fontSize)),
      scrollerTop: Math.round(bodyRect.top),
      scrollerBottom: Math.round(bodyRect.bottom),
    };
  });
  if (!reach.focused) throw new Error(`${state}: the mandate field never took focus, so the keyboard case was not exercised`);
  if (reach.inset < KEYBOARD_PX - 1) throw new Error(`${state}: the sheet reserved ${reach.inset}px for a ${KEYBOARD_PX}px keyboard`);
  if (reach.bottom > reach.visibleBottom) {
    throw new Error(`${state}: with the keyboard open the confirm ends at ${reach.bottom}px, under the keyboard — only ${reach.visibleBottom}px of the ${reach.layout}px viewport is visible`);
  }
  /* #1004: the focused field's first line, above whichever fold comes first. */
  const fold = Math.min(reach.scrollerBottom, reach.visibleBottom);
  if (reach.fieldTop + reach.fieldLine > fold) {
    throw new Error(`${state}: with the keyboard open the focused mandate field starts at ${reach.fieldTop}px and its first line ends past the ${fold}px fold (scroller ${reach.scrollerBottom}px, keyboard ${reach.visibleBottom}px) — the operator types into a field they cannot see`);
  }
  if (reach.fieldTop < reach.scrollerTop) {
    throw new Error(`${state}: the focused mandate field starts at ${reach.fieldTop}px, above the scroller's own top edge at ${reach.scrollerTop}px, so its first line is clipped`);
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
  seedHome();
  /* `package.json`'s own start command: `bunx next start` hands the server to
     node, where the instrumentation hook dies on "SQLite state stores require
     the Bun runtime" and every request 500s. */
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    await waitForServer(baseUrl, server);
    console.log(`screenshots: ${OUT_DIR}`);
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
    /* `GET /api/orchestrator/seat/status` for the live states: the incumbent
       the sheet names and the rotate draft prefills from (#1347). */
    const incumbent = {
      project: "atlas", designated: true, conversationId: "conversation_atlas_orchestrator", predecessorConversationId: "conversation_atlas_predecessor",
      engine: "claude", model: "opus", effort: "high", accountId: null, cwd: REPO_DIR, transcriptPath,
      liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 },
      context: { tokens: 24_000, limit: 100_000, percent: 24, estimated: false, basis: "provider-reported usage" },
      transcriptFacts: { bytes: 4_096, messageCount: 12, toolCount: 3, compactionCount: 0 },
      rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    };
    const states: { id: string; answer: SeatAnswer; patch?: Record<string, unknown>; open?: "row" | "marker" | "controls"; edit?: boolean; rotate?: boolean }[] = [
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
      /* #1347: the seat's controls, from the row's second target. */
      { id: "sheet-live-controls", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: hosted, open: "controls" },
      { id: "sheet-rotate", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: hosted, open: "controls", rotate: true },
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
        await page.route("**/api/orchestrator/seat/status*", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(incumbent) }));
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
        await page.waitForSelector("[data-mobile2-seat-card]", { timeout: 20_000 });
        const seatState = await page.getAttribute("[data-mobile2-seat-card]", "data-mobile2-seat-state");
        const geometry = await checkPhoneGeometry(page, `${state.id}/${scheme}`);
        if (state.open) {
          await page.click(
            state.open === "marker"
              ? "[data-mobile2-seat-transition-open]"
              : state.open === "controls"
                ? "[data-mobile2-seat-controls]"
                : "[data-mobile2-seat-open]",
          );
          await page.waitForSelector('[data-testid="mobile-orchestrator-sheet"]', { timeout: 10_000 });
          if (state.open === "controls") {
            await page.waitForSelector("[data-orchestrator-rotate]", { timeout: 10_000 });
            await checkRotateReach(page, `${state.id}/${scheme}`);
          }
          if (state.rotate) {
            await page.click("[data-orchestrator-rotate]");
            await page.waitForSelector('[data-orchestrator-draft="rotate"]', { timeout: 10_000 });
          }
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
        console.log(`${shot}  → ${seatState}  card ${geometry.card}px · first row ends ${geometry.firstRow}px · target ${geometry.button}px`);
        await context.close();
      }
    }
    console.log(`screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

/* Guarded so the resolver above can be imported by its own test without
   launching a browser and erasing the capture root. */
if (import.meta.main) await main();
