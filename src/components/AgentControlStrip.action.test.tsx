import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

/* Integration/action coverage for the container's real wiring (issue #241
   findings 1, 2 & 7): a running Claude *subagent* pane whose transcript is
   scanner-shaped — proc:null, pid:null, because the root process writes the
   child transcript (src/lib/scanner/transcripts.ts). The strip's liveness comes
   from the canonical ROOT host, and its ROUTING follows the root's kind:
   - a live claude-broker (structured) root → Stop relays to the root's
     structured interrupt (/api/runtime/interrupt), Kill/images disabled, and
     zero /api/tmux + /api/proc requests fire.
   - a live tmux-legacy root → Stop keeps the canonical /api/tmux child path. */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

/* Recording ResizeObserver: happy-dom has none, and the strip's width folding
   must attach its observer even when the strip root mounts LATE (#257 — the
   gated/unresolved surface renders nothing until host evidence arrives). */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed = [];
  }
  resize(width: number): void {
    this.cb([{ contentRect: { width } }]);
  }
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });

/* The runtime plane is authoritative (enabled) and carries the subagent's root
   host keyed by its artifact path — the production shape. */
function rootView(kind: HostKind, host: HostAxis): RuntimeSessionView {
  return {
    session: { hostKind: kind, host, artifactPath: "/root.jsonl", conversationId: "conv-root" } as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: kind === "tmux-legacy", structuredControlsEnabled: true,
  };
}
let rootKind: HostKind = "claude-broker";
let rootAxis: HostAxis = "hosted";
// The mock registry is global across files: keep the plane mutable and flip it
// off in afterAll so later suites (BranchPane.render SSR) see the disabled
// default shape without a live runtime — a re-mock to the real module does not
// reliably un-bind already-loaded consumers, but flipping the flag does.
let planeEnabled = true;
/* A pane-less structured session for the root-conversation compact tests. */
let sessionView: RuntimeSessionView | null = null;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  useRuntime: () => ({ enabled: planeEnabled, connection: planeEnabled ? "live" : "offline", resyncedAt: null, store: {} }),
  useRuntimeSession: () => sessionView,
  useRuntimeSessionByArtifact: (path: string | null) => (planeEnabled && path === "/root.jsonl" ? rootView(rootKind, rootAxis) : null),
}));

afterAll(() => {
  planeEnabled = false;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const { AgentControlStrip } = await import("./AgentControlStrip");

/** Scanner-shaped Claude subagent: its own proc/pid are null (finding 2). */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "viewer", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1,
  activity: "live", proc: null, pid: null, model: "sonnet", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;

async function mount(file: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentControlStrip file={file} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  rootKind = "claude-broker";
  rootAxis = "hosted";
  sessionView = null;
  FakeResizeObserver.instances = [];
  document.body.replaceChildren();
  localStorage.clear();
});

/** The bus's own endpoints — never a control anyone asserts on. */
const RUNTIME_BUS_URLS = ["/api/runtime/snapshot", "/api/runtime/stream"];

/**
 * Every test's fetch stub, with the runtime bus's own traffic kept out of it.
 * The first strip mount starts the tab-wide bus, which fetches
 * `/api/runtime/snapshot` on its own schedule — landing in whichever test's
 * recorder happens to be installed when it resolves and adding a request nobody
 * made (it made the whole file order-dependent). The guard answers the bus
 * itself so each test only ever records the controls it asked about; every
 * other URL, `/api/runtime/interrupt` included, reaches the test's handler.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (RUNTIME_BUS_URLS.some((busUrl) => String(url).startsWith(busUrl))) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response);
    }
    return handler(String(url), init);
  }) as typeof fetch;
}

const stopButton = (host: HTMLElement) =>
  host.querySelector(`button[aria-label^="${translate("en", "composer.interruptAria")}"]`) as HTMLButtonElement | null;

test("a scanner-shaped subagent with a live structured root renders an ENABLED Stop with the root-agent note", async () => {
  const { host, root } = await mount(subagent);
  expect(host.querySelector('[data-strip-surface="structured-subagent"]')).not.toBeNull();
  const stop = stopButton(host);
  expect(stop).not.toBeNull();
  expect(stop!.disabled).toBe(false);
  expect(stop!.getAttribute("aria-disabled")).toBeNull();
  expect(stop!.getAttribute("aria-label")).toContain(translate("en", "strip.stopSubagent"));
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent whose root is dead stays gated — no strip", async () => {
  rootAxis = "dead";
  const { host, root } = await mount(subagent);
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  await act(async () => root.unmount());
});

test("the width observer attaches when the strip mounts late (gated → live root) and folds the layout", async () => {
  // The root host is not live yet: the strip renders nothing, so nothing is observed.
  rootAxis = "dead";
  const { host, root } = await mount(subagent);
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  expect(FakeResizeObserver.instances.reduce((n, o) => n + o.observed.length, 0)).toBe(0);

  // Host evidence arrives: the strip root mounts NOW, and the observer must
  // attach to it (a mount-once effect would have missed this late mount).
  rootAxis = "hosted";
  await act(async () => root.render(<AgentControlStrip file={subagent} />));
  expect(host.querySelector("[data-agent-control-strip]")).not.toBeNull();
  const attached = FakeResizeObserver.instances.filter((o) => o.observed.length > 0);
  expect(attached).toHaveLength(1);

  // Measured width drives the §3 faces: <430 folds to narrow, <300 to mini.
  await act(async () => attached[0]!.resize(360));
  expect(host.querySelector('[data-strip-layout="narrow"]')).not.toBeNull();
  await act(async () => attached[0]!.resize(250));
  expect(host.querySelector('[data-strip-layout="mini"]')).not.toBeNull();
  await act(async () => attached[0]!.resize(600));
  expect(host.querySelector('[data-strip-layout="full"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("Stop on a structured-root subagent relays to the root's structured interrupt — zero /api/tmux, /api/proc", async () => {
  const calls: { url: string; body: unknown }[] = [];
  stubFetch((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, operationId: "op-1" }) } as unknown as Response);
  });

  const { host, root } = await mount(subagent);
  const stop = stopButton(host)!;
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // exactly one root structured interrupt, carrying the ROOT conversationId
  const interrupts = calls.filter((c) => c.url.includes("/api/runtime/interrupt"));
  expect(interrupts.length).toBe(1);
  expect((interrupts[0]!.body as { conversationId?: string }).conversationId).toBe("conv-root");
  // never the legacy routes for a structured root
  expect(calls.some((c) => c.url.includes("/api/tmux"))).toBe(false);
  expect(calls.some((c) => c.url.includes("/api/proc"))).toBe(false);
  await act(async () => root.unmount());
});

test("Stop on a live TMUX-root subagent keeps the canonical /api/tmux child path", async () => {
  rootKind = "tmux-legacy";
  const calls: { url: string; body: unknown }[] = [];
  stubFetch((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, target: "root:%1" }) } as unknown as Response);
  });

  const { host, root } = await mount(subagent);
  expect(host.querySelector('[data-strip-surface="live-subagent"]')).not.toBeNull();
  const stop = stopButton(host)!;
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const interrupts = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(interrupts.length).toBe(1);
  expect(interrupts[0]!.body).toEqual({ action: "interrupt", path: "/child.jsonl" });
  expect(calls.some((c) => c.url.includes("/api/runtime/interrupt"))).toBe(false);
  await act(async () => root.unmount());
});

/* ------------------------- #862 structured compact ------------------------- */

const structuredRoot: FileEntry = {
  path: "/root.jsonl", root: "codex-sessions", name: "root.jsonl", project: "viewer", title: "root",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1,
  activity: "live", proc: "running", pid: null, model: "gpt-5.3-codex-spark", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

function structuredCodexView(): RuntimeSessionView {
  return {
    session: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      conversationId: "conv-root",
      capabilities: { steer: true, structuredAttention: true },
    } as unknown as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"],
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  };
}

const compactButton = (host: HTMLElement) =>
  host.querySelector(`button[aria-label^="${translate("en", "composer.compactAria")}"]`) as HTMLButtonElement | null;

async function confirmCompact(host: HTMLElement): Promise<void> {
  const button = compactButton(host)!;
  await act(async () => button.click());
  await act(async () => button.click());
}

const statusText = (host: HTMLElement) =>
  (host.querySelector("[aria-live]") as HTMLElement | null)?.textContent ?? "";

test("a rejected compaction is reported as the refusal, not as a started compaction", async () => {
  sessionView = structuredCodexView();
  const bodies: Array<Record<string, unknown>> = [];
  stubFetch((url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
    /* Structured controls answer 202 `ok` for a receipt the journal REFUSED,
       so the receipt decides what the operator is told. */
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        structured: true,
        target: "conv-root",
        operationId: String(bodies.at(-1)!.operationId),
        receipt: { operationId: String(bodies.at(-1)!.operationId), status: "rejected", reason: "busy-turn" },
      }),
    } as unknown as Response);
  });

  const { host, root } = await mount(structuredRoot);
  expect(host.querySelector('[data-strip-surface="structured"]')).not.toBeNull();
  await confirmCompact(host);

  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.action).toBe("compact");
  /* The operator reads a sentence, not the durable record's machine token. */
  expect(statusText(host)).toBe(translate("en", "receipt.human.turnActive"));
  expect(statusText(host)).not.toBe(translate("en", "composer.compactSent"));

  /* The refusal is terminal and stored, and idempotency replays a stored
     receipt for the same key forever — so the gesture's operation is released
     and the next attempt is a genuinely new one. Holding the id would answer
     every later click with this same stale refusal. */
  await confirmCompact(host);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.operationId).not.toBe(bodies[0]!.operationId);
  await act(async () => root.unmount());
});

test("a typed capability refusal is localized from its code, not echoed in English", async () => {
  sessionView = structuredCodexView();
  const calls: string[] = [];
  stubFetch((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
    ok: false,
    json: () => Promise.resolve({
      /* `dispatchStructuredControl`'s capability body: the sentence is a
         server-side English string, so the code is what the operator reads. */
      error: "the codex structured host does not expose a compact control",
      code: "unsupported-capability",
      capability: { control: "compact", engine: "codex", supported: false },
    }),
    } as unknown as Response);
  });

  const { host, root } = await mount(structuredRoot);
  await confirmCompact(host);

  expect(calls).toEqual(["/api/tmux"]);
  expect(statusText(host)).toBe(translate("en", "receipt.human.unsupportedCapability"));
  expect(statusText(host)).not.toContain("stream-json");
  await act(async () => root.unmount());
});

test("an ambiguous transport failure keeps the gesture on one operation", async () => {
  sessionView = structuredCodexView();
  const bodies: Array<Record<string, unknown>> = [];
  stubFetch((url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
    /* The runtime-host socket failed and no receipt came back: the compaction
       may or may not have been admitted, so the retry must name the same
       operation rather than risk a second one. */
    return Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ error: "runtime host request timed out" }),
    } as unknown as Response);
  });

  const { host, root } = await mount(structuredRoot);
  await confirmCompact(host);
  expect(statusText(host)).toBe("runtime host request timed out");

  await confirmCompact(host);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.operationId).toBe(bodies[0]!.operationId);
  await act(async () => root.unmount());
});

/* --------------------- #1214 the Claude compact path --------------------- */

const structuredClaudeRoot: FileEntry = {
  path: "/claude-root.jsonl", root: "claude-projects", name: "claude-root.jsonl", project: "viewer", title: "root",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
  activity: "live", proc: "running", pid: null, model: "opus", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

function structuredClaudeView(receipts: RuntimeSessionView["receipts"] = []): RuntimeSessionView {
  return {
    session: {
      hostKind: "claude-broker",
      host: "hosted",
      turn: "idle",
      sessionKey: { engine: "claude", sessionId: "session-claude" },
      conversationId: "conv-claude",
      capabilities: { steer: true, structuredAttention: true },
    } as unknown as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"],
    attentions: [],
    receipts,
    legacy: false,
    structuredControlsEnabled: true,
  };
}

test("the Claude compact control is offered, sends the command, and reports what was witnessed", async () => {
  sessionView = structuredClaudeView();
  const bodies: Array<Record<string, unknown>> = [];
  stubFetch((url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        structured: true,
        target: "conv-claude",
        operationId: String(bodies.at(-1)!.operationId),
        receipt: { operationId: String(bodies.at(-1)!.operationId), status: "pending" },
      }),
    } as unknown as Response);
  });

  const { host, root } = await mount(structuredClaudeRoot);
  /* The control is there and live — not a disabled cell explaining that the
     engine the operator uses daily has no /compact. */
  expect(compactButton(host)!.disabled).toBe(false);
  await confirmCompact(host);

  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.action).toBe("compact");
  /* The admitted line promises a sent command, not a finished compaction. */
  expect(statusText(host)).toBe(translate("en", "composer.compactSentClaude"));

  /* The durable receipt then replaces it with the outcome that was actually
     witnessed — here, none. */
  const operationId = String(bodies[0]!.operationId);
  sessionView = structuredClaudeView([{
    operationId,
    idempotencyKey: operationId,
    conversationId: "conv-claude",
    kind: "compact",
    status: "uncertain",
    reason: "compact-sent-unobserved",
    at: "2026-08-27T00:00:00.000Z",
    revision: 2,
  }]);
  await act(async () => root.render(<AgentControlStrip file={structuredClaudeRoot} />));
  expect(statusText(host)).toBe(translate("en", "receipt.human.compactSentUnobserved"));

  /* A compaction the engine declined is its own visible ending — the command
     went and nothing was compacted — instead of the generic failure line. */
  sessionView = structuredClaudeView([{
    operationId,
    idempotencyKey: operationId,
    conversationId: "conv-claude",
    kind: "compact",
    status: "failed",
    reason: "compact-declined",
    at: "2026-08-27T00:00:30.000Z",
    revision: 3,
  }]);
  await act(async () => root.render(<AgentControlStrip file={structuredClaudeRoot} />));
  expect(statusText(host)).toBe(translate("en", "receipt.human.compactDeclined"));
  expect(statusText(host)).not.toBe(translate("en", "composer.failedCompact"));

  /* And a compaction that WAS witnessed says so. */
  sessionView = structuredClaudeView([{
    operationId,
    idempotencyKey: operationId,
    conversationId: "conv-claude",
    kind: "compact",
    status: "delivered",
    reason: "compaction:boundary-one",
    at: "2026-08-27T00:01:00.000Z",
    revision: 4,
  }]);
  await act(async () => root.render(<AgentControlStrip file={structuredClaudeRoot} />));
  expect(statusText(host)).toBe(translate("en", "composer.compactObserved"));

  /* A settled compaction is a note about one action, not a permanent line: the
     next action starts from a clean status, or its own note would never show. */
  await act(async () => stopButton(host)!.click());
  expect(statusText(host)).not.toBe(translate("en", "composer.compactObserved"));
  await act(async () => root.unmount());
});

test("compact still mints an operation id without a secure context", async () => {
  sessionView = structuredCodexView();
  const bodies: Array<Record<string, unknown>> = [];
  stubFetch((url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, structured: true, target: "conv-root", receipt: { status: "pending" } }),
    } as unknown as Response);
  });
  /* Plain-http LAN access has no `crypto.randomUUID`. Reaching for it directly
     would throw outside the try, leaving the button permanently busy. */
  const cryptoObject = globalThis.crypto as { randomUUID?: unknown };
  const realRandomUUID = cryptoObject.randomUUID;
  delete cryptoObject.randomUUID;
  try {
    const { host, root } = await mount(structuredRoot);
    await confirmCompact(host);

    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]!.operationId).toBe("string");
    expect(String(bodies[0]!.operationId).length).toBeGreaterThan(8);
    expect(statusText(host)).toBe(translate("en", "composer.compactSent"));
    await act(async () => root.unmount());
  } finally {
    if (realRandomUUID !== undefined) cryptoObject.randomUUID = realRandomUUID;
  }
});
