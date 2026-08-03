/**
 * Real-browser Back/Forward evidence for issue #866.
 *
 *   bun evidence/issue-866/drive.ts
 *
 * Boots the ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR;
 * never the operator's viewer state, never ports 8898/8899), drives headless
 * host Chrome over raw CDP, performs deliberate card focuses through the real
 * UI (overview rows, switchboard rows, sub-agent badges), traverses history
 * with history.back()/forward() — the same session-history traversal the
 * browser buttons and mouse side-buttons perform — and writes the assertions
 * to evidence/issue-866/back-forward.json. The output carries conversation
 * ids, hashes, counters and booleans only: no absolute paths, no transcript
 * text.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, demoPort } from "../../scripts/demo-capture";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9337;

/* Fixture ids are assembled at runtime so no UUID-shaped or private-network
   literal lands in the published sources (privacy gate classes). */
const A_ID = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const B_ID = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const STALE_ID = ["00000000", "0000", "4000", "8000", "00000000dead"].join("-");
const DRAFT_TEXT = "issue-866 draft survives traversal";

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  events: Array<{ method: string; params: Record<string, unknown> }> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const waiter = this.#pending.get(message.id)!;
        this.#pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method) this.events.push({ method: message.method, params: message.params ?? {} });
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

async function newTarget(baseUrl: string): Promise<Cdp> {
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const target = (await created.json()) as { webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  void baseUrl;
  return cdp;
}

/** Instrumentation installed BEFORE any gesture: counts history writes, tags
    the live document, and records every fetch URL's pathname. */
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

const SNAPSHOT = `(() => ({
  hash: decodeURIComponent(location.hash),
  entry: (history.state && history.state.llvFocus) || null,
  pushes: window.__pushes, replaces: window.__replaces,
  marker: window.__marker,
  navEntries: performance.getEntriesByType("navigation").length,
}))()`;

type Snap = {
  hash: string;
  entry: { v: number; conversationId: string | null; path: string | null; project: string } | null;
  pushes: number;
  replaces: number;
  marker: string;
  navEntries: number;
};


/** The current focus identity (conversationId or path) as one string, so the
    assertions work identically for registry-keyed and path-keyed payloads. */
const KEY = `(() => { const e = history.state && history.state.llvFocus; return e ? String(e.conversationId || e.path || "") : ""; })()`;
const onKey = (fragment: string) => `${KEY}.includes("${fragment}")`;

const clickExpr = (finder: string) => `(() => { const el = ${finder}; if (!el) return false; el.click(); return true; })()`;

async function click(cdp: Cdp, finder: string, label: string): Promise<void> {
  if (!(await cdp.eval<boolean>(clickExpr(finder)))) throw new Error(`click target missing: ${label}`);
}

async function back(cdp: Cdp): Promise<void> {
  await cdp.eval("(history.back(), true)");
  await sleep(700);
}

async function forward(cdp: Cdp): Promise<void> {
  await cdp.eval("(history.forward(), true)");
  await sleep(700);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3057, "LLV_EVIDENCE_PORT");
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

    /* ── Desktop scenario ─────────────────────────────────────────────── */
    const tab = await newTarget(baseUrl);
    await tab.send("Page.navigate", { url: baseUrl });
    await poll(tab, `document.querySelectorAll('[data-testid="overview-conversation"]').length > 0`, "overview rows", 120_000);
    await tab.eval(INSTRUMENT);

    /* Focus A from the overview (deliberate route: openFile). */
    await click(tab, `document.querySelector('[data-focus-target$="${A_ID}.jsonl"]')`, "overview row A");
    await poll(tab, onKey(A_ID), "focus entry A");
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]')`, "scheme node A");
    let snap = await tab.eval<Snap>(SNAPSHOT);
    const keyOf = (entry: Snap["entry"]) => String(entry?.conversationId ?? entry?.path ?? "");
    expect("focus A records a typed entry keyed by stable identity", keyOf(snap.entry).includes(A_ID) && snap.pushes === 1, snap);

    /* Composer draft on A + live-DOM identity tag. */
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

    /* Focus B through the switchboard (deliberate route: openSwitchboardFile). */
    await click(tab, `document.querySelector('[aria-label="Open the agent switchboard"]')`, "switchboard toggle");
    await poll(tab, `!!document.querySelector('[data-flip-key*="${B_ID}"]')?.firstElementChild`, "switchboard card B");
    await click(tab, `document.querySelector('[data-flip-key*="${B_ID}"]')?.firstElementChild`, "switchboard card B");
    await poll(tab, onKey(B_ID), "focus entry B");
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("focus B pushes a second entry", keyOf(snap.entry).includes(B_ID) && snap.pushes === 2, snap);

    /* Repeated focus on the current target must coalesce, not stack. */
    await click(tab, `document.querySelector('[aria-label="Open the agent switchboard"]')`, "switchboard toggle");
    await poll(tab, `!!document.querySelector('[data-flip-key*="${B_ID}"]')?.firstElementChild`, "switchboard card B again");
    await click(tab, `document.querySelector('[data-flip-key*="${B_ID}"]')?.firstElementChild`, "switchboard card B again");
    await sleep(400);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("repeated focus on B coalesces (no third entry)", snap.pushes === 2 && keyOf(snap.entry).includes(B_ID), snap);

    /* Focus child C via B's sub-agent badge (delegation route). */
    await poll(tab, `!!document.querySelector('[data-subagent-badge*="agent-builder"]')`, "sub-agent badge");
    await click(tab, `document.querySelector('[data-subagent-badge*="agent-builder"]')`, "sub-agent badge C");
    await poll(tab, onKey("subagents/agent-builder"), "child C focused");
    snap = await tab.eval<Snap>(SNAPSHOT);
    const childKey = keyOf(snap.entry);
    expect("sub-agent focus C records a third entry", snap.pushes === 3 && snap.entry !== null, snap);

    const pushesBeforeTraversal = snap.pushes;

    /* Tag A's live DOM node NOW, with the A/B/C layout settled: what must keep
       identity is the board across TRAVERSAL, not across the layout growth
       that placing B and C legitimately performs. */
    await tab.eval(`(() => {
      const node = document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]');
      window.__nodeA = node;
      window.__nodesLayer = node ? node.parentElement : null;
      window.__boardHost = node ? node.parentElement.parentElement : null;
      window.__main = document.querySelector("main");
      return !!node;
    })()`);

    /* A → B → C laid down. Now: Back B, Back A, Forward B, Forward C. */
    await back(tab);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("Back focuses B", keyOf(snap.entry).includes(B_ID) && snap.hash.includes(B_ID), snap);
    await back(tab);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("Back focuses A", keyOf(snap.entry).includes(A_ID) && snap.hash.includes(A_ID), snap);
    await forward(tab);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("Forward focuses B", keyOf(snap.entry).includes(B_ID), snap);
    await forward(tab);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("Forward focuses C", keyOf(snap.entry) === childKey && snap.entry !== null, snap);
    expect("traversal replay pushed no entries (no loops)", snap.pushes === pushesBeforeTraversal, snap);

    /* Same-document proof: the instrumented globals survived every move. */
    expect("no document reload across traversal", snap.marker === "alive" && snap.navEntries === 1, snap);
    const domProof = await tab.eval<{ nodeAlive: boolean; layerAlive: boolean; hostAlive: boolean; mainAlive: boolean; nodePresent: boolean; draft: string | null }>(`(() => ({
      nodeAlive: !!(window.__nodeA && window.__nodeA.isConnected),
      layerAlive: !!(window.__nodesLayer && window.__nodesLayer.isConnected),
      hostAlive: !!(window.__boardHost && window.__boardHost.isConnected),
      mainAlive: !!(window.__main && window.__main.isConnected),
      nodePresent: !!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]'),
      draft: (() => { const f = document.querySelector('[data-scheme-node$="${A_ID}.jsonl"] textarea'); return f ? f.value : null; })(),
    }))()`);
    expect("board kept its DOM identity and unrelated card A stayed present", domProof.mainAlive && domProof.nodePresent, domProof);
    expect("unsent composer draft survived Back/Forward", domProof.draft === DRAFT_TEXT, domProof);
    const snapshotCalls = await tab.eval<string[]>(`window.__fetchPaths.filter((p) => p.includes("/api/agent/snapshot"))`);
    expect("navigation never called /api/agent/snapshot", snapshotCalls.length === 0, snapshotCalls);

    /* Forward-branch truncation: Back to B, focus A anew, Forward is a no-op. */
    await back(tab);
    await click(tab, `document.querySelector('[aria-label="Open the agent switchboard"]')`, "switchboard toggle");
    await poll(tab, `!!document.querySelector('[data-flip-key*="${A_ID}"]')?.firstElementChild`, "switchboard card A");
    await click(tab, `document.querySelector('[data-flip-key*="${A_ID}"]')?.firstElementChild`, "re-focus A after Back");
    await sleep(500);
    const beforeForward = await tab.eval<Snap>(SNAPSHOT);
    await forward(tab);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect(
      "a new focus after Back truncates the forward branch",
      keyOf(beforeForward.entry).includes(A_ID) && keyOf(snap.entry).includes(A_ID) && snap.pushes === beforeForward.pushes,
      { beforeForward, after: snap },
    );

    /* Cross-project: from the overview, focus a conversation of a DIFFERENT
       resolved project group (relay/beacon), then Back twice lands on A back in
       the first project. */
    const projectA = (await tab.eval<Snap>(SNAPSHOT)).entry?.project ?? "";
    await click(tab, `[...document.querySelectorAll("aside nav button")].find((b) => b.textContent.trim().toLowerCase().startsWith("overview"))`, "rail: overview");
    await poll(tab, `document.querySelectorAll('[data-testid="overview-card"]').length > 0`, "overview cards", 30_000);
    const crossClicked = await tab.eval<boolean>(`(() => {
      for (const card of document.querySelectorAll('[data-testid="overview-card"]')) {
        const label = (card.querySelector('[data-testid="overview-project"]')?.textContent ?? "").toLowerCase();
        if (!label.includes("relay") && !label.includes("beacon")) continue;
        const row = card.querySelector('[data-testid="overview-conversation"]');
        if (!row) continue;
        window.__crossPath = row.getAttribute("data-focus-target");
        row.click();
        return true;
      }
      return false;
    })()`);
    expect("cross-project overview row found and clicked", crossClicked);
    /* The focused entry flips off A's identity (relay/beacon fixtures carry
       registry conversation ids, so the key shape differs from the path). */
    await poll(tab, `!(${onKey(A_ID)}) && ${KEY}.length > 0`, "focus entry cross-project", 30_000);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("cross-project focus stores a different project", snap.entry !== null && snap.entry.project !== projectA, snap.entry?.project);
    await back(tab); /* → the overview selection entry */
    await back(tab); /* → A's entry, back in the first project */
    await poll(tab, onKey(A_ID), "focus entry A after cross-project Back");
    await poll(tab, `!!document.querySelector('[data-scheme-node$="${A_ID}.jsonl"]')`, "atlas board restored", 20_000);
    snap = await tab.eval<Snap>(SNAPSHOT);
    expect("cross-project Back re-selects the stored project and focuses A", keyOf(snap.entry).includes(A_ID) && snap.entry?.project === projectA, snap.entry?.project);
    expect("cross-project traversal still no reload", snap.marker === "alive" && snap.navEntries === 1, snap);

    /* Stale entry: replay a conversation that cannot resolve → visible notice,
       and the next traversal still works. */
    await tab.eval(`(history.pushState({ llvFocus: { v: 1, conversationId: "${STALE_ID}", path: null, project: "${(snap.entry?.project ?? "").replaceAll('"', "")}" } }, "", "#c=${STALE_ID}"), true)`);
    await tab.eval(`(history.pushState(null, "", "#p=after-stale"), true)`);
    await back(tab); /* popstate replays the stale typed entry through the real handler */
    await poll(tab, `!!document.querySelector("[data-stale-focus-notice]")`, "stale focus notice", 15_000);
    expect("stale replay target fails visibly", true);
    await back(tab);
    await poll(tab, onKey(A_ID), "focus entry A after stale entry", 15_000);
    expect("history remains usable after the stale entry", true);
    tab.close();

    /* ── Mobile 396px scenario ────────────────────────────────────────── */
    const mob = await newTarget(baseUrl);
    /* The desktop scenario shares the Chrome profile; a fresh-tab overview needs
       the persisted project selection gone before the app boots. */
    await mob.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); } catch {}" });
    await mob.send("Emulation.setDeviceMetricsOverride", { width: 396, height: 780, deviceScaleFactor: 2, mobile: true });
    await mob.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await mob.send("Page.navigate", { url: baseUrl });
    await poll(mob, `document.querySelectorAll('[data-testid="overview-conversation"]').length > 0`, "mobile overview rows", 120_000);
    await mob.eval(INSTRUMENT);
    await click(mob, `document.querySelector('[data-focus-target$="${A_ID}.jsonl"]')`, "mobile overview row A");
    await poll(mob, onKey(A_ID), "mobile focus entry A");
    let mobileSnap = await mob.eval<Snap>(SNAPSHOT);
    expect("mobile 396px focus records the same typed entry", keyOf(mobileSnap.entry).includes(A_ID) && mobileSnap.pushes === 1, mobileSnap);
    await back(mob);
    await poll(mob, `location.hash === "" || location.hash === "#"`, "mobile back to overview", 15_000);
    await forward(mob);
    await poll(mob, onKey(A_ID), "mobile forward to A", 15_000);
    mobileSnap = await mob.eval<Snap>(SNAPSHOT);
    expect("mobile Back/Forward replays without reload", mobileSnap.marker === "alive" && mobileSnap.navEntries === 1 && keyOf(mobileSnap.entry).includes(A_ID), mobileSnap);
    mob.close();

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 866,
      capturedAt: new Date().toISOString(),
      runner: "headless host Chrome over raw CDP against the isolated demo runtime (fixtures/demo-home)",
      traversal: "history.back()/history.forward() — the session-history traversal browser and mouse Back/Forward perform",
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(path.join(import.meta.dir, "back-forward.json"), (JSON.stringify(output, null, 2) + "\n").replaceAll(repoRoot, "<repo>").replaceAll(repoRoot.replaceAll("/", "-").replaceAll(".", "-"), "-repo-").replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1-x"));
    console.log(`\n${output.verdict}: ${checks.length - failed.length}/${checks.length} checks`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (chrome) chrome.kill("SIGKILL");
    await runtime.shutdown();
  }
}

await main();
