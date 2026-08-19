"use client";

import {
  normalizeVoiceDeliveries,
  type RuntimeVoiceDelivery,
} from "@/lib/runtime/voiceDelivery";


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
}

export type ParsedRealtimeEvent =
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { kind: "delegation"; id: string }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

const MAX_LINE_CHARS = 12_000;
const MAX_LINES = 80;
const MAX_OPERATOR_ACTIVITY_OUTBOX = 256;
const OPERATOR_ACTIVITY_RETRY_MIN_MS = 1_000;
const OPERATOR_ACTIVITY_RETRY_MAX_MS = 30_000;
const OPERATOR_ACTIVITY_ID = /^[a-f0-9]{64}$/;

function operatorActivityStorageKey(conversationId: string): string {
  return `llv.realtime-operator-activity.v1.${conversationId}`;
}

function readOperatorActivityOutbox(conversationId: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(operatorActivityStorageKey(conversationId)) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === "string" && OPERATOR_ACTIVITY_ID.test(item)))]
      .slice(-MAX_OPERATOR_ACTIVITY_OUTBOX);
  } catch {
    return [];
  }
}

function writeOperatorActivityOutbox(conversationId: string, ids: readonly string[]): void {
  try {
    const key = operatorActivityStorageKey(conversationId);
    const bounded = [...new Set(ids.filter((item) => OPERATOR_ACTIVITY_ID.test(item)))].slice(-MAX_OPERATOR_ACTIVITY_OUTBOX);
    if (bounded.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(bounded));
  } catch {
    /* A privacy-restricted browser still keeps the live call usable. */
  }
}

function newOperatorActivityId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (type === "delegation.created") {
    const id = stringAt(event.item, "id")
      ?? stringAt(event.delegation, "id")
      ?? stringAt(event, "delegation_item_id")
      ?? "";
    return id ? { kind: "delegation", id } : { kind: "ignored" };
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
  private snapshot: CodexRealtimeSnapshot = { phase: "idle", lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };
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
  private operatorActivityFlush: Promise<void> | null = null;
  private operatorActivityRetryTimer: number | null = null;
  private operatorActivityRetryMs = OPERATOR_ACTIVITY_RETRY_MIN_MS;
  private lineSequence = 0;
  /** The line each speaker is still streaming into, by line id. Held here
      rather than read off the end of the list because a delegating turn
      interleaves both speakers with worker progress, so "the last line" is
      almost never the line an update belongs to. */
  private readonly openTranscriptLines = new Map<TranscriptSpeaker, string>();
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
    this.update({ phase: "connecting", error: null, startedAt: null, micMuted: false, outputMuted: false });
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
          this.flushOperatorActivities();
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
      } catch {
        return;
      }
      if (body.acknowledged !== true || body.deliveryId !== delivery.deliveryId) return;
      this.pendingWorkerDeliveries.delete(delivery.deliveryId);
      this.acknowledgedWorkerDeliveries.add(delivery.deliveryId);
      for (const listener of this.deliveryAcknowledgedListeners) listener(delivery.deliveryId);
    }
  }

  private enqueueOperatorActivity(): void {
    const ids = readOperatorActivityOutbox(this.conversationId);
    ids.push(newOperatorActivityId());
    writeOperatorActivityOutbox(this.conversationId, ids);
    this.flushOperatorActivities();
  }

  private flushOperatorActivities(): void {
    if (this.snapshot.phase !== "live" || !this.realtimeSessionId || this.operatorActivityFlush) return;
    if (this.operatorActivityRetryTimer !== null) {
      window.clearTimeout(this.operatorActivityRetryTimer);
      this.operatorActivityRetryTimer = null;
    }
    const task = this.deliverOperatorActivities();
    this.operatorActivityFlush = task;
    void task.finally(() => {
      if (this.operatorActivityFlush === task) this.operatorActivityFlush = null;
    });
  }

  private async deliverOperatorActivities(): Promise<void> {
    while (this.snapshot.phase === "live" && this.realtimeSessionId) {
      const operatorEventId = readOperatorActivityOutbox(this.conversationId)[0];
      if (!operatorEventId) {
        this.operatorActivityRetryMs = OPERATOR_ACTIVITY_RETRY_MIN_MS;
        return;
      }
      try {
        await responseJson(await fetch("/api/runtime/realtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "operatorActivity",
            conversationId: this.conversationId,
            realtimeSessionId: this.realtimeSessionId,
            operatorEventId,
          }),
        }));
      } catch {
        this.scheduleOperatorActivityRetry();
        return;
      }
      writeOperatorActivityOutbox(
        this.conversationId,
        readOperatorActivityOutbox(this.conversationId).filter((candidate) => candidate !== operatorEventId),
      );
      this.operatorActivityRetryMs = OPERATOR_ACTIVITY_RETRY_MIN_MS;
    }
  }

  private scheduleOperatorActivityRetry(): void {
    if (this.operatorActivityRetryTimer !== null || this.snapshot.phase !== "live") return;
    const delay = this.operatorActivityRetryMs;
    this.operatorActivityRetryMs = Math.min(OPERATOR_ACTIVITY_RETRY_MAX_MS, delay * 2);
    this.operatorActivityRetryTimer = window.setTimeout(() => {
      this.operatorActivityRetryTimer = null;
      this.flushOperatorActivities();
    }, delay);
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
    const payload = JSON.stringify({
      action: "selectedContext",
      conversationId: this.conversationId,
      realtimeSessionId: this.realtimeSessionId,
      selectedContext: viewerSelectedContext(),
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
        this.enqueueOperatorActivity();
        this.publishSelectedContext();
      }
    } else if (event.kind === "delegation") {
      return;
    } else if (event.kind === "error") {
      this.setError(event.message);
    }
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
    if (this.operatorActivityRetryTimer !== null) window.clearTimeout(this.operatorActivityRetryTimer);
    this.operatorActivityRetryTimer = null;
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
