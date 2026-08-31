import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, installSnapshot, type RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import type { RuntimeBus, RuntimeBusState } from "@/hooks/runtimeBus";
import { setLocale } from "@/lib/i18n";
import { createFailedLegacyBufferProjection } from "@/lib/runtime/fixtures/failedLegacyBufferProjection";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "@/lib/runtime/structuredDeliveryController";
import type { FileEntry } from "@/lib/types";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

function inertRuntimeState(): RuntimeBusState {
  return {
    store: emptyStore(),
    connection: "offline",
    resyncedAt: null,
    lastEventAt: null,
    enabled: false,
    structuredHostsEnabled: false,
  };
}

let runtimeState = inertRuntimeState();
const runtimeBus: RuntimeBus = {
  getState: () => runtimeState,
  subscribe: () => () => {},
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};

const actualRuntimeBus = await import("@/hooks/runtimeBus");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/runtimeBus", () => ({
  ...actualRuntimeBus,
  getRuntimeBus: () => runtimeBus,
  isRuntimeUiEnabled: () => true,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [],
    linesStart: 0,
    size: 0,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { BranchPane } = await import("./BranchPane");

const roots = new Set<Root>();

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  await bindStructuredDeliveryQueue([], { client: null });
  runtimeState = inertRuntimeState();
  setLocale("en");
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

afterAll(() => {
  mock.module("@/hooks/runtimeBus", () => actualRuntimeBus);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  dom.close();
});

function liveLegacyFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/conversations/live-legacy.jsonl",
    root: "codex-sessions",
    name: "live-legacy.jsonl",
    project: "viewer",
    title: "live legacy turn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: Date.now() / 1000,
    size: 512,
    activity: "live",
    activityReason: "jsonl_turn_open",
    proc: "running",
    pid: 203,
    lastTurn: { startedAt: Date.now() - 60_000, endedAt: null },
    model: "gpt",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function mount(file: FileEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<BranchPane file={file} tasks={[]} isRoot />));
  return host;
}

function installRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  runtimeState = {
    store: installSnapshot(snapshot),
    connection: "live",
    resyncedAt: null,
    lastEventAt: Date.now(),
    enabled: true,
    structuredHostsEnabled: snapshot.structuredHostsEnabled === true,
  };
}

function deadProjectionSnapshot(conversationId: string): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    structuredHostsEnabled: true,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 1,
    sessions: [{
      conversationId,
      sessionKey: { engine: "codex", sessionId: `${conversationId}-session` },
      hostKind: "codex-app-server",
      host: "dead",
      turn: "unknown",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "viewer",
      artifactPath: "/conversations/conflicting.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

test("a failed legacy pane-buffer probe reaches BranchPane as one live running verdict", async () => {
  const fixture = await createFailedLegacyBufferProjection();
  try {
    expect(fixture.failedDelivery).toMatchObject({
      ok: false,
      outcome: "failed",
      error: "Pane buffer unreadable — message was not sent.",
    });
    for (const rawIdentifier of fixture.rawIdentifiers) {
      expect(JSON.stringify(fixture.failedDelivery)).not.toContain(rawIdentifier);
    }
    expect(fixture.snapshot.sessions.filter((session) => session.conversationId === fixture.conversationId)).toHaveLength(1);
    expect(fixture.snapshot.sessions.find((session) => session.conversationId === fixture.conversationId)).toMatchObject({
      hostKind: "tmux-legacy",
      host: "hosted",
      turn: "running",
      provenance: "derived",
    });
    expect(hasStructuredDeliveryHost(fixture.key)).toBeFalse();

    installRuntimeSnapshot(fixture.snapshot);
    const host = mount(liveLegacyFile({ conversationId: fixture.conversationId }));
    expect(host.querySelectorAll('[data-card-status="running"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-strip-surface="live-root"]')).toHaveLength(1);
    expect(host.querySelector("[data-dead-host-banner]")).toBeNull();
    expect(host.querySelector('[data-strip-surface="dead"]')).toBeNull();
    expect(host.textContent).not.toContain("Respawn conversation");
    expect(host.textContent).not.toContain("Drafted images will be sent after the host recovers");
    for (const rawIdentifier of fixture.rawIdentifiers) {
      expect(host.innerHTML).not.toContain(rawIdentifier);
    }
  } finally {
    await fixture.dispose();
  }
});

test.each([
  ["live host", "conversation_conflicting_live_process", { activity: "idle", lastTurn: { startedAt: 1_000, endedAt: 2_000 } }],
  ["open turn", "conversation_conflicting_open_turn", { proc: null, pid: null }],
] as const)("conflicting dead projection stays fail closed on %s evidence alone", (_evidence, conversationId, overrides) => {
  installRuntimeSnapshot(deadProjectionSnapshot(conversationId));
  const host = mount(liveLegacyFile({ conversationId, ...overrides }));

  expect(host.querySelector("[data-dead-host-banner]")).toBeNull();
  expect(host.textContent).not.toContain("Respawn conversation");
});
