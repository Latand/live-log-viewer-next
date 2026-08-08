/**
 * P1 — an account switch must leave ONE coherent delivery story on the card.
 *
 * The operator's screenshot showed a single conversation card claiming, at the
 * same moment: a queued composer receipt, a "Delivering" outbox chip, and
 * "Held for «» — delivers after the account switch" with an EMPTY account name.
 * Three delivery states for one message, one of them naming nobody.
 *
 * Two rules are asserted here:
 *  1. No surface ever interpolates an empty account name. When the pending
 *     annotation carries neither `targetLabel` nor `targetAccountId`, the copy
 *     is the nameless variant, never «».
 *  2. A queued submission's bubble is its ONE delivery state. The composer's
 *     receipt row and status line belong to a DIRECT send, which has no bubble.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ConversationMigration, FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* The legacy pane route is the subject here, so the runtime plane stays OFF:
   `file.proc` is the host authority and the composer sends through /api/tmux. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => ({
    enabled: false,
    structuredHostsEnabled: false,
    connection: "offline",
    resyncedAt: null,
    store: {},
  }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");
const { enqueueOutbox, readOutbox, resetOutboxForTests } = await import("./conversation/outbox");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const CARD = "conv-migration-hold";

/** The pending window exactly as the coordinator publishes it before the target
    identity reaches the card: `waiting-turn`, no label, no account id. */
const pendingWithoutTarget = {
  intentId: "intent-1",
  trigger: "manual",
  phase: "waiting-turn",
  targetAccountId: "",
  failure: null,
} as unknown as ConversationMigration;

function fileWith(migration: ConversationMigration | undefined): FileEntry {
  return {
    path: "/codex-hold.jsonl",
    root: "codex-sessions",
    name: "codex-hold.jsonl",
    project: "viewer",
    title: "Codex",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: null,
    conversationId: CARD,
    pendingQuestion: null,
    waitingInput: null,
    ...(migration ? { migration } : {}),
  } as FileEntry;
}

/** The legacy pane route answers with the migration hold the coordinator took:
    admitted, not delivered, waiting for the successor. */
function stubHeldSend(): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    if (url === "/api/tmux") {
      state.calls += 1;
      return { ok: true, json: async () => ({ ok: true, outcome: "held" }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
  return state;
}

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Every delivery-state word the composer can paint for one message. */
function deliveryStatements(host: HTMLElement, locale: "en" | "uk"): string[] {
  const text = host.textContent ?? "";
  return ([
    "composer.receiptHeld",
    "composer.receiptQueued",
    "composer.receiptRecovering",
    "composer.deliveryHeld",
    "composer.deliveryHeldUnnamed",
    "common.sent",
  ] as const)
    .map((key) => translate(locale, key, { label: "" }))
    .filter((phrase) => phrase.length > 0 && text.includes(phrase));
}

test("a held delivery in the pending window never names an empty account", async () => {
  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    stubHeldSend();
    /* A direct send: the retry of a failed receipt is the one path that still
       reports through the composer's own status line. */
    sessionStorage.setItem(`llvSent:${CARD}`, JSON.stringify([
      { id: 1, text: "second try", at: Date.now(), via: "pane", state: "failed", clientMessageId: "key-retry" },
    ]));
    const { host, root } = await renderInto(<TmuxComposer file={fileWith(pendingWithoutTarget)} />);
    const retry = host.querySelector(
      `button[aria-label="${translate(locale, "composer.retrySend")}"]`,
    ) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    expect(host.textContent).not.toContain("«»");
    expect(host.textContent).toContain(translate(locale, "composer.deliveryHeldUnnamed"));
    await act(async () => root.unmount());
    sessionStorage.clear();
    resetOutboxForTests();
  }
});

test("a named target still reads as the named hold", async () => {
  stubHeldSend();
  sessionStorage.setItem(`llvSent:${CARD}`, JSON.stringify([
    { id: 1, text: "second try", at: Date.now(), via: "pane", state: "failed", clientMessageId: "key-retry" },
  ]));
  const named = { ...pendingWithoutTarget, targetLabel: "Account B" } as ConversationMigration;
  const { host, root } = await renderInto(<TmuxComposer file={fileWith(named)} />);
  const retry = host.querySelector(
    `button[aria-label="${translate("en", "composer.retrySend")}"]`,
  ) as HTMLButtonElement;
  await act(async () => {
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();

  expect(host.textContent).toContain(translate("en", "composer.deliveryHeld", { label: "Account B" }));
  await act(async () => root.unmount());
});

test("a queued submission held for the switch paints exactly ONE delivery state", async () => {
  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    const wire = stubHeldSend();
    enqueueOutbox(CARD, { id: "key-queued", text: "message for the successor", images: 0, at: Date.now() });

    const { host, root } = await renderInto(<TmuxComposer file={fileWith(pendingWithoutTarget)} />);
    await settle();
    expect(wire.calls).toBe(1);

    /* The bubble in the feed carries the state; the composer repeats nothing. */
    expect(readOutbox(CARD)[0]).toMatchObject({ id: "key-queued", state: "delivering" });
    expect(deliveryStatements(host, locale)).toEqual([]);
    expect(host.textContent).not.toContain("«»");

    await act(async () => root.unmount());
    sessionStorage.clear();
    resetOutboxForTests();
  }
});

test("a held delivery with no migration annotation at all still says something true", async () => {
  stubHeldSend();
  sessionStorage.setItem(`llvSent:${CARD}`, JSON.stringify([
    { id: 1, text: "second try", at: Date.now(), via: "pane", state: "failed", clientMessageId: "key-retry" },
  ]));
  const { host, root } = await renderInto(<TmuxComposer file={fileWith(undefined)} />);
  const retry = host.querySelector(
    `button[aria-label="${translate("en", "composer.retrySend")}"]`,
  ) as HTMLButtonElement;
  await act(async () => {
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();

  expect(host.textContent).not.toContain("«»");
  expect(host.textContent).toContain(translate("en", "composer.deliveryHeldUnnamed"));
  await act(async () => root.unmount());
});
