/**
 * The canonical realtime transcript, as the app-server publishes it (#1629).
 *
 * A call has TWO transcript sources and they are not interchangeable:
 *
 * - the WebRTC data channel, which the browser reads directly. It is immediate
 *   and it is what the panel has always shown, and it exists only while that one
 *   peer connection is up.
 * - `thread/realtime/*` notifications on the app-server connection, which is
 *   where native's own canonical timeline comes from. It survives a data-channel
 *   drop, it is what the thread's history is built from, and until now the
 *   Viewer never carried it anywhere — the panel could not show a word of what
 *   the backend had actually committed.
 *
 * This reads the second one. It is deliberately a small reducer over the wire
 * shapes rather than something the host does inline, so the notification
 * ordering — flat deltas, per-item deltas, an item completed after canonical
 * commit — is testable without a process, and so the host's own notification
 * switch stays a dispatch table.
 *
 * The methods and their fields are the installed app-server's published schema:
 * `thread/realtime/transcript/delta` carries `role` and `delta`,
 * `transcript/done` carries `role` and the complete `text`, the per-item pair
 * carries `itemId`, and `item/completed` carries a `transcriptSegment` item with
 * `role`, `text` and the canonical item `id`.
 */

type JsonObject = Record<string, unknown>;

export type CanonicalVoiceRole = "user" | "assistant";

/** One canonical transcript segment, at whatever completeness it has reached. */
export interface CanonicalVoiceSegment {
  /** The canonical item id when native named one, else this call's own
      per-role segment id. Stable across the deltas that build it. */
  id: string;
  realtimeSessionId: string;
  role: CanonicalVoiceRole;
  /** The whole segment so far, never a delta: a consumer that missed one frame
      must not be left rendering a hole. */
  text: string;
  final: boolean;
}

/** Matches the browser client's own line bound, so a canonical segment and a
    data-channel line can never disagree merely about where they were cut. */
const MAX_SEGMENT_CHARS = 12_000;

/** Open segments one call may accumulate at once. Native interleaves at most a
    handful (one per role, plus the items it is committing), so this is a guard
    against a malformed stream rather than a working limit. */
const MAX_OPEN_SEGMENTS = 32;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function string(source: JsonObject | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function role(value: unknown): CanonicalVoiceRole | null {
  return value === "user" || value === "assistant" ? value : null;
}

interface OpenSegment {
  id: string;
  role: CanonicalVoiceRole;
  text: string;
}

export class CodexRealtimeTranscript {
  private readonly open = new Map<string, OpenSegment>();
  private sequence = 0;
  private realtimeSessionId = "";

  /** A new call is a new transcript: nothing from the last one may be extended,
      and the ids it minted must not be reused. */
  begin(realtimeSessionId: string): void {
    this.open.clear();
    this.realtimeSessionId = realtimeSessionId;
  }

  end(): void {
    this.open.clear();
  }

  /**
   * Read one notification, and answer the segment it changed.
   *
   * Null for anything this does not describe, including a notification for
   * another thread — the caller has already filtered by thread, and this keeps
   * the reducer usable on its own.
   */
  observe(method: string, params: unknown): CanonicalVoiceSegment | null {
    const body = object(params);
    if (!body || !this.realtimeSessionId) return null;
    if (method === "thread/realtime/transcript/delta") {
      const speaker = role(body.role);
      const delta = typeof body.delta === "string" ? body.delta : "";
      if (!speaker || !delta) return null;
      return this.append(`role:${speaker}`, speaker, delta);
    }
    if (method === "thread/realtime/transcript/done") {
      const speaker = role(body.role);
      const text = typeof body.text === "string" ? body.text : "";
      if (!speaker) return null;
      return this.finish(`role:${speaker}`, speaker, text);
    }
    if (method === "thread/realtime/item/transcript/delta") {
      const itemId = string(body, "itemId");
      const delta = typeof body.delta === "string" ? body.delta : "";
      if (!itemId || !delta) return null;
      /* The per-item stream can begin before its `item/started` names a role.
         Assistant is the only role native streams this way — the operator's own
         speech arrives on the flat channel — and a segment that is later
         completed carries its canonical role with it. */
      const speaker = this.open.get(`item:${itemId}`)?.role ?? "assistant";
      return this.append(`item:${itemId}`, speaker, delta, itemId);
    }
    if (method === "thread/realtime/item/started" || method === "thread/realtime/item/completed") {
      const item = object(body.item);
      if (string(item, "type") !== "transcriptSegment") return null;
      const itemId = string(item, "id") ?? string(body, "itemId");
      const speaker = role(item?.role);
      if (!itemId || !speaker) return null;
      const text = typeof item?.text === "string" ? item.text : "";
      return method === "thread/realtime/item/completed"
        ? this.finish(`item:${itemId}`, speaker, text, itemId)
        : this.open.has(`item:${itemId}`)
          ? null
          : this.start(`item:${itemId}`, speaker, text, itemId);
    }
    return null;
  }

  private start(key: string, speaker: CanonicalVoiceRole, text: string, canonicalId?: string): CanonicalVoiceSegment {
    if (this.open.size >= MAX_OPEN_SEGMENTS) {
      const oldest = this.open.keys().next().value as string | undefined;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.sequence += 1;
    const segment: OpenSegment = {
      id: canonicalId ?? `${this.realtimeSessionId}:${speaker}:${this.sequence}`,
      role: speaker,
      text: text.slice(0, MAX_SEGMENT_CHARS),
    };
    this.open.set(key, segment);
    return { ...segment, realtimeSessionId: this.realtimeSessionId, final: false };
  }

  private append(key: string, speaker: CanonicalVoiceRole, delta: string, canonicalId?: string): CanonicalVoiceSegment {
    const existing = this.open.get(key);
    if (!existing) return this.start(key, speaker, delta, canonicalId);
    existing.text = (existing.text + delta).slice(0, MAX_SEGMENT_CHARS);
    return { ...existing, realtimeSessionId: this.realtimeSessionId, final: false };
  }

  private finish(key: string, speaker: CanonicalVoiceRole, text: string, canonicalId?: string): CanonicalVoiceSegment {
    const existing = this.open.get(key);
    /* The done event carries the WHOLE segment, so it wins over what the deltas
       accumulated: a dropped frame is repaired here rather than left as a hole
       in the middle of a sentence. An empty final text keeps what was streamed,
       because losing the words would be the worse reading of a sparse event. */
    const segment: OpenSegment = existing
      ? { ...existing, text: (text || existing.text).slice(0, MAX_SEGMENT_CHARS) }
      : this.newSegment(speaker, text, canonicalId);
    this.open.delete(key);
    return { ...segment, realtimeSessionId: this.realtimeSessionId, final: true };
  }

  private newSegment(speaker: CanonicalVoiceRole, text: string, canonicalId?: string): OpenSegment {
    this.sequence += 1;
    return {
      id: canonicalId ?? `${this.realtimeSessionId}:${speaker}:${this.sequence}`,
      role: speaker,
      text: text.slice(0, MAX_SEGMENT_CHARS),
    };
  }
}
