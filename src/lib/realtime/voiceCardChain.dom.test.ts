import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";

import { viewBus } from "@/hooks/viewPresenceBus";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { McpToolRefusal } from "@/lib/mcp/server";
import type { VoiceUtteranceLookup } from "@/lib/mcp/selectedContextTarget";
import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";
import { noteVoiceWorkBoundary, resetVoiceViewBindings } from "@/lib/runtime/voiceViewBinding";

import { codexRealtimeClient } from "./codexRealtimeClient";

/**
 * The whole chain, from the wire event to the transcript the agent gets back
 * (#1629).
 *
 * The independent review of the component branch reproduced its two P1s by
 * driving exactly this path, and both defects lived in the joins BETWEEN the
 * pieces — a browser that guessed which utterance a late handoff belonged to,
 * and a reader whose only identity was the conversation. Neither is visible to
 * a test of one piece, so this file drives all three at once:
 *
 * - the REAL `CodexRealtimeClient`, fed the actual data-channel event shapes,
 *   making its own decisions about what to publish;
 * - the REAL `executeRealtimeControl`, holding the real ledger;
 * - the REAL `conversation_messages` binding, resolving a card it was given no
 *   argument for, through the production translation of the endpoint's answer.
 *
 * Only two things are elided. The HTTP hop is a direct call (covered over a real
 * socket in `voiceUtteranceWiring.test.ts`), and the native metadata is supplied
 * rather than produced by a running Codex — the parser that reads it off a real
 * request envelope is covered in `nativeWorkMetadata.test.ts`, and what an
 * actual 0.154.0 puts there is recorded in
 * `docs/design/native-voice-work-identity.md`.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  Audio: dom.Audio,
  MediaStream: dom.MediaStream ?? class {},
});

class StubDataChannel {
  readyState = "open";
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void { this.readyState = "closed"; }
}

class StubPeerConnection {
  static latest: StubPeerConnection | null = null;
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription: { sdp: string } | null = null;
  channel = new StubDataChannel();
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { StubPeerConnection.latest = this; }
  createDataChannel(): StubDataChannel { return this.channel; }
  addTrack(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  async createOffer(): Promise<{ sdp: string }> { return { sdp: "v=0\r\noffer\r\n" }; }
  async setLocalDescription(offer: { sdp: string }): Promise<void> { this.localDescription = offer; }
  async setRemoteDescription(): Promise<void> {}
  close(): void {}
}

const originalFetch = globalThis.fetch;
const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
const originalNavigator = globalThis.navigator;

Object.assign(globalThis, {
  RTCPeerConnection: StubPeerConnection,
  navigator: {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [{ stop() {} }],
        getTracks: () => [{ stop() {} }],
      }),
    },
  },
});

afterAll(() => {
  Object.assign(globalThis, { fetch: originalFetch, RTCPeerConnection: originalRtc, navigator: originalNavigator });
});

/* The client cache is keyed by conversation id and lives for the process, so
   each case gets its own conversation rather than inheriting a live call from
   the one before it. */
let callerSequence = 0;
let CALLER = "conversation_voice_chain_0";
const THREAD = "thread-chain";
const DESK = { viewSessionId: "vs-chain-1", deviceId: "dev-chain-1" };
const CARD_A = "conversation_card_a";
const CARD_B = "conversation_card_b";
const CARD_C = "conversation_card_c";

let sandbox = "";
const transcripts = new Map<string, string>();

/** A host with a live call and the two identity answers #1629 added. */
function voiceHost() {
  return {
    async startRealtimeWebRtc() {
      return {
        sdp: "v=0\r\nanswer",
        realtimeSessionId: "live-1",
        persona: { variant: "modality" as const, personaId: `voice_persona_${"e".repeat(46)}` },
      };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
    currentRealtimeSessionId() { return "live-1"; },
    providerThreadId() { return THREAD; },
    voiceWorkTurnState() { return "unknown" as const; },
    hasActiveTurn() { return false; },
  };
}

/** The authority the route derives, per action. */
async function control(body: Record<string, unknown>) {
  const action = body.action;
  const authority = action === "start"
    ? { operator: true }
    : action === "utteranceContext"
      ? { caller: { kind: "conversation" as const, conversationId: CALLER }, operator: false }
      : { caller: { kind: "session" as const, realtimeSessionId: String(body.realtimeSessionId ?? "") }, operator: false };
  return executeRealtimeControl({ conversationId: CALLER, ...body }, () => voiceHost(), authority);
}

let published: Record<string, unknown>[] = [];

beforeEach(() => {
  resetVoiceViewBindings();
  callerSequence += 1;
  CALLER = `conversation_voice_chain_${callerSequence}`;
  published = [];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-chain-"));
  transcripts.clear();
  for (const [card, line] of [[CARD_A, "card A speaks"], [CARD_B, "card B speaks"], [CARD_C, "card C speaks"]] as const) {
    const file = path.join(sandbox, `${card}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-10T08:59:00.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: line }] },
    })}\n`);
    transcripts.set(card, file);
  }
  dom.localStorage.clear();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    published.push(body);
    const result = await control(body);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.body,
    } as unknown as Response;
  }) as typeof fetch;
  viewBus.reportIdentity(DESK);
  viewBus.reportCards([...transcripts].map(([conversationId, file]) => ({
    path: file, conversationId, project: "atlas", label: conversationId,
  })));
});

afterEach(() => {
  resetVoiceViewBindings();
  viewBus.reportIdentity(null);
  viewBus.reportCards([]);
  viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function looking(card: string): void {
  const file = transcripts.get(card)!;
  viewBus.reportSlice({ mode: "list", focusedPath: file, selectedPaths: [file], visiblePaths: [], camera: null });
}

async function liveCall(): Promise<StubPeerConnection> {
  const client = codexRealtimeClient(CALLER);
  await client.start();
  const peer = StubPeerConnection.latest!;
  peer.channel.onopen?.();
  /* The start POST and its binding have to land before the first utterance. */
  await settle();
  return peer;
}

/** Every publication on this leg is fire-and-forget, so the assertions have to
    let the microtasks it queued run before they look. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/** The operator finishes speaking: this is where the browser pairs the spoken
    turn with the card that was on screen. */
async function spoke(card: string, peer: StubPeerConnection): Promise<void> {
  looking(card);
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "turn.done", role: "user", item: { text: "look at that" } }) });
  await settle();
}

/** Native routes that utterance into the thread. */
async function handedOff(peer: StubPeerConnection, suffix: string): Promise<void> {
  peer.channel.onmessage?.({
    data: JSON.stringify({
      type: "delegation.created",
      item: {
        id: `delegation-${suffix}`,
        type: "delegation",
        target: "client",
        handoff_id: `handoff-${suffix}`,
        user_bidi_turn_id: `bidi-${suffix}`,
      },
    }),
  });
  await settle();
}

const work = (turnId: string, turnTrigger: string | null = "realtime") =>
  ({ threadId: THREAD, turnId, turnTrigger, callId: `call-${turnId}`, itemId: `fc-${turnId}` });

/** The production translation of the endpoint's answer, kept in step with
    `productionVoiceUtteranceContext`. */
const lookup = async (requestWork: unknown): Promise<VoiceUtteranceLookup> => {
  const answer = await control({ action: "utteranceContext", work: requestWork });
  if (answer.status !== 200) return { state: "unavailable", reason: String(answer.body.error ?? answer.status) };
  return answer.body.utterance as VoiceUtteranceLookup;
};

function bindings() {
  const pinnedTranscript = (candidate: string) => {
    if (![...transcripts.values()].includes(candidate)) return undefined;
    const descriptor = fs.openSync(candidate, "r");
    return { descriptor, stat: fs.fstatSync(descriptor), rootName: "codex-sessions", root: sandbox, sameIdentity: () => true };
  };
  return viewerMcpBindings(undefined, undefined, {
    selectedContext: {
      selectedConversation: () => ({
        resolve: (conversationId: string) => transcripts.has(conversationId)
          ? { conversationId, engine: "codex" as const, path: transcripts.get(conversationId)!, project: "atlas" }
          : null,
        readTail: () => null,
      }),
      pathAllowed: () => true,
      voiceUtteranceContext: lookup,
    },
    pinnedTranscript,
  } as never);
}

/** What the agent gets: the card's own text, or the refusal code. */
async function agentRead(turnId: string, requestId: string, turnTrigger: string | null = "realtime"): Promise<string> {
  try {
    const answered = await bindings().conversation_messages(
      { clientRequestId: requestId },
      { nativeWork: work(turnId, turnTrigger) },
    ) as { records: Array<{ text: string }> };
    return answered.records[0]?.text ?? "(no records)";
  } catch (error) {
    if (error instanceof McpToolRefusal) return String(error.details.code);
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const actions = () => published.map((entry) => String(entry.action));

/* ------------------------------------------------------------------ *
 * The reviewer's own sequences, driven through the real client.
 * ------------------------------------------------------------------ */

test("A, B, late handoff A, C, late handoff B: no card is ever read for the wrong work", async () => {
  /* The exact P1 #1 reproduction. The old client dropped its ambiguous queue and
     then let B's late handoff claim utterance C, which produced C's transcript
     under B's handoff. The queue is no longer a thing that can be emptied into a
     guess: the uncertainty is published, and it stands. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await spoke(CARD_B, peer);
  await handedOff(peer, "a");
  await spoke(CARD_C, peer);
  await handedOff(peer, "b");

  /* The client told the Viewer it could not attribute the handoff, and reported
     no join at all. */
  expect(actions()).toContain("handoffAmbiguity");
  expect(actions()).not.toContain("handoff");

  /* And every way the agent could ask ends in a refusal that names the reason,
     never in card B's or card C's transcript. */
  for (const turn of ["turn-1", "turn-2", "turn-3"]) {
    expect(await agentRead(turn, `chain-ambiguous-${turn}`)).toBe("voice_selected_context_ambiguous");
  }
});

test("the same handoff repeated after a later utterance claims nothing", async () => {
  /* The duplicate arm, at the client. A is reported once; the operator speaks
     about B; native redelivers handoff A. The old client believed it and joined
     A's identities to B's card — the report is refused now, and the client says
     so as an ambiguity rather than carrying on. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await handedOff(peer, "a");
  expect(await agentRead("turn-a", "chain-dup-1")).toBe("voice_selected_context_unproven");

  await spoke(CARD_B, peer);
  await handedOff(peer, "a");

  expect(actions().filter((action) => action === "handoff")).toHaveLength(1);
  expect(actions()).toContain("handoffAmbiguity");
  /* And no turn gets a card out of any of it. */
  expect(await agentRead("turn-a", "chain-dup-2")).toBe("voice_selected_context_ambiguous");
  expect(await agentRead("turn-b", "chain-dup-3")).toBe("voice_selected_context_ambiguous");
});

test("neither A's turn nor B's is handed a card, at any point in the chain", async () => {
  /* END TO END, THROUGH THE REAL EFFECTFUL PATH: browser client, control hop,
     ledger and MCP resolver. The lookup once carried only the conversation, so
     A's second read returned B; then it carried the turn, so A's read returned A
     on evidence that could not carry it. Installed Codex reports no edge from an
     utterance to the work it became, so every read here is a typed refusal and
     none of them names a card. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await handedOff(peer, "a");
  expect(await agentRead("turn-a", "chain-ab-1")).toBe("voice_selected_context_unproven");

  await spoke(CARD_B, peer);
  await handedOff(peer, "b");
  expect(await agentRead("turn-b", "chain-ab-2")).toBe("voice_selected_context_unproven");
  expect(await agentRead("turn-a", "chain-ab-3")).toBe("voice_selected_context_unproven");
});

test("an unrelated text turn after the call reads no card", async () => {
  /* P2. The call is over, work that started in it may still be running, and a
     new typed request must not inherit what the operator was looking at. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await handedOff(peer, "a");
  expect(await agentRead("turn-a", "chain-text-1")).toBe("voice_selected_context_unproven");
  await codexRealtimeClient(CALLER).stop();
  await settle();

  /* A turn native did not start from the call carries no `turn_trigger`, so it
     is not the call's business at all and falls through to the ordinary
     "name your target" — a different answer from the spoken refusal, which is
     the distinction the agent acts on. */
  expect(await agentRead("turn-typed", "chain-text-2", null))
    .toContain("conversationId, transcriptPath or selectedContext is required");
  expect(await agentRead("turn-a", "chain-text-3")).toBe("voice_selected_context_unproven");
});

test("a hangup is not a clock: what the call recorded outlives the transport", async () => {
  /* The ten-minute window used to discard live work. Nothing here is a clock —
     the record survives the hangup and is retired only when the host is observed
     going idle after the handoff. The refusal is the same throughout, which is
     what says the record is still there rather than gone. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await handedOff(peer, "a");
  expect(await agentRead("turn-a", "chain-hangup-1")).toBe("voice_selected_context_unproven");
  await codexRealtimeClient(CALLER).stop();
  await settle();

  expect(await agentRead("turn-a", "chain-hangup-2")).toBe("voice_selected_context_unproven");
  noteVoiceWorkBoundary(CALLER, "turn-a");
  expect(await agentRead("turn-a", "chain-hangup-3")).toBe("voice_selected_context_unproven");
});

test("a spoken turn the agent answered out loud is retired, and the refusal stays specific", async () => {
  /* The first utterance produced work that called no tool. Once the host is idle
     again that work is over and its record goes, so the call is back to ONE
     outstanding utterance — which changes the sentence the agent is given and
     changes nothing about the answer. Retirement keeps the ledger honest; it was
     never what made a card actionable. */
  const peer = await liveCall();
  await spoke(CARD_A, peer);
  await handedOff(peer, "a");
  noteVoiceWorkBoundary(CALLER, "turn-a");
  noteVoiceWorkBoundary(CALLER, null);

  await spoke(CARD_B, peer);
  await handedOff(peer, "b");
  expect(await agentRead("turn-b", "chain-idle-1")).toBe("voice_selected_context_unproven");
});
