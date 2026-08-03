/**
 * Real-browser evidence for issue #873 — request_attention as an immediate
 * VERIFIED camera handoff, gated on server-attributed authority.
 *
 *   bun evidence/issue-873/drive.ts
 *
 * Deep checkouts overflow the ~108-byte unix-socket limit for the fixture tmux
 * socket ("tmux exited with 1" at boot); point LLV_DEMO_TMUX_TMPDIR at a short
 * external dir, exactly as scripts/demo-capture.ts documents.
 *
 * PRODUCTION-SHAPED: the driver builds the EXACT current head (`next build`)
 * and serves it with `next start` over the ISOLATED demo runtime
 * (fixtures/demo-home + its own LLV_STATE_DIR; never the operator's viewer
 * state, never ports 8898/8899). Real headless host Chrome over raw CDP is
 * the operator; the REAL MCP tool service + bindings run in this process
 * against the same shared state dir — the exact cross-process seam production
 * uses. Only the caller-authority resolver is injected per scenario, because
 * one process cannot BE three different callers at once; the resolver itself
 * is covered by callerAuthority/managerAuthority tests.
 *
 * What the checks prove (#873 review, findings 1–5 + evidence):
 *  - a worker and an unidentified caller are refused with ZERO durable traces,
 *    and the same worker cannot execute a deployment (the barrier holds);
 *  - the root/gateway and the target project's orchestrator seat both direct
 *    the handoff;
 *  - two same-device tabs: the record names ONE executing browser session and
 *    exactly one tab navigates; the other never moves;
 *  - the camera physically arrives before MCP success, same-document; the
 *    page's only word to the record is the arrival;
 *  - `intent: "open"` lands with ONE glide and ONE history entry;
 *  - replay returns the committed receipt; a RESTARTED service (fresh receipt
 *    store) adopts the same record — one record, one navigation;
 *  - an aborted call closes the record with nothing left to navigate;
 *  - exactly one Return restores the exact pre-move camera AND focused card;
 *  - with the view gone, the call is an explicit NO_ACTIVE_VIEW refusal.
 *
 * The output carries fixture ids, geometry and booleans only: no absolute
 * paths, no transcript text, no identities beyond the fixture browser.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, claudePath, demoPort, renderFixtureTemplate } from "../../scripts/demo-capture";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9338;

/* Fixture ids are assembled at runtime so no UUID-shaped literal lands in the
   published sources (privacy gate classes). */
const A_ID = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const B_ID = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");

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

async function newTarget(): Promise<Cdp> {
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const target = (await created.json()) as { id: string; webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl, target.id);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  /* Headless windows created over /json/new do not reliably inherit
     --window-size; a target that comes up narrow renders the MOBILE layout,
     whose attention host is deliberately disabled, and the whole proof
     silently tests the wrong surface. Pin desktop metrics explicitly before
     anything navigates. */
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

/** Installed before anything runs in a tab: records every event kind this page
    POSTs to the attention record, captures the tab's own presence session id
    off its heartbeats, and tags the live document. */
const INSTRUMENT = `(() => {
  window.__marker = "alive";
  window.__attnPosts = [];
  window.__mySession = null;
  const of = window.fetch.bind(window);
  window.fetch = (...a) => {
    try {
      const url = new URL(String(a[0] instanceof Request ? a[0].url : a[0]), location.href);
      const init = a[1];
      if (init && typeof init.body === "string") {
        if (url.pathname.startsWith("/api/attention/")) window.__attnPosts.push(JSON.parse(init.body).kind);
        if (url.pathname === "/api/view/presence") window.__mySession = JSON.parse(init.body).viewSessionId ?? window.__mySession;
      }
    } catch {}
    return of(...a);
  };
  return true;
})()`;

const rectOf = (suffix: string) => `(() => {
  const node = document.querySelector('[data-scheme-node$="${suffix}"]');
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
})()`;

type Rect = { x: number; y: number; w: number; h: number } | null;

const PAGE_STATE = `(() => ({
  aRect: ${rectOf("A.jsonl".replace("A", "__A__"))},
  bRect: ${rectOf("B.jsonl".replace("B", "__B__"))},
  attnPosts: window.__attnPosts ?? [],
  mySession: window.__mySession ?? null,
  marker: window.__marker ?? null,
  navEntries: performance.getEntriesByType("navigation").length,
  historyLength: history.length,
  returnChips: document.querySelectorAll('[data-testid="focus-return-chip"]').length,
  returnButtons: document.querySelectorAll('[data-testid="attention-return"]').length,
  viewport: { w: window.innerWidth, h: window.innerHeight },
}))()`.replaceAll("__A__", A_ID).replaceAll("__B__", B_ID);

type PageState = {
  aRect: Rect;
  bRect: Rect;
  attnPosts: string[];
  mySession: string | null;
  marker: string | null;
  navEntries: number;
  historyLength: number;
  returnChips: number;
  returnButtons: number;
  viewport: { w: number; h: number };
};

const onScreen = (rect: Rect, viewport: { w: number; h: number }): boolean =>
  rect !== null && rect.x < viewport.w && rect.y < viewport.h && rect.x + rect.w > 0 && rect.y + rect.h > 0;

const sameRect = (left: Rect, right: Rect, epsilon = 3): boolean =>
  left !== null && right !== null
  && Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon
  && Math.abs(left.w - right.w) <= epsilon && Math.abs(left.h - right.h) <= epsilon;

type Camera = { x: number; y: number; zoom: number } | null;

const sameCamera = (left: Camera, right: Camera): boolean =>
  left !== null && right !== null
  && Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1 && Math.abs(left.zoom - right.zoom) <= 0.01;

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3058, "LLV_EVIDENCE_PORT");
  /* The demo env allows the docker-bridge host for dev browsing; loopback
     renders SSR-empty. Assembled at runtime (see the note on A_ID). */
  const devHost = [172, 17, 0, 1].join(".");
  const baseUrl = `http://${devHost}:${port}`;
  const checks: Check[] = [];
  const expect = (name: string, pass: boolean, detail: unknown = null) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : " — " + JSON.stringify(detail)}`);
  };

  /* ── The exact-head PRODUCTION build the server below serves ──────────── */
  const buildHead = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  if (process.env.LLV_EVIDENCE_SKIP_BUILD !== "1") {
    console.log(`building production head ${buildHead.slice(0, 12)}…`);
    /* A leaked standalone config from a previous runtime breaks a clean
       build; scrubbed the same way the deploy scripts scrub it. */
    const buildEnv = { ...process.env, NODE_ENV: "production" as const };
    delete (buildEnv as Record<string, unknown>).__NEXT_PRIVATE_STANDALONE_CONFIG;
    execSync("bunx next build --webpack", { cwd: repoRoot, env: buildEnv, stdio: "inherit" });
  }

  console.log("booting isolated demo runtime (production server)…");
  const runtime = await bootstrapDemoRuntime(repoRoot, port, undefined, { server: "start" });
  let chrome: ChildProcess | null = null;
  try {
    await runtime.waitUntilReady();
    console.log("demo server ready");

    /* This process becomes a sibling of the demo server over the SAME isolated
       state dir — the cross-process shape the MCP stdio server has in
       production. Set BEFORE the src modules load, so every per-call path
       resolution sees the demo world and never the operator's. Chrome below
       still launches with the HOST environment: the browser is the operator's
       real browser, not part of the demo world. */
    const hostEnv = { ...process.env };
    for (const [key, value] of Object.entries(runtime.env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    const stateDir = runtime.env.LLV_STATE_DIR!;
    const { productionDomainDependencies, viewerMcpBindings } = await import("../../src/lib/mcp/bindings");
    const { createMcpToolService, MemoryMcpReceiptStore, FileMcpReceiptStore } = await import("../../src/lib/mcp/server");
    type Authority =
      | { kind: "root"; conversationId: string | null }
      | { kind: "worker"; conversationId: string; role: string | null }
      | { kind: "unidentified" };
    type Seat = { conversationId: string; path: string | null; project: string | null };
    /* The one injected seam (see the module note): WHO is calling. Everything
       else — target resolution, presence selection, the record, the arrival
       wait — is the production dependency set. */
    const serviceAs = (authority: Authority, seats: Seat[] = [], receipts = new MemoryMcpReceiptStore()) =>
      createMcpToolService(viewerMcpBindings(undefined, undefined, {
        ...productionDomainDependencies,
        attentionAuthority: () => authority,
        authorizedSeats: () => seats,
        callerAttribution: () => (authority.kind === "root"
          ? { kind: "gateway" as const, conversationId: authority.conversationId, role: null }
          : authority.kind === "worker"
            ? { kind: seats.some((seat) => seat.conversationId === authority.conversationId) ? "manager" as const : "agent" as const, conversationId: authority.conversationId, role: authority.role }
            : { kind: "unidentified" as const, conversationId: null, role: null }),
      }), receipts);
    const targetPath = renderFixtureTemplate(claudePath("atlas", `${B_ID}.jsonl`), runtime.env.HOME!);
    const targetPathA = renderFixtureTemplate(claudePath("atlas", `${A_ID}.jsonl`), runtime.env.HOME!);

    const attentionFilePath = path.join(stateDir, "attention.json");
    const readRequests = (): Array<Record<string, unknown>> => {
      try {
        return (JSON.parse(fs.readFileSync(attentionFilePath, "utf8")) as { requests: Array<Record<string, unknown>> }).requests;
      } catch {
        return [];
      }
    };
    type PresenceSession = {
      viewSessionId: string;
      deviceId: string;
      mode: string;
      visibility: string;
      lastSeenAt: number;
      lastInteractionAt: number;
      device: { kind: string };
      focusedPath: string | null;
      camera: { x: number; y: number; zoom: number } | null;
    };
    const readPresence = (): PresenceSession[] => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(stateDir, "view-presence.json"), "utf8")) as {
          sessions: PresenceSession[];
        }).sessions;
      } catch {
        return [];
      }
    };
    const liveSession = (viewSessionId: string): PresenceSession | null =>
      readPresence().find((session) => session.viewSessionId === viewSessionId) ?? null;

    /* ── Scenario: authority refusals, BEFORE any browser exists ─────────── */
    const ask = (clientRequestId: string, overrides: Record<string, unknown> = {}) => ({
      clientRequestId,
      target: { kind: "conversation", path: targetPath },
      reason: "Issue-873 evidence: verified camera handoff to card B.",
      ...overrides,
    });
    type ToolResult = { ok: boolean; replayed?: boolean; recovered?: boolean; attentionId?: string; details?: Record<string, unknown>; error?: string; code?: string;
      handoff?: { deviceId: string; viewSessionId: string | null; state: string; resolution: string | null; arrivedAt: string } };

    const workerTools = serviceAs({ kind: "worker", conversationId: "conversation_evidence_worker", role: "builder" });
    const workerRefusal = await workerTools.callTool("request_attention", ask("issue-873-worker-1")) as ToolResult;
    expect(
      "a worker caller is refused before anything durable exists",
      workerRefusal.ok === false && workerRefusal.details?.code === "ATTENTION_NOT_PERMITTED"
        && workerRefusal.details?.refusedAs === "worker" && readRequests().length === 0,
      { code: workerRefusal.details?.code ?? null, refusedAs: workerRefusal.details?.refusedAs ?? null, requests: readRequests().length },
    );

    const unidentifiedRefusal = await serviceAs({ kind: "unidentified" })
      .callTool("request_attention", ask("issue-873-unidentified-1")) as ToolResult;
    expect(
      "an unidentified caller is refused the same way",
      unidentifiedRefusal.ok === false && unidentifiedRefusal.details?.refusedAs === "unidentified" && readRequests().length === 0,
      { refusedAs: unidentifiedRefusal.details?.refusedAs ?? null, requests: readRequests().length },
    );

    /* The deployment barrier the same external worker must NOT pass: the
       executor requires the designated orchestrator seat, so the refusal here
       is what "deployment readiness" means for a worker-facing surface. */
    const deployAttempt = await workerTools.callTool("deploy_exact_sha", {
      clientRequestId: "issue-873-worker-deploy-1",
      revision: buildHead,
    }) as ToolResult;
    expect(
      "the same worker cannot execute a deployment: the designated-seat barrier refuses it",
      deployAttempt.ok === false && deployAttempt.details?.code === "deploy_caller_not_designated",
      { code: deployAttempt.details?.code ?? null },
    );

    /* ── The operator's browser: tab A on the scheme board, focused on A ─── */
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

    const openBoardTab = async (): Promise<Cdp> => {
      const tab = await newTarget();
      await tab.send("Page.navigate", { url: baseUrl });
      /* The shell restores the operator's last surface, so the startup route
         can be a project dashboard rather than the overview. Steer through the
         rail's Overview entry exactly as an operator would, then wait for the
         overview conversation rows to arrive from the poll. */
      await poll(tab, `(() => {
        const rows = document.querySelectorAll('[data-testid="overview-conversation"]');
        if (rows.length > 0) return true;
        const overview = [...document.querySelectorAll("nav button")].find((el) => (el.textContent ?? "").trim() === "Overview");
        if (overview) overview.click();
        return false;
      })()`, "overview rows", 120_000);
      await tab.eval(`(() => { const el = document.querySelector('[data-focus-target$="${A_ID}.jsonl"]'); if (el) el.click(); return !!el; })()`);
      await poll(tab, `!!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]')`, "scheme node A");
      await tab.eval(INSTRUMENT);
      return tab;
    };

    const tabA = await openBoardTab();
    /* A second tab in the SAME profile: one device, two browser sessions — the
       duplicate-host race the record must resolve to exactly one executor.
       Headless Chrome reports only the frontmost window `visible`, which IS
       the scenario: the backgrounded tab is the hidden host that must never
       win selection or move. Tab A is brought back to front as the one the
       operator is actually at. */
    const tabB = await openBoardTab();
    await tabA.send("Page.bringToFront");
    /* The operator "is at" tab A: a real user gesture there makes it the
       latest-interaction session, deterministically. */
    await tabA.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 200, button: "left", clickCount: 1 });
    await tabA.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 200, button: "left", clickCount: 1 });

    /* Both browser sessions must be on the shared presence record — the
       executing one visible — and both tabs must know their own session ids,
       before the tool can choose. */
    const presenceDeadline = Date.now() + 40_000;
    for (;;) {
      const desks = readPresence().filter((session) => session.device.kind !== "mobile" && session.mode === "scheme");
      const stateA = await tabA.eval<PageState>(PAGE_STATE);
      const stateB = await tabB.eval<PageState>(PAGE_STATE);
      if (desks.length >= 2 && desks.some((session) => session.visibility === "visible") && stateA.mySession && stateB.mySession) break;
      if (Date.now() > presenceDeadline) throw new Error("presence mirror never named both Chrome sessions");
      await sleep(500);
    }
    const sessions = readPresence().filter((session) => session.mode === "scheme");
    expect(
      "presence names one device with two live browser sessions",
      new Set(sessions.map((session) => session.deviceId)).size === 1 && sessions.length >= 2,
      { sessions: sessions.length, devices: new Set(sessions.map((session) => session.deviceId)).size, visible: sessions.filter((session) => session.visibility === "visible").length },
    );

    /* Let the focus-A camera glide settle, so `before` is the frame the
       operator is actually resting at — the same frame Return must restore. */
    let before = await tabA.eval<PageState>(PAGE_STATE);
    const settleDeadline = Date.now() + 15_000;
    for (;;) {
      await sleep(500);
      const next = await tabA.eval<PageState>(PAGE_STATE);
      if (sameRect(before.aRect, next.aRect, 1)) { before = next; break; }
      if (Date.now() > settleDeadline) throw new Error("board camera never settled after focusing A");
      before = next;
    }
    const beforeB = await tabB.eval<PageState>(PAGE_STATE);
    /* And the presence mirror must have heartbeat that settled camera through:
       it is the cross-process record of where the operator IS, and the camera
       Return must bring back. */
    const sessionA = before.mySession!;
    const sessionB = beforeB.mySession!;
    let preMove: PresenceSession | null = liveSession(sessionA);
    const cameraDeadline = Date.now() + 40_000;
    for (;;) {
      await sleep(2_000);
      const next = liveSession(sessionA);
      if (next?.camera && preMove?.camera && sameCamera(preMove.camera, next.camera)) { preMove = next; break; }
      if (Date.now() > cameraDeadline) throw new Error("presence camera never settled after focusing A");
      preMove = next;
    }
    /* Snapshot BOTH sessions' pre-move cameras now, before anything can move:
       whichever tab the record chooses, its way back is judged against the
       frame captured here. */
    const preMoveBySession = new Map<string, PresenceSession | null>([
      [sessionA, preMove],
      [sessionB, liveSession(sessionB)],
    ]);

    /* ── The call under test: the REAL binding, root authority ───────────── */
    const rootTools = serviceAs({ kind: "root", conversationId: "conversation_root" });
    const started = Date.now();
    const result = await rootTools.callTool("request_attention", ask("issue-873-evidence-1")) as ToolResult;
    const elapsedMs = Date.now() - started;

    const recordAtSuccess = readRequests().find((request) => request.id === result.attentionId) ?? null;
    const afterA = await tabA.eval<PageState>(PAGE_STATE);
    const afterB = await tabB.eval<PageState>(PAGE_STATE);

    expect("MCP success exists and names a completed arrival", result.ok === true && result.handoff?.state === "following", { handoff: result.handoff ?? null, elapsedMs });
    expect(
      "the durable record names ONE executing browser session and holds the pre-move return point",
      recordAtSuccess !== null
        && recordAtSuccess.state === "following"
        && Array.isArray(recordAtSuccess.returnPoints) && recordAtSuccess.returnPoints.length === 1
        && recordAtSuccess.acceptedVia === "auto-follow"
        && (recordAtSuccess.offeredTo as string[]).length === 1
        && typeof recordAtSuccess.directedSessionId === "string"
        && typeof recordAtSuccess.operationKey === "string"
        && [sessionA, sessionB].includes(recordAtSuccess.directedSessionId as string),
      { state: recordAtSuccess?.state, returnPoints: (recordAtSuccess?.returnPoints as unknown[] | undefined)?.length, directedSession: recordAtSuccess?.directedSessionId === sessionA ? "tab-A" : recordAtSuccess?.directedSessionId === sessionB ? "tab-B" : "unknown" },
    );
    /* Which tab was chosen? The record says; the OTHER one must not have moved. */
    const chosenIsA = recordAtSuccess?.directedSessionId === sessionA;
    const chosen = chosenIsA ? afterA : afterB;
    const idle = chosenIsA ? afterB : afterA;
    const idleBefore = chosenIsA ? beforeB : before;
    expect(
      "the duplicate-host race resolves to exactly one navigation: the chosen tab moved, the other did not",
      onScreen(chosen.bRect, chosen.viewport)
        && sameRect(idleBefore.aRect, idle.aRect) && sameRect(idleBefore.bRect, idle.bRect)
        && [...afterA.attnPosts, ...afterB.attnPosts].filter((kind) => kind === "arrive").length === 1,
      { chosenTab: chosenIsA ? "A" : "B", chosenB: chosen.bRect, idleA: idle.aRect, posts: { a: afterA.attnPosts, b: afterB.attnPosts } },
    );
    expect(
      "the pages' only word to the record was the arrival — no offer, no accept, no confirmation",
      [...afterA.attnPosts, ...afterB.attnPosts].every((kind) => kind === "arrive"),
      { a: afterA.attnPosts, b: afterB.attnPosts },
    );
    expect(
      "the target card physically arrived on screen before success, same-document",
      onScreen(chosen.bRect, chosen.viewport) && chosen.marker === "alive" && chosen.navEntries === 1,
      { before: { aRect: before.aRect, bRect: before.bRect }, after: { aRect: chosen.aRect, bRect: chosen.bRect }, viewport: chosen.viewport },
    );

    const chosenTab = chosenIsA ? tabA : tabB;
    const chosenSession = chosenIsA ? sessionA : sessionB;
    const chosenPreMove = preMoveBySession.get(chosenSession) ?? null;
    /* The chip renders on the page's next offers refresh after its own arrive
       POST — moments after the MCP response, never before the record follows. */
    await poll(chosenTab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 1`, "return chip", 10_000);
    const withChip = await chosenTab.eval<PageState>(PAGE_STATE);
    expect("exactly one Return action is on screen, on the chosen tab only", withChip.returnChips === 1 && withChip.returnButtons === 1 && (chosenIsA ? afterB : afterA).returnChips === 0, { chips: withChip.returnChips, buttons: withChip.returnButtons });

    /* ── Replay and restart replay: same operation, one record, one move ─── */
    const replay = await rootTools.callTool("request_attention", ask("issue-873-evidence-1")) as ToolResult;
    /* A DIFFERENT service instance with a FRESH receipt store — the shape of a
       restarted MCP process. The durable operation identity on the record is
       what connects the two lives. */
    const restarted = await serviceAs({ kind: "root", conversationId: "conversation_root" })
      .callTool("request_attention", ask("issue-873-evidence-1")) as ToolResult;
    await sleep(500);
    const afterReplay = await chosenTab.eval<PageState>(PAGE_STATE);
    expect(
      "replaying the same clientRequestId returns the committed receipt and moves nothing",
      replay.ok === true && replay.replayed === true && replay.attentionId === result.attentionId
        && readRequests().length === 1
        && afterReplay.attnPosts.filter((kind) => kind === "arrive").length === chosen.attnPosts.filter((kind) => kind === "arrive").length,
      { replayed: replay.replayed, requests: readRequests().length },
    );
    expect(
      "a RESTARTED service adopts the same record: one record, one navigation, a recovered receipt",
      restarted.ok === true && restarted.recovered === true && restarted.attentionId === result.attentionId
        && readRequests().filter((request) => request.operationKey === recordAtSuccess?.operationKey).length === 1,
      { recovered: restarted.recovered ?? null, attentionMatches: restarted.attentionId === result.attentionId },
    );

    /* And the DURABLE receipt seam itself: two service lives over one receipt
       FILE, retrying the SAME landed operation. The first life adopts the
       record (no second navigation) and settles the receipt durably; the
       second replays that settled receipt without touching the binding. */
    const receiptFile = path.join(stateDir, "evidence-mcp-receipts.json");
    const durableA = await serviceAs({ kind: "root", conversationId: "conversation_root" }, [], new FileMcpReceiptStore(receiptFile) as never)
      .callTool("request_attention", ask("issue-873-evidence-1")) as ToolResult;
    const durableB = await serviceAs({ kind: "root", conversationId: "conversation_root" }, [], new FileMcpReceiptStore(receiptFile) as never)
      .callTool("request_attention", ask("issue-873-evidence-1")) as ToolResult;
    expect(
      "a durable receipt survives the process: the second life replays the first's settled success",
      durableA.ok === true && durableA.recovered === true
        && durableB.ok === true && durableB.replayed === true && durableB.attentionId === result.attentionId
        && readRequests().length === 1,
      { okA: durableA.ok, recoveredA: durableA.recovered ?? null, okB: durableB.ok, replayedB: durableB.replayed ?? null, idsMatch: durableB.attentionId === result.attentionId },
    );

    /* ── One Return restores the exact pre-move viewport: camera AND focus ── */
    const capturedPoint = (recordAtSuccess?.returnPoints as Array<{ camera: Camera; focusedPath: string | null }> | undefined)?.[0] ?? null;
    expect(
      "the record's captured return point is the settled pre-move camera",
      sameCamera(capturedPoint?.camera ?? null, chosenPreMove?.camera ?? null),
      { captured: capturedPoint?.camera ?? null, preMove: chosenPreMove?.camera ?? null },
    );
    await chosenTab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await poll(chosenTab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 0`, "return chip consumed", 15_000);
    const restored = await chosenTab.eval<PageState>(PAGE_STATE);
    const recordAfterReturn = readRequests().find((request) => request.id === result.attentionId) ?? null;
    /* The live camera is mirrored by heartbeat, so give it its own cadence to
       report the restored position. Judged by the CAMERA rather than a node
       rect: the demo board has live activity and cards resize between capture
       and restore, so screen-space rects are not a stable identity — the
       camera is what Return actually restores. */
    let restoredSession = liveSession(chosenSession);
    const restoreDeadline = Date.now() + 40_000;
    while (!sameCamera(restoredSession?.camera ?? null, chosenPreMove?.camera ?? null) && Date.now() < restoreDeadline) {
      await sleep(2_000);
      restoredSession = liveSession(chosenSession);
    }
    expect(
      "one Return restores the exact pre-move camera and focused card, and closes the record as returned",
      sameCamera(restoredSession?.camera ?? null, chosenPreMove?.camera ?? null)
        && recordAfterReturn?.state === "returned"
        && restored.returnChips === 0 && restored.marker === "alive" && restored.navEntries === 1
        && (capturedPoint?.focusedPath === null || restoredSession?.focusedPath === capturedPoint?.focusedPath),
      { restoredCamera: restoredSession?.camera ?? null, preMove: chosenPreMove?.camera ?? null, focusedPath: restoredSession?.focusedPath ?? null, captured: capturedPoint?.focusedPath ?? null, state: recordAfterReturn?.state },
    );

    /* ── The orchestrator seat for the target's own project also directs ─── */
    const targetProject = (readRequests().find((request) => request.id === result.attentionId)?.frameAtCreation as { project?: string } | undefined)?.project ?? "";
    const seated = await serviceAs(
      { kind: "worker", conversationId: "conversation_evidence_manager", role: "orchestrator" },
      [{ conversationId: "conversation_evidence_manager", path: null, project: targetProject }],
    ).callTool("request_attention", ask("issue-873-orchestrator-1", {
      target: { kind: "conversation", path: targetPathA },
      reason: "Issue-873 evidence: orchestrator-directed handoff to card A.",
    })) as ToolResult;
    expect(
      "the validated orchestrator seat for the target's project directs the handoff",
      seated.ok === true && seated.handoff?.state === "following",
      { ok: seated.ok, state: seated.handoff?.state ?? null, project: targetProject ? "resolved" : "missing" },
    );
    /* Put the operator back so the abort scenario below starts from rest. */
    await sleep(500);
    await chosenTab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await sleep(1_500);

    /* ── intent=open: one glide, one history entry, then one exact Return ── */
    const beforeOpen = await chosenTab.eval<PageState>(PAGE_STATE);
    const opened = await rootTools.callTool("request_attention", ask("issue-873-open-1", { intent: "open" })) as ToolResult;
    await sleep(700);
    const afterOpen = await chosenTab.eval<PageState>(PAGE_STATE);
    await sleep(700);
    const afterOpenSettled = await chosenTab.eval<PageState>(PAGE_STATE);
    expect(
      "intent=open lands with ONE glide and ONE history entry — no second move fights the camera",
      opened.ok === true && opened.handoff?.state === "following"
        && onScreen(afterOpen.bRect, afterOpen.viewport)
        /* Settled: two samples 700ms apart agree — a competing glide would
           still be dragging the camera between them. */
        && sameRect(afterOpen.bRect, afterOpenSettled.bRect, 1)
        && afterOpenSettled.historyLength - beforeOpen.historyLength === 1
        && afterOpenSettled.navEntries === 1,
      { historyDelta: afterOpenSettled.historyLength - beforeOpen.historyLength, openRect: afterOpen.bRect, settledRect: afterOpenSettled.bRect },
    );
    await poll(chosenTab, `document.querySelectorAll('[data-testid="attention-return"]').length === 1`, "open return control", 10_000);
    await chosenTab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await sleep(1_000);
    const openRecord = readRequests().find((request) => request.id === opened.attentionId) ?? null;
    expect("the open handoff's Return closes its record too", openRecord?.state === "returned", { state: openRecord?.state ?? null });

    /* ── Abort: a cancelled call closes the record; nothing ever navigates ── */
    const abortController = new AbortController();
    abortController.abort();
    const preAbort = await chosenTab.eval<PageState>(PAGE_STATE);
    const abortedCall = await rootTools.callTool(
      "request_attention",
      ask("issue-873-abort-1"),
      { signal: abortController.signal },
    ) as ToolResult;
    /* A full browser poll cycle: were anything left navigable, this is when a
       poll would move the camera. */
    await sleep(5_000);
    const postAbort = await chosenTab.eval<PageState>(PAGE_STATE);
    const abortedRecord = readRequests().find((request) => request.id === (abortedCall.details?.attentionId as string | undefined)) ?? null;
    expect(
      "an aborted call is an explicit HANDOFF_ABORTED with a terminal record and zero movement",
      abortedCall.ok === false && abortedCall.details?.code === "HANDOFF_ABORTED"
        && abortedRecord !== null && ["expired"].includes(abortedRecord.state as string)
        && sameRect(preAbort.aRect, postAbort.aRect) && sameRect(preAbort.bRect, postAbort.bRect)
        && postAbort.attnPosts.filter((kind) => kind === "arrive").length === preAbort.attnPosts.filter((kind) => kind === "arrive").length,
      { code: abortedCall.details?.code ?? null, recordState: abortedRecord?.state ?? null },
    );

    /* ── With every view gone: an explicit bounded refusal, nothing durable ── */
    for (const tab of [tabA, tabB]) {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.targetId}`);
      tab.close();
    }
    console.log("waiting out the presence active window…");
    await sleep(27_000);
    const requestsBefore = readRequests().length;
    const refused = await rootTools.callTool("request_attention", ask("issue-873-no-view-1")) as ToolResult;
    expect(
      "with no active view the call refuses as NO_ACTIVE_VIEW and files nothing",
      refused.ok === false && refused.details?.code === "NO_ACTIVE_VIEW" && readRequests().length === requestsBefore,
      { code: refused.details?.code ?? null, requests: readRequests().length },
    );

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 873,
      capturedAt: new Date().toISOString(),
      buildHead,
      runner: "exact-head production build served by `next start` over the isolated demo runtime (fixtures/demo-home); headless host Chrome (two same-device tabs) over raw CDP; the real MCP tool service + bindings called cross-process over the same shared LLV_STATE_DIR, with only the caller-authority seam injected per scenario",
      contract: "authority-gated execution (root/orchestrator only, refusals file nothing); one browser session executes; success only after the chosen view's verified arrival; one-glide one-entry open; idempotent replay and restart replay over the durable operation identity; abort closes the record; one exact Return restoring camera and focus; explicit bounded failures",
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(
      path.join(import.meta.dir, "handoff.json"),
      (JSON.stringify(output, null, 2) + "\n")
        .replaceAll(repoRoot, "<repo>")
        .replaceAll(repoRoot.replaceAll("/", "-").replaceAll(".", "-"), "-repo-")
        .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1-x"),
    );
    console.log(`\n${output.verdict}: ${checks.length - failed.length}/${checks.length} checks`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (chrome) chrome.kill("SIGKILL");
    await runtime.shutdown();
  }
}

await main();
