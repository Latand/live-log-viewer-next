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
 * Browser-rendered evidence for issue #653 (defect 1): a launch bubble keyed to a
 * DIFFERENT conversation must never leak into an unrelated pane — the exact
 * production failure where a failed reviewer spawn's "Доставляється" bubble
 * appeared inside the #621 voice builder's pane after that pane's own structured
 * entry went dead. Pane ownership is now keyed on the durable conversation id, so
 * a foreign launch (its `conversationId` differs from this pane's) is neither
 * seeded nor rendered. A same-conversation launch (the control) still renders.
 * Captured at desktop (1280×900) and 390px with the real production CSS.
 */

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "issue-653");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

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
const NOW = Date.parse("2026-07-24T11:58:00.000Z");
const PROMPT_AT = Date.parse("2026-07-24T08:07:37.000Z");

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

/* The pane's own conversation (issue #621 voice builder), whose structured entry
   went dead at the deploy cutover. */
const PANE_CONVERSATION = "conversation_0d5a6c49";
/* The foreign reviewer conversation (PR #618 round 2) whose failed spawn owns the
   leaked launch bubble. Synthetic prompt text — no real operator content. */
const FOREIGN_CONVERSATION = "conversation_64a866e0";
const FOREIGN_PROMPT = "Fresh-context review, round 2, for PR #618 (synthetic fixture text)";

function baseFile(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/repo/pipeline-f8c801d8/00031cd0.jsonl",
    root: "claude-projects",
    name: "00031cd0.jsonl",
    project: "live-log-viewer",
    title: "Builder · voice (#621)",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 0,
    /* The pane's own structured entry is dead (the deploy cutover). */
    activity: "idle",
    activityReason: "registry_terminal",
    proc: "killed",
    pid: null,
    model: "claude-opus-4-8",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: PANE_CONVERSATION,
    ...over,
  } as FileEntry;
}

/* The leaked bubble as the server projects it onto a launch card: a failed
   reviewer spawn whose durable conversation is the FOREIGN one. */
const FOREIGN_LAUNCH: StructuredSpawnCardState = {
  launchId: "launch_653_foreign",
  clientAttemptId: null, accountId: "acct_reviewer", conversationId: FOREIGN_CONVERSATION,
  state: "queued", initialMessage: "queued", retrySafe: false, error: null,
  promptImages: 0, promptAt: PROMPT_AT, prompt: FOREIGN_PROMPT, promptEcho: FOREIGN_PROMPT,
};
/* The control: the SAME launch facts, but owned by this pane's conversation. It
   is a legitimate delivering launch bubble and must render. */
const OWN_LAUNCH: StructuredSpawnCardState = {
  ...FOREIGN_LAUNCH, conversationId: PANE_CONVERSATION,
};

const STATES: Array<{ id: string; file: FileEntry; expectEntries: number }> = [
  { id: "foreign-leak-suppressed", file: baseFile({ launch: FOREIGN_LAUNCH }), expectEntries: 0 },
  { id: "own-launch-renders", file: baseFile({ launch: OWN_LAUNCH }), expectEntries: 1 },
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
  outboxEntries: number;
  foreignPromptVisible: boolean;
}

test("issue 653 evidence: a foreign launch bubble never leaks into a dead-entry pane at desktop and 390px", async () => {
  expect(CSS.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, Geometry> = {};

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      mobile = viewport.mobile;
      resetOutboxForTests();
      dom.sessionStorage.clear();

      const inner = await renderWindow(<BranchPane file={state.file} tasks={[]} isRoot />);

      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      await page.setContent(pageHtml(inner, viewport.width), { waitUntil: "load" });
      const key = `${state.id}-${viewport.id}`;
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${key}.html`), pageHtml(inner, viewport.width));
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}.png`) });

      const geometry = await page.evaluate((prompt) => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          foreignPromptVisible: document.body.textContent?.includes(prompt) === true,
        } as Geometry;
      }, FOREIGN_PROMPT);
      await page.close();
      manifest[key] = geometry;

      expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.outboxEntries).toBe(state.expectEntries);
    }
  }

  /* The heart of #653: the foreign bubble is gone from the dead pane at both
     widths, while the same launch owned by this pane still renders. */
  expect(manifest["foreign-leak-suppressed-desktop"]!.outboxEntries).toBe(0);
  expect(manifest["foreign-leak-suppressed-desktop"]!.foreignPromptVisible).toBe(false);
  expect(manifest["foreign-leak-suppressed-mobile-390"]!.outboxEntries).toBe(0);
  expect(manifest["foreign-leak-suppressed-mobile-390"]!.foreignPromptVisible).toBe(false);
  expect(manifest["own-launch-renders-desktop"]!.outboxEntries).toBe(1);
  expect(manifest["own-launch-renders-desktop"]!.foreignPromptVisible).toBe(true);

  fs.writeFileSync(path.join(EVIDENCE_DIR, "geometry.json"), JSON.stringify(manifest, null, 2));
});
