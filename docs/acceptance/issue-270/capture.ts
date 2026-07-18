/**
 * Issue #270 visual acceptance capture.
 *
 * Boots the production build (`bun run build` first) against a disposable
 * deterministic fixture home and captures the reasoning-meter surfaces with
 * Playwright driving its cached chromium:
 *
 *   bun install && bun run build
 *   mkdir -p /tmp/llv-pw && (cd /tmp/llv-pw && bun add playwright@1.61.1)
 *   bun docs/acceptance/issue-270/capture.ts
 *
 * Fixture (created fresh under $TMPDIR/llv-issue-270-fixture on every run):
 *  - claude session "atlas" with model claude-opus-4-8 + a thinking block →
 *    model "opus-4-8", effort "high" (meter visible, in-flow).
 *  - codex session with a turn_context that records effort "low" and NO model
 *    → the model=null engine-badge fallback from the #270 review finding.
 * The claude session's mtime is ~2 minutes old (large 300px switch card, the
 * meter renders); the codex session is ~1 hour old (small 220px switch card,
 * the meter collapses below the 260px reasoning-host threshold).
 *
 * Alongside the PNGs the run asserts the DOM contract (in-flow slot classes,
 * container-query collapse via computed style, fallback-badge tooltips) and
 * writes the results to evidence.json; any failed assertion fails the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = path.resolve(import.meta.dir);
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PORT = Number(process.env.LLV_270_PORT ?? 3272);
const PLAYWRIGHT_DIR = process.env.LLV_PLAYWRIGHT_DIR ?? "/tmp/llv-pw/node_modules";

const CLAUDE_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CODEX_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function buildFixtureHome(): { home: string; claudePath: string; codexPath: string } {
  const root = path.join(os.tmpdir(), "llv-issue-270-fixture");
  fs.rmSync(root, { recursive: true, force: true });
  const home = path.join(root, "home");
  const now = Date.now();
  const cwd = "/demo/Projects/atlas";

  const claudeDir = path.join(home, ".claude/projects/-demo-Projects-atlas");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, `${CLAUDE_SESSION}.jsonl`);
  const at = (offsetSec: number) => new Date(now - offsetSec * 1000).toISOString();
  fs.writeFileSync(
    claudePath,
    jsonl([
      { type: "user", uuid: "a0000000-0000-4000-8000-000000000001", timestamp: at(300), cwd, message: { role: "user", content: "Verify the reasoning meter keeps its reserved in-flow slot on every surface." } },
      { type: "assistant", uuid: "a0000000-0000-4000-8000-000000000002", timestamp: at(240), cwd, message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "thinking", thinking: "Check the header row, the switch cards, and the 390px focus view." }, { type: "text", text: "I will open each surface and confirm the meter is a plain flex item beside the model chip." }] } },
      { type: "assistant", uuid: "a0000000-0000-4000-8000-000000000003", timestamp: at(120), cwd, message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "The meter occupies its reserved slot and wraps with the row — no overlay, no paint transform." }] } },
    ]),
  );
  const claudeMtime = new Date(now - 120_000);
  fs.utimesSync(claudePath, claudeMtime, claudeMtime);

  const codexDir = path.join(home, ".codex/sessions/2026/07/18");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, `rollout-2026-07-18T09-00-00-${CODEX_SESSION}.jsonl`);
  fs.writeFileSync(
    codexPath,
    jsonl([
      { type: "session_meta", timestamp: at(4200), payload: { id: CODEX_SESSION, cwd, originator: "codex_cli_rs", cli_version: "0.200.0", source: "cli" } },
      { type: "turn_context", timestamp: at(4100), payload: { effort: "low" } },
      { type: "event_msg", timestamp: at(4000), payload: { type: "user_message", message: "Confirm the effort tier stays reachable when the model is unknown." } },
      { type: "event_msg", timestamp: at(3700), payload: { type: "agent_message", message: "The engine badge carries the reasoning-effort tooltip while the meter is collapsed." } },
    ]),
  );
  const codexMtime = new Date(now - 3600_000);
  fs.utimesSync(codexPath, codexMtime, codexMtime);

  /* An empty $TMPDIR/claude-<uid> keeps the claude-tasks root inside the
     fixture — otherwise the scanner falls back to the real /tmp/claude-<uid>
     and the host machine's background-task files leak into the capture. */
  const uid = process.getuid?.() ?? 1000;
  for (const dir of [".config/agent-log-viewer/state", ".cache", "tmp", path.join("tmp", `claude-${uid}`)]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return { home, claudePath, codexPath };
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

async function main(): Promise<void> {
  const { home, claudePath, codexPath } = buildFixtureHome();
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

  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT_DIR, "playwright/index.mjs")).href);
  const browser = await chromium.launch();
  try {
    await waitForServer(server, logs);
    const base = `http://127.0.0.1:${PORT}/`;
    const shoot = async (page: unknown, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
      // @ts-expect-error playwright page is dynamically imported
      await page.screenshot({ path: path.join(OUT_DIR, name), clip });
      console.log(`  shot ${name}`);
    };
    /* Best-effort: give the transcript feed a moment to replace its Loading…
       placeholder so the shots read as a settled screen; the header meter —
       the acceptance subject — is already asserted by then. */
    const settleFeed = async (page: { getByText: (t: string) => { first: () => { waitFor: (o: { timeout: number }) => Promise<void> } } }, text: string) => {
      await page.getByText(text).first().waitFor({ timeout: 15_000 }).catch(() => console.log("  note: feed kept its loading placeholder"));
    };

    /* 1) Desktop pane: claude session, model chip + in-flow meter. */
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}#f=${encodeURIComponent(claudePath)}`, { waitUntil: "domcontentloaded" });
      const pills = page.locator("header [data-effort-pills]").first();
      await pills.waitFor({ timeout: 30_000 });
      const slot = await pills.evaluate((el: Element) => ({
        className: el.className,
        display: getComputedStyle(el).display,
        rowClass: (el.parentElement as HTMLElement).className,
        title: el.getAttribute("title"),
      }));
      check(slot.className.includes("reasoning-slot") && !slot.className.includes("absolute"), "desktop-pane-in-flow", `meter classes "${slot.className}" — plain flex item, no positioned escape`);
      check(slot.display !== "none", "desktop-pane-meter-visible", `computed display "${slot.display}" in the wide pane header`);
      check(slot.rowClass.includes("flex-wrap"), "desktop-pane-row-wraps", "meter and model chip are siblings of one wrapping meta row");
      check(slot.title === "Reasoning effort: high", "desktop-pane-tooltip", `meter tooltip "${slot.title}"`);
      await settleFeed(page, "The meter occupies its reserved slot");
      await shoot(page, "desktop-pane-claude-effort-slot.png");
      const box = await pills.evaluate((el: Element) => {
        const r = (el.closest("header") as HTMLElement).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await shoot(page, "desktop-pane-claude-header-closeup.png", { x: Math.max(box.x - 8, 0), y: Math.max(box.y - 8, 0), width: Math.min(box.width + 16, 1280), height: box.height + 16 });
      await page.close();
    }

    /* 2) Desktop pane: codex session with model=null — the #270 fallback. */
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}#f=${encodeURIComponent(codexPath)}`, { waitUntil: "domcontentloaded" });
      const pills = page.locator("header [data-effort-pills]").first();
      await pills.waitFor({ timeout: 30_000 });
      const badge = page.locator("header span", { hasText: /^Codex$/ }).first();
      const badgeTitle = await badge.getAttribute("title");
      check(badgeTitle === "Reasoning effort: low", "desktop-fallback-tooltip", `engine-badge fallback title "${badgeTitle}" with model=null`);
      const chipCount = await page.locator('header span[title^="Codex · "]').count();
      check(chipCount === 0, "desktop-fallback-no-model-chip", "no model identity chip renders — the engine badge is the identity fallback");
      await settleFeed(page, "carries the reasoning-effort tooltip");
      await shoot(page, "desktop-pane-codex-model-null-fallback.png");
      const box = await badge.evaluate((el: Element) => {
        const r = (el.closest("header") as HTMLElement).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await shoot(page, "desktop-pane-codex-header-closeup.png", { x: Math.max(box.x - 8, 0), y: Math.max(box.y - 8, 0), width: Math.min(box.width + 16, 1280), height: box.height + 16 });
      await page.close();
    }

    /* 3) Switchboard: 300px card keeps the meter, 220px card collapses it. */
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}#p=atlas`, { waitUntil: "domcontentloaded" });
      const corner = page.locator('button[aria-label="Open the agent switchboard"]').first();
      await corner.waitFor({ timeout: 30_000 });
      await corner.click();
      const cards = page.locator("article.reasoning-host");
      await cards.first().waitFor({ timeout: 30_000 });
      const states = await cards.evaluateAll((elements: Element[]) =>
        elements.map((card) => {
          const pills = card.querySelector("[data-effort-pills]");
          const spans = [...card.querySelectorAll("span")];
          const codexBadge = spans.find((el) => el.textContent === "Codex");
          const modelChip = spans.find((el) => el.textContent === "opus-4-8");
          return {
            width: (card as HTMLElement).getBoundingClientRect().width,
            meterDisplay: pills ? getComputedStyle(pills).display : "missing",
            codexBadgeTitle: codexBadge?.getAttribute("title") ?? null,
            modelChipTitle: modelChip?.getAttribute("title") ?? null,
          };
        }),
      );
      const large = states.find((s: { width: number }) => s.width >= 260);
      const small = states.find((s: { width: number }) => s.width < 260);
      check(!!large && large.meterDisplay !== "none" && large.meterDisplay !== "missing", "switchboard-large-meter", `300px card meter computed display "${large?.meterDisplay}" — visible above the threshold`);
      check(!!small && small.meterDisplay === "none", "switchboard-small-collapse", `220px card meter computed display "${small?.meterDisplay}" — container query collapses it`);
      check(small?.codexBadgeTitle === "Reasoning effort: low", "switchboard-small-fallback-tooltip", `collapsed card engine-badge title "${small?.codexBadgeTitle}" keeps the tier reachable`);
      check((large?.modelChipTitle ?? "").includes("Reasoning effort: high"), "switchboard-large-chip-tooltip", `model chip title "${large?.modelChipTitle}"`);
      await shoot(page, "switchboard-collapse-large-vs-small.png");
      await page.close();
    }

    /* 4) 390px mobile: merged model·effort chip; codex fallback badge. */
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${base}#f=${encodeURIComponent(claudePath)}`, { waitUntil: "domcontentloaded" });
      const chip = page.locator("header span", { hasText: /^opus-4-8 · high$/ }).first();
      await chip.waitFor({ timeout: 30_000 });
      const pillCount = await page.locator("header [data-effort-pills]").count();
      check(pillCount === 0, "mobile-merged-chip", 'phone header shows the merged "opus-4-8 · high" chip; the bar meter never renders');
      await settleFeed(page, "The meter occupies its reserved slot");
      await shoot(page, "mobile-390-claude-merged-chip.png");
      await page.goto(`${base}#f=${encodeURIComponent(codexPath)}`, { waitUntil: "domcontentloaded" });
      const badge = page.locator("header span", { hasText: /^Codex$/ }).first();
      await badge.waitFor({ timeout: 30_000 });
      const badgeTitle = await badge.getAttribute("title");
      check(badgeTitle === "Reasoning effort: low", "mobile-fallback-tooltip", `phone engine-badge fallback title "${badgeTitle}" with model=null`);
      await settleFeed(page, "carries the reasoning-effort tooltip");
      await shoot(page, "mobile-390-codex-model-null-fallback.png");
      await page.close();
    }

    fs.writeFileSync(
      path.join(OUT_DIR, "evidence.json"),
      JSON.stringify({ capturedAt: new Date().toISOString(), viewer: "production next start", checks }, null, 2) + "\n",
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
