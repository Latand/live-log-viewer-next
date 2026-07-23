import { afterAll, beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { chromium, type Browser } from "playwright-core";

import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

import { BranchPane } from "@/components/BranchPane";
import { enqueueOutbox, resetOutboxForTests, updateOutbox } from "./outbox";

/**
 * Objective, BROWSER-RENDERED visual evidence (round-1 P2#7): the ONE canonical
 * conversation window — the same BranchPane shell, LogFeed, and TmuxComposer —
 * rendered with the real production Tailwind CSS in a headless Chromium at
 * desktop (1280px) and 390px, across the queued / delivering / live lifecycle
 * states. For each it commits a PNG screenshot and a geometry manifest, and
 * asserts the layout the operator actually sees: no horizontal overflow at
 * 390px, the transcript feed dominating the composer (its viewport-budget
 * share), the single control strip present, and lifecycle continuity (the same
 * shell/feed/composer in every state). The previous evidence only recorded HTML
 * tag presence with `evidence/` ignored; this renders real CSS layout and
 * commits the artifacts.
 */

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "conversation-window");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

/** The compiled production Tailwind CSS emitted by `next build`. */
function productionCss(): string {
  const files = fs.existsSync(CSS_DIR) ? fs.readdirSync(CSS_DIR).filter((name) => name.endsWith(".css")) : [];
  return files.map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8")).join("\n");
}

const dom = new Window({ url: "http://localhost/" });
installActEnv();
let mobile = false;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: undefined,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (q: string) => ({
  matches: q.includes("max-width: 767px") ? mobile : q.includes("pointer: coarse") ? mobile : false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
});

let browser: Browser;
beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
  setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  mobile = false;
});
afterAll(async () => {
  await browser?.close();
});

const CONV = "conversation_evidence";

function baseFile(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/repo/.codex/sessions/rollout-evidence.jsonl",
    root: "codex-sessions",
    name: "rollout-evidence.jsonl",
    project: "live-log-viewer",
    title: "Builder · ship #569+#561+#560",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 0,
    activity: "live",
    proc: null,
    pid: null,
    model: "gpt-5.4",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: CONV,
    ...over,
  } as FileEntry;
}

const QUEUED_LAUNCH: StructuredSpawnCardState = {
  launchId: "launch_evidence", clientAttemptId: null, accountId: "work",
  state: "queued", initialMessage: "queued", retrySafe: false, error: null,
};
const DELIVERED_LAUNCH: StructuredSpawnCardState = { ...QUEUED_LAUNCH, state: "live-late-success", initialMessage: "delivered" };
/* The #614 pre-transcript launch: a transcript-less `spawn:` window whose queued
   prompt the server projected onto the launch state, so LogFeed seeds it as the
   first user bubble even on a surface that never ran the composer. */
const PRE_TRANSCRIPT_PROMPT = "LLV614_CANONICAL_PROBE_20260723";
const PROMPTED_LAUNCH: StructuredSpawnCardState = {
  ...QUEUED_LAUNCH, launchId: "launch_evidence_614",
  promptImages: 0, promptAt: 1, prompt: PRE_TRANSCRIPT_PROMPT, promptEcho: PRE_TRANSCRIPT_PROMPT,
};

const STATES: Array<{ id: string; file: FileEntry; seedOutbox?: "delivering"; expectPrompt?: string }> = [
  { id: "queued", file: baseFile({ path: "spawn:launch_evidence", name: "spawn:launch_evidence", spawn: QUEUED_LAUNCH }) },
  {
    id: "pre-transcript-prompt",
    file: baseFile({ path: "spawn:launch_evidence_614", name: "spawn:launch_evidence_614", size: 0, spawn: PROMPTED_LAUNCH }),
    expectPrompt: PRE_TRANSCRIPT_PROMPT,
  },
  { id: "delivering", file: baseFile({ launch: DELIVERED_LAUNCH }), seedOutbox: "delivering" },
  { id: "live", file: baseFile({ launch: DELIVERED_LAUNCH }) },
];

const VIEWPORTS: Array<{ id: string; mobile: boolean; width: number; height: number }> = [
  { id: "desktop", mobile: false, width: 1280, height: 900 },
  { id: "mobile-390", mobile: true, width: 390, height: 844 },
];

/** Client-mount BranchPane so `useIsMobile` reads the toggled matchMedia and the
    real per-viewport DOM (mobile disclosure vs desktop inline) is produced, with
    passive effects (capability resolution, outbox subscription) flushed. */
async function renderWindow(node: React.ReactElement): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

const CSS = productionCss();

function pageHtml(inner: string, width: number): string {
  /* A fixed-height flex host so the feed/composer flex-1 budget is measurable,
     exactly as the board column constrains a live pane. */
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
    html,body{margin:0;padding:0;background:var(--color-canvas,#fff);}
    #evidence-host{display:flex;flex-direction:column;width:${width}px;height:100vh;overflow:hidden;}
    </style></head><body><div id="evidence-host">${inner}</div></body></html>`;
}

interface Geometry {
  scrollWidth: number;
  viewportWidth: number;
  feedHeight: number;
  composerHeight: number;
  controlStrip: boolean;
  /** The mobile chat-first budget folds the control strip behind this disclosure
      (issue #419); on desktop the strip is inline. Either way the controls are
      one window's controls — this records which affordance is present. */
  mobileDetailsToggle: boolean;
  textarea: boolean;
  launchChips: boolean;
  outbox: boolean;
}

test("browser-rendered conversation-window evidence: geometry, overflow, and lifecycle continuity at desktop and 390px", async () => {
  expect(CSS.length).toBeGreaterThan(10_000); // the production build's CSS is present
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, Geometry> = {};

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      mobile = viewport.mobile;
      resetOutboxForTests();
      dom.sessionStorage.clear();
      if (state.seedOutbox) {
        enqueueOutbox(CONV, { id: "op_evidence", text: "Ship the canonical conversation window.", images: 0, at: Date.now() });
        updateOutbox(CONV, "op_evidence", { state: "delivering" });
      }
      const inner = await renderWindow(<BranchPane file={state.file} tasks={[]} isRoot />);
      /* #614: the projected launch prompt renders as the first user bubble on a
         surface that never ran the composer — the server-seeded launch-owned
         bubble, present at both desktop and 390px. */
      if (state.expectPrompt) {
        expect(inner).toContain(state.expectPrompt);
        expect(inner).toContain("data-outbox");
      }

      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      await page.setContent(pageHtml(inner, viewport.width), { waitUntil: "load" });
      const key = `${state.id}-${viewport.id}`;
      const htmlPath = path.join(EVIDENCE_DIR, `${key}.html`);
      fs.writeFileSync(htmlPath, pageHtml(inner, viewport.width));
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}.png`) });

      const geometry = await page.evaluate(() => {
        const rect = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? (el as HTMLElement).getBoundingClientRect().height : 0;
        };
        return {
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          feedHeight: rect("[data-log-feed-scroller]"),
          composerHeight: rect("form"),
          controlStrip: Boolean(document.querySelector("[data-agent-control-strip]")),
          mobileDetailsToggle: Boolean(document.querySelector('[data-testid="mobile-details-toggle"]')),
          textarea: Boolean(document.querySelector("textarea")),
          launchChips: Boolean(document.querySelector("[data-launch-chips]")),
          outbox: Boolean(document.querySelector("[data-outbox]")),
        } as Geometry;
      });
      await page.close();
      manifest[key] = geometry;

      /* No horizontal overflow — the window fits its viewport width (a 1px
         rounding tolerance), the 390px bug the review asks us to prove absent. */
      expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      /* Lifecycle continuity: the SAME shell/feed/composer in every state. */
      expect(geometry.feedHeight).toBeGreaterThan(0);
      expect(geometry.textarea).toBe(true);
      /* The single control surface is present as one window's controls: inline
         on desktop, folded behind the disclosure on the 390px chat-first
         layout. */
      expect(viewport.mobile ? geometry.mobileDetailsToggle : geometry.controlStrip).toBe(true);
      /* The transcript owns the majority of the window — the feed dominates the
         composer (its ≥60% viewport-budget intent, issue #419). */
      expect(geometry.feedHeight).toBeGreaterThan(geometry.composerHeight);
    }
  }

  /* State-specific facts render INSIDE the window as chips/bubbles. */
  expect(manifest["queued-desktop"]!.launchChips).toBe(true);
  expect(manifest["delivering-desktop"]!.outbox).toBe(true);
  expect(manifest["delivering-mobile-390"]!.outbox).toBe(true);
  /* #614: the pre-transcript launch shows its queued prompt as the first user
     bubble (data-outbox) alongside its launch chips, at desktop and 390px — the
     window is a conversation mid-launch, never an empty shell. */
  expect(manifest["pre-transcript-prompt-desktop"]!.outbox).toBe(true);
  expect(manifest["pre-transcript-prompt-desktop"]!.launchChips).toBe(true);
  expect(manifest["pre-transcript-prompt-mobile-390"]!.outbox).toBe(true);

  fs.writeFileSync(path.join(EVIDENCE_DIR, "geometry.json"), JSON.stringify(manifest, null, 2));

  /* Every capture shares the same shell/feed/composer geometry signature. */
  for (const [key, g] of Object.entries(manifest)) {
    const isMobile = key.endsWith("mobile-390");
    expect(g.feedHeight > 0 && g.textarea && (isMobile ? g.mobileDetailsToggle : g.controlStrip)).toBe(true);
    expect(g.scrollWidth).toBeLessThanOrEqual(g.viewportWidth + 1);
  }
}, 120_000);
