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
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  /** The handoff that turns the utterance just finished into work on the thread.
      Its identities are the canonical join between what was said and what the
      backing model was asked to do (#1629). */
  | { kind: "handoff"; handoffId: string | null; itemId: string | null; userBidiTurnId: string | null }
  | { kind: "usage"; status: string }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

const MAX_LINE_CHARS = 12_000;
const MAX_LINES = 80;

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

function eventRole(event: Record<string, unknown>, fallback: "user" | "assistant"): "user" | "assistant" {
  const role = stringAt(event, "role")
    ?? stringAt(event.turn, "role")
    ?? stringAt(event.item, "role");
  return role === "user" || role === "input" ? "user" : role === "assistant" || role === "output" ? "assistant" : fallback;
}

export function parseCodexRealtimeEvent(value: unknown): ParsedRealtimeEvent {
  const event = object(value);
  if (!event) return { kind: "ignored" };
  const type = stringAt(event, "type") ?? stringAt(event, "method") ?? "";
  if (type === "input_transcript.added") {
    const text = eventText(event);
    return text ? { kind: "transcript", role: "user", text, final: false } : { kind: "ignored" };
  }
  if (type === "output_transcript.added") {
    const text = eventText(event);
    return text ? { kind: "transcript", role: "assistant", text, final: false } : { kind: "ignored" };
  }
  if (type === "turn.done") {
    const text = eventText(event);
    return text
      ? { kind: "transcript", role: eventRole(event, "assistant"), text, final: true }
      : { kind: "ignored" };
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
  /** The line each speaker is still streaming into, by line id. Held here
      rather than read off the end of the list because a delegating turn
      interleaves both speakers with worker progress, so "the last line" is
      almost never the line an update belongs to. */
  private readonly openTranscriptLines = new Map<TranscriptSpeaker, string>();
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
  /* Which panel line each canonical transcript segment owns, so a segment that
     is republished updates its own line instead of stacking a second copy. */
  private readonly canonicalLines = new Map<string, string>();
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
    this.writeLine(`progress:${turnId}`, "progress", text, !running, "replace");
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
      this.writeTranscript(event.role, event.text, event.final);
      /* THE UTTERANCE BOUNDARY (#844 §2). The operator's speech never passes
         through our server — it rides the WebRTC leg straight to the model — so
         this is the one moment in the whole system where a spoken turn can be
         paired with the card the operator had selected. Read here, at the
         instant the transcript goes final, for the same reason the composer
         reads it inside its submit handler: everything the reference will say
         is decided by the state that existed when the operator finished
         speaking. */
      if (event.role === "user" && event.final) {
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
   * A canonical segment carries its WHOLE text each time, so:
   *
   * - a segment already merged updates the line it owns, in place. That is what
   *   makes a redelivered frame, a `done` completing its own deltas, and a
   *   replay after reconnect converge on one line instead of three.
   * - a segment arriving for the first time ADOPTS the most recent line of the
   *   same speaker whose text it continues — the data-channel line for the same
   *   words — and takes ownership of it. The canonical text wins, because it is
   *   the record the thread keeps.
   * - anything else is a line this panel never saw, and it is appended. That is
   *   the case a dropped data channel produces, and it is the reason for all of
   *   this.
   */
  reconcileCanonicalTranscript(segments: readonly RuntimeVoiceTranscriptSegment[] | null | undefined): void {
    for (const segment of segments ?? []) {
      if (!segment?.segmentId || typeof segment.text !== "string") continue;
      if (segment.role !== "user" && segment.role !== "assistant") continue;
      const owned = this.canonicalLines.get(segment.segmentId);
      const key = owned ?? this.adoptableLineFor(segment) ?? `canonical:${segment.segmentId}`;
      if (!owned) {
        this.canonicalLines.set(segment.segmentId, key);
        /* The canonical record owns this line now, so a later data-channel
           fragment for the same speaker opens a fresh one rather than appending
           to text the backend has already committed. */
        if (this.openTranscriptLines.get(segment.role) === key) this.openTranscriptLines.delete(segment.role);
      }
      this.writeLine(key, segment.role, segment.text, segment.final, "replace");
    }
  }

  /**
   * The line this segment is the committed form of, if the panel already has it.
   *
   * Matched by speaker and by prefix, newest first, and never a line another
   * segment already owns. Prefix rather than equality because the data channel
   * streams: when the canonical `done` lands, the line usually holds a leading
   * part of the same sentence.
   */
  private adoptableLineFor(segment: RuntimeVoiceTranscriptSegment): string | null {
    const owned = new Set(this.canonicalLines.values());
    for (let index = this.snapshot.lines.length - 1; index >= 0; index -= 1) {
      const line = this.snapshot.lines[index]!;
      if (line.role !== segment.role || owned.has(line.id)) continue;
      return line.text && segment.text.startsWith(line.text) ? line.id : null;
    }
    return null;
  }

  /**
   * Route a speaker's text to the line that speaker currently owns. Barge-in
   * puts the operator's turn after the agent's half-finished one, and worker
   * progress lands between the two, so position says nothing about ownership.
   * Whoever speaks closes the other's line: an interrupted turn that resumes
   * opens a fresh line instead of growing the one it abandoned.
   */
  private writeTranscript(role: TranscriptSpeaker, text: string, final: boolean): void {
    this.openTranscriptLines.delete(role === "user" ? "assistant" : "user");
    const key = this.openTranscriptLines.get(role) ?? `${role}:${++this.lineSequence}`;
    if (final) this.openTranscriptLines.delete(role);
    else this.openTranscriptLines.set(role, key);
    /* A final event carries the complete turn, a streamed one only the new
       fragment — except on backends that resend the whole text, which the
       prefix check below absorbs. */
    this.writeLine(key, role, text, final, final ? "replace" : "append");
  }

  private writeLine(
    key: string,
    role: CodexRealtimeRole,
    text: string,
    final: boolean,
    mode: "replace" | "append",
  ): void {
    const lines = [...this.snapshot.lines];
    const index = lines.findIndex((line) => line.id === key);
    if (index < 0) {
      lines.push({ id: key, role, text: text.slice(-MAX_LINE_CHARS), final });
    } else {
      const previous = lines[index]!;
      const combined = mode === "replace" || text.startsWith(previous.text)
        ? text
        : `${previous.text}${text}`;
      lines[index] = { ...previous, text: combined.slice(-MAX_LINE_CHARS), final };
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
    /* No line survives a dead transport as "still streaming": the next call
       opens its own rather than appending to a turn nobody can finish. */
    this.openTranscriptLines.clear();
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
    this.canonicalLines.clear();
    this.openTranscriptLines.clear();
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
