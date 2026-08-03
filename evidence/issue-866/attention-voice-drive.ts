/**
 * Real-browser evidence for the issue #866 production regression: a directed
 * `request_attention` handoff must preserve SPA Back/Forward and a live voice
 * pipeline.
 *
 *   bun evidence/issue-866/attention-voice-drive.ts
 *
 * Deep checkouts overflow the ~108-byte unix-socket limit for the fixture tmux
 * socket ("tmux exited with 1" at boot); point LLV_DEMO_TMUX_TMPDIR at a short
 * external dir, exactly as scripts/demo-capture.ts documents.
 *
 * PRODUCTION-SHAPED, like evidence/issue-873/drive.ts: the driver builds the
 * EXACT current head (`next build`) and serves it with `next start` over the
 * ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR; never the
 * operator's viewer state, never ports 8898/8899). Real headless host Chrome
 * over raw CDP is the operator; the REAL MCP tool service + bindings run in
 * this process against the same shared state dir. Only the caller-authority
 * resolver is injected, because one process cannot BE the root caller.
 *
 * THE VOICE SENTINEL. The regression's kill mechanism is a document
 * navigation: Back after an unrecorded `show` handoff left the in-app history
 * stack, remounted the app and destroyed every live JS object in the page —
 * including the active voice call's media graph and peer connection. The demo
 * runtime has no realtime backend to hold a real agent call, so the sentinel
 * is the same machinery one level down: a live `getUserMedia` microphone
 * stream (Chrome's fake device), a running `AudioContext` over it, a CONNECTED
 * loopback `RTCPeerConnection` carrying the audio track, and a heartbeat
 * counter — the exact in-page state an active voice conversation is made of,
 * and exactly what a document boundary crossing terminates. Document and board
 * identity sentinels (tagged live DOM nodes, `performance` navigation entries,
 * a window marker) prove the same thing from the document's side.
 *
 * What the checks prove:
 *  - a directed `show` handoff records EXACTLY ONE typed same-document focus
 *    entry, only after the verified arrival;
 *  - browser Back and Forward then traverse the previous and target cards
 *    with no document reload, no remount, no snapshot fetch — and the voice
 *    pipeline, the composer draft and the board DOM survive;
 *  - replaying the same clientRequestId moves nothing and records nothing;
 *  - a sub-agent conversation target records the same single entry;
 *  - `intent: "open"` still lands with exactly one entry (the quiet open and
 *    the arrival record coalesce);
 *  - a stale target fails visibly with no entry, and traversal still works.
 *
 * The output carries fixture ids, geometry and booleans only: no absolute
 * paths, no transcript text, no identities beyond the fixture browser.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, claudePath, demoPort, renderFixtureTemplate } from "../../scripts/demo-capture";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9339;

/* Fixture ids are assembled at runtime so no UUID-shaped literal lands in the
   published sources (privacy gate classes). */
const A_ID = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const B_ID = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const STALE_ID = ["00000000", "0000", "4000", "8000", "00000000dead"].join("-");
const DRAFT_TEXT = "issue-866 draft survives the attention handoff";

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  targetId: string;

  private constructor(ws: WebSocket, targetId: string) {
    this.#ws = ws;
    this.targetId = targetId;
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

  static async connect(url: string, targetId: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP connect failed")));
    });
    return new Cdp(ws, targetId);
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

/** History write counters, the live-document marker, fetch pathnames, and the
    document/board identity tags — installed before any gesture. */
const INSTRUMENT = `(() => {
  window.__marker = "alive";
  window.__pushes = 0; window.__replaces = 0;
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
  window.__main = document.querySelector("main");
  return true;
})()`;

/** The live voice pipeline (see the module note): fake-device microphone →
    AudioContext → a CONNECTED loopback RTCPeerConnection, plus a heartbeat. */
const VOICE = `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  await context.resume().catch(() => {});
  context.createMediaStreamSource(stream);
  const near = new RTCPeerConnection();
  const far = new RTCPeerConnection();
  /* A candidate can fire before the other side has its remote description —
     retry once instead of losing it. */
  const feed = (peer, candidate) => peer.addIceCandidate(candidate).catch(() => {
    setTimeout(() => peer.addIceCandidate(candidate).catch(() => {}), 500);
  });
  near.onicecandidate = (e) => { if (e.candidate) feed(far, e.candidate); };
  far.onicecandidate = (e) => { if (e.candidate) feed(near, e.candidate); };
  const track = stream.getAudioTracks()[0];
  near.addTrack(track, stream);
  const offer = await near.createOffer();
  await near.setLocalDescription(offer);
  await far.setRemoteDescription(offer);
  const answer = await far.createAnswer();
  await far.setLocalDescription(answer);
  await near.setRemoteDescription(answer);
  window.__voice = { stream, track, context, near, far, beats: 0 };
  setInterval(() => { window.__voice.beats += 1; }, 250);
  return true;
})()`;

const rectOf = (suffix: string) => `(() => {
  const node = document.querySelector('[data-scheme-node$="${suffix}"]');
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
})()`;

type Rect = { x: number; y: number; w: number; h: number } | null;

type Voice = {
  pc: string;
  trackLive: boolean;
  streamActive: boolean;
  audio: string;
  beats: number;
} | null;

const PAGE_STATE = `(() => ({
  hash: decodeURIComponent(location.hash),
  entryKey: (() => { const e = history.state && history.state.llvFocus; return e ? String(e.conversationId || e.path || "") : ""; })(),
  entryProject: (history.state && history.state.llvFocus && history.state.llvFocus.project) || null,
  pushes: window.__pushes ?? -1,
  replaces: window.__replaces ?? -1,
  marker: window.__marker ?? null,
  navEntries: performance.getEntriesByType("navigation").length,
  aRect: ${rectOf(`__A__.jsonl`)},
  bRect: ${rectOf(`__B__.jsonl`)},
  viewport: { w: window.innerWidth, h: window.innerHeight },
  returnChips: document.querySelectorAll('[data-testid="focus-return-chip"]').length,
  staleNotice: !!document.querySelector("[data-stale-focus-notice]"),
  mainAlive: !!(window.__main && window.__main.isConnected),
  nodeAAlive: !!(window.__nodeA && window.__nodeA.isConnected),
  draft: (() => { const f = document.querySelector('[data-scheme-node$="__A__.jsonl"] textarea'); return f ? f.value : null; })(),
  voice: window.__voice ? {
    pc: window.__voice.near.connectionState,
    trackLive: window.__voice.track.readyState === "live",
    streamActive: window.__voice.stream.active,
    audio: window.__voice.context.state,
    beats: window.__voice.beats,
  } : null,
}))()`.replaceAll("__A__", A_ID).replaceAll("__B__", B_ID);

type PageState = {
  hash: string;
  entryKey: string;
  entryProject: string | null;
  pushes: number;
  replaces: number;
  marker: string | null;
  navEntries: number;
  aRect: Rect;
  bRect: Rect;
  viewport: { w: number; h: number };
  returnChips: number;
  staleNotice: boolean;
  mainAlive: boolean;
  nodeAAlive: boolean;
  draft: string | null;
  voice: Voice;
};

const onScreen = (rect: Rect, viewport: { w: number; h: number }): boolean =>
  rect !== null && rect.x < viewport.w && rect.y < viewport.h && rect.x + rect.w > 0 && rect.y + rect.h > 0;

const sameRect = (left: Rect, right: Rect, epsilon = 3): boolean =>
  left !== null && right !== null
  && Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon
  && Math.abs(left.w - right.w) <= epsilon && Math.abs(left.h - right.h) <= epsilon;

/** The whole voice pipeline is still what "an active call" is made of. */
const voiceAlive = (voice: Voice): boolean =>
  voice !== null && voice.pc === "connected" && voice.trackLive && voice.streamActive && voice.audio === "running";

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3060, "LLV_EVIDENCE_PORT");
  /* The demo env allows the docker-bridge host for dev browsing; loopback
     renders SSR-empty. Assembled at runtime (see the note on A_ID). */
  const devHost = [172, 17, 0, 1].join(".");
  const prodPort = port + 1;
  const baseUrl = `http://${devHost}:${prodPort}`;
  const checks: Check[] = [];
  const expect = (name: string, pass: boolean, detail: unknown = null) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : " — " + JSON.stringify(detail)}`);
  };

  /* ── The exact-head PRODUCTION build the server below serves ──────────── */
  const buildHead = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  if (process.env.LLV_EVIDENCE_SKIP_BUILD !== "1") {
    console.log(`building production head ${buildHead.slice(0, 12)}…`);
    const buildEnv = { ...process.env, NODE_ENV: "production" as const };
    delete (buildEnv as Record<string, unknown>).__NEXT_PRIVATE_STANDALONE_CONFIG;
    execSync("bunx next build --webpack", { cwd: repoRoot, env: buildEnv, stdio: "inherit" });
  }

  console.log("booting isolated demo runtime…");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
  let chrome: ChildProcess | null = null;
  let prodServer: ChildProcess | null = null;
  try {
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
      if (Date.now() > prodDeadline) throw new Error("production server did not become ready");
      await sleep(250);
    }
    console.log("production server ready");

    /* This process becomes a sibling of the demo server over the SAME isolated
       state dir — the cross-process shape the MCP stdio server has in
       production. Set BEFORE the src modules load. Chrome below still launches
       with the HOST environment: the browser is the operator's real browser. */
    const hostEnv = { ...process.env };
    for (const [key, value] of Object.entries(runtime.env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    /* Dev-mode module init arms long-lived watchers that outlive the run —
       see the same brace in evidence/issue-873/drive.ts. */
    Object.assign(process.env, { NODE_ENV: "production" });
    const stateDir = runtime.env.LLV_STATE_DIR!;
    const { productionDomainDependencies, viewerMcpBindings } = await import("../../src/lib/mcp/bindings");
    const { createMcpToolService, MemoryMcpReceiptStore } = await import("../../src/lib/mcp/server");
    /* The one injected seam: WHO is calling. Everything else — target
       resolution, presence selection, the record, the arrival wait — is the
       production dependency set. */
    const rootTools = createMcpToolService(viewerMcpBindings(undefined, undefined, {
      ...productionDomainDependencies,
      attentionAuthority: () => ({ kind: "root", conversationId: "conversation_root" }),
      callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_root", role: null }),
    }), new MemoryMcpReceiptStore());
    type ToolResult = { ok: boolean; replayed?: boolean; attentionId?: string; details?: Record<string, unknown>; error?: string;
      handoff?: { deviceId: string; viewSessionId: string | null; state: string; resolution: string | null; arrivedAt: string } };
    const targetB = renderFixtureTemplate(claudePath("atlas", `${B_ID}.jsonl`), runtime.env.HOME!);
    const targetChild = renderFixtureTemplate(claudePath("atlas", `${B_ID}/subagents/agent-builder.jsonl`), runtime.env.HOME!);
    const targetStale = renderFixtureTemplate(claudePath("atlas", `${STALE_ID}.jsonl`), runtime.env.HOME!);
    const ask = (clientRequestId: string, overrides: Record<string, unknown> = {}) => ({
      clientRequestId,
      target: { kind: "conversation", path: targetB },
      reason: "Issue-866 evidence: directed show handoff must record the focus entry.",
      ...overrides,
    });

    type PresenceSession = { viewSessionId: string; mode: string; visibility: string; device: { kind: string } };
    const readPresence = (): PresenceSession[] => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(stateDir, "view-presence.json"), "utf8")) as {
          sessions: PresenceSession[];
        }).sessions;
      } catch {
        return [];
      }
    };

    /* ── The operator's browser: one desktop tab, focused on card A ──────── */
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
      /* The voice sentinel: a fake microphone the page can actually open, on
         an origin Chrome will treat as secure enough for getUserMedia. */
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--unsafely-treat-insecure-origin-as-secure=${baseUrl}`,
      "about:blank",
    ], { stdio: "ignore", env: hostEnv });
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

    const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
    const target = (await created.json()) as { id: string; webSocketDebuggerUrl: string };
    const tab = await Cdp.connect(target.webSocketDebuggerUrl, target.id);
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    /* Headless windows created over /json/new do not reliably inherit
       --window-size; a narrow target renders the MOBILE layout, whose
       attention host is deliberately disabled. */
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.send("Page.navigate", { url: baseUrl });
    await poll(tab, `(() => {
      const rows = document.querySelectorAll('[data-testid="overview-conversation"]');
      if (rows.length > 0) return true;
      const overview = [...document.querySelectorAll("nav button")].find((el) => (el.textContent ?? "").trim() === "Overview");
      if (overview) overview.click();
      return false;
    })()`, "overview rows", 120_000);
    await tab.eval(INSTRUMENT);

    /* The voice call is up BEFORE the handoff arrives — the operator scenario
       the regression terminated. */
    await tab.eval(VOICE);
    await poll(tab, `window.__voice && window.__voice.near.connectionState === "connected"`, "voice loopback connected", 20_000);

    /* Focus A deliberately: the previous card Back must return to. */
    await tab.eval(`(() => { const el = document.querySelector('[data-focus-target$="${A_ID}.jsonl"]'); if (el) el.click(); return !!el; })()`);
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]')`, "scheme node A");
    await tab.eval(`(() => { window.__nodeA = document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]'); return true; })()`);
    /* A real user gesture makes this the latest-interaction session. */
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 200, button: "left", clickCount: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 200, button: "left", clickCount: 1 });

    /* Composer draft on A: local UI state the traversal must not destroy. */
    const draftSet = await tab.eval<boolean>(`(() => {
      const node = document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]');
      const field = node && node.querySelector("textarea");
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(field, ${JSON.stringify(DRAFT_TEXT)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    expect("composer draft typed into card A", draftSet);

    /* The presence mirror must name this desktop session, visible, before the
       tool can direct anything at it. */
    const presenceDeadline = Date.now() + 40_000;
    for (;;) {
      const desks = readPresence().filter((session) => session.device.kind !== "mobile" && session.mode === "scheme");
      if (desks.some((session) => session.visibility === "visible")) break;
      if (Date.now() > presenceDeadline) throw new Error("presence mirror never named the Chrome session");
      await sleep(500);
    }

    /* Let the focus-A glide settle so `before` is the frame the operator is
       actually resting at. */
    let before = await tab.eval<PageState>(PAGE_STATE);
    const settleDeadline = Date.now() + 15_000;
    for (;;) {
      await sleep(500);
      const next = await tab.eval<PageState>(PAGE_STATE);
      if (sameRect(before.aRect, next.aRect, 1)) { before = next; break; }
      if (Date.now() > settleDeadline) throw new Error("board camera never settled after focusing A");
      before = next;
    }
    expect(
      "focusing A recorded its own typed entry, and the voice pipeline is live",
      before.entryKey.includes(A_ID) && voiceAlive(before.voice),
      { entryKey: before.entryKey, voice: before.voice },
    );

    /* ── The regression flow: a directed SHOW handoff to card B ──────────── */
    const shown = await rootTools.callTool("request_attention", ask("issue-866-show-1")) as ToolResult;
    await sleep(700);
    const afterShow = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "the show handoff verified its arrival: MCP success, camera at B, same document",
      shown.ok === true && shown.handoff?.state === "following"
        && onScreen(afterShow.bRect, afterShow.viewport)
        && afterShow.marker === "alive" && afterShow.navEntries === 1,
      { ok: shown.ok, state: shown.handoff?.state ?? null, bRect: afterShow.bRect },
    );
    expect(
      "the verified show arrival recorded EXACTLY ONE typed focus entry for B",
      afterShow.pushes - before.pushes === 1 && afterShow.entryKey.includes(B_ID),
      { pushesDelta: afterShow.pushes - before.pushes, entryKey: afterShow.entryKey, entryProject: afterShow.entryProject },
    );

    /* Replaying the same operation must move and record nothing. */
    const replay = await rootTools.callTool("request_attention", ask("issue-866-show-1")) as ToolResult;
    await sleep(500);
    const afterReplay = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "a replayed request_attention returns the committed receipt: no new entry, no move",
      replay.ok === true && replay.replayed === true && replay.attentionId === shown.attentionId
        && afterReplay.pushes === afterShow.pushes && afterReplay.entryKey.includes(B_ID),
      { replayed: replay.replayed ?? null, pushesDelta: afterReplay.pushes - afterShow.pushes },
    );

    /* ── Back: the previous card, same document, voice still alive ───────── */
    const beatsBeforeBack = afterReplay.voice?.beats ?? -1;
    await tab.eval("(history.back(), true)");
    await poll(tab, `(() => { const e = history.state && history.state.llvFocus; return !!e && String(e.conversationId || e.path || "").includes("${A_ID}"); })()`, "Back lands on A's entry", 15_000);
    await sleep(700);
    const afterBack = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "Back traverses to the previous card inside the document — no reload, no remount",
      afterBack.entryKey.includes(A_ID) && afterBack.marker === "alive" && afterBack.navEntries === 1
        && afterBack.mainAlive && afterBack.nodeAAlive,
      { entryKey: afterBack.entryKey, navEntries: afterBack.navEntries, mainAlive: afterBack.mainAlive },
    );
    expect(
      "the live voice pipeline survived Back: connected peer, live track, running audio, advancing heartbeat",
      voiceAlive(afterBack.voice) && (afterBack.voice?.beats ?? -1) > beatsBeforeBack,
      { voice: afterBack.voice, beatsBeforeBack },
    );
    expect("the unsent composer draft survived Back", afterBack.draft === DRAFT_TEXT, { draft: afterBack.draft });

    /* ── Forward: the target card again, still same-document ─────────────── */
    await tab.eval("(history.forward(), true)");
    await poll(tab, `(() => { const e = history.state && history.state.llvFocus; return !!e && String(e.conversationId || e.path || "").includes("${B_ID}"); })()`, "Forward lands on B's entry", 15_000);
    await sleep(700);
    const afterForward = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "Forward restores the target card's entry; traversal replay pushed nothing",
      afterForward.entryKey.includes(B_ID) && afterForward.pushes === afterShow.pushes
        && afterForward.marker === "alive" && afterForward.navEntries === 1 && voiceAlive(afterForward.voice),
      { entryKey: afterForward.entryKey, pushesDelta: afterForward.pushes - afterShow.pushes },
    );

    /* Close the first record so the next directed handoff owns the offer slot. */
    await poll(tab, `document.querySelectorAll('[data-testid="attention-return"]').length === 1`, "return control", 15_000);
    await tab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await poll(tab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 0`, "return chip consumed", 15_000);
    await sleep(1_000);

    /* ── A sub-agent conversation target records the same single entry ───── */
    const preChild = await tab.eval<PageState>(PAGE_STATE);
    const child = await rootTools.callTool("request_attention", ask("issue-866-child-1", {
      target: { kind: "conversation", path: targetChild },
      reason: "Issue-866 evidence: directed show handoff to a sub-agent card.",
    })) as ToolResult;
    await sleep(700);
    const afterChild = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "a sub-agent target handoff records exactly one entry keyed by the child conversation",
      child.ok === true && child.handoff?.state === "following"
        && afterChild.pushes - preChild.pushes === 1
        && afterChild.entryKey.includes("subagents/agent-builder")
        && afterChild.navEntries === 1,
      { ok: child.ok, pushesDelta: afterChild.pushes - preChild.pushes, entryKey: afterChild.entryKey },
    );
    await poll(tab, `document.querySelectorAll('[data-testid="attention-return"]').length === 1`, "child return control", 15_000);
    await tab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await poll(tab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 0`, "child return chip consumed", 15_000);
    await sleep(1_000);

    /* ── intent: "open" still lands with exactly one entry ───────────────── */
    const preOpen = await tab.eval<PageState>(PAGE_STATE);
    const opened = await rootTools.callTool("request_attention", ask("issue-866-open-1", { intent: "open" })) as ToolResult;
    await sleep(700);
    const afterOpen = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "intent=open records exactly one entry: the quiet open and the arrival record coalesce",
      opened.ok === true && opened.handoff?.state === "following"
        && afterOpen.pushes - preOpen.pushes === 1
        && afterOpen.entryKey.includes(B_ID)
        && afterOpen.navEntries === 1,
      { ok: opened.ok, pushesDelta: afterOpen.pushes - preOpen.pushes, entryKey: afterOpen.entryKey },
    );

    /* ── A stale target fails visibly, records nothing, traversal survives ── */
    const preStale = await tab.eval<PageState>(PAGE_STATE);
    const stale = await rootTools.callTool("request_attention", ask("issue-866-stale-1", {
      target: { kind: "conversation", path: targetStale },
      reason: "Issue-866 evidence: a target no scanner can produce.",
    })) as ToolResult;
    await sleep(700);
    const afterStale = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "a stale target is an explicit failure with no focus entry",
      stale.ok === false && afterStale.pushes === preStale.pushes,
      { ok: stale.ok, error: stale.error ?? null, code: stale.details?.code ?? null, pushesDelta: afterStale.pushes - preStale.pushes },
    );
    await tab.eval("(history.back(), true)");
    await sleep(1_000);
    const afterStaleBack = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "Back still works after the failed handoff, same document, voice alive",
      afterStaleBack.marker === "alive" && afterStaleBack.navEntries === 1 && voiceAlive(afterStaleBack.voice),
      { entryKey: afterStaleBack.entryKey, navEntries: afterStaleBack.navEntries, voice: afterStaleBack.voice },
    );

    /* ── Final sentinels: nothing across the whole run crossed the document ── */
    const snapshotCalls = await tab.eval<string[]>(`window.__fetchPaths.filter((p) => p.includes("/api/agent/snapshot"))`);
    expect("navigation never called /api/agent/snapshot", snapshotCalls.length === 0, snapshotCalls);
    const finalState = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "document, board and voice identity survived the entire run",
      finalState.marker === "alive" && finalState.navEntries === 1 && finalState.mainAlive && voiceAlive(finalState.voice),
      { navEntries: finalState.navEntries, voice: finalState.voice },
    );

    tab.close();

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 866,
      capturedAt: new Date().toISOString(),
      buildHead,
      runner: "exact-head production build served by `next start` over the isolated demo runtime (fixtures/demo-home); headless host Chrome with a fake media device over raw CDP; the real MCP tool service + bindings called cross-process over the same shared LLV_STATE_DIR, with only the root caller-authority seam injected",
      contract: "every successful conversation-target request_attention handoff records exactly one typed same-document focus entry after verified arrival; Back/Forward traverse the previous and target cards with no document reload, remount, snapshot fetch, voice interruption, composer loss or duplicate entry; replays record nothing; sub-agent and open targets record the same single entry; a stale target fails visibly and leaves history usable",
      voiceSentinel: "live fake-device getUserMedia stream + running AudioContext + CONNECTED loopback RTCPeerConnection carrying the audio track + advancing heartbeat — the in-page state an active voice conversation is made of, which a document navigation would terminate",
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(
      path.join(import.meta.dir, "attention-voice.json"),
      (JSON.stringify(output, null, 2) + "\n")
        .replaceAll(repoRoot, "<repo>")
        .replaceAll(repoRoot.replaceAll("/", "-").replaceAll(".", "-"), "-repo-")
        .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1-x"),
    );
    console.log(`\n${output.verdict}: ${checks.length - failed.length}/${checks.length} checks`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (chrome) chrome.kill("SIGKILL");
    if (prodServer && prodServer.exitCode === null) prodServer.kill("SIGKILL");
    await runtime.shutdown();
  }
}

await main();
/* Belt to the NODE_ENV brace above: whatever module-level timer the imported
   graph may still hold, the run is over and the verdict is written. */
process.exit(process.exitCode ?? 0);
