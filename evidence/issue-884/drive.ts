/**
 * Real-browser evidence for issue #884 — the `#a=` fragment makes the artifact
 * preview linkable: a pasted or bookmarked URL opens it directly on load.
 *
 *   bun evidence/issue-884/drive.ts
 *
 * PRODUCTION-SHAPED, exactly like the issue-875 driver it extends: builds the
 * EXACT current head (`next build --webpack`), serves it with `next start`
 * over the ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR;
 * never the operator's viewer state, never ports 8898/8899), and drives real
 * headless host Chrome over raw CDP. Every artifact fixture is SYNTHETIC and
 * generated at runtime into the disposable capture home.
 *
 * What the checks prove (issue #884 acceptance):
 *  - a URL pasted into a fresh tab whose fragment names a supported artifact
 *    opens the preview on load, with no prior conversation context, on
 *    desktop and in the 396 px mobile viewport;
 *  - the fragment reads bytes ONLY through /api/artifact — the same
 *    authorization a clicked link uses — so unsupported (.jsonl included),
 *    out-of-root and missing paths land on the explicit visible states while
 *    the URL stays put: never a silent redirect;
 *  - closing a fragment-opened preview strips the fragment in place (one
 *    replaceState, zero pushes, no reload) and leaves the app coherent;
 *  - browser Back closes a hash-opened preview and Forward reopens it, with
 *    the document alive throughout (#866 focus history untouched);
 *  - `#f=` keeps resolving conversation transcripts to their card, unchanged;
 *  - a fragment outside the app's vocabulary shows the explicit
 *    unknown-fragment notice instead of quietly landing on the default view.
 *
 * Output: evidence/issue-884/fragment.json (fixture ids, booleans only) and
 * screenshots of the rendered states. No absolute paths, no identities.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, demoPort } from "../../scripts/demo-capture";
import { S_ID, seedArtifacts, seedTranscript } from "../issue-875/seeds";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9341;

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const waiter = this.#pending.get(message.id)!;
        this.#pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP connect failed")));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(`page eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    }
    return result.result.value;
  }

  async screenshot(file: string): Promise<void> {
    const shot = (await this.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    fs.writeFileSync(path.join(import.meta.dir, file), Buffer.from(shot.data, "base64"));
  }

  close(): void {
    this.#ws.close();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function poll(cdp: Cdp, expression: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.eval<boolean>(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(250);
  }
}

async function click(cdp: Cdp, finder: string, label: string): Promise<void> {
  const clicked = await cdp.eval<boolean>(`(() => { const el = ${finder}; if (!el) return false; el.click(); return true; })()`);
  if (!clicked) throw new Error(`click target missing: ${label}`);
}

/** History writes, document identity and every fetch pathname, installed on
    every NEW document so load-time requests are captured too. */
const INSTRUMENT = `(() => {
  window.__pushes = 0; window.__replaces = 0; window.__marker = "alive";
  const hp = history.pushState.bind(history);
  const hr = history.replaceState.bind(history);
  history.pushState = (...a) => { window.__pushes++; return hp(...a); };
  history.replaceState = (...a) => { window.__replaces++; return hr(...a); };
  window.__fetchPaths = [];
  const of = window.fetch.bind(window);
  window.fetch = (...a) => {
    try { window.__fetchPaths.push(new URL(String(a[0] instanceof Request ? a[0].url : a[0]), location.href).pathname + new URL(String(a[0] instanceof Request ? a[0].url : a[0]), location.href).search); } catch {}
    return of(...a);
  };
})()`;

const SHEET = `document.querySelector('[data-artifact-preview]')`;
const sheetState = (state: string) => `(() => { const s = ${SHEET}; return !!s && s.getAttribute("data-artifact-state") === "${state}"; })()`;

const fragment = (p: string) => `#a=${encodeURIComponent(p)}`;

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3063, "LLV_EVIDENCE_PORT");
  const devHost = [172, 17, 0, 1].join(".");
  const checks: Check[] = [];
  const expect = (name: string, pass: boolean, detail: unknown = null) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : " — " + JSON.stringify(detail)}`);
  };

  /* ── The exact-head PRODUCTION build the server below serves ─────────── */
  const buildHead = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  if (process.env.LLV_EVIDENCE_SKIP_BUILD !== "1") {
    console.log(`building production head ${buildHead.slice(0, 12)}…`);
    const buildEnv = { ...process.env, NODE_ENV: "production" as const };
    delete (buildEnv as Record<string, unknown>).__NEXT_PRIVATE_STANDALONE_CONFIG;
    execSync("bunx next build --webpack", { cwd: repoRoot, env: buildEnv, stdio: "inherit" });
  }

  console.log("booting isolated demo runtime…");
  const prodPort = port + 1;
  /* An orphaned server from a crashed run would silently serve a STALE build
     to every check below. Refuse to start over an occupied port. */
  for (const candidate of [port, prodPort]) {
    const occupied = await fetch(`http://127.0.0.1:${candidate}/`, { signal: AbortSignal.timeout(1_000) }).then(() => true).catch(() => false);
    if (occupied) throw new Error(`port ${candidate} is already serving something — kill the stale server first`);
  }
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  const outsideDir = fs.mkdtempSync(path.join(runtime.root, "outside-"));
  let chrome: ChildProcess | null = null;
  let prodServer: ChildProcess | null = null;
  try {
    seedArtifacts(runtime.env.HOME!, outsideDir);
    const transcript = seedTranscript(runtime.env.HOME!, outsideDir);

    prodServer = spawn(
      "bunx",
      ["next", "start", "--hostname", "0.0.0.0", "--port", String(prodPort)],
      { cwd: repoRoot, env: { ...runtime.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const prodDeadline = Date.now() + 60_000;
    for (;;) {
      if (prodServer.exitCode !== null) throw new Error(`production server exited with ${prodServer.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${prodPort}/api/files`);
        if (response.ok) break;
      } catch {
        /* still booting */
      }
      if (Date.now() > prodDeadline) throw new Error("production server never became ready");
      await sleep(400);
    }
    console.log("production server ready");
    const baseUrl = `http://${devHost}:${prodPort}`;

    /* ── Headless host Chrome ─────────────────────────────────────────── */
    const profile = path.join(runtime.root, "chrome-profile");
    fs.mkdirSync(profile, { recursive: true });
    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--window-size=1440,900",
      "about:blank",
    ], { stdio: "ignore" });
    const cdpDeadline = Date.now() + 20_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        break;
      } catch {
        if (Date.now() > cdpDeadline) throw new Error("Chrome CDP endpoint never came up");
        await sleep(300);
      }
    }
    const newTarget = async (): Promise<Cdp> => {
      const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
      const target = (await created.json()) as { webSocketDebuggerUrl: string };
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
      return cdp;
    };

    /* ── Desktop: the pasted-URL open, in a FRESH tab with no app state ── */
    const tab = await newTarget();
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.send("Page.navigate", { url: `${baseUrl}/${fragment("~/artifacts/run.log")}` });
    await poll(tab, sheetState("ready"), "pasted #a= URL opened the preview on load", 120_000);
    const pasted = await tab.eval<{ kind: string | null; name: boolean; hash: string; artifactFetches: string[]; nav: number }>(`(() => ({
      kind: ${SHEET}.getAttribute("data-artifact-kind"),
      name: (${SHEET}.getAttribute("aria-label") || "").includes("run.log"),
      hash: location.hash,
      artifactFetches: window.__fetchPaths.filter((p) => p.includes("run.log")),
      nav: performance.getEntriesByType("navigation").length,
    }))()`);
    expect("a pasted URL opens the text preview directly on load, no conversation context",
      pasted.kind === "text" && pasted.name && pasted.hash === fragment("~/artifacts/run.log") && pasted.nav === 1,
      pasted);
    expect("the fragment read its bytes ONLY through /api/artifact — the clicked-link authorization",
      pasted.artifactFetches.length > 0 && pasted.artifactFetches.every((p) => p.startsWith("/api/artifact?")),
      pasted.artifactFetches);
    await tab.screenshot("desktop-pasted-open.png");

    /* Close: the fragment strips in place; the app stays coherent. */
    const beforeClose = await tab.eval<{ pushes: number; replaces: number; len: number }>(
      `({ pushes: window.__pushes, replaces: window.__replaces, len: history.length })`,
    );
    await click(tab, `${SHEET}.querySelector('[aria-label="Close preview"]')`, "close button");
    await poll(tab, `!${SHEET}`, "sheet closed");
    const afterClose = await tab.eval<{ pushes: number; replaces: number; len: number; hash: string; marker: string; nav: number; alive: boolean }>(`(() => ({
      pushes: window.__pushes, replaces: window.__replaces, len: history.length,
      hash: location.hash, marker: window.__marker,
      nav: performance.getEntriesByType("navigation").length,
      alive: document.querySelectorAll("body *").length > 50,
    }))()`);
    expect("closing the fragment-opened preview strips the fragment in place: one replaceState, zero pushes, no reload, app coherent",
      afterClose.hash === "" && afterClose.pushes === beforeClose.pushes
        && afterClose.replaces === beforeClose.replaces + 1 && afterClose.len === beforeClose.len
        && afterClose.marker === "alive" && afterClose.nav === 1 && afterClose.alive,
      { beforeClose, afterClose });
    await tab.screenshot("desktop-after-close.png");

    /* ── Explicit failure states, each from an in-tab pasted fragment ──── */
    const failureCase = async (target: string, state: string, label: string) => {
      await tab.eval(`(location.hash = ${JSON.stringify(fragment(target))}, true)`);
      await poll(tab, sheetState(state), `${label} → ${state}`, 30_000);
      const held = await tab.eval<{ hash: string; marker: string }>(`({ hash: location.hash, marker: window.__marker })`);
      expect(`a pasted ${label} lands on the explicit ${state} state with the URL held — no silent redirect`,
        held.hash === fragment(target) && held.marker === "alive", held);
    };
    await failureCase(`~/.claude/projects/x/${S_ID}.jsonl`, "unsupported", ".jsonl transcript fragment");
    await tab.screenshot("desktop-unsupported-jsonl.png");
    await failureCase(path.join(outsideDir, "denied.md"), "denied", "out-of-root fragment");
    await tab.screenshot("desktop-denied.png");
    await failureCase("~/artifacts/missing.md", "missing", "missing-file fragment");
    await tab.screenshot("desktop-missing.png");

    /* ── Back/Forward over a hash-opened preview ──────────────────────── */
    await tab.send("Page.navigate", { url: `${baseUrl}/` });
    await poll(tab, `document.querySelectorAll("body *").length > 50`, "app shell after clean navigation", 60_000);
    await tab.eval(`(location.hash = ${JSON.stringify(fragment("~/artifacts/board.png"))}, true)`);
    await poll(tab, sheetState("ready"), "hash assignment opened the image preview", 30_000);
    await tab.eval("(history.back(), true)");
    await poll(tab, `!${SHEET}`, "Back closed the hash-opened preview", 15_000);
    await tab.eval("(history.forward(), true)");
    await poll(tab, sheetState("ready"), "Forward reopened the preview", 15_000);
    const traversal = await tab.eval<{ marker: string; nav: number; hash: string }>(
      `({ marker: window.__marker, nav: performance.getEntriesByType("navigation").length, hash: location.hash })`,
    );
    expect("Back closes and Forward reopens the hash-opened preview with the same document alive",
      traversal.marker === "alive" && traversal.nav === 1 && traversal.hash === fragment("~/artifacts/board.png"),
      traversal);
    await tab.screenshot("desktop-forward-reopened.png");

    /* ── #f= still resolves conversation transcripts to their card ────── */
    await tab.send("Page.navigate", { url: `${baseUrl}/#f=${encodeURIComponent(transcript)}` });
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${S_ID}.jsonl"]')`, "#f= transcript deep link resolved to its card", 120_000);
    const transcriptLink = await tab.eval<{ preview: boolean; notice: boolean }>(`({
      preview: !!${SHEET},
      notice: !!document.querySelector("[data-unknown-fragment-notice]"),
    })`);
    expect("#f= keeps deep-linking the .jsonl transcript to its conversation card — no preview, no notice",
      !transcriptLink.preview && !transcriptLink.notice);
    await tab.screenshot("desktop-transcript-deeplink.png");

    /* ── An uninterpretable fragment says so ──────────────────────────── */
    await tab.send("Page.navigate", { url: `${baseUrl}/#not-a-known-key` });
    await poll(tab, `!!document.querySelector("[data-unknown-fragment-notice]")`, "unknown-fragment notice rendered", 60_000);
    const unknown = await tab.eval<{ text: string; preview: boolean }>(`({
      text: document.querySelector("[data-unknown-fragment-notice]").textContent || "",
      preview: !!${SHEET},
    })`);
    expect("a fragment the app cannot interpret shows the explicit notice instead of quietly navigating away",
      unknown.text.length > 0 && !unknown.preview, unknown);
    await tab.screenshot("desktop-unknown-fragment.png");
    tab.close();

    /* ── 396 px mobile: the same pasted URL opens the full-height sheet ── */
    const mob = await newTarget();
    await mob.send("Emulation.setDeviceMetricsOverride", { width: 396, height: 780, deviceScaleFactor: 2, mobile: true });
    await mob.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await mob.send("Page.navigate", { url: `${baseUrl}/${fragment("~/artifacts/board.png")}` });
    await poll(mob, sheetState("ready"), "mobile pasted #a= URL opened the preview", 120_000);
    const mobile = await mob.eval<{ role: string | null; label: boolean; fullHeight: boolean; fullWidth: boolean; closeBox: { w: number; h: number } }>(`(() => {
      const s = ${SHEET};
      const rect = s.getBoundingClientRect();
      const close = s.querySelector('[aria-label="Close preview"]').getBoundingClientRect();
      return {
        role: s.getAttribute("role"),
        label: (s.getAttribute("aria-label") || "").includes("board.png"),
        fullHeight: Math.round(rect.height) >= window.innerHeight - 1,
        fullWidth: Math.round(rect.width) >= window.innerWidth - 1,
        closeBox: { w: Math.round(close.width), h: Math.round(close.height) },
      };
    })()`);
    expect("396px: the pasted URL opens a full-height labelled dialog with 44px close target",
      mobile.role === "dialog" && mobile.label && mobile.fullHeight && mobile.fullWidth
        && mobile.closeBox.w >= 44 && mobile.closeBox.h >= 44,
      mobile);
    await mob.screenshot("mobile-pasted-open.png");
    await mob.eval(`(location.hash = ${JSON.stringify(fragment("~/artifacts/missing.md"))}, true)`);
    await poll(mob, sheetState("missing"), "mobile missing state", 30_000);
    await mob.screenshot("mobile-missing.png");
    mob.close();

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 884,
      capturedAt: new Date().toISOString(),
      buildHead,
      runner: "exact-head production build served by `next start` over the isolated demo runtime (fixtures/demo-home); synthetic runtime-generated artifact fixtures; headless host Chrome over raw CDP",
      screenshots: [
        "desktop-pasted-open.png", "desktop-after-close.png",
        "desktop-unsupported-jsonl.png", "desktop-denied.png", "desktop-missing.png",
        "desktop-forward-reopened.png", "desktop-transcript-deeplink.png",
        "desktop-unknown-fragment.png",
        "mobile-pasted-open.png", "mobile-missing.png",
      ],
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(
      path.join(import.meta.dir, "fragment.json"),
      (JSON.stringify(output, null, 2) + "\n")
        .replaceAll(repoRoot, "<repo>")
        .replaceAll(runtime.root, "<capture>")
        .replaceAll(outsideDir, "<outside>")
        /* The denied-case detail holds the pasted fragment, which carries the
           outside dir percent-ENCODED — scrub that spelling too. */
        .replaceAll(encodeURIComponent(outsideDir), encodeURIComponent("/outside"))
        .replaceAll(encodeURIComponent(repoRoot), encodeURIComponent("/repo"))
        .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1-x"),
    );
    console.log(`\n${output.verdict}: ${checks.length - failed.length}/${checks.length} checks`);
    if (failed.length) process.exitCode = 1;
  } finally {
    chrome?.kill("SIGKILL");
    prodServer?.kill("SIGTERM");
    fs.rmSync(outsideDir, { recursive: true, force: true });
    await runtime.shutdown();
  }
}

await main();
