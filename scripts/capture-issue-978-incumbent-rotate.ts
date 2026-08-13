/**
 * Rendered verification of the #978 incumbent header and rotate flow:
 *
 *   bun run build && bun scripts/capture-issue-978-incumbent-rotate.ts
 *
 * Slice B's whole claim is visual — «the operator can SEE who holds the seat and
 * that the server wants it rotated» — so it is settled by a frame, not by a
 * test. Same recipe as `capture-issue-977-orchestrator-panel.ts`: the production
 * build is served against a purpose-built synthetic home under /tmp (never the
 * operator's live state, and no real home path or account in any frame), and
 * each state is driven by answering the seat and status routes in flight.
 * Everything else — layout, tokens, the real feed and composer — is the
 * production render.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/978-<state>-<scheme>.png
 *
 * States: the incumbent header on a healthy seat, an estimated context reading,
 * the server's rotation recommendation (strong and soft), the rotate draft
 * prefilled from the incumbent, a rotation that failed with its retry, and the
 * successor with its predecessor linked.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { demoPort } from "./demo-capture";

const BASE = process.env.ORCH_CAPTURE_DIR ?? "/tmp/llv-issue-978";
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
  { id: "00000978", title: "Run the Atlas board", agoMinutes: 3 },
  { id: "00000979", title: "Rotate: run the Atlas board", agoMinutes: 1 },
];

/* Invented names, and the only ones any frame can show — the seeded home has no
   signed-in accounts, so nothing real can reach the account picker. */
const ACCOUNTS = {
  claude: { active: "team", accounts: [{ id: "team", label: "team", authPresent: true }, { id: "spare", label: "spare", authPresent: true }] },
  codex: { active: "codex-team", accounts: [{ id: "codex-team", label: "codex-team", authPresent: true }] },
};

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

const MANDATE = "You are the Atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.\n\n## What you do\n- one lane per issue, one owner per file\n- a fresh reviewer every round\n- merge only on APPROVE with green gates\n- never deploy red";

function seat(transcriptPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas",
    seatEpoch: 3,
    conversationId: "conversation_atlas_orchestrator",
    path: transcriptPath,
    mandate: MANDATE,
    promptVersion: 4,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "seatreq-000001", mode: "spawn", launchId: "launch-000001", error: null },
    designatedAt: "2100-01-02T11:00:00.000Z",
    activatedAt: "2100-01-02T11:00:02.000Z",
    ...overrides,
  };
}

/** `GET /api/orchestrator/seat/status`, the reading the header renders. */
function incumbent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas",
    designated: true,
    conversationId: "conversation_atlas_orchestrator",
    predecessorConversationId: null,
    engine: "claude",
    model: "opus",
    effort: "high",
    accountId: "team",
    cwd: REPO_DIR,
    transcriptFacts: { bytes: 2_100_000, messageCount: 812, toolCount: 1_930, compactionCount: 0 },
    context: { tokens: 240_000, limit: 1_000_000, percent: 24, estimated: false, basis: "provider-reported usage from the transcript's newest turn", policy: "claude-opus-1m" },
    rotation: { recommended: false, level: "none", advisory: null, reasons: [], threshold: null, thresholdUnknown: false },
    ...overrides,
  };
}

function recommending(level: "recommend" | "strongly_recommend", reasons: string[]): Record<string, unknown> {
  return {
    recommended: true,
    level,
    advisory: level === "strongly_recommend" ? "STRONGLY_RECOMMEND_ROTATION" : null,
    reasons,
    threshold: { windowTokens: 1_000_000, thresholdTokens: 500_000, fraction: 0.5, policy: "claude-opus-1m" },
    thresholdUnknown: false,
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

interface CaptureState {
  id: string;
  answer: SeatAnswer;
  status: Record<string, unknown>;
  /** Overlay for the seat conversation's own scanned card. */
  patch?: Record<string, unknown>;
  /** Press Rotate and settle on the draft before shooting. */
  rotate?: boolean;
  /** Confirm the rotation too, so the frame carries the route's refusal. */
  confirmRotation?: boolean;
  /** What `POST /api/orchestrator/rotate` answers, when it is called. */
  rotateReply?: { status: number; body: Record<string, unknown> };
}

async function main(): Promise<void> {
  const port = demoPort(process.env.ORCH_CAPTURE_PORT, 4978, "ORCH_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  const repoRoot = path.resolve(import.meta.dir, "..");
  seedHome();
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
    const transcriptPath = owned.find((file) => (file.title ?? "").includes("Run the Atlas board"))?.path ?? "";
    const successorPath = owned.find((file) => (file.title ?? "").includes("Rotate:"))?.path ?? "";
    if (!projectId || !transcriptPath || !successorPath) throw new Error("the seeded project did not scan");

    /* A seeded transcript has no process behind it, so a hosted state has to say
       so — otherwise every capture is the `resumable` one. */
    const hosted = { proc: "running", pid: 4_978 };
    const live: SeatAnswer = { seat: seat(transcriptPath), pending: null, exists: true };
    const states: CaptureState[] = [
      { id: "incumbent", answer: live, status: incumbent(), patch: hosted },
      {
        id: "incumbent-estimated",
        answer: live,
        status: incumbent({
          context: { tokens: 525_000, limit: 1_000_000, percent: 53, estimated: true, basis: "ESTIMATE: transcript bytes / 4 — no provider-reported usage found", policy: "claude-opus-1m" },
          rotation: recommending("strongly_recommend", ["context usage 525,000 tokens (estimate) has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)"]),
        }),
        patch: hosted,
      },
      {
        id: "rotation-recommended",
        answer: live,
        status: incumbent({
          context: { tokens: 620_000, limit: 1_000_000, percent: 62, estimated: false, basis: "provider-reported usage from the transcript's newest turn", policy: "claude-opus-1m" },
          rotation: recommending("strongly_recommend", ["context usage 620,000 tokens has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)"]),
        }),
        patch: hosted,
      },
      {
        id: "rotation-soft",
        answer: live,
        status: incumbent({
          transcriptFacts: { bytes: 9_800_000, messageCount: 2_400, toolCount: 6_100, compactionCount: 3 },
          rotation: recommending("recommend", [
            "3 compaction(s) recorded in the transcript, threshold 2",
            "transcript is 9.3 MB, threshold 8 MB",
          ]),
        }),
        patch: hosted,
      },
      { id: "rotate-draft", answer: live, status: incumbent(), patch: hosted, rotate: true },
      {
        id: "rotate-error",
        answer: live,
        status: incumbent(),
        patch: hosted,
        rotate: true,
        confirmRotation: true,
        rotateReply: { status: 400, body: { error: "orchestrator cwd could not be resolved — pass cwd explicitly or set LLV_ORCHESTRATOR_CWD" } },
      },
      {
        id: "successor",
        answer: {
          seat: seat(successorPath, {
            seatEpoch: 4,
            conversationId: "conversation_atlas_successor",
            predecessorConversationId: "conversation_atlas_orchestrator",
            intent: { clientRequestId: "seatreq-000002", mode: "spawn", launchId: "launch-000002", error: null },
          }),
          pending: null,
          exists: true,
        },
        status: incumbent({
          conversationId: "conversation_atlas_successor",
          predecessorConversationId: "conversation_atlas_orchestrator",
          context: { tokens: 18_000, limit: 1_000_000, percent: 2, estimated: false, basis: "provider-reported usage from the transcript's newest turn", policy: "claude-opus-1m" },
        }),
        patch: hosted,
        /* The successor's own card is the one the panel opens now. */
      },
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
        /* Synthetic accounts: the seeded home has none, and the pickers are part
           of what this frame has to show. */
        await page.route("**/api/accounts", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ACCOUNTS) }));
        await page.route("**/api/orchestrator/seat/status*", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.status) }));
        await page.route("**/api/orchestrator/seat?*", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.answer) }));
        const reply = state.rotateReply;
        if (reply) {
          await page.route("**/api/orchestrator/rotate", (route) =>
            route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) }));
        }
        const patch = state.patch;
        if (patch) {
          const seatPath = state.answer.seat?.path as string;
          await page.route("**/api/files*", async (route) => {
            const response = await route.fetch();
            const body = await response.json() as { files?: Record<string, unknown>[] };
            for (const file of body.files ?? []) {
              if (file.path === seatPath) Object.assign(file, patch);
            }
            await route.fulfill({ response, body: JSON.stringify(body) });
          });
        }
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await page.waitForSelector("[data-orchestrator-incumbent]", { timeout: 20_000 });
        if (state.rotate) {
          await page.click("[data-orchestrator-rotate]");
          await page.waitForSelector('[data-orchestrator-draft="rotate"]', { timeout: 10_000 });
        }
        if (state.confirmRotation) {
          await page.click("[data-orchestrator-confirm]");
          await page.waitForSelector("[data-orchestrator-intent-error]", { timeout: 10_000 });
        }
        await page.waitForTimeout(900);
        const shot = path.join(OUT_DIR, `978-${state.id}-${scheme}.png`);
        await page.screenshot({ path: shot });

        const facts = await page.evaluate(() => {
          const panel = document.querySelector("[data-orchestrator-panel]");
          const row = document.querySelector("[data-orchestrator-incumbent]");
          const dock = document.querySelector("[data-orchestrator-dock]");
          const board = document.querySelector("main");
          return {
            state: panel?.getAttribute("data-orchestrator-state") ?? "",
            mode: panel?.getAttribute("data-orchestrator-mode") ?? "",
            rotation: document.querySelector("[data-orchestrator-rotation]")?.getAttribute("data-orchestrator-rotation") ?? "none",
            context: row?.querySelector("[data-orchestrator-context]")?.getAttribute("data-orchestrator-context") ?? "",
            predecessor: Boolean(document.querySelector("[data-orchestrator-predecessor]")),
            /* The row must survive the dock's narrowest usable width without
               pushing the Rotate button out of the panel. */
            rowOverflows: row ? row.scrollWidth > row.clientWidth + 1 : false,
            dock: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
            board: board ? Math.round(board.getBoundingClientRect().width) : 0,
          };
        });
        if (facts.rowOverflows) throw new Error(`the incumbent row overflowed the dock in ${state.id}`);
        if (facts.dock !== 440) throw new Error(`the dock resolved to ${facts.dock}px, not its stored 440`);
        if (facts.board < 320) throw new Error(`the board fell to ${facts.board}px, under its 320px floor`);
        console.log(`${shot}  → ${facts.state}/${facts.mode}  rotation ${facts.rotation}  ctx ${facts.context}%  predecessor ${facts.predecessor}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
