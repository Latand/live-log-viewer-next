"use client";

export type CodexRealtimePhase = "idle" | "connecting" | "live" | "stopping" | "error";
export type CodexRealtimeRole = "user" | "assistant" | "progress";

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
const HANDOFF_INTERVAL_MS = 200;
const HANDOFF_CHUNK_BYTES = 500;

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

export function chunkUtf8(text: string, maxBytes = HANDOFF_CHUNK_BYTES): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be positive");
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  for (const symbol of text) {
    if (encoder.encode(symbol).byteLength > maxBytes) continue;
    if (current && encoder.encode(current + symbol).byteLength > maxBytes) {
      chunks.push(current);
      current = symbol;
    } else {
      current += symbol;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function delegationContextEvents(
  delegationItemId: string,
  text: string,
  channel: "commentary" | "speakable",
): Record<string, unknown>[] {
  if (!delegationItemId || !text) return [];
  return chunkUtf8(text).map((chunk) => ({
    type: "delegation.context.append",
    delegation_item_id: delegationItemId,
    channel,
    content: [{ type: "input_text", text: chunk }],
  }));
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
  private delegationItemId: string | null = null;
  /** The worker turn as the producer has it so far — a reference to the same
      growing string, never a copy, so retention stays the producer's bound. */
  private pendingWorkerText = "";
  /** How much of `pendingWorkerText` the channel has accepted. The cursor is
      the whole contract with the wire: it advances only by characters that
      were actually sent, so nothing ships twice and nothing is skipped. */
  private sentWorkerChars = 0;
  private flushingWorkerProgress = false;
  private pendingFinalText = "";
  private handoffTimer: number | null = null;
  private unloadHangup: (() => void) | null = null;
  private lineSequence = 0;
  private epoch = 0;

  constructor(readonly conversationId: string) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CodexRealtimeSnapshot => this.snapshot;

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
        if (epoch === this.epoch) this.update({ phase: "live", error: null, startedAt: Date.now() });
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
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "stop", conversationId: this.conversationId }),
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", conversationId: this.conversationId, sdp: offer }),
      }));
      if (epoch !== this.epoch) return;
      if (typeof answer.sdp !== "string") throw new Error("Codex returned no WebRTC answer");
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
        body: JSON.stringify({ action: "stop", conversationId: this.conversationId }),
      }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    this.cleanupTransport();
    this.update({ phase: failure ? "error" : "idle", error: failure });
  }

  queueWorkerProgress(text: string): void {
    if (!text || this.snapshot.phase !== "live") return;
    this.trackWorkerText(text);
    this.upsertLine("progress", text.slice(-MAX_LINE_CHARS), false);
    this.armHandoff();
  }

  finishWorkerProgress(text: string): void {
    if (!text || this.snapshot.phase !== "live") return;
    this.trackWorkerText(text);
    if (this.handoffTimer !== null) {
      window.clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
    /* Everything still owed on commentary goes out before the spoken summary,
       so the agent never hears the ending ahead of the middle. */
    this.drainWorkerProgress();
    const spoken = this.pendingWorkerText.slice(-MAX_LINE_CHARS);
    this.pendingFinalText = `Agent Final Message:\n\n${spoken}`;
    this.pendingFinalText = this.pendingFinalText.slice(
      this.sendDelegationContext(this.pendingFinalText, "speakable"),
    );
    this.upsertLine("progress", spoken, true);
    this.pendingWorkerText = "";
    this.sentWorkerChars = 0;
  }

  /**
   * The producer streams one turn that only grows, so the handoff is a cursor
   * into it. Text that does not extend what was seen before is a rewrite (a
   * restarted or replaced turn, not an append): the cursor returns to zero and
   * the replacement ships once, rather than being diffed against a turn that
   * no longer exists.
   */
  private trackWorkerText(text: string): void {
    if (!text.startsWith(this.pendingWorkerText)) this.sentWorkerChars = 0;
    this.pendingWorkerText = text;
  }

  private armHandoff(): void {
    if (this.handoffTimer !== null) return;
    this.handoffTimer = window.setTimeout(() => {
      this.handoffTimer = null;
      this.flushWorkerProgress();
    }, HANDOFF_INTERVAL_MS);
  }

  /** One flush, then re-arm while the wire still owes the producer content. */
  private flushWorkerProgress(): void {
    if (this.flushOnce() > 0 && this.sentWorkerChars < this.pendingWorkerText.length) this.armHandoff();
  }

  private drainWorkerProgress(): void {
    while (this.sentWorkerChars < this.pendingWorkerText.length && this.flushOnce() > 0);
  }

  /**
   * Ships at most one window of unsent text and returns how much went out. A
   * single flush is capped so a cursor reset (or a channel that was shut for a
   * while) cannot burst an entire turn onto the wire in one tick; the rest
   * follows on the next flush, in order.
   */
  private flushOnce(): number {
    /* `update` runs subscribers synchronously, so a re-render can call back in
       here mid-flush; a reentrant flush would read the cursor before it moved
       and send the same characters twice. */
    if (this.flushingWorkerProgress) return 0;
    this.flushingWorkerProgress = true;
    try {
      const text = this.pendingWorkerText;
      if (this.sentWorkerChars >= text.length) return 0;
      const cap = Math.min(text.length, this.sentWorkerChars + MAX_LINE_CHARS);
      /* A cap landing between the halves of a surrogate pair would put a lone
         half in each append, and each encodes as U+FFFD. Keep the pair whole
         and let it open the next flush. */
      const lead = text.charCodeAt(cap - 1);
      const end = cap < text.length && lead >= 0xd800 && lead <= 0xdbff ? cap - 1 : cap;
      const sent = this.sendDelegationContext(text.slice(this.sentWorkerChars, end), "commentary");
      this.sentWorkerChars += sent;
      return sent;
    } finally {
      this.flushingWorkerProgress = false;
    }
  }

  /**
   * Returns the number of characters the channel accepted — the whole text on
   * success, the prefix that made it out if a send throws part-way, zero if
   * there is nowhere to send yet. Callers resume from exactly that point, so a
   * retry never repeats a delivered chunk.
   */
  private sendDelegationContext(text: string, channel: "commentary" | "speakable"): number {
    if (!text || !this.delegationItemId || this.events?.readyState !== "open") return 0;
    let sent = 0;
    for (const chunk of chunkUtf8(text)) {
      const [event] = delegationContextEvents(this.delegationItemId, chunk, channel);
      if (!event) continue;
      try {
        this.events.send(JSON.stringify(event));
      } catch {
        return sent;
      }
      sent += chunk.length;
    }
    return text.length;
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
      this.upsertLine(event.role, event.text, event.final);
    } else if (event.kind === "delegation") {
      this.delegationItemId = event.id;
      this.flushWorkerProgress();
      if (this.pendingFinalText) {
        this.pendingFinalText = this.pendingFinalText.slice(
          this.sendDelegationContext(this.pendingFinalText, "speakable"),
        );
      }
    } else if (event.kind === "error") {
      this.setError(event.message);
    }
  }

  private upsertLine(role: CodexRealtimeRole, text: string, final: boolean): void {
    const lines = [...this.snapshot.lines];
    const previous = lines.at(-1);
    if (previous?.role === role && !previous.final) {
      const combined = final || text.startsWith(previous.text) ? text : `${previous.text}${text}`;
      lines[lines.length - 1] = { ...previous, text: combined.slice(-MAX_LINE_CHARS), final };
    } else {
      lines.push({ id: `${Date.now()}-${++this.lineSequence}`, role, text: text.slice(-MAX_LINE_CHARS), final });
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
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private cleanupTransport(): void {
    if (this.unloadHangup) window.removeEventListener("pagehide", this.unloadHangup);
    this.unloadHangup = null;
    if (this.handoffTimer !== null) window.clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
    this.events?.close();
    this.peer?.close();
    for (const track of this.media?.getTracks() ?? []) track.stop();
    this.audio?.remove();
    this.events = null;
    this.peer = null;
    this.media = null;
    this.audio = null;
    this.delegationItemId = null;
    this.pendingWorkerText = "";
    this.sentWorkerChars = 0;
    this.flushingWorkerProgress = false;
    this.pendingFinalText = "";
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
