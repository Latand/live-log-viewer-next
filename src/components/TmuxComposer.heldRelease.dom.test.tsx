/**
 * P1 — composer messages held for an account switch must RELEASE once the
 * switch is over, level-triggered, never only on a live event.
 *
 * Reproduced live: two messages on one card read "Held for «B» — delivers
 * after the switch" while the switch had ALREADY completed server-side (the
 * conversation ran under the target account and a fresh send delivered within
 * seconds). The held texts existed in no server-side store — the hold lived in
 * the client outbox, whose only release signals were events (a receipt, the
 * delivered text's transcript echo) that never arrived once the server-side
 * hold record was gone. The entries sat "delivering" forever and, because the
 * dispatcher is serial, everything queued behind them was stranded too.
 *
 * The rule asserted here: whenever the card's account state no longer holds
 * deliveries — the migration annotation vanished, or its target already IS the
 * account the card runs under — every switch-held entry returns to the queue
 * and redelivers under its ORIGINAL idempotency key. On the next snapshot, not
 * only on the event that was missed.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ConversationMigration, FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";

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

/* The legacy pane route is the subject: `file.proc` is the host authority and
   the composer sends through /api/tmux. The runtime plane stays OFF. */
import { TmuxComposer } from "./TmuxComposer";
import { enqueueOutbox, readOutbox, resetOutboxForTests } from "./conversation/outbox";

const realFetch = globalThis.fetch;

beforeEach(() => {
  setRuntimeUiEnabledForTests(false);
});

afterEach(() => {
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const CARD = "conversation_held-release";
const SOURCE_PATH = "/data/accounts/codex/account-a/sessions/hold.jsonl";
const TARGET_PATH = "/data/accounts/codex/account-b/sessions/hold.jsonl";

/** The stale annotation exactly as the incident showed it: still `waiting-turn`
    toward account B while the card already runs under account B. */
const switchingToB: ConversationMigration = {
  intentId: "intent-1",
  trigger: "manual",
  phase: "waiting-turn",
  targetAccountId: "account-b",
  targetLabel: "account-b",
  failure: null,
};

function fileWith(path: string, migration: ConversationMigration | undefined): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: "hold.jsonl",
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

/** The pane route, scripted: answers `held` while `state.outcome` says so, and
    records every send body so replays can be asserted key-exact. */
function stubWire(): { calls: { clientMessageId?: string; text?: string }[]; outcome: "held" | "delivered" } {
  const state = { calls: [] as { clientMessageId?: string; text?: string }[], outcome: "held" as "held" | "delivered" };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    if (url === "/api/tmux") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { clientMessageId?: string; text?: string };
      state.calls.push(body);
      return {
        ok: true,
        json: async () => (state.outcome === "held" ? { ok: true, outcome: "held" } : { ok: true }),
      } as Response;
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

const settle = async (rounds = 1) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** Queue two messages and let the first settle as held-for-the-switch: the
    incident's starting position — one entry parked `delivering`, the second
    stranded `queued` behind the serial dispatcher. */
async function holdTwoMessages(wire: ReturnType<typeof stubWire>, root: Root) {
  enqueueOutbox(CARD, { id: "key-held-1", text: "first held message", images: 0, at: Date.now() });
  enqueueOutbox(CARD, { id: "key-held-2", text: "second held message", images: 0, at: Date.now() + 1 });
  await act(async () => {
    root.render(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-held-1"]);
  expect(readOutbox(CARD).map((entry) => entry.state)).toEqual(["delivering", "queued"]);
}

test("held entries deliver once the hold's target IS the active account, even under a stale annotation", async () => {
  const wire = stubWire();
  const { root } = await renderInto(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
  await holdTwoMessages(wire, root);

  /* The switch completes: the transcript now lives under account B. The
     annotation is STALE — still `waiting-turn` toward the very account the
     card already runs under — and no release event ever fires. */
  wire.outcome = "delivered";
  await act(async () => {
    root.render(<TmuxComposer file={fileWith(TARGET_PATH, switchingToB)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(6);

  /* Both messages redelivered, in order, under their ORIGINAL idempotency
     keys — an idempotent replay, never a second distinct message. */
  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-held-1", "key-held-1", "key-held-2"]);
  expect(readOutbox(CARD).map((entry) => entry.state)).toEqual(["delivered", "delivered"]);
  await act(async () => root.unmount());
});

test("held entries deliver when the migration annotation vanishes (registry already reads migration=null)", async () => {
  const wire = stubWire();
  const { root } = await renderInto(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
  await holdTwoMessages(wire, root);

  wire.outcome = "delivered";
  await act(async () => {
    root.render(<TmuxComposer file={fileWith(TARGET_PATH, undefined)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(6);

  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-held-1", "key-held-1", "key-held-2"]);
  expect(readOutbox(CARD).map((entry) => entry.state)).toEqual(["delivered", "delivered"]);
  await act(async () => root.unmount());
});

test("a live hold toward a DIFFERENT account keeps holding — no premature replay", async () => {
  const wire = stubWire();
  const { root } = await renderInto(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
  await holdTwoMessages(wire, root);

  /* Another poll of the same switching card: nothing may re-fire. */
  await act(async () => {
    root.render(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();

  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-held-1"]);
  expect(readOutbox(CARD).map((entry) => entry.state)).toEqual(["delivering", "queued"]);
  await act(async () => root.unmount());
});

test("a replay the server holds AGAIN does not loop: one replay per hold-level change", async () => {
  const wire = stubWire();
  const { root } = await renderInto(<TmuxComposer file={fileWith(SOURCE_PATH, switchingToB)} />);
  await holdTwoMessages(wire, root);

  /* The annotation drops but the server still answers `held` (e.g. the fence
     outlived the annotation by one poll). The release replays ONCE, re-parks
     the entry as held, and does not hammer the wire. */
  await act(async () => {
    root.render(<TmuxComposer file={fileWith(TARGET_PATH, undefined)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(6);

  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-held-1", "key-held-1"]);
  expect(readOutbox(CARD)[0]!.state).toBe("delivering");
  await act(async () => root.unmount());
});

test("a held entry survives reload and still delivers once the hold is over", async () => {
  /* What a refresh restores after the incident: the persisted queue holds the
     stranded entry. It must deliver — never be silently lost or stuck. */
  sessionStorage.setItem(`llvOutbox:${CARD}`, JSON.stringify([
    { id: "key-reloaded", text: "held before the refresh", images: 0, at: Date.now(), state: "delivering", heldForSwitch: true },
  ]));
  const wire = stubWire();
  wire.outcome = "delivered";
  const { root } = await renderInto(<TmuxComposer file={fileWith(TARGET_PATH, undefined)} />);
  await settle(6);

  expect(wire.calls.map((call) => call.clientMessageId)).toEqual(["key-reloaded"]);
  expect(readOutbox(CARD).map((entry) => entry.state)).toEqual(["delivered"]);
  await act(async () => root.unmount());
});
