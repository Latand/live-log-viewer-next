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
const UNRESOLVED_TOKEN = /__[A-Z0-9_]*DEMO[A-Z0-9_]*__/;
const DEFAULT_PORT = 3028;

export type DemoShot = {
  id: string;
  output: string;
  project: string | null;
  file: string | null;
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

export const claudePath = (project: string, session: string) =>
  `${DEMO_TOKEN}/.claude/projects/__DEMO_HOME_SLUG__-Projects-${project}/${session}`;

export const PENDING_QUESTION_FILE = claudePath("atlas", "22222222-2222-4222-8222-222222222222.jsonl");

export const SHOTS: DemoShot[] = [
  {
    id: "chat-feed",
    output: "chat-feed.png",
    project: "atlas",
    file: claudePath("atlas", "11111111-1111-4111-8111-111111111111.jsonl"),
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
    file: `${DEMO_TOKEN}/.codex/sessions/2100/01/02/rollout-2100-01-02T11-20-00-33333333-3333-4333-8333-333333333333.jsonl`,
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
    viewport: { width: 920, height: 420 },
    stableText: ["atlas", "orbit", "forge"],
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
    id: "pending-question",
    output: "pending-question.png",
    project: "atlas",
    file: claudePath("atlas", "22222222-2222-4222-8222-222222222222.jsonl"),
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
    TMUX_TMPDIR: path.join(root, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_DEV_ORIGINS: "172.17.0.1",
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    LLV_RESOURCES_FIXTURE: path.join(config, "agent-log-viewer", "state", "resources.json"),
    LLV_TS_HOST: "172.17.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    USER: "demo",
    LOGNAME: "demo",
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

function copyFixtureSource(repoRoot: string, home: string): void {
  const source = path.join(repoRoot, "fixtures/demo-home/home");
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

async function startPendingQuestionPane(root: string, pendingPath: string, env: NodeJS.ProcessEnv, paneScript?: { source: string; args: string[] }): Promise<void> {
  const holderPath = path.join(root, "pending-question-holder.cjs");
  const source = paneScript?.source ?? 'const fs = require("node:fs"); fs.openSync(process.argv[2], "a"); setInterval(() => {}, 60_000);\n';
  fs.writeFileSync(holderPath, source, "utf8");
  const args = [pendingPath, ...(paneScript?.args ?? [])];
  const holderCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(holderPath)} ${args.map(shellQuote).join(" ")}`;
  await runProcess(
    "tmux",
    ["new-session", "-d", "-s", "demo-capture", "-n", "pending-question", holderCommand],
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
): Promise<DemoRuntime> {
  const uid = process.getuid?.() ?? 1000;
  const root = captureRoot(repoRoot);
  removeGeneratedRuntime(root);
  const env = buildDemoEnvironment(repoRoot, uid);
  ensureRuntimeDirectories(env, uid);
  copyFixtureSource(repoRoot, env.HOME!);
  materializeTemplates(env.HOME!, env.HOME!);
  ensureRuntimeDirectories(env, uid);
  setStableTimes(env.HOME!);

  const pendingPath = renderFixtureTemplate(PENDING_QUESTION_FILE, env.HOME!);
  await startPendingQuestionPane(root, pendingPath, env, questionPaneScript);
  const server = spawn(
    "bunx",
    ["next", "dev", "--hostname", "0.0.0.0", "--port", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs = outputLines(server, "demo server output");

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= Promise.all([stop(server), stopFixtureTmux(env)]).then(() => undefined);
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
  await runProcess("bunx", ["next", "typegen"], {
    cwd: repoRoot,
    env: { ...env, NODE_ENV: "production" },
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.DEMO_CAPTURE_PORT, DEFAULT_PORT, "DEMO_CAPTURE_PORT");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  const { root, env, serverLogs, shutdown } = runtime;

  const configPath = path.join(root, "capture-config.json");
  const config = {
    baseUrl: `http://172.17.0.1:${port}`,
    fixedIso: DEMO_FIXED_ISO,
    outputDir: "/output",
    shots: SHOTS.map((shot) => ({
      ...shot,
      file: shot.file ? renderFixtureTemplate(shot.file, env.HOME!) : null,
    })),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  process.once("SIGINT", () => { void shutdown(); process.exitCode = 130; });
  process.once("SIGTERM", () => { void shutdown(); process.exitCode = 143; });

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
    await shutdown();
  }
  await regenerateNextTypes(repoRoot, env);
}

if (import.meta.main) await main();
