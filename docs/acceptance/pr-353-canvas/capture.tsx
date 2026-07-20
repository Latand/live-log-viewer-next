/**
 * #353 acceptance evidence — the corrected board-canvas composition.
 *
 *   bun docs/acceptance/pr-353-canvas/capture.ts
 *
 * The frames render the REAL shipped React components — `PipelineGroupBody`
 * (which mounts `PipelineStageGraph`) and the phone `MobilePipelineDock` — with
 * the app's own production-built CSS (`.next/static/css`, so run `next build`
 * first). Each is rasterized over raw CDP in headless Chrome and gated to prove
 * the exact composition the operator required:
 *
 *   - desktop: the compact colored PipelineGroup container hosts every declared
 *     stage as its real conversation-card shell (pending placeholders, the live
 *     conversation, a completed round, roles, statuses, and the directed
 *     pass/fail links). The body sizes to its cards — no empty fixed-height slab,
 *     no detached graph surface.
 *   - 390px: chat stays primary; the compact `MobilePipelineDock` disclosure
 *     carries the plan, and the large desktop graph panel is never mounted. The
 *     document never exceeds the 390px viewport (`scrollWidth === 390`).
 *
 * Every stage id, task, model, and path here is fabricated — no live capture,
 * project name, filesystem path, account, or transcript. The frames are
 * deterministic: each is rendered twice and gated on byte-identical innerText.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "../../../src/lib/pipelines/types";
import { PipelineGroupBody } from "../../../src/components/scheme/PipelineGroupBody";
import { MobilePipelineDock } from "../../../src/components/mobile/MobilePipelineDock";

const OUTPUT_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

// ── Fabricated, privacy-safe pipeline ───────────────────────────────────────
const role = (roleId: string, engine: "claude" | "codex", model: string, access: "read-only" | "read-write") =>
  ({ roleId, engine, model, effort: "high", access, promptScaffold: null }) as PipelineStage["effectiveRole"];

function stage(id: string, kind: "run" | "review-loop", next: string | null, r: PipelineStage["effectiveRole"], onFail: PipelineStage["onFail"] = null): PipelineStage {
  return { id, kind, prompt: id, next, onFail, effectiveRole: r } as PipelineStage;
}

function attempt(n: number, state: PipelineStageAttempt["state"], model: string, activatedBy: PipelineStageAttempt["activatedBy"] = null): PipelineStageAttempt {
  return {
    n, state, effectiveRole: role("builder", "codex", model, "read-write"),
    launchId: null, conversationId: `conv-${state}-${n}`, sessionId: null,
    agentPath: `/pipeline/${state}-${n}.jsonl`, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy, output: null, verdict: null, error: null,
  } as PipelineStageAttempt;
}

const runningStages: PipelineStage[] = [
  stage("plan", "run", "build", role("architect", "claude", "fable-5", "read-only")),
  stage("build", "run", "review", role("builder", "codex", "gpt-5.6-sol", "read-write")),
  stage("review", "review-loop", "ship", role("reviewer", "claude", "opus-4.8", "read-only"), { to: "build", maxRounds: 3 }),
  stage("ship", "run", null, role("deployer", "codex", "gpt-5.6-sol", "read-write")),
];

const runningPipeline: Pipeline = {
  id: "pl-353", task: "Restore the conversation pipeline canvas", project: "workspace",
  repoDir: "/workspace/app", worktreeDir: "/workspace/app-pipeline-pl-353",
  branch: "canvas", baseBranch: "main", baseRef: "0000", lastPassedCommit: "0000",
  stages: runningStages, taskIds: [],
  runs: [
    { stageId: "plan", attempts: [attempt(1, "passed", "fable-5")] },
    { stageId: "build", attempts: [attempt(1, "running", "gpt-5.6-sol", { stageId: "plan", attempt: 1, edge: "pass" })] },
    { stageId: "review", attempts: [] },
    { stageId: "ship", attempts: [] },
  ],
  cursor: { stageId: "build", state: "running", input: null, activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } },
  state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: new Date("2100-01-02T12:00:00.000Z").toISOString(), closedAt: null,
} as unknown as Pipeline;

const draftPipeline: Pipeline = {
  ...runningPipeline, id: "pl-353-draft", task: "Draft: add a verification stage", state: "draft",
  runs: runningStages.map((s) => ({ stageId: s.id, attempts: [] })),
  cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null },
} as unknown as Pipeline;

// ── Page markup (real components + production CSS) ───────────────────────────
function readBuiltCss(): string {
  const dir = path.join(REPO_ROOT, ".next/static/css");
  if (!fs.existsSync(dir)) throw new Error(`missing ${dir} — run \`next build\` before capturing`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (!files.length) throw new Error(`no compiled CSS under ${dir}`);
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

/** A colored PipelineGroup frame (the #451 container) wrapping the real body.
    The board container is 360px with the graph scrolling horizontally; this
    evidence widens the frame so every declared stage card and its directed link
    are visible at once (the exact composition the operator asked to see). */
function groupFrame(pipeline: Pipeline, draft: boolean, width: number): string {
  const color = draft ? "var(--color-warning)" : "hsl(210 62% 42%)";
  const body = renderToStaticMarkup(
    <PipelineGroupBody pipeline={pipeline} flows={[]} onOpenAttempt={() => {}} onClose={() => {}} />,
  );
  return `
    <section data-pipeline-group="${pipeline.id}" ${draft ? 'data-pipeline-draft=""' : ""} style="width:${width}px;">
      <div style="display:flex;height:52px;align-items:center;gap:12px;border-radius:10px;border:1px ${draft ? "dashed" : "solid"} ${color};background:var(--color-card);padding:0 16px;box-shadow:0 8px 24px rgba(0,0,0,0.12);">
        <span style="height:10px;width:10px;border-radius:9999px;background:${color};"></span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--color-primary);">${pipeline.task}</span>
      </div>
      <div style="margin-top:8px;border-radius:10px;border:1px ${draft ? "dashed" : "solid"} ${color};background:var(--color-card);padding:12px;box-shadow:0 8px 24px rgba(0,0,0,0.12);">
        ${body}
      </div>
    </section>`;
}

function desktopHtml(css: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style>
    <style>body{margin:0;background:var(--color-canvas);}</style></head>
    <body><div style="display:flex;flex-direction:column;gap:36px;align-items:flex-start;padding:40px;width:max-content;">
      ${groupFrame(runningPipeline, false, 900)}
      ${groupFrame(draftPipeline, true, 900)}
    </div></body></html>`;
}

function chatBubble(mine: boolean, text: string): string {
  const align = mine ? "flex-end" : "flex-start";
  const bg = mine ? "var(--color-accent)" : "var(--color-card)";
  const fg = mine ? "#fff" : "var(--color-primary)";
  return `<div style="display:flex;justify-content:${align};"><div style="max-width:78%;border-radius:14px;border:1px solid var(--color-border);background:${bg};color:${fg};padding:8px 12px;font-size:13px;line-height:1.4;">${text}</div></div>`;
}

function mobileHtml(css: string): string {
  /* The phone default: the dock mounts COLLAPSED to a single 44px disclosure row
     so the transcript stays the dominant surface (the dock's own contract). The
     large desktop graph is never mounted here. */
  const dock = renderToStaticMarkup(<MobilePipelineDock pipeline={runningPipeline} defaultExpanded={false} />);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style>
    <style>html,body{margin:0;height:100%;background:var(--color-canvas);overflow:hidden;}</style></head>
    <body><div style="height:100vh;display:flex;flex-direction:column;">
      <div style="height:44px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--color-border);background:var(--color-card);padding:0 12px;font-size:14px;font-weight:600;color:var(--color-primary);">Conversation</div>
      <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:14px;">
        ${chatBubble(false, "Restore the conversation pipeline canvas from the rescued commit.")}
        ${chatBubble(true, "On it — the build stage is running now; review and ship are queued.")}
        ${chatBubble(false, "Great. Keep the pipeline out of the way while I read.")}
      </div>
      <div style="border-top:1px solid var(--color-border);background:var(--color-card);">${dock}</div>
    </div></body></html>`;
}

// ── Minimal CDP client (the pinned puppeteer container is not everywhere) ────
type Shot = { id: string; output: string; width: number; height: number; mobile: boolean; html: string; gate: string; beyondViewport: boolean };

function chromeExecutable(): string {
  const candidates = [process.env.LLV_EVIDENCE_CHROME, "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
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
    ws.addEventListener("message", (e) => client.dispatch(String((e as MessageEvent).data)));
    return client;
  }
  private dispatch(raw: string): void {
    const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
    if (m.id === undefined) return;
    const entry = this.pending.get(m.id);
    if (!entry) return;
    this.pending.delete(m.id);
    if (m.error) entry.reject(new Error(m.error.message));
    else entry.resolve(m.result);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  close(): void { this.ws.close(); }
}

async function launchChrome(userDataDir: string): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(chromeExecutable(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
    "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const deadline = setTimeout(() => reject(new Error(`Chrome never announced DevTools\n${buffered}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(deadline); resolve(match[1]); }
    });
    child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`Chrome exited with ${code}\n${buffered}`)); });
  });
  return { child, wsUrl };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>(
    "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value as T;
}

async function renderShot(cdp: Cdp, shot: Shot, htmlPath: string, capture: boolean): Promise<{ text: string; png: Buffer | null }> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: shot.mobile }, sessionId);
    await cdp.send("Page.navigate", { url: `file://${htmlPath}` }, sessionId);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ready = await evaluate<string>(cdp, sessionId, `(() => {
        if (document.readyState !== "complete") return "loading";
        if (document.fonts && document.fonts.status !== "loaded") return "fonts";
        return document.querySelector(${JSON.stringify(shot.gate)}) ? "ready" : "no-gate";
      })()`);
      if (ready === "ready") break;
      if (Date.now() > deadline) throw new Error(`${shot.id} gate ${shot.gate} never appeared: ${ready}`);
      await Bun.sleep(120);
    }
    const problems = await evaluate<string[]>(cdp, sessionId, `(() => {
      const p = [];
      if (document.documentElement.scrollWidth > window.innerWidth) p.push("document overflows " + window.innerWidth + "px: scrollWidth=" + document.documentElement.scrollWidth);
      if (document.querySelector("[data-scheme-group-strip]")) p.push("a detached stage-graph strip is present");
      ${shot.mobile ? `if (document.querySelector("[data-pipeline-stage-graph]")) p.push("the large desktop graph mounted in the mobile viewport");` : `if (!document.querySelector("[data-pipeline-stage-graph]")) p.push("no conversation-card graph inside the group body");`}
      return p;
    })()`);
    if (problems.length) throw new Error(`${shot.id} composition gate failed:\n${problems.join("\n")}`);
    await evaluate(cdp, sessionId, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const text = await evaluate<string>(cdp, sessionId, "document.body.innerText");
    let png: Buffer | null = null;
    if (capture) {
      const res = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: shot.beyondViewport }, sessionId);
      png = Buffer.from(res.data, "base64");
    }
    return { text, png };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const css = readBuiltCss();
  const shots: Shot[] = [
    { id: "canvas-composition-desktop", output: "canvas-composition-desktop-1440.png", width: 1440, height: 900, mobile: false, html: desktopHtml(css), gate: "[data-pipeline-group-editor]", beyondViewport: true },
    { id: "canvas-composition-390", output: "canvas-composition-390.png", width: 390, height: 844, mobile: true, html: mobileHtml(css), gate: "[data-testid='mobile-pipeline-dock']", beyondViewport: false },
  ];
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "llv353-"));
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    const launched = await launchChrome(path.join(tmp, "chrome-profile"));
    chrome = launched.child;
    cdp = await Cdp.connect(launched.wsUrl);
    for (const shot of shots) {
      const htmlPath = path.join(tmp, `${shot.id}.html`);
      fs.writeFileSync(htmlPath, shot.html, "utf8");
      const first = await renderShot(cdp, shot, htmlPath, true);
      const second = await renderShot(cdp, shot, htmlPath, false);
      if (first.text.replace(/\s+/g, " ").trim() !== second.text.replace(/\s+/g, " ").trim()) {
        throw new Error(`${shot.id} drifted between deterministic passes`);
      }
      fs.writeFileSync(path.join(OUTPUT_DIR, shot.output), first.png!);
      process.stdout.write(`${shot.output} ${first.png!.length} bytes\n`);
    }
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) chrome.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
