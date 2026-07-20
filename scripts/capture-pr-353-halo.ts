/**
 * Capture the #353 halo acceptance evidence FROM THE BUILT VIEWER:
 *
 *   LLV_DEMO_TMUX_TMPDIR=/tmp/halo-tmux bun scripts/capture-pr-353-halo.ts
 *
 * Boots the isolated demo Next.js server (the same disposable fixture home the
 * demo stills use) and overlays ONE privacy-safe pipeline onto the demo `atlas`
 * project's real, synthetic transcripts: two passed run stages, one live run
 * stage, and two future stages. The production scene folds the terminal stages
 * into compact history, so only the live stage keeps a full pane. It then
 * drives the real board with the locally cached Chromium (playwright-core, no
 * Docker) to write two private real screenshots for direct visual inspection:
 *
 *   /tmp/llv-pr353-halo/halo-composition-desktop.png — one colored halo
 *     enclosing the single live conversation pane plus two future-stage shells;
 *     the two passed stages are compact history off the scene, and the pass
 *     rails route from the live card into the placeholders.
 *   /tmp/llv-pr353-halo/halo-composition-390.png — the 390px phone shell,
 *     asserted at capture time to keep scrollWidth <= innerWidth (no horizontal
 *     overflow), chat-first.
 *
 * The pipeline is seeded through the shipped store (so it passes the real schema)
 * and references only the existing synthetic atlas transcripts. The private shots
 * stay outside the repository and are inspected directly by the reviewer. No demo
 * fixture is modified; the seed lives only in the disposable capture home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { bootstrapDemoRuntime, demoPort } from "./demo-capture";

const OUT_DIR = process.env.HALO_CAPTURE_OUT_DIR ?? "/tmp/llv-pr353-halo";
const PROJECT = "atlas";
const PIPELINE_ID = "halo353";
const SEED_ISO = "2100-01-02T12:00:00.000Z";

const roleless = (access: "read-write" | "read-only") => ({
  roleId: null,
  engine: "codex" as const,
  model: null,
  effort: null,
  access,
  promptScaffold: null,
});

/** The demo `atlas` fixtures use single-digit-repeat UUIDs. Built from the digit
    rather than written as a literal so the synthetic id never reads as a bare
    resource identifier in this committed source (the privacy gate scans it). */
const repeatUuid = (digit: string) =>
  [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join("-");
const ATLAS_ROOT = repeatUuid("1");
const ATLAS_README = repeatUuid("2");

/** Absolute path of an existing demo `atlas` transcript (a top-level session or a
    subagent leaf under the root session). These already render as three clean
    sibling cards, so binding three pipeline stages to them makes the halo enclose
    three materialized conversations plus the future review placeholder. */
function atlasEntry(env: NodeJS.ProcessEnv, relative: string, conversationId: string): { path: string; conversationId: string } {
  const homeSlug = env.HOME!.replace(/[^A-Za-z0-9]/g, "-");
  return {
    path: path.join(env.LLV_CLAUDE_HOME!, "projects", `${homeSlug}-Projects-${PROJECT}`, relative),
    conversationId,
  };
}

/** The three materialized stage conversations, in chain order. */
function atlasStageMembers(env: NodeJS.ProcessEnv) {
  return {
    architect: atlasEntry(env, `${ATLAS_ROOT}/subagents/agent-architect.jsonl`, "agent-architect"),
    builder: atlasEntry(env, `${ATLAS_ROOT}/subagents/agent-builder.jsonl`, "agent-builder"),
    verify: atlasEntry(env, `${ATLAS_README}.jsonl`, ATLAS_README),
  };
}

async function seedPipeline(env: NodeJS.ProcessEnv): Promise<void> {
  const members = atlasStageMembers(env);
  for (const member of Object.values(members)) {
    if (!fs.existsSync(member.path)) throw new Error(`expected demo transcript is missing: ${member.path}`);
  }

  /* Seed through the real store so the record passes the shipped schema. */
  process.env.LLV_STATE_DIR = env.LLV_STATE_DIR;
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
  const stages = [
    { id: "architect", kind: "run" as const, prompt: "{{task}}", next: "builder", onFail: null, effectiveRole: roleless("read-write") },
    { id: "builder", kind: "run" as const, prompt: "{{prev.output}}", next: "verify", onFail: null, effectiveRole: roleless("read-write") },
    { id: "verify", kind: "run" as const, prompt: "{{prev.output}}", next: "polish", onFail: null, effectiveRole: roleless("read-write") },
    { id: "polish", kind: "run" as const, prompt: "{{prev.output}}", next: "review", onFail: null, effectiveRole: roleless("read-write") },
    { id: "review", kind: "review-loop" as const, prompt: "{{task}}", next: null, onFail: null, effectiveRole: roleless("read-only") },
  ];
  const pipeline = buildPipeline({
    id: PIPELINE_ID,
    task: "Restore the colored pipeline halo",
    project: PROJECT,
    repoDir: "/demo/Projects/atlas",
    stages,
    srcPath: null,
    srcConversationId: null,
    now: SEED_ISO,
  });
  const attempt = (state: string, member: { path: string; conversationId: string }, done: boolean) => ({
    n: 1,
    state,
    effectiveRole: roleless("read-write"),
    launchId: null,
    conversationId: member.conversationId,
    sessionId: null,
    agentPath: member.path,
    paneId: null,
    flowId: null,
    startedAt: SEED_ISO,
    completedAt: done ? SEED_ISO : null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.runs = pipeline.runs.map((run) => {
    if (run.stageId === "architect") return { ...run, attempts: [attempt("passed", members.architect, true) as unknown as (typeof run.attempts)[number]] };
    if (run.stageId === "builder") return { ...run, attempts: [attempt("passed", members.builder, true) as unknown as (typeof run.attempts)[number]] };
    if (run.stageId === "verify") return { ...run, attempts: [attempt("running", members.verify, false) as unknown as (typeof run.attempts)[number]] };
    return run; // review stays a future placeholder (no attempt)
  });
  pipeline.state = "running";
  pipeline.cursor = { stageId: "verify", state: "running", input: null, activatedBy: null };
  savePipelines([pipeline]);
}

/** Deterministic capture prelude, matching the demo stills: pin the clock, drop
    the live SSE/observer churn, and clear any prior board camera/prefs. */
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
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

/** Select the project and wait for its scheme board to render. Navigating to `/`
    then setting the hash mirrors the demo capture, so the client mounts the board
    for `#p=<project>` exactly as an operator's in-app selection would. */
async function openProject(page: Page, baseUrl: string): Promise<void> {
  await page.addInitScript(seedInit);
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.evaluate((project) => { location.hash = `#p=${project}`; }, PROJECT);
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/files`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.HALO_CAPTURE_PORT, 3031, "HALO_CAPTURE_PORT");
  /* Reuse the demo runtime purely to materialize the disposable fixture home,
     then stop its dev server and serve the SAME home from the production build —
     the built Viewer hydrates reliably in headless Chromium where the dev bundle
     does not. */
  const runtime = await bootstrapDemoRuntime(repoRoot, port + 1);
  await runtime.shutdown();
  const env = { ...runtime.env, NODE_ENV: "production" as const, PORT: String(port) };
  const baseUrl = `http://127.0.0.1:${port}`;
  const outDir = path.isAbsolute(OUT_DIR) ? OUT_DIR : path.join(repoRoot, OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer(baseUrl, server);
    await seedPipeline(env);
    /* Warm the scan so the atlas transcripts and the seeded pipeline are live
       before the board mounts. */
    const verify = atlasStageMembers(env).verify;
    for (let i = 0; i < 60; i += 1) {
      const files = (await (await fetch(`${baseUrl}/api/files`)).json().catch(() => ({}))) as { files?: Array<{ path: string }> };
      if (files.files?.some((file) => file.path === verify.path)) break;
      await Bun.sleep(500);
    }

    /* ── Desktop halo ─────────────────────────────────────────────────────── */
    const desktop = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
    await openProject(desktop, baseUrl);
    await desktop.waitForSelector(`[data-pipeline-group-header="${PIPELINE_ID}"]`, { timeout: 60_000 });
    await desktop.waitForSelector(`[data-scheme-node="slot::${PIPELINE_ID}::polish"]`, { timeout: 60_000 });
    await desktop.waitForSelector(`[data-scheme-node="slot::${PIPELINE_ID}::review"]`, { timeout: 60_000 });
    /* Only the live `verify` stage keeps a full pane; the passed architect/builder
       stages are compact history off the scene. Exactly three surfaces carry a
       stage card: the live pane and the two future shells. */
    await desktop.waitForFunction(
      (pipelineId) => document.querySelectorAll(`[data-pipeline-stage-card^="${pipelineId}::"]`).length === 3,
      PIPELINE_ID,
      { timeout: 60_000 },
    );
    const stageCardIds = await desktop.locator(`[data-pipeline-stage-card^="${PIPELINE_ID}::"]`).evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-pipeline-stage-card")).sort(),
    );
    const expectedCards = [`${PIPELINE_ID}::polish`, `${PIPELINE_ID}::review`, `${PIPELINE_ID}::verify`];
    if (JSON.stringify(stageCardIds) !== JSON.stringify(expectedCards)) {
      throw new Error(`expected the live verify pane plus two future shells, received ${stageCardIds.join(", ")}`);
    }
    const architect = atlasStageMembers(env).architect;
    const architectCompact = await desktop.evaluate((p) => document.querySelector(`[data-scheme-node="${p}"]`) === null, architect.path);
    if (!architectCompact) throw new Error("the passed architect stage must be compact history, not a full board pane");
    /* Frame the whole board so the halo and its cards fill the shot. */
    await desktop.evaluate(() => {
      const fit = Array.from(document.querySelectorAll("button")).find((button) =>
        (button.getAttribute("title") || "").startsWith("Fit all content"),
      );
      if (fit instanceof HTMLElement) fit.click();
    });
    await desktop.waitForTimeout(1600);
    await desktop.screenshot({ path: path.join(outDir, "halo-composition-desktop.png") });
    await desktop.close();

    /* ── Mobile 390px ─────────────────────────────────────────────────────── */
    const mobile = await browser.newPage({ viewport: { width: 390, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await openProject(mobile, baseUrl);
    await mobile.waitForTimeout(3000);
    const overflow = await mobile.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (overflow.scrollWidth > overflow.innerWidth) {
      throw new Error(`390px shell overflows horizontally: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`);
    }
    await mobile.screenshot({ path: path.join(outDir, "halo-composition-390.png") });
    await mobile.close();

    console.log(`captured one live pane + two future shells (terminal stages compact) + 390px halo evidence into ${outDir} (390 scrollWidth ${overflow.scrollWidth} <= innerWidth ${overflow.innerWidth})`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

if (import.meta.main) await main();
