import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

import { BranchPane } from "@/components/BranchPane";
import { enqueueOutbox, resetOutboxForTests, updateOutbox } from "./outbox";

/**
 * Objective visual evidence (issue #569 + #561 + #560): ONE conversation window
 * — the same BranchPane shell, LogFeed, and TmuxComposer — renders queued,
 * delivering, and live lifecycle states, at desktop and 390px. This captures
 * each production-shaped state to `evidence/conversation-window/*.html` and
 * proves, by DOM, that the shell/feed/composer are literally the same window in
 * every state (a full-browser screenshot pipeline needs a chromium/Docker image
 * that is not available in this sandbox; the rendered HTML is the artifact).
 */

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "conversation-window");

const dom = new Window({ url: "http://localhost/" });
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
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: query.includes("max-width: 767px") ? mobile : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
  setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  mobile = false;
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
  launchId: "launch_evidence",
  clientAttemptId: null,
  accountId: "work",
  state: "queued",
  initialMessage: "queued",
  retrySafe: false,
  error: null,
};

const DELIVERED_LAUNCH: StructuredSpawnCardState = { ...QUEUED_LAUNCH, state: "live-late-success", initialMessage: "delivered" };

/* The three lifecycle states of ONE window (issue #569). */
const STATES: Array<{ id: string; file: FileEntry; seedOutbox?: "delivering" }> = [
  // Queued: the launch placeholder — no transcript yet, launch chips inside the feed.
  { id: "queued", file: baseFile({ path: "spawn:launch_evidence", name: "spawn:launch_evidence", spawn: QUEUED_LAUNCH }) },
  // Delivering: a materialized conversation with the operator's first message
  // optimistically in the queue, being delivered.
  { id: "delivering", file: baseFile({ launch: DELIVERED_LAUNCH }), seedOutbox: "delivering" },
  // Live: the same conversation, launch facts still shown as transient chips.
  { id: "live", file: baseFile({ launch: DELIVERED_LAUNCH }) },
];

const VIEWPORTS: Array<{ id: string; mobile: boolean }> = [
  { id: "desktop", mobile: false },
  { id: "mobile-390", mobile: true },
];

function render(node: React.ReactElement): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  const html = host.innerHTML;
  flushSync(() => root.unmount());
  host.remove();
  return html;
}

/** The shell/feed/composer signature that must be identical across states. */
function windowSignature(html: string): { shell: boolean; feed: boolean; composer: boolean } {
  return {
    shell: html.includes('data-link-path='),
    feed: html.includes("data-log-feed-scroller"),
    composer: html.includes("<textarea") && html.includes("<form"),
  };
}

test("the same conversation window renders queued, delivering, and live at desktop and 390px", () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const manifest: Record<string, { shell: boolean; feed: boolean; composer: boolean; bytes: number }> = {};

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      mobile = viewport.mobile;
      resetOutboxForTests();
      dom.sessionStorage.clear();
      if (state.seedOutbox) {
        enqueueOutbox(CONV, { id: "msg_evidence", text: "Ship the canonical conversation window.", images: 0, at: Date.now() });
        updateOutbox(CONV, "msg_evidence", { state: "delivering" });
      }
      const html = render(<BranchPane file={state.file} tasks={[]} isRoot />);
      const key = `${state.id}-${viewport.id}`;
      const signature = windowSignature(html);
      manifest[key] = { ...signature, bytes: html.length };
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, `${key}.html`),
        `<!doctype html><meta charset="utf-8"><title>${key}</title><body>${html}</body>`,
      );

      /* Every lifecycle state is the SAME window: shell, feed, and composer are
         all present — never a status-only card that hides the conversation. */
      expect(signature).toEqual({ shell: true, feed: true, composer: true });
    }
  }

  /* The launch/queue facts render INSIDE that window as compact chips/bubbles,
     not as a replacement surface. */
  const queued = fs.readFileSync(path.join(EVIDENCE_DIR, "queued-desktop.html"), "utf8");
  expect(queued).toContain('data-launch-chips="true"');
  expect(queued).toContain('data-launch-state="queued"');

  const delivering = fs.readFileSync(path.join(EVIDENCE_DIR, "delivering-desktop.html"), "utf8");
  expect(delivering).toContain('data-outbox-state="delivering"');
  expect(delivering).toContain('data-launch-state="live-late-success"');

  const live = fs.readFileSync(path.join(EVIDENCE_DIR, "live-mobile-390.html"), "utf8");
  expect(live).toContain("data-log-feed-scroller");
  expect(live).toContain("<textarea");

  fs.writeFileSync(path.join(EVIDENCE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  /* The manifest is the objective proof: all six captures carry the identical
     shell/feed/composer signature. */
  for (const [, signature] of Object.entries(manifest)) {
    expect(signature.shell && signature.feed && signature.composer).toBe(true);
  }
});
