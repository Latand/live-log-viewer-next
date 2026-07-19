/**
 * Deterministic #353 evidence capture: boots the pinned demo fixture runtime
 * (same isolated home + fixed clock as scripts/demo-capture.ts), injects a
 * schema-v3 pipeline with a fail-edge cycle into the fixture state dir, then
 * drives local headless Chrome over CDP for a 1920×1080 desktop board shot and
 * a 390×844 mobile shot. The mobile frame gate asserts the #353 overflow
 * contract: document scrollWidth === innerWidth (no document-level horizontal
 * scroll). The page is served through the docker-bridge origin (172.17.0.1),
 * matching the fixture's LLV_DEV_ORIGINS allowlist — hydration stalls on any
 * other dev origin.
 *
 *   bun docs/media/issue-353/capture-353.ts
 *
 * (Set LLV_DEMO_TMUX_TMPDIR to a short path on deep checkouts, as with
 * scripts/demo-capture.ts.)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const { bootstrapDemoRuntime, renderFixtureTemplate, claudePath, DEMO_FIXED_ISO } = await import(path.join(repoRoot, "scripts/demo-capture.ts"));

const PORT = 3041;
const OUT_DIR = path.join(repoRoot, "docs/media/issue-353");

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
      params?: { type?: string; args?: Array<{ value?: unknown; description?: string }>; exceptionDetails?: unknown };
    };
    if (message.method === "Runtime.consoleAPICalled") {
      logs.push(`console.${message.params?.type}: ${(message.params?.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ")}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      logs.push(`exception: ${JSON.stringify(message.params?.exceptionDetails)}`);
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

/** A schema-v3 pipeline exercising the #353 surface: three stages, a pass
    chain, a fail-edge cycle (verify ↩ implement, 1 of 3 rounds used), persisted
    relay provenance on every attempt, one live attempt bound to a fixture
    transcript. Paused so the demo tick loop leaves the record untouched. */
function pipelineFixture(home: string): unknown {
  const id = "a3530001";
  const repoDir = path.join(home, "Projects/atlas");
  const planPath = renderFixtureTemplate(claudePath("atlas", "11111111-1111-4111-8111-111111111111.jsonl"), home);
  const verifyPath = renderFixtureTemplate(claudePath("atlas", "22222222-2222-4222-8222-222222222222.jsonl"), home);
  const role = { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null };
  const attempt = (n: number, over: Record<string, unknown>) => ({
    n, state: "passed", effectiveRole: role, launchId: null, conversationId: null, sessionId: null,
    agentPath: null, paneId: null, flowId: null, startedAt: "2100-01-02T10:00:00.000Z", completedAt: "2100-01-02T10:20:00.000Z",
    input: null, activatedBy: null, output: null, verdict: { status: "pass", confidence: 0.9 }, error: null, ...over,
  });
  return {
    schemaVersion: 3,
    pipelines: [{
      id,
      task: "Editable pipeline graph",
      spec: "Issue #353 acceptance",
      project: "atlas",
      repoDir,
      worktreeDir: path.join(path.dirname(repoDir), `atlas-pipeline-${id}`),
      branch: `pipeline/editable-pipeline-graph-${id}`,
      baseBranch: "main",
      baseRef: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
      lastPassedCommit: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
      stages: [
        { id: "plan", kind: "run", prompt: "{{task}}", next: "implement", onFail: null, effectiveRole: role },
        { id: "implement", kind: "run", prompt: "{{prev.output}}", next: "verify", onFail: null, effectiveRole: role },
        { id: "verify", kind: "run", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "implement", maxRounds: 3 }, effectiveRole: role },
      ],
      runs: [
        { stageId: "plan", attempts: [attempt(1, { agentPath: planPath, output: "Plan ready: bounded slices." })] },
        { stageId: "implement", attempts: [
          attempt(1, { input: "Plan ready: bounded slices.", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" }, output: "Implemented slice 1." }),
          attempt(2, { input: "Regression found.\n\nFail verdict findings:\n- header count drift", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" }, output: "Fixed the header drift." }),
        ] },
        { stageId: "verify", attempts: [
          attempt(1, { state: "failed", input: "Implemented slice 1.", activatedBy: { stageId: "implement", attempt: 1, edge: "pass" }, output: "Regression found.", verdict: { status: "fail", findings: ["header count drift"] } }),
          attempt(2, { state: "running", agentPath: verifyPath, completedAt: null, input: "Fixed the header drift.", activatedBy: { stageId: "implement", attempt: 2, edge: "pass" }, output: null, verdict: null }),
        ] },
      ],
      cursor: { stageId: "verify", state: "running", input: "Fixed the header drift.", activatedBy: { stageId: "implement", attempt: 2, edge: "pass" } },
      state: "paused",
      pausedState: "running",
      stateDetail: null,
      srcPath: null,
      srcConversationId: null,
      createdAt: "2100-01-02T09:00:00.000Z",
      closedAt: null,
      hiddenAt: null,
    }],
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runtime = await bootstrapDemoRuntime(repoRoot, PORT);
  const chromeDir = fs.mkdtempSync("/tmp/chrome-353-");
  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    await runtime.waitUntilReady();
    /* Inject the v3 pipeline AFTER the runtime materialized its state dir. */
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

    const shots = [
      { name: "board-desktop.png", width: 1920, height: 1080, mobile: false },
      { name: "board-mobile-390.png", width: 390, height: 844, mobile: true },
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
      /* Wait for the pipeline surface: the strip/hub group aria or dock. */
      await evalUntil(cdp, `!!document.querySelector('[aria-label*="Editable pipeline graph"], [data-testid="mobile-pipeline-dock"]')`, 90_000);
      await cdp.send("Runtime.evaluate", { expression: `
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; } nextjs-portal { display: none !important; }";
        document.head.appendChild(style);
      ` });
      if (shot.mobile) {
        /* Expand the dock so the full rail (incl. fail-edge badge) is visible. */
        await cdp.send("Runtime.evaluate", { expression: `
          const summary = document.querySelector('[data-testid="mobile-pipeline-dock-summary"][aria-expanded="false"]');
          if (summary) summary.click();
        ` });
        await Bun.sleep(800);
        const gate = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`, returnByValue: true });
        const measured = JSON.parse(String(gate.result?.value)) as { scrollWidth: number; innerWidth: number };
        if (measured.scrollWidth !== measured.innerWidth) {
          throw new Error(`390px overflow gate failed: scrollWidth ${measured.scrollWidth} != innerWidth ${measured.innerWidth}`);
        }
        console.log(`mobile overflow gate: scrollWidth ${measured.scrollWidth} === innerWidth ${measured.innerWidth}`);
      } else {
        /* Frame the whole board deterministically. */
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
