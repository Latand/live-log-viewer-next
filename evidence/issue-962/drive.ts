/**
 * Real-browser evidence for issue #962 — the depth ladder: filled container
 * wells, deeper dark scheme canvas, zoom-sparse dot grid, quiet-card tone.
 *
 *   bun evidence/issue-962/drive.ts
 *
 * PRODUCTION-SHAPED, exactly like the issue-884 driver it extends: builds the
 * EXACT current head (`next build --webpack`), serves it with `next start`
 * over the ISOLATED demo runtime (fixtures/demo-home + its own LLV_STATE_DIR;
 * never the operator's viewer state, never ports 8898/8899), and drives real
 * headless host Chrome over raw CDP. Every pipeline/board fixture is SYNTHETIC
 * and generated at runtime into the disposable capture home (seeds.ts).
 *
 * What the checks prove (issue #962 acceptance):
 *  - a settled pipeline container renders as a faint FILLED well: solid
 *    hairline (1px) border + well-surface fill, in light AND dark;
 *  - the flow (branch-group) container takes the same well treatment;
 *  - a draft pipeline keeps its DASHED halo — dashed stays a draft affordance;
 *  - the dot grid is confined to the scheme canvas and its on-screen spacing
 *    never collapses below the sparse floor while zooming out;
 *  - the scheme canvas is deeper than the app canvas in dark mode only;
 *  - an inactive card takes the quiet surface; the NEEDS-YOU (waiting) card
 *    and a selected card keep their full treatments;
 *  - an empty project renders the bare canvas + grid with zero cards.
 *
 * Output: evidence/issue-962/depth-ladder.json (booleans + colors only) and
 * screenshots of the rendered states. No absolute paths, no identities.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bootstrapDemoRuntime, claudePath, demoPort, renderFixtureTemplate } from "../../scripts/demo-capture";
import { BEACON_SESSIONS, seedEmptyProject, seedPipelines } from "./seeds";

const CHROME = process.env.LLV_EVIDENCE_CHROME || "/usr/bin/google-chrome-stable";
const CDP_PORT = 9347;

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

/* ── Page probes (self-contained expressions, evaluated in the app) ─────── */

/** Region fill/border of the FIRST matching group's halo region div. */
const regionProbe = (selector: string) => `(() => {
  const wrap = document.querySelector('${selector}');
  if (!wrap) return null;
  const region = wrap.firstElementChild;
  const cs = getComputedStyle(region);
  return {
    borderStyle: cs.borderTopStyle,
    borderWidth: cs.borderTopWidth,
    background: cs.backgroundColor,
    inlineStyle: region.getAttribute("style") || "",
  };
})()`;

const GRID = `document.querySelector('[data-scheme-grid]')`;

const gridProbe = `(() => {
  const grid = ${GRID};
  if (!grid) return null;
  const board = grid.parentElement;
  const size = parseFloat((getComputedStyle(grid).backgroundSize.split(" ")[0] || "0").replace("px", ""));
  return { tile: size, boardBg: getComputedStyle(board).backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor };
})()`;

/** The quiet card's computed body fill, if any inactive card is on the board. */
const quietProbe = `(() => {
  const section = document.querySelector('section[data-link-path][class*="bg-quiet"]');
  if (!section) return null;
  return { background: getComputedStyle(section).backgroundColor };
})()`;

async function openProject(tab: Cdp, baseUrl: string, project: string, ready: string, label: string): Promise<void> {
  await tab.send("Page.navigate", { url: `${baseUrl}/#p=${encodeURIComponent(project)}` });
  await poll(tab, ready, label, 120_000);
  /* Let the camera glide + entry fades settle so shots are stable. */
  await sleep(1_200);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const port = demoPort(process.env.LLV_EVIDENCE_PORT, 3071, "LLV_EVIDENCE_PORT");
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
  let chrome: ChildProcess | null = null;
  let prodServer: ChildProcess | null = null;
  try {
    const home = runtime.env.HOME!;
    /* Seed BEFORE any server request touches the pipeline store, so the JSON
       registries migrate into the fresh capture-state SQLite on first read. */
    seedPipelines(home);
    seedEmptyProject(home);
    /* One inactive beacon conversation: an mtime hours in the past (relative
       to the REAL clock the server runs on) reads as done — the quiet card. */
    const quietPath = renderFixtureTemplate(claudePath("beacon", BEACON_SESSIONS.spare), home);
    const stale = new Date(Date.now() - 6 * 3600 * 1000);
    fs.utimesSync(quietPath, stale, stale);

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
      return cdp;
    };
    const setScheme = (tab: Cdp, value: "light" | "dark") =>
      tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });

    const PIPELINE_WELL = `[data-scheme-group="pipeline"]:not([data-pipeline-draft])`;
    const DRAFT_HALO = `[data-scheme-group="pipeline"][data-pipeline-draft]`;
    const FLOW_WELL = `[data-scheme-group="flow"]`;

    /* ── Desktop, LIGHT ───────────────────────────────────────────────── */
    const tab = await newTarget();
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await setScheme(tab, "light");

    /* Beacon: dense board — settled pipeline well + dashed draft halo. */
    await openProject(tab, baseUrl, "beacon", `!!document.querySelector('${PIPELINE_WELL}') && !!document.querySelector('${DRAFT_HALO}')`, "beacon board with both pipeline halos");
    const wellLight = await tab.eval<{ borderStyle: string; borderWidth: string; background: string; inlineStyle: string } | null>(regionProbe(PIPELINE_WELL));
    expect("light: a settled pipeline container is a filled well — 1px solid hairline + well-surface fill",
      !!wellLight && wellLight.borderStyle === "solid" && wellLight.borderWidth === "1px"
        && wellLight.inlineStyle.includes("var(--surface-well)") && wellLight.background.startsWith("rgb"),
      wellLight);
    const draftLight = await tab.eval<{ borderStyle: string; borderWidth: string } | null>(regionProbe(DRAFT_HALO));
    expect("light: a draft pipeline keeps the dashed 2px halo — dashed stays a draft/drop affordance",
      !!draftLight && draftLight.borderStyle === "dashed" && draftLight.borderWidth === "2px",
      draftLight);
    const gridLight = await tab.eval<{ tile: number; boardBg: string; bodyBg: string } | null>(gridProbe);
    expect("light: the dot grid lives on the scheme canvas and the board matches the app canvas (rgb(243, 243, 246))",
      !!gridLight && gridLight.tile >= 18 && gridLight.boardBg === "rgb(243, 243, 246)" && gridLight.bodyBg === "rgb(243, 243, 246)",
      gridLight);
    const quietLight = await tab.eval<{ background: string } | null>(quietProbe);
    expect("light: an inactive card takes the quiet surface (rgb(250, 250, 251))",
      !!quietLight && quietLight.background === "rgb(250, 250, 251)",
      quietLight);
    await tab.screenshot("desktop-light-beacon-wells.png");

    /* Zoom out: the grid's on-screen spacing never drops below the floor. */
    const tiles: number[] = [gridLight?.tile ?? 0];
    for (let i = 0; i < 6; i += 1) {
      await tab.eval(`(() => { const b = document.querySelector('button[title^="Zoom out"]'); b && b.click(); return true; })()`);
      await sleep(150);
      const probe = await tab.eval<{ tile: number } | null>(gridProbe);
      tiles.push(probe?.tile ?? 0);
    }
    expect("the dot grid stays sparse across zoom-out steps (every on-screen tile ≥ 18px)",
      tiles.every((tile) => tile >= 18), tiles);
    await tab.screenshot("desktop-light-beacon-zoomed-out.png");
    await tab.eval(`(() => { const b = document.querySelector('button[title^="Zoom 100"]'); b && b.click(); return true; })()`);
    await sleep(600);

    /* Selected card: the member tint + check, over the new well. */
    const marked = await tab.eval<boolean>(`(() => {
      const check = document.querySelector('[data-scheme-node] .scheme-select-check');
      if (!check) return false;
      check.click();
      return true;
    })()`);
    await poll(tab, `!!document.querySelector('[data-lasso-selected="true"]')`, "selection session engaged", 10_000);
    expect("a selected card keeps its full selection treatment on the dense board", marked);
    await tab.screenshot("desktop-light-beacon-selected.png");
    await tab.eval(`(() => { const check = document.querySelector('[data-lasso-selected="true"] .scheme-select-check'); check && check.click(); return true; })()`);

    /* Forge: the flow (branch-group) container takes the same well. */
    await openProject(tab, baseUrl, "forge", `!!document.querySelector('${FLOW_WELL}')`, "forge flow group");
    const flowLight = await tab.eval<{ borderStyle: string; borderWidth: string; inlineStyle: string } | null>(regionProbe(FLOW_WELL));
    expect("light: the branch/flow container renders as the same filled hairline well",
      !!flowLight && flowLight.borderStyle === "solid" && flowLight.borderWidth === "1px" && flowLight.inlineStyle.includes("var(--surface-well)"),
      flowLight);
    await tab.screenshot("desktop-light-forge-branch-group.png");

    /* Atlas: the NEEDS-YOU card (pending question) keeps its attention glow. */
    await openProject(tab, baseUrl, "atlas", `!!document.querySelector('.pane-attention')`, "atlas NEEDS-YOU card");
    const needsYou = await tab.eval<{ glow: boolean; quiet: boolean }>(`(() => {
      const pane = document.querySelector('.pane-attention');
      return { glow: !!pane, quiet: !!pane.querySelector('section[class*="bg-quiet"]') };
    })()`);
    expect("the NEEDS-YOU card keeps its full attention treatment and never takes the quiet tone",
      needsYou.glow && !needsYou.quiet, needsYou);
    await tab.screenshot("desktop-light-atlas-needs-you.png");

    /* Ember: an empty project — bare canvas, dot grid, zero cards. */
    await openProject(tab, baseUrl, "ember", `!!${GRID}`, "ember empty project");
    const empty = await tab.eval<{ nodes: number; grid: boolean }>(`({
      nodes: document.querySelectorAll('[data-scheme-node]').length,
      grid: !!${GRID},
    })`);
    expect("an empty project renders the bare scheme canvas with the dot grid and zero cards",
      empty.nodes === 0 && empty.grid, empty);
    await tab.screenshot("desktop-light-empty-project.png");

    /* ── Desktop, DARK ────────────────────────────────────────────────── */
    await setScheme(tab, "dark");
    await openProject(tab, baseUrl, "beacon", `!!document.querySelector('${PIPELINE_WELL}')`, "beacon dark");
    const gridDark = await tab.eval<{ tile: number; boardBg: string; bodyBg: string } | null>(gridProbe);
    expect("dark: the scheme canvas (rgb(13, 13, 17)) dips deeper than the app canvas (rgb(16, 16, 20))",
      !!gridDark && gridDark.boardBg === "rgb(13, 13, 17)" && gridDark.bodyBg === "rgb(16, 16, 20)",
      gridDark);
    const wellDark = await tab.eval<{ borderStyle: string; borderWidth: string; background: string } | null>(regionProbe(PIPELINE_WELL));
    expect("dark: the settled pipeline well keeps the 1px hairline + filled treatment",
      !!wellDark && wellDark.borderStyle === "solid" && wellDark.borderWidth === "1px" && wellDark.background.startsWith("rgb"),
      wellDark);
    const quietDark = await tab.eval<{ background: string } | null>(quietProbe);
    expect("dark: the inactive card takes the dark quiet surface (rgb(20, 20, 25))",
      !!quietDark && quietDark.background === "rgb(20, 20, 25)",
      quietDark);
    await tab.screenshot("desktop-dark-beacon-wells.png");

    await openProject(tab, baseUrl, "forge", `!!document.querySelector('${FLOW_WELL}')`, "forge dark");
    await tab.screenshot("desktop-dark-forge-branch-group.png");
    await openProject(tab, baseUrl, "atlas", `!!document.querySelector('.pane-attention')`, "atlas dark");
    await tab.screenshot("desktop-dark-atlas-needs-you.png");
    tab.close();

    /* ── 390 px mobile, light + dark ──────────────────────────────────── */
    const mob = await newTarget();
    await mob.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await mob.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await setScheme(mob, "light");
    await openProject(mob, baseUrl, "beacon", `!!${GRID}`, "beacon 390px light");
    const mobile = await mob.eval<{ grid: boolean; tile: number }>(`(() => {
      const grid = ${GRID};
      const size = grid ? parseFloat((getComputedStyle(grid).backgroundSize.split(" ")[0] || "0").replace("px", "")) : 0;
      return { grid: !!grid, tile: size };
    })()`);
    expect("390px: the scheme canvas keeps the sparse grid", mobile.grid && mobile.tile >= 18, mobile);
    await mob.screenshot("mobile-light-beacon.png");
    await setScheme(mob, "dark");
    await sleep(600);
    await mob.screenshot("mobile-dark-beacon.png");
    mob.close();

    const failed = checks.filter((check) => !check.pass);
    const output = {
      issue: 962,
      capturedAt: new Date().toISOString(),
      buildHead,
      runner: "exact-head production build served by `next start` over the isolated demo runtime (fixtures/demo-home); synthetic runtime-generated pipeline/board fixtures; headless host Chrome over raw CDP",
      screenshots: [
        "desktop-light-beacon-wells.png", "desktop-light-beacon-zoomed-out.png",
        "desktop-light-beacon-selected.png", "desktop-light-forge-branch-group.png",
        "desktop-light-atlas-needs-you.png", "desktop-light-empty-project.png",
        "desktop-dark-beacon-wells.png", "desktop-dark-forge-branch-group.png",
        "desktop-dark-atlas-needs-you.png",
        "mobile-light-beacon.png", "mobile-dark-beacon.png",
      ],
      checks,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    fs.writeFileSync(
      path.join(import.meta.dir, "depth-ladder.json"),
      (JSON.stringify(output, null, 2) + "\n")
        .replaceAll(repoRoot, "<repo>")
        .replaceAll(runtime.root, "<capture>")
        .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1-x"),
    );
    console.log(`\n${output.verdict}: ${checks.length - failed.length}/${checks.length} checks`);
    if (failed.length) process.exitCode = 1;
  } finally {
    chrome?.kill("SIGKILL");
    prodServer?.kill("SIGTERM");
    await runtime.shutdown();
  }
}

await main();
