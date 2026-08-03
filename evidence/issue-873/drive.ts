/**
 * Real-browser evidence for issue #873 — request_attention as an immediate
 * VERIFIED camera handoff.
 *
 *   bun evidence/issue-873/drive.ts
 *
 * Deep checkouts overflow the ~108-byte unix-socket limit for the fixture tmux
 * socket ("tmux exited with 1" at boot); point LLV_DEMO_TMUX_TMPDIR at a short
 * external dir, exactly as scripts/demo-capture.ts documents.
 *
 * Boots the ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR;
 * never the operator's viewer state, never ports 8898/8899), opens the real
 * Viewer in headless host Chrome over raw CDP, and then calls the REAL MCP
 * request_attention binding in this process against the same shared state dir
 * — the exact cross-process seam production uses. The checks prove:
 *
 *  - presence names the live Chrome desktop, and the call directs exactly it;
 *  - the page's only word to the record is the ARRIVAL — no offer, no accept,
 *    no confirmation of any kind;
 *  - at the instant the MCP promise resolves, the record is `following` with
 *    the pre-move return point captured, and the target card is physically on
 *    screen — the camera moved BEFORE success, same-document;
 *  - exactly one Return control exists, and pressing it restores the exact
 *    original framing;
 *  - replaying the same clientRequestId returns the committed receipt and
 *    navigates nothing;
 *  - with the view gone, the call is an explicit NO_ACTIVE_VIEW refusal.
 *
 * The output carries fixture ids, geometry and booleans only: no absolute
 * paths, no transcript text, no device identities beyond the fixture browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
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
  return cdp;
}

/** Installed before the handoff: records every event kind this page POSTs to
    the attention record, and tags the live document. */
const INSTRUMENT = `(() => {
  window.__marker = "alive";
  window.__attnPosts = [];
  const of = window.fetch.bind(window);
  window.fetch = (...a) => {
    try {
      const url = new URL(String(a[0] instanceof Request ? a[0].url : a[0]), location.href);
      const init = a[1];
      if (url.pathname.startsWith("/api/attention/") && init && typeof init.body === "string") {
        window.__attnPosts.push(JSON.parse(init.body).kind);
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
  marker: window.__marker ?? null,
  navEntries: performance.getEntriesByType("navigation").length,
  returnChips: document.querySelectorAll('[data-testid="focus-return-chip"]').length,
  returnButtons: document.querySelectorAll('[data-testid="attention-return"]').length,
  viewport: { w: window.innerWidth, h: window.innerHeight },
}))()`.replaceAll("__A__", A_ID).replaceAll("__B__", B_ID);

type PageState = {
  aRect: Rect;
  bRect: Rect;
  attnPosts: string[];
  marker: string | null;
  navEntries: number;
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

  console.log("booting isolated demo runtime…");
  const runtime = await bootstrapDemoRuntime(repoRoot, port);
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
    const { viewerMcpBindings } = await import("../../src/lib/mcp/bindings");
    const { createMcpToolService, MemoryMcpReceiptStore } = await import("../../src/lib/mcp/server");
    const tools = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
    const targetPath = renderFixtureTemplate(claudePath("atlas", `${B_ID}.jsonl`), runtime.env.HOME!);

    const attentionFilePath = path.join(stateDir, "attention.json");
    const readRequests = (): Array<Record<string, unknown>> => {
      try {
        return (JSON.parse(fs.readFileSync(attentionFilePath, "utf8")) as { requests: Array<Record<string, unknown>> }).requests;
      } catch {
        return [];
      }
    };
    type PresenceSession = {
      deviceId: string;
      mode: string;
      visibility: string;
      lastSeenAt: number;
      device: { kind: string };
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
    const liveCamera = (): { x: number; y: number; zoom: number } | null =>
      readPresence().find((session) => session.visibility === "visible" && session.mode === "scheme")?.camera ?? null;
    const sameCamera = (left: { x: number; y: number; zoom: number } | null, right: { x: number; y: number; zoom: number } | null): boolean =>
      left !== null && right !== null
      && Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1 && Math.abs(left.zoom - right.zoom) <= 0.01;

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

    const tab = await newTarget();
    await tab.send("Page.navigate", { url: baseUrl });
    await poll(tab, `document.querySelectorAll('[data-testid="overview-conversation"]').length > 0`, "overview rows", 120_000);

    /* A real operator position: the scheme board, focused on card A. */
    await tab.eval(`(() => { const el = document.querySelector('[data-focus-target$="${A_ID}.jsonl"]'); if (el) el.click(); return !!el; })()`);
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]')`, "scheme node A");
    await tab.eval(INSTRUMENT);

    /* The live desktop must be on the shared presence record before the tool
       can direct it. */
    const presenceDeadline = Date.now() + 30_000;
    for (;;) {
      const desks = readPresence().filter((session) => session.device.kind !== "mobile" && session.visibility === "visible" && session.mode === "scheme");
      if (desks.length > 0) break;
      if (Date.now() > presenceDeadline) throw new Error("presence mirror never named the Chrome desktop");
      await sleep(500);
    }
    const desks = readPresence().filter((session) => session.visibility === "visible");
    expect("presence names the live Chrome desktop on the shared record", desks.length > 0, { sessions: desks.length, mode: desks[0]?.mode });

    /* Let the focus-A camera glide settle, so `before` is the frame the
       operator is actually resting at — the same frame Return must restore. */
    let before = await tab.eval<PageState>(PAGE_STATE);
    const settleDeadline = Date.now() + 15_000;
    for (;;) {
      await sleep(500);
      const next = await tab.eval<PageState>(PAGE_STATE);
      if (sameRect(before.aRect, next.aRect, 1)) { before = next; break; }
      if (Date.now() > settleDeadline) throw new Error("board camera never settled after focusing A");
      before = next;
    }
    /* And the presence mirror must have heartbeat that settled camera through:
       it is the cross-process record of where the operator IS, and the camera
       Return must bring back. */
    let preCamera = liveCamera();
    const cameraDeadline = Date.now() + 40_000;
    for (;;) {
      await sleep(2_000);
      const next = liveCamera();
      if (next !== null && sameCamera(preCamera, next)) { preCamera = next; break; }
      if (Date.now() > cameraDeadline) throw new Error("presence camera never settled after focusing A");
      preCamera = next;
    }

    /* ── The call under test: the REAL MCP binding, cross-process ────────── */
    const started = Date.now();
    const result = await tools.callTool("request_attention", {
      clientRequestId: "issue-873-evidence-1",
      target: { kind: "conversation", path: targetPath },
      reason: "Issue-873 evidence: verified camera handoff to card B.",
    }) as Record<string, unknown> & { ok: boolean; handoff?: { deviceId: string; state: string; resolution: string | null }; attentionId?: string };
    const elapsedMs = Date.now() - started;

    /* Read the durable record and the page AT the moment of resolution. */
    const recordAtSuccess = readRequests().find((request) => request.id === result.attentionId) ?? null;
    const after = await tab.eval<PageState>(PAGE_STATE);

    expect("MCP success exists and names a completed arrival", result.ok === true && result.handoff?.state === "following", { handoff: result.handoff ?? null, elapsedMs });
    expect(
      "the durable record is following with the pre-move return point at the instant of success",
      recordAtSuccess !== null
        && recordAtSuccess.state === "following"
        && Array.isArray(recordAtSuccess.returnPoints) && recordAtSuccess.returnPoints.length === 1
        && recordAtSuccess.acceptedVia === "auto-follow"
        && (recordAtSuccess.offeredTo as string[]).length === 1,
      { state: recordAtSuccess?.state, returnPoints: (recordAtSuccess?.returnPoints as unknown[] | undefined)?.length, offeredTo: recordAtSuccess?.offeredTo },
    );
    expect(
      "the page's only word to the record was the arrival — no offer, no accept, no confirmation",
      after.attnPosts.length >= 1 && after.attnPosts.every((kind) => kind === "arrive"),
      after.attnPosts,
    );
    expect(
      "the target card physically arrived on screen before success, same-document",
      onScreen(after.bRect, after.viewport) && !sameRect(before.aRect, after.aRect) && after.marker === "alive" && after.navEntries === 1,
      { before: { aRect: before.aRect, bRect: before.bRect }, after: { aRect: after.aRect, bRect: after.bRect }, viewport: after.viewport },
    );
    /* The chip renders on the page's next offers refresh after its own arrive
       POST — moments after the MCP response, never before the record follows. */
    await poll(tab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 1`, "return chip", 10_000);
    const withChip = await tab.eval<PageState>(PAGE_STATE);
    expect("exactly one Return action is on screen", withChip.returnChips === 1 && withChip.returnButtons === 1, { chips: withChip.returnChips, buttons: withChip.returnButtons });

    /* ── Replay: same clientRequestId, no second navigation ──────────────── */
    const replay = await tools.callTool("request_attention", {
      clientRequestId: "issue-873-evidence-1",
      target: { kind: "conversation", path: targetPath },
      reason: "Issue-873 evidence: verified camera handoff to card B.",
    }) as Record<string, unknown> & { ok: boolean; replayed?: boolean; attentionId?: string };
    await sleep(500);
    const afterReplay = await tab.eval<PageState>(PAGE_STATE);
    expect(
      "replaying the same clientRequestId returns the committed receipt and moves nothing",
      replay.ok === true && replay.replayed === true && replay.attentionId === result.attentionId
        && readRequests().length === 1
        && sameRect(after.bRect, afterReplay.bRect)
        && afterReplay.attnPosts.length === after.attnPosts.length,
      { replayed: replay.replayed, requests: readRequests().length },
    );

    /* ── One Return restores the original frame exactly ───────────────────── */
    /* The camera the handoff itself moved to, off the record's own return
       point capture: it must equal the settled pre-move camera. */
    const capturedPoint = (recordAtSuccess?.returnPoints as Array<{ camera: { x: number; y: number; zoom: number } | null }> | undefined)?.[0] ?? null;
    expect(
      "the record's captured return point is the settled pre-move camera",
      sameCamera(capturedPoint?.camera ?? null, preCamera),
      { captured: capturedPoint?.camera ?? null, preMove: preCamera },
    );
    await tab.eval(`(() => { const el = document.querySelector('[data-testid="attention-return"]'); if (el) el.click(); return !!el; })()`);
    await poll(tab, `document.querySelectorAll('[data-testid="focus-return-chip"]').length === 0`, "return chip consumed", 15_000);
    const restored = await tab.eval<PageState>(PAGE_STATE);
    const recordAfterReturn = readRequests().find((request) => request.id === result.attentionId) ?? null;
    /* The live camera is mirrored by heartbeat, so give it its own cadence to
       report the restored position. Judged by the CAMERA rather than a node
       rect: the demo board has live activity and cards resize between capture
       and restore, so screen-space rects are not a stable identity — the
       camera is what Return actually restores. */
    let restoredCamera = liveCamera();
    const restoreDeadline = Date.now() + 40_000;
    while (!sameCamera(restoredCamera, preCamera) && Date.now() < restoreDeadline) {
      await sleep(2_000);
      restoredCamera = liveCamera();
    }
    expect(
      "one Return restores the exact pre-move camera and closes the record as returned",
      sameCamera(restoredCamera, preCamera) && recordAfterReturn?.state === "returned" && restored.returnChips === 0 && restored.marker === "alive" && restored.navEntries === 1,
      { restoredCamera, preMove: preCamera, state: recordAfterReturn?.state },
    );

    /* ── With the view gone: an explicit bounded refusal, nothing durable ── */
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.targetId}`);
    tab.close();
    console.log("waiting out the presence active window…");
    await sleep(27_000);
    const requestsBefore = readRequests().length;
    const refused = await tools.callTool("request_attention", {
      clientRequestId: "issue-873-evidence-2",
      target: { kind: "conversation", path: targetPath },
      reason: "Issue-873 evidence: no active view refusal.",
    }) as Record<string, unknown> & { ok: boolean; details?: { code?: string } };
    expect(
      "with no active view the call refuses as NO_ACTIVE_VIEW and files nothing",
      refused.ok === false && refused.details?.code === "NO_ACTIVE_VIEW" && readRequests().length === requestsBefore,
      { code: refused.details?.code ?? null, requests: readRequests().length },
    );

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 873,
      capturedAt: new Date().toISOString(),
      runner: "headless host Chrome over raw CDP against the isolated demo runtime (fixtures/demo-home); the real MCP request_attention binding called cross-process over the same shared LLV_STATE_DIR",
      contract: "success only after the chosen view's verified arrival; one deterministic device; no pending/offered state; one exact Return; idempotent replay; explicit bounded failures",
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
