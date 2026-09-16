/**
 * Kanban board update-stall and scroll profile (issue #1546).
 *
 * Usage: bun scripts/profile-kanban-board.ts <source-root> <output-dir> [idle-seconds]
 *
 * Bundles the REAL board over `issue1695Evidence.fixture.tsx`, scaled to the
 * shape #1546 reported (hundreds of flows, files and tasks — all invented), and
 * serves it on an ephemeral loopback port. Every API and stream response
 * terminates in the fixture, so this measures the browser's own work: no live
 * state, no deployed server, no operator data.
 *
 * Two samples, written to `<output-dir>/results.json`:
 *
 * - `idle`  — the operator is not touching the board while data keeps arriving.
 *             Catalog updates are dispatched on a fixed cadence for the whole
 *             window; long tasks, frame intervals and a CPU profile are kept.
 * - `scroll`— 80 wheel events down the Assigned column with the data frozen.
 *             Sampled script time, React commits and frame intervals are kept.
 *
 * Both halves run against whatever source tree they are pointed at, so a
 * before/after pair is one checkout apart and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const repo = path.resolve(process.argv[2] ?? ".");
const out = path.resolve(process.argv[3] ?? ".artifacts/performance/kanban");
const idleSeconds = Number(process.argv[4] ?? 35);
fs.mkdirSync(out, { recursive: true });

/* The fixture, scaled up. The added corpus is entirely invented: numbered
   historical builders, their review rounds and their finished tasks. */
let fixture = fs.readFileSync(path.join(repo, "src/components/kanban/issue1695Evidence.fixture.tsx"), "utf8");
fixture = fixture.replace('const PIPELINES = SCENARIO === "pipelines" || STAGES;', "const PIPELINES = true;");
fixture = fixture.replace("let revision = 1;", `
for (let i = 0; i < 280; i++) {
  const builder = add(conversation('history-builder-' + i, 'Historical work ' + i));
  const reviewers = [0, 1].map(j => add(conversation('history-review-' + i + '-' + j, 'Historical review ' + i)));
  const flow = reviewFlow('history-flow-' + i, builder, reviewers[1], ['REQUEST_CHANGES', 'REQUEST_CHANGES', 'REQUEST_CHANGES', 'APPROVE'], 100000);
  flow.state = 'closed';
  flows.push(flow);
}
let revision = 1;`);
fixture = fixture.replace("if (EDITING) {\n  const at", `
for (let i = 0; i < 600; i++) tasks.push(task('history-task-' + i, 'done', 'Historical task ' + i, 'Synthetic acceptance notes. '.repeat(12), 100000, i < 60 ? [files.find(f => f.name === 'history-builder-' + i + '.jsonl')] : [], i < 60 ? {} : { board: 'hidden' }));
if (EDITING) {\n  const at`);
/* The driver's handles: corpus size, one catalog update, and React commits. */
fixture = fixture.replace("Object.assign(window, { evidence });", `Object.assign(window, { evidence,
  profileCorpus: { files: files.length, flows: flows.length, tasks: tasks.length },
  profileUpdate: () => { files[0] = { ...files[0], mtime: files[0].mtime + 1, size: files[0].size + 1 }; window.dispatchEvent(new Event('llv:files-changed')); },
});`);

/* The bundle entry lives inside the tree being measured: `react` has to
   resolve to the SAME copy for the fixture and for the components it imports,
   or the board mounts against a null dispatcher. */
const stage = path.join(repo, ".artifacts/profile-kanban");
fs.mkdirSync(stage, { recursive: true });
const fixturePath = path.join(stage, "fixture.tsx");
fs.writeFileSync(fixturePath, fixture);
/* Unminified, so the CPU profile names the functions the issue is about. */
const build = Bun.spawnSync([
  process.execPath, "build", fixturePath, "--target=browser", `--outdir=${stage}/bundle`,
  "--define", 'process.env.NODE_ENV="production"', "--define", "process.env={}",
  `--tsconfig-override=${repo}/tsconfig.json`,
], { cwd: repo, stdout: "pipe", stderr: "pipe" });
if (build.exitCode) throw new Error(build.stderr.toString() + build.stdout.toString());

const cssPath = path.join(repo, "src/app/globals.css");
const css = await postcss([tailwind()]).process(fs.readFileSync(cssPath, "utf8"), { from: cssPath });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/app.js") return new Response(Bun.file(path.join(stage, "bundle/fixture.js")), { headers: { "content-type": "text/javascript" } });
  if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
  return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>', { headers: { "content-type": "text/html" } });
} });

interface Sampled { longTasks: { at: number; ms: number }[]; frames: number[] }

const summarize = (sample: Sampled, windowMs: number) => ({
  windowMs: Math.round(windowMs),
  longTasks: sample.longTasks.length,
  longTaskTotalMs: Math.round(sample.longTasks.reduce((a, b) => a + b.ms, 0)),
  longTaskMaxMs: Math.round(Math.max(0, ...sample.longTasks.map((entry) => entry.ms))),
  frames: sample.frames.length,
  framesOver25: sample.frames.filter((ms) => ms > 25).length,
  frameMaxMs: Math.round(Math.max(0, ...sample.frames)),
  frameP95Ms: Number(percentile(sample.frames, 95).toFixed(1)),
});

const rounded = (value: { scriptMs: number; jsMs: number }) => ({ scriptMs: Math.round(value.scriptMs), jsMs: Math.round(value.jsMs) });

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

interface CpuProfile { nodes: { id: number; callFrame: { functionName: string } }[]; samples: number[]; timeDeltas: number[] }

/** Sampled work that is not `(idle)`: `scriptMs` is everything the main thread
    did, `jsMs` drops `(program)` — V8's own parse/compile/compositor bookkeeping,
    which moves independently of the code under test. */
function sampledMs(profile: CpuProfile): { scriptMs: number; jsMs: number } {
  const named = (name: string) => new Set(profile.nodes.filter((node) => node.callFrame.functionName === name).map((node) => node.id));
  const idle = named("(idle)");
  const program = named("(program)");
  let script = 0;
  let js = 0;
  for (const [index, id] of profile.samples.entries()) {
    if (idle.has(id)) continue;
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    script += ms;
    if (!program.has(id)) js += ms;
  }
  return { scriptMs: script, jsMs: js };
}

/** Self time of one function in a sampled profile — the attribution #1546 asked
    for, reported by name so a reader can check it against the source. */
function selfMs(profile: CpuProfile, functionName: string): number {
  const ids = new Set(profile.nodes.filter((node) => node.callFrame.functionName === functionName).map((node) => node.id));
  let total = 0;
  for (const [index, id] of profile.samples.entries()) if (ids.has(id)) total += (profile.timeDeltas[index] ?? 0) / 1000;
  return total;
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable" });
const results: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const sample = { longTasks: [] as unknown[], frames: [] as number[], commits: 0, recording: false };
    w.profileSample = sample;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (sample.recording) sample.longTasks.push({ at: entry.startTime, ms: entry.duration }); }).observe({ type: "longtask", buffered: true });
    let previous = 0;
    const tick = (now: number) => { if (sample.recording && previous) sample.frames.push(now - previous); previous = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    /* React publishes every commit through the devtools hook; a board render
       is always one of these, so counting them never undercounts. */
    (w as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: () => { if (sample.recording) sample.commits++; },
      onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.port}/?scenario=pipelines`);
  try {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { timeout: 60_000 });
  } catch (error) {
    throw new Error(`the board never rendered a card: ${pageErrors.join(" | ") || "no page error"}`, { cause: error });
  }
  await page.waitForTimeout(3_000);
  const corpus = await page.evaluate(() => ({
    ...(window as unknown as { profileCorpus: unknown }).profileCorpus as object,
    cards: document.querySelectorAll("[data-kanban-board] .card[data-id]").length,
    dom: document.querySelectorAll("*").length,
  }));

  const start = () => page.evaluate(() => {
    const s = (window as unknown as { profileSample: { longTasks: unknown[]; frames: number[]; commits: number; recording: boolean; at?: number } }).profileSample;
    s.longTasks.length = 0; s.frames.length = 0; s.commits = 0; s.at = performance.now(); s.recording = true;
  });
  const stop = () => page.evaluate(() => {
    const s = (window as unknown as { profileSample: { longTasks: unknown[]; frames: number[]; commits: number; recording: boolean; at: number } }).profileSample;
    s.recording = false;
    return { longTasks: s.longTasks as { at: number; ms: number }[], frames: s.frames, commits: s.commits, windowMs: performance.now() - s.at };
  });

  /* ── idle: no input, data still arriving ───────────────────────────── */
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await start();
  await page.evaluate(() => { (window as unknown as { profileTimer: number }).profileTimer = window.setInterval(() => (window as unknown as { profileUpdate: () => void }).profileUpdate(), 500); });
  await page.waitForTimeout(idleSeconds * 1_000);
  await page.evaluate(() => window.clearInterval((window as unknown as { profileTimer: number }).profileTimer));
  const idle = await stop();
  const idleProfile = (await cdp.send("Profiler.stop")).profile;
  fs.writeFileSync(path.join(out, "idle-cpu.json"), JSON.stringify(idleProfile));
  results.idle = {
    ...summarize(idle, idle.windowMs), commits: idle.commits,
    ...rounded(sampledMs(idleProfile as never)),
    /* The grouping scan #1546 measured, named. */
    flowMembershipSelfMs: Math.round(selfMs(idleProfile as never, "flowMembership")),
    getBoundingClientRectSelfMs: Math.round(selfMs(idleProfile as never, "getBoundingClientRect")),
  };

  /* ── still: the same window with no input, so the commits and the script
     time a GESTURE is answerable for are what it costs above this. ──────── */
  await cdp.send("Profiler.start");
  await start();
  await page.waitForTimeout(2_700);
  const still = await stop();
  const stillProfile = (await cdp.send("Profiler.stop")).profile;
  results.still = { ...summarize(still, still.windowMs), commits: still.commits, ...rounded(sampledMs(stillProfile as never)) };

  /* ── scroll: 80 wheel events, data frozen ──────────────────────────── */
  const box = await page.locator('.column[data-status="assigned"] .col-body').first().boundingBox();
  if (!box) throw new Error("the Assigned column has no scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await cdp.send("Profiler.start");
  await start();
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(16);
  }
  const scroll = await stop();
  const scrollProfile = (await cdp.send("Profiler.stop")).profile;
  fs.writeFileSync(path.join(out, "scroll-cpu.json"), JSON.stringify(scrollProfile));
  /* Presence after the gesture: what the board reports must be what is on
     screen, whatever schedule the measurement runs on. */
  await page.waitForTimeout(1_500);
  const presence = await page.evaluate(() => {
    const posts = (window as unknown as { evidence: { presence: Array<{ visiblePaths: string[] }> } }).evidence.presence;
    const last = posts[posts.length - 1] ?? null;
    const tiles = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .tile[data-member]")].map((tile) => {
      const card = tile.closest<HTMLElement>(".card")!;
      const body = card.closest<HTMLElement>(".col-body")!.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      const onScreen = rect.bottom > body.top && rect.top < body.bottom && getComputedStyle(card.closest(".column")!).display !== "none";
      return { path: tile.dataset.member!, onScreen, reported: Boolean(last?.visiblePaths.includes(tile.dataset.member!)) };
    });
    return { posts: posts.length, tiles: tiles.length, mismatched: tiles.filter((tile) => tile.onScreen !== tile.reported) };
  });
  results.scroll = {
    ...summarize(scroll, scroll.windowMs), commits: scroll.commits,
    ...rounded(sampledMs(scrollProfile as never)),
    getBoundingClientRectSelfMs: Math.round(selfMs(scrollProfile as never, "getBoundingClientRect")),
    presence,
  };
  results.corpus = corpus;
  results.pageErrors = pageErrors;
  fs.writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
