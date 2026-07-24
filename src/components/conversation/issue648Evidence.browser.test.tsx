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
import { resetOutboxForTests } from "./outbox";

/**
 * Browser-rendered evidence for issue #648: a structured / MCP spawn's launch
 * bubble that the transcript echo can NEVER retire — its first user record is
 * journaled with SDK / agent provenance, so it renders as a system row, not a
 * `user` echo. Before the fix such a bubble spun on "Доставляється" (delivering)
 * forever. The server projects the delivery receipt (`initialMessage:"delivered"`
 * + `deliveredAt`), and the client settles the launch bubble to `delivered`
 * INDEPENDENT of any echo, so it renders delivered and retires on the delivered
 * TTL. This captures the receipt-settled-no-echo window (and a delivering
 * control) at desktop (1280×900) and 390px, with the real production CSS.
 */

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "issue-648");
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
const originalDateNow = Date.now;
/** Fixed clock: the launch settled 3s after it was submitted, well inside the
    delivered TTL, so the settled bubble renders (as delivered) at capture. */
const NOW = Date.parse("2026-07-24T10:38:30.000Z");
const PROMPT_AT = Date.parse("2026-07-24T10:38:21.000Z");
const DELIVERED_AT = Date.parse("2026-07-24T10:38:24.240Z");

beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
  setLocale("uk");
  Date.now = () => NOW;
});
afterEach(() => {
  document.body.replaceChildren();
  mobile = false;
});
afterAll(async () => {
  await browser?.close();
  Date.now = originalDateNow;
});

const CONV = "conversation_648_evidence";
/* A structured launch whose transcript echo never matches: the prompt is the
   plain operator draft, and the transcript (absent here) would journal it as a
   system row, so ONLY the delivery receipt can settle the bubble. Synthetic
   prompt text — no real operator content in committed evidence. */
const LAUNCH_PROMPT = "Прочитай синтетичну розмову у файлі-фікстурі та підсумуй її";

function baseFile(over: Partial<FileEntry>): FileEntry {
  return {
    path: "spawn:launch_648_evidence",
    root: "claude-projects",
    name: "spawn:launch_648_evidence",
    project: "live-log-viewer",
    title: "Builder · settle the launch bubble (#648)",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 0,
    activity: "live",
    proc: null,
    pid: null,
    model: "claude-opus-4-8",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: CONV,
    ...over,
  } as FileEntry;
}

const DELIVERING_LAUNCH: StructuredSpawnCardState = {
  launchId: "launch_648_evidence", clientAttemptId: null, accountId: "acct_evidence",
  state: "queued", initialMessage: "queued", retrySafe: false, error: null,
  promptImages: 0, promptAt: PROMPT_AT, prompt: LAUNCH_PROMPT, promptEcho: LAUNCH_PROMPT,
};
/* The #648 fix: the delivery receipt reports delivered with its timestamp, so
   the launch bubble settles to `delivered` even though no echo ever matches. */
const RECEIPT_SETTLED_LAUNCH: StructuredSpawnCardState = {
  ...DELIVERING_LAUNCH,
  state: "recovered", initialMessage: "delivered", deliveredAt: DELIVERED_AT,
};

const STATES: Array<{ id: string; launch: StructuredSpawnCardState; expectState: "delivering" | "delivered" }> = [
  { id: "delivering-control", launch: DELIVERING_LAUNCH, expectState: "delivering" },
  { id: "receipt-settled-no-echo", launch: RECEIPT_SETTLED_LAUNCH, expectState: "delivered" },
];

const VIEWPORTS: Array<{ id: string; mobile: boolean; width: number; height: number }> = [
  { id: "desktop", mobile: false, width: 1280, height: 900 },
  { id: "mobile-390", mobile: true, width: 390, height: 844 },
];

async function renderWindow(node: React.ReactElement): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  /* A second flush so the launch-seed effect and the delivered-receipt
     settlement effect both run and the outbox re-renders. */
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

const CSS = productionCss();

function pageHtml(inner: string, width: number): string {
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
  textarea: boolean;
  outboxEntries: number;
  outboxState: string;
  statusLabel: string;
  promptVisible: boolean;
}

test("issue 648 evidence: a delivery-receipt-settled launch bubble renders delivered (never delivering forever) at desktop and 390px", async () => {
  expect(CSS.length).toBeGreaterThan(10_000); // the production build's CSS is present
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, Geometry> = {};

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      mobile = viewport.mobile;
      resetOutboxForTests();
      dom.sessionStorage.clear();

      const inner = await renderWindow(<BranchPane file={baseFile({ launch: state.launch })} tasks={[]} isRoot />);
      /* The launch prompt renders as the conversation's first optimistic bubble
         on every surface (issue #614), delivering or delivered. */
      expect(inner).toContain(LAUNCH_PROMPT);
      expect(inner).toContain("data-outbox");

      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      await page.setContent(pageHtml(inner, viewport.width), { waitUntil: "load" });
      const key = `${state.id}-${viewport.id}`;
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${key}.html`), pageHtml(inner, viewport.width));
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}.png`) });

      const geometry = await page.evaluate((prompt) => {
        const rect = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? (el as HTMLElement).getBoundingClientRect().height : 0;
        };
        const entry = document.querySelector<HTMLElement>("[data-outbox-entry]");
        const status = document.querySelector<HTMLElement>("[data-outbox-status]");
        return {
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          feedHeight: rect("[data-log-feed-scroller]"),
          composerHeight: rect("form"),
          textarea: Boolean(document.querySelector("textarea")),
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          outboxState: entry?.dataset.outboxState ?? "",
          statusLabel: status?.textContent ?? "",
          promptVisible: document.body.textContent?.includes(prompt) === true,
        } as Geometry;
      }, LAUNCH_PROMPT);
      await page.close();
      manifest[key] = geometry;

      /* No horizontal overflow at either width (the 390px contract). */
      expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      /* The one shell/feed/composer, transcript-dominant. */
      expect(geometry.feedHeight).toBeGreaterThan(0);
      expect(geometry.textarea).toBe(true);
      expect(geometry.feedHeight).toBeGreaterThan(geometry.composerHeight);
      /* Exactly one launch bubble, in the expected lifecycle state. */
      expect(geometry.outboxEntries).toBe(1);
      expect(geometry.outboxState).toBe(state.expectState);
      expect(geometry.promptVisible).toBe(true);
    }
  }

  /* The heart of #648: the receipt-settled launch reads DELIVERED, not the
     eternal delivering ghost — at desktop and at 390px. */
  expect(manifest["receipt-settled-no-echo-desktop"]!.outboxState).toBe("delivered");
  expect(manifest["receipt-settled-no-echo-desktop"]!.statusLabel).toContain("Доставлено");
  expect(manifest["receipt-settled-no-echo-mobile-390"]!.outboxState).toBe("delivered");
  expect(manifest["receipt-settled-no-echo-mobile-390"]!.statusLabel).toContain("Доставлено");
  /* The control proves the contrast: an un-settled launch still reads delivering. */
  expect(manifest["delivering-control-desktop"]!.outboxState).toBe("delivering");
  expect(manifest["delivering-control-desktop"]!.statusLabel).toContain("Доставляється");

  fs.writeFileSync(path.join(EVIDENCE_DIR, "geometry.json"), JSON.stringify(manifest, null, 2));

  for (const [key, g] of Object.entries(manifest)) {
    expect(g.scrollWidth).toBeLessThanOrEqual(g.viewportWidth + 1);
    expect(g.feedHeight > 0 && g.textarea).toBe(true);
    expect(key.includes("receipt-settled") ? g.outboxState === "delivered" : true).toBe(true);
  }
});
