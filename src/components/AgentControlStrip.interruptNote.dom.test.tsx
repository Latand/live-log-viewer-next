/**
 * P1 — the interrupt note may never contradict the turn spinner.
 *
 * The operator's screenshot showed "sent Escape — agent interrupted" sitting
 * beside a live "working…" spinner on the same card: the strip's note is a
 * one-shot toast, so it kept asserting a stopped agent while the pane still
 * reported a running turn.
 *
 * The note now reconciles against the SAME turn state the spinner reads
 * (`turnIsRunning`): it says the Escape is still landing while that turn runs,
 * it says the agent is interrupted once the turn is over, and it leaves
 * altogether once a DIFFERENT turn is running — that note is about a turn the
 * operator can no longer see.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

class FakeResizeObserver {
  constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {}
  observe(): void {
    this.cb([{ contentRect: { width: 900 } }]);
  }
  unobserve(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });

/* Pure legacy pane: `file.proc` is the host authority and Stop takes the
   canonical /api/tmux interrupt path. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => ({ enabled: false, connection: "offline", resyncedAt: null, store: {} }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const { AgentControlStrip } = await import("./AgentControlStrip");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
});

const TURN_STARTED = 1_770_000_000_000;

function liveRoot(turn: { startedAt: number; endedAt: number | null } | null, activity: "live" | "idle" = "live"): FileEntry {
  return {
    path: "/codex-root.jsonl", root: "codex-sessions", name: "codex-root.jsonl", project: "viewer",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1,
    activity, proc: "running", pid: 4242, conversationId: "conv-strip-interrupt",
    pendingQuestion: null, waitingInput: null,
    ...(turn ? { lastTurn: turn } : {}),
  } as FileEntry;
}

async function mount(file: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentControlStrip file={file} />));
  return { host, root };
}

function stubInterrupt(): void {
  globalThis.fetch = ((url: string) => {
    if (String(url) === "/api/tmux") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  }) as typeof fetch;
}

const stopButton = (host: HTMLElement) =>
  host.querySelector(`button[aria-label^="${translate("en", "composer.interruptAria")}"]`) as HTMLButtonElement;

const noteText = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent ?? "";

async function sendEscape(host: HTMLElement): Promise<void> {
  const stop = stopButton(host);
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("while the interrupted turn is still running the note says the agent has not stopped yet", async () => {
  stubInterrupt();
  const running = liveRoot({ startedAt: TURN_STARTED, endedAt: null });
  const { host, root } = await mount(running);
  await sendEscape(host);

  /* The spinner and the note describe the same turn, so they must agree. */
  expect(noteText(host)).toBe(translate("en", "composer.escapeSentWaiting"));
  expect(noteText(host)).not.toBe(translate("en", "composer.escapeSent"));
  await act(async () => root.unmount());
});

test("once that turn ends the note reads as the completed interrupt", async () => {
  stubInterrupt();
  const running = liveRoot({ startedAt: TURN_STARTED, endedAt: null });
  const { host, root } = await mount(running);
  await sendEscape(host);

  const stopped = liveRoot({ startedAt: TURN_STARTED, endedAt: TURN_STARTED + 4_000 }, "idle");
  await act(async () => root.render(<AgentControlStrip file={stopped} />));
  expect(noteText(host)).toBe(translate("en", "composer.escapeSent"));
  await act(async () => root.unmount());
});

test("a NEW running turn retires the note instead of contradicting the spinner", async () => {
  stubInterrupt();
  const running = liveRoot({ startedAt: TURN_STARTED, endedAt: null });
  const { host, root } = await mount(running);
  await sendEscape(host);
  expect(noteText(host)).not.toBe("");

  const nextTurn = liveRoot({ startedAt: TURN_STARTED + 30_000, endedAt: null });
  await act(async () => root.render(<AgentControlStrip file={nextTurn} />));
  expect(noteText(host)).toBe("");
  expect(host.textContent).not.toContain(translate("en", "composer.escapeSent"));
  expect(host.textContent).not.toContain(translate("en", "composer.escapeSentWaiting"));
  await act(async () => root.unmount());
});

test("a note retired by a new turn stays retired once that turn ends", async () => {
  stubInterrupt();
  const { host, root } = await mount(liveRoot({ startedAt: TURN_STARTED, endedAt: null }));
  await sendEscape(host);

  /* Retirement has to be terminal. Hidden-while-running only would let the note
     come back the moment this unrelated turn stopped, telling the operator that
     a turn nobody interrupted was interrupted — and again after every later
     turn, forever. */
  const nextTurn = liveRoot({ startedAt: TURN_STARTED + 30_000, endedAt: null });
  await act(async () => root.render(<AgentControlStrip file={nextTurn} />));
  expect(noteText(host)).toBe("");

  const nextEnded = liveRoot({ startedAt: TURN_STARTED + 30_000, endedAt: TURN_STARTED + 45_000 }, "idle");
  await act(async () => root.render(<AgentControlStrip file={nextEnded} />));
  expect(noteText(host)).toBe("");
  expect(host.textContent).not.toContain(translate("en", "composer.escapeSent"));
  await act(async () => root.unmount());
});

test("a failed interrupt still reports its own error, untouched by the turn state", async () => {
  globalThis.fetch = ((url: string) => {
    if (String(url) === "/api/tmux") {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false, error: "no pane" }) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  }) as typeof fetch;
  const { host, root } = await mount(liveRoot({ startedAt: TURN_STARTED, endedAt: null }));
  await sendEscape(host);
  expect(noteText(host)).toBe("no pane");
  await act(async () => root.unmount());
});
