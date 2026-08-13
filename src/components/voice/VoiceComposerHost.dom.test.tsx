/**
 * THE CARD LEAVES; THE CALL DOES NOT NOTICE.
 *
 * The #691 hoist exists for one moment: the operator is on a call, navigates to
 * another project, and the conversation card that used to own the composer
 * unmounts. Everything the composer holds — the draft, the outbox and its
 * dispatcher, the dictation, staged images and their object URLs — has to survive
 * that, exactly once, with the report relay still polling.
 *
 * These cases drive the REAL components (`VoiceComposerHost`, the real card
 * composer through `TmuxComposer`, `VoiceBridgeRelayHost` and the real `voiceSlots`
 * registry), because every failure mode here is a lifetime, and a stub has none:
 *
 * - a SECOND composer (two outboxes, two dictation owners, two dispatchers racing
 *   the same queue);
 * - a composer TORN DOWN with its card (the recording dies, the object URLs are
 *   revoked, the queue stops draining);
 * - a composer parked FOREVER, for a call that ended hours ago, plus the props
 *   snapshot it renders from — the leak that made the retained `activeCall`
 *   projection the wrong thing for a composer to read;
 * - a relay restarted (or stopped) because the card it used to sit under is gone.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
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
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  File: dom.File,
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

const CONVERSATION = "conversation_hoist_lifecycle";

const structuredView = {
  session: {
    conversationId: CONVERSATION,
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: false, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: (conversationId: string | null) =>
    (conversationId === CONVERSATION ? structuredView : realUseRuntimeSession(conversationId)),
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) =>
    (conversationId === CONVERSATION ? [] : realUseRuntimeReceiptsForArtifact(path, conversationId)),
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { appendComposerDraft, TmuxComposer } = await import("@/components/TmuxComposer");
const { readOutbox, resetOutboxForTests } = await import("@/components/conversation/outbox");
const { reportCallPhase, resetActiveCallsForTest } = await import("@/lib/realtime/activeCall");
const { getVoiceComposerCardPropsIds, resetVoiceSlotsForTest } = await import("./voiceSlots");
const { resetManagerIdentityForTest } = await import("./managerIdentity");
const { VoiceBridgeRelayHost } = await import("./VoiceBridgeRelayHost");
const { VoiceComposerHost } = await import("./VoiceComposerHost");

const file = {
  path: "/hoist-lifecycle.jsonl", root: "codex-sessions", name: "hoist-lifecycle.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: CONVERSATION,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;
let roots: Root[] = [];
let bridgePolls = 0;
/* The relay's own lifetime, observed through the subscription it takes on the one
   client: a teardown releases it, and a restart takes a second one. */
let relaySubscriptions = 0;
let relayReleases = 0;
let relayResolutions: string[] = [];

const relayClient = {
  reconcileWorkerDeliveries: () => undefined,
  onDeliveryAcknowledged: () => {
    relaySubscriptions += 1;
    return () => { relayReleases += 1; };
  },
  realtimeSession: () => "rt_live",
};

beforeEach(() => {
  bridgePolls = 0;
  relaySubscriptions = 0;
  relayReleases = 0;
  relayResolutions = [];
  resetActiveCallsForTest();
  resetVoiceSlotsForTest();
  resetOutboxForTests();
  resetManagerIdentityForTest();
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("/api/bridge")) {
      bridgePolls += 1;
      return json({ ok: true, plan: { kind: "idle" } });
    }
    if (url === "/api/runtime/send") return json({ operationId: "op-1", receipt: { status: "delivering", operationId: "op-1" } });
    if (url.startsWith("/api/orchestrator/seat?")) return json({ seat: null, pending: null, exists: false });
    return json({});
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetActiveCallsForTest();
  resetVoiceSlotsForTest();
});

/** The Viewer, as far as this seam is concerned: the two Viewer-level owners, plus
    a board that may or may not currently be rendering the conversation's card. */
function Viewer({ card }: { card: boolean }) {
  return (
    <>
      <VoiceComposerHost />
      <VoiceBridgeRelayHost resolveClient={(conversationId) => {
        relayResolutions.push(conversationId);
        return relayClient;
      }} />
      {card ? <TmuxComposer file={file} /> : null}
    </>
  );
}

async function mountViewer(): Promise<(card: boolean) => Promise<void>> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (card: boolean) => {
    await act(async () => {
      root.render(<Viewer card={card} />);
      for (let tick = 0; tick < 6; tick += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  await render(true);
  return render;
}

/** A call coming up on this conversation, reported the way the client reports it. */
async function startCall(): Promise<void> {
  await act(async () => {
    reportCallPhase(CONVERSATION, "live");
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function hangUp(): Promise<void> {
  await act(async () => {
    reportCallPhase(CONVERSATION, "idle");
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Every composer form in the document — the count that must never be two. */
const composers = () => document.querySelectorAll("form textarea");
const micButtons = () => document.querySelectorAll("button[aria-label='Dictate']");
const parked = () => document.querySelectorAll("[data-testid='voice-composer-parked']");
const cardSlot = () => document.querySelector("[data-testid='voice-composer-card-slot']");

test("with the card on screen there is exactly one composer, and it renders in the card's slot", async () => {
  await mountViewer();

  expect(composers()).toHaveLength(1);
  expect(micButtons()).toHaveLength(1);
  /* Rendered by the HOST but living in the card's published place: the hoist is
     invisible until the card leaves. */
  expect(cardSlot()!.querySelector("textarea")).not.toBeNull();
  expect(parked()).toHaveLength(0);
});

test("the card leaving MID-CALL keeps exactly one composer, one outbox and one dictation owner", async () => {
  const render = await mountViewer();
  await startCall();

  /* A queued message the dispatcher owns: if the card unmount produced a second
     composer, a second dispatcher would be draining this same queue. */
  await act(async () => {
    appendComposerDraft(CONVERSATION, "keep working on this");
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (document.querySelector("form") as HTMLFormElement)
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let tick = 0; tick < 8; tick += 1) await new Promise((r) => setTimeout(r, 0));
  });
  expect(readOutbox(CONVERSATION)).toHaveLength(1);

  /* The operator opens another project: the card unmounts, the call does not. */
  await render(false);

  expect(composers()).toHaveLength(1);
  expect(micButtons()).toHaveLength(1);
  /* Mounted and hidden — the container that keeps a recording recording and an
     object URL valid — rather than portalled into a card that no longer exists. */
  expect(parked()).toHaveLength(1);
  expect(parked()[0]!.querySelector("textarea")).not.toBeNull();
  expect(cardSlot()).toBeNull();
  /* ONE outbox, with the message still in it: not drained twice, not lost. */
  expect(readOutbox(CONVERSATION)).toHaveLength(1);
});

test("the report relay is never torn down or restarted by the card leaving", async () => {
  const render = await mountViewer();
  await startCall();

  expect(relayResolutions).toEqual([CONVERSATION]);
  expect(relaySubscriptions).toBe(1);
  const pollsWhileCarded = bridgePolls;
  expect(pollsWhileCarded).toBeGreaterThan(0);

  await render(false);

  /* Its lifetime is the CALL's, not the card's: same client, same subscription,
     nothing released, no second poll loop started. */
  expect(new Set(relayResolutions)).toEqual(new Set([CONVERSATION]));
  expect(relaySubscriptions).toBe(1);
  expect(relayReleases).toBe(0);
});

test("the call ending with no card on screen releases the composer — a hidden one is not parked forever", async () => {
  const render = await mountViewer();
  await startCall();
  await render(false);
  expect(composers()).toHaveLength(1);

  await hangUp();

  /* The retained `activeCall` projection keeps naming this conversation so the
     ended transcript stays readable. Read by the COMPOSER owner, that would park
     this hidden composer for the rest of the tab's life. */
  expect(composers()).toHaveLength(0);
  expect(parked()).toHaveLength(0);
  /* And the props snapshot it rendered from is released with it: retained past the
     card on purpose, but not forever, and not one per conversation ever opened. */
  expect(getVoiceComposerCardPropsIds()).toEqual([]);
});

test("the relay stops with the call, and a returning card gets its composer back", async () => {
  const render = await mountViewer();
  await startCall();
  await render(false);
  await hangUp();

  /* The relay's effect ended with the call — released once, never re-subscribed. */
  expect(relayReleases).toBe(1);

  /* The operator navigates back: the card publishes again and the composer returns,
     still exactly one of it. */
  await render(true);
  expect(composers()).toHaveLength(1);
  expect(cardSlot()!.querySelector("textarea")).not.toBeNull();
  expect(getVoiceComposerCardPropsIds()).toEqual([CONVERSATION]);
});

test("a card that leaves with NO call up takes its composer and its retained props with it", async () => {
  const render = await mountViewer();
  expect(composers()).toHaveLength(1);

  await render(false);

  /* Exactly what a card-scoped composer always did — the hoist changes nothing for
     a conversation that is not on a call. */
  expect(composers()).toHaveLength(0);
  expect(getVoiceComposerCardPropsIds()).toEqual([]);
});
