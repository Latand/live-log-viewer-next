/**
 * Issue #404 acceptance evidence: the pipeline template picker mounted with an
 * empty repository directory resolves straight into the typed `missing` error
 * state — no phantom "Checking repository…" spinner. Regenerated with:
 *
 *   bun docs/acceptance/issue-404/capture.ts
 *
 * The run reuses the Stage A demo runtime (isolated fixture home + dev
 * server) and seeds one codex rollout whose session_meta carries no cwd — the
 * production condition that mounts the picker with an empty repoDir. Each
 * shot opens the picker through the real dashboard entry (desktop button /
 * mobile create menu), gates on the blocked state with zero spinners and a
 * focused editable input, holds for a second to prove the state is settled
 * rather than a pre-spinner frame, and renders twice with an innerText
 * equality gate before publication. Chrome runs over raw CDP — the pinned
 * mcp/puppeteer container is not available on every capture host.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bootstrapDemoRuntime,
  DEMO_FIXED_ISO,
  demoPort,
  regenerateNextTypes,
} from "../../../scripts/demo-capture";
import { translate, type Locale } from "../../../src/lib/i18n";

const DEFAULT_PORT = 3404;
const CWDLESS_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const CWDLESS_SESSION_FILE = `rollout-2100-01-02T11-30-00-${CWDLESS_SESSION_ID}.jsonl`;

type EvidenceShot = {
  id: string;
  output: string;
  viewport: { width: number; height: number; mobile: boolean };
  locale: Locale;
};

const SHOTS: EvidenceShot[] = [
  { id: "empty-preflight-desktop-en", output: "empty-preflight-desktop-1440-en.png", viewport: { width: 1440, height: 900, mobile: false }, locale: "en" },
  { id: "empty-preflight-mobile-en", output: "empty-preflight-mobile-390-en.png", viewport: { width: 390, height: 844, mobile: true }, locale: "en" },
  { id: "empty-preflight-desktop-uk", output: "empty-preflight-desktop-1440-uk.png", viewport: { width: 1440, height: 900, mobile: false }, locale: "uk" },
  { id: "empty-preflight-mobile-uk", output: "empty-preflight-mobile-390-uk.png", viewport: { width: 390, height: 844, mobile: true }, locale: "uk" },
];

const FREEZE_STYLE = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    content-visibility: visible !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    will-change: auto !important;
  }
  html { scroll-behavior: auto !important; }
  body { cursor: default !important; }
  [data-capture-volatile="pid"] { display: none !important; }
  nextjs-portal { display: none !important; }
`;

function chromeExecutable(): string {
  const candidates = [process.env.LLV_EVIDENCE_CHROME, "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome executable found; set LLV_EVIDENCE_CHROME");
}

/** Minimal flat-session CDP client over the browser websocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
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
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(payload);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function launchChrome(userDataDir: string): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(chromeExecutable(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const deadline = setTimeout(() => reject(new Error(`Chrome never announced DevTools\n${buffered}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Chrome exited with ${code}\n${buffered}`));
    });
  });
  return { child, wsUrl };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
}

/** Seed the cwd-less codex rollout (#404): a session whose meta head carries
    no `cwd`, so the scanner derives neither cwd nor projectRoot and the
    picker's only truthful mount value is an empty repository directory. */
function seedCwdlessCodexSession(home: string): string {
  const directory = path.join(home, ".codex/sessions/2100/01/02");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, CWDLESS_SESSION_FILE);
  const records = [
    { type: "session_meta", timestamp: "2100-01-02T11:30:00.000Z", payload: { id: CWDLESS_SESSION_ID, originator: "codex_cli_rs", cli_version: "0.200.0", source: "cli", model_provider: "openai" } },
    { type: "event_msg", timestamp: "2100-01-02T11:30:04.000Z", payload: { type: "user_message", message: "Recover this imported transcript; its rollout header has no working directory." } },
    { type: "event_msg", timestamp: "2100-01-02T11:30:10.000Z", payload: { type: "agent_message", message: "The session metadata records no cwd, so no repository can be inferred for pipeline work.", phase: "commentary" } },
    { type: "response_item", timestamp: "2100-01-02T11:30:16.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Imported without a working directory; pick a repository explicitly before starting a pipeline." }], phase: "final_answer" } },
    { type: "event_msg", timestamp: "2100-01-02T11:30:16.100Z", payload: { type: "task_complete", last_agent_message: "Imported without a working directory." } },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const instant = new Date(DEMO_FIXED_ISO);
  fs.utimesSync(file, instant, instant);
  return file;
}

/** Localized copy each gate needs, resolved from the product catalog so the
    evidence can never drift from the shipped strings. */
function copyFor(locale: Locale) {
  return {
    createMenu: translate(locale, "dash.createMenu"),
    newPipeline: translate(locale, "dash.newPipeline"),
    pipelineItem: translate(locale, "dash.pipeline"),
    dialogTitle: translate(locale, "pipelineTemplates.title"),
    checking: translate(locale, "pipelineTemplates.checking"),
    emptyCopy: translate(locale, "pipelinePreflight.empty"),
    retry: translate(locale, "pipelineTemplates.retry"),
    blank: translate(locale, "pipelineTemplates.blank"),
    loading: translate(locale, "common.loadingCap"),
  };
}

/** One poll step: open the picker through the surface's real entry control if
    it is not up yet. Idempotent — re-running while open is a no-op. */
function openExpression(shot: EvidenceShot): string {
  const copy = copyFor(shot.locale);
  if (!shot.viewport.mobile) {
    return `(() => {
      if (document.querySelector("[data-pipeline-picker-state]")) return "open";
      const trigger = document.querySelector('button[aria-label=' + CSS.escape(${JSON.stringify(copy.newPipeline)}) + ']');
      if (!(trigger instanceof HTMLElement)) return "no-trigger";
      trigger.click();
      return "clicked";
    })()`;
  }
  return `(() => {
    if (document.querySelector("[data-pipeline-picker-state]")) return "open";
    const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((entry) => (entry.innerText || "").includes(${JSON.stringify(copy.pipelineItem)}));
    if (item instanceof HTMLElement) { item.click(); return "clicked-item"; }
    const trigger = document.querySelector('button[aria-label=' + CSS.escape(${JSON.stringify(copy.createMenu)}) + ']');
    if (!(trigger instanceof HTMLElement)) return "no-trigger";
    trigger.click();
    return "clicked-menu";
  })()`;
}

/** The #404 acceptance gates, evaluated inside the picker dialog: mounted
    blocked, zero spinners, localized empty-directory copy, no checking copy,
    and a focused editable repository input. Returns failure strings. */
function inspectExpression(shot: EvidenceShot): string {
  const copy = copyFor(shot.locale);
  return `(() => {
    const copy = ${JSON.stringify(copy)};
    const problems = [];
    const picker = document.querySelector("[data-pipeline-picker-state]");
    if (!picker) return ["picker overlay is missing"];
    const dialog = picker.querySelector('div[role="dialog"][aria-modal="true"]');
    if (!dialog) return ["picker dialog is missing"];
    if (picker.getAttribute("data-pipeline-picker-state") !== "blocked") {
      problems.push("picker state is " + picker.getAttribute("data-pipeline-picker-state"));
    }
    if (picker.querySelector(".animate-spin")) problems.push("a spinner is visible");
    const text = dialog.innerText || "";
    for (const needle of [copy.dialogTitle, copy.emptyCopy, copy.retry, copy.blank]) {
      if (!text.includes(needle)) problems.push("missing dialog text " + JSON.stringify(needle));
    }
    for (const needle of [copy.checking, copy.loading]) {
      if (text.includes(needle)) problems.push("unexpected dialog text " + JSON.stringify(needle));
    }
    const alert = dialog.querySelector('[role="alert"]');
    if (!alert) problems.push("missing blocked alert");
    const input = dialog.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      problems.push("missing repository input");
    } else {
      if (input.disabled) problems.push("repository input is disabled");
      if (input.value !== "") problems.push("repository input is not empty: " + JSON.stringify(input.value));
      if (document.activeElement !== input) {
        problems.push("repository input is not focused (active: " + (document.activeElement ? document.activeElement.tagName : "none") + ")");
      }
      const box = input.getBoundingClientRect();
      if (box.width < 200 || box.height < 30) problems.push("repository input is " + box.width.toFixed(1) + "x" + box.height.toFixed(1));
    }
    for (const element of [alert, input]) {
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) {
        problems.push(element.tagName + " leaves the " + innerWidth + "px viewport");
      }
    }
    return problems;
  })()`;
}

async function renderShot(
  cdp: Cdp,
  baseUrl: string,
  shot: EvidenceShot,
  capturePng: boolean,
): Promise<{ text: string; png: Buffer | null }> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: shot.viewport.width,
      height: shot.viewport.height,
      deviceScaleFactor: 1,
      mobile: shot.viewport.mobile,
    }, sessionId);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }, sessionId);
    const fixedMs = Date.parse(DEMO_FIXED_ISO);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const captureTime = ${fixedMs};
        const NativeDate = Date;
        class CaptureDate extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [captureTime])); }
          static now() { return captureTime; }
        }
        Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
        Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
        Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
        try {
          localStorage.clear();
          sessionStorage.clear();
          localStorage.setItem("llv_lang", ${JSON.stringify(shot.locale)});
          localStorage.setItem("llvSound", "0");
        } catch {}
      })();`,
    }, sessionId);
    await cdp.send("Page.navigate", { url: `${baseUrl}/#p=codex` }, sessionId);

    /* Wait for the codex dashboard, then open the picker through the real
       entry control; the poll retries until the blocked dialog is up. */
    const deadline = Date.now() + 90_000;
    let last = "";
    for (;;) {
      last = await evaluate<string>(cdp, sessionId, `(() => {
        if (document.readyState !== "complete") return "document " + document.readyState;
        if (document.fonts && document.fonts.status !== "loaded") return "fonts " + document.fonts.status;
        return ${openExpression(shot)};
      })()`);
      if (last === "open") break;
      if (Date.now() > deadline) {
        const text = await evaluate<string>(cdp, sessionId, "document.body ? document.body.innerText : \"(no body)\"");
        throw new Error(`${shot.id} never opened the picker: ${last}\nRendered text:\n${text}`);
      }
      await Bun.sleep(250);
    }

    await evaluate(cdp, sessionId, `(() => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(FREEZE_STYLE)};
      document.head.append(style);
    })()`);
    await evaluate(cdp, sessionId, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

    const gateDeadline = Date.now() + 30_000;
    for (;;) {
      const problems = await evaluate<string[]>(cdp, sessionId, inspectExpression(shot));
      if (!problems.length) break;
      if (Date.now() > gateDeadline) {
        if (process.env.LLV_EVIDENCE_DEBUG) {
          const debugShot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
          fs.writeFileSync(path.join(os.tmpdir(), `llv404-debug-${shot.id}.png`), Buffer.from(debugShot.data, "base64"));
        }
        throw new Error(`${shot.id} element gates failed:\n${problems.join("\n")}`);
      }
      await Bun.sleep(250);
    }

    /* The regression under test was a spinner that never resolves. Hold a
       real second, then require every gate to still pass — the blocked state
       is settled, not a frame on the way into "checking". */
    await Bun.sleep(1_000);
    const settled = await evaluate<string[]>(cdp, sessionId, inspectExpression(shot));
    if (settled.length) throw new Error(`${shot.id} state drifted after settling:\n${settled.join("\n")}`);

    const text = await evaluate<string>(cdp, sessionId, `document.querySelector("[data-pipeline-picker-state]").innerText`);
    let png: Buffer | null = null;
    if (capturePng) {
      const shotResult = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
      png = Buffer.from(shotResult.data, "base64");
    }
    return { text, png };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const outputDir = import.meta.dir;
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, DEFAULT_PORT, "LLV_EVIDENCE_PORT");
  /* A stale server on the port would silently serve outdated fixture state
     (Next auto-increments to a free port and the probes would never notice). */
  const ghost = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500) }).catch(() => null);
  if (ghost) throw new Error(`something already listens on port ${port} — stop it or set LLV_EVIDENCE_PORT`);
  /* Deep checkout paths overflow the unix-socket limit for the fixture tmux
     socket; park only the socket in a short-lived dir under the system tmp. */
  const tmuxDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "llv404-tmux-"));
  process.env.LLV_DEMO_TMUX_TMPDIR = tmuxDir;
  /* `next dev` rewrites the tsconfig include list for its dev type manifest;
     the capture must leave the checkout exactly as it found it. */
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const tsconfigBefore = fs.readFileSync(tsconfigPath, "utf8");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  const { env, root, serverLogs, shutdown } = runtime;

  seedCwdlessCodexSession(env.HOME!);

  process.once("SIGINT", () => { void shutdown(); process.exitCode = 130; });
  process.once("SIGTERM", () => { void shutdown(); process.exitCode = 143; });

  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    await runtime.waitUntilReady();
    const launched = await launchChrome(path.join(root, "chrome-profile"));
    chrome = launched.child;
    cdp = await Cdp.connect(launched.wsUrl);
    /* The demo env allows exactly LLV_DEV_ORIGINS=172.17.0.1 as the dev
       origin; rendering from any other origin makes Next dev silently block
       its own resources, so the local Chrome browses the bridge address. */
    const baseUrl = `http://172.17.0.1:${port}`;
    for (const shot of SHOTS) {
      const first = await renderShot(cdp, baseUrl, shot, true);
      const second = await renderShot(cdp, baseUrl, shot, false);
      const firstText = normalizeText(first.text);
      const secondText = normalizeText(second.text);
      if (firstText !== secondText) {
        let at = 0;
        while (at < Math.min(firstText.length, secondText.length) && firstText[at] === secondText[at]) at += 1;
        const context = (value: string) => JSON.stringify(value.slice(Math.max(0, at - 80), at + 160));
        throw new Error(
          `${shot.id} changed between deterministic passes at offset ${at}:\nfirst:  ${context(firstText)}\nsecond: ${context(secondText)}`,
        );
      }
      const output = path.join(outputDir, shot.output);
      fs.writeFileSync(output, first.png!);
      process.stdout.write(`${shot.output} ${first.png!.length} bytes\n`);
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverLogs()}`);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) chrome.kill("SIGKILL");
    await shutdown();
    fs.writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
    fs.rmSync(tmuxDir, { recursive: true, force: true });
  }
  await regenerateNextTypes(repoRoot, env);
  fs.writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
}

if (import.meta.main) await main();
