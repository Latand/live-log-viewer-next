import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { chromium, type Browser } from "playwright-core";

import { BranchPane } from "@/components/BranchPane";
import {
  applyEvent,
  installSnapshot,
  type RuntimeEnvelope,
  type RuntimeSession,
  type RuntimeSnapshot,
  type RuntimeStore,
} from "@/components/runtime/runtimeModel";
import { getRuntimeBus } from "@/hooks/runtimeBus";
import { resetLogTailCacheForTests } from "@/hooks/useLogTail";
import { setLocale } from "@/lib/i18n";
import {
  appendRuntimeLiveTurnDelta,
  completeRuntimeLiveTurnItem,
  runtimeLiveTurnItems,
  type RuntimeLiveTurn,
} from "@/lib/runtime/liveTurn";
import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import { installActEnv } from "@/test-helpers/actEnv";

import { resetCanonicalAssistantClaimsForTests } from "./liveTurnHandoff";
import {
  adoptOutbox,
  enqueueOutbox,
  OUTBOX_LIMIT,
  outboxStateForReceiptStatus,
  publishTranscriptEchoes,
  readOutbox,
  resetOutboxForTests,
  seedLaunchOutbox,
  updateOutbox,
} from "./outbox";

interface LifecycleFixture {
  identity: {
    conversationId: string;
    launchId: string;
    startingPath: string;
    adoptedPath: string;
  };
  runtimeEnvelopes: RuntimeEnvelope[];
  transcriptRecords: unknown[];
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dir, "fixtures", "issue-626-lifecycle.json"),
  "utf8",
)) as LifecycleFixture;

const EVIDENCE_DIR = path.join(process.cwd(), "docs", "media", "issue-626");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");
const CONVERSATION_ID = fixture.identity.conversationId;
const launchPrompt = "Investigate issue 626.";
const unrelatedPrompt = "Unrelated queued entry remains visible.";
const FINAL_FILLER_COUNT = 2_700;
const FINAL_ASSISTANT_COUNT = 40;
const CAPTURE_NOW = Date.parse("2026-07-23T09:02:00.000Z");

function productionCss(): string {
  if (!fs.existsSync(CSS_DIR)) return "";
  return fs.readdirSync(CSS_DIR)
    .filter((name) => name.endsWith(".css"))
    .map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8"))
    .join("\n");
}

function runtimeSession(): RuntimeSession {
  return {
    conversationId: CONVERSATION_ID,
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

function emptyRuntimeSnapshot(): RuntimeSnapshot {
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
    structuredHostsEnabled: true,
  };
}

function runtimeAt(envelopeCount: number): RuntimeStore {
  let store = installSnapshot(emptyRuntimeSnapshot());
  for (const envelope of fixture.runtimeEnvelopes.slice(0, envelopeCount)) {
    const result = applyEvent(store, envelope);
    if (result.outcome !== "applied") throw new Error(`runtime replay ${result.outcome}`);
    store = result.store;
  }
  return store;
}

const overflowText = (index: number) => {
  const prefix = `Second-turn handoff ${String(index).padStart(2, "0")} `;
  const body = `${prefix}${"x".repeat(1_680 - prefix.length)}`;
  if (index !== FINAL_ASSISTANT_COUNT - 1) return body;
  return [
    body,
    "<oai-mem-citation>",
    "<citation_entries>",
    "MEMORY.md:1-2|note=[issue 626 deterministic fixture]",
    "</citation_entries>",
    "<rollout_ids>",
    "</rollout_ids>",
    "</oai-mem-citation>",
    "VERDICT: APPROVE",
    "",
    "NO FINDINGS",
  ].join("\n");
};

function boundedFinalLiveTurn(seed: RuntimeLiveTurn | null | undefined): RuntimeLiveTurn {
  let liveTurn = seed ?? null;
  for (let index = 0; index < FINAL_ASSISTANT_COUNT; index += 1) {
    const id = `item_overflow_626_${index}`;
    const text = overflowText(index);
    const occurredAt = `2026-07-23T09:01:${String(index).padStart(2, "0")}.000Z`;
    liveTurn = appendRuntimeLiveTurnDelta(
      liveTurn,
      "turn_issue_626_second",
      text,
      occurredAt,
    );
    liveTurn = completeRuntimeLiveTurnItem(
      liveTurn,
      "turn_issue_626_second",
      { type: "agentMessage", id, text },
      occurredAt,
    );
  }
  if (!liveTurn) throw new Error("final live turn fixture failed");
  return liveTurn;
}

function snapshotFor(state: EvidenceState): RuntimeSnapshot {
  const store = runtimeAt(state.envelopeCount);
  const session = store.sessions[CONVERSATION_ID]!;
  const liveTurn = state.logMode === "final"
    ? boundedFinalLiveTurn(session.liveTurn)
    : session.liveTurn;
  return {
    ...emptyRuntimeSnapshot(),
    snapshotSeq: state.logMode === "final" ? 100 : store.cursor,
    filesRevision: state.filesRevision,
    sessions: [{
      ...session,
      artifactPath: state.path.startsWith("spawn:") ? null : state.path,
      liveTurn,
    }],
  };
}

function responseMessage(id: string, text: string, timestamp: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      id,
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text }],
    },
  };
}

function userMessage(text: string, timestamp: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

function serviceRecord(index: number): unknown {
  return {
    timestamp: `2026-07-23T09:00:${String(index % 60).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: index + 1 } },
    },
  };
}

const partialRecords = fixture.transcriptRecords.slice(0, 4);
const finalRecords = [
  ...partialRecords,
  ...Array.from({ length: FINAL_FILLER_COUNT }, (_, index) => serviceRecord(index)),
  fixture.transcriptRecords[4]!,
  userMessage(launchPrompt, "2026-07-23T09:00:07.000Z"),
  ...Array.from({ length: FINAL_ASSISTANT_COUNT }, (_, index) =>
    responseMessage(
      `item_overflow_626_${index}`,
      overflowText(index),
      `2026-07-23T09:01:${String(index).padStart(2, "0")}.000Z`,
    )),
];

function serialize(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

const partialLog = serialize(partialRecords);
const finalLog = serialize(finalRecords);

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

const adoptedLaunch: StructuredSpawnCardState = {
  ...launchBase,
  state: "live-late-success",
  initialMessage: "delivered",
  ["prompt"]: undefined,
  promptEcho: undefined,
};

type LogMode = "empty" | "partial" | "final";

interface EvidenceState {
  id: string;
  envelopeCount: number;
  filesRevision: number;
  path: string;
  launch: StructuredSpawnCardState;
  logMode: LogMode;
  logOverride?: string;
  expectedOrder: string[];
}

const STATES: EvidenceState[] = [
  {
    id: "streaming-before-tool",
    envelopeCount: 2,
    filesRevision: 40,
    path: fixture.identity.startingPath,
    launch: launchBase,
    logMode: "empty",
    expectedOrder: ["outbox", "live"],
  },
  {
    id: "refresh-at-tool-transition",
    envelopeCount: 4,
    filesRevision: 40,
    path: fixture.identity.startingPath,
    launch: { ...launchBase, state: "reconciling", initialMessage: "queued" },
    logMode: "empty",
    expectedOrder: ["outbox", "live"],
  },
  {
    id: "partial-adoption",
    envelopeCount: 8,
    filesRevision: 41,
    path: fixture.identity.adoptedPath,
    launch: adoptedLaunch,
    logMode: "partial",
    expectedOrder: ["user", "commentary", "tool", "live"],
  },
  {
    id: "refresh-after-adoption",
    envelopeCount: 8,
    filesRevision: 41,
    path: fixture.identity.adoptedPath,
    launch: adoptedLaunch,
    logMode: "final",
    expectedOrder: ["commentary", "user", "commentary", "mem-citation", "review", "outbox"],
  },
];

const VIEWPORTS = [
  { id: "desktop-1280", width: 1280, height: 900, mobile: false },
  { id: "mobile-390", width: 390, height: 844, mobile: true },
];

function baseFile(state: EvidenceState, log: string): FileEntry {
  return {
    path: state.path,
    root: "codex-sessions",
    name: path.basename(state.path),
    project: "live-log-viewer-next",
    title: "Issue 626 production lifecycle",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: Date.parse("2026-07-23T09:02:00.000Z") / 1_000,
    size: new TextEncoder().encode(log).length,
    activity: "live",
    proc: "running",
    pid: 626,
    model: "gpt-5.6-sol",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: CONVERSATION_ID,
    spawn: state.path.startsWith("spawn:") ? state.launch : undefined,
    launch: state.path.startsWith("spawn:") ? undefined : state.launch,
  } as FileEntry;
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
  EventSource: undefined,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: undefined,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: query.includes("max-width: 767px") || query.includes("pointer: coarse")
    ? mobile
    : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

let browser: Browser;
let currentSnapshot = emptyRuntimeSnapshot();
const logs = new Map<string, string>();
let logRequestCount = 0;
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

async function openEvidenceBrowser(): Promise<{
  instance: Browser;
  closeOwned: () => Promise<void>;
}> {
  if (browser?.isConnected()) {
    return { instance: browser, closeOwned: () => Promise.resolve() };
  }
  const instance = await chromium.launch({ executablePath: chromium.executablePath() });
  return { instance, closeOwned: () => instance.close() };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (url.includes("/api/runtime/snapshot")) {
    return Response.json(currentSnapshot);
  }
  if (url.endsWith("/api/logs")) {
    logRequestCount += 1;
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      reqs?: Array<{ id: string; path: string; offset: number }>;
    };
    const chunks: Record<string, {
      data: string;
      size: number;
      offset: number;
      start: number;
    }> = {};
    for (const req of request.reqs ?? []) {
      const log = logs.get(req.path) ?? "";
      const size = new TextEncoder().encode(log).length;
      chunks[req.id] = {
        data: log.slice(req.offset),
        size,
        offset: size,
        start: req.offset,
      };
    }
    return Response.json({ chunks });
  }
  if (url.endsWith("/api/tts/backend")) {
    return Response.json({
      backend: "openai",
      lockedByEnv: true,
      options: [{
        id: "openai",
        available: false,
        keyPath: "",
        model: "fixture",
        voice: "fixture",
        cap: 1_000,
      }],
    });
  }
  return Response.json({});
}) as typeof fetch;

beforeEach(() => {
  Date.now = () => CAPTURE_NOW;
  setLocale("en");
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.localStorage.setItem("llv_runtime_ui", "1");
  resetOutboxForTests();
  resetCanonicalAssistantClaimsForTests();
  resetLogTailCacheForTests();
  logs.clear();
  logRequestCount = 0;
  getRuntimeBus().stop();
});

afterEach(() => {
  document.body.replaceChildren();
  mobile = false;
  getRuntimeBus().stop();
});

afterAll(async () => {
  await browser?.close();
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

function stateLog(state: EvidenceState): string {
  if (state.logOverride !== undefined) return state.logOverride;
  if (state.logMode === "partial") return partialLog;
  if (state.logMode === "final") return finalLog;
  return "";
}

async function renderState(state: EvidenceState): Promise<{
  html: string;
  liveItems: number;
  runtimeItems: number;
  runtimeOverflow: number;
  runtimeOmittedChars: number;
}> {
  const log = stateLog(state);
  logs.set(state.path, log);
  currentSnapshot = snapshotFor(state);
  getRuntimeBus().stop();

  const runtimeLiveTurn = currentSnapshot.sessions[0]?.liveTurn;
  const runtimeItems = runtimeLiveTurnItems(runtimeLiveTurn);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <main
        data-issue-626-evidence={state.id}
        className="flex h-screen min-h-0 flex-col overflow-hidden bg-canvas text-primary"
      >
        <header className="shrink-0 border-b border-border bg-raised px-4 py-2">
          <div className="text-ui font-bold">Issue 626 · canonical conversation</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-caption text-muted">
            <span data-conversation-id>{CONVERSATION_ID}</span>
            <span data-launch-id>{fixture.identity.launchId}</span>
            <span data-files-revision>files revision {state.filesRevision}</span>
          </div>
          <div data-adopted-path className="mt-1 truncate font-mono text-caption text-secondary">
            {state.path}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 p-2">
          <BranchPane file={baseFile(state, log)} tasks={[]} isRoot />
        </div>
      </main>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  if (state.logMode === "partial") {
    const toolDisclosure = host.querySelector<HTMLDetailsElement>('[data-feed-kind="tool"] details');
    if (toolDisclosure) {
      await act(async () => {
        toolDisclosure.open = true;
        toolDisclosure.dispatchEvent(new Event("toggle"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  const html = host.innerHTML;
  const liveItems = host.querySelectorAll("[data-live-turn]").length;
  const result = {
    html,
    liveItems,
    runtimeItems: runtimeItems.length,
    runtimeOverflow: runtimeLiveTurn?.overflow?.length ?? 0,
    runtimeOmittedChars: runtimeItems.reduce((total, item) => total + (item.omittedChars ?? 0), 0),
  };
  await act(async () => root.unmount());
  host.remove();
  return result;
}

function pageHtml(inner: string, css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    #evidence-host{display:flex;flex-direction:column;width:100%;height:100vh;overflow:hidden}
    *,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
    </style></head><body><div id="evidence-host">${inner}</div></body></html>`;
}

interface GeometryEvidence {
  width: number;
  scrollWidth: number;
  feedHeight: number;
  composerHeight: number;
  order: string[];
  liveItems: number;
  runtimeItems: number;
  runtimeOverflow: number;
  runtimeOmittedChars: number;
  tailLinesStart: number;
  tailLineCount: number;
  feedRows: number;
  toolRows: number;
  reviewRows: number;
  citationRows: number;
  outboxEntries: number;
  toolOutputVisible: boolean;
  unrelatedOutboxVisible: boolean;
  productionWindow: boolean;
  launchId: string;
  conversationId: string;
  path: string;
  filesRevision: string;
}

test("issue 626 production evidence preserves lifecycle ownership and bounded handoffs at 1280px and 390px", async () => {
  const css = productionCss();
  expect(css.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, GeometryEvidence> = {};

  for (const viewport of VIEWPORTS) {
    mobile = viewport.mobile;
    dom.sessionStorage.clear();
    resetOutboxForTests();
    resetCanonicalAssistantClaimsForTests();
    resetLogTailCacheForTests();
    logs.clear();
    logRequestCount = 0;
    getRuntimeBus().stop();

    for (const state of STATES) {
      if (state.logMode === "final") {
        enqueueOutbox(CONVERSATION_ID, {
          id: "repeat_prompt_626",
          text: launchPrompt,
          images: 0,
          at: Date.parse("2026-07-23T09:00:06.500Z"),
          launchOwned: true,
        });
        enqueueOutbox(CONVERSATION_ID, {
          id: "unrelated_prompt_626",
          text: unrelatedPrompt,
          images: 0,
          at: Date.parse("2026-07-23T09:00:06.750Z"),
          launchOwned: true,
        });
      }

      const rendered = await renderState(state);
      expect(
        rendered.html.includes("data-pan-ignore")
        && rendered.html.includes("data-log-feed-scroller")
        && rendered.html.includes("<textarea"),
      ).toBe(true);

      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(pageHtml(rendered.html, css), { waitUntil: "load" });
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      if (state.logMode === "final") {
        await page.locator("[data-outbox]").scrollIntoViewIfNeeded();
      }
      const key = `${state.id}-${viewport.id}`;
      const evidence = await page.evaluate((unrelatedText) => {
        const rect = (selector: string) =>
          (document.querySelector(selector) as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
        const rawOrder = Array.from(document.querySelectorAll<HTMLElement>(
          "[data-feed-kind], [data-outbox], [data-live-turn-group]",
        )).map((element) => {
          if (element.dataset.outbox !== undefined) return "outbox";
          if (element.dataset.liveTurnGroup !== undefined) return "live";
          return element.dataset.feedKind === "prose" ? "commentary" : element.dataset.feedKind ?? "";
        }).filter(Boolean);
        const order = rawOrder.filter((kind, index) => kind !== rawOrder[index - 1]);
        const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
        return {
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          feedHeight: rect("[data-log-feed-scroller]"),
          composerHeight: rect("form"),
          order,
          tailLinesStart: Number(scroller?.dataset.tailLinesStart ?? 0),
          tailLineCount: Number(scroller?.dataset.tailLineCount ?? 0),
          feedRows: document.querySelectorAll("[data-feed-kind]").length,
          toolRows: document.querySelectorAll('[data-feed-kind="tool"]').length,
          reviewRows: document.querySelectorAll('[data-feed-kind="review"]').length,
          citationRows: document.querySelectorAll('[data-feed-kind="mem-citation"]').length,
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          toolOutputVisible: document.body.textContent?.includes("TOOL_OUTPUT_626") === true,
          unrelatedOutboxVisible: document.body.textContent?.includes(unrelatedText) === true,
          productionWindow: Boolean(
            document.querySelector("[data-pan-ignore]"),
          ) && Boolean(document.querySelector("[data-log-feed-scroller]"))
            && Boolean(document.querySelector("textarea")),
          launchId: document.querySelector("[data-launch-id]")?.textContent ?? "",
          conversationId: document.querySelector("[data-conversation-id]")?.textContent ?? "",
          path: document.querySelector("[data-adopted-path]")?.textContent?.trim() ?? "",
          filesRevision: document.querySelector("[data-files-revision]")?.textContent ?? "",
        };
      }, unrelatedPrompt);
      manifest[key] = {
        ...evidence,
        liveItems: rendered.liveItems,
        runtimeItems: rendered.runtimeItems,
        runtimeOverflow: rendered.runtimeOverflow,
        runtimeOmittedChars: rendered.runtimeOmittedChars,
      };

      if (state.logMode === "partial" && evidence.tailLineCount === 0) {
        throw new Error(`partial log transport delivered zero lines after ${logRequestCount} requests`);
      }
      expect(evidence.order).toEqual(state.expectedOrder);
      expect(evidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      expect(evidence.feedHeight).toBeGreaterThan(evidence.composerHeight);
      expect(evidence.productionWindow).toBe(true);
      expect(evidence.launchId).toBe(fixture.identity.launchId);
      expect(evidence.conversationId).toBe(CONVERSATION_ID);
      expect(evidence.path).toBe(state.path);
      expect(evidence.filesRevision).toContain(String(state.filesRevision));

      const bodyText = await page.locator("body").textContent() ?? "";
      const occurrences = (needle: string) => bodyText.split(needle).length - 1;
      expect(occurrences("First commentary survives the tool transition.")).toBeLessThanOrEqual(1);
      expect(occurrences("Second commentary follows the tool output.")).toBeLessThanOrEqual(1);
      expect(occurrences(launchPrompt)).toBe(1);

      if (state.logMode === "partial") {
        expect(evidence.toolRows).toBe(1);
        expect(evidence.toolOutputVisible).toBe(true);
        expect(evidence.outboxEntries).toBe(0);
      }
      if (state.logMode === "final") {
        expect(evidence.tailLinesStart).toBeGreaterThan(0);
        expect(evidence.tailLineCount).toBeLessThan(finalRecords.length);
        expect(evidence.reviewRows).toBe(1);
        expect(evidence.citationRows).toBe(1);
        expect(evidence.outboxEntries).toBe(1);
        expect(evidence.unrelatedOutboxVisible).toBe(true);
        expect(rendered.liveItems).toBe(0);
        expect(rendered.runtimeItems).toBeGreaterThan(32);
        expect(rendered.runtimeOverflow).toBeGreaterThan(0);
        expect(rendered.runtimeOmittedChars).toBeGreaterThan(0);
      }

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

test("issue 626 production DOM keeps compacted receipt-delivered ownership across lifecycle churn at 1280px and 390px", async () => {
  const css = productionCss();
  expect(css.length).toBeGreaterThan(10_000);
  const repeated = "Issue 626 repeated row-anchor ownership.";
  const provisional = "spawn:launch_issue_626_occurrence";
  const firstPath = "/synthetic/issue-626-generation-1.jsonl";
  const secondPath = "/synthetic/issue-626-generation-2.jsonl";
  const generationState = (id: string, transcriptPath: string): EvidenceState => ({
    id,
    envelopeCount: 0,
    filesRevision: 42,
    path: transcriptPath,
    launch: adoptedLaunch,
    logMode: "empty",
    logOverride: serialize([userMessage(repeated, "2026-07-23T09:03:00.000Z")]),
    expectedOrder: ["user", "outbox"],
  });
  const { instance: evidenceBrowser, closeOwned } = await openEvidenceBrowser();

  try {
    for (const viewport of VIEWPORTS) {
      mobile = viewport.mobile;
      dom.sessionStorage.clear();
      resetOutboxForTests();
      resetCanonicalAssistantClaimsForTests();
      resetLogTailCacheForTests();
      logs.clear();
      getRuntimeBus().stop();

      enqueueOutbox(provisional, {
        id: "older-receipt-delivered",
        text: repeated,
        images: 0,
        at: Date.parse("2026-07-23T09:02:00.000Z"),
        launchOwned: true,
      });
      updateOutbox(provisional, "older-receipt-delivered", {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: Date.parse("2026-07-23T09:02:01.000Z"),
      });
      enqueueOutbox(provisional, {
        id: "newer-pending",
        text: repeated,
        images: 0,
        at: Date.parse("2026-07-23T09:02:02.000Z"),
        launchOwned: true,
      });
      updateOutbox(provisional, "newer-pending", { state: "delivering" });
      for (let index = 0; index < OUTBOX_LIMIT - 1; index += 1) {
        const id = `browser-filler-${index}`;
        enqueueOutbox(provisional, {
          id,
          text: `Browser filler ${index}`,
          images: 0,
          at: Date.parse("2026-07-23T09:02:03.000Z") + index,
          launchOwned: true,
        });
        updateOutbox(provisional, id, { state: "delivering" });
      }
      adoptOutbox(provisional, CONVERSATION_ID);
      resetOutboxForTests();

      const delayed = await renderState(generationState("delayed-older-echo", firstPath));
      const delayedPage = await evidenceBrowser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await delayedPage.setContent(pageHtml(delayed.html, css), { waitUntil: "load" });
      const delayedEvidence = await delayedPage.evaluate((text) => {
        const body = document.body.textContent ?? "";
        return {
          occurrences: body.split(text).length - 1,
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          scrollWidth: document.documentElement.scrollWidth,
        };
      }, repeated);
      expect(delayedEvidence.occurrences).toBe(2);
      expect(delayedEvidence.outboxEntries).toBe(OUTBOX_LIMIT);
      expect(delayedEvidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      await delayedPage.screenshot({
        path: path.join(EVIDENCE_DIR, `delayed-occurrence-${viewport.id}.png`),
        fullPage: false,
      });
      await delayedPage.close();

      resetLogTailCacheForTests();
      logs.clear();
      const filtered = await renderState({
        ...generationState("filtered-capped-tail", firstPath),
        logOverride: "",
        expectedOrder: ["outbox"],
      });
      const filteredPage = await evidenceBrowser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await filteredPage.setContent(pageHtml(filtered.html, css), { waitUntil: "load" });
      const filteredEvidence = await filteredPage.evaluate((text) => {
        const body = document.body.textContent ?? "";
        return {
          occurrences: body.split(text).length - 1,
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          scrollWidth: document.documentElement.scrollWidth,
        };
      }, repeated);
      expect(filteredEvidence.occurrences).toBe(1);
      expect(filteredEvidence.outboxEntries).toBe(OUTBOX_LIMIT);
      expect(filteredEvidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      await filteredPage.screenshot({
        path: path.join(EVIDENCE_DIR, `filtered-capped-tail-${viewport.id}.png`),
        fullPage: false,
      });
      await filteredPage.close();

      resetOutboxForTests();
      resetLogTailCacheForTests();
      logs.clear();
      const successor = await renderState(generationState("successor-generation-echo", secondPath));
      const successorPage = await evidenceBrowser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await successorPage.setContent(pageHtml(successor.html, css), { waitUntil: "load" });
      const successorEvidence = await successorPage.evaluate((text) => {
        const body = document.body.textContent ?? "";
        return {
          occurrences: body.split(text).length - 1,
          outboxEntries: document.querySelectorAll("[data-outbox-entry]").length,
          scrollWidth: document.documentElement.scrollWidth,
        };
      }, repeated);
      expect(successorEvidence.occurrences).toBe(1);
      expect(successorEvidence.outboxEntries).toBe(OUTBOX_LIMIT - 1);
      expect(successorEvidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      await successorPage.screenshot({
        path: path.join(EVIDENCE_DIR, `successor-generation-${viewport.id}.png`),
        fullPage: false,
      });
      await successorPage.close();
    }
  } finally {
    await closeOwned();
  }
}, 120_000);

test("issue 626 production LogFeed does not reseed a compacted terminal launch at 1280px and 390px", async () => {
  const css = productionCss();
  expect(css.length).toBeGreaterThan(10_000);
  const provisional = "spawn:launch_issue_626_terminal";
  const prompt = "Issue 626 terminal launch prompt.";
  const promptAt = launchBase.promptAt ?? CAPTURE_NOW;
  const terminalLaunch: StructuredSpawnCardState = {
    ...launchBase,
    launchId: "launch_issue_626_terminal",
    state: "live-late-success",
    initialMessage: "delivered",
    ["prompt"]: prompt,
    promptEcho: prompt,
    promptAt,
  };
  const state: EvidenceState = {
    id: "terminal-launch-reseed",
    envelopeCount: 0,
    filesRevision: 43,
    path: fixture.identity.adoptedPath,
    launch: terminalLaunch,
    logMode: "empty",
    logOverride: "",
    expectedOrder: ["outbox"],
  };
  const { instance: evidenceBrowser, closeOwned } = await openEvidenceBrowser();

  try {
    for (const viewport of VIEWPORTS) {
      mobile = viewport.mobile;
      dom.sessionStorage.clear();
      resetOutboxForTests();
      resetCanonicalAssistantClaimsForTests();
      resetLogTailCacheForTests();
      logs.clear();
      getRuntimeBus().stop();

      seedLaunchOutbox(provisional, {
        id: terminalLaunch.launchId,
        text: prompt,
        images: 0,
        at: promptAt,
      });
      publishTranscriptEchoes(provisional, [{
        generation: fixture.identity.adoptedPath,
        id: "row:0:0",
        text: prompt,
      }]);
      expect(typeof readOutbox(provisional)[0]?.retiredEchoId).toBe("string");

      for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
        const id = `terminal-browser-filler-${index}`;
        enqueueOutbox(provisional, {
          id,
          text: `Terminal browser filler ${index}`,
          images: 0,
          at: promptAt + index + 1,
          launchOwned: true,
        });
        updateOutbox(provisional, id, { state: "delivering" });
      }
      adoptOutbox(provisional, CONVERSATION_ID);
      resetOutboxForTests();

      const rendered = await renderState(state);
      const queue = readOutbox(CONVERSATION_ID);
      expect(queue).toHaveLength(OUTBOX_LIMIT);
      expect(queue.some((entry) => entry.id === terminalLaunch.launchId)).toBe(false);
      expect(queue[0]?.id).toBe("terminal-browser-filler-0");

      const page = await evidenceBrowser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(pageHtml(rendered.html, css), { waitUntil: "load" });
      const evidence = await page.evaluate(() => ({
        ids: Array.from(document.querySelectorAll<HTMLElement>("[data-outbox-entry]"))
          .map((entry) => entry.dataset.outboxEntry ?? ""),
        scrollWidth: document.documentElement.scrollWidth,
        productionWindow: Boolean(document.querySelector("[data-pan-ignore]"))
          && Boolean(document.querySelector("[data-log-feed-scroller]"))
          && Boolean(document.querySelector("textarea")),
      }));
      expect(evidence.ids).toHaveLength(OUTBOX_LIMIT);
      expect(evidence.ids).not.toContain(terminalLaunch.launchId);
      expect(evidence.ids[0]).toBe("terminal-browser-filler-0");
      expect(evidence.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      expect(evidence.productionWindow).toBe(true);
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `terminal-launch-reseed-${viewport.id}.png`),
        fullPage: false,
      });
      await page.close();
    }
  } finally {
    await closeOwned();
  }
}, 120_000);
