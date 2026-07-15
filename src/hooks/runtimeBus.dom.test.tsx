import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import type { RuntimeSnapshot } from "@/components/runtime/runtimeModel";

import { createRuntimeBus, type EventSourceLike, type RuntimeBus } from "./runtimeBus";

class FakeEventSource implements EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  onmessage: ((this: unknown, ev: { data: string; lastEventId?: string }) => void) | null = null;
  private readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  open(): void {
    this.onopen?.(null);
  }

  message(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
});

afterAll(() => {
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  dom.close();
});

function productionSnapshot(): RuntimeSnapshot & { transportPadding: string } {
  const session = {
    conversationId: "codex-one",
    sessionKey: { engine: "codex" as const, sessionId: "codex-session" },
    hostKind: "codex-app-server" as const,
    host: "hosted" as const,
    turn: "idle" as const,
    provenance: "structured" as const,
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "codex-account",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/repo",
    artifactPath: "/sessions/codex.jsonl",
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    drift: null,
  };
  const sessions = [
    session,
    {
      ...session,
      conversationId: "claude-one",
      sessionKey: { engine: "claude" as const, sessionId: "claude-session" },
      hostKind: "claude-broker" as const,
      accountId: "claude-account",
      artifactPath: "/sessions/claude.jsonl",
    },
  ];
  for (let index = 0; index < 800; index += 1) {
    sessions.push({
      ...session,
      conversationId: `background-${index}`,
      sessionKey: { engine: "codex", sessionId: `background-session-${index}` },
      accountId: `background-account-${index % 4}`,
      artifactPath: `/sessions/background-${index}.jsonl`,
    });
  }
  const snapshot: RuntimeSnapshot & { transportPadding: string } = {
    schemaVersion: 1,
    snapshotSeq: 100,
    retentionFloorSeq: 0,
    structuredHostsEnabled: true,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 1,
    sessions,
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
    transportPadding: "",
  };
  snapshot.transportPadding = "x".repeat(Math.max(0, 477 * 1024 - Buffer.byteLength(JSON.stringify(snapshot))));
  return snapshot;
}

function RuntimeProbe({ bus, onCommit }: { bus: RuntimeBus; onCommit: () => void }) {
  const state = useSyncExternalStore(bus.subscribe, bus.getState, bus.getState);
  useEffect(onCommit);
  return (
    <output data-connection={state.connection}>
      {state.store.cursor}:{state.store.sessions["codex-one"]?.sessionKey.engine},{state.store.sessions["claude-one"]?.sessionKey.engine}:{Object.keys(state.store.sessions).length}
    </output>
  );
}

test("a production-sized React join stays warm and bounded through Codex and Claude bursts", async () => {
  const sources: FakeEventSource[] = [];
  let snapshotFetches = 0;
  const encodedSnapshot = JSON.stringify(productionSnapshot());
  const bus = createRuntimeBus({
    fetch: async () => {
      snapshotFetches += 1;
      return new Response(encodedSnapshot, { headers: { "content-type": "application/json" } });
    },
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const depthErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("Maximum update depth exceeded") || message.includes("#185")) depthErrors.push(message);
    else originalConsoleError(...args);
  };

  try {
    let committedRenders = 0;
    const warmStartedAt = performance.now();
    await act(async () => {
      root.render(<RuntimeProbe bus={bus} onCommit={() => { committedRenders += 1; }} />);
      bus.start();
      await Bun.sleep(25);
    });
    const warmElapsedMs = performance.now() - warmStartedAt;
    expect(Buffer.byteLength(encodedSnapshot)).toBeGreaterThanOrEqual(477 * 1024);
    expect(host.textContent).toBe("100:codex,claude:802");
    expect(warmElapsedMs).toBeLessThan(500);
    expect(snapshotFetches).toBe(1);
    expect(sources).toHaveLength(1);

    await act(async () => {
      sources[0]!.open();
      await Bun.sleep(20);
    });
    committedRenders = 0;
    let subscriberNotifications = 0;
    const unsubscribe = bus.subscribe(() => { subscriberNotifications += 1; });
    let seq = 100;
    await act(async () => {
      for (const conversationId of ["codex-one", "claude-one"]) {
        for (let index = 0; index < 64; index += 1) {
          seq += 1;
          sources[0]!.message({
            schemaVersion: 1,
            seq,
            eventId: `event-${seq}`,
            scope: { type: "session", id: conversationId },
            revision: index + 2,
            kind: "item",
            payload: { phase: "delta", text: `token-${index}` },
          });
          await Promise.resolve();
        }
      }
      await Bun.sleep(20);
    });
    unsubscribe();

    expect(host.textContent).toBe("228:codex,claude:802");
    expect(bus.getState().store.cursor).toBe(228);
    expect(snapshotFetches).toBe(1);
    expect(sources).toHaveLength(1);
    expect(subscriberNotifications).toBe(1);
    expect(committedRenders).toBe(1);
    expect(depthErrors).toEqual([]);
  } finally {
    console.error = originalConsoleError;
    await act(async () => { root.unmount(); });
    bus.stop();
    host.remove();
  }
});
