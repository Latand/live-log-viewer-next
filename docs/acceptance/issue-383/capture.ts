/**
 * Issue #383 acceptance evidence: deterministic stills of the supersedence
 * surfaces, regenerated with:
 *
 *   bun docs/acceptance/issue-383/capture.ts
 *
 * The run reuses the Stage A demo runtime (isolated fixture home + dev
 * server), seeds one durable supersedence edge in the fixture agent registry
 * (atlas round 1 → the live pending-question round 2), and renders with the
 * system Chrome over raw CDP — the pinned mcp/puppeteer container is not
 * available on every capture host. Determinism mirrors the demo harness:
 * frozen clock at DEMO_FIXED_ISO, EventSource/IntersectionObserver disabled,
 * animations zeroed, and every shot rendered twice with an innerText equality
 * gate plus element-visibility assertions before publication.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bootstrapDemoRuntime,
  claudePath,
  DEMO_FIXED_ISO,
  demoPort,
  regenerateNextTypes,
  renderFixtureTemplate,
} from "../../../scripts/demo-capture";
import { AgentRegistry } from "../../../src/lib/agent/registry";

const DEFAULT_PORT = 3383;
/** Two minutes before the frozen page clock, so the banner reads a stable age. */
const SUPERSEDED_AT_ISO = "2100-01-02T11:58:00.000Z";
const PREDECESSOR_SESSION = "11111111-1111-4111-8111-111111111111.jsonl";
const SUCCESSOR_SESSION = "22222222-2222-4222-8222-222222222222.jsonl";

type EvidenceShot = {
  id: string;
  output: string;
  viewport: { width: number; height: number; mobile: boolean };
  /** Location hash naming the surface; `__PRED__`/`__SUCC__` resolve to the
      materialized fixture transcript paths. */
  hash: string;
  /** When set, click this transcript's "Expand" control after readiness so the
      shot frames the full-size pane dialog (the demo-harness interaction). */
  expandFile?: string;
  /** When set, root the text/element gates at this transcript's own pane
      (`section[data-link-path]`): the mobile chrome around the focused pane
      keeps other conversations' text (shelf previews, hidden list) in the DOM,
      which must not leak into the determinism or absent-text checks. */
  scopeFile?: string;
  stableText: string[];
  absentText: string[];
  visible: Array<{ selector: string; text: string | null; minWidth: number; minHeight: number }>;
};

const SHOTS: EvidenceShot[] = [
  {
    /* The atlas board: the retired round sits demoted beside its live
       successor — banner in place of the composer, successor still working. */
    id: "superseded-desktop",
    output: "superseded-round-desktop-1440.png",
    viewport: { width: 1440, height: 900, mobile: false },
    hash: "#p=atlas",
    stableText: [
      "Round superseded",
      "Open the live round",
      "Resume here",
      "round 2 · continues previous",
      /* The account badge hint resolves async from /api/accounts; waiting for
         the resolved health suffix keeps both deterministic passes identical. */
      "Signed out",
    ],
    /* A feed still fetching shows "Loading…" (adjacent mobile swipe panes
       included); the gate poll waits it out so both passes read loaded text. */
    absentText: ["Loading…"],
    visible: [
      { selector: "[data-superseded-banner]", text: "Open the live round", minWidth: 220, minHeight: 36 },
      { selector: "[data-continues-chip]", text: "round 2", minWidth: 48, minHeight: 8 },
    ],
  },
  {
    id: "superseded-mobile",
    output: "superseded-round-mobile-390.png",
    viewport: { width: 390, height: 844, mobile: true },
    hash: "#f=__PRED__",
    scopeFile: "__PRED__",
    stableText: ["Round superseded", "Open the live round", "Resume here", "Signed out"],
    absentText: ["Loading…"],
    visible: [
      { selector: "[data-superseded-banner]", text: "Open the live round", minWidth: 240, minHeight: 60 },
    ],
  },
  {
    /* Full-size successor pane: lineage chip in the header, live feed, and the
       ordinary composer accepting input. */
    id: "successor-desktop",
    output: "successor-lineage-desktop-1440.png",
    viewport: { width: 1440, height: 900, mobile: false },
    hash: "#f=__SUCC__",
    expandFile: "__SUCC__",
    stableText: ["round 2 · continues previous", "Choose the hero framing", "Signed out"],
    absentText: ["Round superseded", "Loading…"],
    visible: [
      { selector: "[data-continues-chip]", text: "round 2", minWidth: 60, minHeight: 8 },
      { selector: "textarea", text: null, minWidth: 200, minHeight: 20 },
    ],
  },
  {
    id: "successor-mobile",
    output: "successor-lineage-mobile-390.png",
    viewport: { width: 390, height: 844, mobile: true },
    hash: "#f=__SUCC__",
    scopeFile: "__SUCC__",
    stableText: ["round 2 · continues previous", "Signed out"],
    absentText: ["Round superseded", "Loading…"],
    visible: [
      { selector: "[data-continues-chip]", text: "round 2", minWidth: 60, minHeight: 8 },
      { selector: "textarea", text: null, minWidth: 200, minHeight: 20 },
    ],
  },
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
  button[aria-label^="Copy"],
  button[aria-label^="Read answer"],
  button[aria-label="Enable sound notifications"] { opacity: 0 !important; }
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
  private readonly eventListeners = new Set<(method: string, params: unknown, sessionId?: string) => void>();
  private constructor(private readonly ws: WebSocket) {}

  onEvent(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

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
    const message = JSON.parse(raw) as {
      id?: number; result?: unknown; error?: { message: string };
      method?: string; params?: unknown; sessionId?: string;
    };
    if (message.id === undefined) {
      if (message.method) {
        for (const listener of this.eventListeners) listener(message.method, message.params, message.sessionId);
      }
      return;
    }
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

/** Root the page-side checks either at the body or — for expandFile shots —
    at the full-window pane dialog: the board behind that opaque overlay stays
    in the DOM, so body-level text would leak the other panes' surfaces. */
function scopeExpression(shot: EvidenceShot): string {
  if (shot.expandFile) return `document.querySelector('div[role="dialog"][aria-modal="true"]')`;
  if (shot.scopeFile) return `document.querySelector('section[data-link-path=' + CSS.escape(${JSON.stringify(shot.scopeFile)}) + ']')`;
  return "document.body";
}

/** The element gates as a page-side expression; returns failure strings. */
function inspectExpression(shot: EvidenceShot): string {
  return `(() => {
    const shot = ${JSON.stringify({ visible: shot.visible, absentText: shot.absentText })};
    const scope = ${scopeExpression(shot)};
    if (!scope) return ["expanded pane dialog is missing"];
    const problems = [];
    for (const expected of shot.visible) {
      const candidates = Array.from(scope.querySelectorAll(expected.selector))
        .filter((el) => expected.text === null || (el.innerText || "").includes(expected.text))
        .sort((a, b) => {
          const ab = a.getBoundingClientRect();
          const bb = b.getBoundingClientRect();
          return bb.width * bb.height - ab.width * ab.height;
        });
      const element = candidates[0];
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        problems.push("missing " + expected.selector + " containing " + JSON.stringify(expected.text));
        continue;
      }
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        problems.push(expected.selector + " is hidden");
      }
      if (box.width < expected.minWidth || box.height < expected.minHeight) {
        problems.push(expected.selector + " is " + box.width.toFixed(1) + "x" + box.height.toFixed(1));
      }
      if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) {
        problems.push(expected.selector + " leaves the " + innerWidth + "px viewport");
      }
    }
    for (const text of shot.absentText) {
      if ((scope.innerText || "").includes(text)) problems.push("unexpected text " + JSON.stringify(text));
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
  const diagnostics: string[] = [];
  const stopListening = cdp.onEvent((method, params, eventSession) => {
    if (eventSession !== sessionId) return;
    if (method === "Runtime.exceptionThrown") {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
      diagnostics.push(`page exception: ${details?.exception?.description ?? details?.text ?? "unknown"}`);
    }
    if (method === "Runtime.consoleAPICalled") {
      const call = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (call.type === "error" || call.type === "warning") {
        const rendered = (call.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
        diagnostics.push(`console ${call.type}: ${rendered}`.slice(0, 500));
      }
    }
  });
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
          localStorage.setItem("llv_lang", "en");
          localStorage.setItem("llvSound", "0");
        } catch {}
      })();`,
    }, sessionId);
    await cdp.send("Page.navigate", { url: `${baseUrl}/${shot.hash}` }, sessionId);

    const deadline = Date.now() + 90_000;
    const readiness = `(() => {
      const needles = ${JSON.stringify(shot.stableText)};
      if (document.readyState !== "complete") return "document " + document.readyState;
      if (document.fonts && document.fonts.status !== "loaded") return "fonts " + document.fonts.status;
      const text = document.body ? document.body.innerText : "";
      const missing = needles.filter((needle) => !text.includes(needle));
      return missing.length ? "missing " + JSON.stringify(missing) : "ready";
    })()`;
    let last = "";
    for (;;) {
      last = await evaluate<string>(cdp, sessionId, readiness);
      if (last === "ready") break;
      if (Date.now() > deadline) {
        const text = await evaluate<string>(cdp, sessionId, "document.body ? document.body.innerText : \"(no body)\"");
        throw new Error(`${shot.id} readiness timed out: ${last}\nDiagnostics:\n${diagnostics.join("\n")}\nRendered text:\n${text}`);
      }
      await Bun.sleep(250);
    }

    if (shot.expandFile) {
      /* The demo-harness interaction: the board pane's own header control
         opens the full-window dialog of exactly this conversation. */
      await evaluate(cdp, sessionId, `(() => {
        const section = Array.from(document.querySelectorAll("section[data-link-path]"))
          .find((el) => el.getAttribute("data-link-path") === ${JSON.stringify(shot.expandFile)});
        const expand = Array.from(section ? section.querySelectorAll("button") : [])
          .find((button) => (button.getAttribute("aria-label") || "").startsWith("Expand "));
        if (!(expand instanceof HTMLElement)) throw new Error("missing expand control for " + ${JSON.stringify(shot.expandFile)});
        expand.click();
      })()`);
      const dialogReadiness = `(() => {
        const scope = ${scopeExpression(shot)};
        if (!scope) return "dialog missing";
        const needles = ${JSON.stringify(shot.stableText)};
        const text = scope.innerText || "";
        const missing = needles.filter((needle) => !text.includes(needle));
        return missing.length ? "dialog missing " + JSON.stringify(missing) : "ready";
      })()`;
      const dialogDeadline = Date.now() + 30_000;
      for (;;) {
        last = await evaluate<string>(cdp, sessionId, dialogReadiness);
        if (last === "ready") break;
        if (Date.now() > dialogDeadline) {
          throw new Error(`${shot.id} expanded dialog timed out: ${last}\nDiagnostics:\n${diagnostics.join("\n")}`);
        }
        await Bun.sleep(250);
      }
    }

    await evaluate(cdp, sessionId, `(() => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(FREEZE_STYLE)};
      document.head.append(style);
      const close = document.querySelector('button[aria-label="Close the notification"]');
      if (close instanceof HTMLElement) close.click();
    })()`);
    await evaluate(cdp, sessionId, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

    const gateDeadline = Date.now() + 30_000;
    for (;;) {
      const problems = await evaluate<string[]>(cdp, sessionId, inspectExpression(shot));
      if (!problems.length) break;
      if (Date.now() > gateDeadline) {
        if (process.env.LLV_EVIDENCE_DEBUG) {
          const debugShot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
          fs.writeFileSync(path.join(os.tmpdir(), `llv383-debug-${shot.id}.png`), Buffer.from(debugShot.data, "base64"));
        }
        throw new Error(`${shot.id} element gates failed:\n${problems.join("\n")}`);
      }
      await Bun.sleep(250);
    }

    const text = await evaluate<string>(cdp, sessionId, `(${scopeExpression(shot)}).innerText`);
    let png: Buffer | null = null;
    if (capturePng) {
      const shotResult = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
      png = Buffer.from(shotResult.data, "base64");
    }
    return { text, png };
  } finally {
    stopListening();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Seed the one durable supersedence edge the evidence renders (#383):
    atlas round 1 terminally superseded by the live pending-question round 2.
    Uses the registry's own mutation API — the same path the product takes —
    then pins the edge timestamp to the frozen capture clock. */
function seedSupersedence(stateDir: string, predecessorPath: string, successorPath: string): void {
  const registryFile = path.join(stateDir, "agent-registry.json");
  const registry = new AgentRegistry(registryFile);
  const predecessor = registry.ensureConversation("claude", predecessorPath, null);
  const successor = registry.ensureConversation("claude", successorPath, null);
  registry.recordSupersedence(predecessor.id, successor.id, "recovery-spawn");
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    conversations: Record<string, { supersededBy?: { at: string } | null }>;
  };
  const edge = raw.conversations[predecessor.id]?.supersededBy;
  if (!edge) throw new Error("supersedence edge did not commit");
  edge.at = SUPERSEDED_AT_ISO;
  fs.writeFileSync(registryFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
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
  const tmuxDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "llv383-tmux-"));
  process.env.LLV_DEMO_TMUX_TMPDIR = tmuxDir;
  /* `next dev` rewrites the tsconfig include list for its dev type manifest;
     the capture must leave the checkout exactly as it found it. */
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const tsconfigBefore = fs.readFileSync(tsconfigPath, "utf8");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  const { env, root, serverLogs, shutdown } = runtime;

  const predecessorPath = renderFixtureTemplate(claudePath("atlas", PREDECESSOR_SESSION), env.HOME!);
  const successorPath = renderFixtureTemplate(claudePath("atlas", SUCCESSOR_SESSION), env.HOME!);
  seedSupersedence(env.LLV_STATE_DIR!, predecessorPath, successorPath);

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
       origin (the docker-bridge address the pinned puppeteer container uses).
       Rendering from any other origin makes Next dev silently block its own
       resources and the page never hydrates — so the local Chrome browses the
       same bridge address. */
    const baseUrl = `http://172.17.0.1:${port}`;
    for (const shot of SHOTS) {
      const resolved: EvidenceShot = {
        ...shot,
        hash: shot.hash
          .replace("__PRED__", encodeURIComponent(predecessorPath))
          .replace("__SUCC__", encodeURIComponent(successorPath)),
        expandFile: shot.expandFile
          ?.replace("__PRED__", predecessorPath)
          .replace("__SUCC__", successorPath),
        scopeFile: shot.scopeFile
          ?.replace("__PRED__", predecessorPath)
          .replace("__SUCC__", successorPath),
      };
      const first = await renderShot(cdp, baseUrl, resolved, true);
      const second = await renderShot(cdp, baseUrl, resolved, false);
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
