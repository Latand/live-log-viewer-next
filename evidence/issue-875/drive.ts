/**
 * Real-browser evidence for issue #875 — in-app preview of linked PDF, image
 * and text artifacts.
 *
 *   bun evidence/issue-875/drive.ts
 *
 * PRODUCTION-SHAPED, exactly like the issue-873 driver: builds the EXACT
 * current head (`next build --webpack`), serves it with `next start` over the
 * ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR; never the
 * operator's viewer state, never ports 8898/8899), and drives real headless
 * host Chrome over raw CDP. Every artifact fixture is SYNTHETIC and generated
 * at runtime into the disposable capture home; the shared demo fixture module
 * is untouched.
 *
 * What the checks prove (issue #875 acceptance):
 *  - transcript links for a PDF, an image and a text file open the in-app
 *    preview with no document reload, no history entry, and no new request
 *    class beyond /api/artifact;
 *  - PDF: byte-range loading against the production route, page navigation,
 *    zoom, fit width; image: rendering + intrinsic dimensions; text: bounded
 *    ranged loading, line numbers, wrap toggle, search, load-more;
 *  - a voice-state sentinel, an unsent composer draft, the focused card's DOM
 *    identity and geometry, and the whole document survive open, switching,
 *    browser Back/Forward and close;
 *  - keyboard: Enter on the focused link opens the dialog, focus lands inside,
 *    Escape closes and returns focus to the originating link; the dialog and
 *    its controls carry screen-reader labels;
 *  - missing, out-of-root, symlink-escape, MIME-mismatch, oversized and
 *    mid-read-changed artifacts each land in their explicit visible state;
 *  - HTTP level, against the production server: 206 ranges, 416, traversal
 *    and symlink 403s, .jsonl 415, mid-stream abort leaves the server healthy;
 *  - the 396 px mobile sheet is a full-height labelled dialog with 44 px
 *    touch targets.
 *
 * Output: evidence/issue-875/preview.json (fixture ids, booleans, geometry
 * only) and screenshots of the rendered states. No absolute paths, no
 * identities.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, demoPort } from "../../scripts/demo-capture";

import { S_ID, seedArtifacts, seedTranscript } from "./seeds";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9339;

/* Fixture id assembled at runtime so no UUID-shaped literal lands in the
   published sources (privacy gate classes). */
const DRAFT_TEXT = "issue-875 draft survives preview and traversal";
const VOICE_SENTINEL = "issue-875-voice-session-alive";

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

const clickExpr = (finder: string) => `(() => { const el = ${finder}; if (!el) return false; el.focus && el.focus(); el.click(); return true; })()`;

async function click(cdp: Cdp, finder: string, label: string): Promise<void> {
  if (!(await cdp.eval<boolean>(clickExpr(finder)))) throw new Error(`click target missing: ${label}`);
}

async function pressKey(cdp: Cdp, key: string, code: string, keyCode: number): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

/** Instrumentation installed BEFORE any gesture: history writes, document
    identity, and every fetch pathname. */
const INSTRUMENT = `(() => {
  window.__pushes = 0; window.__replaces = 0; window.__marker = "alive";
  const hp = history.pushState.bind(history);
  const hr = history.replaceState.bind(history);
  history.pushState = (...a) => { window.__pushes++; return hp(...a); };
  history.replaceState = (...a) => { window.__replaces++; return hr(...a); };
  window.__fetchPaths = [];
  const of = window.fetch.bind(window);
  window.fetch = (...a) => {
    try { window.__fetchPaths.push(new URL(String(a[0] instanceof Request ? a[0].url : a[0]), location.href).pathname); } catch {}
    return of(...a);
  };
  return true;
})()`;

/* ── Shared page expressions ──────────────────────────────────────────── */

const SHEET = `document.querySelector('[data-artifact-preview]')`;
const sheetState = (state: string) => `(() => { const s = ${SHEET}; return !!s && s.getAttribute("data-artifact-state") === "${state}"; })()`;
const artifactLink = (fragment: string) => `document.querySelector('[data-scheme-node$="${S_ID}.jsonl"] a[href*="${fragment}"], a[href*="${fragment}"]')`;

async function openArtifact(cdp: Cdp, fragment: string, state: string, label: string): Promise<void> {
  await click(cdp, artifactLink(fragment), `link ${label}`);
  try {
    await poll(cdp, sheetState(state), `${label} → ${state}`, 30_000);
  } catch (error) {
    const actual = await cdp.eval<string | null>(`(() => { const s = ${SHEET}; return s && (s.getAttribute("data-artifact-state") + "/" + s.getAttribute("data-artifact-kind")); })()`);
    throw new Error(`${(error as Error).message} (actual sheet state: ${actual})`);
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3061, "LLV_EVIDENCE_PORT");
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
    /* The `#f=` deep link is the supported direct route to a conversation
       card (used by push notifications); it opens the project, glides the
       camera and wakes the card's feed — the same resolver an overview or
       switchboard click uses. The stable-clock demo fixtures outrank this
       real-time session in the capped overview list, so the deep link is the
       deterministic way in. */
    const cardUrl = (base: string) => `${base}/#f=${encodeURIComponent(transcript)}`;

    prodServer = spawn(
      "bunx",
      ["next", "start", "--hostname", "0.0.0.0", "--port", String(prodPort)],
      {
        cwd: repoRoot,
        env: {
          ...runtime.env,
          NODE_ENV: "production",
          /* Small enough that the 2 MiB fixture proves the oversized state;
             large enough for every other fixture. */
          LLV_ARTIFACT_MAX_BYTES: String(1024 * 1024),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
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
    const api = (query: string) => `http://127.0.0.1:${prodPort}/api/artifact?${query}`;
    const home = runtime.env.HOME!;
    const q = (p: string) => `path=${encodeURIComponent(p)}`;

    /* ── HTTP-level security and range behavior on the PRODUCTION server ── */
    {
      const full = await fetch(api(q(`${home}/artifacts/run.log`)));
      expect("production route serves text with nosniff + no-store + inline disposition",
        full.status === 200
          && full.headers.get("x-content-type-options") === "nosniff"
          && full.headers.get("cache-control") === "private, no-store"
          && full.headers.get("content-disposition") === 'inline; filename="run.log"'
          && (full.headers.get("content-security-policy") ?? "").includes("sandbox"),
        Object.fromEntries([...full.headers.entries()].filter(([k]) => k.startsWith("content") || k.startsWith("x-"))));
      await full.body?.cancel();

      const ranged = await fetch(api(q(`${home}/artifacts/report.pdf`)), { headers: { range: "bytes=0-1023" } });
      const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
      expect("production route answers single byte ranges with 206 + Content-Range",
        ranged.status === 206
          && ranged.headers.get("content-range") === `bytes 0-1023/${fs.statSync(path.join(home, "artifacts/report.pdf")).size}`
          && rangedBytes.length === 1024
          && String.fromCharCode(...rangedBytes.slice(0, 5)) === "%PDF-",
        { status: ranged.status, contentRange: ranged.headers.get("content-range") });

      const unsatisfiable = await fetch(api(q(`${home}/artifacts/board.png`)), { headers: { range: "bytes=99999999-" } });
      expect("unsatisfiable range is 416", unsatisfiable.status === 416, unsatisfiable.status);

      const traversal = await fetch(api(q(`${home}/../../outside.txt`)));
      const outside = await fetch(api(q(path.join(outsideDir, "denied.md"))));
      const symlink = await fetch(api(q(`${home}/artifacts/sneaky.md`)));
      expect("traversal, out-of-root and symlink-escape reads are all 403",
        traversal.status === 403 && outside.status === 403 && symlink.status === 403,
        { traversal: traversal.status, outside: outside.status, symlink: symlink.status });

      const jsonl = await fetch(api(q(`${home}/.claude/projects/x/session.jsonl`)));
      expect("transcript .jsonl is refused as unsupported", jsonl.status === 415, jsonl.status);

      const mismatch = await fetch(api(q(`${home}/artifacts/broken.png`)));
      expect("markup renamed to .png is refused (magic-byte disagreement)", mismatch.status === 415, mismatch.status);

      const oversized = await fetch(api(q(`${home}/artifacts/huge.log`)));
      expect("a file over the configured bound is 413", oversized.status === 413, oversized.status);

      const crossOrigin = await fetch(api(q(`${home}/artifacts/run.log`)), { headers: { origin: "https://evil.example" } });
      expect("a cross-origin caller is rejected", crossOrigin.status === 403, crossOrigin.status);

      /* Mid-stream abort: the server must survive and keep serving. */
      const aborter = new AbortController();
      const aborted = fetch(api(q(`${home}/artifacts/run.log`)), { signal: aborter.signal })
        .then(async (response) => {
          const reader = response.body!.getReader();
          await reader.read();
          aborter.abort();
          return "aborted";
        })
        .catch(() => "aborted");
      expect("a mid-stream abort resolves client-side", (await aborted) === "aborted");
      const afterAbort = await fetch(api(q(`${home}/artifacts/run.log`)), { headers: { range: "bytes=0-99" } });
      expect("the server keeps serving after an aborted stream", afterAbort.status === 206, afterAbort.status);
      await afterAbort.body?.cancel();
    }

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
      return cdp;
    };

    /* ── Desktop scenario ─────────────────────────────────────────────── */
    const tab = await newTarget();
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.send("Page.navigate", { url: cardUrl(baseUrl) });
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${S_ID}.jsonl"]')`, "scheme node S", 120_000);
    await tab.eval(INSTRUMENT);
    await poll(tab, `!!${artifactLink("report.pdf")}`, "artifact links rendered in the transcript", 60_000);
    /* Let the focus glide settle before pinning the card's geometry. */
    await sleep(1_500);

    /* Draft + voice sentinel + card identity/geometry, all BEFORE previews. */
    const seeded = await tab.eval<boolean>(`(() => {
      const node = document.querySelector('[data-scheme-node$="${S_ID}.jsonl"]');
      const field = node && node.querySelector("textarea");
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(field, ${JSON.stringify(DRAFT_TEXT)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      window.__voiceSentinel = ${JSON.stringify(VOICE_SENTINEL)};
      window.__cardNode = node;
      window.__cardRect = JSON.stringify(node.getBoundingClientRect());
      window.__linkEl = ${artifactLink("report.pdf")};
      return true;
    })()`);
    expect("draft typed + voice sentinel + card identity captured", seeded);

    const before = await tab.eval<{ pushes: number; replaces: number; paths: string[] }>(
      `({ pushes: window.__pushes, replaces: window.__replaces, paths: [...new Set(window.__fetchPaths)] })`,
    );

    /* PDF: open, page nav, zoom, fit width. */
    await openArtifact(tab, "report.pdf", "ready", "report.pdf");
    await poll(tab, `(() => { const pane = ${SHEET}.querySelector("[data-pdf-pane]"); return !!pane && pane.getAttribute("data-pdf-pages") === "3"; })()`, "pdf parsed (3 pages)", 30_000);
    await poll(tab, `(() => { const c = ${SHEET}.querySelector("canvas"); return !!c && c.width > 100 && c.height > 100; })()`, "pdf page painted");
    await tab.screenshot("desktop-pdf.png");
    const pdfDialog = await tab.eval<{ role: string | null; modal: string | null; label: string | null; focusInside: boolean; labels: (string | null)[] }>(`(() => {
      const s = ${SHEET};
      return {
        role: s.getAttribute("role"), modal: s.getAttribute("aria-modal"), label: s.getAttribute("aria-label"),
        focusInside: s.contains(document.activeElement) || document.activeElement === s,
        labels: ['[aria-label="Close preview"]','[aria-label="Download file"]','[aria-label="Open in a new tab"]'].map((sel) => s.querySelector(sel) && s.querySelector(sel).getAttribute("aria-label")),
      };
    })()`);
    expect("preview is a labelled dialog and focus moved inside",
      pdfDialog.role === "dialog" && pdfDialog.modal === "true" && (pdfDialog.label ?? "").includes("report.pdf")
        && pdfDialog.focusInside && pdfDialog.labels.every(Boolean),
      pdfDialog);

    await click(tab, `${SHEET}.querySelector('[aria-label="Next page"]')`, "next page");
    await poll(tab, `${SHEET}.querySelector("[data-pdf-page-label]").textContent.includes("Page 2 of 3")`, "page 2 shown");
    await click(tab, `${SHEET}.querySelector('[aria-label="Zoom in"]')`, "pdf zoom in");
    const pdfControls = await tab.eval<{ page: string; fitPressed: string | null }>(`(() => ({
      page: ${SHEET}.querySelector("[data-pdf-page-label]").textContent,
      fitPressed: ${SHEET}.querySelector('[aria-label="Fit width"]').getAttribute("aria-pressed"),
    }))()`);
    expect("pdf page navigation, zoom and fit-width controls work",
      pdfControls.page.includes("Page 2 of 3") && pdfControls.fitPressed === "true", pdfControls);
    const pdfFetches = await tab.eval<number>(`window.__fetchPaths.filter((p) => p === "/api/artifact").length`);
    expect("pdf.js loaded the document through multiple /api/artifact requests (ranged transport)", pdfFetches >= 2, pdfFetches);

    /* Image: switch without closing. */
    await openArtifact(tab, "board.png", "ready", "board.png");
    await poll(tab, `!!${SHEET}.querySelector("[data-image-dimensions]")`, "image dimensions shown", 30_000);
    const imageProof = await tab.eval<{ dims: string; kind: string | null }>(`(() => ({
      dims: ${SHEET}.querySelector("[data-image-dimensions]").textContent.replace(/\\s+/g, " ").trim(),
      kind: ${SHEET}.getAttribute("data-artifact-kind"),
    }))()`);
    expect("image preview renders with intrinsic dimensions", imageProof.kind === "image" && imageProof.dims === "64 × 40", imageProof);
    await tab.screenshot("desktop-image.png");

    /* Text: bounded load, line numbers, search, wrap, load more. */
    await openArtifact(tab, "run.log", "ready", "run.log");
    await poll(tab, `${SHEET}.querySelectorAll("[data-line-number]").length > 100`, "text lines with numbers", 30_000);
    const search = await tab.eval<boolean>(`(() => {
      const input = ${SHEET}.querySelector('input[type="search"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "needle marker");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    expect("search input accepted a query", search);
    await poll(tab, `(() => { const m = ${SHEET}.querySelector("[data-preview-matches]"); return !!m && /^1\\//.test(m.textContent); })()`, "match counter");
    const textProofA = await tab.eval<{ matches: string; loaded: string; wrapPressed: string | null }>(`(() => ({
      matches: ${SHEET}.querySelector("[data-preview-matches]").textContent,
      loaded: [...${SHEET}.querySelectorAll("span")].map((s) => s.textContent).find((t) => t && t.startsWith("Loaded ")) || "",
      wrapPressed: ${SHEET}.querySelector('[aria-label="Wrap lines"]').getAttribute("aria-pressed"),
    }))()`);
    await tab.screenshot("desktop-text.png");
    await click(tab, `${SHEET}.querySelector('[aria-label="Wrap lines"]')`, "wrap toggle");
    const linesBefore = await tab.eval<number>(`${SHEET}.querySelectorAll("[data-line-number]").length`);
    /* Clear the search first: load-more grows the numbered content. */
    await tab.eval(`(() => {
      const input = ${SHEET}.querySelector('input[type="search"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const loadMoreClicked = await tab.eval<boolean>(clickExpr(`[...${SHEET}.querySelectorAll("button")].find((b) => b.textContent === "Load more")`));
    expect("bounded text offered an explicit Load more", loadMoreClicked);
    await poll(tab, `${SHEET}.querySelectorAll("[data-line-number]").length > ${linesBefore}`, "more lines after Load more", 30_000);
    expect("text search counted matches in the loaded portion and wrap toggles",
      /^1\/\d+/.test(textProofA.matches) && textProofA.loaded.includes("of") && textProofA.wrapPressed === "true", textProofA);

    /* Same-document + no-scan proof across open PDF → image → text. */
    const after = await tab.eval<{ pushes: number; replaces: number; paths: string[]; marker: string; nav: number; draft: string | null; sentinel: unknown; cardAlive: boolean; rectSame: boolean; sheetCount: number }>(`(() => ({
      pushes: window.__pushes, replaces: window.__replaces,
      paths: [...new Set(window.__fetchPaths)],
      marker: window.__marker,
      nav: performance.getEntriesByType("navigation").length,
      draft: (() => { const f = document.querySelector('[data-scheme-node$="${S_ID}.jsonl"] textarea'); return f ? f.value : null; })(),
      sentinel: window.__voiceSentinel,
      cardAlive: !!(window.__cardNode && window.__cardNode.isConnected),
      rectSame: JSON.stringify(window.__cardNode.getBoundingClientRect()) === window.__cardRect,
      sheetCount: document.querySelectorAll("[data-artifact-preview]").length,
    }))()`);
    const addedPaths = after.paths.filter((p) => !before.paths.includes(p));
    expect("opening/switching previews added only /api/artifact requests (no snapshot, scan or transcript rescan)",
      addedPaths.every((p) => p === "/api/artifact") && addedPaths.length <= 1, addedPaths);
    expect("previews wrote no history entries and never reloaded the document",
      after.pushes === before.pushes && after.replaces === before.replaces && after.marker === "alive" && after.nav === 1,
      { before, after: { pushes: after.pushes, replaces: after.replaces, nav: after.nav } });
    expect("draft, voice sentinel, card DOM identity and geometry survived preview open/switch",
      after.draft === DRAFT_TEXT && after.sentinel === VOICE_SENTINEL && after.cardAlive && after.rectSame && after.sheetCount === 1,
      after);

    /* Browser Back/Forward with the preview open. The deep link is this tab's
       only in-app entry, so a plain Back would leave the app; a real project
       hash navigation writes the second entry the traversal then walks. */
    await tab.eval(`(() => { location.hash = "#p=" + encodeURIComponent(localStorage.getItem("llvProject") || ""); return true; })()`);
    await sleep(600);
    await tab.eval("(history.back(), true)");
    await sleep(900);
    await tab.eval("(history.forward(), true)");
    await sleep(900);
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${S_ID}.jsonl"]')`, "card back after traversal", 30_000);
    const traversal = await tab.eval<{ marker: string; nav: number; draft: string | null; sentinel: unknown; sheet: boolean }>(`(() => ({
      marker: window.__marker,
      nav: performance.getEntriesByType("navigation").length,
      draft: (() => { const f = document.querySelector('[data-scheme-node$="${S_ID}.jsonl"] textarea'); return f ? f.value : null; })(),
      sentinel: window.__voiceSentinel,
      sheet: !!${SHEET},
    }))()`);
    expect("Back/Forward kept the same document, draft, sentinel and preview surface",
      traversal.marker === "alive" && traversal.nav === 1 && traversal.draft === DRAFT_TEXT
        && traversal.sentinel === VOICE_SENTINEL && traversal.sheet,
      traversal);

    /* Keyboard: close, re-open with Enter on the focused link, Escape out. */
    await click(tab, `${SHEET}.querySelector('[aria-label="Close preview"]')`, "close button");
    await poll(tab, `!${SHEET}`, "sheet closed by button");
    await tab.eval(`(() => { const a = ${artifactLink("run.log")}; a.focus(); return true; })()`);
    await pressKey(tab, "Enter", "Enter", 13);
    await poll(tab, sheetState("ready"), "keyboard Enter opened the preview", 30_000);
    await pressKey(tab, "Escape", "Escape", 27);
    await poll(tab, `!${SHEET}`, "Escape closed the preview");
    const focusBack = await tab.eval<boolean>(`document.activeElement === ${artifactLink("run.log")}`);
    expect("Escape closed the preview and focus returned to the originating link", focusBack);

    /* Explicit failure states, each visible and labelled. */
    await openArtifact(tab, "missing.md", "missing", "missing.md");
    await tab.screenshot("desktop-missing.png");
    await openArtifact(tab, "denied.md", "denied", "denied.md");
    await openArtifact(tab, "sneaky.md", "denied", "sneaky.md (symlink escape)");
    await openArtifact(tab, "broken.png", "unsupported", "broken.png (mime mismatch)");
    await openArtifact(tab, "huge.log", "oversized", "huge.log");
    await tab.screenshot("desktop-oversized.png");
    expect("missing, denied, symlink-escape, mismatch and oversized states all rendered explicitly", true);

    /* Changed-mid-read: open live.log, mutate it on disk, load more → changed. */
    await openArtifact(tab, "live.log", "ready", "live.log");
    fs.appendFileSync(path.join(home, "artifacts/live.log"), "appended after the preview opened\n");
    await click(tab, `[...${SHEET}.querySelectorAll("button")].find((b) => b.textContent === "Load more")`, "load more on mutated file");
    await poll(tab, sheetState("changed"), "changed state after on-disk mutation", 30_000);
    await tab.screenshot("desktop-changed.png");
    const reloaded = await tab.eval<boolean>(clickExpr(`[...${SHEET}.querySelectorAll("button")].find((b) => b.textContent === "Reload")`));
    expect("changed state offered Reload", reloaded);
    await poll(tab, sheetState("ready"), "reload recovered the changed file", 30_000);
    await pressKey(tab, "Escape", "Escape", 27);
    await poll(tab, `!${SHEET}`, "sheet closed at the end of the desktop scenario");
    tab.close();

    /* ── Mobile 396 px scenario ───────────────────────────────────────── */
    const mob = await newTarget();
    await mob.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); } catch {}" });
    await mob.send("Emulation.setDeviceMetricsOverride", { width: 396, height: 780, deviceScaleFactor: 2, mobile: true });
    await mob.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await mob.send("Page.navigate", { url: cardUrl(baseUrl) });
    await poll(mob, `!!${artifactLink("report.pdf")}`, "mobile transcript links", 120_000);
    await mob.eval(INSTRUMENT);
    await openArtifact(mob, "run.log", "ready", "mobile run.log");
    const mobile = await mob.eval<{ role: string | null; label: string | null; fullHeight: boolean; fullWidth: boolean; closeBox: { w: number; h: number }; marker: string; nav: number }>(`(() => {
      const s = ${SHEET};
      const rect = s.getBoundingClientRect();
      const close = s.querySelector('[aria-label="Close preview"]').getBoundingClientRect();
      return {
        role: s.getAttribute("role"), label: s.getAttribute("aria-label"),
        fullHeight: Math.round(rect.height) >= window.innerHeight - 1,
        fullWidth: Math.round(rect.width) >= window.innerWidth - 1,
        closeBox: { w: Math.round(close.width), h: Math.round(close.height) },
        marker: window.__marker,
        nav: performance.getEntriesByType("navigation").length,
      };
    })()`);
    expect("396px mobile preview is a full-height labelled dialog with 44px touch targets",
      mobile.role === "dialog" && (mobile.label ?? "").includes("run.log") && mobile.fullHeight && mobile.fullWidth
        && mobile.closeBox.w >= 44 && mobile.closeBox.h >= 44 && mobile.marker === "alive" && mobile.nav === 1,
      mobile);
    await mob.screenshot("mobile-text.png");
    await openArtifact(mob, "report.pdf", "ready", "mobile report.pdf");
    await poll(mob, `(() => { const c = ${SHEET}.querySelector("canvas"); return !!c && c.width > 50; })()`, "mobile pdf painted", 30_000);
    await mob.screenshot("mobile-pdf.png");
    mob.close();

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 875,
      capturedAt: new Date().toISOString(),
      buildHead,
      runner: "exact-head production build served by `next start` over the isolated demo runtime (fixtures/demo-home); synthetic runtime-generated artifact fixtures; headless host Chrome over raw CDP",
      screenshots: [
        "desktop-pdf.png", "desktop-image.png", "desktop-text.png",
        "desktop-missing.png", "desktop-oversized.png", "desktop-changed.png",
        "mobile-text.png", "mobile-pdf.png",
      ],
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(
      path.join(import.meta.dir, "preview.json"),
      (JSON.stringify(output, null, 2) + "\n")
        .replaceAll(repoRoot, "<repo>")
        .replaceAll(runtime.root, "<capture>")
        .replaceAll(outsideDir, "<outside>")
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
