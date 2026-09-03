/**
 * Mobile v2 lane 5 (#1439) — the phone composer's send slot, against the REAL
 * TmuxComposer (README §2 rule 8, §4.2's state table).
 *
 * The operator photographed three rows stacked above the keyboard: a live-tail
 * pill, a «working… 1m 31s» status row, and a model/effort row. The slot is
 * what replaced the first two — one control that says what the one useful
 * action is right now — so what it becomes, and from WHICH authority, is the
 * acceptance:
 *
 *   working + nothing typed  → Stop (and the first keystroke flips it to send)
 *   runtime offline          → Queue
 *   killed                   → Respawn (a send is impossible; this is the way back)
 *
 * The kind is read off `chatState`, the same projection the conversation bar's
 * meta line renders, so the slot and the bar can never disagree about what the
 * conversation is doing (§2 rule 10 — the 2026-08 audit's finding 3).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { ConnectionState } from "@/components/runtime/runtimeModel";
import { setRuntimeBusForTests, type RuntimeBus, type RuntimeBusState } from "@/hooks/runtimeBus";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
installActEnv();
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
});
let mobile = true;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

import { TmuxComposer } from "./TmuxComposer";

/* A bus whose connection the test drives. One frozen state object per
   connection: `useSyncExternalStore` compares snapshots by identity, and a
   fresh object per read re-renders forever. */
const listeners = new Set<() => void>();
const STATES: Record<string, RuntimeBusState> = {};
const stateFor = (value: ConnectionState): RuntimeBusState => (STATES[value] ??= {
  enabled: true,
  structuredHostsEnabled: true,
  connection: value,
  resyncedAt: null,
  lastEventAt: null,
  store: emptyStore(),
});
let connection: ConnectionState = "live";
const testBus: RuntimeBus = {
  getState: () => stateFor(connection),
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};

const realFetch = globalThis.fetch;
const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  setLocale("en");
  connection = "live";
  calls.length = 0;
  setRuntimeBusForTests(testBus);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  setRuntimeBusForTests(null);
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** A legacy-hosted conversation card; `patch` puts it in one lifecycle state. */
function conversation(patch: Partial<FileEntry> = {}): FileEntry {
  const now = Math.floor(Date.now() / 1000);
  return {
    path: "/slot-1439.jsonl",
    root: "codex-sessions",
    name: "slot-1439.jsonl",
    project: "viewer",
    title: "Rebuild the board status projection",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: now,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 4242,
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
    lastTurn: { startedAt: Date.now() - 90_000, endedAt: null },
    ...patch,
  } as FileEntry;
}

async function render(file: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={file} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const slot = (host: HTMLElement): HTMLButtonElement | null => host.querySelector("[data-mobile2-send]");
const slotKind = (host: HTMLElement): string | null => slot(host)?.getAttribute("data-mobile2-send") ?? null;

function type(host: HTMLElement, value: string): void {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value } }));
}

test("working with an empty draft is Stop, and the first keystroke flips it to send", async () => {
  const { host, root } = await render(conversation());
  expect(slotKind(host)).toBe("stop");
  expect(slot(host)!.getAttribute("aria-label")).toBe("Stop the agent");

  /* Typing does not stop being able to stop — it stops being the useful thing
     to offer: the message queues behind the running turn (§4.2). */
  type(host, "also add the held precedence test");
  expect(slotKind(host)).toBe("send");

  type(host, "");
  expect(slotKind(host)).toBe("stop");
  flushSync(() => root.unmount());
});

test("Stop interrupts the conversation the composer is pointed at", async () => {
  const { host, root } = await render(conversation());
  await act(async () => {
    slot(host)!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  const interrupt = calls.find((call) => call.url === "/api/tmux" && (call.body as { action?: string } | null)?.action === "interrupt");
  expect(interrupt).toBeTruthy();
  expect((interrupt!.body as { path: string }).path).toBe("/slot-1439.jsonl");
  flushSync(() => root.unmount());
});

test("an idle conversation keeps the ordinary send", async () => {
  const { host, root } = await render(conversation({ proc: null, pid: null, activity: "idle", lastTurn: { startedAt: Date.now() - 900_000, endedAt: Date.now() - 800_000 } }));
  expect(slotKind(host)).toBe("send");
  flushSync(() => root.unmount());
});

test("offline, the slot is Queue and says the text is delivered on reconnect", async () => {
  connection = "offline";
  const { host, root } = await render(conversation());
  expect(slotKind(host)).toBe("queue");
  expect(slot(host)!.textContent).toContain("Queue");
  /* Queue is still a submit — the outbox is what holds the message. */
  expect(slot(host)!.getAttribute("type")).toBe("submit");
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(field.getAttribute("placeholder")).toContain("delivered on reconnect");
  flushSync(() => root.unmount());
});

test("a killed conversation offers Respawn, and the tap resumes its host", async () => {
  const { host, root } = await render(conversation({ proc: "killed", pid: null, activity: "recent" }));
  expect(slotKind(host)).toBe("respawn");
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(field.getAttribute("placeholder")).toContain("queues until a respawn");
  await act(async () => {
    slot(host)!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  const resume = calls.find((call) => call.url === "/api/tmux" && (call.body as { action?: string } | null)?.action === "resume");
  expect(resume).toBeTruthy();
  expect((resume!.body as { path: string }).path).toBe("/slot-1439.jsonl");
  flushSync(() => root.unmount());
});

test("killed outranks offline: the way back beats a queue that cannot drain", async () => {
  connection = "offline";
  const { host, root } = await render(conversation({ proc: "killed", pid: null, activity: "recent" }));
  expect(slotKind(host)).toBe("respawn");
  flushSync(() => root.unmount());
});

test("the desktop composer has no slot and no phone hooks at all", async () => {
  mobile = false;
  try {
    const { host, root } = await render(conversation());
    expect(slot(host)).toBeNull();
    expect(host.querySelector("[data-mobile2-composer]")).toBeNull();
    expect(host.querySelector("[data-mobile2-tools]")).toBeNull();
    /* And the desktop keeps its own send button, and its options row. */
    expect(host.querySelector('form button[type="submit"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="composer-options-row"]')).toBeTruthy();
    flushSync(() => root.unmount());
  } finally {
    mobile = true;
  }
});
