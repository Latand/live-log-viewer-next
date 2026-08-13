/**
 * Rendered verification of the #964 fixed card anatomy, in a real browser:
 *
 *   bun scripts/capture-issue-964-anatomy.ts
 *
 * Serves the production build against a purpose-built synthetic home under
 * /tmp (never the operator's live state, and no real home path anywhere in
 * the frames), then drives the real switchboard, far-zoom labels, and
 * collapsed stacks with a locally available Chromium — in dark AND light.
 *
 * The scanner reads real seeded transcripts; the browser patches the
 * `/api/files` payload in flight to place each card into one operational
 * state — quiet, running, NEEDS YOU, held-delivery, rate-limited,
 * wakeup-queued, an account switch in each phase (preflight, switching,
 * failed), and a settled managed account. Everything the frames show — row
 * structure, chip placement, tones, translations — is the production render
 * path; only the authority facts are seeded.
 *
 * Shots land outside the repository for direct inspection:
 *
 *   <out>/964-switchboard-dark.png       — the full switch-card state matrix, dark
 *   <out>/964-switchboard-light.png      — the same matrix, light
 *   <out>/964-board-dense-dark.png       — full board, ops facts on full cards
 *   <out>/964-far-zoom-dark.png          — far labels: status → title → ops chips
 *   <out>/964-stack-collapsed-dark.png   — collapsed rows: status leads, switch on ops line
 *   <out>/964-mobile-390-<state>-*.png   — 390 px per-state frames, dark + light
 *
 * Two switchboard cards carry the fully mixed combination (switch + rate limit
 * + wakeup on one ops row) — one in each fixed card width — and their chip
 * geometry is asserted in the live DOM: every chip inside the row, none
 * clipped away, each fact complete on its title (#964 review, finding 1).
 * The 390 px pass walks EVERY seeded operational state on the phone's
 * conversation surface and verifies the state's fact and the title before
 * framing (#964 review, finding 2).
 *
 * A DOM summary (row order, chip row membership, per-state switch chips, card
 * heights and chip geometry) is written to evidence/issue-964/card-anatomy.json.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page, type Route } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const BASE = createCaptureDirectory({
  envName: "ANATOMY_CAPTURE_DIR",
  prefix: "llv-issue-964",
  raw: process.env.ANATOMY_CAPTURE_DIR,
  repoRoot: path.resolve(import.meta.dir, ".."),
});
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
  status:
    | "needs-you"
    | "held"
    | "running"
    | "queued"
    | "rate-limited"
    | "switching"
    | "switch-failed"
    | "settled-account"
    | "mixed-large"
    | "mixed-small"
    | "quiet";
  /** Child of this session id — becomes a quiet subagent branch in a stack. */
  childOf?: string;
};

const SESSIONS: SeededSession[] = [
  { id: "11111111", title: "Gate the release on the review verdict", agoMinutes: 6, status: "needs-you" },
  { id: "22222222", title: "Move the delivery fence into the registry", agoMinutes: 9, status: "held" },
  { id: "33333333", title: "Rebuild the board status projection", agoMinutes: 1, status: "running" },
  { id: "44444444", title: "Poll the nightly integration run", agoMinutes: 25, status: "queued" },
  { id: "55555555", title: "Write the migration retrospective", agoMinutes: 200, status: "quiet" },
  { id: "66666666", title: "Audit the tone tokens", agoMinutes: 300, status: "switching", childOf: "10101010" },
  { id: "77777777", title: "Sweep the caption floor", agoMinutes: 320, status: "queued", childOf: "10101010" },
  { id: "88888888", title: "Collect switch-card fixtures", agoMinutes: 340, status: "quiet", childOf: "10101010" },
  { id: "99999999", title: "Compare account quotas", agoMinutes: 12, status: "rate-limited" },
  { id: "10101010", title: "Draft the deployment notes", agoMinutes: 500, status: "quiet" },
  { id: "12121212", title: "Rebalance the account pool", agoMinutes: 4, status: "switching" },
  { id: "13131313", title: "Rotate the burndown fixtures", agoMinutes: 40, status: "switch-failed" },
  { id: "14141414", title: "Summarize the incident review", agoMinutes: 90, status: "settled-account" },
  /* The fully mixed combination — switch + rate limit + wakeup on ONE ops row —
     in each fixed card width: the rate limit lands this card in the waiting
     section (large, 300px)… */
  { id: "15151515", title: "Reconcile the quota ledger", agoMinutes: 8, status: "mixed-large" },
  /* …while an idle preflight switch + wakeup + a subagent branch lands in the
     recent section (small, 220px). */
  { id: "16161616", title: "Refill the fixture pool", agoMinutes: 30, status: "mixed-small" },
  { id: "17171717", title: "Fold the fixture branches", agoMinutes: 45, status: "quiet", childOf: "16161616" },
];

/** The transcript home of the seeded managed account: the settled-account card
    runs under a REAL `accounts/claude/account-b` root, so the settled ops chip,
    the pane header's account badge, and the transcript feed all read the same
    genuine path — no display-only rewrite. */
const ACCOUNT_B_ID = "account-b";

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const sessionUuid = (id: string) => `${id}-1111-4111-8111-111111111111`;
const sessionPathSuffix = (id: string) => `${sessionUuid(id)}.jsonl`;

function seedHome(): void {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config/agent-log-viewer/state"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(REPO_DIR));
  fs.mkdirSync(folder, { recursive: true });
  /* A genuine managed account: registry entry + its own transcript tree. The
     settled-account session lives there, so its path carries the real
     `accounts/claude/<id>` layout the settled chip and account badge read. */
  fs.writeFileSync(
    path.join(HOME, ".config/agent-log-viewer/state/claude-accounts.json"),
    JSON.stringify({ version: 1, active: "default", accounts: [{ id: ACCOUNT_B_ID, label: "Account B", kind: "managed", createdAt: 0 }], retired: [] }) + "\n",
    "utf8",
  );
  const accountBHome = path.join(HOME, ".config/agent-log-viewer/accounts/claude", ACCOUNT_B_ID);
  const accountBFolder = path.join(accountBHome, "projects", projectSlug(REPO_DIR));
  fs.mkdirSync(accountBFolder, { recursive: true });
  /* The registry only trusts a managed home locked to its owner. */
  fs.chmodSync(accountBHome, 0o700);
  SESSIONS.forEach((session) => {
    const uuid = sessionUuid(session.id);
    const at = new Date(CAPTURE_MS - session.agoMinutes * 60_000);
    const stamp = at.toISOString();
    const lines = [
      { type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd: REPO_DIR, message: { role: "user", content: `${session.title}.` } },
      { type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd: REPO_DIR, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${session.title} — on it.` }] } },
    ];
    const file = path.join(session.status === "settled-account" ? accountBFolder : folder, `${uuid}.jsonl`);
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

/** When set, the payload narrows to these session ids for framed close-ups. */
let onlyIds: string[] | null = null;

/** Place each scanned card into exactly one operational state, in flight. */
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
       scans with the real clock; normalize every card to a settled baseline,
       then apply the ONE state this card demonstrates. */
    file.activity = "idle";
    file.lastTurn = null;
    file.pendingWakeup = null;
    file.proc = null;
    file.pid = null;
    file.model = "sonnet-4-5";
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
        intentId: "intent-964",
        trigger: "quota",
        phase: "waiting-turn",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        sourceLabel: "Account A",
        heldDeliveries: 3,
        failure: null,
      };
    }
    if (seed.status === "switching") {
      file.migration = {
        intentId: "intent-964",
        trigger: "manual",
        phase: "preparing",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        sourceLabel: "Account A",
        failure: null,
      };
    }
    if (seed.status === "switch-failed") {
      file.migration = {
        intentId: "intent-964",
        trigger: "manual",
        phase: "failed-recoverable",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        sourceLabel: "Account A",
        failure: "successor never came up",
      };
    }
    /* The fully mixed rows (#964 review, finding 1): switch + rate limit +
       wakeup TOGETHER on one ops row. The rate limit routes the large card
       into the waiting section; the idle preflight keeps the small card in
       recent. No display rewrites — every fact is the real authority field. */
    if (seed.status === "mixed-large") {
      file.activity = "recent";
      file.rateLimit = { source: "account", accountId: "default", window: "session", resetAt: (CAPTURE_MS + 45 * 60_000) / 1000 };
      file.migration = {
        intentId: "intent-964-mixed",
        trigger: "quota",
        phase: "preparing",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        sourceLabel: "Account A",
        failure: null,
      };
      file.pendingWakeup = { fireAt: CAPTURE_MS + 25 * 60_000, reason: "recheck the quota ledger" };
    }
    if (seed.status === "mixed-small") {
      file.migration = {
        intentId: "intent-964-mixed",
        trigger: "manual",
        phase: "waiting-turn",
        targetAccountId: "account-b",
        targetLabel: "Account B",
        sourceLabel: "Account A",
        failure: null,
      };
      file.pendingWakeup = { fireAt: CAPTURE_MS + 40 * 60_000, reason: "refill the fixture pool" };
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
  if (width < 40 || height < 40) return undefined;
  return { x, y, width, height };
}

type OpsChipGeometry = {
  chip: string;
  width: number;
  /** How far the chip's right edge pokes past the visible ops row (px);
      anything meaningfully positive means the chip is clipped away. */
  overflowRight: number;
  titled: boolean;
};

type SwitchCardFact = {
  title: string;
  rows: string[];
  height: number;
  width: number;
  status: string | null;
  switchChip: { kind: string; text: string } | null;
  opsChips: string[];
  chipsOutsideOps: string[];
  opsGeometry: OpsChipGeometry[];
};

/** Every switchboard card's anatomy, read from the live DOM. */
async function switchboardFacts(page: Page): Promise<SwitchCardFact[]> {
  return page.evaluate(() => {
    const facts: SwitchCardFact[] = [];
    type OpsChipGeometry = { chip: string; width: number; overflowRight: number; titled: boolean };
    type SwitchCardFact = {
      title: string;
      rows: string[];
      height: number;
      width: number;
      status: string | null;
      switchChip: { kind: string; text: string } | null;
      opsChips: string[];
      chipsOutsideOps: string[];
      opsGeometry: OpsChipGeometry[];
    };
    for (const card of Array.from(document.querySelectorAll("article[role=button]"))) {
      const rows = Array.from(card.querySelectorAll("[data-card-row]")).map((row) => row.getAttribute("data-card-row") ?? "");
      const ops = card.querySelector('[data-card-row="ops"]');
      const chipIn = (selector: string) => (ops?.querySelector(selector) ? true : false);
      const opsChips: string[] = [];
      if (chipIn("[data-card-switch]")) opsChips.push(`switch:${ops!.querySelector("[data-card-switch]")!.getAttribute("data-card-switch")}`);
      if (chipIn("[data-rate-limited]")) opsChips.push("rate-limit");
      if (chipIn("[data-wakeup]")) opsChips.push("wakeup");
      const outside: string[] = [];
      for (const marker of ["[data-card-switch]", "[data-rate-limited]", "[data-wakeup]"]) {
        for (const chip of Array.from(card.querySelectorAll(marker))) {
          if (!ops?.contains(chip)) outside.push(marker);
        }
      }
      /* Clipping check (#964 review, finding 1): rects come unclipped even
         inside overflow-hidden, so a chip pushed past the row's right edge is
         measurable as overflowRight > 0. */
      const opsRect = ops?.getBoundingClientRect() ?? null;
      const opsGeometry: OpsChipGeometry[] = [];
      if (ops && opsRect) {
        for (const marker of ["[data-card-switch]", "[data-rate-limited]", "[data-wakeup]"]) {
          const chip = ops.querySelector(marker);
          if (!chip) continue;
          const rect = chip.getBoundingClientRect();
          opsGeometry.push({
            chip: marker.replace(/[[\]]/g, ""),
            width: Math.round(rect.width * 10) / 10,
            overflowRight: Math.round((rect.right - opsRect.right) * 10) / 10,
            titled: Boolean(chip.getAttribute("title") || chip.getAttribute("aria-label")),
          });
        }
      }
      const switchChip = card.querySelector("[data-card-switch]");
      facts.push({
        title: (card.querySelector('[data-card-row="content"]')?.textContent ?? "").trim().slice(0, 48),
        rows,
        height: Math.round(card.getBoundingClientRect().height),
        width: Math.round(card.getBoundingClientRect().width),
        status: card.querySelector("[data-card-status]")?.getAttribute("data-card-status") ?? null,
        switchChip: switchChip
          ? { kind: switchChip.getAttribute("data-card-switch") ?? "", text: (switchChip.textContent ?? "").trim() }
          : null,
        opsChips,
        chipsOutsideOps: outside,
        opsGeometry,
      });
    }
    return facts;
  });
}

function verifySwitchboard(facts: SwitchCardFact[]): void {
  must(facts.length >= 9, `expected the full card matrix on the switchboard, saw ${facts.length}`);
  const by = (title: string) => facts.find((fact) => fact.title.startsWith(title));
  for (const fact of facts) {
    must(fact.rows.join(",") === "identity,content,ops", `rows out of order on «${fact.title}»: ${fact.rows.join(",")}`);
    must(fact.chipsOutsideOps.length === 0, `operational chips outside the ops row on «${fact.title}»`);
  }
  const heights = new Set(facts.map((fact) => fact.height));
  must(heights.size <= 2, `card heights vary beyond the two fixed sizes: ${[...heights].join(", ")}`);
  must(by("Rebalance")?.switchChip?.kind === "switching", "the switching card lost its switch chip");
  must((by("Rebalance")?.switchChip?.text ?? "").includes("Account B"), "the switching chip does not name account B");
  must(by("Rotate")?.switchChip?.kind === "failed", "the failed switch is not explicit");
  must(by("Move")?.status === "held", "the held card lost the HELD status word");
  must(by("Move")?.switchChip?.kind === "pending", "the preflight (held) card does not show the pending switch");
  must(by("Summarize")?.switchChip?.kind === "settled", "the settled card does not name its account");
  must((by("Summarize")?.switchChip?.text ?? "").includes("account-b"), "the settled chip does not carry the account id");
  must(by("Gate")?.status === "needs-you", "the question card lost NEEDS YOU");
  must(by("Compare")?.opsChips.includes("rate-limit") === true, "the rate limit left the ops row");
  must(by("Poll")?.opsChips.includes("wakeup") === true, "the wakeup left the ops row");
  const quiet = by("Write");
  must(quiet !== undefined && quiet.status === null && quiet.opsChips.length === 0, "the quiet card grew chips");

  /* #964 review, finding 1: with switch + rate limit + wakeup on ONE row, no
     chip may be clipped out of the visible ops row — each stays ≥16px wide
     (icon + tone survive) and keeps its complete fact on title/aria. Checked
     at BOTH fixed card widths. */
  const mixedGeometry = (title: string, expectedWidth: number, chips: string[]) => {
    const fact = by(title);
    must(fact !== undefined, `the mixed card «${title}» is missing from the switchboard`);
    must(fact!.width === expectedWidth, `«${title}» is not the ${expectedWidth}px card: ${fact!.width}`);
    for (const chip of chips) {
      const geometry = fact!.opsGeometry.find((entry) => entry.chip === chip);
      must(geometry !== undefined, `«${title}» lost its ${chip} chip from the ops row`);
      must(geometry!.width >= 16, `«${title}»'s ${chip} chip collapsed below visibility: ${geometry!.width}px`);
      must(geometry!.overflowRight <= 0.5, `«${title}»'s ${chip} chip is clipped past the ops row by ${geometry!.overflowRight}px`);
      must(geometry!.titled, `«${title}»'s ${chip} chip carries no title/aria fact`);
    }
  };
  mixedGeometry("Reconcile", 300, ["data-card-switch", "data-rate-limited", "data-wakeup"]);
  mixedGeometry("Refill", 220, ["data-card-switch", "data-wakeup"]);
  must(by("Reconcile")?.switchChip?.kind === "switching", "the mixed large card lost its switching chip");
  must(by("Refill")?.switchChip?.kind === "pending", "the mixed small card lost its pending switch chip");
}

async function openSwitchboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector('[aria-label="Open the agent switchboard"]') as HTMLButtonElement | null)?.click();
  });
  await page.waitForSelector("article[role=button]", { timeout: 30_000 });
  await page.waitForTimeout(600);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const port = demoPort(process.env.ANATOMY_CAPTURE_PORT, 3064, "ANATOMY_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedHome();
  console.log(`screenshots: ${OUT_DIR}`);

  const server = spawn("bunx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: buildEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const summary: Record<string, unknown> = {
    buildHead: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
    /* #964 review, finding 3: the frames are captured against the production
       build of buildHead. Committing them necessarily creates one commit past
       buildHead, so the enforceable head-binding invariant is: everything
       after buildHead is evidence-only. capture-issue-964-evidence.test.ts
       verifies exactly that. */
    evidencePolicy: "captured at buildHead; commits after buildHead may touch only evidence/",
  };
  try {
    await waitForServer(baseUrl, server);
    const scanned = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: Array<{ project?: string; cwd?: string }> };
    const projectId = scanned.files?.find((file) => file.cwd === REPO_DIR)?.project ?? "";
    must(Boolean(projectId), `no scanned project owns the seeded repository`);

    for (const scheme of ["dark", "light"] as const) {
      /* ── Desktop ──────────────────────────────────────────────────────── */
      /* 1440px tall: the switchboard matrix (waiting + working + recent, the
         small mixed card included) must sit inside the framed viewport. */
      const page = await browser.newPage({ viewport: { width: 1600, height: 1440 }, deviceScaleFactor: 2, colorScheme: scheme });
      await page.addInitScript(seedInit);
      await routeFiles(page);
      /* Dense board first — every seeded state, the settled managed-account
         conversation included (its transcript is genuinely on disk). */
      onlyIds = SESSIONS.map((session) => session.id);
      await page.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "networkidle", timeout: 90_000 });
      await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
      await page.waitForTimeout(1200);
      await page.locator('button[title^="Fit all content"]').first().click();
      await page.waitForTimeout(900);
      if (scheme === "dark") await page.screenshot({ path: path.join(OUT_DIR, "964-board-dense-dark.png") });

      /* Collapsed stack: the switching branch shows its switch on the ops line. */
      const stackFacts = await page.evaluate(() => {
        const stack = Array.from(document.querySelectorAll("[data-scheme-node]"))
          .find((el) => (el.getAttribute("data-scheme-node") ?? "").endsWith("::stack"));
        if (!stack) return null;
        return Array.from(stack.querySelectorAll("button")).map((row) => {
          const rows = Array.from(row.querySelectorAll("[data-card-row]")).map((el) => el.getAttribute("data-card-row"));
          const ops = row.querySelector('[data-card-row="ops"]');
          const switchChip = row.querySelector("[data-card-switch]");
          return {
            rows,
            status: row.querySelector("[data-card-status]")?.getAttribute("data-card-status") ?? null,
            switchChip: switchChip ? switchChip.getAttribute("data-card-switch") : null,
            switchInOps: switchChip ? Boolean(ops?.contains(switchChip)) : null,
          };
        });
      });
      must(Boolean(stackFacts?.length), "no collapsed branch stack rendered");
      must(
        stackFacts!.some((row) => row.switchChip === "switching" && row.switchInOps === true),
        "the switching branch does not show its switch on the stack row's ops line",
      );
      must(stackFacts!.every((row) => row.rows.join(",") === "identity,ops"), "stack rows lost the identity→ops order");
      if (scheme === "dark") {
        summary.stack = stackFacts;
        await page.screenshot({ path: path.join(OUT_DIR, "964-stack-collapsed-dark.png"), clip: await nodeClip(page, "::stack") });
      }

      /* Far zoom: labels keep identity → status → title → trailing ops chips. */
      for (let step = 0; step < 10; step += 1) await page.locator('button[title^="Zoom out"]').first().click();
      await page.waitForTimeout(600);
      const farFacts = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll("[data-scheme-node]"))
          .map((node) => {
            const label = node.querySelector("[data-far-label]");
            if (!label || !(label instanceof HTMLElement)) return null;
            const children = Array.from(label.children);
            const indexOf = (selector: string) => children.findIndex((child) => child.matches(selector) || child.querySelector(selector));
            return {
              card: (node.getAttribute("data-scheme-node") ?? "").split("/").at(-1) ?? "",
              statusAt: indexOf("[data-card-status]"),
              titleAt: children.findIndex((child) => (child.textContent ?? "").length > 20),
              switchAt: indexOf("[data-card-switch]"),
              rateAt: indexOf("[data-rate-limited]"),
            };
          })
          .filter((fact): fact is NonNullable<typeof fact> => fact !== null);
        return labels;
      });
      const farSwitching = farFacts.find((fact) => fact.card.startsWith("12121212") && fact.switchAt >= 0);
      must(farSwitching !== undefined, "the switching card's far label lost its switch chip");
      must(farSwitching!.statusAt < farSwitching!.titleAt, "far label: status does not precede the title");
      must(farSwitching!.switchAt > farSwitching!.titleAt, "far label: the switch chip does not trail the title");
      if (scheme === "dark") {
        summary.farZoom = farFacts;
        await page.screenshot({ path: path.join(OUT_DIR, "964-far-zoom-dark.png") });
      }

      /* Switchboard: the full 9-state matrix, verified card by card. */
      onlyIds = null;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector("[data-scheme-node]", { timeout: 60_000 });
      await page.waitForTimeout(1200);
      await openSwitchboard(page);
      const facts = await switchboardFacts(page);
      verifySwitchboard(facts);
      summary[`switchboard-${scheme}`] = facts;
      await page.screenshot({ path: path.join(OUT_DIR, `964-switchboard-${scheme}.png`) });
      await page.close();

      /* ── 390 px phone: the switchboard is desktop-only, so the phone's card
         surface is the focused conversation (pane header + strip). Walk EVERY
         seeded operational state (#964 review, finding 2): open it by its
         strip chip, verify the state's operational fact and the title in the
         live DOM, then frame it — dark and light alike. ─────────────────── */
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, colorScheme: scheme });
      await phone.addInitScript(seedInit);
      await routeFiles(phone);
      await phone.goto(`${baseUrl}/#p=${projectId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await phone.waitForTimeout(2500);
      const phoneStates: Array<{ state: string; id: string; verify: string }> = [
        { state: "needs-you", id: "11111111", verify: "status:needs-you" },
        { state: "held", id: "22222222", verify: "status:held" },
        { state: "running", id: "33333333", verify: "status:running" },
        { state: "queued", id: "44444444", verify: "wakeup" },
        { state: "quiet", id: "55555555", verify: "quiet" },
        { state: "rate-limited", id: "99999999", verify: "rate-limit" },
        { state: "switching", id: "12121212", verify: "text:Switching to «Account B»" },
        { state: "switch-failed", id: "13131313", verify: "text:Account switch failed" },
        { state: "settled-account", id: "14141414", verify: "account:account-b" },
      ];
      for (const { state, id, verify } of phoneStates) {
        const seed = SESSIONS.find((session) => session.id === id)!;
        /* Conversations ride the header strip as chips titled by their
           conversation title; the focused conversation keeps its chip too. */
        const chip = phone.locator(`button[title^="${seed.title}"]`).first();
        if ((await chip.count()) === 0) {
          const visible = await phone.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 600));
          throw new Error(`the ${state} conversation is missing from the 390px strip; visible: ${visible}`);
        }
        await chip.click({ force: true });
        await phone.waitForTimeout(1500);
        /* The phone folds the pane's meta row (ops chips, account badge)
           behind the details disclosure — reachability on this surface is
           exactly that one tap, so take it before reading the facts. */
        const details = phone.locator('button[aria-label="Show conversation details"]').first();
        if (await details.count()) {
          await details.click({ force: true });
          await phone.waitForTimeout(400);
        }
        /* Title stability: whatever the operational state, the conversation
           still answers to its title on the focused surface. */
        const titleShown = await phone.evaluate(
          (title) => (document.body.textContent ?? "").includes(title),
          seed.title.slice(0, 30),
        );
        must(titleShown, `the ${state} 390px view lost the conversation title`);
        const observed = await phone.evaluate((expectation) => {
          const kindOf = () => document.querySelector("[data-card-status]")?.getAttribute("data-card-status") ?? null;
          if (expectation.startsWith("status:")) {
            return { ok: kindOf() === expectation.slice("status:".length), detail: kindOf() };
          }
          if (expectation === "wakeup") {
            const chipNode = document.querySelector("[data-wakeup]");
            return { ok: Boolean(chipNode), detail: chipNode?.getAttribute("title") ?? chipNode?.getAttribute("aria-label") ?? null };
          }
          if (expectation === "rate-limit") {
            const chipNode = document.querySelector("[data-rate-limited]");
            return { ok: Boolean(chipNode), detail: chipNode?.getAttribute("title") ?? null };
          }
          if (expectation.startsWith("text:")) {
            const needle = expectation.slice("text:".length);
            return { ok: (document.body.textContent ?? "").includes(needle), detail: needle };
          }
          if (expectation.startsWith("account:")) {
            /* The 390px account chip is a letter circle; the full account id
               rides its aria-label ("Open accounts for <id>"). */
            const badge = document.querySelector("[data-conversation-account-chip]");
            const face = `${badge?.getAttribute("aria-label") ?? ""} ${(badge?.textContent ?? "").trim()}`;
            return { ok: face.includes(expectation.slice("account:".length)), detail: face.trim() };
          }
          /* quiet: no status word and no operational chips anywhere. */
          const noisy = document.querySelector("[data-card-status], [data-wakeup], [data-rate-limited], [data-card-switch]");
          return { ok: !noisy, detail: noisy?.tagName ?? null };
        }, verify);
        must(observed.ok, `the ${state} 390px view failed its check (${verify}; saw ${String(observed.detail)})`);
        summary[`mobile-390-${state}-${scheme}`] = { verify, detail: observed.detail, titleShown: true };
        await phone.screenshot({ path: path.join(OUT_DIR, `964-mobile-390-${state}-${scheme}.png`) });
      }
      await phone.close();
    }

    const evidenceDir = path.join(repoRoot, "evidence", "issue-964");
    fs.mkdirSync(evidenceDir, { recursive: true });
    /* Committed summary: fixture ids trimmed, synthetic home scrubbed in raw
       and slug-encoded form — a publication surface carries only $HOME-relative
       paths. */
    const scrubbed = JSON.stringify(summary, null, 2)
      .replaceAll("-1111-4111-8111-111111111111", "")
      .replaceAll(projectSlug(HOME), "$HOME")
      .replaceAll(HOME, "$HOME");
    fs.writeFileSync(path.join(evidenceDir, "card-anatomy.json"), scrubbed + "\n", "utf8");
    console.log(`screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await main();
