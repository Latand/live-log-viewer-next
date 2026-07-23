import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { chromium, type Browser } from "playwright-core";

import { FeedItem } from "@/components/feed/FeedItem";
import {
  createFeedSession,
  type FeedEntry,
} from "@/components/feed/parse";
import { RawLineProvider } from "@/components/feed/rawLine";
import {
  applyEvent,
  installSnapshot,
  type RuntimeEnvelope,
  type RuntimeSession,
  type RuntimeSnapshot,
  type RuntimeStore,
} from "@/components/runtime/runtimeModel";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

import { LaunchChips } from "./LaunchChips";
import { LiveTurnRows } from "./LiveTurnRows";
import { OutboxBubblesView } from "./OutboxBubbles";
import { visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";
import type { OutboxEntry } from "./outbox";

interface LifecycleFixture {
  identity: {
    conversationId: string;
    launchId: string;
    startingPath: string;
    adoptedPath: string;
  };
  fileCheckpoints: Array<{
    name: string;
    filesRevision: number;
    path: string;
  }>;
  runtimeEnvelopes: RuntimeEnvelope[];
  transcriptRecords: unknown[];
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dir, "fixtures", "issue-626-lifecycle.json"),
  "utf8",
)) as LifecycleFixture;
const EVIDENCE_DIR = path.join(process.cwd(), "docs", "media", "issue-626");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

function productionCss(): string {
  if (!fs.existsSync(CSS_DIR)) return "";
  return fs.readdirSync(CSS_DIR)
    .filter((name) => name.endsWith(".css"))
    .map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8"))
    .join("\n");
}

function runtimeSession(): RuntimeSession {
  return {
    conversationId: fixture.identity.conversationId,
    sessionKey: { engine: "codex", sessionId: "session_issue_626" },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "work",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/workspace",
    artifactPath: null,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    liveTurn: null,
  };
}

function runtimeSnapshot(): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 40,
    sessions: [runtimeSession()],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

function runtimeAt(envelopeCount: number): RuntimeStore {
  let store = installSnapshot(runtimeSnapshot());
  for (const envelope of fixture.runtimeEnvelopes.slice(0, envelopeCount)) {
    const result = applyEvent(store, envelope);
    if (result.outcome !== "applied") throw new Error(`runtime replay ${result.outcome}`);
    store = result.store;
  }
  return store;
}

function feedAt(recordCount: number): FeedEntry[] {
  const snapshot = createFeedSession({
    engine: "codex",
    fmt: "codex",
    showSvc: false,
    lineFilter: "",
  }).feed(
    fixture.transcriptRecords.slice(0, recordCount).map((record) => JSON.stringify(record)),
    0,
    false,
  );
  return snapshot.items.map((entry) => entry.item.kind === "tool"
    ? { ...entry, item: { ...entry.item, open: true } }
    : entry);
}

const launchPrompt = "Investigate issue 626.";
const outboxEntry: OutboxEntry = {
  id: fixture.identity.launchId,
  text: launchPrompt,
  images: 0,
  at: Date.parse("2026-07-23T09:00:00.000Z"),
  state: "delivering",
  launchOwned: true,
};

interface EvidenceState {
  id: string;
  envelopeCount: number;
  recordCount: number;
  filesRevision: number;
  path: string;
  launch: StructuredSpawnCardState;
  outbox: boolean;
  expectedOrder: string[];
}

const launchBase: StructuredSpawnCardState = {
  launchId: fixture.identity.launchId,
  clientAttemptId: "attempt_issue_626",
  accountId: "work",
  state: "starting",
  initialMessage: "pending",
  retrySafe: false,
  error: null,
  ["prompt"]: launchPrompt,
  promptEcho: launchPrompt,
  promptImages: 0,
  promptAt: Date.parse("2026-07-23T09:00:00.000Z"),
};

const STATES: EvidenceState[] = [
  {
    id: "streaming-before-tool",
    envelopeCount: 2,
    recordCount: 0,
    filesRevision: 40,
    path: fixture.identity.startingPath,
    launch: launchBase,
    outbox: true,
    expectedOrder: ["outbox", "live"],
  },
  {
    id: "refresh-at-tool-transition",
    envelopeCount: 4,
    recordCount: 0,
    filesRevision: 40,
    path: fixture.identity.startingPath,
    launch: { ...launchBase, state: "reconciling", initialMessage: "queued" },
    outbox: true,
    expectedOrder: ["outbox", "live"],
  },
  {
    id: "partial-adoption",
    envelopeCount: 8,
    recordCount: 4,
    filesRevision: 41,
    path: fixture.identity.adoptedPath,
    launch: { ...launchBase, state: "live-late-success", initialMessage: "delivered" },
    outbox: false,
    expectedOrder: ["user", "commentary", "tool", "live"],
  },
  {
    id: "refresh-after-adoption",
    envelopeCount: 10,
    recordCount: fixture.transcriptRecords.length,
    filesRevision: 41,
    path: fixture.identity.adoptedPath,
    launch: { ...launchBase, state: "live-late-success", initialMessage: "delivered" },
    outbox: false,
    expectedOrder: ["user", "commentary", "tool", "commentary"],
  },
];

const VIEWPORTS = [
  { id: "desktop-1280", width: 1280, height: 900 },
  { id: "mobile-390", width: 390, height: 844 },
];

const dom = new Window({ url: "http://localhost/" });
installActEnv();
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
  matches: query.includes("max-width: 767px") || query.includes("pointer: coarse"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

let browser: Browser;

beforeEach(() => {
  setLocale("en");
  dom.sessionStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser?.close();
});

function rowKind(item: FeedEntry["item"]): string {
  if (item.kind === "prose") return "commentary";
  return item.kind;
}

function EvidenceConversation({ state }: { state: EvidenceState }) {
  const store = runtimeAt(state.envelopeCount);
  const liveTurn = store.sessions[fixture.identity.conversationId]?.liveTurn;
  const feed = feedAt(state.recordCount);
  const visibleLive = visibleRuntimeLiveTurnItems(liveTurn, feed);
  return (
    <RawLineProvider value={() => null}>
      <main
        data-issue-626-evidence={state.id}
        className="flex h-screen min-h-0 flex-col overflow-hidden bg-canvas text-primary"
      >
        <header className="border-b border-border bg-raised px-4 py-3">
          <div className="text-ui font-bold">Issue 626 · canonical conversation</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-caption text-muted">
            <span data-conversation-id>{fixture.identity.conversationId}</span>
            <span data-launch-id>{fixture.identity.launchId}</span>
            <span data-files-revision>files revision {state.filesRevision}</span>
          </div>
          <div data-adopted-path className="mt-1 truncate font-mono text-caption text-secondary">{state.path}</div>
        </header>
        <section data-log-feed-scroller className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[920px] px-4 py-3 sm:px-6">
            <LaunchChips launch={state.launch} />
            {state.outbox ? (
              <div data-evidence-row="outbox">
                <OutboxBubblesView
                  entries={[outboxEntry]}
                  t={(key) => key}
                  onCancel={() => {}}
                  onRetry={() => {}}
                />
              </div>
            ) : null}
            {feed.map((entry) => (
              <div
                key={entry.key}
                data-evidence-row={rowKind(entry.item)}
                data-source-id={entry.item.kind === "prose" ? entry.item.sourceId : undefined}
              >
                <FeedItem item={entry.item} />
              </div>
            ))}
            <div data-evidence-row={visibleLive.length ? "live" : undefined}>
              <LiveTurnRows items={visibleLive} />
            </div>
          </div>
        </section>
        <footer className="border-t border-border bg-raised p-3">
          <textarea
            aria-label="Message"
            className="min-h-11 w-full resize-none rounded-surface border border-border bg-card px-3 py-2 text-ui"
            defaultValue=""
            placeholder="Message this conversation"
          />
        </footer>
      </main>
    </RawLineProvider>
  );
}

async function renderState(state: EvidenceState): Promise<{
  html: string;
  liveItems: number;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<EvidenceConversation state={state} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const html = host.innerHTML;
  const liveItems = host.querySelectorAll("[data-live-turn]").length;
  await act(async () => root.unmount());
  host.remove();
  return { html, liveItems };
}

function pageHtml(inner: string, css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    </style></head><body>${inner}</body></html>`;
}

interface GeometryEvidence {
  width: number;
  scrollWidth: number;
  feedHeight: number;
  composerHeight: number;
  order: string[];
  liveItems: number;
  toolRows: number;
  toolOutputVisible: boolean;
  launchId: string;
  conversationId: string;
  path: string;
  filesRevision: string;
}

test("issue 626 browser evidence preserves chronology, refresh handoff, tools, and 390px geometry", async () => {
  const css = productionCss();
  expect(css.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, GeometryEvidence> = {};

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      const rendered = await renderState(state);
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(pageHtml(rendered.html, css), { waitUntil: "load" });
      const key = `${state.id}-${viewport.id}`;
      const evidence = await page.evaluate(() => {
        const rect = (selector: string) =>
          (document.querySelector(selector) as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
        return {
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          feedHeight: rect("[data-log-feed-scroller]"),
          composerHeight: rect("footer"),
          order: Array.from(document.querySelectorAll<HTMLElement>("[data-evidence-row]"))
            .map((element) => element.dataset.evidenceRow)
            .filter((value): value is string => Boolean(value)),
          liveItems: document.querySelectorAll("[data-live-turn]").length,
          toolRows: document.querySelectorAll('[data-evidence-row="tool"]').length,
          toolOutputVisible: document.body.textContent?.includes("TOOL_OUTPUT_626") === true,
          launchId: document.querySelector("[data-launch-id]")?.textContent ?? "",
          conversationId: document.querySelector("[data-conversation-id]")?.textContent ?? "",
          path: document.querySelector("[data-adopted-path]")?.textContent ?? "",
          filesRevision: document.querySelector("[data-files-revision]")?.textContent ?? "",
        };
      });
      manifest[key] = evidence;

      expect(evidence.order).toEqual(state.expectedOrder);
      expect(evidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      expect(evidence.feedHeight).toBeGreaterThan(evidence.composerHeight);
      expect(evidence.liveItems).toBe(rendered.liveItems);
      expect(evidence.launchId).toBe(fixture.identity.launchId);
      expect(evidence.conversationId).toBe(fixture.identity.conversationId);
      expect(evidence.path).toBe(state.path);
      expect(evidence.filesRevision).toContain(String(state.filesRevision));
      if (state.recordCount >= 4) {
        expect(evidence.toolRows).toBe(1);
        expect(evidence.toolOutputVisible).toBe(true);
      }

      const bodyText = await page.locator("body").innerText();
      const occurrences = (needle: string) => bodyText.split(needle).length - 1;
      expect(occurrences("First commentary survives the tool transition.")).toBeLessThanOrEqual(1);
      expect(occurrences("Second commentary follows the tool output.")).toBeLessThanOrEqual(1);
      expect(occurrences(launchPrompt)).toBe(1);

      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `${key}.png`),
        fullPage: false,
      });
      await page.close();
    }
  }

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "geometry.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}, 120_000);
