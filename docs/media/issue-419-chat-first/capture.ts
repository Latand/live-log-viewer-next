/**
 * Deterministic #419 (reopened) chat-first mobile evidence capture. Boots the
 * pinned demo fixture runtime (same isolated home + fixed clock as
 * scripts/demo-capture.ts), injects THREE fully synthetic schema-v3 pipelines
 * (a live fail-edge cycle, a needs-decision chain, and a completed chain) onto a
 * fictional `atlas` project, then drives local headless Chrome over CDP for:
 *
 *   - board-desktop.png      1920×1080 desktop board (unchanged desktop layout)
 *   - chat-first-390.png     390×844 phone, chat-first shell (folded chrome)
 *   - chat-first-430.png     430×932 phone, chat-first shell (folded chrome)
 *
 * Every phone frame asserts the chat-first contract before capture by MEASURING
 * rendered geometry (never a self-declared constant):
 *   - document.scrollWidth === window.innerWidth (no document-level h-overflow),
 *   - the real LogFeed scroller ([data-log-feed-scroller]) owns >= 0.60 of the
 *     usable visual viewport (visualViewport.height) in the default chat-first
 *     state — a waiting focused conversation with long metadata, folded runtime
 *     controls, and many docked pipelines,
 *   - with the conversation-details AND composer-options disclosures driven open
 *     (materializing the long metadata row and the model/reasoning + attachment
 *     row), the document still shows no horizontal overflow,
 *   - attachments add no PERSISTENT chrome: the image picker is folded behind the
 *     composer-options disclosure, and a staged image is transient operator
 *     content (its preview tray legitimately consumes space while shown, with no
 *     horizontal overflow) that reserves ZERO height once cleared — the default
 *     >= 0.60 budget is fully restored,
 *   - the focused chat reserves ZERO persistent bottom rows: the pipeline
 *     summary rides the top strip and no MobilePipelineSummaryRow /
 *     MobileBottomShelf row is rendered inline.
 *
 * All fixtures are synthetic; NO operator project, path, or state is used. The
 * page is served through the docker-bridge origin (172.17.0.1), matching the
 * fixture's LLV_DEV_ORIGINS allowlist — hydration stalls on any other dev origin.
 *
 *   bun docs/media/issue-419-chat-first/capture.ts
 *
 * (Set LLV_DEMO_TMUX_TMPDIR to a short path on deep checkouts, as with
 * scripts/demo-capture.ts.)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const { bootstrapDemoRuntime, renderFixtureTemplate, claudePath, DEMO_FIXED_ISO } = await import(path.join(repoRoot, "scripts/demo-capture.ts"));

const PORT = 3043;
const OUT_DIR = path.join(repoRoot, "docs/media/issue-419-chat-first");

/* A 1×1 PNG staged into the composer to exercise the attachment path (issue
   #419 §attachments): a real image so the preview tray renders and its height
   enters the measured transcript budget. */
const ATTACHMENT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* Measures the REAL chat-first budget from rendered geometry: the LogFeed
   scroller height against the usable visual viewport, plus the overflow and
   zero-bottom-row invariants. Returned as JSON so a self-declared constant can
   never stand in for measured layout (round-1 finding 1). */
const MEASURE_EXPR = `(() => {
  const shell = document.querySelector('[data-testid="mobile-chat-shell"]');
  const feed = shell && shell.querySelector('[data-log-feed-scroller]');
  const vv = window.visualViewport;
  const usable = Math.round(vv ? vv.height : window.innerHeight);
  const feedH = feed ? Math.round(feed.getBoundingClientRect().height) : 0;
  return JSON.stringify({
    hasShell: !!shell,
    hasFeed: !!feed,
    feedH,
    usable,
    share: usable > 0 ? feedH / usable : 0,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bottomShelfRows: document.querySelectorAll('[data-testid="mobile-bottom-shelf"]').length,
    pipelineTriggers: document.querySelectorAll('[data-testid="mobile-pipeline-summary"]').length,
    attachmentTrays: document.querySelectorAll('[data-testid="mobile-chat-shell"] [data-testid="attachment-tray"]').length,
  });
})()`;

type ChatMeasure = {
  hasShell: boolean;
  hasFeed: boolean;
  feedH: number;
  usable: number;
  share: number;
  scrollWidth: number;
  innerWidth: number;
  bottomShelfRows: number;
  pipelineTriggers: number;
  attachmentTrays: number;
};

/* Clicks a chat-shell disclosure toggle by test id when it is in `want` state. */
function toggleExpr(testid: string, want: "true" | "false"): string {
  return `(() => { const s = document.querySelector('[data-testid="mobile-chat-shell"]'); const b = s && s.querySelector('[data-testid="${testid}"]'); if (b && b.getAttribute('aria-expanded') === '${want}') { b.click(); return true; } return false; })()`;
}

type CdpResponse = { result?: { value?: unknown }; data?: string };
type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  close: () => void;
  logs: string[];
};

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new Error(`ws error: ${String(event)}`));
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
  const logs: string[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      error?: { message: string };
      result?: CdpResponse;
      params?: { type?: string; args?: Array<{ value?: unknown; description?: string }> };
    };
    if (message.method === "Runtime.consoleAPICalled") {
      logs.push(`console.${message.params?.type}: ${(message.params?.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ")}`);
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result ?? {});
    }
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
    logs,
  };
}

async function evalUntil(cdp: Cdp, expression: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value === true) return;
    if (Date.now() - start > timeoutMs) throw new Error(`condition timed out: ${expression.slice(0, 120)}`);
    await Bun.sleep(500);
  }
}

async function evalJson<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return JSON.parse(String(result.result?.value)) as T;
}

/** Mirror of store.ts slugify: the loader's isPipeline gate rejects the WHOLE
    registry unless branch === `pipeline/${slugify(task)}-${id}`. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

const role = { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null };

function attempt(n: number, over: Record<string, unknown>): Record<string, unknown> {
  return {
    n, state: "passed", effectiveRole: role, launchId: null, conversationId: null, sessionId: null,
    agentPath: null, paneId: null, flowId: null, startedAt: "2100-01-02T10:00:00.000Z", completedAt: "2100-01-02T10:20:00.000Z",
    input: null, activatedBy: null, output: null, verdict: { status: "pass", confidence: 0.9 }, error: null, ...over,
  };
}

/** Three synthetic schema-v3 pipelines: busy / attention / completed tones, one
    live attempt bound to a fixture transcript so the phone has a real focused
    conversation to keep dominant. Paused so the demo tick loop leaves them be. */
function pipelineFixture(home: string): unknown {
  const repoDir = path.join(home, "Projects/atlas");
  const planPath = renderFixtureTemplate(claudePath("atlas", "11111111-1111-4111-8111-111111111111.jsonl"), home);
  const verifyPath = renderFixtureTemplate(claudePath("atlas", "22222222-2222-4222-8222-222222222222.jsonl"), home);
  const base = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const shell = (id: string, task: string, over: Record<string, unknown>) => ({
    id, task, spec: "Issue #419 chat-first mobile", project: "atlas", repoDir,
    worktreeDir: path.join(path.dirname(repoDir), `atlas-pipeline-${id}`),
    branch: `pipeline/${slugify(task)}-${id}`, baseBranch: "main", baseRef: base, lastPassedCommit: base,
    stages: [
      { id: "plan", kind: "run", prompt: "{{task}}", next: "implement", onFail: null, effectiveRole: role },
      { id: "implement", kind: "run", prompt: "{{prev.output}}", next: "verify", onFail: null, effectiveRole: role },
      { id: "verify", kind: "run", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "implement", maxRounds: 3 }, effectiveRole: role },
    ],
    srcPath: null, srcConversationId: null, createdAt: "2100-01-02T09:00:00.000Z", closedAt: null, hiddenAt: null,
    pausedState: null, stateDetail: null, ...over,
  });
  return {
    schemaVersion: 3,
    pipelines: [
      shell("a4190001", "Chat-first mobile shell", {
        runs: [
          { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan ready: fold secondary chrome." })] },
          { stageId: "implement", attempts: [
            attempt(1, { input: "Plan ready: fold secondary chrome.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Folded the header meta row." }),
            attempt(2, { input: "Regression found.\n\nFail verdict findings:\n- runtime row still pinned", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" }, output: "Folded the runtime controls too." }),
          ] },
          { stageId: "verify", attempts: [
            attempt(1, { state: "failed", input: "Folded the header meta row.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: "Regression found.", verdict: { status: "fail", findings: ["runtime row still pinned"] } }),
            attempt(2, { state: "running", agentPath: verifyPath, completedAt: null, input: "Folded the runtime controls too.", activatedBy: { stageId: "implement", attempt: 2, edge: "pass" }, output: null, verdict: null }),
          ] },
        ],
        cursor: { stageId: "verify", state: "running", input: "Folded the runtime controls too.", activatedBy: { stageId: "implement", attempt: 2, edge: "pass" } },
        state: "paused", pausedState: "running",
      }),
      shell("a4190002", "Zero-row secondary surfaces", {
        runs: [
          { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan: overlay triggers for pipelines and shelf." })] },
          { stageId: "implement", attempts: [attempt(1, { input: "Plan: overlay triggers for pipelines and shelf.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Top-strip triggers landed." })] },
          { stageId: "verify", attempts: [
            attempt(1, { state: "needs_decision", completedAt: null, input: "Top-strip triggers landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: "Reviewer needs a call on the shelf icon.", verdict: { status: "needs_decision", findings: ["confirm header shelf trigger"] } }),
          ] },
        ],
        cursor: { stageId: "verify", state: "running", input: "Top-strip triggers landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } },
        state: "needs_decision", pausedState: null,
      }),
      shell("a4190003", "Transcript viewport budget", {
        runs: [
          { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan: assert >=60% transcript share." })] },
          { stageId: "implement", attempts: [attempt(1, { input: "Plan: assert >=60% transcript share.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Budget model landed." })] },
          { stageId: "verify", attempts: [attempt(1, { input: "Budget model landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: "All checks pass." })] },
        ],
        cursor: null,
        state: "completed", pausedState: null, closedAt: "2100-01-02T10:30:00.000Z",
      }),
      /* Two more live chains so the phone docks MANY pipelines (five total): the
         folded pipelines icon must still keep the transcript dominant when the
         board behind it is busy. */
      shell("a4190004", "Composer disclosure fold", {
        runs: [
          { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan: fold the composer second row." })] },
          { stageId: "implement", attempts: [attempt(1, { input: "Plan: fold the composer second row.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Primary-row disclosure landed." })] },
          { stageId: "verify", attempts: [
            attempt(1, { state: "running", agentPath: verifyPath, completedAt: null, input: "Primary-row disclosure landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: null, verdict: null }),
          ] },
        ],
        cursor: { stageId: "verify", state: "running", input: "Primary-row disclosure landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } },
        state: "paused", pausedState: "running",
      }),
      shell("a4190005", "Shelf modal lifecycle", {
        runs: [
          { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan: give the shelf modal semantics." })] },
          { stageId: "implement", attempts: [attempt(1, { input: "Plan: give the shelf modal semantics.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Focus trap + scroll lock landed." })] },
          { stageId: "verify", attempts: [attempt(1, { input: "Focus trap + scroll lock landed.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: "All checks pass." })] },
        ],
        cursor: null,
        state: "completed", pausedState: null, closedAt: "2100-01-02T10:40:00.000Z",
      }),
    ],
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runtime = await bootstrapDemoRuntime(repoRoot, PORT);
  const chromeDir = fs.mkdtempSync("/tmp/chrome-419-");
  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    await runtime.waitUntilReady();
    fs.writeFileSync(
      path.join(runtime.env.LLV_STATE_DIR!, "pipelines.json"),
      JSON.stringify(pipelineFixture(runtime.env.HOME!), null, 2) + "\n",
      "utf8",
    );

    chrome = spawn("google-chrome-stable", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
      "--force-color-profile=srgb", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${chromeDir}`, "--remote-debugging-port=0", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const portFile = path.join(chromeDir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await Bun.sleep(200);
    const debugPort = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();

    /* Staged on the same host Chrome reads from, for DOM.setFileInputFiles. */
    const attachmentPngPath = path.join(chromeDir, "attachment.png");
    fs.writeFileSync(attachmentPngPath, Buffer.from(ATTACHMENT_PNG_B64, "base64"));

    const shots = [
      { name: "board-desktop.png", width: 1920, height: 1080, mobile: false, view: "board" as const },
      { name: "chat-first-390.png", width: 390, height: 844, mobile: true, view: "chat" as const },
      { name: "chat-first-430.png", width: 430, height: 932, mobile: true, view: "chat" as const },
    ];
    for (const shot of shots) {
      const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string; id: string };
      const cdp = await connect(created.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: shot.mobile });
      const fixedMs = Date.parse(DEMO_FIXED_ISO);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
        const NativeDate = Date;
        class CaptureDate extends NativeDate { constructor(...a){ super(...(a.length ? a : [${fixedMs}])); } static now(){ return ${fixedMs}; } }
        Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
        Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
        Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
        try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("llv_lang", "en"); localStorage.setItem("llvSound", "0"); } catch {}
      ` });
      await cdp.send("Page.navigate", { url: `http://172.17.0.1:${PORT}/` });
      await evalUntil(cdp, `document.readyState === "complete"`);
      await Bun.sleep(2000);
      await cdp.send("Runtime.evaluate", { expression: `location.hash = "#p=atlas";` });
      await evalUntil(cdp, `!!document.querySelector('[aria-label*="Chat-first mobile shell"], [data-testid="mobile-chat-shell"], [data-testid="mobile-pipeline-dock"]')`, 90_000);
      await cdp.send("Runtime.evaluate", { expression: `
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; } nextjs-portal { display: none !important; }";
        document.head.appendChild(style);
      ` });
      await Bun.sleep(600);

      if (shot.mobile) {
        /* Wait for the LogFeed scroller to mount and lay out before measuring. */
        await evalUntil(cdp, `!!document.querySelector('[data-testid="mobile-chat-shell"] [data-log-feed-scroller]')`, 30_000);
        await Bun.sleep(500);

        /* GATE — measure the REAL transcript budget in the default chat-first
           state (waiting focused conversation, folded chrome, many docked
           pipelines): the LogFeed scroller height over the usable visual
           viewport must clear 0.60, with no document-level horizontal overflow
           (#353 class) and ZERO persistent bottom rows (pipeline summary is a
           top-strip trigger; the shelf is an overlay). */
        const base = await evalJson<ChatMeasure>(cdp, MEASURE_EXPR);
        if (!base.hasFeed) throw new Error(`feed scroller missing (${shot.name})`);
        if (base.scrollWidth !== base.innerWidth) throw new Error(`overflow gate failed (${shot.name}): scrollWidth ${base.scrollWidth} != innerWidth ${base.innerWidth}`);
        if (base.bottomShelfRows !== 0) throw new Error(`bottom-shelf row present (${shot.name}): expected 0, got ${base.bottomShelfRows}`);
        if (!(base.share >= 0.6)) throw new Error(`chat budget gate failed (${shot.name}): measured transcript share ${base.share.toFixed(3)} (feed ${base.feedH}px / usable ${base.usable}px) < 0.60`);
        console.log(`${shot.name} default chat-first budget: share ${base.share.toFixed(3)} (feed ${base.feedH}px / usable ${base.usable}px), pipelineTriggers ${base.pipelineTriggers}, bottomShelfRows 0, scrollWidth ${base.scrollWidth} === innerWidth ${base.innerWidth}`);

        /* Attachment coverage. The image affordance never adds a PERSISTENT row:
           the picker is folded behind the composer-options disclosure (issue
           #419), so the default budget above already reflects zero attachment
           chrome. A staged image is TRANSIENT operator content — its preview
           tray is expected to consume space while present (the transcript yields
           to it, as it should) — so the contract is that it (a) stages without
           horizontal overflow and (b) reserves ZERO height once cleared, i.e.
           the default >= 0.60 budget is fully restored. Images are either
           capability-folded (picker disabled, no input) or exercised live. */
        await cdp.send("DOM.enable");
        await cdp.send("Runtime.evaluate", { expression: toggleExpr("composer-options-toggle", "false"), returnByValue: true });
        await Bun.sleep(300);
        const picker = await evalJson<{ hasInput: boolean; disabled: boolean | null }>(cdp, `(() => { const s = document.querySelector('[data-testid="mobile-chat-shell"]'); const i = s && s.querySelector('input[type=file]'); return JSON.stringify({ hasInput: !!i, disabled: i ? !!i.disabled : null }); })()`);
        if (picker.hasInput && picker.disabled === false) {
          const handle = await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-testid="mobile-chat-shell"] input[type=file]')` });
          const objectId = (handle.result as { objectId?: string } | undefined)?.objectId;
          if (!objectId) throw new Error(`could not resolve the composer file input (${shot.name})`);
          await cdp.send("DOM.setFileInputFiles", { files: [attachmentPngPath], objectId });
          await evalUntil(cdp, `!!document.querySelector('[data-testid="mobile-chat-shell"] [data-testid="attachment-tray"]')`, 15_000);
          await Bun.sleep(300);
          /* Fold the options row again so the tray is the only added element. */
          await cdp.send("Runtime.evaluate", { expression: toggleExpr("composer-options-toggle", "true"), returnByValue: true });
          await Bun.sleep(200);
          const withAttachment = await evalJson<ChatMeasure>(cdp, MEASURE_EXPR);
          if (withAttachment.attachmentTrays < 1) throw new Error(`attachment tray missing after staging (${shot.name})`);
          if (withAttachment.scrollWidth !== withAttachment.innerWidth) throw new Error(`attachment overflow gate failed (${shot.name}): scrollWidth ${withAttachment.scrollWidth} != innerWidth ${withAttachment.innerWidth}`);
          console.log(`${shot.name} attachment (staged, transient): share ${withAttachment.share.toFixed(3)} (feed ${withAttachment.feedH}px / usable ${withAttachment.usable}px), no h-overflow`);
          /* Clear the attachment and prove it reserved ZERO height: the default
             transcript budget must be fully restored to >= 0.60. */
          await cdp.send("Runtime.evaluate", { expression: `(() => { const tray = document.querySelector('[data-testid="mobile-chat-shell"] [data-testid="attachment-tray"]'); if (!tray) return false; const btns = Array.from(tray.querySelectorAll('button')); const clear = btns.find((b) => /clear|remove|delete|видал|очист/i.test((b.getAttribute('aria-label') || ''))); (clear || btns[0])?.click(); return true; })()`, returnByValue: true });
          await evalUntil(cdp, `document.querySelectorAll('[data-testid="mobile-chat-shell"] [data-testid="attachment-tray"]').length === 0`, 10_000);
          await Bun.sleep(200);
          const cleared = await evalJson<ChatMeasure>(cdp, MEASURE_EXPR);
          if (!(cleared.share >= 0.6)) throw new Error(`attachment did not reserve zero height (${shot.name}): restored share ${cleared.share.toFixed(3)} < 0.60`);
          console.log(`${shot.name} attachment cleared: restored share ${cleared.share.toFixed(3)} (feed ${cleared.feedH}px / usable ${cleared.usable}px) — tray reserves zero height`);
        } else {
          console.log(`${shot.name} attachment: image picker capability-folded (hasInput ${picker.hasInput}, disabled ${picker.disabled}) — zero attachment row height`);
        }

        /* Expanded worst case: open BOTH disclosures (the long-metadata row and
           the composer model/reasoning + attachment row) and confirm no
           horizontal overflow persists; the expanded share is logged for the
           record (opening chrome is the operator's explicit act). */
        await cdp.send("Runtime.evaluate", { expression: toggleExpr("mobile-details-toggle", "false"), returnByValue: true });
        await cdp.send("Runtime.evaluate", { expression: toggleExpr("composer-options-toggle", "false"), returnByValue: true });
        await Bun.sleep(300);
        const expanded = await evalJson<ChatMeasure>(cdp, MEASURE_EXPR);
        if (expanded.scrollWidth !== expanded.innerWidth) throw new Error(`expanded overflow gate failed (${shot.name}): scrollWidth ${expanded.scrollWidth} != innerWidth ${expanded.innerWidth}`);
        console.log(`${shot.name} expanded (details+options open): share ${expanded.share.toFixed(3)} (feed ${expanded.feedH}px / usable ${expanded.usable}px), scrollWidth ${expanded.scrollWidth} === innerWidth ${expanded.innerWidth}`);

        /* Restore the clean chat-first default for the screenshot. */
        await cdp.send("Runtime.evaluate", { expression: toggleExpr("mobile-details-toggle", "true"), returnByValue: true });
        await cdp.send("Runtime.evaluate", { expression: toggleExpr("composer-options-toggle", "true"), returnByValue: true });
        await Bun.sleep(300);
      } else {
        await cdp.send("Runtime.evaluate", { expression: `
          const fit = Array.from(document.querySelectorAll("button")).find((b) => (b.getAttribute("title") || "").startsWith("Fit all content"));
          if (fit) fit.click();
        ` });
        await Bun.sleep(800);
      }

      await Bun.sleep(1200);
      const png = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT_DIR, shot.name), Buffer.from(String(png.data), "base64"));
      console.log(`captured ${shot.name}`);
      cdp.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${created.id}`).catch(() => undefined);
    }
  } finally {
    chrome?.kill("SIGKILL");
    await runtime.shutdown();
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }
}

await main();
