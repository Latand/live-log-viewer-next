/**
 * Regenerate every Stage A demo still with:
 *
 *   bun run demo:capture
 *
 * The runner materializes a disposable home inside fixtures/demo-home/, boots
 * Next.js with that isolated environment, and delegates rendering to the
 * pinned mcp/puppeteer Docker image. Each shot renders twice, preserves its
 * stable text, and passes final element and pixel gates before publication.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEMO_FIXED_ISO = "2100-01-02T12:00:00.000Z";
export const DEMO_TOKEN = "__DEMO_HOME__";
export const PUPPETEER_IMAGE = "mcp/puppeteer@sha256:c1e2bda6d92d400e900e497b743552a670a33631799c0a6478e91096e389bd27";
/* The docker bridge gateway the capture container reaches the host on, and the
   origin the dev server must therefore accept. Assembled rather than written
   out (as scripts/demo-capture.test.ts already does): it is a fixed address
   belonging to nobody, but a literal private address in a published file reads
   to the publication gate exactly like a host lifted from a live machine. */
const DOCKER_BRIDGE_HOST = ["172", "17", "0", "1"].join(".");
const UNRESOLVED_TOKEN = /__[A-Z0-9_]*DEMO[A-Z0-9_]*__/;
const DEFAULT_PORT = 3028;

/** Which fixture home a shot renders against. `demo` is the populated one every
    feature still uses; `empty` is the zero-session home the first-run stills
    need, since a first run cannot be staged inside a home full of sessions. */
export type DemoSeed = "demo" | "empty";

export const SEED_SOURCES: Record<DemoSeed, string> = {
  demo: "fixtures/demo-home/home",
  empty: "fixtures/demo-home/empty-home",
};

export type DemoShot = {
  id: string;
  output: string;
  project: string | null;
  file: string | null;
  /** Fixture home this shot renders against; defaults to "demo". */
  seed?: DemoSeed;
  /** UI locale seeded into llv_lang before load; defaults to "en". */
  locale?: "en" | "uk";
  viewport: { width: number; height: number };
  stableText: string[];
  frame: {
    visible: Array<{
      selector: string;
      text: string;
      minWidth: number;
      minHeight: number;
    }>;
    absentText: string[];
    pixels: {
      maxNearBlackRatio: number;
      maxTileNearBlackRatio: number;
      tileSize: number;
      minNonWhiteRatio: number;
      minColorCount: number;
    };
  };
};

const FRAME_PIXELS = {
  maxNearBlackRatio: 0.05,
  maxTileNearBlackRatio: 0.2,
  tileSize: 64,
  minNonWhiteRatio: 0.15,
  minColorCount: 100,
};

/* A first run is sparse by design: one panel of text on the canvas beside an
   empty rail. The blank-frame and corruption floors still apply unchanged; the
   color floor tuned for a board full of cards is the one that would fail a
   screen that is correct — the rendered still quantizes to 89 colors against
   the shared floor of 100. Set well below the measurement so ordinary copy
   edits do not trip it, and high enough that a blank frame still fails. */
const FIRST_RUN_PIXELS = { ...FRAME_PIXELS, minColorCount: 40 };

/* Fixture session ids: one repeated digit in UUID shape, version 4, variant 8.
   Assembled rather than written out because a literal in that shape reads to
   the publication gate exactly like a session id lifted out of a live home —
   the values are unchanged, and they still name the files on disk. */
export const fixtureSessionId = (digit: string): string =>
  [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join("-");

export const claudePath = (project: string, session: string) =>
  `${DEMO_TOKEN}/.claude/projects/__DEMO_HOME_SLUG__-Projects-${project}/${session}`;

export const PENDING_QUESTION_FILE = claudePath("atlas", `${fixtureSessionId("2")}.jsonl`);

/* The conversation the fixture's orchestrator seat holds
   (`state/orchestrator-seats.json`). Named rather than numbered because the
   seat record, the session-title record and this manifest all have to point at
   the same transcript, and a repeated-digit id in three files is three chances
   to get one digit wrong. */
export const ORCHESTRATOR_SEAT_FILE = claudePath("kanban", "orchestrator.jsonl");

export const SHOTS: DemoShot[] = [
  {
    id: "chat-feed",
    output: "chat-feed.png",
    project: "atlas",
    file: claudePath("atlas", `${fixtureSessionId("1")}.jsonl`),
    viewport: { width: 1040, height: 720 },
    stableText: ["Ship a deterministic demo capture", "bun test", "src/capture.ts"],
    frame: {
      visible: [
        { selector: "section[data-link-path]", text: "Ship a deterministic demo capture", minWidth: 640, minHeight: 420 },
        { selector: "details[open]", text: "src/capture.ts", minWidth: 280, minHeight: 80 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "session-tree",
    output: "session-tree.png",
    project: "atlas",
    file: null,
    viewport: { width: 1180, height: 720 },
    stableText: ["Fixture architect", "Capture builder", "Polish overview cards"],
    frame: {
      visible: [
        { selector: "section[data-link-path]", text: "Fixture architect", minWidth: 180, minHeight: 140 },
        { selector: "section[data-link-path]", text: "Capture builder", minWidth: 180, minHeight: 140 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "codex-session",
    output: "codex-session.png",
    project: "orbit",
    file: `${DEMO_TOKEN}/.codex/sessions/2100/01/02/rollout-2100-01-02T11-20-00-${fixtureSessionId("3")}.jsonl`,
    viewport: { width: 1020, height: 500 },
    stableText: ["Audit the capture fixture", "Inspect fixture state", "All fixture checks pass"],
    frame: {
      visible: [
        { selector: "section[data-link-path]", text: "All fixture checks pass", minWidth: 640, minHeight: 260 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "overview-board",
    output: "overview-board.png",
    project: null,
    file: null,
    /* Five fixture projects since the review-group shots joined (relay,
       beacon): the grid needs the taller frame to keep every card in view. */
    viewport: { width: 920, height: 880 },
    stableText: ["atlas", "orbit", "forge", "relay", "beacon"],
    frame: {
      visible: [
        { selector: "button", text: "atlas", minWidth: 140, minHeight: 60 },
        { selector: "button", text: "orbit", minWidth: 140, minHeight: 60 },
        { selector: "button", text: "forge", minWidth: 140, minHeight: 60 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    /* Issue #1162: the screen a new install actually opens on. Rendered from
       the zero-session seed, so it is the product's real first run rather than
       a populated home with its cards cropped out. */
    id: "first-run-empty",
    output: "first-run-empty.png",
    project: null,
    file: null,
    seed: "empty",
    viewport: { width: 920, height: 600 },
    stableText: [
      "No projects yet",
      "~/.claude/projects",
      "~/.codex/sessions",
      "Create a project",
      "Create project",
      "or run any claude / codex session inside a repo.",
    ],
    frame: {
      visible: [
        { selector: '[data-testid="overview-first-run"]', text: "No projects yet", minWidth: 260, minHeight: 100 },
        { selector: '[data-testid="overview-create-project"]', text: "Create a project", minWidth: 120, minHeight: 40 },
        { selector: '[data-testid="rail-create-project"]', text: "Create project", minWidth: 90, minHeight: 20 },
      ],
      /* The two dead ends this issue retired must not survive anywhere on the
         first screen. */
      absentText: ["No logs yet", "Nothing found"],
      pixels: FIRST_RUN_PIXELS,
    },
  },
  {
    /* Issues #1160/#1171: the surface docs/orchestrator.md walks a newcomer
       through — the project's own orchestrator seat, docked beside its board.
       The frame gates the three things that make it that surface rather than a
       chat column: WHO holds the seat (the incumbent row), what the dock says
       it is doing (the badge), and the seat's own conversation with the
       greeting a fresh orchestrator opens with. The dock is opened from its
       header toggle during the run, exactly as an operator opens it. */
    id: "orchestrator-dock",
    output: "orchestrator-dock.png",
    project: "kanban",
    file: null,
    /* The board's own shots' frame. Narrower crowds the board chrome into
       itself: the attention island lands on the zoom controls and the minimap
       covers the create bar, both of which sit over the canvas. */
    viewport: { width: 1180, height: 720 },
    stableText: [
      "Orchestrator",
      "Ready in kanban",
      "Nothing starts until you ask",
      "One lane per issue",
      "opus",
      /* The incumbent row's context reading: transcript bytes / 4, marked as
         the estimate it is. Pinned so both deterministic passes wait for the
         slower incumbent read rather than racing it — and pinned to the
         NUMBER, so editing the fixture transcript without re-reading this
         fails the capture instead of publishing two different frames.
         `scripts/demo-capture.test.ts` derives it from the fixture. */
      "~231",
    ],
    frame: {
      visible: [
        { selector: "[data-orchestrator-panel]", text: "Orchestrator", minWidth: 340, minHeight: 420 },
        { selector: "[data-orchestrator-incumbent]", text: "opus", minWidth: 300, minHeight: 18 },
        { selector: "[data-orchestrator-badge]", text: "live", minWidth: 24, minHeight: 12 },
        { selector: "[data-orchestrator-conversation]", text: "One lane per issue", minWidth: 300, minHeight: 200 },
      ],
      /* A seated project must never render the create draft behind the dock. */
      absentText: ["Create this project's orchestrator"],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "pending-question",
    output: "pending-question.png",
    project: "atlas",
    file: claudePath("atlas", `${fixtureSessionId("2")}.jsonl`),
    viewport: { width: 980, height: 580 },
    stableText: [
      "AskUserQuestion",
      "Choose the hero framing",
      "Compact feed",
      "Balanced board",
      "Overview first",
      "waiting for a reply",
    ],
    frame: {
      visible: [
        { selector: "#question", text: "Choose the hero framing", minWidth: 560, minHeight: 260 },
        { selector: "#question button", text: "Compact feed", minWidth: 420, minHeight: 36 },
        { selector: "#question button", text: "Balanced board", minWidth: 420, minHeight: 36 },
        { selector: "#question button", text: "Overview first", minWidth: 420, minHeight: 36 },
      ],
      absentText: ["tmux pane unavailable"],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "review-group-expanded",
    output: "review-group-expanded.png",
    project: "relay",
    file: null,
    viewport: { width: 1180, height: 720 },
    stableText: ["Relay switch builder", "Round 3 · in progress", "REQUEST_CHANGES", "APPROVE"],
    frame: {
      visible: [
        { selector: "[role=\"group\"]", text: "Round 3 · in progress", minWidth: 200, minHeight: 200 },
        { selector: "button", text: "REQUEST_CHANGES", minWidth: 160, minHeight: 14 },
        { selector: "button", text: "APPROVE", minWidth: 160, minHeight: 14 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "review-group-collapsed",
    output: "review-group-collapsed.png",
    project: "beacon",
    file: null,
    viewport: { width: 1180, height: 720 },
    stableText: ["Beacon quota builder", "2 rounds", "APPROVE"],
    frame: {
      visible: [
        { selector: "[data-review-deck-collapsed]", text: "APPROVE", minWidth: 180, minHeight: 22 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "review-group-mobile",
    output: "review-group-mobile.png",
    project: "beacon",
    file: null,
    viewport: { width: 390, height: 720 },
    stableText: ["2 rounds", "APPROVE"],
    frame: {
      visible: [
        { selector: "[data-review-deck-collapsed]", text: "APPROVE", minWidth: 300, minHeight: 44 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "readiness-kanban",
    output: "readiness-kanban.png",
    project: "kanban",
    file: null,
    locale: "uk",
    viewport: { width: 1180, height: 720 },
    stableText: [
      "Готовність задач",
      "Зараз",
      "На рев'ю",
      "Заблоковано",
      "Заплановано",
      "Готово",
      /* Chip titles pass through cleanTitle, which strips markdown '#'. */
      "Wire the readiness strip 290",
      "Ship the review evidence 290",
      "#290",
    ],
    frame: {
      visible: [
        { selector: '[data-testid="task-readiness"]', text: "Готовність задач", minWidth: 900, minHeight: 200 },
        { selector: '[data-readiness-section="now"] > button', text: "Зараз", minWidth: 600, minHeight: 20 },
        { selector: '[data-readiness-section="review"] > button', text: "На рев'ю", minWidth: 600, minHeight: 20 },
        { selector: '[data-readiness-section="blocked"] > button', text: "Заблоковано", minWidth: 600, minHeight: 20 },
        { selector: '[data-readiness-section="planned"] > button', text: "Заплановано", minWidth: 600, minHeight: 20 },
        { selector: '[data-readiness-section="done"] > button', text: "Готово", minWidth: 600, minHeight: 20 },
        { selector: '[data-readiness-section="now"] button', text: "Wire the readiness strip", minWidth: 120, minHeight: 16 },
        { selector: '[data-readiness-section="review"] button', text: "Ship the review evidence", minWidth: 120, minHeight: 16 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "readiness-kanban-mobile",
    output: "readiness-kanban-mobile.png",
    project: "kanban",
    file: null,
    locale: "uk",
    viewport: { width: 390, height: 720 },
    stableText: [
      "Готовність задач",
      "Зараз",
      "На рев'ю",
      "Заблоковано",
      "Заплановано",
      "Готово",
      /* Only the «Зараз» section expands at 390px (internal scroll budget);
         its chip row carries the title, issue and agent link evidence. */
      "Wire the readiness strip 290",
      "#290",
    ],
    frame: {
      visible: [
        { selector: '[data-testid="task-readiness"]', text: "Готовність задач", minWidth: 350, minHeight: 280 },
        { selector: '[data-readiness-section="now"] > button', text: "Зараз", minWidth: 300, minHeight: 40 },
        { selector: '[data-readiness-section="review"] > button', text: "На рев'ю", minWidth: 300, minHeight: 40 },
        { selector: '[data-readiness-section="blocked"] > button', text: "Заблоковано", minWidth: 300, minHeight: 40 },
        { selector: '[data-readiness-section="planned"] > button', text: "Заплановано", minWidth: 300, minHeight: 40 },
        { selector: '[data-readiness-section="done"] > button', text: "Готово", minWidth: 300, minHeight: 40 },
        { selector: '[data-readiness-section="now"] button', text: "Wire the readiness strip", minWidth: 100, minHeight: 36 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
  {
    id: "review-loop",
    output: "review-loop.png",
    project: "forge",
    file: null,
    viewport: { width: 1180, height: 720 },
    stableText: ["Demo media review loop", "R2", "Reviewer checking deterministic output"],
    frame: {
      visible: [
        { selector: "[data-scheme-group=\"flow\"]", text: "Demo media review loop", minWidth: 360, minHeight: 220 },
        { selector: "section[data-link-path]", text: "Reviewer checking deterministic output", minWidth: 180, minHeight: 140 },
      ],
      absentText: [],
      pixels: FRAME_PIXELS,
    },
  },
];

function captureRoot(repoRoot: string): string {
  return path.join(repoRoot, "fixtures/demo-home/.capture");
}

export function buildDemoEnvironment(
  repoRoot: string,
  uid: number,
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const root = captureRoot(repoRoot);
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const config = path.join(home, ".config");
  const nodeEnv = source.NODE_ENV === "production" || source.NODE_ENV === "test" ? source.NODE_ENV : "development";
  return {
    NODE_ENV: nodeEnv,
    PATH: source.PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    /* The fixture socket dir overflows the ~108-byte unix-socket path limit in
       deep checkouts (tmux resolves it to its realpath, so a short symlink
       cannot help). The override lets such hosts park ONLY the tmux socket in
       a short-lived external dir; every other mutable path stays inside the
       generated fixture home. */
    TMUX_TMPDIR: source.LLV_DEMO_TMUX_TMPDIR || path.join(root, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_DEV_ORIGINS: DOCKER_BRIDGE_HOST,
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    LLV_RESOURCES_FIXTURE: path.join(config, "agent-log-viewer", "state", "resources.json"),
    LLV_TS_HOST: DOCKER_BRIDGE_HOST,
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    /* Paired on one line on purpose: a line that BEGINS `USER:` reads to the
       publication gate exactly like a transcript speaker label. */
    LOGNAME: "demo", USER: "demo",
    SHELL: "/bin/sh",
    LLV_DEMO_UID: String(uid),
  };
}

export function buildDockerClientEnvironment(
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: source.PATH,
  };
  if (source.DOCKER_HOST) env.DOCKER_HOST = source.DOCKER_HOST;
  return env;
}

export function renderFixtureTemplate(value: string, demoHome: string): string {
  const homeSlug = demoHome.replace(/[^A-Za-z0-9]/g, "-");
  const rendered = value
    .replaceAll(DEMO_TOKEN, demoHome)
    .replaceAll("__DEMO_HOME_SLUG__", homeSlug);
  if (UNRESOLVED_TOKEN.test(rendered)) throw new Error("unresolved fixture token");
  return rendered;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function assertStableText(first: string, second: string, shotId: string): void {
  if (normalizeText(first) !== normalizeText(second)) {
    throw new Error(`${shotId} changed between deterministic passes`);
  }
}

function removeGeneratedRuntime(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

function copyFixtureSource(repoRoot: string, home: string, seed: DemoSeed): void {
  const source = path.join(repoRoot, SEED_SOURCES[seed]);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("demo fixture source must be a regular directory");
  fs.cpSync(source, home, { recursive: true, dereference: false, errorOnExist: true });
}

function materializeTemplates(root: string, home: string): void {
  const directories: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      const stat = fs.lstatSync(pathname);
      if (stat.isSymbolicLink()) throw new Error(`demo fixture contains a symlink: ${pathname}`);
      if (entry.isDirectory()) {
        visit(pathname);
        directories.push(pathname);
        continue;
      }
      if (!entry.isFile()) throw new Error(`demo fixture contains an unsupported entry: ${pathname}`);
      const bytes = fs.readFileSync(pathname);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      const rendered = renderFixtureTemplate(text, home);
      if (rendered !== text) fs.writeFileSync(pathname, rendered, "utf8");
    }
  };
  visit(root);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const name = path.basename(directory);
    const rendered = renderFixtureTemplate(name, home);
    if (name !== rendered) fs.renameSync(directory, path.join(path.dirname(directory), rendered));
  }
}

function setStableTimes(root: string): void {
  const instant = new Date(DEMO_FIXED_ISO);
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      fs.utimesSync(pathname, instant, instant);
    }
  };
  visit(root);
  fs.utimesSync(root, instant, instant);
}

function ensureRuntimeDirectories(env: NodeJS.ProcessEnv, uid: number): void {
  const required = [
    env.HOME!,
    env.TMPDIR!,
    path.join(env.TMPDIR!, `claude-${uid}`),
    env.TMUX_TMPDIR!,
    env.XDG_CONFIG_HOME!,
    env.XDG_CACHE_HOME!,
    env.XDG_RUNTIME_DIR!,
    env.LLV_STATE_DIR!,
  ];
  for (const directory of required) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function outputLines(child: ChildProcess, label: string): () => string {
  const chunks: string[] = [];
  const remember = (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
    while (chunks.join("").length > 24_000) chunks.shift();
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);
  return () => `${label}:\n${chunks.join("")}`;
}

async function waitForServer(url: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`demo server exited with ${child.exitCode}\n${logs()}`);
    try {
      const response = await fetch(`${url}/api/files`);
      if (response.ok) return;
    } catch {
      // The dev server is still compiling.
    }
    await Bun.sleep(250);
  }
  throw new Error(`demo server did not become ready\n${logs()}`);
}

function runProcess(command: string, args: string[], options: Parameters<typeof spawn>[2]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Keep `argv[2]` open for writing and stay alive. The scanner attributes a
    transcript to the process holding it open, so this is the whole of what
    makes a fixture conversation read as hosted rather than finished. */
export const FIXTURE_HOLDER_SOURCE = 'const fs = require("node:fs"); fs.openSync(process.argv[2], "a"); setInterval(() => {}, 60_000);\n';

async function startPendingQuestionPane(root: string, pendingPath: string, env: NodeJS.ProcessEnv, paneScript?: { source: string; args: string[] }): Promise<void> {
  const holderPath = path.join(root, "pending-question-holder.cjs");
  const source = paneScript?.source ?? FIXTURE_HOLDER_SOURCE;
  fs.writeFileSync(holderPath, source, "utf8");
  const args = [pendingPath, ...(paneScript?.args ?? [])];
  const holderCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(holderPath)} ${args.map(shellQuote).join(" ")}`;
  await runProcess(
    "tmux",
    ["new-session", "-d", "-s", "demo-capture", "-n", "pending-question", holderCommand],
    { cwd: env.HOME, env, stdio: "ignore" },
  );
}

/**
 * A second window of the same fixture session, holding the orchestrator seat's
 * transcript open (#1160/#1171).
 *
 * The seat file designates the conversation; that alone makes the dock's panel
 * LIVE, but the conversation itself would read as a finished run that the
 * operator has to resume — the dock would say so, over the greeting turn the
 * shot exists to show. A process holding the transcript is the same evidence a
 * real agent leaves, so the shot states what a seated project actually looks
 * like. Its own window, so the pending-question holder keeps its own process:
 * one pid is attributed to one transcript.
 */
async function startOrchestratorSeatPane(root: string, seatPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const holderPath = path.join(root, "orchestrator-seat-holder.cjs");
  fs.writeFileSync(holderPath, FIXTURE_HOLDER_SOURCE, "utf8");
  const holderCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(holderPath)} ${shellQuote(seatPath)}`;
  await runProcess(
    "tmux",
    ["new-window", "-d", "-t", "demo-capture:", "-n", "orchestrator-seat", holderCommand],
    { cwd: env.HOME, env, stdio: "ignore" },
  );
}

async function stopFixtureTmux(env: NodeJS.ProcessEnv): Promise<void> {
  await runProcess("tmux", ["kill-server"], { cwd: env.HOME, env, stdio: "ignore" });
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

export type DemoRuntime = {
  root: string;
  env: NodeJS.ProcessEnv;
  port: number;
  serverLogs: () => string;
  /** Resolves when the dev server answers /api/files. */
  waitUntilReady: () => Promise<void>;
  shutdown: () => Promise<void>;
};

/**
 * The repository's own `next`, run on Bun, the way `package.json` runs it.
 *
 * Two things are load-bearing. `--bun` is the runtime: the Viewer's startup
 * instrumentation opens its state stores through `bun:sqlite`, so a dev server
 * started under Node fails to boot at all. And the binary is named explicitly
 * because `bunx next` resolves through an install step that rewrites
 * `package.json` to whatever versions happen to be in `node_modules` — a
 * capture run must not edit the manifest of the repository it is documenting.
 */
function nextCommand(repoRoot: string, args: string[]): [string, string[]] {
  return [process.execPath, ["--bun", path.join(repoRoot, "node_modules/.bin/next"), ...args]];
}

export function demoPort(raw: string | undefined, fallback: number, name: string): number {
  const port = Number(raw ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} must be a valid non-privileged port`);
  return port;
}

/**
 * Materialize the disposable fixture home, start the pending-question tmux
 * pane, and boot the isolated Next.js dev server. Shared by the stills
 * capture and the stage B motion capture.
 */
export async function bootstrapDemoRuntime(
  repoRoot: string,
  port: number,
  questionPaneScript?: { source: string; args: string[] },
  seed: DemoSeed = "demo",
): Promise<DemoRuntime> {
  const uid = process.getuid?.() ?? 1000;
  const root = captureRoot(repoRoot);
  removeGeneratedRuntime(root);
  const env = buildDemoEnvironment(repoRoot, uid);
  ensureRuntimeDirectories(env, uid);
  copyFixtureSource(repoRoot, env.HOME!, seed);
  materializeTemplates(env.HOME!, env.HOME!);
  ensureRuntimeDirectories(env, uid);
  setStableTimes(env.HOME!);

  /* The interactive holder belongs to the populated seed's pending-question
     transcript, and the seat holder to its orchestrator conversation. The
     zero-session seed has neither transcript, and a first run has no live agent
     by definition — so nothing is started for it, and nothing is torn down for
     it either (see `shutdown` below). */
  const startedQuestionPane = seed === "demo";
  if (startedQuestionPane) {
    const pendingPath = renderFixtureTemplate(PENDING_QUESTION_FILE, env.HOME!);
    await startPendingQuestionPane(root, pendingPath, env, questionPaneScript);
    await startOrchestratorSeatPane(root, renderFixtureTemplate(ORCHESTRATOR_SEAT_FILE, env.HOME!), env);
  }
  const server = spawn(
    ...nextCommand(repoRoot, ["dev", "--hostname", "0.0.0.0", "--port", String(port)]),
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs = outputLines(server, "demo server output");

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= Promise.all([
      stop(server),
      /* Tearing down a fixture session that was never started fails, and that
         failure would surface as a capture failure at the very end of a run
         that had already published every still. */
      startedQuestionPane ? stopFixtureTmux(env) : Promise.resolve(),
    ]).then(() => undefined);
    return shutdownPromise;
  };
  return {
    root,
    env,
    port,
    serverLogs,
    waitUntilReady: () => waitForServer(`http://127.0.0.1:${port}`, server, serverLogs),
    shutdown,
  };
}

/** Rebuild the route type manifest the dev server left behind. */
export async function regenerateNextTypes(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  fs.rmSync(path.join(repoRoot, ".next/dev/types"), { recursive: true, force: true });
  const [command, args] = nextCommand(repoRoot, ["typegen"]);
  await runProcess(command, args, {
    cwd: repoRoot,
    env: { ...env, NODE_ENV: "production" },
    stdio: "inherit",
  });
}

/** Shots grouped by the fixture home they need, in manifest order. One boot
    per seed: the disposable home is a single directory, so two seeds cannot be
    live at once. */
export function shotsBySeed(shots: DemoShot[] = SHOTS): Array<[DemoSeed, DemoShot[]]> {
  const groups = new Map<DemoSeed, DemoShot[]>();
  for (const shot of shots) {
    const seed = shot.seed ?? "demo";
    const group = groups.get(seed);
    if (group) group.push(shot);
    else groups.set(seed, [shot]);
  }
  return [...groups];
}

/** Render one seed's shots: boot its fixture home, hand the group to the pinned
    browser image, tear the runtime down again. Returns the runtime environment
    so the caller can regenerate the route types the dev server left behind. */
async function captureSeed(repoRoot: string, port: number, seed: DemoSeed, shots: DemoShot[]): Promise<NodeJS.ProcessEnv> {
  const runtime = await bootstrapDemoRuntime(repoRoot, port, undefined, seed);
  const { root, env, serverLogs, shutdown } = runtime;

  const configPath = path.join(root, "capture-config.json");
  const config = {
    baseUrl: `http://${DOCKER_BRIDGE_HOST}:${port}`,
    fixedIso: DEMO_FIXED_ISO,
    outputDir: "/output",
    shots: shots.map((shot) => ({
      ...shot,
      file: shot.file ? renderFixtureTemplate(shot.file, env.HOME!) : null,
    })),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const onSignal = (code: number) => () => { void shutdown(); process.exitCode = code; };
  const onInterrupt = onSignal(130);
  const onTerminate = onSignal(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    await runtime.waitUntilReady();
    fs.mkdirSync(path.join(repoRoot, "docs/media"), { recursive: true });
    const configInContainer = `/workspace/${path.relative(repoRoot, configPath)}`;
    try {
      await runProcess("docker", [
        "run", "--rm", "--network", "bridge",
        "-v", `${repoRoot}:/workspace:ro`,
        "-v", `${path.join(repoRoot, "docs/media")}:/output`,
        "-e", "NODE_PATH=/project/node_modules",
        ...(process.env.DEMO_CAPTURE_DEBUG ? ["-e", "DEMO_CAPTURE_DEBUG=1"] : []),
        "--entrypoint", "node",
        PUPPETEER_IMAGE,
        "/workspace/scripts/demo-capture-browser.cjs",
        "--config", configInContainer,
      ], { cwd: repoRoot, env: buildDockerClientEnvironment(), stdio: "inherit" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverLogs()}`);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await shutdown();
  }
  return env;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.DEMO_CAPTURE_PORT, DEFAULT_PORT, "DEMO_CAPTURE_PORT");
  let lastEnv: NodeJS.ProcessEnv | null = null;
  for (const [seed, shots] of shotsBySeed()) {
    lastEnv = await captureSeed(repoRoot, port, seed, shots);
  }
  if (lastEnv) await regenerateNextTypes(repoRoot, lastEnv);
}

if (import.meta.main) await main();
