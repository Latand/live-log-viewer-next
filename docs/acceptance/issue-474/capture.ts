/**
 * Issue #474 visual acceptance capture — off-screen edge-agent chips.
 *
 * Boots the production build (`bun run build` first) against a disposable
 * deterministic fixture home and captures the edge-chip wayfinding surface
 * with puppeteer-core driving a cached chrome-headless-shell:
 *
 *   bun install && bun run build
 *   npx --yes @puppeteer/browsers install chrome-headless-shell@stable   # → LLV_474_CHS
 *   mkdir -p /tmp/llv-pptr && (cd /tmp/llv-pptr && bun add puppeteer-core@23.11.1)
 *   LLV_474_CHS=<shell> LLV_474_PPTR=/tmp/llv-pptr/node_modules \
 *     bun docs/acceptance/issue-474/capture.ts
 *
 * Fixture (created fresh under $TMPDIR/llv-issue-474-fixture on every run):
 *  - Five live claude conversations in project "atlas", each with a long,
 *    descriptive first user message so its chip label overflows the resting
 *    width. All mtimes are ~30s old so every conversation is current work and
 *    therefore an edge-navigation cluster.
 *
 * What the stills prove, in the real production build:
 *  - Desktop (1440×900): the operator is reading one conversation while the
 *    other current-work clusters sit off-screen. They surface in the
 *    "Off-screen work" navigation landmark, folded into a compact «+N» edge
 *    disclosure — the anti-overlap contract (issue #292): navigation chips
 *    never paint over open chat content. Expanding the disclosure reveals the
 *    labelled, click-to-fit list of off-screen conversations.
 *  - Mobile (390×844): the phone shell drops the scheme entirely, so no edge
 *    chip or navigation landmark renders.
 *
 * The reserved control box, continuous hover/focus surface, bounded
 * progressive reveal, keyboard full-reveal, and reduced-motion behaviour of an
 * individual *visible* chip are exercised deterministically by the DOM
 * interaction suite (src/components/scheme/EdgeChips.hover.dom.test.tsx, nine
 * tests): the demo board's auto-layout re-packs current-work clusters into a
 * compact row and clamps pan/zoom, so a single hovered visible chip cannot be
 * isolated in a headless still — the folded «+N» surface is what the real
 * board deterministically shows for off-screen work.
 *
 * Every assertion is mirrored to evidence.json; a failed assertion fails the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = path.resolve(import.meta.dir);
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PORT = Number(process.env.LLV_474_PORT ?? 3474);
const PPTR_DIR = process.env.LLV_474_PPTR ?? "/tmp/llv-pptr/node_modules";
const CHS = process.env.LLV_474_CHS;
if (!CHS || !fs.existsSync(CHS)) throw new Error("set LLV_474_CHS to a chrome-headless-shell binary");

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/* Titles only: a fresh session id is minted per run (randomUUID) so no
   identifier literal lives in this published harness — the disposable fixture
   home under $TMPDIR is the only place a concrete id is ever written. */
const CONVERSATION_TITLES = [
  "Deterministic capture pipeline — stage two builder verification pass",
  "Reasoning-effort meter reserved slot across every switchboard surface",
  "Off-screen edge navigation chips with bounded progressive hover reveal",
  "Minimap full world extent and viewport rectangle framing correctness",
  "In-place Claude login recovery for accounts stuck in the error state",
];

function buildFixtureHome(): string {
  const root = path.join(os.tmpdir(), "llv-issue-474-fixture");
  fs.rmSync(root, { recursive: true, force: true });
  const home = path.join(root, "home");
  const now = Date.now();
  const cwd = "/demo/Projects/atlas";
  const claudeDir = path.join(home, ".claude/projects/-demo-Projects-atlas");
  fs.mkdirSync(claudeDir, { recursive: true });
  const at = (offsetSec: number) => new Date(now - offsetSec * 1000).toISOString();

  CONVERSATION_TITLES.forEach((title, index) => {
    const file = path.join(claudeDir, `${randomUUID()}.jsonl`);
    fs.writeFileSync(
      file,
      jsonl([
        { type: "user", uuid: randomUUID(), timestamp: at(300 + index), cwd, message: { role: "user", content: title } },
        { type: "assistant", uuid: randomUUID(), timestamp: at(60 + index), cwd, message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Working on it — this conversation stays live so it anchors an edge chip." }] } },
      ]),
    );
    const mtime = new Date(now - 30_000 - index * 1000);
    fs.utimesSync(file, mtime, mtime);
  });

  const uid = process.getuid?.() ?? 1000;
  for (const dir of [".config/agent-log-viewer/state", ".cache", "tmp", path.join("tmp", `claude-${uid}`)]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  return home;
}

function serverEnv(home: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LLV_STATE_DIR: path.join(home, ".config/agent-log-viewer/state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

async function waitForServer(child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}\n${logs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/files`);
      if (response.ok) return;
    } catch {
      /* still booting */
    }
    await Bun.sleep(250);
  }
  throw new Error(`server did not become ready\n${logs()}`);
}

type Check = { id: string; detail: string };
const checks: Check[] = [];
function check(condition: boolean, id: string, detail: string): void {
  if (!condition) throw new Error(`FAILED ${id}: ${detail}`);
  checks.push({ id, detail });
  console.log(`  ok ${id}: ${detail}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- puppeteer-core is loaded
   from an out-of-repo install by absolute path, so its types aren't in scope. */
async function placeConversations(page: any): Promise<void> {
  for (let index = 0; index < CONVERSATION_TITLES.length; index += 1) {
    await page.evaluate((idx: number) => {
      let cards = document.querySelectorAll("article.reasoning-host");
      if (cards.length === 0) {
        const opener = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Open the agent switchboard");
        (opener as HTMLElement | undefined)?.click();
      }
      cards = document.querySelectorAll("article.reasoning-host");
      (cards[idx] as HTMLElement | undefined)?.click();
    }, index);
    await Bun.sleep(550);
  }
  // Ensure the switchboard modal is closed so the board (and its edge nav) shows.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(() => Boolean(document.querySelector('input[placeholder*="Search title"]')));
    if (!open) break;
    await page.keyboard.press("Escape");
    await Bun.sleep(200);
  }
}

async function main(): Promise<void> {
  const home = buildFixtureHome();
  console.log(`fixture home: ${home}`);

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: REPO_ROOT,
    env: serverEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  server.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  server.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const logs = () => chunks.join("").slice(-8000);

  const { default: puppeteer } = await import(pathToFileURL(path.join(PPTR_DIR, "puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")).href);
  const browser = await puppeteer.launch({ executablePath: CHS, args: ["--no-sandbox", "--force-color-profile=srgb"] });
  try {
    await waitForServer(server, logs);
    const base = `http://127.0.0.1:${PORT}/`;
    const noAnim = `*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }`;

    /* 1) Desktop: read one conversation while the rest sit off-screen and fold
          into the "Off-screen work" navigation landmark. */
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.emulateTimezone("UTC");
      await page.goto(`${base}#p=atlas`, { waitUntil: "networkidle2", timeout: 60_000 });
      await page.addStyleTag({ content: noAnim });
      await placeConversations(page);

      await page.waitForFunction(() => Boolean(document.querySelector('nav[aria-label="Off-screen work"]')), { timeout: 30_000 });
      const nav = await page.evaluate(() => {
        const el = document.querySelector('nav[aria-label="Off-screen work"]') as HTMLElement;
        const triggers = Array.from(el.querySelectorAll("button")).filter((b) => /^\+\d+$/.test((b.textContent || "").trim()));
        const visible = document.querySelectorAll("[data-edge-chip]").length;
        return {
          pointerEvents: getComputedStyle(el).pointerEvents,
          triggerCount: triggers.length,
          firstTrigger: triggers[0]?.textContent?.trim() ?? null,
          firstTriggerAria: triggers[0]?.getAttribute("aria-label") ?? null,
          firstTriggerExpanded: triggers[0]?.getAttribute("aria-expanded") ?? null,
          visible,
          offscreen: triggers.reduce((sum, t) => sum + Number((t.textContent || "+0").replace("+", "")), 0),
        };
      });
      check(nav.pointerEvents === "none", "desktop-nav-cannot-block-content", `the off-screen navigation landmark is pointer-events:${nav.pointerEvents} — only its chips take pointer input, never covering chat content (issue #292)`);
      check(nav.triggerCount >= 1, "desktop-offscreen-disclosure", `${nav.triggerCount} «+N» edge disclosure(s) present for ${nav.offscreen} off-screen current-work cluster(s)`);
      check(/^\+\d+$/.test(nav.firstTrigger ?? ""), "desktop-disclosure-count", `the edge disclosure shows its folded count "${nav.firstTrigger}"`);
      check((nav.firstTriggerAria ?? "").length > 0 && nav.firstTriggerExpanded === "false", "desktop-disclosure-a11y", `the disclosure is a collapsed, labelled control (aria-label "${nav.firstTriggerAria}", aria-expanded ${nav.firstTriggerExpanded})`);
      await page.screenshot({ path: path.join(OUT_DIR, "desktop-1440-offscreen-edge-nav.png") });
      console.log("  shot desktop-1440-offscreen-edge-nav.png");

      // Expand the disclosure: the labelled, click-to-fit off-screen list.
      await page.evaluate(() => {
        const el = document.querySelector('nav[aria-label="Off-screen work"]') as HTMLElement;
        const trigger = Array.from(el.querySelectorAll("button")).find((b) => /^\+\d+$/.test((b.textContent || "").trim()));
        (trigger as HTMLElement | undefined)?.click();
      });
      await page.waitForFunction(() => document.querySelectorAll("[data-overflow-chip]").length > 0, { timeout: 10_000 });
      const list = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("[data-overflow-chip]"));
        return {
          count: items.length,
          allButtons: items.every((i) => i.tagName === "BUTTON"),
          labels: items.map((i) => (i.textContent || "").trim()),
          expanded: document.querySelector('nav[aria-label="Off-screen work"] button[aria-expanded="true"]') !== null,
        };
      });
      check(list.count >= 1 && list.allButtons, "desktop-offscreen-list", `expanding reveals ${list.count} click-to-fit off-screen conversation button(s)`);
      check(list.labels.every((l: string) => l.length > 0), "desktop-offscreen-labels", `every off-screen entry carries its conversation label (${JSON.stringify(list.labels)})`);
      check(list.expanded, "desktop-disclosure-expands", "the disclosure reports aria-expanded=true once opened");
      await page.screenshot({ path: path.join(OUT_DIR, "desktop-1440-offscreen-edge-nav-expanded.png") });
      console.log("  shot desktop-1440-offscreen-edge-nav-expanded.png");
      await page.close();
    }

    /* 2) 390px: the phone shell drops the scheme, so no edge chip or landmark. */
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.emulateTimezone("UTC");
      await page.goto(`${base}#p=atlas`, { waitUntil: "networkidle2", timeout: 60_000 });
      await page.addStyleTag({ content: noAnim });
      await Bun.sleep(800);
      const mobile = await page.evaluate(() => ({
        chips: document.querySelectorAll("[data-edge-chip]").length,
        nav: Boolean(document.querySelector('nav[aria-label="Off-screen work"]')),
      }));
      check(mobile.chips === 0, "mobile-chips-removed", `no edge chip renders on the 390px shell (found ${mobile.chips})`);
      check(!mobile.nav, "mobile-nav-removed", "the off-screen navigation landmark is absent on the phone width");
      await page.screenshot({ path: path.join(OUT_DIR, "mobile-390-no-edge-chips.png") });
      console.log("  shot mobile-390-no-edge-chips.png");
      await page.close();
    }

    fs.writeFileSync(
      path.join(OUT_DIR, "evidence.json"),
      JSON.stringify({
        issue: 474,
        capturedAt: new Date().toISOString(),
        viewer: "production next start",
        viewport: { desktop: "1440x900", mobile: "390x844" },
        interactionSuite: "src/components/scheme/EdgeChips.hover.dom.test.tsx (9 tests: continuous surface, reserved control box, bounded progressive reveal, keyboard full-reveal, reduced motion, click fit, coarse-pointer removal)",
        checks,
      }, null, 2) + "\n",
    );
    console.log(`all ${checks.length} checks passed`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await Bun.sleep(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
}

await main();
