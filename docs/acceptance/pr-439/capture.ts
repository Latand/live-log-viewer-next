/**
 * PR #439 acceptance evidence: the pipeline stage graph renders and navigates
 * every declared stage for VALID PATH-ONLY attempts — a launch that recorded a
 * transcript path but never adopted a stable conversation id. The repair opens
 * such attempts (primary nodes, retry stacks, review-cycle roles) instead of
 * leaving their controls disabled, resolving the current non-archived generation
 * first and falling back to `agentPath`.
 *
 * Regenerated with:
 *
 *   bun run build            # emits the compiled Tailwind bundle these shots link
 *   bun docs/acceptance/pr-439/capture.ts
 *
 * The graph is server-rendered from a synthetic pipeline (ids like `plan` /
 * `build` / `review`, model `gpt-5.6-sol`) with NO real project names, paths,
 * account names, transcripts, or personal data, then rasterised over raw CDP
 * (the pinned mcp/puppeteer container is not available on every capture host).
 * Each viewport renders the same markup twice with an equality gate before
 * publication so a shot can never freeze a transient frame.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PipelineStageGraph, PipelineStageGraphFlowsProvider } from "@/components/scheme/PipelineStageGraph";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const OUT_DIR = import.meta.dir;

const role = {
  roleId: "builder" as const,
  engine: "codex" as const,
  model: "gpt-5.6-sol",
  effort: "high",
  access: "read-write" as const,
  promptScaffold: "build",
};

function run(id: string, next: string | null): PipelineStage {
  return { id, kind: "run", prompt: id, next, onFail: null, effectiveRole: role };
}

function review(id: string, next: string | null): PipelineStage {
  return {
    id, kind: "review-loop", prompt: id, next, onFail: { to: "build", maxRounds: 3 },
    effectiveRole: { ...role, roleId: "reviewer", access: "read-only", promptScaffold: "review" },
  };
}

/** A launch that recorded only a transcript path — the repaired path-only case. */
function pathAttempt(n: number, state: string, agentPath: string): PipelineStageAttempt {
  return { n, state, effectiveRole: role, launchId: null, conversationId: null, sessionId: null, agentPath, paneId: null, flowId: null, startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as PipelineStageAttempt;
}

function convAttempt(n: number, state: string, conversationId: string, flowId: string | null = null): PipelineStageAttempt {
  return { n, state, effectiveRole: role, launchId: null, conversationId, sessionId: null, agentPath: `/synthetic/${conversationId}.jsonl`, paneId: null, flowId, startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as PipelineStageAttempt;
}

/** One synthetic pipeline exercising every repaired surface: a retry stack whose
    FIRST attempt is path-only and still linkable (`plan`, retried then passed),
    an implementer with a grouped review cycle (`build`/`review`), and an
    untouched downstream pending ghost (`verify`). */
function syntheticPipeline(): { pipeline: Pipeline; flows: Flow[] } {
  const stages: PipelineStage[] = [
    run("plan", "build"),
    run("build", "review"),
    review("review", "verify"),
    run("verify", null),
  ];
  const reviewing = convAttempt(1, "reviewing", "review-r1", "flow-review");
  const pipeline = {
    id: "p1", task: "Synthetic stage graph", project: "synthetic", repoDir: "/worktree", worktreeDir: "/worktree",
    branch: "feature", baseBranch: "main", baseRef: "abc", lastPassedCommit: "abc", stages,
    runs: [
      { stageId: "plan", attempts: [pathAttempt(1, "failed", "/synthetic/plan-1.jsonl"), convAttempt(2, "passed", "plan-2")] },
      { stageId: "build", attempts: [convAttempt(1, "passed", "build-1")] },
      { stageId: "review", attempts: [reviewing] },
      { stageId: "verify", attempts: [] },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } },
    state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(0).toISOString(), closedAt: null,
  } as unknown as Pipeline;
  const flows = [{
    id: "flow-review", state: "reviewing", roundLimit: 3,
    roles: { implementer: role, reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" } },
    rounds: [{ n: 1 }],
  } as unknown as Flow];
  return { pipeline, flows };
}

function renderGraph(): string {
  const { pipeline, flows } = syntheticPipeline();
  return renderToStaticMarkup(
    h(PipelineStageGraphFlowsProvider, { flows, children: h(PipelineStageGraph, { pipeline, onOpenAttempt: () => {} }) }),
  );
}

function compiledCss(): string {
  const dir = path.join(ROOT, ".next/static/css");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".css")) : [];
  if (!files.length) throw new Error("no compiled CSS found — run `bun run build` first");
  return files.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
}

function pageHtml(markup: string, css: string, width: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>${css}</style>
<style>
  *,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}
  html,body{margin:0;background:var(--color-canvas)}
  #frame{width:${width}px;padding:24px;box-sizing:border-box}
</style></head>
<body class="font-sans text-[15px]"><div id="frame"><div id="root">${markup}</div></div></body></html>`;
}

// ── CDP over the browser websocket (mirrors docs/acceptance/issue-404) ──────────

function chromeExecutable(): string {
  const candidates = [process.env.LLV_EVIDENCE_CHROME, "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  throw new Error("no Chrome executable found; set LLV_EVIDENCE_CHROME");
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {}
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener("message", (event) => client.dispatch(String(event.data)));
    ws.addEventListener("close", () => {
      for (const entry of client.pending.values()) entry.reject(new Error("CDP websocket closed"));
      client.pending.clear();
    });
    return client;
  }
  private dispatch(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(payload);
    });
  }
  close(): void { this.ws.close(); }
}

async function launchChrome(userDataDir: string): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(chromeExecutable(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
    "--hide-scrollbars", "--font-render-hinting=none", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const deadline = setTimeout(() => reject(new Error(`Chrome never announced DevTools\n${buffered}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(deadline); resolve(match[1]!); }
    });
    child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`Chrome exited with ${code}\n${buffered}`)); });
  });
  return { child, wsUrl };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>(
    "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId,
  );
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
  return result.result.value as T;
}

type Rect = { x: number; y: number; width: number; height: number };
/** `viewport`: the layout width Chrome emulates. `clip`: which element's box the
    PNG is cropped to — the inner graph canvas for the full desktop plan, the
    390-wide scroll column for the mobile framing. */
type Shot = { id: string; output: string; viewport: number; mobile: boolean; clip: string };
const SHOTS: Shot[] = [
  { id: "stage-graph-desktop", output: "stage-graph-desktop.png", viewport: 1920, mobile: false, clip: "[data-pipeline-stage-graph] > div" },
  { id: "stage-graph-390px", output: "stage-graph-390px.png", viewport: 390, mobile: true, clip: "[data-pipeline-stage-graph]" },
];

async function captureShot(cdp: Cdp, shot: Shot, markup: string, css: string): Promise<void> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: shot.viewport, height: 900, deviceScaleFactor: 2, mobile: shot.mobile }, sessionId);
    const html = pageHtml(markup, css, shot.viewport);
    const loaded = new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        const ready = await evaluate<boolean>(cdp, sessionId, `document.readyState === "complete" && !!document.querySelector("[data-pipeline-stage-graph]")`).catch(() => false);
        if (ready) { clearInterval(timer); resolve(); }
      }, 50);
    });
    await cdp.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` }, sessionId);
    await loaded;
    await evaluate(cdp, sessionId, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);

    const first = await evaluate<string>(cdp, sessionId, `document.querySelector("[data-pipeline-stage-graph]").innerText`);
    const second = await evaluate<string>(cdp, sessionId, `document.querySelector("[data-pipeline-stage-graph]").innerText`);
    if (first !== second) throw new Error(`unstable render for ${shot.id}`);

    const rect = await evaluate<Rect>(cdp, sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(shot.clip)});
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    })()`);
    const clip = { x: Math.max(0, rect.x - 12), y: Math.max(0, rect.y - 12), width: rect.width + 24, height: rect.height + 24, scale: 2 };
    const png = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip }, sessionId);
    fs.writeFileSync(path.join(OUT_DIR, shot.output), Buffer.from(png.data, "base64"));
    console.log(`captured ${shot.output} (viewport ${shot.viewport}px, clip ${Math.round(clip.width)}×${Math.round(clip.height)})`);
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const markup = renderGraph();
  const second = renderGraph();
  if (markup !== second) throw new Error("server markup is not deterministic");
  const css = compiledCss();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pr439-chrome-"));
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    const launched = await launchChrome(profile);
    chrome = launched.child;
    cdp = await Cdp.connect(launched.wsUrl);
    for (const shot of SHOTS) await captureShot(cdp, shot, markup, css);
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

await main();
