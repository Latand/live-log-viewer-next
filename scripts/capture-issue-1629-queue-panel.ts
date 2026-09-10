/**
 * Rendered acceptance for the native Codex queue panel (#1629), in a real
 * browser against the real stylesheet:
 *
 *   bun run build && bun scripts/capture-issue-1629-queue-panel.ts
 *
 * The DOM tests answer what the panel DOES — which command a control admits,
 * which row goes busy, what a refusal says. They cannot answer whether the
 * operator can use it: happy-dom applies no stylesheet, so it has nothing to say
 * about whether the controls are reachable, whether a row that cannot be changed
 * is visibly different from one that can, or whether a refusal is legible.
 *
 * It measures, in the page:
 *
 *   - that every row Codex is holding is rendered, in Codex's order, with its
 *     controls inside the panel and large enough to hit;
 *   - that a row which cannot be changed offers no controls and says why, in
 *     text the reader can actually see;
 *   - that a refusal is legible and distinct from the ordinary row status, so
 *     "Codex refused this" is not read as another queued message;
 *   - that the two controls the runtime's own rules make load-bearing are
 *     REACHABLE AND HITTABLE: the header's queue-level start, and the one action
 *     a withdrawn payload has (a start naming that entry), which is the only
 *     route back for words that survived a steer that did not land;
 *   - that a message the journal has settled is not painted at all — the journal
 *     keeps up to 128 of them behind the queue, and the panel is the queue;
 *   - that the panel stays inside its own width — a queue is above the composer,
 *     and one that overflows pushes the field the operator is typing in.
 *
 * Then it proves the reading can go red: the same measurements are taken against
 * pages where the controls have been removed, where the blocked row's
 * explanation has been hidden, and where the refusal has been given the ordinary
 * status colour. A run where any of those still reads as "usable" exits non-zero.
 *
 * Frames and the measurement JSON land outside the repository, under
 * <BOARD_CAPTURE_DIR>/<unique-run>/out. Nothing is served from the operator's
 * state, nothing is deployed, and no path from this machine reaches a frame.
 */
import fs from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";

import { NativeQueuePanel } from "../src/components/NativeQueuePanel";
import { projectNativeQueue } from "../src/components/nativeQueueView";
import type { NativeQueueRecord } from "../src/lib/runtime/nativeQueueContracts";
import { translate, type TFunction } from "../src/lib/i18n";
import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "BOARD_CAPTURE_DIR",
  prefix: "llv-issue-1629",
  raw: process.env.BOARD_CAPTURE_DIR,
  repoRoot,
});
const OUT_DIR = path.join(BASE, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const t: TFunction = (key, params) => translate("en", key, params);

function entry(id: string, text: string, overrides: Partial<NativeQueueRecord> = {}): NativeQueueRecord {
  return {
    entryId: id,
    conversationId: "conversation_capture",
    binding: { threadId: "thread-capture", accountId: "account-capture" },
    clientUserMessageId: `client-${id}`,
    nativeSubmissionId: `native-${id}`,
    revision: 1,
    versions: [{ revision: 1, operationId: `op-${id}`, text, images: [], contentDigest: `digest-${id}` }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
    ...overrides,
  };
}

const ENTRIES = [
  entry("one", "Rebase the branch onto main and rerun the focused tests."),
  entry("two", "Then open the pull request with the evidence table."),
  entry("three", "And post the deploy plan once the checks are green.", {
    state: "uncertain",
    reason: "native queue mutation outcome is unknown; no mutation was retried",
  }),
  entry("four", "Say in the thread that the rehearsal passed.", { state: "withdrawn", nativeSubmissionId: null }),
  /* Settled, and therefore not part of the queue at all. It is here so the
     reading can say the panel painted no history, rather than the fixture
     never offering it any. */
  entry("five", "This one was delivered a while ago.", { state: "delivered" }),
];

/** What the panel is expected to paint: the queue, and nothing settled. */
const LIVE_ENTRIES = ENTRIES.filter((row) => row.state !== "delivered");

const ITEMS = ENTRIES.filter((row) => row.nativeSubmissionId !== null && row.state === "queued").map((row) => ({
  id: row.nativeSubmissionId!,
  clientUserMessageId: row.clientUserMessageId,
  input: [{ type: "text" as const, text: row.versions[0]!.text }],
}));

/** The build's own compiled CSS, so the measured colours are the shipped ones. */
function stylesheet(): string {
  const cssDir = path.join(repoRoot, ".next", "static", "css");
  let names: string[];
  try {
    names = fs.readdirSync(cssDir).filter((name) => name.endsWith(".css"));
  } catch {
    throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  }
  if (names.length === 0) throw new Error("no compiled stylesheet under .next/static/css — run `bun run build` first");
  return names.map((name) => fs.readFileSync(path.join(cssDir, name), "utf8")).join("\n");
}

function page(body: string, css: string): string {
  return `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>body{margin:0;background:var(--color-surface,#0b0b0e);padding:24px;}
  #frame{width:520px;}</style>
</head><body><div id="frame">${body}</div></body></html>`;
}

function panelHtml(failure: string | null): string {
  const view = projectNativeQueue({ entries: ENTRIES, native: { threadId: "thread-capture", items: ITEMS, stale: false }, turn: "idle" });
  const markup = renderToStaticMarkup(createElement(NativeQueuePanel, {
    view,
    loading: false,
    error: null,
    thread: { model: "gpt-6-astra", effort: "high" },
    mintKey: () => "capture",
    submit: async () => ({ ok: true }),
    onRefresh: () => undefined,
    t,
  }));
  /* The refusal row is state the server-rendered markup cannot reach, so it is
     rendered in the same shape the component paints it. */
  return failure
    ? markup.replace(
      "</section>",
      `<p data-testid="native-queue-failure" role="alert" class="border-t border-danger/30 bg-danger/5 px-2 py-1 text-caption text-danger">${failure}</p></section>`,
    )
    : markup;
}

interface Reading {
  rows: number;
  /** The panel must paint the queue and no settled history. */
  settledRowsPainted: number;
  /** The smallest side of the header's queue-level start control, in px. */
  headerStartPx: number;
  /** The controls a withdrawn row offers: exactly its one start. */
  withdrawnRowControls: number;
  withdrawnStartPx: number;
  controlsInsidePanel: boolean;
  smallestControlPx: number;
  blockedRowHasControls: boolean;
  /** The fewest controls any row the operator may still change is offering. */
  smallestActionableRowControls: number;
  blockedReasonVisible: boolean;
  blockedReasonColour: string;
  statusColour: string;
  failureColour: string;
  failureVisible: boolean;
  withinWidth: boolean;
}

const READ = () => {
  const panel = document.querySelector('[data-testid="native-queue-panel"]') as HTMLElement | null;
  const frame = document.querySelector("#frame") as HTMLElement;
  if (!panel) {
    return {
      rows: 0, settledRowsPainted: 0, headerStartPx: 0, withdrawnRowControls: 0, withdrawnStartPx: 0,
      controlsInsidePanel: false, smallestControlPx: 0, blockedRowHasControls: true,
      smallestActionableRowControls: 0,
      blockedReasonVisible: false, blockedReasonColour: "", statusColour: "", failureColour: "",
      failureVisible: false, withinWidth: false,
    };
  }
  const panelBox = panel.getBoundingClientRect();
  const rows = [...panel.querySelectorAll('[data-testid="native-queue-row"]')] as HTMLElement[];
  const controls = [...panel.querySelectorAll("button")] as HTMLElement[];
  const boxes = controls.map((control) => control.getBoundingClientRect());
  const blocked = rows.find((row) => row.getAttribute("data-state") === "uncertain");
  const blockedStatus = blocked?.querySelector('[data-testid="native-queue-row-status"]') as HTMLElement | null;
  const anyStatus = rows[0]?.querySelector('[data-testid="native-queue-row-status"]') as HTMLElement | null;
  const failure = document.querySelector('[data-testid="native-queue-failure"]') as HTMLElement | null;
  const failureBox = failure?.getBoundingClientRect();
  const headerStart = panel.querySelector('[data-testid="native-queue-start"]') as HTMLElement | null;
  const headerBox = headerStart?.getBoundingClientRect();
  const withdrawn = rows.find((row) => row.getAttribute("data-state") === "withdrawn");
  const withdrawnStart = withdrawn?.querySelector('[data-testid="native-queue-row-start"]') as HTMLElement | null;
  const withdrawnBox = withdrawnStart?.getBoundingClientRect();
  return {
    rows: rows.length,
    settledRowsPainted: rows.filter((row) => ["delivered", "removed", "refused"].includes(row.getAttribute("data-state") ?? "")).length,
    headerStartPx: headerBox ? Math.min(headerBox.width, headerBox.height) : 0,
    withdrawnRowControls: withdrawn ? withdrawn.querySelectorAll("button").length : 0,
    withdrawnStartPx: withdrawnBox ? Math.min(withdrawnBox.width, withdrawnBox.height) : 0,
    controlsInsidePanel: boxes.every((box) => box.top >= panelBox.top - 1 && box.bottom <= panelBox.bottom + 1
      && box.left >= panelBox.left - 1 && box.right <= panelBox.right + 1),
    smallestControlPx: boxes.length ? Math.min(...boxes.map((box) => Math.min(box.width, box.height))) : 0,
    blockedRowHasControls: blocked ? blocked.querySelectorAll("button").length > 0 : true,
    smallestActionableRowControls: Math.min(...rows
      .filter((row) => row.getAttribute("data-state") === "queued")
      .map((row) => row.querySelectorAll("button").length), Number.POSITIVE_INFINITY),
    blockedReasonVisible: Boolean(blockedStatus
      && blockedStatus.getBoundingClientRect().height > 0
      && (blockedStatus.textContent ?? "").includes("Cannot be changed")),
    blockedReasonColour: blockedStatus ? getComputedStyle(blockedStatus).color : "",
    statusColour: anyStatus ? getComputedStyle(anyStatus).color : "",
    failureColour: failure ? getComputedStyle(failure).color : "",
    failureVisible: Boolean(failureBox && failureBox.width > 0 && failureBox.height > 0),
    withinWidth: panelBox.right <= frame.getBoundingClientRect().right + 1,
  };
};

function holds(reading: Reading): boolean {
  return reading.rows === LIVE_ENTRIES.length
    && reading.settledRowsPainted === 0
    /* The header's queue-level start, and the withdrawn payload's own one: both
       are controls the runtime admits and the panel used not to offer at all. */
    && reading.headerStartPx >= 12
    && reading.withdrawnRowControls === 1
    && reading.withdrawnStartPx >= 12
    && reading.controlsInsidePanel
    && reading.smallestControlPx >= 12
    /* Edit, remove, send now, and at least one move: a row the operator may
       change has to actually offer the controls the projection says it has. */
    && reading.smallestActionableRowControls >= 4
    && !reading.blockedRowHasControls
    && reading.blockedReasonVisible
    && reading.withinWidth
    && reading.failureVisible
    && reading.failureColour !== reading.statusColour;
}

/** Best effort, and said so in the record: the verdicts rest on rectangles and
    computed styles, and a shell that cannot encode a frame must not turn a green
    measurement into a failed run. */
async function frame(view: import("playwright-core").Page, name: string): Promise<boolean> {
  try {
    await view.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const css = stylesheet();
  let browser: Browser | undefined;
  const measurements: Record<string, unknown> = {};
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
    });
    const context = await browser.newContext({ viewport: { width: 620, height: 640 }, reducedMotion: "no-preference" });
    const view = await context.newPage();

    await view.setContent(page(panelHtml("Codex refused this change: the queued message was already dispatched."), css), { waitUntil: "load" });
    const live = await view.evaluate(READ) as Reading;
    measurements.frames = await frame(view, "queue");
    measurements.queue = live;

    /* RED PATHS. Each reintroduces a defect in the page and must be caught. */
    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => { for (const button of document.querySelectorAll('[data-testid="native-queue-row"] button')) button.remove(); });
    measurements.redNoControls = await view.evaluate(READ) as Reading;

    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => {
      const blocked = document.querySelector('[data-state="uncertain"] [data-testid="native-queue-row-status"]') as HTMLElement | null;
      if (blocked) blocked.style.display = "none";
    });
    measurements.redReasonHidden = await view.evaluate(READ) as Reading;

    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => {
      const failure = document.querySelector('[data-testid="native-queue-failure"]') as HTMLElement | null;
      const status = document.querySelector('[data-testid="native-queue-row-status"]') as HTMLElement | null;
      if (failure && status) failure.style.color = getComputedStyle(status).color;
    });
    measurements.redFailureIndistinct = await view.evaluate(READ) as Reading;

    /* The queue-level start taken away again: the header control the panel
       offered for as long as the parser was rejecting it. */
    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => { document.querySelector('[data-testid="native-queue-start"]')?.remove(); });
    measurements.redNoQueueStart = await view.evaluate(READ) as Reading;

    /* And the withdrawn payload stranded again: its row present, its one route
       back gone, which is exactly what the panel used to render. */
    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => {
      for (const button of document.querySelectorAll('[data-state="withdrawn"] button')) button.remove();
    });
    measurements.redWithdrawnStranded = await view.evaluate(READ) as Reading;

    /* And a settled message painted back into the queue. */
    await view.setContent(page(panelHtml("Codex refused this change."), css), { waitUntil: "load" });
    await view.evaluate(() => {
      const row = document.querySelector('[data-testid="native-queue-row"]');
      const clone = row?.cloneNode(true) as HTMLElement | undefined;
      if (clone && row) { clone.setAttribute("data-state", "delivered"); row.parentElement?.append(clone); }
    });
    measurements.redHistoryPainted = await view.evaluate(READ) as Reading;

    const greens = holds(live);
    const reds = [measurements.redNoControls, measurements.redReasonHidden, measurements.redFailureIndistinct,
      measurements.redNoQueueStart, measurements.redWithdrawnStranded, measurements.redHistoryPainted]
      .map((reading) => holds(reading as Reading));
    measurements.verdict = { queueHolds: greens, redPathsCaught: reds.map((held) => !held) };
    fs.writeFileSync(path.join(OUT_DIR, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
    console.log(JSON.stringify(measurements.verdict));
    console.log(`frames and measurements: ${OUT_DIR}`);
    return greens && reds.every((held) => !held) ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

process.exit(await main());
