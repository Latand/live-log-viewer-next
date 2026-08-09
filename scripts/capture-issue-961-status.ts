/**
 * Rendered verification of the #961 board status vocabulary, in a real browser:
 *
 *   bun scripts/capture-issue-961-status.ts
 *
 * Serves the production build against a purpose-built synthetic home under
 * /tmp (never the operator's live state, and no real home path anywhere in the
 * frames), then drives the real board with a locally available Chromium.
 *
 * The scanner reads real seeded transcripts; the browser then patches the
 * `/api/files` payload in flight to place each card into exactly one authority
 * state — a pending question (NEEDS YOU), a draining account switch holding
 * three deliveries (HELD ×3), an open turn on a live agent (RUNNING · elapsed),
 * a scheduled wakeup (QUEUED), and untouched quiet cards. Everything the
 * frames show — projection, badge, tones, translations, layout, zoom — is the
 * production render path; only the authority facts are seeded, the same way
 * the launch receipt is fulfilled synthetically in the #887 capture.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/961-desktop-dense.png        — the dense board, one word per card, quiet cards bare
 *   <out>/961-card-needs-you.png       — NEEDS YOU, warning tone, question card
 *   <out>/961-card-held.png            — HELD ×3 during the account switch, ribbon intact
 *   <out>/961-card-running.png         — RUNNING with the elapsed run time
 *   <out>/961-card-queued.png          — QUEUED beside the existing ⏰ wakeup chip
 *   <out>/961-card-quiet.png           — a quiet card carries no status badge
 *   <out>/961-stack-collapsed.png      — the collapsed branch stack keeps the words
 *   <out>/961-far-zoom.png             — far-zoom labels carry the word at map distance
 *   <out>/961-switchboard.png          — switch cards share the same vocabulary
 *   <out>/961-mobile-390-focus.png     — 390 px conversation, word in the header
 *   <out>/961-mobile-390-map.png       — 390 px lite map cards
 *
 * A DOM summary (badge words, computed font sizes, per-card status attributes)
 * is written to evidence/issue-961/status-vocabulary.json for the repository.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page, type Route } from "playwright-core";

import { demoPort } from "./demo-capture";

const BASE = process.env.STATUS_CAPTURE_DIR ?? "/tmp/llv-issue-961";
const HOME = path.join(BASE, "home");
const OUT_DIR = path.join(BASE, "out");
const REPO_DIR = path.join(HOME, "Projects", "atlas");

/** Frozen browser clock, so every elapsed/countdown in the frames is stable. */
const CAPTURE_MS = Date.parse("2100-01-02T12:00:00.000Z");

type SeededSession = {
  id: string;
  title: string;
  /** Minutes before the capture moment the transcript last grew. */
  agoMinutes: number;
  status: "needs-you" | "held" | "running" | "queued" | "rate-limited" | "quiet";
  /** Child of this session id — becomes a quiet subagent branch in a stack. */
  childOf?: string;
};

const SESSIONS: SeededSession[] = [
  { id: "11111111", title: "Gate the release on the review verdict", agoMinutes: 6, status: "needs-you" },
  { id: "22222222", title: "Move the delivery fence into the registry", agoMinutes: 9, status: "held" },
  { id: "33333333", title: "Rebuild the board status projection", agoMinutes: 1, status: "running" },
  { id: "44444444", title: "Poll the nightly integration run", agoMinutes: 25, status: "queued" },
  { id: "55555555", title: "Write the migration retrospective", agoMinutes: 200, status: "quiet" },
  { id: "66666666", title: "Audit the tone tokens", agoMinutes: 300, status: "quiet", childOf: "10101010" },
  { id: "77777777", title: "Sweep the caption floor", agoMinutes: 320, status: "queued", childOf: "10101010" },
  { id: "88888888", title: "Collect switch-card fixtures", agoMinutes: 340, status: "quiet", childOf: "10101010" },
  { id: "99999999", title: "Compare account quotas", agoMinutes: 12, status: "rate-limited" },
  { id: "10101010", title: "Draft the deployment notes", agoMinutes: 500, status: "quiet" },
];

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const sessionUuid = (id: string) => `${id}-1111-4111-8111-111111111111`;
const sessionPathSuffix = (id: string) => `${sessionUuid(id)}.jsonl`;

function seedHome(): void {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  SESSIONS.forEach((session) => {
    const uuid = sessionUuid(session.id);
    const at = new Date(CAPTURE_MS - session.agoMinutes * 60_000);
    const stamp = at.toISOString();
    const lines = [
      { type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd: REPO_DIR, message: { role: "user", content: `${session.title}.` } },
      { type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd: REPO_DIR, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${session.title} — on it.` }] } },
    ];
    const file = path.join(folder, `${uuid}.jsonl`);
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    fs.utimesSync(file, at, at);
  });
}

function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const config = path.join(HOME, ".config");
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME,
    TMPDIR: path.join(BASE, "tmp"),
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

const seedInit = () => {
  const captureTime = Date.parse("2100-01-02T12:00:00.000Z");
  const NativeDate = Date;
  class CaptureDate extends NativeDate {
    constructor(...args: unknown[]) {
      super(...((args.length ? args : [captureTime]) as []));
    }
    static now() { return captureTime; }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("llv_lang", "en");
  localStorage.setItem("llvSound", "0");
};

/** When set, the payload narrows to these session ids — the close-up frames
    center one card (or one root + its stacked branches) at a readable zoom. */
let onlyIds: string[] | null = null;

/** Place each scanned card into exactly one authority state, in flight. */
function patchFilesPayload(payload: { files?: Array<Record<string, unknown>> }): typeof payload {
  if (onlyIds) {
    const keep = new Set(onlyIds.map(sessionPathSuffix));
    payload.files = (payload.files ?? []).filter((file) => keep.has(String(file.path).split("/").at(-1) ?? ""));
  }
  const bySuffix = new Map(SESSIONS.map((session) => [sessionPathSuffix(session.id), session]));
  const pathOf = (id: string) =>
    (payload.files ?? []).find((file) => String(file.path).endsWith(sessionPathSuffix(id)))?.path as string | undefined;
  const stackRoot = pathOf("10101010");
  for (const file of payload.files ?? []) {
    const seed = bySuffix.get(String(file.path).split("/").at(-1) ?? "");
    if (!seed) continue;
    /* The fixture clock is pinned to 2100 in the browser while the server
       scans with the real clock, so scanner-derived liveness is meaningless
       here. Normalize every seeded card to a settled baseline, then apply the
       ONE authority state this card demonstrates. */
    file.activity = "idle";
    file.lastTurn = null;
    file.pendingWakeup = null;
    file.proc = null;
    file.pid = null;
    file.mtime = (CAPTURE_MS - seed.agoMinutes * 60_000) / 1000;
    if (seed.childOf && stackRoot) {
      file.parent = stackRoot;
      file.kind = "subagent";
    }
    if (seed.status === "needs-you") {
      file.activity = "recent";
      file.pendingQuestion = {
        kind: "question",
        toolUseId: `toolu_${seed.id}`,
        transcriptPath: file.path,
        pid: 4242,
        paneTarget: null,
        askedAt: new Date(CAPTURE_MS - 4 * 60_000).toISOString(),
        questions: [{ question: "Ship behind the flag or wait for the verdict?", options: [] }],
      };
    }
    if (seed.status === "rate-limited") {
      file.activity = "recent";
      file.rateLimit = { source: "account", accountId: "default", window: "session", resetAt: (CAPTURE_MS + 90 * 60_000) / 1000 };
    }
    if (seed.status === "held") {
      file.migration = {
        intentId: "intent-961",
        trigger: "quota",
        phase: "waiting-turn",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        heldDeliveries: 3,
        failure: null,
      };
    }
    if (seed.status === "running") {
      file.activity = "live";
      file.lastTurn = { startedAt: CAPTURE_MS - (12 * 60 + 34) * 1000, endedAt: null };
    }
    if (seed.status === "queued") {
      file.pendingWakeup = { fireAt: CAPTURE_MS + 12 * 60_000, reason: "poll the nightly integration run" };
    }
  }
  return payload;
}

async function routeFiles(page: Page): Promise<void> {
  await page.route("**/api/files*", async (route: Route) => {
    try {
      const response = await route.fetch();
      const payload = patchFilesPayload(await response.json());
      await route.fulfill({ response, contentType: "application/json", body: JSON.stringify(payload) });
    } catch {
      /* A poll aborted by page teardown: let it fail as it would unrouted. */
      await route.abort().catch(() => undefined);
    }
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/files`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

/** A card's on-screen rect, padded, for a framed close-up. */
async function nodeClip(page: Page, suffix: string, pad = 28) {
  const box = await page.evaluate(({ suffix: tail, pad: margin }) => {
    const node = Array.from(document.querySelectorAll("[data-scheme-node]"))
      .find((el) => el.getAttribute("data-scheme-node")?.endsWith(tail));
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: Math.max(rect.x - margin, 0), y: Math.max(rect.y - margin - 40, 0), width: rect.width + margin * 2, height: rect.height + margin * 2 + 40 };
  }, { suffix, pad });
  if (!box) return undefined;
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.min(box.x, viewport.width - 1));
  const y = Math.max(0, Math.min(box.y, viewport.height - 1));
  const width = Math.min(box.width, viewport.width - x);
  const height = Math.min(box.height, viewport.height - y);
  /* A card partly outside the viewport cannot be framed; fall back to the
     full page rather than hanging the screenshot on a degenerate clip. */
  if (width < 40 || height < 40) return undefined;
  return { x, y, width, height };
}

type BadgeFact = { card: string; status: string | null; word: string | null; fontPx: number | null };

/** Every rendered badge with the card it sits on and its computed font size. */
async function badgeFacts(page: Page): Promise<BadgeFact[]> {
  return page.evaluate(() => {
    const facts: Array<{ card: string; status: string | null; word: string | null; fontPx: number | null }> = [];
    for (const node of Array.from(document.querySelectorAll("[data-scheme-node]"))) {
      const card = node.getAttribute("data-scheme-node") ?? "";
      const badges = Array.from(node.querySelectorAll("[data-card-status]"));
      if (!badges.length) {
        facts.push({ card: card.split("/").at(-1) ?? card, status: null, word: null, fontPx: null });
        continue;
      }
      for (const badge of badges) {
        facts.push({
          card: card.split("/").at(-1) ?? card,
          status: badge.getAttribute("data-card-status"),
          word: badge.textContent?.trim() ?? null,
          fontPx: Number.parseFloat(getComputedStyle(badge).fontSize) || null,
        });
      }
    }
    return facts;
  });
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.STATUS_CAPTURE_PORT, 3049, "STATUS_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedHome();

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const summary: Record<string, unknown> = {};
  try {
    await waitForServer(baseUrl, server);
    const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ project?: string; cwd?: string }> };
    const projectId = scanned.files?.find((file) => file.cwd === REPO_DIR)?.project ?? "";
    must(Boolean(projectId), `no scanned project owns the seeded repository`);

    /* ── Desktop board ──────────────────────────────────────────────────── */
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await page.addInitScript(seedInit);
    await routeFiles(page);
    await page.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
    await page.waitForTimeout(1200);
    /* Frame the WHOLE board — the dense-board evidence must show every card. */
    await page.locator('button[title^="Fit all content"]').first().click();
    await page.waitForTimeout(900);

    const facts = await badgeFacts(page);
    summary.board = facts;
    if (process.env.STATUS_CAPTURE_DEBUG) console.log(JSON.stringify(facts, null, 2));
    const wordOf = (id: string) => facts.find((fact) => fact.card.startsWith(sessionUuid(id)) && fact.status);
    must(wordOf("11111111")?.status === "needs-you", "the question card does not read NEEDS YOU");
    must(wordOf("22222222")?.status === "held", "the switching card does not read HELD");
    must((wordOf("22222222")?.word ?? "").includes("×3"), "HELD does not carry the unsettled count");
    must(wordOf("33333333")?.status === "running", "the live card does not read RUNNING");
    must((wordOf("33333333")?.word ?? "").includes("12m"), "RUNNING does not carry the elapsed time");
    must(wordOf("44444444")?.status === "queued", "the wakeup card does not read QUEUED");
    must(wordOf("99999999")?.status === "needs-you", "the rate-limited card does not read NEEDS YOU");
    const quiet = facts.filter((fact) => fact.card.startsWith(sessionUuid("55555555")));
    must(quiet.length === 1 && quiet[0]!.status === null, "a quiet card grew a status badge");
    for (const fact of facts) {
      if (fact.fontPx !== null) must(fact.fontPx >= 10, `badge under the 10px caption floor: ${fact.card} at ${fact.fontPx}px`);
    }
    await page.screenshot({ path: path.join(OUT_DIR, "961-desktop-dense.png") });

    /* Close-ups: narrow the payload to the one card and reload — the default
       framing then centers it alone at a readable zoom. */
    const closeups: Array<[string, string]> = [
      ["11111111", "961-card-needs-you.png"],
      ["22222222", "961-card-held.png"],
      ["33333333", "961-card-running.png"],
      ["44444444", "961-card-queued.png"],
      ["55555555", "961-card-quiet.png"],
    ];
    for (const [id, name] of closeups) {
      onlyIds = [id];
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT_DIR, name), clip: await nodeClip(page, sessionPathSuffix(id)) });
    }
    onlyIds = null;

    /* The collapsed branch stack under its quiet root. */
    onlyIds = ["10101010", "66666666", "77777777", "88888888"];
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
    await page.waitForTimeout(1200);
    const stackFacts = await page.evaluate(() => {
      const stack = Array.from(document.querySelectorAll("[data-scheme-node]"))
        .find((el) => (el.getAttribute("data-scheme-node") ?? "").endsWith("::stack"));
      if (!stack) return null;
      return {
        key: stack.getAttribute("data-scheme-node"),
        badges: Array.from(stack.querySelectorAll("[data-card-status]")).map((badge) => badge.getAttribute("data-card-status")),
      };
    });
    must(Boolean(stackFacts), "no collapsed branch stack rendered");
    must((stackFacts!.badges ?? []).includes("queued"), "the stack rows dropped the queued branch's word");
    summary.stack = stackFacts;
    await page.screenshot({ path: path.join(OUT_DIR, "961-stack-collapsed.png"), clip: await nodeClip(page, "::stack") });
    onlyIds = null;

    /* Far zoom on the full board: the identity labels take over the word. */
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
    await page.waitForTimeout(1200);
    for (let step = 0; step < 10; step += 1) await page.locator('button[title^="Zoom out"]').first().click();
    await page.waitForTimeout(600);
    const farBadges = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-scheme-node] [data-card-status]"))
        .filter((badge) => {
          let el: Element | null = badge;
          while (el && !(el instanceof HTMLElement && el.style.opacity !== "")) el = el.parentElement;
          return true;
        }).length,
    );
    must(farBadges > 0, "no badges survive at far zoom");
    await page.screenshot({ path: path.join(OUT_DIR, "961-far-zoom.png") });

    /* Switchboard: same words on the switch cards. The far-zoom minimap rect
       overlays the corner trigger's hit point, so activate it via the DOM. */
    await page.evaluate(() => {
      (document.querySelector('[aria-label="Open the agent switchboard"]') as HTMLButtonElement | null)?.click();
    });
    await page.waitForTimeout(800);
    const switchFacts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("article [data-card-status]")).map((badge) => ({
        status: badge.getAttribute("data-card-status"),
        word: badge.textContent?.trim() ?? "",
        fontPx: Number.parseFloat(getComputedStyle(badge).fontSize) || null,
      })),
    );
    must(switchFacts.some((fact) => fact.status === "needs-you"), "no switch card reads NEEDS YOU");
    must(switchFacts.some((fact) => fact.status === "running"), "no switch card reads RUNNING");
    for (const fact of switchFacts) must((fact.fontPx ?? 0) >= 10, "a switch-card badge sits under the caption floor");
    summary.switchboard = switchFacts;
    await page.screenshot({ path: path.join(OUT_DIR, "961-switchboard.png") });
    await page.close();

    /* ── 390 px phone ───────────────────────────────────────────────────── */
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    await phone.addInitScript(seedInit);
    await routeFiles(phone);
    await phone.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await phone.waitForTimeout(2500);
    /* Open the blocked conversation the way an operator would: by its row. */
    const focusTarget = phone.locator("text=Gate the release on the review verdict").first();
    if (await focusTarget.count()) {
      await focusTarget.click({ force: true });
      await phone.waitForTimeout(1500);
    }
    const mobileHeader = await phone.evaluate(() => {
      const badge = document.querySelector("header [data-card-status], [data-card-status]");
      return badge ? { status: badge.getAttribute("data-card-status"), word: badge.textContent?.trim(), fontPx: Number.parseFloat(getComputedStyle(badge).fontSize) } : null;
    });
    must(mobileHeader?.status === "needs-you", "the 390px conversation header does not carry the word");
    must((mobileHeader?.fontPx ?? 0) >= 10, "the 390px badge sits under the caption floor");
    summary.mobileFocus = mobileHeader;
    await phone.screenshot({ path: path.join(OUT_DIR, "961-mobile-390-focus.png") });

    /* Context shot only: the phone map is MobileMapLite's bounded MARKER
       projection (#418), not the lite scheme cards, and it is deliberately
       outside this lane's surfaces — the words live on the focus view above
       and on the lite/far-zoom scheme labels captured on desktop. */
    const mapButton = phone.locator('[aria-label="Open the project map"]');
    if (await mapButton.count()) {
      await mapButton.first().click();
      await phone.waitForSelector('[data-testid="mobile-map"]', { timeout: 30_000 });
      await phone.waitForTimeout(1500);
      summary.mobileMap = { markers: await phone.locator('[data-testid="mobile-map"] button').count(), surface: "marker map (#418), unchanged by #961" };
      await phone.screenshot({ path: path.join(OUT_DIR, "961-mobile-390-map.png") });
    }
    await phone.close();

    const evidenceDir = path.join(repoRoot, "evidence", "issue-961");
    fs.mkdirSync(evidenceDir, { recursive: true });
    /* The committed summary names cards by their 8-char seed only: a full
       fixture UUID would trip the privacy gate's resource-identifier class. */
    const scrubbed = JSON.stringify(summary, null, 2).replaceAll("-1111-4111-8111-111111111111", "");
    fs.writeFileSync(path.join(evidenceDir, "status-vocabulary.json"), scrubbed + "\n", "utf8");
    console.log(`screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
