/**
 * Regenerate every stage B motion asset — the flow GIFs and the stitched
 * demo.mp4 — with:
 *
 *   bun run demo:motion
 *
 * The runner reuses the stage A fixture home and isolated Next.js server, then
 * plays each storyboard below inside the pinned mcp/puppeteer image with a
 * synthetic cursor, human pacing and captions, recording frames over CDP
 * screencast. Live moments (the tail growing, the question being answered) are
 * driven through the real APIs: a host sync loop appends fixture transcript
 * records mid-recording, and the pending question is answered end-to-end via
 * /api/answer against an interactive fixture pane. Frames pass the stage A
 * pixel gates before ffmpeg assembles the published GIFs and mp4.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  bootstrapDemoRuntime,
  buildDockerClientEnvironment,
  claudePath,
  DEMO_FIXED_ISO,
  demoPort,
  PENDING_QUESTION_FILE,
  PUPPETEER_IMAGE,
  regenerateNextTypes,
  renderFixtureTemplate,
} from "./demo-capture";

const DEFAULT_PORT = 3029;

export const MOTION_VIEWPORT = { width: 1280, height: 720 };
export const GIF_FPS = 12;
export const GIF_WIDTH = 960;
export const VIDEO_FPS = 30;
export const GIF_DURATION_BOUNDS = { min: 6, max: 12 };
export const VIDEO_DURATION_BOUNDS = { min: 30, max: 60 };

export const MOTION_PIXELS = {
  maxNearBlackRatio: 0.05,
  maxTileNearBlackRatio: 0.2,
  tileSize: 64,
  minNonWhiteRatio: 0.12,
  minColorCount: 100,
};

export type MotionTarget = { selector: string; text?: string };

export type HostAction = { kind: "append"; file: string; lines: string[]; utimeIso: string };

export type MotionStep =
  | { do: "pause"; ms: number }
  | { do: "caption"; text: string }
  | { do: "captionHide" }
  | { do: "move"; target: MotionTarget; ms?: number }
  | { do: "hover"; target: MotionTarget; ms?: number; holdMs?: number }
  | { do: "click"; target: MotionTarget; ms?: number }
  | { do: "type"; target: MotionTarget; text: string }
  | { do: "waitText"; text: string }
  | { do: "waitFor"; selector: string }
  | { do: "host"; action: HostAction }
  | { do: "card"; title: string; subtitle: string; note?: string; ms: number };

export type Storyboard = {
  id: string;
  /** File name published to docs/media, or null for mp4-only segments. */
  gif: string | null;
  /** Whether the segment joins the stitched demo.mp4. */
  video: boolean;
  startHash: string | null;
  /** Preparation executed before the recording starts. */
  setup: MotionStep[];
  steps: MotionStep[];
  /** Pixel gates for sampled frames; null for the brand cards. */
  pixels: typeof MOTION_PIXELS | null;
};

const ATLAS_MAIN = claudePath("atlas", "11111111-1111-4111-8111-111111111111.jsonl");

const record = (value: Record<string, unknown>) => JSON.stringify(value);

/** Transcript records the live tail receives while the hero GIF records. */
const TAIL_BATCH_1 = [
  record({
    type: "assistant",
    uuid: "c1000000-0000-4000-8000-000000000001",
    timestamp: "2100-01-02T12:00:01.000Z",
    cwd: "/demo/Projects/atlas",
    message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Stage B is rolling — regenerating the demo media before publishing." }] },
  }),
  record({
    type: "assistant",
    uuid: "c1000000-0000-4000-8000-000000000002",
    timestamp: "2100-01-02T12:00:03.000Z",
    cwd: "/demo/Projects/atlas",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "tool_use", id: "tool-demo-regen", name: "Bash", input: { command: "bun run demo:capture", description: "Re-render every demo still" } }],
    },
  }),
];

const TAIL_BATCH_2 = [
  record({
    type: "user",
    uuid: "c1000000-0000-4000-8000-000000000003",
    timestamp: "2100-01-02T12:00:05.000Z",
    cwd: "/demo/Projects/atlas",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-demo-regen", content: "six stills rendered\nvalidation: 0 jank frames" }] },
  }),
  record({
    type: "assistant",
    uuid: "c1000000-0000-4000-8000-000000000004",
    timestamp: "2100-01-02T12:00:07.000Z",
    cwd: "/demo/Projects/atlas",
    message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "All six stills validated — the capture pipeline is green." }] },
  }),
];

/** What the fixture pane records in the transcript when Enter lands. */
export const QUESTION_ANSWER_LINES = [
  record({
    type: "user",
    uuid: "b1000000-0000-4000-8000-000000000004",
    timestamp: "2100-01-02T12:00:04.000Z",
    cwd: "/demo/Projects/atlas",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-question-framing", content: "Balanced board" }] },
  }),
  record({
    type: "assistant",
    uuid: "b1000000-0000-4000-8000-000000000005",
    timestamp: "2100-01-02T12:00:06.000Z",
    cwd: "/demo/Projects/atlas",
    message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Balanced board it is — framing the hero shot with the tree beside the live feed." }] },
  }),
];

export const QUESTION_PANE_CONFIG = {
  question: "Choose the hero framing",
  options: ["Compact feed (Recommended)", "Balanced board", "Overview first"],
  selected: 0,
  answerLines: QUESTION_ANSWER_LINES,
  utimeIso: "2100-01-02T12:00:06.000Z",
};

const expandButton = (file: string) => `section[data-link-path="${file}"] button[aria-label^="Expand"]`;

export const STORYBOARDS: Storyboard[] = [
  {
    id: "intro-card",
    gif: null,
    video: true,
    startHash: null,
    setup: [
      { do: "waitText", text: "atlas" },
      { do: "waitText", text: "forge" },
    ],
    steps: [
      { do: "card", title: "Agent Log Viewer", subtitle: "Every coding agent on your machine — one live board.", note: "bunx agent-log-viewer", ms: 2800 },
    ],
    pixels: null,
  },
  {
    id: "board-to-live-tail",
    gif: "board-to-live-tail.gif",
    video: true,
    startHash: null,
    setup: [
      { do: "waitText", text: "atlas" },
      { do: "waitText", text: "orbit" },
      { do: "waitText", text: "forge" },
    ],
    steps: [
      { do: "caption", text: "Every agent on this machine — one board" },
      { do: "pause", ms: 800 },
      { do: "click", target: { selector: "button", text: "atlas" }, ms: 750 },
      { do: "waitText", text: "Ship a deterministic demo capture" },
      { do: "pause", ms: 700 },
      { do: "caption", text: "Sessions, subagents and reviewers — one tree" },
      { do: "click", target: { selector: expandButton(ATLAS_MAIN) }, ms: 650 },
      { do: "waitFor", selector: `[role="dialog"] section[data-link-path="${ATLAS_MAIN}"]` },
      { do: "pause", ms: 600 },
      { do: "caption", text: "Live tail — watch it work" },
      { do: "host", action: { kind: "append", file: ATLAS_MAIN, lines: TAIL_BATCH_1, utimeIso: "2100-01-02T12:00:03.000Z" } },
      { do: "waitText", text: "regenerating the demo media" },
      { do: "pause", ms: 1200 },
      { do: "host", action: { kind: "append", file: ATLAS_MAIN, lines: TAIL_BATCH_2, utimeIso: "2100-01-02T12:00:07.000Z" } },
      { do: "waitText", text: "the capture pipeline is green" },
      { do: "pause", ms: 1500 },
    ],
    pixels: MOTION_PIXELS,
  },
  {
    // Runs before spawn-agent: answering retires the fixture's pending
    // question, and the spawn draft would otherwise linger on the atlas board.
    id: "pending-question",
    gif: "pending-question.gif",
    video: true,
    startHash: `#f=${encodeURIComponent(PENDING_QUESTION_FILE)}`,
    setup: [
      { do: "waitFor", selector: `section[data-link-path="${PENDING_QUESTION_FILE}"]` },
      { do: "click", target: { selector: expandButton(PENDING_QUESTION_FILE) }, ms: 0 },
      { do: "waitFor", selector: '[role="dialog"] #question' },
      { do: "waitText", text: "Choose the hero framing" },
    ],
    steps: [
      { do: "pause", ms: 600 },
      { do: "caption", text: "The agent is blocked on a question" },
      { do: "hover", target: { selector: "#question button", text: "Compact feed" }, ms: 700, holdMs: 500 },
      { do: "hover", target: { selector: "#question button", text: "Overview first" }, ms: 500, holdMs: 400 },
      { do: "caption", text: "Answer straight from the browser" },
      { do: "click", target: { selector: "#question button", text: "Balanced board" }, ms: 600 },
      { do: "waitText", text: "Answered" },
      { do: "pause", ms: 700 },
      { do: "caption", text: "…and the agent moves on" },
      { do: "waitText", text: "framing the hero shot" },
      { do: "pause", ms: 1200 },
    ],
    pixels: MOTION_PIXELS,
  },
  {
    id: "spawn-agent",
    gif: "spawn-agent.gif",
    video: true,
    startHash: "#p=atlas",
    setup: [
      { do: "waitText", text: "Ship a deterministic demo capture" },
    ],
    steps: [
      { do: "caption", text: "Need another pair of hands?" },
      { do: "pause", ms: 600 },
      { do: "click", target: { selector: 'button[aria-label="New conversation with an agent"]' }, ms: 700 },
      { do: "waitFor", selector: 'section[aria-label="Draft of a new agent conversation"]' },
      { do: "pause", ms: 500 },
      { do: "click", target: { selector: 'section[aria-label="Draft of a new agent conversation"] textarea' }, ms: 600 },
      { do: "type", target: { selector: 'section[aria-label="Draft of a new agent conversation"] textarea' }, text: "Add a retry pass to the capture pipeline." },
      { do: "pause", ms: 400 },
      { do: "caption", text: "Pick an engine, model and effort — it launches in tmux" },
      { do: "hover", target: { selector: 'section[aria-label="Draft of a new agent conversation"] button[aria-label="Launch the agent"]' }, ms: 650, holdMs: 900 },
      { do: "pause", ms: 600 },
    ],
    pixels: MOTION_PIXELS,
  },
  {
    id: "review-loop",
    gif: "review-loop.gif",
    video: true,
    startHash: "#p=forge",
    setup: [
      { do: "waitText", text: "Demo media review loop" },
      { do: "waitText", text: "Reviewer checking deterministic output" },
    ],
    steps: [
      { do: "caption", text: "Implement → review, in rounds" },
      { do: "pause", ms: 900 },
      { do: "click", target: { selector: '[data-scheme-ui] button', text: "R1" }, ms: 850 },
      { do: "waitText", text: "REQUEST_CHANGES" },
      { do: "caption", text: "Round 1 came back: changes requested" },
      { do: "pause", ms: 1700 },
      { do: "caption", text: "A fresh reviewer every round — findings relayed automatically" },
      { do: "click", target: { selector: '[data-scheme-ui] button', text: "R2" }, ms: 750 },
      { do: "waitText", text: "Reviewer checking deterministic output" },
      { do: "pause", ms: 1800 },
    ],
    pixels: MOTION_PIXELS,
  },
  {
    id: "outro-card",
    gif: null,
    video: true,
    startHash: null,
    setup: [
      { do: "waitText", text: "atlas" },
    ],
    steps: [
      { do: "card", title: "bunx agent-log-viewer", subtitle: "Local-first. No database. Reads ~/.claude and ~/.codex.", note: "github.com/Latand/live-log-viewer-next", ms: 3200 },
    ],
    pixels: null,
  },
];

/** The order segments join demo.mp4 — every storyboard, as declared. */
export const VIDEO_OUTPUT = "demo.mp4";

function runProcess(command: string, args: string[], options: Parameters<typeof spawn>[2]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.slice(0, 4).join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited with ${code}: ${err.slice(0, 800)}`));
    });
  });
}

type FrameIndex = {
  frames: Array<{ file: string; ts: number }>;
  endTs: number;
};

function writeConcatList(dir: string, index: FrameIndex): string {
  if (!index.frames.length) throw new Error(`${dir} recorded no frames`);
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < index.frames.length; i += 1) {
    const frame = index.frames[i]!;
    const next = index.frames[i + 1];
    const duration = Math.max(0.016, (next ? next.ts : index.endTs) - frame.ts);
    lines.push(`file ${frame.file}`, `duration ${duration.toFixed(4)}`);
  }
  lines.push(`file ${index.frames.at(-1)!.file}`);
  const listPath = path.join(dir, "frames.ffconcat");
  fs.writeFileSync(listPath, `${lines.join("\n")}\n`, "utf8");
  return listPath;
}

async function ffprobeDuration(file: string): Promise<number> {
  const raw = await capture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", file]);
  const duration = Number(raw.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe returned no duration for ${file}`);
  return duration;
}

function assertDuration(file: string, duration: number, bounds: { min: number; max: number }): void {
  if (duration < bounds.min || duration > bounds.max) {
    throw new Error(`${path.basename(file)} runs ${duration.toFixed(2)}s — outside [${bounds.min}, ${bounds.max}]s`);
  }
}

async function encodeGif(listPath: string, dir: string, output: string): Promise<void> {
  const filters = [
    `fps=${GIF_FPS}`,
    `scale=${GIF_WIDTH}:-1:flags=lanczos`,
    "split[s0][s1]",
  ].join(",");
  await runProcess("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `${filters};[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0",
    output,
  ], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
}

async function encodeSegment(listPath: string, dir: string, output: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=${VIDEO_FPS},scale=${MOTION_VIEWPORT.width}:${MOTION_VIEWPORT.height}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    output,
  ], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
}

async function concatSegments(segments: string[], videoDir: string, output: string): Promise<void> {
  const listPath = path.join(videoDir, "segments.txt");
  fs.writeFileSync(listPath, segments.map((segment) => `file '${segment.replaceAll("'", `'\\''`)}'`).join("\n") + "\n", "utf8");
  await runProcess("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart",
    output,
  ], { cwd: videoDir, stdio: ["ignore", "inherit", "inherit"] });
}

/** Applies host actions requested by the in-container executor. */
function startHostSync(syncDir: string, home: string): { stop: () => void } {
  const done = new Set<string>();
  const timer = setInterval(() => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(syncDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || done.has(entry)) continue;
      done.add(entry);
      const request = JSON.parse(fs.readFileSync(path.join(syncDir, entry), "utf8")) as HostAction;
      if (request.kind !== "append") throw new Error(`unknown host action: ${JSON.stringify(request)}`);
      const target = renderFixtureTemplate(request.file, home);
      if (!path.resolve(target).startsWith(`${path.resolve(home)}${path.sep}`)) throw new Error(`host append escapes the fixture home: ${target}`);
      fs.appendFileSync(target, request.lines.map((line) => `${line}\n`).join(""), "utf8");
      const instant = new Date(request.utimeIso);
      fs.utimesSync(target, instant, instant);
      fs.writeFileSync(path.join(syncDir, `${entry}.done`), "", "utf8");
    }
  }, 120);
  return { stop: () => clearInterval(timer) };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.DEMO_MOTION_PORT, DEFAULT_PORT, "DEMO_MOTION_PORT");

  const paneSource = fs.readFileSync(path.join(repoRoot, "scripts/demo-motion-question-pane.cjs"), "utf8");
  const paneConfig = Buffer.from(JSON.stringify(QUESTION_PANE_CONFIG), "utf8").toString("base64");
  const runtime = await bootstrapDemoRuntime(repoRoot, port, { source: paneSource, args: [paneConfig] });
  const { root, env, shutdown, serverLogs } = runtime;
  process.once("SIGINT", () => { void shutdown(); process.exitCode = 130; });
  process.once("SIGTERM", () => { void shutdown(); process.exitCode = 143; });

  const motionDir = path.join(root, "motion");
  const syncDir = path.join(motionDir, "sync");
  fs.mkdirSync(syncDir, { recursive: true });
  // Pre-create every directory the container writes into, so the files it
  // leaves behind (owned by the container user) sit in host-owned directories
  // the assembly step can still write lists and segments into.
  for (const board of STORYBOARDS) fs.mkdirSync(path.join(motionDir, board.id), { recursive: true });
  fs.mkdirSync(path.join(motionDir, "video"), { recursive: true });

  const home = env.HOME!;
  const config = {
    baseUrl: `http://172.17.0.1:${port}`,
    fixedIso: DEMO_FIXED_ISO,
    motionDir: "/motion",
    viewport: MOTION_VIEWPORT,
    storyboards: JSON.parse(renderFixtureTemplate(JSON.stringify(STORYBOARDS), home)) as Storyboard[],
  };
  fs.writeFileSync(path.join(motionDir, "motion-config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const hostSync = startHostSync(syncDir, home);
  try {
    await runtime.waitUntilReady();
    try {
      await runProcess("docker", [
        "run", "--rm", "--network", "bridge",
        "-v", `${repoRoot}:/workspace:ro`,
        "-v", `${motionDir}:/motion`,
        "-e", "NODE_PATH=/project/node_modules",
        "--entrypoint", "node",
        PUPPETEER_IMAGE,
        "/workspace/scripts/demo-motion-browser.cjs",
        "--config", "/motion/motion-config.json",
      ], { cwd: repoRoot, env: buildDockerClientEnvironment(), stdio: "inherit" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverLogs()}`);
    }
  } finally {
    hostSync.stop();
    await shutdown();
  }

  const mediaDir = path.join(repoRoot, "docs/media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const videoDir = path.join(motionDir, "video");
  const segments: string[] = [];

  for (const board of STORYBOARDS) {
    const dir = path.join(motionDir, board.id);
    const index = JSON.parse(fs.readFileSync(path.join(dir, "frames.json"), "utf8")) as FrameIndex;
    const listPath = writeConcatList(dir, index);
    if (board.gif) {
      const gifPath = path.join(mediaDir, board.gif);
      await encodeGif(listPath, dir, gifPath);
      const duration = await ffprobeDuration(gifPath);
      assertDuration(gifPath, duration, GIF_DURATION_BOUNDS);
      process.stdout.write(`${board.gif} ${(fs.statSync(gifPath).size / 1024).toFixed(0)} KiB, ${duration.toFixed(2)}s\n`);
    }
    if (board.video) {
      const segment = path.join(videoDir, `${board.id}.mp4`);
      await encodeSegment(listPath, dir, segment);
      segments.push(segment);
    }
  }

  const videoPath = path.join(mediaDir, VIDEO_OUTPUT);
  await concatSegments(segments, videoDir, videoPath);
  const videoDuration = await ffprobeDuration(videoPath);
  assertDuration(videoPath, videoDuration, VIDEO_DURATION_BOUNDS);
  process.stdout.write(`${VIDEO_OUTPUT} ${(fs.statSync(videoPath).size / 1024).toFixed(0)} KiB, ${videoDuration.toFixed(2)}s\n`);

  await regenerateNextTypes(repoRoot, env);
}

if (import.meta.main) await main();
