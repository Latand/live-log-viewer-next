/**
 * Real-browser switching profile for issue #1432.
 *
 *   bun scripts/profile-switching.ts [--port 3121] [--cdp-port 9333] [--out file.md] [--keep]
 *
 * Seeds a throwaway home with the same invented corpus the DOM profile uses
 * (`src/test-helpers/switchingFixtures.ts`: short, long and tool-heavy
 * conversations in two projects), boots the repository's own Next.js dev
 * server under that home, and drives a headless Chrome over raw CDP through
 * the switching scenarios on a desktop viewport and a 390px phone viewport.
 * Every step reports real milliseconds and animation frames from the gesture
 * to the milestone, measured inside the page with `performance.now()` and
 * `requestAnimationFrame`.
 *
 * Nothing here names a person, an account or a machine: the home, the
 * projects and every transcript are invented, and the run deletes its home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { en } from "@/lib/i18n/en";
import { appendedLine, switchingCorpus, transcriptText, type SwitchingConversation } from "@/test-helpers/switchingFixtures";

const repoRoot = path.resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg.slice(2), next);
    index += 1;
  } else {
    args.set(arg.slice(2), "1");
  }
}
const PORT = Number(args.get("port") ?? 3121);
const CDP_PORT = Number(args.get("cdp-port") ?? 9333);
const KEEP = args.has("keep");
const OUT = args.get("out");
/** `--dump`: print what the scanner made of the seeded home, then stop. */
const DUMP = args.has("dump");
/** `--server-log <file>`: keep the dev server's own output for the run. */
const SERVER_LOG = args.get("server-log");
const CHROME = process.env.LLV_PROFILE_CHROME ?? "/usr/bin/google-chrome-stable";

/* ── throwaway home ─────────────────────────────────────────────────────── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1432-profile-"));
const home = path.join(root, "home");
const slug = (value: string) => value.replace(/[^A-Za-z0-9]/g, "-");
const cwdFor = (project: string) => path.join(home, "Projects", project);
const corpus = switchingCorpus(cwdFor);

/** Session ids in the transcript's own shape, assembled from the corpus index. */
function sessionIdFor(index: number): string {
  const tail = (index + 1).toString(16).padStart(12, "0");
  return [`c${index}`.padEnd(8, "0"), "0000", "4000", "8000", tail].join("-");
}

interface Seeded extends SwitchingConversation {
  /** Absolute transcript path as the scanner will report it. */
  diskPath: string;
}

function seedHome(): Seeded[] {
  const seeded: Seeded[] = [];
  corpus.forEach((entry, index) => {
    const cwd = cwdFor(entry.project);
    fs.mkdirSync(cwd, { recursive: true });
    const dir = path.join(home, ".claude", "projects", slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const diskPath = path.join(dir, `${sessionIdFor(index)}.jsonl`);
    fs.writeFileSync(diskPath, transcriptText(entry.lines));
    seeded.push({ ...entry, diskPath });
  });
  /* No account is seeded: the switching paths under measurement never touch
     one, and a fake sign-in only makes the account controller spend the run
     talking to a provider that will refuse it. */
  /* Older mtimes for the older shapes so the board orders them the same way
     the DOM profile's fixtures do. */
  const base = Date.now();
  for (const entry of seeded) {
    const age = entry.shape === "short" ? 0 : entry.shape === "long" ? 60_000 : 120_000;
    fs.utimesSync(entry.diskPath, new Date(base - age), new Date(base - age));
  }
  return seeded;
}

function buildEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? 1000;
  const tmp = path.join(root, "tmp");
  const config = path.join(home, ".config");
  for (const dir of [home, tmp, path.join(tmp, `claude-${uid}`), path.join(root, "tmux"), path.join(root, "cache"), path.join(root, "runtime"), config, path.join(config, "agent-log-viewer", "state")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.chmodSync(path.join(root, "runtime"), 0o700);
  return {
    NODE_ENV: "development",
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    TMUX_TMPDIR: path.join(root, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "profile", USER: "profile",
    SHELL: "/bin/sh",
  };
}

/* ── processes ──────────────────────────────────────────────────────────── */

function outputLines(child: ChildProcess): () => string {
  const lines: string[] = [];
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push(line);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  return () => lines.join("\n");
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForServer(url: string, child: ChildProcess, logs: () => string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early\n${logs()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  throw new Error(`dev server did not answer within ${timeoutMs} ms\n${logs()}`);
}

/* ── raw CDP ────────────────────────────────────────────────────────────── */

class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters = new Map<string, Array<(params: unknown) => void>>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; error?: { message?: string; code?: number }; result?: unknown };
      if (message.id === undefined) {
        if (message.method) {
          const list = this.waiters.get(message.method);
          if (list?.length) {
            this.waiters.delete(message.method);
            for (const resolve of list) resolve(message.params);
          }
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
    });
  }
  /** Resolve on the next occurrence of a CDP event, or null after `timeoutMs`. */
  waitFor(method: string, timeoutMs: number): Promise<unknown | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(method) ?? [];
        this.waiters.set(method, list.filter((entry) => entry !== settle));
        resolve(null);
      }, timeoutMs);
      const settle = (params: unknown) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), settle]);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate an expression (may be a promise) and return its JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as { text: string; exception?: { description?: string; value?: unknown } };
      throw new Error(`${details.exception?.description ?? details.text}\n${JSON.stringify(details).slice(0, 1200)}\nexpression: ${expression.slice(0, 400)}`);
    }
    return result.result.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

async function pageWebSocketUrl(): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await Bun.sleep(250);
  }
  throw new Error("headless chrome exposed no page target");
}

/* ── in-page measurement ────────────────────────────────────────────────── */

/** Installed once per document: milestone polling per animation frame. */
const PROBE = String.raw`
(() => {
  if (window.__profile) return;
  const pane = (path) => document.querySelector('[data-link-path="' + path + '"]');
  const probe = {
    rows: (path) => { const el = pane(path); return el ? el.querySelectorAll('[data-feed-kind]').length : 0; },
    ringed: (path) => { const node = document.querySelector('[data-scheme-node="' + path + '"]'); return !!(node && node.querySelector(':scope > .ring-2')); },
    rail: () => { const el = document.querySelector('button[aria-current="page"]'); return el ? el.textContent.trim() : ""; },
    skeleton: () => !!document.querySelector('[role="status"][aria-busy="true"][aria-live="polite"]'),
    focusedPane: () => document.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]'),
    focusedPath: () => { const el = probe.focusedPane(); return el ? el.getAttribute('data-link-path') : null; },
    focusedRows: () => { const el = probe.focusedPane(); return el ? el.querySelectorAll('[data-feed-kind]').length : 0; },
    chip: (path, title) => Array.from(document.querySelectorAll('button[title]')).find((b) => b.title === title) || null,
    chipActive: (title) => { const b = probe.chip(null, title); return !!(b && b.className.includes('border-accent/60')); },
    firstRow: (path) => { const el = pane(path); return el ? el.querySelector('[data-feed-key]') : null; },
    /* Poll until every named check holds; report when EACH one first held. */
    untilEach: (checks, timeoutMs) => new Promise((resolve, reject) => {
      const start = performance.now();
      const at = {};
      const tick = () => {
        for (const [key, fn] of Object.entries(checks)) {
          if (at[key] !== undefined) continue;
          let ok = false;
          try { ok = fn(); } catch (error) { reject(error); return; }
          if (ok) at[key] = Math.round((performance.now() - start) * 10) / 10;
        }
        if (Object.keys(checks).every((key) => at[key] !== undefined)) { resolve(at); return; }
        if (performance.now() - start > timeoutMs) { reject(new Error('milestones not reached: ' + JSON.stringify(at) + ' :: ' + document.body.innerText.slice(0, 200))); return; }
        setTimeout(tick, 2);
      };
      tick();
    }),
    /* Network requests that started after sinceMs (a performance.now() stamp): when, how long, what. */
    requestsSince: (sinceMs) => performance.getEntriesByType('resource')
      .filter((entry) => entry.startTime >= sinceMs && entry.name.includes('/api/'))
      .map((entry) => { const u = new URL(entry.name); return { at: Math.round(entry.startTime - sinceMs), ms: Math.round(entry.duration), name: (u.pathname + u.search).slice(0, 90) }; }),
    /* Poll on a short timer until check() holds; resolve with real ms since the
       call and the animation frames that elapsed meanwhile. Headless Chrome
       throttles requestAnimationFrame for an unfocused page, so the frame
       counter is an observer, never the clock the poll rides on. */
    until: (check, timeoutMs, watch) => new Promise((resolve, reject) => {
      const start = performance.now();
      let frames = 0;
      let counting = true;
      const seen = {};
      const frame = () => { if (!counting) return; frames += 1; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const tick = () => {
        if (watch) for (const [key, fn] of Object.entries(watch)) if (fn()) seen[key] = true;
        let ok = false;
        try { ok = check(); } catch (error) { counting = false; reject(error); return; }
        if (ok) { counting = false; resolve({ ms: Math.round((performance.now() - start) * 10) / 10, frames, seen }); return; }
        if (performance.now() - start > timeoutMs) {
          counting = false;
          const nodes = Array.from(document.querySelectorAll('[data-scheme-node]')).map((node) => [String(node.getAttribute('data-scheme-node')).split('/').pop(), !!node.querySelector(':scope > .ring-2'), node.querySelectorAll('[data-feed-kind]').length]);
          reject(new Error('milestone not reached: ' + check.toString().slice(0, 160) + ' :: hash=' + location.hash.slice(0, 80) + ' rail=' + probe.rail() + ' skeleton=' + probe.skeleton() + ' nodes=' + JSON.stringify(nodes) + ' focused=' + probe.focusedPath() + ' :: ' + document.body.innerText.slice(0, 160).replace(/\n/g, ' ')));
          return;
        }
        setTimeout(tick, 2);
      };
      tick();
    }),
  };
  window.__profile = probe;
})();
`;

interface Milestone {
  ms: number;
  frames: number;
  seen: Record<string, boolean>;
  /** API requests the page issued between the gesture and the milestone. */
  requests?: Array<{ at: number; ms: number; name: string }>;
  /** False when the milestone never showed within its budget: the row says
      so and the run goes on, so one missing ring cannot blank a whole table. */
  reached?: false;
}

interface Row {
  surface: string;
  step: string;
  ms: number | string;
  frames: number | string;
  notes: string;
}
const rows: Row[] = [];
const describeRequests = (requests: Array<{ at: number; ms: number; name: string }>) =>
  requests.slice(0, 12).map((entry) => `+${entry.at}ms ${entry.name} (${entry.ms}ms)`).join("; ");
const record = (surface: string, step: string, milestone: Milestone, notes = ""): void => {
  const requestNotes = milestone.requests?.length ? `requests ${describeRequests(milestone.requests)}` : "";
  const missed = milestone.reached === false ? "NOT REACHED within the budget" : "";
  const allNotes = [missed, notes, requestNotes].filter(Boolean).join("; ");
  const ms = milestone.reached === false ? `>${milestone.ms}` : milestone.ms;
  rows.push({ surface, step, ms, frames: milestone.frames, notes: allNotes });
  console.log(`  ${surface} | ${step} | ${ms} ms | ${milestone.frames} frames${allNotes ? " | " + allNotes : ""}`);
};

const js = JSON.stringify;

/** Run `gesture`, then wait for every named check; returns when each first held plus the API requests the step issued. */
async function measureEach(cdp: Cdp, gesture: string, checks: Record<string, string>, timeoutMs = 30_000): Promise<{ at: Record<string, number>; requests: Array<{ at: number; ms: number; name: string }> }> {
  const source = `{${Object.entries(checks).map(([key, expression]) => `${js(key)}: () => (${expression})`).join(",")}}`;
  return cdp.evaluate(`(async () => {
    const p = window.__profile;
    const since = performance.now();
    ${gesture};
    const at = await p.untilEach(${source}, ${timeoutMs});
    return { at, requests: p.requestsSince(since) };
  })()`);
}

/** Run `gesture` (a JS statement) and wait for `check` (a JS expression) on the
    same frame clock; the API requests issued meanwhile ride along, so a slow
    step can be attributed to the server or to the client. */
async function measure(cdp: Cdp, gesture: string, check: string, timeoutMs = 20_000, watch: Record<string, string> = {}): Promise<Milestone> {
  const watchSource = `{${Object.entries(watch).map(([key, expression]) => `${js(key)}: () => (${expression})`).join(",")}}`;
  try {
    return await cdp.evaluate<Milestone>(`(async () => {
      const p = window.__profile;
      const since = performance.now();
      ${gesture};
      const milestone = await p.until(() => (${check}), ${timeoutMs}, ${watchSource});
      return { ...milestone, requests: p.requestsSince(since) };
    })()`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("milestone not reached")) throw error;
    console.log(`  ! not reached within ${timeoutMs} ms: ${message.split("\n")[0]?.slice(0, 400)}`);
    return { ms: timeoutMs, frames: "" as unknown as number, seen: {}, reached: false };
  }
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  /* The load event of the NEW document, armed before the navigation is
     issued: polling readyState right after Page.navigate reads the old
     document, and a probe installed there dies with its context. */
  const loaded = cdp.waitFor("Page.loadEventFired", 120_000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.evaluate(PROBE);
}

/* ── scenarios ──────────────────────────────────────────────────────────── */

interface Scanned {
  path: string;
  conversationId?: string;
  title: string;
}

interface Catalog {
  files: Scanned[];
  /** Scanner project key per display name (a non-git directory keys as a hash). */
  keys: Record<string, string>;
}

async function scannedFiles(origin: string): Promise<Catalog> {
  const body = (await (await fetch(`${origin}/api/files`)).json()) as { files: Scanned[]; projectCatalog?: Array<{ project: string; displayName?: string }> };
  const keys: Record<string, string> = {};
  for (const entry of body.projectCatalog ?? []) keys[entry.displayName ?? entry.project] = entry.project;
  return { files: body.files, keys };
}

function findSeeded(seeded: Seeded[], project: string, shape: string): Seeded {
  const entry = seeded.find((candidate) => candidate.project === project && candidate.shape === shape);
  if (!entry) throw new Error(`corpus has no ${project}/${shape}`);
  return entry;
}

async function runDesktop(cdp: Cdp, origin: string, seeded: Seeded[], catalog: Catalog): Promise<void> {
  const short = findSeeded(seeded, "alpha", "short");
  const long = findSeeded(seeded, "alpha", "long");
  const tools = findSeeded(seeded, "alpha", "toolheavy");
  const betaA = findSeeded(seeded, "beta", "short");
  const betaB = findSeeded(seeded, "beta", "long");
  const projectUrl = (name: string) => `${origin}/#p=${encodeURIComponent(catalog.keys[name] ?? name)}`;
  /* Every «Open conversation» button is a conversation-hash anchor; the
     transcript-path form resolves through the same in-app route as `#c=`. */
  const hashOf = (entry: Seeded) => `#f=${encodeURIComponent(entry.diskPath)}`;
  const alphaPaths = [short.diskPath, long.diskPath, tools.diskPath];
  const betaPaths = [betaA.diskPath, betaB.diskPath];
  const painted = (paths: string[]) => paths.map((p) => `p.rows(${js(p)}) > 0`).join(" && ");

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  /* Warm the dev server's compile once, then measure a cold mount. */
  await navigate(cdp, projectUrl("alpha"));
  await measure(cdp, "", painted(alphaPaths), 120_000);
  await navigate(cdp, "about:blank");
  await navigate(cdp, projectUrl("alpha"));
  const mount = await cdp.evaluate<{ at: Record<string, number>; requests: Array<{ at: number; ms: number; name: string }> }>(`(async () => {
    const p = window.__profile;
    const at = await p.untilEach({
      nodes: () => document.querySelectorAll('[data-scheme-node]').length >= ${alphaPaths.length},
      ${alphaPaths.map((path, index) => `rows${index}: () => p.rows(${js(path)}) > 0`).join(",\n      ")}
    }, 60000);
    const base = performance.now() - Math.max(...Object.values(at));
    return { at: Object.fromEntries(Object.entries(at).map(([key, value]) => [key, Math.round(value + base)])), requests: p.requestsSince(0) };
  })()`);
  record("desktop", "navigate → three cards painted (cold, since navigation start)", { ms: Math.max(...alphaPaths.map((_, index) => mount.at[`rows${index}`]!)), frames: "", seen: {} } as unknown as Milestone,
    `nodes at ${mount.at.nodes}ms; rows per pane ${alphaPaths.map((_, index) => mount.at[`rows${index}`]).join("/")}ms; requests ${describeRequests(mount.requests)}`);

  /* An in-app «Open conversation» link: every such button is a #c= anchor. */
  /* The click is dispatched the way a pointer does it — cancelable — and the
     browser's default (the hash navigation) is applied only when the app did
     not claim it, so the row can say which route the link took. */
  const link = (hash: string) => `const a = document.createElement("a"); a.href = ${js(hash)}; a.textContent = "open"; document.body.append(a); window.__linkInApp = !a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); a.remove(); if (!window.__linkInApp) location.hash = ${js(hash)}`;
  const inApp = () => cdp.evaluate<boolean>("window.__linkInApp === true").then((value) => (value ? "in-app yes" : "in-app no (hash navigation)"));
  const open = await measure(cdp, link(hashOf(short)), `p.ringed(${js(short.diskPath)})`, 20_000, { skeleton: "p.skeleton()" });
  record("desktop", "«Open conversation» link → target ringed", open, `${await inApp()}; skeleton ${open.seen.skeleton ? "shown" : "never"}; hash ${(await cdp.evaluate<string>("location.hash")).slice(0, 12)}…`);

  /* Project switch through the rail: first visit (cold board) and revisit. */
  const railClick = (label: string) => `Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim().startsWith(${js(label)})).click()`;
  const betaVisit = await measureEach(cdp, railClick("beta"), {
    rail: `p.rail().startsWith("beta")`,
    skeleton: `p.skeleton()`,
    nodes: `document.querySelectorAll('[data-scheme-node]').length >= ${betaPaths.length}`,
    ...Object.fromEntries(betaPaths.map((path, index) => [`rows${index}`, `p.rows(${js(path)}) > 0`])),
  });
  record("desktop", "project switch (first visit) → rail highlight", { ms: betaVisit.at.rail!, frames: "", seen: {} } as unknown as Milestone);
  record("desktop", "project switch (first visit) → cards painted (cold)", { ms: Math.max(...betaPaths.map((_, index) => betaVisit.at[`rows${index}`]!)), frames: "", seen: {} } as unknown as Milestone,
    `skeleton at ${betaVisit.at.skeleton}ms; nodes at ${betaVisit.at.nodes}ms; rows per pane ${betaPaths.map((_, index) => betaVisit.at[`rows${index}`]).join("/")}ms; requests ${describeRequests(betaVisit.requests)}`);
  const alphaRail = await measure(cdp, railClick("alpha"), `p.rail().startsWith("alpha")`);
  record("desktop", "project switch (revisit) → rail highlight", alphaRail);
  const alphaPaint = await measure(cdp, "", painted(alphaPaths), 30_000, { skeleton: "p.skeleton()" });
  record("desktop", "project switch (revisit) → cards painted from cache", alphaPaint, `skeleton ${alphaPaint.seen.skeleton ? "shown" : "never"}`);

  /* A cross-project link from alpha to beta's long conversation. */
  const cross = await measure(cdp, link(hashOf(betaB)), `p.rail().startsWith("beta")`, 20_000, { skeleton: "p.skeleton()" });
  record("desktop", "cross-project link → rail switched", cross, await inApp());
  const crossPaint = await measure(cdp, "", painted(betaPaths), 30_000, { skeleton: "p.skeleton()" });
  record("desktop", "cross-project link → beta cards painted from cache", crossPaint, `skeleton ${cross.seen.skeleton || crossPaint.seen.skeleton ? "shown" : "never"}`);
  const crossRing = await measure(cdp, "", `p.ringed(${js(betaB.diskPath)})`);
  record("desktop", "cross-project link → target ringed", crossRing);
  await measure(cdp, railClick("alpha"), painted(alphaPaths), 30_000);

  /* Keyboard: select a card, then ArrowRight to a neighbour. */
  const selectCard = (p: string) => `{ const n = document.querySelector('[data-scheme-node=${js(p)}]'); n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); }`;
  await measure(cdp, selectCard(short.diskPath), `p.ringed(${js(short.diskPath)})`);
  const arrow = await measure(cdp, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`, `!p.ringed(${js(short.diskPath)}) && (p.ringed(${js(long.diskPath)}) || p.ringed(${js(tools.diskPath)}))`);
  record("desktop", "ArrowRight → ring moves to the neighbour card", arrow);
  const clickFocus = await measure(cdp, selectCard(tools.diskPath), `p.ringed(${js(tools.diskPath)})`);
  record("desktop", "click on a card → ring moves", clickFocus);

  /* The tail moves on disk: scanner watch → stream → parse → paint. */
  const rowsBefore = await cdp.evaluate<number>(`window.__profile.rows(${js(short.diskPath)})`);
  /* Stashed on the page, never returned: CDP cannot serialise a DOM node. */
  await cdp.evaluate(`(window.__profileFirstRow = window.__profile.firstRow(${js(short.diskPath)})) !== undefined`);
  const appendedAt = Date.now();
  fs.appendFileSync(short.diskPath, appendedLine("alpha", 9_001, "desktop", cwdFor) + "\n");
  const fresh = await measure(cdp, "", `p.rows(${js(short.diskPath)}) > ${rowsBefore}`, 30_000);
  const preserved = await cdp.evaluate<boolean>(`window.__profile.firstRow(${js(short.diskPath)}) === window.__profileFirstRow`);
  record("desktop", "fresh tail record on disk → appended to the short card", { ...fresh, ms: Date.now() - appendedAt }, `first row node preserved ${preserved ? "yes" : "no"}`);

  /* A cold deep link from the URL. */
  await navigate(cdp, "about:blank");
  await navigate(cdp, `${origin}/${hashOf(betaA)}`);
  const cold = await cdp.evaluate<Milestone>(`(async () => { const p = window.__profile; const m = await p.until(() => p.rail().startsWith("beta") && p.rows(${js(betaA.diskPath)}) > 0, 60000); return { ms: Math.round(performance.now()), frames: m.frames, seen: {} }; })()`);
  record("desktop", "cold URL deep link → target project and card painted (since navigation start)", cold);
}

async function runPhone(cdp: Cdp, origin: string, seeded: Seeded[], catalog: Catalog): Promise<void> {
  const short = findSeeded(seeded, "alpha", "short");
  const long = findSeeded(seeded, "alpha", "long");
  const projectUrl = (name: string) => `${origin}/#p=${encodeURIComponent(catalog.keys[name] ?? name)}`;
  const titleOf = (entry: Seeded) => {
    const row = catalog.files.find((file) => file.path === entry.diskPath);
    if (!row) throw new Error(`scanner reported no row for ${entry.shape}`);
    return row.title;
  };
  /* The strip chip's title attribute is the cleaned title, capped at 60. */
  const chipTitle = (entry: Seeded) => `Array.from(document.querySelectorAll('button[title]')).find((b) => b.title.startsWith(${js(titleOf(entry).slice(0, 40))}))`;

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });

  await navigate(cdp, "about:blank");
  await navigate(cdp, projectUrl("alpha"));
  const mount = await cdp.evaluate<Milestone>(`(async () => { const p = window.__profile; const m = await p.until(() => p.focusedRows() > 0, 60000); return { ms: Math.round(performance.now()), frames: m.frames, seen: {} }; })()`);
  record("phone", "navigate → focused pane painted (cold, since navigation start)", mount, `focused ${await cdp.evaluate<string>("window.__profile.focusedPath()") === short.diskPath ? "short" : "other"}`);

  const tapChip = (entry: Seeded) => `${chipTitle(entry)}.click()`;
  const chipA = await measure(cdp, tapChip(short), `p.chipActive(${chipTitle(short)}.title) && p.focusedPath() === ${js(short.diskPath)}`);
  record("phone", "tap chip A (short) → chip highlighted and pane focused", chipA);
  const rowsA = await measure(cdp, "", `p.focusedPath() === ${js(short.diskPath)} && p.focusedRows() >= ${short.lines.length}`);
  record("phone", "tap chip A → A rows painted", rowsA);

  const chipB = await measure(cdp, tapChip(long), `p.focusedPath() === ${js(long.diskPath)}`);
  record("phone", "tap chip B (long, cold) → pane focused", chipB);
  const rowsB = await measure(cdp, "", `p.focusedPath() === ${js(long.diskPath)} && p.focusedRows() > 0`, 30_000);
  record("phone", "tap chip B (long, cold) → B rows painted", rowsB, `rows on screen ${await cdp.evaluate<number>("window.__profile.focusedRows()")}`);

  const back = await measure(cdp, tapChip(short), `p.focusedPath() === ${js(short.diskPath)} && p.focusedRows() > 0`);
  record("phone", "tap chip A again (cached) → A's previous rows on screen", back);

  await cdp.evaluate(`(window.__profileFirstRow = window.__profile.firstRow(${js(short.diskPath)})) !== undefined`);
  const rowsBefore = await cdp.evaluate<number>(`window.__profile.rows(${js(short.diskPath)})`);
  const appendedAt = Date.now();
  fs.appendFileSync(short.diskPath, appendedLine("alpha", 9_002, "phone", cwdFor) + "\n");
  const fresh = await measure(cdp, "", `p.rows(${js(short.diskPath)}) > ${rowsBefore}`, 30_000);
  const preserved = await cdp.evaluate<boolean>(`window.__profile.firstRow(${js(short.diskPath)}) === window.__profileFirstRow`);
  record("phone", "fresh tail record on disk → appended to A", { ...fresh, ms: Date.now() - appendedAt }, `first row node preserved ${preserved ? "yes" : "no"}`);

  /* Header swipe to the neighbour pane (synthetic touch sequence on the pane header). */
  const swipe = `{
    const header = document.querySelector('[data-testid="mobile-focused-pane"] header');
    const r = header.getBoundingClientRect();
    const touch = (x) => new Touch({ identifier: 1, target: header, clientX: x, clientY: r.top + r.height / 2 });
    header.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(r.left + 200)], changedTouches: [touch(r.left + 200)] }));
    header.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(r.left + 60)] }));
  }`;
  const before = await cdp.evaluate<string>("window.__profile.focusedPath()");
  const hop = await measure(cdp, swipe, `p.focusedPath() !== ${js(before)} && p.focusedRows() > 0`);
  record("phone", "header swipe → neighbour pane focused with cached rows", hop);

  /* Project switch through the drawer: first visit, then revisit. */
  const drawer = `document.querySelector('button[aria-label=${js(en["dash.openProjects"])}]').click()`;
  const railClick = (label: string) => `Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim().startsWith(${js(label)})).click()`;
  await cdp.evaluate(drawer);
  const toBeta = await measure(cdp, railClick("beta"), `${betaFocusedCheck(seeded)} && p.focusedRows() > 0`, 30_000, { skeleton: "p.skeleton()" });
  record("phone", "drawer project switch (first visit) → focused pane painted (cold)", toBeta, `skeleton ${toBeta.seen.skeleton ? "shown" : "never"}`);
  await cdp.evaluate(drawer);
  const backAlpha = await measure(cdp, railClick("alpha"), `${alphaFocusedCheck(seeded)} && p.focusedRows() > 0`, 30_000, { skeleton: "p.skeleton()" });
  record("phone", "drawer project switch (revisit) → focused pane painted from cache", backAlpha, `skeleton ${backAlpha.seen.skeleton ? "shown" : "never"}`);
}

function betaFocusedCheck(seeded: Seeded[]): string {
  const paths = seeded.filter((entry) => entry.project === "beta").map((entry) => entry.diskPath);
  return `[${paths.map((candidate) => js(candidate)).join(",")}].includes(p.focusedPath())`;
}
function alphaFocusedCheck(seeded: Seeded[]): string {
  const paths = seeded.filter((entry) => entry.project === "alpha").map((entry) => entry.diskPath);
  return `[${paths.map((candidate) => js(candidate)).join(",")}].includes(p.focusedPath())`;
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const seeded = seedHome();
  const env = buildEnvironment();
  const origin = `http://127.0.0.1:${PORT}`;
  const server = spawn(
    process.execPath,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(PORT)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs = outputLines(server);
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    console.log(`dev server starting on ${origin} under ${root}`);
    await waitForServer(`${origin}/api/files`, server, serverLogs);
    /* The scanner needs a moment to attribute the seeded transcripts. */
    let catalog: Catalog = { files: [], keys: {} };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      catalog = await scannedFiles(origin);
      if (seeded.every((entry) => catalog.files.some((file) => file.path === entry.diskPath)) && catalog.keys.alpha && catalog.keys.beta) break;
      await Bun.sleep(1_000);
    }
    const missing = seeded.filter((entry) => !catalog.files.some((file) => file.path === entry.diskPath));
    if (missing.length) throw new Error(`scanner never listed ${missing.map((entry) => entry.shape).join(", ")}\n${serverLogs()}`);
    console.log(`scanner lists ${catalog.files.length} transcripts`);
    if (DUMP) {
      const body = (await (await fetch(`${origin}/api/files`)).json()) as { files: Array<Record<string, unknown>>; projectCatalog: unknown; projectCwds: unknown };
      const redact = (value: unknown) => JSON.stringify(value).replaceAll(root, "<root>");
      for (const file of body.files) {
        console.log(redact(Object.fromEntries(["path", "project", "cwd", "projectRoot", "activity", "kind", "root", "title", "conversationId"].map((key) => [key, file[key]]))));
      }
      console.log("catalog", redact(body.projectCatalog));
      console.log("cwds", redact(body.projectCwds));
      return;
    }

    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(root, "chrome")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1280,800",
      "about:blank",
    ], { env: { ...process.env, HOME: root }, stdio: "ignore" });
    cdp = await Cdp.connect(await pageWebSocketUrl());
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    console.log("desktop 1280×800");
    await runDesktop(cdp, origin, seeded, catalog);
    console.log("phone 390×844");
    await runPhone(cdp, origin, seeded, catalog);

    const header = "| surface | step | real ms since gesture | frames | notes |\n|---|---|---:|---:|---|";
    const body = rows.map((row) => `| ${row.surface} | ${row.step} | ${row.ms} | ${row.frames} | ${row.notes} |`).join("\n");
    const table = `#1432 switching profile (real browser: headless Chrome, Next.js dev server, throwaway home)\n${header}\n${body}\n`;
    console.log(`\n${table}`);
    if (OUT) fs.writeFileSync(OUT, table);
  } finally {
    cdp?.close();
    await stop(chrome);
    await stop(server);
    if (SERVER_LOG) fs.writeFileSync(SERVER_LOG, serverLogs().replaceAll(root, "<root>"));
    if (KEEP) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
  process.exit(1);
});
