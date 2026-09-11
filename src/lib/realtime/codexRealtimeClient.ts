"use client";

import {
  normalizeVoiceDeliveries,
  type RuntimeVoiceDelivery,
} from "@/lib/runtime/voiceDelivery";
import type { RuntimeVoiceTranscriptSegment } from "@/lib/runtime/contracts";
import type { VoiceBackingHost } from "@/hooks/useCodexRealtime";


import { viewBus } from "@/hooks/viewPresenceBus";
import { viewerSelectedContext } from "@/lib/selection/viewerSelectedContext";

import { reportCallPhase } from "./activeCall";

export type CodexRealtimePhase = "idle" | "connecting" | "live" | "stopping" | "error";
export type CodexRealtimeRole = "user" | "assistant" | "progress";
/** The two roles that stream a turn. Worker progress is excluded: its line is
    addressed by turn id, not by who is currently holding the floor. */
type TranscriptSpeaker = Exclude<CodexRealtimeRole, "progress">;

export interface CodexRealtimeLine {
  id: string;
  role: CodexRealtimeRole;
  text: string;
  final: boolean;
}

export interface CodexRealtimeSnapshot {
  phase: CodexRealtimePhase;
  lines: readonly CodexRealtimeLine[];
  error: string | null;
  /** Epoch ms the call went live, for the panel's call timer; null until then.
      Kept in the snapshot rather than derived in the view so a remounted
      composer resumes the same clock instead of restarting it. */
  startedAt: number | null;
  /** Microphone held open but not transmitting. */
  micMuted: boolean;
  /** Agent audio silenced locally; the call keeps running. */
  outputMuted: boolean;
  /**
   * Something the operator should know while the call keeps running (#1629).
   *
   * Deliberately not `error`, which puts the panel in its failed state and ends
   * the call in the reader's mind. An approaching usage limit is the case this
   * was added for: the backend says so before it cuts the call, and the operator
   * can only act on it while there is still a call to act in.
   */
  notice: string | null;
  /**
   * Why the agent behind this call cannot be reached, or null while it can
   * (#1629).
   *
   * SEPARATE FROM `error`, WHICH IS ABOUT THE TRANSPORT. The two failures look
   * identical to the operator and are not the same thing: the WebRTC leg runs to
   * the provider, so a backing host that was interrupted, replaced or killed
   * leaves the call sounding perfectly alive while nothing said into it can
   * reach any work. The panel used to show `live` throughout that, and a worker
   * response that failed to deliver was swallowed silently.
   */
  agentUnavailable: string | null;
}

export type ParsedRealtimeEvent =
  /** `chunkId` is the provider's id for one streamed fragment, and `turnId` the
      id a `turn.done` names its turn by. An empty `text` occurs only on a
      `turn.done` that names its speaker: it ends that speaker's turn with the
      words already streamed. */
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean; chunkId?: string; turnId?: string }
  /** The handoff that turns the utterance just finished into work on the thread.
      Its identities are the canonical join between what was said and what the
      backing model was asked to do (#1629). */
  | { kind: "handoff"; handoffId: string | null; itemId: string | null; userBidiTurnId: string | null }
  | { kind: "usage"; status: string }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

const MAX_LINE_CHARS = 12_000;
const MAX_LINES = 80;
/** Canonical segment ids one call remembers. Above the runtime store's own
    tail of 80, so every segment the store can still redeliver is recognised as
    already placed and updates the line it has. */
const MAX_CANONICAL_SEGMENTS = 160;
/** Turns per speaker and source still open to alignment. The canonical stream
    lags the data channel by a few turns at most; an older turn keeps the line
    it has. */
const MAX_OPEN_TURNS = 32;
/** Fragment ids one call remembers, so a fragment delivered again is known
    however long ago its turn ended. */
const MAX_SEEN_FRAGMENTS = 2_048;
/** Turn ids of the dones that closed a turn, remembered for the same reason. */
const MAX_SEEN_COMPLETIONS = 512;
/** Earlier calls whose late canonical segments must stay out of the current one. */
const MAX_RETIRED_SESSIONS = 8;

/** One speaker's turn as the data channel captioned it (#1658). */
interface CaptionTurn {
  role: TranscriptSpeaker;
  /** The streamed fragments, joined. */
  streamed: string;
  /** The first fragment with words: the provider fragment native opens its
      segment for this turn with. */
  opening: string;
  /** The words of the `turn.done` that closed the turn: the provider's final
      transcript. Null while the turn is open, and when that done had none. */
  finalText: string | null;
  closed: boolean;
  /** The panel line it is on, once drawn. */
  line: string | null;
}

/** One speaker's turn as native committed it: one canonical segment. */
interface CanonicalTurn {
  role: TranscriptSpeaker;
  /** The whole segment so far, as the store carries it. */
  text: string;
  final: boolean;
  /** What the segment said before a repair rewrote it, when this client saw
      it: the words its fragments accumulated, which is what the caption of
      the same turn streamed. Null until a text arrives that does not continue
      the one before. */
  unrepaired: { text: string; final: boolean } | null;
  line: string | null;
  /** The caption turn it was last aligned with. */
  caption: CaptionTurn | null;
}

/** One panel line: a turn from either source, or from both. */
interface TurnView {
  role: TranscriptSpeaker;
  caption: CaptionTurn | null;
  canonical: CanonicalTurn | null;
  /** How strongly the two were shown to be one turn; 0 for a single source. */
  agreement: number;
}

/** One call's transcript. */
interface TranscriptLedger {
  /** The realtime session whose canonical segments belong on these lines. */
  sessionId: string | null;
  /** The turn each speaker's caption is streaming into. One per speaker, not
      one overall: in a duplex call both speak at once, and closing one
      speaker's line whenever the other spoke split every overlapping sentence
      into fragments. */
  streaming: Map<TranscriptSpeaker, CaptionTurn>;
  /** Each speaker's turns still open to alignment, per source, in the order
      that source took them. Everything older has settled on its line. */
  open: Record<TranscriptSpeaker, { captions: CaptionTurn[]; canonicals: CanonicalTurn[] }>;
  /** Every canonical segment placed, by id, so a redelivery updates its own turn. */
  segments: Map<string, CanonicalTurn>;
  /** Fragment ids already applied. */
  fragments: Set<string>;
  /** Turn ids of the dones that already closed a turn. */
  completions: Set<string>;
}

function newTranscriptLedger(sessionId: string | null = null): TranscriptLedger {
  return {
    sessionId,
    streaming: new Map(),
    open: { user: { captions: [], canonicals: [] }, assistant: { captions: [], canonicals: [] } },
    segments: new Map(),
    fragments: new Set(),
    completions: new Set(),
  };
}

function boundedPush<T>(queue: T[], value: T, limit: number): void {
  queue.push(value);
  if (queue.length > limit) queue.splice(0, queue.length - limit);
}

/** Drop the oldest entry of an insertion-ordered collection once it is past `limit`. */
function forgetOldest<T>(entries: Set<T> | Map<T, unknown>, limit: number): void {
  if (entries.size <= limit) return;
  const oldest = entries.keys().next();
  if (!oldest.done) entries.delete(oldest.value);
}

function comparable(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `longer` says everything `shorter` does and possibly more. */
function continues(longer: string, shorter: string): boolean {
  return comparable(longer).startsWith(comparable(shorter));
}

/* How strongly a caption turn and a canonical segment are shown to be one turn. */
const DIFFERENT_TURNS = 0;
/** Only one end of their words agrees: the first words, or every word after
    the first. That is all a final segment whose repair rewrote the other end
    shares with a caption that has no final text of its own. */
const SAME_EDGE = 1;
/** Their words agree past the opening. */
const SAME_WORDS = 2;

/** The words of a text, as a repair can leave them: case and punctuation are
    the provider's to change. */
function words(text: string): string[] {
  return comparable(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(" ").filter(Boolean);
}

/**
 * Whether a caption turn and a canonical segment are the same spoken turn.
 *
 * They share no identifier, but they carry the same provider evidence: native
 * builds its segment from the same fragments the data channel delivers, in the
 * same order, and its mirrored `transcript/done` carries the same final text as
 * the channel's `turn.done`. So a segment still streaming must be the same
 * fragments as the caption, one a little ahead of the other; a final one is what
 * those fragments accumulated or, once repaired, the provider's final text. A
 * pair that fits none of that is two turns, whatever order they arrived in.
 *
 * A repair replaces the segment's text, so the text it replaced is kept and
 * weighed too: it is the fragments themselves, and the evidence the caption of
 * the same turn still carries.
 */
function sameTurn(caption: CaptionTurn, canonical: CanonicalTurn): number {
  const now = agreement(caption, canonical.text, canonical.final);
  return canonical.unrepaired
    ? Math.max(now, agreement(caption, canonical.unrepaired.text, canonical.unrepaired.final))
    : now;
}

function agreement(caption: CaptionTurn, text: string, final: boolean): number {
  const committed = comparable(text);
  const opening = comparable(caption.opening);
  const finalText = caption.finalText === null ? null : comparable(caption.finalText);
  /* A turn that streamed nothing is only its final text. */
  const streamed = comparable(caption.streamed) || finalText || "";
  if (!committed) return DIFFERENT_TURNS;
  if (!committed.startsWith(opening) && !opening.startsWith(committed)) {
    /* A different start. The provider's final text can still show one turn,
       because a repair may rewrite how the turn began. */
    if (!final) return DIFFERENT_TURNS;
    if (finalText !== null) return finalText === committed ? SAME_WORDS : DIFFERENT_TURNS;
    /* A caption whose done had no words has only its fragments, and a repair
       of the opening word keeps every word after it. */
    const said = words(streamed);
    const kept = words(committed);
    return caption.closed && said.length > 1 && said.length === kept.length
      && said.every((word, index) => index === 0 || word === kept[index])
      ? SAME_EDGE
      : DIFFERENT_TURNS;
  }
  if (!final) {
    /* A closed caption already holds every fragment the segment can reach. */
    return streamed.startsWith(committed) || (!caption.closed && committed.startsWith(streamed))
      ? SAME_WORDS
      : DIFFERENT_TURNS;
  }
  if (committed === streamed || committed === finalText || (!caption.closed && committed.startsWith(streamed))) {
    return SAME_WORDS;
  }
  /* A caption with a final text of its own that still disagrees is another
     turn; one without it can be checked no further than its opening. */
  return finalText === null ? SAME_EDGE : DIFFERENT_TURNS;
}

/**
 * Pair one speaker's caption turns with native's segments (#1658).
 *
 * Both sources take a speaker's turns in the same order, since native opens a
 * segment on the speaker's first fragment and closes it on that speaker's
 * `turn.done`, the same provider events the data channel carries. Either can
 * miss a turn, though: a data channel that opened late, a segment with no
 * words, a host that restarted. Pairing the k-th with the k-th then shifts every
 * later turn onto its neighbour's line. So this is the in-order alignment of
 * the two sequences with the most agreement by `sameTurn`: a turn one source
 * missed is left on a line of its own, the turns around it still pair, and the
 * same words said twice stay two turns because each turn pairs once. On a tie
 * the earlier pairing wins.
 */
function align(role: TranscriptSpeaker, captions: readonly CaptionTurn[], canonicals: readonly CanonicalTurn[]): TurnView[] {
  const agreement = captions.map((caption) => canonicals.map((canonical) => sameTurn(caption, canonical)));
  /* best[i][j]: the most agreement captions from i and segments from j can reach. */
  const best = Array.from({ length: captions.length + 1 }, () => new Array<number>(canonicals.length + 1).fill(0));
  for (let i = captions.length - 1; i >= 0; i -= 1) {
    for (let j = canonicals.length - 1; j >= 0; j -= 1) {
      const paired = agreement[i]![j]! ? agreement[i]![j]! + best[i + 1]![j + 1]! : 0;
      best[i]![j] = Math.max(paired, best[i + 1]![j]!, best[i]![j + 1]!);
    }
  }
  const views: TurnView[] = [];
  let i = 0;
  let j = 0;
  while (i < captions.length || j < canonicals.length) {
    const here = i < captions.length && j < canonicals.length ? agreement[i]![j]! : 0;
    if (here && here + best[i + 1]![j + 1]! === best[i]![j]) {
      views.push({ role, caption: captions[i++]!, canonical: canonicals[j++]!, agreement: here });
    } else if (j < canonicals.length && (i === captions.length || best[i]![j + 1] === best[i]![j])) {
      views.push({ role, caption: null, canonical: canonicals[j++]!, agreement: 0 });
    } else {
      views.push({ role, caption: captions[i++]!, canonical: null, agreement: 0 });
    }
  }
  return views;
}

/**
 * The words one line shows.
 *
 * The caption leads while both stream, because it is the low-latency one, and
 * the caption's final text leads a segment still streaming. A final segment
 * wins: it is committed, and its mirrored `done` has repaired any fragment the
 * provider never streamed. The one exception is the moment between native's
 * completion and that repair, recognisable because the segment still says
 * exactly what the fragments said; the caption's final text is already right,
 * and the line does not flicker back.
 */
function viewText({ caption, canonical }: TurnView): string {
  const captioned = caption ? caption.finalText ?? caption.streamed : "";
  if (!canonical) return captioned;
  if (!caption || !captioned) return canonical.text;
  if (canonical.final) {
    return caption.finalText !== null && comparable(canonical.text) === comparable(caption.streamed)
      ? caption.finalText
      : canonical.text;
  }
  if (caption.finalText !== null) return caption.finalText;
  return continues(canonical.text, captioned) ? canonical.text : captioned;
}

function newOperatorActivityId(): string {
  return randomHex(32);
}

/**
 * The backend's usage-limit state, in words the operator can act on.
 *
 * Only `approaching` is spoken about: it is the one state where saying something
 * changes what the operator does. Any other status the backend adds later is
 * passed through rather than swallowed, because a warning nobody has taught this
 * function about is still a warning.
 */
function usageNotice(status: string): string | null {
  if (status === "approaching") {
    return "This account is approaching its usage limit; the call may be cut short.";
  }
  return status === "ok" || status === "none" ? null : `Usage limit status: ${status}.`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringAt(value: unknown, key: string): string | null {
  const item = object(value);
  return item && typeof item[key] === "string" ? item[key] as string : null;
}

function eventText(event: Record<string, unknown>): string {
  const turn = object(event.turn);
  const item = object(event.item);
  const content = Array.isArray(event.content) ? event.content : Array.isArray(item?.content) ? item.content : [];
  const contentText = content
    .map((part) => typeof part === "string" ? part : stringAt(part, "text") ?? stringAt(part, "transcript") ?? "")
    .join("");
  return (
    stringAt(event, "transcript")
    ?? stringAt(event, "text")
    ?? stringAt(event, "delta")
    ?? stringAt(turn, "transcript")
    ?? stringAt(turn, "text")
    ?? stringAt(item, "transcript")
    ?? stringAt(item, "text")
    ?? contentText
  ).slice(0, MAX_LINE_CHARS);
}

function namedRole(event: Record<string, unknown>): "user" | "assistant" | null {
  const role = stringAt(event, "role")
    ?? stringAt(event.turn, "role")
    ?? stringAt(event.item, "role");
  return role === "user" || role === "input" ? "user" : role === "assistant" || role === "output" ? "assistant" : null;
}

function transcriptChunk(event: Record<string, unknown>, role: "user" | "assistant"): ParsedRealtimeEvent {
  const text = eventText(event);
  if (!text) return { kind: "ignored" };
  /* Native's streamed fragments each carry their own id, so a fragment the
     channel delivers twice can be recognised as the same one. */
  const chunkId = stringAt(event.item, "id");
  return chunkId
    ? { kind: "transcript", role, text, final: false, chunkId }
    : { kind: "transcript", role, text, final: false };
}

export function parseCodexRealtimeEvent(value: unknown): ParsedRealtimeEvent {
  const event = object(value);
  if (!event) return { kind: "ignored" };
  const type = stringAt(event, "type") ?? stringAt(event, "method") ?? "";
  if (type === "input_transcript.added") return transcriptChunk(event, "user");
  if (type === "output_transcript.added") return transcriptChunk(event, "assistant");
  if (type === "turn.done") {
    const text = eventText(event);
    const role = namedRole(event);
    /* A done with no words still ends its speaker's turn — native closes that
       speaker's canonical segment on it (#1658), and a caption left open would
       swallow the next turn into this one. Without words it is only a boundary
       when it says whose. */
    if (!text && !role) return { kind: "ignored" };
    const parsed: ParsedRealtimeEvent = { kind: "transcript", role: role ?? "assistant", text, final: true };
    const turnId = stringAt(event.turn, "id");
    return turnId ? { ...parsed, turnId } : parsed;
  }
  if (type === "delegation.created" || type === "conversation.handoff.requested") {
    /* Both events name the same handoff; `delegation.created` nests the
       identities under the item it created and the request carries them flat. */
    const item = object(event.item) ?? object(event.delegation);
    const handoffId = stringAt(event, "handoff_id") ?? stringAt(item, "handoff_id");
    const itemId = stringAt(event, "item_id") ?? stringAt(item, "id") ?? stringAt(event, "delegation_item_id");
    const userBidiTurnId = stringAt(event, "user_bidi_turn_id") ?? stringAt(item, "user_bidi_turn_id");
    return handoffId || itemId || userBidiTurnId
      ? { kind: "handoff", handoffId, itemId, userBidiTurnId }
      : { kind: "ignored" };
  }
  if (type === "session.usage.updated") {
    /* A limit warning is not a failure: the call keeps running, and saying so
       out of band is the difference between the operator finishing a thought
       and the call ending mid-sentence with a generic transport message. The
       9-second cutoff in `docs/realtime-v3/BLOCKED.md` is what this exists for. */
    const status = stringAt(event.usage_limit, "status") ?? stringAt(event, "status");
    return status ? { kind: "usage", status } : { kind: "ignored" };
  }
  if (type === "error") {
    const message = (
      stringAt(event, "message")
      ?? stringAt(event.error, "message")
      ?? "Realtime conversation failed"
    ).slice(0, 500);
    return { kind: "error", message };
  }
  return { kind: "ignored" };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Realtime request failed (${response.status})`);
  return body;
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, 5_000);
    function done() {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

class CodexRealtimeClient {
  private snapshot: CodexRealtimeSnapshot = {
    phase: "idle", lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false, notice: null,
    agentUnavailable: null,
  };
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private readonly pendingWorkerDeliveries = new Map<string, RuntimeVoiceDelivery>();
  private readonly acknowledgedWorkerDeliveries = new Set<string>();
  /* Announced only when the HOST has confirmed the write, never on enqueue. The
     bridge's cursor rides on this signal, so a listener firing early would move a
     durable cursor past a report the session never actually received. */
  private readonly deliveryAcknowledgedListeners = new Set<(deliveryId: string) => void>();
  /* #691 §6: the credential this peer holds for its own call. Presented on every
     write into the session, because absence of evidence authorizes nothing. */
  private realtimeSessionId: string | null = null;
  private workerDeliveryFlush: Promise<void> | null = null;
  private workerDeliveryWakeEpoch: number | null = null;
  private unloadHangup: (() => void) | null = null;
  private lineSequence = 0;
  /** The current call's utterances, held here because a delegating turn
      interleaves both speakers with worker progress, so "the last line" is
      almost never the line an update belongs to. Kept through the hangup and
      replaced when the next call starts: a canonical segment the backend
      commits just after the hangup still belongs on this call's lines. */
  private transcript: TranscriptLedger = newTranscriptLedger();
  private readonly retiredTranscriptSessions: string[] = [];
  /* #1629: the utterance boundary this peer is currently publishing for. The
     server cannot mint it — the operator's audio never reaches it — and without
     one a retried publication counts as a second utterance and a slow one
     overwrites a newer one. Reset with the call, like every other per-call
     ledger here. */
  private utteranceSequence = 0;
  private utteranceId: string | null = null;
  /* Utterances published and not yet accounted for by a handoff. A join is
     reported only while this holds exactly one of them, because that is the only
     arrangement in which the association is a fact rather than a guess. */
  private utterancesAwaitingHandoff: { id: string; sequence: number }[] = [];
  /* Canonical handoff identities this call has already seen. Native repeats a
     handoff across its two event shapes and can redeliver one late, and a repeat
     that claimed a fresh utterance is how card B answered a question asked about
     card A after the operator spoke again. */
  private readonly reportedHandoffKeys = new Set<string>();
  /* Set once this peer sees a handoff it cannot attribute, and never cleared
     within the call. Every unattributed utterance may still produce a handoff,
     so nothing arriving afterwards can be shown to be anyone's. */
  private handoffCorrelationLost = false;
  private epoch = 0;

  constructor(readonly conversationId: string) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CodexRealtimeSnapshot => this.snapshot;

  /**
   * Fires when the runtime host has durably accepted a delivery — the one moment
   * at which "this reached the session" is true. Consumers that advance a durable
   * cursor (the #691 bridge) must key on this and on nothing earlier.
   */
  onDeliveryAcknowledged = (listener: (deliveryId: string) => void): (() => void) => {
    this.deliveryAcknowledgedListeners.add(listener);
    return () => this.deliveryAcknowledgedListeners.delete(listener);
  };

  /** The live microphone stream, for the panel's level meter. Deliberately
      outside the snapshot: the meter animates per frame and must not push
      React re-renders through the composer. */
  micStream = (): MediaStream | null => this.media;

  /** Muting is a track-level gate, never a teardown: the peer connection and
      the backend session stay up, so unmuting resumes the same call instead of
      paying for a fresh admission. */
  toggleMic = (): void => {
    const micMuted = !this.snapshot.micMuted;
    for (const track of this.media?.getAudioTracks() ?? []) track.enabled = !micMuted;
    this.update({ micMuted });
  };

  /** Local playback only — the agent keeps talking, the operator stops hearing
      it. Useful when the room has someone else in it. */
  toggleOutput = (): void => {
    const outputMuted = !this.snapshot.outputMuted;
    if (this.audio) this.audio.muted = outputMuted;
    this.update({ outputMuted });
  };

  async start(): Promise<void> {
    if (this.snapshot.phase === "connecting" || this.snapshot.phase === "live") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      this.setError("Realtime audio is unavailable in this browser");
      return;
    }
    this.cleanupTransport();
    /* A new call is a new turn order. The last call's lines stay on screen,
       but nothing of this call may be attached to them, and that call's own
       late segments are kept out of this one. */
    if (this.transcript.sessionId) {
      boundedPush(this.retiredTranscriptSessions, this.transcript.sessionId, MAX_RETIRED_SESSIONS);
    }
    this.transcript = newTranscriptLedger();
    /* `notice` is cleared with `error` for the same reason: it describes the
       call that is starting, and a warning carried over from the previous one
       would tell the operator about a limit this call has not reported. */
    this.update({
      phase: "connecting", error: null, notice: null, agentUnavailable: null, startedAt: null, micMuted: false, outputMuted: false,
    });
    const epoch = ++this.epoch;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const peer = new RTCPeerConnection();
      const events = peer.createDataChannel("oai-events");
      const audio = new Audio();
      audio.autoplay = true;
      audio.hidden = true;
      document.body.append(audio);

      this.media = media;
      this.peer = peer;
      this.events = events;
      this.audio = audio;
      for (const track of media.getAudioTracks()) peer.addTrack(track, media);
      peer.ontrack = ({ streams }) => {
        if (epoch !== this.epoch) return;
        if (streams[0]) audio.srcObject = streams[0];
        void audio.play().catch(() => undefined);
      };
      events.onmessage = (message) => {
        if (epoch === this.epoch) this.acceptWireMessage(message.data);
      };
      events.onopen = () => {
        if (epoch === this.epoch) {
          this.update({ phase: "live", error: null, startedAt: Date.now() });
          this.flushWorkerDeliveries();
        }
      };
      /* Closing the tab must hang up too. A call the backend still believes is
         open holds the account's one concurrent slot, and the next call is
         refused with "You have reached your usage limit." — indistinguishable
         from an exhausted window. `keepalive` is what lets the request outlive
         the page; `pagehide` fires where `beforeunload` does not, notably on
         mobile Safari. */
      this.unloadHangup = () => {
        try {
          void fetch("/api/runtime/realtime", {
            method: "POST",
            /* The page is unloading; the session id in the body is what proves this
               peer owns the call it is hanging up. Nothing else is presented — a
               capability header here would name this browser an AGENT and get the
               operator's own hangup refused. */
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "stop",
              conversationId: this.conversationId,
              realtimeSessionId: this.realtimeSessionId,
            }),
            keepalive: true,
          });
        } catch { /* the page is going away regardless */ }
      };
      window.addEventListener("pagehide", this.unloadHangup);
      events.onclose = () => {
        /* A channel lost before it ever opened is a failed admission too: the
           call lands in the error state so the UI can offer a restart instead
           of sitting in "connecting" forever. */
        if (epoch === this.epoch
          && (this.snapshot.phase === "live" || this.snapshot.phase === "connecting")) {
          this.failWithServerReason("Realtime connection closed", epoch);
        }
      };
      peer.onconnectionstatechange = () => {
        if (epoch === this.epoch
          && (peer.connectionState === "failed" || peer.connectionState === "disconnected")) {
          this.failWithServerReason("Realtime connection was interrupted", epoch);
        }
      };

      await peer.setLocalDescription(await peer.createOffer());
      await waitForIceGathering(peer);
      if (epoch !== this.epoch) return;
      const offer = peer.localDescription?.sdp;
      if (!offer) throw new Error("The browser produced no WebRTC offer");
      const answer = await responseJson(await fetch("/api/runtime/realtime", {
        method: "POST",
        /* ONE CLICK STARTS THE CALL. This request presents nothing but its own
           same-origin shape, which is what the server reads as the operator; the one
           thing that would break it is presenting a conversation capability, because
           that is precisely how an agent names itself. */
        headers: { "content-type": "application/json" },
        /* #844 §4: the window this call belongs to. Sent once, at start, and
           never re-asserted — a call that could re-bind itself mid-session would
           be exactly the implicit device switch the typed refusals prevent. */
        body: JSON.stringify({
          action: "start",
          conversationId: this.conversationId,
          sdp: offer,
          ...(viewBus.getIdentity() ? { view: viewBus.getIdentity() } : {}),
        }),
      }));
      if (epoch !== this.epoch) return;
      if (typeof answer.sdp !== "string") throw new Error("Codex returned no WebRTC answer");
      /* The credential for this call, minted by the backend during the exchange this
         peer just ran. Held for the life of the session and presented on every write
         into it (#691 §6). */
      this.realtimeSessionId = typeof answer.realtimeSessionId === "string" ? answer.realtimeSessionId : null;
      /* The same id the host tags every canonical segment of this call with. */
      if (this.realtimeSessionId) this.transcript.sessionId = this.realtimeSessionId;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.cleanupTransport();
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<void> {
    if (this.snapshot.phase === "idle") return;
    this.epoch += 1;
    this.update({ phase: "stopping", error: null });
    let failure: string | null = null;
    try {
      await responseJson(await fetch("/api/runtime/realtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "stop",
          conversationId: this.conversationId,
          realtimeSessionId: this.realtimeSessionId,
        }),
      }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    /* Canonical pending deliveries intentionally survive an explicit hangup.
       A later Live Mode start retries the same stable id and the host resumes
       from its durable chunk cursor. */
    this.cleanupTransport();
    this.update({ phase: failure ? "error" : "idle", error: failure });
  }

  updateWorkerProgress(turnId: string, text: string, running: boolean): void {
    if (!turnId || !text || this.snapshot.phase !== "live") return;
    /* One line per turn, addressed by turn id. Every tick carries the whole
       accumulated answer rather than a delta, so a tick that cannot find its
       own line redraws the entire text as a new one — the operator sees the
       answer once per tick as a ladder of ever-longer prefixes. The turn id
       also survives the line being finalized when the turn ends, so a trailing
       tick reuses it instead of opening a second copy. */
    this.writeLine(`progress:${turnId}`, "progress", text, !running);
  }

  reconcileWorkerDeliveries(
    value: readonly RuntimeVoiceDelivery[] | null | undefined,
    options: { authoritative?: boolean } = {},
  ): void {
    const deliveries = normalizeVoiceDeliveries(value);
    if (options.authoritative) {
      const current = new Set(deliveries.map((delivery) => delivery.deliveryId));
      for (const [deliveryId, delivery] of this.pendingWorkerDeliveries) {
        if (delivery.sourceTurnId && !current.has(deliveryId)) {
          this.pendingWorkerDeliveries.delete(deliveryId);
        }
      }
    }
    for (const delivery of deliveries) {
      if (!delivery.ready || this.acknowledgedWorkerDeliveries.has(delivery.deliveryId)) continue;
      this.pendingWorkerDeliveries.set(delivery.deliveryId, delivery);
    }
    this.flushWorkerDeliveries();
  }

  private flushWorkerDeliveries(): void {
    if (this.snapshot.phase !== "live" || this.pendingWorkerDeliveries.size === 0) return;
    if (this.workerDeliveryFlush) {
      this.workerDeliveryWakeEpoch = this.epoch;
      return;
    }
    const task = this.deliverPendingWorkerResponses();
    this.workerDeliveryFlush = task;
    void task.finally(() => {
      if (this.workerDeliveryFlush !== task) return;
      this.workerDeliveryFlush = null;
      const wakeEpoch = this.workerDeliveryWakeEpoch;
      this.workerDeliveryWakeEpoch = null;
      if (wakeEpoch === this.epoch) this.flushWorkerDeliveries();
    });
  }

  private async deliverPendingWorkerResponses(): Promise<void> {
    while (this.snapshot.phase === "live") {
      const delivery = this.pendingWorkerDeliveries.values().next().value as RuntimeVoiceDelivery | undefined;
      if (!delivery) return;
      let body: Record<string, unknown>;
      try {
        body = await responseJson(await fetch("/api/runtime/realtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "deliverWorkerResponse",
            conversationId: this.conversationId,
            realtimeSessionId: this.realtimeSessionId,
            delivery,
          }),
        }));
      } catch (failure) {
        /* SAY SO. This is the request that carries work output INTO the call, so
           a failure here means the operator is listening to a call whose agent
           cannot be reached — and it used to return in silence, leaving the
           panel reading `live`. The delivery itself stays pending and is
           retried by the next reconcile; what changes is that the panel stops
           claiming a working link. */
        this.reportAgentUnavailable(failure instanceof Error ? failure.message : String(failure));
        return;
      }
      if (body.acknowledged !== true || body.deliveryId !== delivery.deliveryId) {
        this.reportAgentUnavailable("the runtime did not acknowledge the last answer sent into this call");
        return;
      }
      this.clearAgentUnavailable();
      this.pendingWorkerDeliveries.delete(delivery.deliveryId);
      this.acknowledgedWorkerDeliveries.add(delivery.deliveryId);
      for (const listener of this.deliveryAcknowledgedListeners) listener(delivery.deliveryId);
    }
  }

  /**
   * Report which handoff the last published utterance became (#1629).
   *
   * Fire-and-forget for the same reason the reference itself is: the audio is
   * already on its way, and a stutter in the conversation is a worse price than
   * a missing join. Carries the utterance id it is completing, so the server
   * attaches the canonical identities to that admission instead of counting a
   * second utterance.
   *
   * AND IT REPORTS NOTHING RATHER THAN GUESS. The handoff event and the
   * transcript boundary that published the reference share no identifier on the
   * wire — native's own parser uses `item.id` for both handoff ids and emits no
   * acceptance receipt naming the utterance
   * (`docs/design/native-voice-work-identity.md`) — so the association is a fact
   * in exactly one arrangement: one utterance outstanding, one handoff arriving
   * for the first time. That is the ordinary flow — speak, pause, the work
   * starts.
   *
   * Everything else is UNCERTAINTY, AND IT IS REPORTED AS SUCH. Two outstanding
   * utterances means a handoff could belong to either; a canonical identity this
   * call has already reported means a repeat, and repeats used to claim whatever
   * had been said since. Both tell the server that this call can no longer prove
   * a join, and the server's answer to an implicit card request becomes a typed
   * refusal for the rest of the call. Clearing the queue and carrying on — what
   * this did before — is how `A, B, late A, C, late B` ended with C's transcript
   * under B's handoff.
   */
  private publishHandoffJoin(event: { handoffId: string | null; itemId: string | null; userBidiTurnId: string | null }): void {
    const key = [event.handoffId ?? "", event.itemId ?? "", event.userBidiTurnId ?? ""].join(" ");
    if (this.reportedHandoffKeys.has(key)) {
      /* The same handoff twice. It already belongs to whatever it belonged to;
         what is unknown is whether the utterance since has one of its own. */
      this.reportAmbiguousHandoff("this call reported the same handoff twice, so a later spoken turn's own handoff cannot be told from a repeat");
      return;
    }
    this.reportedHandoffKeys.add(key);
    const outstanding = this.utterancesAwaitingHandoff;
    if (this.handoffCorrelationLost || outstanding.length !== 1) {
      this.utterancesAwaitingHandoff = [];
      this.reportAmbiguousHandoff(outstanding.length > 1
        ? "more than one spoken turn was outstanding when a handoff arrived"
        : "a handoff arrived with no spoken turn waiting for one");
      return;
    }
    const claimed = outstanding[0]!;
    this.utterancesAwaitingHandoff = [];
    if (!this.realtimeSessionId) return;
    const payload = JSON.stringify({
      action: "handoff",
      conversationId: this.conversationId,
      realtimeSessionId: this.realtimeSessionId,
      /* The CLAIMED utterance's own identity, carried on the queue entry rather
         than read off the latest publish, so the report cannot drift onto a
         newer turn if the two ever stop being the same one. */
      utterance: claimed,
      handoff: {
        handoffId: event.handoffId,
        itemId: event.itemId,
        userBidiTurnId: event.userBidiTurnId,
      },
    });
    void fetch("/api/runtime/realtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }).catch(() => undefined);
  }

  /**
   * Tell the server this call can no longer prove which utterance a handoff is.
   *
   * Sent once — the server holds the uncertainty for the rest of the generation,
   * so repeating it changes nothing — and fire-and-forget like every other
   * publication on this leg. A POST that never lands leaves the server's own
   * ledger to refuse on its own evidence; it cannot turn the uncertainty back
   * into a join, because nothing after this point reports one.
   */
  private reportAmbiguousHandoff(reason: string): void {
    if (this.handoffCorrelationLost) return;
    this.handoffCorrelationLost = true;
    if (!this.realtimeSessionId) return;
    void fetch("/api/runtime/realtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "handoffAmbiguity",
        conversationId: this.conversationId,
        realtimeSessionId: this.realtimeSessionId,
        reason,
      }),
    }).catch(() => undefined);
  }

  /**
   * What the runtime says about the host behind this call (#1629).
   *
   * Fed from the same session projection the composer already reads, so a host
   * that died, was replaced or was never adopted reaches the panel as a state
   * rather than as continued silence. `unknown` is not a failure — a projection
   * that has not arrived yet says nothing — and only `dead` and `unhosted`
   * contradict a live call.
   */
  reportBackingHost(host: VoiceBackingHost): void {
    if (host === "hosted") return this.clearAgentUnavailable();
    if (host === "unknown") return;
    this.reportAgentUnavailable(host === "dead"
      ? "the agent behind this call is no longer running, so nothing said here reaches it"
      : host === "recovering" || host === "registering"
        ? "the agent behind this call is being restored; what is said now may not reach it yet"
        : host === "conflict"
          ? "another host has claimed this conversation, so this call may no longer reach its agent"
          : "this conversation has no running agent behind the call right now");
  }

  private reportAgentUnavailable(reason: string): void {
    const message = reason.slice(0, 300);
    if (this.snapshot.agentUnavailable === message) return;
    this.update({ agentUnavailable: message });
  }

  private clearAgentUnavailable(): void {
    if (this.snapshot.agentUnavailable === null) return;
    this.update({ agentUnavailable: null });
  }

  private publishOperatorActivity(): void {
    if (!this.realtimeSessionId) return;
    const payload = JSON.stringify({
      action: "operatorActivity",
      conversationId: this.conversationId,
      realtimeSessionId: this.realtimeSessionId,
      operatorEventId: newOperatorActivityId(),
    });
    const publish = async (retriesRemaining: number): Promise<void> => {
      try {
        await responseJson(await fetch("/api/runtime/realtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }));
      } catch {
        if (retriesRemaining > 0) await publish(retriesRemaining - 1);
      }
    };
    void publish(1);
  }

  /**
   * Report what this call points at, for the delegated turn about to be minted.
   *
   * Fire-and-forget on purpose. A refused reference (another device, a reloaded
   * window, one too old) leaves the PREVIOUS admission standing rather than
   * blanking it, and the operator's speech is already on its way to the model
   * regardless — blocking the audio path on this POST would trade a missing
   * badge for a stutter in the conversation. The typed refusal is recorded by
   * the server and read from the ledger; nothing here retries it.
   */
  private publishSelectedContext(): void {
    if (!this.realtimeSessionId) return;
    /* Minted once per utterance and reused by the retry below, so the server
       recognizes a replay as the same spoken turn rather than a later one. */
    this.utteranceSequence += 1;
    this.utteranceId = randomHex(16);
    /* Once this call can no longer prove a join, the queue has no reader left,
       so it stops being filled rather than growing for the rest of the call. */
    if (!this.handoffCorrelationLost) {
      this.utterancesAwaitingHandoff.push({ id: this.utteranceId, sequence: this.utteranceSequence });
    }
    const payload = JSON.stringify({
      action: "selectedContext",
      conversationId: this.conversationId,
      realtimeSessionId: this.realtimeSessionId,
      selectedContext: viewerSelectedContext(),
      utterance: { id: this.utteranceId, sequence: this.utteranceSequence },
    });
    const publish = async (retry: boolean): Promise<void> => {
      try {
        const response = await fetch("/api/runtime/realtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (!response.ok && retry) await publish(false);
      } catch {
        if (retry) await publish(false);
      }
    };
    try {
      void publish(true);
    } catch {
      /* the call keeps going without a selected-card reference */
    }
  }

  private acceptWireMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const event = parseCodexRealtimeEvent(value);
    if (event.kind === "transcript") {
      this.writeCaption(event.role, event.text, event.final, event.chunkId, event.turnId);
      /* THE UTTERANCE BOUNDARY (#844 §2). The operator's speech never passes
         through our server — it rides the WebRTC leg straight to the model — so
         this is the one moment in the whole system where a spoken turn can be
         paired with the card the operator had selected. Read here, at the
         instant the transcript goes final, for the same reason the composer
         reads it inside its submit handler: everything the reference will say
         is decided by the state that existed when the operator finished
         speaking. A done with no words ends the caption but publishes nothing,
         exactly as when such a done was not read at all. */
      if (event.role === "user" && event.final && event.text) {
        this.publishOperatorActivity();
        this.publishSelectedContext();
      }
    } else if (event.kind === "handoff") {
      /* The utterance just published is the one being handed off, so this is
         where the reference the operator was looking at is joined to the work
         the backing model is about to do. */
      this.publishHandoffJoin(event);
    } else if (event.kind === "usage") {
      this.update({ notice: usageNotice(event.status) });
    } else if (event.kind === "error") {
      this.setError(event.message);
    }
  }

  /**
   * Merge the canonical transcript the app-server published (#1629).
   *
   * TWO SOURCES, ONE PANEL. The data channel is the immediate one and the
   * app-server's `thread/realtime/*` notifications are the committed one; the
   * Viewer used to carry only the first, so a call whose data channel dropped
   * showed nothing of what the backend had actually recorded. Both now reach
   * here, and the whole job is not showing the operator every sentence twice.
   *
   * A canonical segment carries its WHOLE text each time, and is one turn
   * (#1658):
   *
   * - a segment already placed updates its own turn, in place. That is what
   *   makes a redelivered frame, a `done` completing its own deltas, and the
   *   store handing over its whole tail again converge on one line.
   * - a segment seen for the first time is the speaker's next turn on the
   *   canonical stream, and `align` pairs it with the caption turn it is, in
   *   whichever order the two arrived.
   * - a segment no caption turn is has a line of its own. That is the case a
   *   dropped data channel produces, and it is the reason for all of this.
   *
   * A segment with no words yet takes no line and no place in the order: native
   * opens every segment empty, and an empty one used to claim a line before the
   * caption with its words could be joined.
   */
  reconcileCanonicalTranscript(segments: readonly RuntimeVoiceTranscriptSegment[] | null | undefined): void {
    const ledger = this.transcript;
    const realign = new Set<TranscriptSpeaker>();
    /* Turns already settled on their lines, whose segment changed again. */
    const resettled: TurnView[] = [];
    for (const segment of segments ?? []) {
      if (!segment?.segmentId || typeof segment.text !== "string") continue;
      if (segment.role !== "user" && segment.role !== "assistant") continue;
      const text = segment.text.slice(0, MAX_LINE_CHARS);
      const placed = ledger.segments.get(segment.segmentId);
      if (!placed) {
        if (!comparable(text) || !this.belongsToThisCall(segment.realtimeSessionId)) continue;
        const turn: CanonicalTurn = {
          role: segment.role, text, final: segment.final, unrepaired: null, line: null, caption: null,
        };
        ledger.segments.set(segment.segmentId, turn);
        forgetOldest(ledger.segments, MAX_CANONICAL_SEGMENTS);
        ledger.open[segment.role].canonicals.push(turn);
        realign.add(segment.role);
        continue;
      }
      /* A settled segment is not reopened by a late non-final frame of it. */
      if (!comparable(text) || (placed.final && !segment.final)) continue;
      if (placed.text === text && placed.final === segment.final) continue;
      /* A repair replaces the words; the ones it replaced still name the turn. */
      if (!placed.unrepaired && !continues(text, placed.text)) {
        placed.unrepaired = { text: placed.text, final: placed.final };
      }
      placed.text = text;
      placed.final = segment.final;
      if (ledger.open[placed.role].canonicals.includes(placed)) realign.add(placed.role);
      else resettled.push({ role: placed.role, caption: placed.caption, canonical: placed, agreement: 0 });
    }
    this.draw([...resettled, ...[...realign].flatMap((role) => this.realign(role))]);
  }

  /**
   * Whether a canonical segment from this realtime session belongs on the
   * current call's lines.
   *
   * The runtime store keeps the last calls' segments too, and a new call must
   * not attach them to its own turns. The call's own id comes from its answer;
   * an answer without one binds the first session that is not an earlier call's,
   * and nothing binds while the answer is still on its way.
   */
  private belongsToThisCall(sessionId: string): boolean {
    if (this.transcript.sessionId !== null) return sessionId === this.transcript.sessionId;
    if (this.snapshot.phase === "connecting" || this.retiredTranscriptSessions.includes(sessionId)) return false;
    this.transcript.sessionId = sessionId;
    return true;
  }

  /**
   * Route a caption fragment to the turn its speaker is taking.
   *
   * Each speaker streams into its own turn until that speaker's `turn.done`,
   * which is exactly where native closes the canonical segment. The other
   * speaker talking does not end it: in a duplex call the two overlap word by
   * word, and ending a turn there left every overlapping sentence in pieces
   * with the whole of it repeated underneath. Worker progress lands between
   * them too, so position says nothing about ownership.
   */
  private writeCaption(role: TranscriptSpeaker, text: string, final: boolean, chunkId?: string, turnId?: string): void {
    const ledger = this.transcript;
    /* The same fragment delivered twice is one fragment, however long ago its
       turn ended. */
    if (chunkId) {
      if (ledger.fragments.has(chunkId)) return;
      ledger.fragments.add(chunkId);
      forgetOldest(ledger.fragments, MAX_SEEN_FRAGMENTS);
    }
    /* So is a done: the one that closed a turn, delivered again, is known by
       the turn id it carries, and ends neither that turn a second time nor the
       one streaming now. That holds for a done that drew nothing, too, because
       every fragment of its turn was lost. */
    if (final && turnId) {
      if (ledger.completions.has(turnId)) return;
      ledger.completions.add(turnId);
      forgetOldest(ledger.completions, MAX_SEEN_COMPLETIONS);
    }
    let turn = ledger.streaming.get(role);
    if (!turn) {
      /* A done with no words and nothing streamed before it is no turn. */
      if (!text) return;
      turn = { role, streamed: "", opening: text, finalText: null, closed: false, line: null };
      ledger.open[role].captions.push(turn);
      if (!final) ledger.streaming.set(role, turn);
    }
    if (final) {
      /* A done carries the complete turn; an empty one keeps what streamed. */
      turn.finalText = text ? text.slice(0, MAX_LINE_CHARS) : null;
      turn.closed = true;
      ledger.streaming.delete(role);
    } else {
      /* A fragment with its own id is one delta, so a word said twice in a row
         is two of them. Only a fragment without one may be a backend resending
         the whole text so far, which the prefix check absorbs. */
      const whole = !chunkId && text.startsWith(turn.streamed);
      turn.streamed = (whole ? text : `${turn.streamed}${text}`).slice(-MAX_LINE_CHARS);
      if (!comparable(turn.opening)) turn.opening = text;
    }
    this.draw(this.realign(role));
  }

  /**
   * Align a speaker's open turns again, and settle the ones that are done.
   *
   * A pair whose words agree and whose two halves have both finished can no
   * longer change partner, so it and everything before it leave the open lists
   * and keep the lines they have. That keeps the alignment to the few turns
   * the two sources are apart, and the lists bounded however long the call.
   */
  private realign(role: TranscriptSpeaker): TurnView[] {
    const open = this.transcript.open[role];
    const views = align(role, open.captions, open.canonicals);
    let settled = 0;
    views.forEach((view, index) => {
      if (view.agreement === SAME_WORDS && view.caption!.closed && view.canonical!.final) settled = index + 1;
    });
    let captions = views.slice(settled).filter((view) => view.caption).length;
    let canonicals = views.slice(settled).filter((view) => view.canonical).length;
    while (captions > MAX_OPEN_TURNS || canonicals > MAX_OPEN_TURNS) {
      const oldest = views[settled++]!;
      if (oldest.caption) captions -= 1;
      if (oldest.canonical) canonicals -= 1;
    }
    for (const view of views) if (view.canonical) view.canonical.caption = view.caption;
    open.captions = views.slice(settled).flatMap((view) => view.caption ? [view.caption] : []);
    open.canonicals = views.slice(settled).flatMap((view) => view.canonical ? [view.canonical] : []);
    return views;
  }

  /**
   * Put these turns on the panel, in one update.
   *
   * A turn keeps the line it was first drawn on. When alignment joins two
   * turns that were each drawn alone, the earlier line takes both and the
   * other goes; when it separates two, the one drawn first keeps the line and
   * the other gets a new one. A new line goes just before the next turn of the
   * same speaker that has one, so a turn one source missed and the other
   * supplied late still reads in its place.
   */
  private draw(views: readonly TurnView[]): void {
    let lines: readonly CodexRealtimeLine[] = this.snapshot.lines;
    let copied: CodexRealtimeLine[] | null = null;
    const editable = (): CodexRealtimeLine[] => {
      copied ??= [...lines];
      lines = copied;
      return copied;
    };
    const indexOf = (id: string | null) => id === null ? -1 : lines.findIndex((line) => line.id === id);
    /* Lines a turn earlier in this pass has taken, or folded into another. */
    const taken = new Set<string>();
    views.forEach((view, position) => {
      const turns: (CaptionTurn | CanonicalTurn)[] = [];
      if (view.caption) turns.push(view.caption);
      if (view.canonical) turns.push(view.canonical);
      const held = [...new Set(turns.map((turn) => turn.line))]
        .filter((id): id is string => id !== null && !taken.has(id) && indexOf(id) >= 0)
        .sort((a, b) => indexOf(a) - indexOf(b));
      const text = viewText(view);
      const final = view.caption?.closed === true || view.canonical?.final === true;
      let lineId = held[0] ?? null;
      if (lineId === null) {
        /* A line that scrolled out of the bounded list is not brought back. */
        if (!text || turns.some((turn) => turn.line !== null && !taken.has(turn.line))) return;
        lineId = `${view.role}:${++this.lineSequence}`;
        const next = views.slice(position + 1)
          .filter((later) => later.role === view.role)
          .flatMap((later) => [indexOf(later.caption?.line ?? null), indexOf(later.canonical?.line ?? null)])
          .find((index) => index >= 0);
        editable().splice(next ?? lines.length, 0, { id: lineId, role: view.role, text, final });
      }
      for (const folded of held.slice(1)) {
        editable().splice(indexOf(folded), 1);
        taken.add(folded);
      }
      for (const turn of turns) turn.line = lineId;
      taken.add(lineId);
      const index = indexOf(lineId);
      const line = lines[index]!;
      if (text && (line.text !== text || line.final !== final)) editable()[index] = { ...line, text, final };
    });
    if (copied) this.update({ lines: lines.slice(-MAX_LINES) });
  }

  private writeLine(key: string, role: CodexRealtimeRole, text: string, final: boolean): void {
    const lines = [...this.snapshot.lines];
    const index = lines.findIndex((line) => line.id === key);
    if (index < 0) {
      lines.push({ id: key, role, text: text.slice(-MAX_LINE_CHARS), final });
    } else {
      lines[index] = { ...lines[index]!, text: text.slice(-MAX_LINE_CHARS), final };
    }
    this.update({ lines: lines.slice(-MAX_LINES) });
  }

  private setError(message: string): void {
    this.update({ phase: "error", error: message.slice(0, 500) });
  }

  /**
   * The transport dying describes the symptom; the cause sits on the server
   * (#664). Codex delivers `thread/realtime/error` on its own sideband channel
   * — a backend cutoff reads here as nothing but a dead peer connection — so
   * show the transport reason at once and upgrade it in place once the host
   * hands over what the backend actually said ("You have reached your usage
   * limit."). Best effort by construction: the transport reason stands if the
   * lookup fails, and a newer call (epoch bump) never inherits this message.
   */
  private failWithServerReason(fallback: string, epoch: number): void {
    this.setError(fallback);
    void (async () => {
      try {
        const body = await responseJson(await fetch("/api/runtime/realtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "status", conversationId: this.conversationId }),
        }));
        const message = stringAt(body.failure, "message")?.trim() ?? "";
        if (message && epoch === this.epoch && this.snapshot.phase === "error") this.setError(message);
      } catch {
        /* the transport reason already on screen stands */
      }
    })();
  }

  private update(patch: Partial<CodexRealtimeSnapshot>): void {
    const previousPhase = this.snapshot.phase;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
    /* Announced after this client's own subscribers, so the Viewer-level host
       never sees a phase the card has not rendered yet. */
    if (this.snapshot.phase !== previousPhase) reportCallPhase(this.conversationId, this.snapshot.phase);
  }

  /** The live session credential, for consumers that must write into this call
      through the host (the #691 bridge relay). Null when no call is up. */
  realtimeSession = (): string | null => this.realtimeSessionId;

  private cleanupTransport(): void {
    /* No turn survives a dead transport as "still streaming". Its canonical
       half can still arrive, so the turn order itself is kept until the next
       call replaces it. */
    this.transcript.streaming.clear();
    if (this.unloadHangup) window.removeEventListener("pagehide", this.unloadHangup);
    this.unloadHangup = null;
    this.events?.close();
    this.peer?.close();
    for (const track of this.media?.getTracks() ?? []) track.stop();
    this.audio?.remove();
    this.events = null;
    this.peer = null;
    this.media = null;
    this.audio = null;
    this.realtimeSessionId = null;
    /* A new call is a new utterance ledger. Carrying the counter across would
       let the first utterance of the next call be refused as superseded by the
       last one of this one. */
    this.utteranceSequence = 0;
    this.utteranceId = null;
    this.utterancesAwaitingHandoff = [];
    this.reportedHandoffKeys.clear();
    this.handoffCorrelationLost = false;
  }
}

const clients = new Map<string, CodexRealtimeClient>();

export function codexRealtimeClient(conversationId: string): CodexRealtimeClient {
  const existing = clients.get(conversationId);
  if (existing) return existing;
  const client = new CodexRealtimeClient(conversationId);
  clients.set(conversationId, client);
  return client;
}
