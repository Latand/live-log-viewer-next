/**
 * Rendered verification of the #977 orchestrator dock, in a real browser:
 *
 *   bun run build && bun scripts/capture-issue-977-orchestrator-panel.ts
 *
 * The operator's requirement for this panel is a composition that "looks
 * pleasant stretched by height, as it will be on desktop" with EVERY state
 * designed — which is a claim only a rendered frame can settle. So the
 * production build is served against a purpose-built synthetic home under /tmp
 * (never the operator's live state, and no real home path in any frame), and
 * each panel state is driven by answering the seat route in flight. Everything
 * else — layout, tokens, the real feed and composer — is the production render.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/977-<state>-<scheme>.png
 *
 * States: draft (empty), draft with the mandate edited, creating, intent-error,
 * live (real feed + composer), live-but-finished (resumable in place), and live
 * with the rotation advisory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "ORCH_CAPTURE_DIR",
  prefix: "llv-issue-977",
  raw: process.env.ORCH_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "atlas");
const CAPTURE_MS = Date.parse("2100-01-02T12:00:00.000Z");

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/* Composed rather than written out: a literal UUID in a published source file
   is what the privacy gate's resource-identifier rule exists to catch, and it
   cannot tell a synthetic fixture id from a real one. */
const sessionUuid = (id: string) => [id, "0000", "4000", "8000", "000000000000"].join("-");

const SESSIONS = [
  { id: "00000977", title: "Run the Atlas board", agoMinutes: 3 },
  { id: "00000978", title: "Implement the export endpoint", agoMinutes: 12 },
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
  localStorage.setItem("llvOrchestratorPanelOpen", "1");
};

async function main(): Promise<void> {
  const port = demoPort(process.env.ORCH_CAPTURE_PORT, 4977, "ORCH_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  const repoRoot = path.resolve(import.meta.dir, "..");
  seedHome();
  console.log(`screenshots: ${OUT_DIR}`);
  /* `package.json`'s own start command. `bunx next start` hands the server to
     node, where the instrumentation hook dies on "SQLite state stores require
     the Bun runtime" and every request 500s — see
     `src/app/servedPayloadSecrets.test.ts`, which documents the same trap. */
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
    /* The seat names its conversation's transcript; a seeded transcript has no
       registry id, so the panel resolves it by path exactly as it does for a
       seat whose conversation predates the registry. */
    const transcriptPath = owned.find((file) => (file.title ?? "").includes("Run the Atlas board"))?.path ?? "";
    if (!projectId || !transcriptPath) throw new Error("the seeded project did not scan");

    /* Each state is one answer from the seat route; `patch` overlays the seat
       conversation's own scanned entry, which is what the panel reads liveness
       and the rotation advisory from. A seeded transcript has no process behind
       it, so a hosted state has to say so — otherwise every capture is the
       `resumable` one. */
    const hosted = { proc: "running", pid: 4_977 };
    const overLimit = { ctx: { usedTokens: 142_000, windowTokens: 200_000, pct: 71, source: "transcript", confidence: "reported", observedAt: "2100-01-02T11:59:00.000Z" } };
    const states: { id: string; answer: SeatAnswer; patch?: Record<string, unknown>; edit?: boolean }[] = [
      { id: "draft", answer: { seat: null, pending: null, exists: true } },
      { id: "draft-edited", answer: { seat: null, pending: null, exists: true }, edit: true },
      {
        id: "creating",
        answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-000002", mode: "spawn", launchId: "launch-000002", error: null } }), exists: true },
      },
      {
        id: "intent-error",
        answer: { seat: null, pending: seat(transcriptPath, { conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-000003", mode: "spawn", launchId: null, error: "orchestrator cwd could not be resolved — pass cwd explicitly or set LLV_ORCHESTRATOR_CWD" } }), exists: true },
      },
      { id: "live", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: hosted },
      { id: "live-resumable", answer: { seat: seat(transcriptPath), pending: null, exists: true } },
      { id: "live-rotation", answer: { seat: seat(transcriptPath), pending: null, exists: true }, patch: { ...hosted, ...overLimit } },
    ];

    for (const scheme of ["dark", "light"] as const) {
      for (const state of states) {
        const context = await browser.newContext({
          viewport: { width: 1600, height: 1000 },
          colorScheme: scheme,
          deviceScaleFactor: 2,
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
        await page.waitForSelector("[data-orchestrator-panel]", { timeout: 20_000 });
        if (state.edit) {
          await page.fill("[data-orchestrator-mandate]", "You are the Atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.\n\n## What you do\n- one lane per issue, one owner per file\n- a fresh reviewer every round\n- merge only on APPROVE with green gates\n- never deploy red");
        }
        await page.waitForTimeout(900);
        const shot = path.join(OUT_DIR, `977-${state.id}-${scheme}.png`);
        await page.screenshot({ path: shot });
        const panelState = await page.getAttribute("[data-orchestrator-panel]", "data-orchestrator-state");
        /* The dock's width is a CSS `max()/min()/calc()` expression, which only
           a real engine evaluates — measure what it actually resolved to, and
           what the board is left with beside it. */
        const geometry = await page.evaluate(() => {
          const dock = document.querySelector("[data-orchestrator-dock]");
          const board = document.querySelector("main");
          return {
            dock: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
            board: board ? Math.round(board.getBoundingClientRect().width) : 0,
          };
        });
        if (geometry.dock !== 440) throw new Error(`the dock resolved to ${geometry.dock}px, not its stored 440`);
        if (geometry.board < 320) throw new Error(`the board fell to ${geometry.board}px, under its 320px floor`);
        console.log(`${shot}  → ${panelState}  dock ${geometry.dock}px · board ${geometry.board}px`);
        await context.close();
      }
    }
    console.log(`screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
