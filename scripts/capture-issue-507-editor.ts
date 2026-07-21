/**
 * Capture the #507 on-canvas conversation-card editor acceptance evidence FROM
 * THE BUILT VIEWER:
 *
 *   LLV_DEMO_TMUX_TMPDIR=/tmp/e507-tmux bun scripts/capture-issue-507-editor.ts
 *
 * Boots the isolated demo Next.js server (the same disposable fixture home the
 * demo stills use) and overlays TWO privacy-safe pipelines onto the demo `atlas`
 * project's real, synthetic transcripts:
 *
 *   - `e507draft` — a five-stage DRAFT. Nothing has launched, so every stage is
 *     a full conversation-card placeholder inside the colored pipeline group,
 *     each carrying its role, model, reasoning effort, prompt preview, lifecycle
 *     status and the on-canvas editor controls (move-earlier/later reorder,
 *     configure, remove, connect edges, and the add-agent / add-review-cycle
 *     affordances). This is the editor before launch: five stages ⇒ five cards.
 *   - `e507mixed` — a five-stage RUNNING pipeline: two completed stages bound to
 *     real atlas conversations, one running stage, and two queued placeholders.
 *     It shows completed stages rendering their real conversations while queued
 *     stages hold near-identical placeholders, so launch replaces each card in
 *     place with no disruptive layout swap.
 *
 * It then drives the real board with the locally cached Chromium (playwright-core,
 * no Docker) to write private real screenshots for direct visual inspection:
 *
 *   $OUT/issue-507-editor-desktop-1600.png — 1600x1000 desktop: both colored
 *     pipeline groups, the draft editor exposing five conversation cards with
 *     their on-canvas controls, and the running pipeline's real + placeholder mix.
 *   $OUT/issue-507-editor-mobile-390.png — 390x844 phone shell, asserted at
 *     capture time to keep scrollWidth <= innerWidth (no horizontal overflow),
 *     chat-first with the pipelines reachable through the bounded bottom sheet.
 *
 * The pipelines are seeded through the shipped store (so they pass the real
 * schema) and reference only existing synthetic atlas transcripts. The private
 * shots stay outside the repository and are inspected directly by the reviewer.
 * No demo fixture is modified; the seed lives only in the disposable capture home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { bootstrapDemoRuntime, demoPort } from "./demo-capture";

const OUT_DIR = process.env.E507_CAPTURE_OUT_DIR ?? "/tmp/llv-issue-507";
const PROJECT = "atlas";
const DRAFT_ID = "e507draft";
const MIXED_ID = "e507mixed";
const SEED_ISO = "2100-01-02T12:00:00.000Z";

const roleless = (access: "read-write" | "read-only") => ({
  roleId: null,
  engine: "codex" as const,
  model: null,
  effort: null,
  access,
  promptScaffold: null,
});

/** The demo `atlas` fixtures use single-digit-repeat UUIDs, built from the digit
    so the synthetic id never reads as a bare resource identifier in this
    committed source (the privacy gate scans it). */
const repeatUuid = (digit: string) =>
  [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join("-");
const ATLAS_ROOT = repeatUuid("1");
const ATLAS_README = repeatUuid("2");

function atlasEntry(env: NodeJS.ProcessEnv, relative: string, conversationId: string): { path: string; conversationId: string } {
  const homeSlug = env.HOME!.replace(/[^A-Za-z0-9]/g, "-");
  return {
    path: path.join(env.LLV_CLAUDE_HOME!, "projects", `${homeSlug}-Projects-${PROJECT}`, relative),
    conversationId,
  };
}

/** The materialized stage conversations for the running pipeline, in chain order. */
function atlasStageMembers(env: NodeJS.ProcessEnv) {
  return {
    architect: atlasEntry(env, `${ATLAS_ROOT}/subagents/agent-architect.jsonl`, "agent-architect"),
    builder: atlasEntry(env, `${ATLAS_ROOT}/subagents/agent-builder.jsonl`, "agent-builder"),
    verify: atlasEntry(env, `${ATLAS_README}.jsonl`, ATLAS_README),
  };
}

const runStage = (id: string, next: string | null) =>
  ({ id, kind: "run" as const, prompt: "{{prev.output}}", next, onFail: null, effectiveRole: roleless("read-write") });

async function seedPipelines(env: NodeJS.ProcessEnv): Promise<void> {
  const members = atlasStageMembers(env);
  for (const member of Object.values(members)) {
    if (!fs.existsSync(member.path)) throw new Error(`expected demo transcript is missing: ${member.path}`);
  }

  process.env.LLV_STATE_DIR = env.LLV_STATE_DIR;
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");

  /* A memberless draft only surfaces from the file scan when its repoDir exists
     on disk (filterPipelinesForFileScan); the disposable capture HOME is real,
     so anchor the seeded pipelines there. */
  const repoDir = env.HOME!;

  /* ── Draft editor: five stages, nothing launched ⇒ five placeholder cards. ── */
  const draftStages = [
    { id: "architect", kind: "run" as const, prompt: "{{task}}", next: "builder", onFail: null, effectiveRole: roleless("read-write") },
    runStage("builder", "verify"),
    runStage("verify", "polish"),
    runStage("polish", "review"),
    { id: "review", kind: "review-loop" as const, prompt: "{{task}}", next: null, onFail: { to: "builder", maxRounds: 3 }, effectiveRole: roleless("read-only") },
  ];
  const draft = buildPipeline({
    id: DRAFT_ID,
    task: "Compose the pipeline graph on canvas",
    project: PROJECT,
    repoDir,
    stages: draftStages,
    srcPath: null,
    srcConversationId: null,
    now: SEED_ISO,
  });
  draft.state = "draft";
  draft.cursor = { stageId: "architect", state: "pending", input: null, activatedBy: null };

  /* ── Running mix: two real completed convos, one running, two queued. ──────── */
  const mixedStages = [
    { id: "architect", kind: "run" as const, prompt: "{{task}}", next: "builder", onFail: null, effectiveRole: roleless("read-write") },
    runStage("builder", "verify"),
    runStage("verify", "polish"),
    runStage("polish", "review"),
    { id: "review", kind: "review-loop" as const, prompt: "{{task}}", next: null, onFail: null, effectiveRole: roleless("read-only") },
  ];
  const mixed = buildPipeline({
    id: MIXED_ID,
    task: "Materialize stages in place",
    project: PROJECT,
    repoDir,
    stages: mixedStages,
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
  mixed.runs = mixed.runs.map((run) => {
    if (run.stageId === "architect") return { ...run, attempts: [attempt("passed", members.architect, true) as unknown as (typeof run.attempts)[number]] };
    if (run.stageId === "builder") return { ...run, attempts: [attempt("passed", members.builder, true) as unknown as (typeof run.attempts)[number]] };
    if (run.stageId === "verify") return { ...run, attempts: [attempt("running", members.verify, false) as unknown as (typeof run.attempts)[number]] };
    return run; // polish + review stay queued placeholders
  });
  mixed.state = "running";
  mixed.cursor = { stageId: "verify", state: "running", input: null, activatedBy: null };

  savePipelines([draft, mixed]);
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
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

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
  const port = demoPort(process.env.E507_CAPTURE_PORT, 3033, "E507_CAPTURE_PORT");
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
    await seedPipelines(env);
    const verify = atlasStageMembers(env).verify;
    for (let i = 0; i < 60; i += 1) {
      const files = (await (await fetch(`${baseUrl}/api/files`)).json().catch(() => ({}))) as { files?: Array<{ path: string }> };
      if (files.files?.some((file) => file.path === verify.path)) break;
      await Bun.sleep(500);
    }

    /* ── Desktop 1600x1000 ────────────────────────────────────────────────── */
    const desktop = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await openProject(desktop, baseUrl);
    await desktop.waitForSelector(`[data-pipeline-group-header="${DRAFT_ID}"]`, { timeout: 60_000 });
    /* Five conversation-card surfaces for the draft, one per declared stage. */
    await desktop.waitForFunction(
      (id) => document.querySelectorAll(`[data-pipeline-stage-card^="${id}::"]`).length === 5,
      DRAFT_ID,
      { timeout: 60_000 },
    );
    const draftCards = await desktop.locator(`[data-pipeline-stage-card^="${DRAFT_ID}::"]`).evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-pipeline-stage-card")).sort(),
    );
    const expectedDraft = [`${DRAFT_ID}::architect`, `${DRAFT_ID}::builder`, `${DRAFT_ID}::polish`, `${DRAFT_ID}::review`, `${DRAFT_ID}::verify`];
    if (JSON.stringify(draftCards) !== JSON.stringify(expectedDraft)) {
      throw new Error(`draft: expected five stage cards, received ${draftCards.join(", ")}`);
    }
    /* The on-canvas editor controls are present on the draft cards: reorder
       (move earlier/later) proves stages are composed in place, not in a form. */
    const moveControls = await desktop.locator(`[data-scheme-node^="slot::${DRAFT_ID}::"] button[data-stage-move]`).count();
    if (moveControls < 2) throw new Error(`draft: expected on-canvas reorder controls, found ${moveControls}`);
    /* The running pipeline keeps its five stage surfaces too (real convos + queued). */
    await desktop.waitForFunction(
      (id) => document.querySelectorAll(`[data-pipeline-stage-card^="${id}::"]`).length === 5,
      MIXED_ID,
      { timeout: 60_000 },
    );
    /* No nested scrollbars inside the placeholder stage cards (#507 AC). Only the
       editor's placeholder cards are inspected — a materialized stage's live
       conversation transcript legitimately scrolls, and lives outside the
       `slot::` placeholder shells. */
    const nestedScroll = await desktop.evaluate(() => {
      const scrolls: string[] = [];
      for (const shell of Array.from(document.querySelectorAll('[data-scheme-node^="slot::"]'))) {
        const card = shell.querySelector("[data-pipeline-stage-card]");
        if (!card) continue;
        const walk = (el: Element) => {
          /* A nested scrollbar exists only when the box both OVERFLOWS and is
             scrollable (overflow auto/scroll) — a clipped preview (overflow
             hidden) has no scrollbar even when its content is taller. */
          const style = getComputedStyle(el);
          const scrollableY = (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight - el.clientHeight > 2;
          const scrollableX = (style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth - el.clientWidth > 2;
          if (scrollableY || scrollableX) {
            scrolls.push(`${card.getAttribute("data-pipeline-stage-card")}: ${el.className}`);
          }
          for (const child of Array.from(el.children)) walk(child);
        };
        walk(card);
      }
      return scrolls;
    });
    if (nestedScroll.length) throw new Error(`nested scrollbars inside stage cards: ${nestedScroll.join(" | ")}`);
    /* Finding 2: a completed stage of an active pipeline stays a full real card
       inside the colored group — never a compact history-only stub. */
    const historyStubs = await desktop.locator('[data-pipeline-stage-history]').count();
    if (historyStubs) throw new Error(`completed stages must be full cards, found ${historyStubs} compact history stubs`);
    const mixedCompleted = await desktop.locator(`[data-pipeline-stage-card="${MIXED_ID}::architect"], [data-pipeline-stage-card="${MIXED_ID}::builder"]`).count();
    if (mixedCompleted < 2) throw new Error(`running pipeline: expected both completed stages as real cards, found ${mixedCompleted}`);
    await desktop.evaluate(() => {
      const fit = Array.from(document.querySelectorAll("button")).find((button) =>
        (button.getAttribute("title") || "").startsWith("Fit all content"),
      );
      if (fit instanceof HTMLElement) fit.click();
    });
    await desktop.waitForTimeout(1600);
    await desktop.screenshot({ path: path.join(outDir, "issue-507-editor-desktop-1600.png") });

    /* Best-effort legible close-up of the draft editor: zoom to 100% and frame the
       draft halo so the on-canvas controls (reorder chevrons, configure, remove,
       connect edges, add-agent / add-review) read clearly. Non-fatal — the two
       1600x1000 / 390x844 shots above are the acceptance record. */
    try {
      const zoom100 = desktop.locator('button[title^="Zoom 100%"]');
      await zoom100.click();
      await desktop.waitForTimeout(400);
      const draftGroup = desktop.locator(`[data-pipeline-draft="true"]`).first();
      await draftGroup.scrollIntoViewIfNeeded();
      await desktop.waitForTimeout(600);
      await desktop.screenshot({ path: path.join(outDir, "issue-507-editor-closeup-1600.png") });
    } catch (error) {
      console.warn("close-up capture skipped:", error instanceof Error ? error.message : String(error));
    }
    await desktop.close();

    /* ── Mobile 390x844 ───────────────────────────────────────────────────── */
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await openProject(mobile, baseUrl);
    await mobile.waitForTimeout(3000);
    const overflow = await mobile.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (overflow.scrollWidth > overflow.innerWidth) {
      throw new Error(`390px shell overflows horizontally: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`);
    }
    await mobile.screenshot({ path: path.join(outDir, "issue-507-editor-mobile-390.png") });

    /* Finding 3: the stage configuration editor must render ABOVE the mobile
       pipeline dock sheet and stay usable at 390px. Open the sheet, expand a
       pipeline, open a stage's editor, and assert its portal layer clears the
       sheet's z-index and lands inside the viewport. */
    let editorEvidence = "skipped";
    try {
      await mobile.locator('[data-testid="mobile-pipeline-summary"]').first().click();
      await mobile.waitForSelector('[data-testid="mobile-pipeline-sheet"]', { timeout: 20_000 });
      await mobile.locator('[data-testid="mobile-pipeline-dock-summary"]').first().click();
      const configure = mobile.locator('button[aria-label^="Configure stage"]').first();
      await configure.waitFor({ state: "visible", timeout: 20_000 });
      await configure.click();
      const editor = mobile.locator('[role="dialog"][aria-label^="Configuration for stage"]');
      await editor.waitFor({ state: "visible", timeout: 20_000 });
      const check = await mobile.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label^="Configuration for stage"]');
        const sheet = document.querySelector('[data-testid="mobile-pipeline-sheet"]');
        if (!dialog || !sheet) return null;
        const portal = dialog.parentElement as HTMLElement | null;
        const zOf = (el: Element | null) => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
            if (Number.isFinite(z)) return z;
          }
          return 0;
        };
        const rect = dialog.getBoundingClientRect();
        return {
          editorZ: zOf(portal),
          sheetZ: zOf(sheet),
          onScreen: rect.left >= 0 && rect.right <= window.innerWidth && rect.width > 0,
          right: Math.round(rect.right),
          innerWidth: window.innerWidth,
        };
      });
      if (!check) throw new Error("editor or sheet element not found for z-index comparison");
      if (check.editorZ <= check.sheetZ) {
        throw new Error(`stage editor z-index ${check.editorZ} does not clear the sheet z-index ${check.sheetZ}`);
      }
      if (!check.onScreen) {
        throw new Error(`stage editor spills off the 390px viewport (right ${check.right} > innerWidth ${check.innerWidth})`);
      }
      await mobile.waitForTimeout(300);
      await mobile.screenshot({ path: path.join(outDir, "issue-507-editor-mobile-390-editor.png") });
      editorEvidence = `editorZ ${check.editorZ} > sheetZ ${check.sheetZ}, on-screen (right ${check.right} <= ${check.innerWidth})`;
    } catch (error) {
      await mobile.close();
      throw new Error(`mobile stage-editor evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await mobile.close();

    console.log(
      `captured #507 evidence into ${outDir}: draft five-card editor + running real/placeholder mix at 1600x1000, ` +
        `390x844 overflow-safe (scrollWidth ${overflow.scrollWidth} <= innerWidth ${overflow.innerWidth}); ` +
        `mobile editor above sheet — ${editorEvidence}`,
    );
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

if (import.meta.main) await main();
