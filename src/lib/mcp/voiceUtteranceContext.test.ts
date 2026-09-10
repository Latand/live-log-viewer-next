import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";
import { noteVoiceWorkBoundary, resetVoiceViewBindings } from "@/lib/runtime/voiceViewBinding";
import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { viewerMcpBindings } from "./bindings";
import { McpToolRefusal } from "./server";
import type { VoiceUtteranceLookup } from "./selectedContextTarget";

/**
 * The spoken card reaches the work (#1629), across the seam that actually
 * separates them.
 *
 * A spoken turn carries no `ctx=` marker: the operator's audio goes straight to
 * the model, so an agent asked out loud to "read that one" has nothing to pass
 * to a tool. The card is recorded in the voice ledger instead — and that ledger
 * lives in the Viewer process while the tool runs in the MCP server, so a join
 * recorded and never read is a join that changes nothing.
 *
 * Both halves here are the production code. `executeRealtimeControl` builds the
 * ledger from real admissions and real handoff reports, the MCP binding is the
 * real `conversation_messages`, and the lookup between them is the production
 * translation of the production endpoint's answer. Only the HTTP hop is elided,
 * because a loopback socket would prove the same thing more slowly.
 *
 * The property under test is the one the reviewer named: a POST that succeeds
 * is not delivery. What is asserted is that the tool ANSWERS ABOUT THE CARD —
 * and, at every point where it cannot honestly do so, refuses with its own
 * reason instead of reaching for the card from the turn before.
 */

const CALLER = "conversation_voice_caller";
const SELECTED = "conversation_atlas_selected";
const OTHER = "conversation_atlas_other";
const DESK = { viewSessionId: "vs-desk-1", deviceId: "dev-desk" };
/**
 * READ FROM THE CLOCK, not written into the file.
 *
 * The control endpoint admits a reference against `Date.now()` and refuses one
 * older than the capture window, so a hardcoded capture instant makes this whole
 * file pass only within ten minutes of the moment it was written and fail
 * silently ever after — which is exactly what it did.
 */
const NOW = Date.now();

let sandbox = "";
let selectedTranscript = "";
let otherTranscript = "";

beforeEach(() => {
  resetVoiceViewBindings();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-utterance-mcp-"));
  selectedTranscript = path.join(sandbox, "selected.jsonl");
  otherTranscript = path.join(sandbox, "other.jsonl");
  fs.writeFileSync(selectedTranscript, `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-09-10T08:59:00.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the selected card speaks" }] },
  })}\n`);
  fs.writeFileSync(otherTranscript, `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-09-10T08:58:00.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the other card speaks" }] },
  })}\n`);
});

afterEach(() => {
  resetVoiceViewBindings();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A host with a live call, and nothing else this file needs from one. */
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
    /* #1629: what turns the caller's `_meta` claim into evidence, and what the
       ledger retires finished work on. `unknown` for everything, so nothing is
       retired unless a test says the host saw it end. */
    providerThreadId() { return THREAD; },
    voiceWorkTurnState() { return "unknown" as const; },
    hasActiveTurn() { return false; },
  };
}

const THREAD = "thread-native-1";

/** The native work identity a tool call arrives with, as the MCP transport
    reads it off `params._meta`. */
function work(turnId: string, turnTrigger: string | null = "realtime") {
  return { threadId: THREAD, turnId, turnTrigger, callId: `call-${turnId}`, itemId: `fc-${turnId}` };
}

const OPERATOR = { operator: true };
const PEER = { caller: { kind: "session" as const, realtimeSessionId: "live-1" }, operator: false };
/** The backing agent, identified by the capability the registry maps to it. */
const AGENT = { caller: { kind: "conversation" as const, conversationId: CALLER }, operator: false };

function reference(card: string, revision: number, at = NOW): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: `${card}.jsonl`, selectedPaths: [] },
    cards: [{ path: `${card}.jsonl`, conversationId: card, label: card }],
    identity: DESK,
    revision,
    now: at,
  });
}

const utterance = (sequence: number) => ({ id: `${sequence}`.padStart(32, "f"), sequence });

/**
 * The host running a backing turn and then going idle again.
 *
 * The production signal is the structured-host state listener; this is the same
 * call it makes. It is what retires a spoken turn whose work finished without
 * ever calling a Viewer tool — the ordinary "answer me out loud" turn.
 */
function workRanAndFinished(turnId: string) {
  noteVoiceWorkBoundary(CALLER, turnId);
  noteVoiceWorkBoundary(CALLER, null);
}

async function control(body: Record<string, unknown>, authority: Parameters<typeof executeRealtimeControl>[2]) {
  return executeRealtimeControl({ conversationId: CALLER, ...body }, () => voiceHost(), authority);
}

/** Open a call, publish an utterance's card, and report the handoff it became. */
async function spokenTurn(card: string, sequence: number, options: { handoff?: boolean } = {}) {
  await control({ action: "selectedContext", selectedContext: reference(card, sequence), utterance: utterance(sequence) }, PEER);
  if (options.handoff === false) return;
  await control({
    action: "handoff",
    utterance: utterance(sequence),
    handoff: { handoffId: `handoff-${sequence}`, itemId: `item-${sequence}`, userBidiTurnId: `bidi-${sequence}` },
  }, PEER);
}

/**
 * The production translation of the production endpoint's answer.
 *
 * Kept byte-for-byte in step with `productionVoiceUtteranceContext` in
 * `bindings.ts`: if the two ever disagree about what a state means, this file
 * stops describing the deployed reader and starts describing itself.
 */
function lookupThroughTheControlEndpoint(): (work: unknown) => Promise<VoiceUtteranceLookup> {
  return async (requestWork: unknown) => {
    const answer = await control({ action: "utteranceContext", work: requestWork }, AGENT);
    if (answer.status !== 200) {
      return { state: "unavailable", reason: String(answer.body.error ?? `status ${answer.status}`) };
    }
    return answer.body.utterance as VoiceUtteranceLookup;
  };
}

/**
 * The real bindings, called the way the MCP transport calls them.
 *
 * `nativeWork` is what the transport reads off `params._meta` and forwards as
 * call context (#1629); every tool here is invoked with one, because a caller
 * that cannot say which backing turn it is has no implicit card by design.
 */
function bindings(
  voiceUtteranceContext: (work: unknown) => Promise<VoiceUtteranceLookup>,
  nativeWork: ReturnType<typeof work> | null = work("turn-1"),
) {
  const records: Record<string, { path: string }> = {
    [SELECTED]: { path: selectedTranscript },
    [OTHER]: { path: otherTranscript },
  };
  const pinnedTranscript = (candidate: string) => {
    if (candidate !== selectedTranscript && candidate !== otherTranscript) return undefined;
    const descriptor = fs.openSync(candidate, "r");
    return { descriptor, stat: fs.fstatSync(descriptor), rootName: "codex-sessions", root: sandbox, sameIdentity: () => true };
  };
  const built = viewerMcpBindings(undefined, undefined, {
    selectedContext: {
      selectedConversation: () => ({
        resolve: (conversationId: string) => records[conversationId]
          ? { conversationId, engine: "codex" as const, path: records[conversationId]!.path, project: "atlas" }
          : null,
        readTail: (conversationId: string, bounds: { maxLines: number }) => {
          const candidate = records[conversationId]?.path;
          if (!candidate) return null;
          return {
            path: candidate,
            lines: fs.readFileSync(candidate, "utf8").split("\n").filter(Boolean).slice(-bounds.maxLines),
            bytes: fs.statSync(candidate).size,
            truncated: false,
          };
        },
      }),
      pathAllowed: () => true,
      voiceUtteranceContext,
    },
    pinnedTranscript,
  } as never);
  const context = { nativeWork };
  return {
    conversation_messages: (args: Record<string, unknown>) => built.conversation_messages(args, context),
    get_conversation: (args: Record<string, unknown>) => built.get_conversation(args, context),
  };
}

async function refusal(run: Promise<unknown>): Promise<McpToolRefusal> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolRefusal);
    return error as McpToolRefusal;
  }
  throw new Error("expected a typed refusal");
}

/* ------------------------------------------------------------------ *
 * The delivery itself.
 * ------------------------------------------------------------------ */

test("a tool asked for nothing reads the card the operator spoke about", async () => {
  /* The whole point, end to end: the operator selects a card, says "read that
     one", and the agent — which was handed no id, no path and no reference —
     comes back with THAT card's transcript. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  const answered = await bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-1",
  }) as { conversationId: string; records: Array<{ text: string }> };

  expect(answered.conversationId).toBe(SELECTED);
  expect(answered.records[0]!.text).toContain("the selected card speaks");
});

test("the answer names the handoff it was resolved through", async () => {
  /* Provenance, so the operator and a later reader can tell a spoken resolution
     from an argument the agent supplied itself. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  /* `tailLines` takes the keyed selected-card read (#844 §6), which is the shape
     a spoken "what does that one say" actually wants. */
  const answered = await bindings(lookupThroughTheControlEndpoint()).get_conversation({
    clientRequestId: "spoken-read-2",
    tailLines: 5,
  }) as { conversationId: string; selectedContext?: { conversationId?: string } };

  expect(answered.conversationId).toBe(SELECTED);
  expect(answered.selectedContext?.conversationId).toBe(SELECTED);
});

/* ------------------------------------------------------------------ *
 * Every way it must refuse rather than answer about the wrong card.
 * ------------------------------------------------------------------ */

test("speaking again withdraws the card from work that has not claimed one", async () => {
  /* THE FORBIDDEN FALLBACK. The operator pointed at one card, then spoke again
     about something else. Until that second utterance becomes work, an unclaimed
     join from before it cannot be shown to belong to any particular caller — the
     handoff report is asynchronous, so the newer turn may already be running.
     A caller with no binding of its own is refused rather than handed the
     earlier card. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);
  workRanAndFinished("turn-a");
  await spokenTurn(OTHER, 2, { handoff: false });

  const refused = await refusal(bindings(lookupThroughTheControlEndpoint(), work("turn-fresh")).conversation_messages({
    clientRequestId: "spoken-read-3",
  }));
  expect(refused.details.code).toBe("voice_selected_context_superseded");
  expect(refused.message).toContain("spoken again");

  /* And once that utterance IS handed off, the tool answers about the NEW card. */
  await control({
    action: "handoff",
    utterance: utterance(2),
    handoff: { handoffId: "handoff-2", itemId: "item-2", userBidiTurnId: "bidi-2" },
  }, PEER);
  const answered = await bindings(lookupThroughTheControlEndpoint(), work("turn-two")).conversation_messages({
    clientRequestId: "spoken-read-4",
  }) as { conversationId: string };
  expect(answered.conversationId).toBe(OTHER);
});

test("the work that already claimed a card keeps it while the operator speaks again", async () => {
  /* The other half of the same rule (#1629 P1 #2): an accepted binding is
     frozen. A's backing turn goes on reading A no matter what is said after it. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);
  const first = await bindings(lookupThroughTheControlEndpoint(), work("turn-a")).conversation_messages({
    clientRequestId: "spoken-read-frozen-1",
  }) as { conversationId: string };
  expect(first.conversationId).toBe(SELECTED);

  await spokenTurn(OTHER, 2);
  const second = await bindings(lookupThroughTheControlEndpoint(), work("turn-b")).conversation_messages({
    clientRequestId: "spoken-read-frozen-2",
  }) as { conversationId: string };
  expect(second.conversationId).toBe(OTHER);

  const again = await bindings(lookupThroughTheControlEndpoint(), work("turn-a")).conversation_messages({
    clientRequestId: "spoken-read-frozen-3",
  }) as { conversationId: string };
  expect(again.conversationId).toBe(SELECTED);
});

test("a turn native did not start from the call reads no card at all", async () => {
  /* The unrelated later text turn (#1629 P2). It carries no `turn_trigger`, so
     it has no claim on anything the call admitted — and it is not an error
     either: it simply has to name its target like any other caller. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);
  await control({ action: "stop" }, OPERATOR);

  await expect(bindings(lookupThroughTheControlEndpoint(), work("turn-text", null)).conversation_messages({
    clientRequestId: "spoken-read-text",
  })).rejects.toThrow("conversationId, transcriptPath or selectedContext is required");
});

test("a caller whose transport proves no backing turn is refused, not answered", async () => {
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  const refused = await refusal(bindings(lookupThroughTheControlEndpoint(), null).conversation_messages({
    clientRequestId: "spoken-read-unidentified",
  }));
  expect(refused.details.code).toBe("voice_selected_context_unidentified");
});

test("work naming another native thread is never given this call's card", async () => {
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  const refused = await refusal(bindings(lookupThroughTheControlEndpoint(), {
    ...work("turn-a"), threadId: "thread-somebody-else",
  }).conversation_messages({ clientRequestId: "spoken-read-foreign" }));
  expect(refused.details.code).toBe("voice_selected_context_unidentified");
});

test("A, B, then a late handoff for A: the tool must not return card B", async () => {
  /* The reviewer's repro, driven the way the browser actually drives it. The
     client reports a join only while one utterance is outstanding, so with A and
     B both published it reports nothing at all — and the reader refuses instead
     of handing the agent card B under handoff A's name.

     The earlier version of this case labelled the late report with A's identity
     by hand, which the ledger correctly refused; the production client would have
     labelled it B and been believed. This drives the client's own decision. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await control({ action: "selectedContext", selectedContext: reference(SELECTED, 1), utterance: utterance(1) }, PEER);
  await control({ action: "selectedContext", selectedContext: reference(OTHER, 2), utterance: utterance(2) }, PEER);

  /* What the client sends after seeing A's handoff with two outstanding: nothing. */
  const refused = await refusal(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-ambiguous",
  }));
  expect(refused.details.code).toBe("voice_selected_context_superseded");

  /* And had it reported anyway, naming the newer utterance as the older one's
     work, the ledger would still refuse to complete the wrong admission. */
  const mislabelled = await control({
    action: "handoff",
    utterance: utterance(1),
    handoff: { handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" },
  }, PEER);
  expect(mislabelled.status).toBe(409);
  const stillRefused = await refusal(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-ambiguous-2",
  }));
  expect(stillRefused.details.code).toBe("voice_selected_context_superseded");
});

test("a handoff report whose identity halves disagree completes nothing", async () => {
  /* Both halves are checked because they answer different questions: the id says
     which publication the report belongs to, the sequence says where it sits in
     the call. A report that mixes one turn's id with another's position
     describes a boundary this ledger never saw. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await control({ action: "selectedContext", selectedContext: reference(SELECTED, 1), utterance: utterance(1) }, PEER);

  const crossed = await control({
    action: "handoff",
    utterance: { id: utterance(1).id, sequence: 2 },
    handoff: { handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" },
  }, PEER);
  expect(crossed.status).toBe(409);

  const refused = await refusal(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-crossed",
  }));
  expect(refused.details.code).toBe("voice_selected_context_superseded");
});

test("a late handoff for a superseded utterance never delivers its card", async () => {
  /* Out of order on the wire: the first utterance's handoff arrives after the
     second utterance has already been published. It must not resurrect the
     first card, and it must not silently complete the second. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1, { handoff: false });
  await control({ action: "selectedContext", selectedContext: reference(OTHER, 2), utterance: utterance(2) }, PEER);
  const late = await control({
    action: "handoff",
    utterance: utterance(1),
    handoff: { handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" },
  }, PEER);

  expect(late.status).toBe(409);
  const refused = await refusal(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-5",
  }));
  expect(refused.details.code).toBe("voice_selected_context_superseded");
});

test("a reordered publication cannot become the card a tool reads", async () => {
  /* The reproduced ordering defect, followed all the way to the tool: the older
     reference is refused by the ledger, so the work still resolves to the newer
     card rather than the one that arrived last. */
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 2);
  const stale = await control(
    { action: "selectedContext", selectedContext: reference(OTHER, 1), utterance: utterance(1) },
    PEER,
  );
  expect(stale.status).toBe(409);

  const answered = await bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-6",
  }) as { conversationId: string };
  expect(answered.conversationId).toBe(SELECTED);
});

test("a call that has reported no card refuses instead of guessing", async () => {
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);

  const refused = await refusal(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-7",
  }));
  expect(refused.details.code).toBe("voice_selected_context_absent");
});

test("a Viewer that cannot be read says so, rather than reporting an empty selection", async () => {
  /* Reporting a failed read as "nothing selected" is how an agent tells the
     operator they pointed at nothing when the truth is that nobody could look. */
  const refused = await refusal(bindings(async () => ({
    state: "unavailable", reason: "connection failed",
  })).conversation_messages({ clientRequestId: "spoken-read-8" }));
  expect(refused.details.code).toBe("voice_selected_context_unavailable");
  expect(refused.message).toContain("connection failed");
});

test("an agent not on a call is unaffected, and still has to name its target", async () => {
  /* The regression guard for every ordinary caller: no call, no new behaviour,
     and the same error it has always had. */
  await expect(bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-9",
  })).rejects.toThrow("conversationId, transcriptPath or selectedContext is required");
});

test("naming a target explicitly is never overridden by the call", async () => {
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  const byId = await bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-10",
    conversationId: OTHER,
  }) as { conversationId: string };
  expect(byId.conversationId).toBe(OTHER);

  const byPath = await bindings(lookupThroughTheControlEndpoint()).conversation_messages({
    clientRequestId: "spoken-read-11",
    transcriptPath: otherTranscript,
  }) as { transcriptPath: string };
  expect(byPath.transcriptPath).toBe(otherTranscript);
});

/* ------------------------------------------------------------------ *
 * Who may read the ledger at all.
 * ------------------------------------------------------------------ */

test("only the call's own conversation may read what it points at", async () => {
  await control({ action: "start", sdp: "v=0\r\noffer\r\n", view: DESK }, OPERATOR);
  await spokenTurn(SELECTED, 1);

  for (const authority of [
    { caller: { kind: "conversation" as const, conversationId: "conversation_someone_else" }, operator: false },
    { caller: { kind: "anonymous" as const }, operator: false },
  ]) {
    const refused = await control({ action: "utteranceContext" }, authority);
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("Only that call's conversation");
  }
});

test("a conversation with no call answers no-call rather than failing", async () => {
  const answered = await control({ action: "utteranceContext" }, AGENT);
  expect(answered.status).toBe(200);
  expect(answered.body.utterance).toEqual({ state: "no-call" });
});
